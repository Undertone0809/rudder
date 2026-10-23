import { resolveRudderNativeTarget } from "@rudderhq/shared";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMigrationManifest } from "./migration-manifest.js";

const SCHEMA = "rudder.migration-apply/v1";
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const CANCELLATION_DRAIN_MS = 75_000;

export type MigrationOperatorRequest = Readonly<{
  databaseUrl: string;
  migrationsDir: string;
  expectedFingerprint: string;
  recoveryDirectory: string;
  pgDumpBinary: string;
  validateOnly?: boolean;
}>;

export type MigrationOperatorReport = Readonly<{
  manifestFingerprint: string;
  alreadyCurrent: boolean;
  appliedMigrations: string[];
  reconciledLegacyMigrations: string[];
  normalizedLegacyColumns: string[];
  recoveryPoint: string | null;
}>;

export type MigrationOperatorSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export type ApplyMigrationsWithRustInput = Readonly<{
  databaseUrl: string;
  migrationsDir: string;
  journalFile: string;
  recoveryDirectory: string;
  postgresBinDir?: string;
}>;

export class NativeMigrationOperatorError extends Error {
  constructor(readonly code: string) {
    super(`Rust migration operator failed (${code}); no Node migration fallback is available.`);
    this.name = "NativeMigrationOperatorError";
  }
}

