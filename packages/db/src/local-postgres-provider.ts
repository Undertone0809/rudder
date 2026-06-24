import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const RUDDER_POSTGRES_BIN_DIR_ENV = "RUDDER_POSTGRES_BIN_DIR";
export const RUDDER_PRODUCTION_POSTGRES_VERSION = "18.4";

const execFileAsync = promisify(execFile);

export type LocalPostgresProvider = "official-postgres" | "embedded-postgres";

export type LocalPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type LocalPostgresInstanceOptions = {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
};

type EmbeddedPostgresCtor = new (opts: LocalPostgresInstanceOptions) => LocalPostgresInstance;

export type LocalPostgresInstanceSelection = {
  provider: LocalPostgresProvider;
  instance: LocalPostgresInstance;
  postgresBinDir?: string;
};

export type PostgresVersionRunner = (postgresBinaryPath: string) => Promise<string>;

export function resolveOfficialPostgresBinDir(rawValue = process.env[RUDDER_POSTGRES_BIN_DIR_ENV]): string | null {
  const value = rawValue?.trim();
  if (!value) return null;
  return path.resolve(value);
}

function executableName(baseName: "initdb" | "pg_ctl" | "postgres"): string {
  return process.platform === "win32" ? `${baseName}.exe` : baseName;
}

export function resolveOfficialPostgresBinaries(binDir: string): {
  initdb: string;
  pgCtl: string;
  postgres: string;
} {
  return {
    initdb: path.join(binDir, executableName("initdb")),
    pgCtl: path.join(binDir, executableName("pg_ctl")),
    postgres: path.join(binDir, executableName("postgres")),
  };
}

export function validateOfficialPostgresBinDir(binDir: string): { ok: true } | { ok: false; missing: string[] } {
  const binaries = resolveOfficialPostgresBinaries(binDir);
  const missing = Object.values(binaries).filter((binaryPath) => !existsSync(binaryPath));
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

function requireOfficialPostgresBinDir(binDir: string): ReturnType<typeof resolveOfficialPostgresBinaries> {
  const validation = validateOfficialPostgresBinDir(binDir);
  if (!validation.ok) {
    throw new Error(
      `${RUDDER_POSTGRES_BIN_DIR_ENV} must point at a PostgreSQL ${RUDDER_PRODUCTION_POSTGRES_VERSION} production bin directory; missing ${validation.missing.join(", ")}`,
    );
  }
  return resolveOfficialPostgresBinaries(binDir);
}

function parsePostgresVersion(output: string): string | null {
  const match = /\bPostgreSQL\)?\s+([0-9]+(?:\.[0-9]+)*)\b/i.exec(output);
  return match?.[1] ?? null;
}

