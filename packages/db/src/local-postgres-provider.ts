import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import {
  cleanupStaleSysvSharedMemorySegments,
  isEmbeddedPostgresSharedMemoryError,
} from "./embedded-postgres-recovery.js";

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

export function resolveOfficialPostgresRuntimeFiles(binDir: string): {
  postgresBkiCandidates: string[];
} {
  return {
    postgresBkiCandidates: [
      path.join(binDir, "..", "share", "postgresql", "postgres.bki"),
      path.join(binDir, "..", "share", "postgres.bki"),
    ],
  };
}

function debianSharedirCandidate(binDir: string): string | null {
  const normalized = path.resolve(binDir);
  const parts = normalized.split(path.sep);
  const libIndex = parts.lastIndexOf("lib");
  if (libIndex < 0) return null;
  if (parts[libIndex + 1] !== "postgresql") return null;
  const version = parts[libIndex + 2];
  if (!version || parts[libIndex + 3] !== "bin") return null;
  const prefix = parts.slice(0, libIndex).join(path.sep) || path.sep;
  return path.join(prefix, "share", "postgresql", version);
}

export function resolveOfficialPostgresTemplateDir(binDir: string): string | null {
  const { postgresBkiCandidates } = resolveOfficialPostgresRuntimeFiles(binDir);
  for (const candidatePath of postgresBkiCandidates) {
    if (existsSync(candidatePath)) return path.dirname(candidatePath);
  }

  const debianSharedir = debianSharedirCandidate(binDir);
  if (debianSharedir && existsSync(path.join(debianSharedir, "postgres.bki"))) {
    return debianSharedir;
  }

  const pgConfigPath = path.join(binDir, process.platform === "win32" ? "pg_config.exe" : "pg_config");
  if (!existsSync(pgConfigPath)) return null;
  try {
    const sharedir = execFileSync(pgConfigPath, ["--sharedir"], { encoding: "utf8" }).trim();
    if (!sharedir) return null;
    const postgresBkiPath = path.join(sharedir, "postgres.bki");
    return existsSync(postgresBkiPath) ? sharedir : null;
  } catch {
    return null;
  }
}

export function validateOfficialPostgresBinDir(binDir: string): { ok: true } | { ok: false; missing: string[] } {
  const binaries = resolveOfficialPostgresBinaries(binDir);
  const runtimeFiles = resolveOfficialPostgresRuntimeFiles(binDir);
  const missing = Object.values(binaries).filter((binaryPath) => !existsSync(binaryPath));
  if (!resolveOfficialPostgresTemplateDir(binDir)) {
    missing.push(runtimeFiles.postgresBkiCandidates[0]);
  }
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

export function buildOfficialPostgresStartArgs(options: LocalPostgresInstanceOptions): string[] {
  return [
    "-D",
    options.databaseDir,
    "-l",
    path.join(options.databaseDir, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${options.port}`,
    "-w",
    "start",
  ];
}

function buildOfficialPostgresInitdbArgsForBinDir(
  binDir: string,
  options: LocalPostgresInstanceOptions,
  passwordFilePath: string,
): string[] {
  const args = buildOfficialPostgresInitdbArgs(options, passwordFilePath);
  const templateDir = resolveOfficialPostgresTemplateDir(binDir);
  return templateDir ? [...args, "-L", templateDir] : args;
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

async function waitForOfficialPostgresReady(options: LocalPostgresInstanceOptions): Promise<void> {
  const connectionString = `postgres://${encodeURIComponent(options.user)}:${encodeURIComponent(options.password)}@127.0.0.1:${options.port}/postgres`;
  const deadline = Date.now() + 10_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    const sql = postgres(connectionString, { max: 1, connect_timeout: 1, onnotice: () => {} });
    try {
      await sql`select 1`;
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await sql.end({ timeout: 0 }).catch(() => {});
    }
  }
  throw new Error(
    `PostgreSQL ${RUDDER_PRODUCTION_POSTGRES_VERSION} start did not become ready on port ${options.port}: ${lastError instanceof Error ? lastError.message : String(lastError ?? "timed out")}`,
  );
}

async function stopSpawnedPostgres(child: ReturnType<typeof spawn> | null): Promise<void> {
  if (!child?.pid) return;
  const pid = child.pid;
  const signal = (value: NodeJS.Signals): void => {
    try {
      if (process.platform === "win32") child.kill(value);
      else process.kill(-pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return child.exitCode !== null || child.signalCode !== null;
  };

  if (child.exitCode !== null || child.signalCode !== null) return;
  signal("SIGTERM");
  if (await waitForExit(5_000)) return;
  signal("SIGKILL");
  await waitForExit(2_000);
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
  const runWithSharedMemoryRecovery = async (command: string, args: string[], phase: string): Promise<void> => {
    try {
      await run(command, args, phase);
    } catch (error) {
      if (!isEmbeddedPostgresSharedMemoryError(error)) throw error;
      const recovered = await cleanupStaleSysvSharedMemorySegments();
      if (recovered.removedIds.length === 0) throw error;
      process.emitWarning(
        `Recovered ${recovered.removedIds.length} stale SysV shared memory segment(s) before retrying PostgreSQL ${RUDDER_PRODUCTION_POSTGRES_VERSION} ${phase}.`,
      );
      await run(command, args, phase);
    }
  };
  return {
    async initialise() {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), "rudder-pg-init-"));
      const passwordFilePath = path.join(tempDir, "pwfile");
      try {
        await writeFile(passwordFilePath, `${options.password}\n`, { encoding: "utf8", mode: 0o600 });
        await runWithSharedMemoryRecovery(
          binaries.initdb,
          buildOfficialPostgresInitdbArgsForBinDir(binDir, options, passwordFilePath),
          "initdb",
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    async start() {
      if (process.platform === "win32") {
        await run(binaries.pgCtl, buildOfficialPostgresStartArgs(options), "start");
        return;
      }

      let child: ReturnType<typeof spawn> | null = null;
      const startPostgres = () => {
        child = spawn(
          binaries.postgres,
          ["-D", options.databaseDir, "-h", "127.0.0.1", "-p", String(options.port)],
          {
            env: buildOfficialPostgresCommandEnv(binDir, options.password),
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32",
          },
        );
        child.stderr?.on("data", (chunk) => appendProcessOutput(chunk, options.onError));
        child.unref();
        return child;
      };

      try {
        startPostgres();
        await waitForOfficialPostgresReady(options);
      } catch (error) {
        if (isEmbeddedPostgresSharedMemoryError(error)) {
          const recovered = await cleanupStaleSysvSharedMemorySegments();
          if (recovered.removedIds.length > 0) {
            process.emitWarning(
              `Recovered ${recovered.removedIds.length} stale SysV shared memory segment(s) before retrying PostgreSQL ${RUDDER_PRODUCTION_POSTGRES_VERSION} start.`,
            );
            await stopSpawnedPostgres(child).catch(() => undefined);
            try {
              startPostgres();
              await waitForOfficialPostgresReady(options);
              return;
            } catch (retryError) {
              await stopSpawnedPostgres(child).catch(() => undefined);
              throw retryError;
            }
          }
        }
        await stopSpawnedPostgres(child).catch(() => undefined);
        throw error;
      }
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