export function resolveMigrationApplyBinary(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.RUDDER_NATIVE_MIGRATION_APPLY_PATH?.trim();
  if (configured) return path.resolve(configured);

  const configuredPreflight = env.RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH?.trim()
    || env.RUDDER_MIGRATION_PREFLIGHT_PATH?.trim();
  const binaryName = process.platform === "win32" ? "migration-apply.exe" : "migration-apply";
  if (configuredPreflight) return path.join(path.dirname(path.resolve(configuredPreflight)), binaryName);

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const target = resolveRudderNativeTarget();
  const resourcesPath = env.RUDDER_DESKTOP_RESOURCES_PATH?.trim()
    || (typeof (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath === "string"
      ? (process as NodeJS.Process & { resourcesPath: string }).resourcesPath
      : "");
  const candidates = [
    target ? path.resolve(moduleDir, "../../resources/native", target, binaryName) : "",
    resourcesPath && target ? path.resolve(resourcesPath, "native", target, binaryName) : "",
    path.resolve(moduleDir, "../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../../native/target/debug", binaryName),
    target ? path.resolve(moduleDir, "../../../server/resources/native", target, binaryName) : "",
    path.resolve(moduleDir, "../../../native/target/release", binaryName),
    path.resolve(moduleDir, "../../../../native/target/release", binaryName),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function resolveMigrationPgDumpBinary(options: {
  postgresBinDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const env = options.env ?? process.env;
  const configured = env.RUDDER_NATIVE_MIGRATIONS_PG_DUMP?.trim();
  if (configured) return path.resolve(configured);
  const executable = process.platform === "win32" ? "pg_dump.exe" : "pg_dump";
  const binDir = options.postgresBinDir?.trim() || env.RUDDER_POSTGRES_BIN_DIR?.trim();
  if (binDir) return path.resolve(binDir, executable);
  const found = (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(entry, executable))
    .find((candidate) => existsSync(candidate));
  return found ?? path.resolve(path.dirname(process.execPath), executable);
}

export async function applyMigrationsWithRust(
  input: ApplyMigrationsWithRustInput,
  options: {
    binaryPath?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    spawnProcess?: MigrationOperatorSpawn;
  } = {},
): Promise<MigrationOperatorReport> {
  const manifest = await createMigrationManifest({
    migrationsFolder: input.migrationsDir,
    journalFile: input.journalFile,
  });
  return runNativeMigrationOperator({
    databaseUrl: input.databaseUrl,
    migrationsDir: input.migrationsDir,
    expectedFingerprint: manifest.fingerprint,
    recoveryDirectory: input.recoveryDirectory,
    pgDumpBinary: resolveMigrationPgDumpBinary({ postgresBinDir: input.postgresBinDir, env: options.env }),
  }, options);
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new NativeMigrationOperatorError("invalid_timeout");
  }
  return timeoutMs;
}

function createRequest(input: MigrationOperatorRequest): string {
  if (!/^[a-f0-9]{64}$/u.test(input.expectedFingerprint)) {
    throw new NativeMigrationOperatorError("manifest_fingerprint_required");
  }
  for (const candidate of [input.migrationsDir, input.recoveryDirectory, input.pgDumpBinary]) {
    if (!path.isAbsolute(candidate) || candidate.split(path.sep).includes("..")) {
      throw new NativeMigrationOperatorError("absolute_normalized_paths_required");
    }
  }
  const body = JSON.stringify({
    schema: SCHEMA,
    protocolVersion: 1,
    allowApply: true,
    migrationsDir: input.migrationsDir,
    expectedFingerprint: input.expectedFingerprint,
    recoveryDirectory: input.recoveryDirectory,
    pgDumpBinary: input.pgDumpBinary,
    ...(input.validateOnly ? { validateOnly: true } : {}),
  });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new NativeMigrationOperatorError("input_too_large");
  }
  return body;
}

function parseReport(
  stdout: Buffer,
  stderr: Buffer,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  validateOnly: boolean,
): MigrationOperatorReport {
  if (signal) throw new NativeMigrationOperatorError("operator_signalled");
  if (stderr.byteLength > 0) throw new NativeMigrationOperatorError("unexpected_stderr");
  let body: Record<string, unknown>;
  try {
    const output = new TextDecoder("utf-8", { fatal: true }).decode(stdout).trim();
    if (!output || output.split(/\r?\n/u).length !== 1) throw new Error("invalid output");
    body = JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new NativeMigrationOperatorError("invalid_response");
  }
  if (body.schema !== SCHEMA || body.protocolVersion !== 1) {
    throw new NativeMigrationOperatorError("invalid_response");
  }
  if (body.status === "error" && exitCode === 2) {
    const error = body.error as { code?: unknown } | undefined;
    const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,80}$/u.test(error.code)
      ? error.code
      : "operator_failed";
    throw new NativeMigrationOperatorError(code);
  }
  const report = body.report as MigrationOperatorReport | undefined;
  const strings = (value: unknown): value is string[] => Array.isArray(value)
    && value.length <= 4096
    && value.every((item) => typeof item === "string" && item.length <= 4096);
  if (body.status !== (validateOnly ? "validated" : "applied") || exitCode !== 0 || !report
    || typeof report.manifestFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(report.manifestFingerprint)
    || typeof report.alreadyCurrent !== "boolean"
    || !strings(report.appliedMigrations) || !strings(report.reconciledLegacyMigrations)
    || !strings(report.normalizedLegacyColumns)
    || !(report.recoveryPoint === null || typeof report.recoveryPoint === "string")) {
    throw new NativeMigrationOperatorError("invalid_response");
  }
  return report;
}

export async function runNativeMigrationOperator(
  input: MigrationOperatorRequest,
  options: {
    binaryPath?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    spawnProcess?: MigrationOperatorSpawn;
  } = {},
): Promise<MigrationOperatorReport> {
  if (!/^postgres(?:ql)?:\/\//u.test(input.databaseUrl) || Buffer.byteLength(input.databaseUrl) > 8192) {
    throw new NativeMigrationOperatorError("database_url_invalid");
  }
  const body = createRequest(input);
  if (options.signal?.aborted) throw new NativeMigrationOperatorError("aborted");
  const timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const env = options.env ?? process.env;
  const binaryPath = path.resolve(options.binaryPath ?? resolveMigrationApplyBinary(env));
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"]) {
    if (env[name] !== undefined) childEnv[name] = env[name];
  }
  childEnv.RUDDER_MIGRATION_APPLY_DATABASE_URL = input.databaseUrl;
  childEnv.RUDDER_MIGRATION_APPLY_SUPERVISOR_PID = String(process.pid);

  let cancellationDirectory: string;
  try {
    cancellationDirectory = await mkdtemp(path.join(os.tmpdir(), "rudder-migration-apply-"));
  } catch {
    throw new NativeMigrationOperatorError("cancel_transport_unavailable");
  }
  const cancellationFile = path.join(cancellationDirectory, "cancel");
  childEnv.RUDDER_MIGRATION_APPLY_CANCEL_FILE = cancellationFile;
  let cancellationWrite: Promise<void> | undefined;
  const requestCancellation = () => {
    cancellationWrite ??= writeFile(cancellationFile, "cancel\n", { flag: "wx", mode: 0o600 }).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return;
      throw error;
    });
    return cancellationWrite;
  };
  const spawnProcess = options.spawnProcess ?? ((file, args, spawnOptions) => (
    spawn(file, args, spawnOptions) as ChildProcessWithoutNullStreams
  ));

  let output: { stdout: Buffer; stderr: Buffer; exitCode: number | null; signal: NodeJS.Signals | null };
  try {
    output = await new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnProcess(binaryPath, [], {
          env: childEnv,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        reject(new NativeMigrationOperatorError("spawn_failed"));
        return;
      }

      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let processClosed = false;
      let terminationRequested = false;
      let pendingFailure: NativeMigrationOperatorError | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let forceKill: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const settleError = (error: NativeMigrationOperatorError) => {
        if (settled || pendingFailure) return;
        pendingFailure = error;
        if (processClosed) {
          settled = true;
          cleanup();
          reject(error);
        }
      };
      const terminate = () => {
        if (terminationRequested) return;
        terminationRequested = true;
        void requestCancellation().catch(() => undefined);
        if (process.platform !== "win32") {
          try { child.kill("SIGTERM"); } catch { /* child may have exited */ }
        }
        if (processClosed) return;
        forceKill = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* child may have exited */ }
          forceKill = undefined;
        }, CANCELLATION_DRAIN_MS);
        forceKill.unref?.();
      };
      const onAbort = () => {
        terminate();
        settleError(new NativeMigrationOperatorError("aborted"));
      };
      const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
        if (settled || pendingFailure) return;
        const next = Buffer.concat([target === "stdout" ? stdout : stderr, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (next.byteLength > MAX_OUTPUT_BYTES) {
          terminate();
          settleError(new NativeMigrationOperatorError("output_too_large"));
          return;
        }
        if (target === "stdout") stdout = next;
        else stderr = next;
      };
      child.stdout.on("data", (chunk: Buffer | string) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer | string) => append("stderr", chunk));
      child.once("error", () => {
        processClosed = true;
        settleError(new NativeMigrationOperatorError("spawn_failed"));
      });
      child.once("close", (exitCode, signal) => {
        processClosed = true;
        if (settled) return;
        settled = true;
        cleanup();
        if (forceKill) clearTimeout(forceKill);
        forceKill = undefined;
        if (pendingFailure) reject(pendingFailure);
        else resolve({ stdout, stderr, exitCode, signal });
      });
      child.stdin.once("error", () => {
        terminate();
        settleError(new NativeMigrationOperatorError("stdin_write_failed"));
      });
      timer = setTimeout(() => {
        terminate();
        settleError(new NativeMigrationOperatorError("timeout"));
      }, timeoutMs);
      timer.unref?.();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      try {
        child.stdin.end(body, "utf8");
      } catch {
        terminate();
        settleError(new NativeMigrationOperatorError("stdin_write_failed"));
      }
    });
  } finally {
    await cancellationWrite?.catch(() => undefined);
    await unlink(cancellationFile).catch(() => undefined);
    await rmdir(cancellationDirectory).catch(() => undefined);
  }

  const report = parseReport(output.stdout, output.stderr, output.exitCode, output.signal, input.validateOnly === true);
  if (report.manifestFingerprint !== input.expectedFingerprint) {
    throw new NativeMigrationOperatorError("source_identity_mismatch");
  }
  if (input.validateOnly && (!report.alreadyCurrent || report.appliedMigrations.length
    || report.reconciledLegacyMigrations.length || report.normalizedLegacyColumns.length || report.recoveryPoint)) {
    throw new NativeMigrationOperatorError("validation_mutation_receipt");
  }
  return report;
}