async function defaultPostgresVersionRunner(postgresBinaryPath: string): Promise<string> {
  const result = await execFileAsync(postgresBinaryPath, ["--version"], {
    env: process.env,
  });
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export async function assertOfficialPostgresVersion(
  binDir: string,
  runVersionCommand: PostgresVersionRunner = defaultPostgresVersionRunner,
): Promise<void> {
  const { postgres } = requireOfficialPostgresBinDir(binDir);
  let output = "";
  try {
    output = await runVersionCommand(postgres);
  } catch (error) {
    throw new Error(
      `Failed to verify PostgreSQL ${RUDDER_PRODUCTION_POSTGRES_VERSION} production binary at ${postgres}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const actualVersion = parsePostgresVersion(output);
  if (actualVersion !== RUDDER_PRODUCTION_POSTGRES_VERSION) {
    throw new Error(
      `Expected PostgreSQL ${RUDDER_PRODUCTION_POSTGRES_VERSION} production binary at ${postgres}; got ${output.trim() || "unknown version"}`,
    );
  }
}

function appendProcessOutput(
  output: string | Buffer | undefined,
  sink: ((message: unknown) => void) | undefined,
): void {
  const text = typeof output === "string" ? output : output?.toString("utf8") ?? "";
  if (text.trim()) sink?.(text);
}

export function buildOfficialPostgresInitdbArgs(options: LocalPostgresInstanceOptions, passwordFilePath: string): string[] {
  return [
    "-D",
    options.databaseDir,
    "-U",
    options.user,
    "--auth=scram-sha-256",
    "--pwfile",
    passwordFilePath,
    ...(options.initdbFlags ?? []),
  ];
}

function buildOfficialPostgresCommandEnv(
  binDir: string,
  password: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: password };
  const pathKey = process.platform === "win32" && env.Path !== undefined ? "Path" : "PATH";
  env[pathKey] = [binDir, env[pathKey]].filter(Boolean).join(path.delimiter);
  return env;
}

export function createOfficialPostgresInstance(
  binDir: string,
  options: LocalPostgresInstanceOptions,
): LocalPostgresInstance {
  const binaries = requireOfficialPostgresBinDir(binDir);
  const run = async (command: string, args: string[], phase: string): Promise<void> => {
    try {
      const result = await execFileAsync(command, args, {
        env: buildOfficialPostgresCommandEnv(binDir, options.password),
      });
      appendProcessOutput(result.stdout, options.onLog);
      appendProcessOutput(result.stderr, options.onLog);
    } catch (error) {
      const execError = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
      appendProcessOutput(execError.stdout, options.onError);
      appendProcessOutput(execError.stderr, options.onError);
      throw new Error(
        `PostgreSQL ${RUDDER_PRODUCTION_POSTGRES_VERSION} ${phase} failed: ${execError.message}`,
      );
    }
  };
  const runControlCommand = async (command: string, args: string[], phase: string): Promise<void> => {
    const result = spawnSync(command, args, {
      env: buildOfficialPostgresCommandEnv(binDir, options.password),
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error) {
      throw new Error(`PostgreSQL ${RUDDER_PRODUCTION_POSTGRES_VERSION} ${phase} failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `PostgreSQL ${RUDDER_PRODUCTION_POSTGRES_VERSION} ${phase} failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.status}`}`,
      );
    }
  };

  return {
    async initialise() {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-pg-init-"));
      const passwordFilePath = path.join(tempDir, "pwfile");
      try {
        await writeFile(passwordFilePath, `${options.password}\n`, { encoding: "utf8", mode: 0o600 });
        await run(
          binaries.initdb,
          buildOfficialPostgresInitdbArgs(options, passwordFilePath),
          "initdb",
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    async start() {
      await runControlCommand(
        binaries.pgCtl,
        [
          "-D",
          options.databaseDir,
          "-o",
          `-h 127.0.0.1 -p ${options.port}`,
          "-w",
          "start",
        ],
        "start",
      );
    },
    async stop() {
      await run(binaries.pgCtl, ["-D", options.databaseDir, "-m", "fast", "-w", "stop"], "stop");
    },
  };
}

async function loadEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  try {
    const mod = await import("embedded-postgres");
    return mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL support requires dependency `embedded-postgres`. Reinstall dependencies and try again, set DATABASE_URL for external Postgres, or set RUDDER_POSTGRES_BIN_DIR to a PostgreSQL 18.4 production bin directory.",
    );
  }
}

export async function createLocalPostgresInstance(
  options: LocalPostgresInstanceOptions,
): Promise<LocalPostgresInstanceSelection> {
  const officialBinDir = resolveOfficialPostgresBinDir();
  if (officialBinDir) {
    await assertOfficialPostgresVersion(officialBinDir);
    return {
      provider: "official-postgres",
      postgresBinDir: officialBinDir,
      instance: createOfficialPostgresInstance(officialBinDir, options),
    };
  }

  const EmbeddedPostgres = await loadEmbeddedPostgresCtor();
  return {
    provider: "embedded-postgres",
    instance: new EmbeddedPostgres(options),
  };
}
