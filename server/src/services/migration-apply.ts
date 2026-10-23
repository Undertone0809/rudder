import { resolveNativeCommand } from "@rudderhq/agent-runtime-utils";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MigrationPreflightAdapterError, resolveMigrationPreflightBinary, runMigrationProcess } from "./migration-preflight.js";

const SCHEMA = "rudder.migration-apply/v1";
// The Rust cancellation path is bounded at 55 seconds; leave 20 seconds for
// process scheduling and PostgreSQL response variance before escalating.
const CANCELLATION_CLEANUP_GRACE_MS = 75_000;

export interface NativeMigrationApplyRequest {
  databaseUrl: string;
  migrationsDir: string;
  expectedFingerprint: string;
  recoveryDirectory: string;
  pgDumpBinary: string;
  validateOnly?: boolean;
  startupGate?: {
    policy?: "automatic" | "never" | "prompt";
    facts?: {
      autoApplyRequested: boolean;
      promptNever: boolean;
      interactive: boolean;
      embeddedClusterInitializedBeforeStartup?: boolean;
      applicationDatabaseCreated?: boolean;
    };
    approval?: { stateToken: string; approved: boolean };
  };
}

export interface NativeMigrationApplyReport {
  manifestFingerprint: string;
  alreadyCurrent: boolean;
  appliedMigrations: string[];
  reconciledLegacyMigrations: string[];
  normalizedLegacyColumns: string[];
  recoveryPoint: string | null;
}

export type NativeMigrationStartupOutcome =
  | { kind: "complete"; report: NativeMigrationApplyReport }
  | { kind: "approval-required"; stateToken: string; pendingMigrations: string[] }
  | { kind: "declined" }
  | { kind: "refused"; pendingMigrations: string[] }
  | { kind: "stale-approval" };

export class NativeMigrationApplyError extends Error {
  constructor(readonly code: string) {
    super(`Rust migration operator failed (${code}); startup stopped without a Node migration fallback.`);
    this.name = "NativeMigrationApplyError";
  }
}

export function resolveMigrationApplyBinary(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.RUDDER_NATIVE_MIGRATION_APPLY_PATH?.trim();
  if (configured) return path.resolve(configured);
  return path.join(path.dirname(resolveMigrationPreflightBinary(env)), process.platform === "win32" ? "migration-apply.exe" : "migration-apply");
}

function parseError(stdout: Buffer, exitCode: number | null, signal: NodeJS.Signals | null): Record<string, unknown> {
  if (signal) throw new NativeMigrationApplyError("operator_signalled");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
  } catch {
    throw new NativeMigrationApplyError("invalid_response");
  }
  if (!body || typeof body !== "object" || body.schema !== SCHEMA || body.protocolVersion !== 1) {
    throw new NativeMigrationApplyError("invalid_response");
  }
  if (body.status === "error" && exitCode === 2) {
    const error = body.error as { code?: unknown } | undefined;
    // Only protocol identifiers may reach logs; never child stderr or SQL/URLs.
    const code = typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,80}$/u.test(error.code) ? error.code : "operator_failed";
    throw new NativeMigrationApplyError(code);
  }
  return body;
}

function parseMigrationReport(value: unknown): NativeMigrationApplyReport {
  const report = value as NativeMigrationApplyReport | undefined;
  const strings = (value: unknown): value is string[] => Array.isArray(value)
    && value.length <= 4096 && value.every((item) => typeof item === "string" && item.length <= 4096);
  if (!report
    || typeof report.manifestFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(report.manifestFingerprint)
    || typeof report.alreadyCurrent !== "boolean"
    || !strings(report.appliedMigrations) || !strings(report.reconciledLegacyMigrations)
    || !strings(report.normalizedLegacyColumns)
    || !(report.recoveryPoint === null || typeof report.recoveryPoint === "string")) {
    throw new NativeMigrationApplyError("invalid_response");
  }
  return report;
}

function parseStartupOutcome(body: Record<string, unknown>, exitCode: number | null): NativeMigrationStartupOutcome {
  if (exitCode !== 0 || body.status !== "startup") throw new NativeMigrationApplyError("invalid_response");
  const outcome = body.outcome as Record<string, unknown> | undefined;
  if (!outcome || typeof outcome.kind !== "string") throw new NativeMigrationApplyError("invalid_response");
  if (outcome.kind === "complete") return { kind: "complete", report: parseMigrationReport(outcome.report) };
  if (outcome.kind === "declined") return { kind: "declined" };
  if (outcome.kind === "stale-approval") return { kind: "stale-approval" };
  if (outcome.kind !== "approval-required" && outcome.kind !== "refused") {
    throw new NativeMigrationApplyError("invalid_response");
  }
  const pendingMigrations = outcome.pendingMigrations;
  if (!Array.isArray(pendingMigrations) || pendingMigrations.length > 4096
    || pendingMigrations.some((item) => typeof item !== "string" || item.length > 4096)) {
    throw new NativeMigrationApplyError("invalid_response");
  }
  if (outcome.kind === "refused") return { kind: "refused", pendingMigrations: pendingMigrations as string[] };
  if (typeof outcome.stateToken !== "string" || !/^[a-f0-9]{64}$/u.test(outcome.stateToken)) {
    throw new NativeMigrationApplyError("invalid_response");
  }
  return { kind: "approval-required", stateToken: outcome.stateToken, pendingMigrations: pendingMigrations as string[] };
}

/** Temporary process transport only: all inspection, locking and database writes are Rust-owned. */
async function runNativeMigrationProcess(
  request: NativeMigrationApplyRequest,
  options: { binaryPath?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Awaited<ReturnType<typeof runMigrationProcess>>> {
  const input = JSON.stringify({
    schema: SCHEMA, protocolVersion: 1, allowApply: true,
    migrationsDir: request.migrationsDir, expectedFingerprint: request.expectedFingerprint,
    recoveryDirectory: request.recoveryDirectory, pgDumpBinary: request.pgDumpBinary,
    ...(request.validateOnly ? { validateOnly: true } : {}),
    ...(request.startupGate ? { startupGate: request.startupGate } : {}),
  });
  if (Buffer.byteLength(input) > 256 * 1024) throw new NativeMigrationApplyError("input_too_large");
  if (options.signal?.aborted) throw new NativeMigrationApplyError("aborted");
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60 * 60 * 1000) throw new NativeMigrationApplyError("invalid_timeout");
  const env = options.env ?? process.env;
  const command = resolveNativeCommand(options.binaryPath ?? resolveMigrationApplyBinary(env));
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"]) {
    if (env[name] !== undefined) childEnv[name] = env[name];
  }
  childEnv.RUDDER_MIGRATION_APPLY_DATABASE_URL = request.databaseUrl;
  let cancellationDirectory: string;
  try {
    cancellationDirectory = await mkdtemp(path.join(tmpdir(), "rudder-migration-apply-"));
  } catch {
    throw new NativeMigrationApplyError("cancel_transport_unavailable");
  }
  const cancellationFile = path.join(cancellationDirectory, "cancel");
  let cancellationWrite: Promise<void> | undefined;
  childEnv.RUDDER_MIGRATION_APPLY_CANCEL_FILE = cancellationFile;
  // The Rust operator opens this process by PID and retains the OS process
  // handle. On Windows this lets it cancel in-flight work if Node is
  // terminated with TerminateProcess, which cannot deliver an AbortSignal.
  childEnv.RUDDER_MIGRATION_APPLY_SUPERVISOR_PID = String(process.pid);
  let output: Awaited<ReturnType<typeof runMigrationProcess>>;
  try {
    output = await runMigrationProcess(command.command, command.args, input, childEnv, timeoutMs, {
      signal: options.signal, waitForCloseOnFailure: true,
      terminationGraceMs: CANCELLATION_CLEANUP_GRACE_MS,
      requestCancellation: () => {
        cancellationWrite ??= writeFile(cancellationFile, "cancel\n", { flag: "wx", mode: 0o600 }).catch((error: unknown) => {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return;
          throw error;
        });
        return cancellationWrite;
      },
      preserveStructuredFailure: { schema: SCHEMA, code: "cancellation_cleanup_unconfirmed" },
    });
  } catch (error) {
    if (error instanceof MigrationPreflightAdapterError) {
      throw new NativeMigrationApplyError(error.code === "process_failed" ? "spawn_failed" : error.code);
    }
    throw error;
  } finally {
    await cancellationWrite?.catch(() => undefined);
    await unlink(cancellationFile).catch(() => undefined);
    await rmdir(cancellationDirectory).catch(() => undefined);
  }
  return output;
}

export async function runNativeMigrationApply(
  request: NativeMigrationApplyRequest,
  options: { binaryPath?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<NativeMigrationApplyReport> {
  if (request.startupGate) throw new NativeMigrationApplyError("startup_gate_requires_startup_transport");
  const output = await runNativeMigrationProcess(request, options);
  if (output.stderr.byteLength) throw new NativeMigrationApplyError("unexpected_stderr");
  const body = parseError(output.stdout, output.exitCode, output.signal);
  if (body.status !== (request.validateOnly ? "validated" : "applied")) throw new NativeMigrationApplyError("invalid_response");
  const report = parseMigrationReport(body.report);
  if (report.manifestFingerprint !== request.expectedFingerprint) throw new NativeMigrationApplyError("source_identity_mismatch");
  if (request.validateOnly && (!report.alreadyCurrent || report.appliedMigrations.length || report.reconciledLegacyMigrations.length || report.normalizedLegacyColumns.length || report.recoveryPoint)) {
    throw new NativeMigrationApplyError("validation_mutation_receipt");
  }
  return report;
}

export async function runNativeMigrationStartup(
  request: Omit<NativeMigrationApplyRequest, "validateOnly" | "startupGate"> & {
    startupGate: NonNullable<NativeMigrationApplyRequest["startupGate"]>;
  },
  options: { binaryPath?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<NativeMigrationStartupOutcome> {
  const output = await runNativeMigrationProcess(request, options);
  if (output.stderr.byteLength) throw new NativeMigrationApplyError("unexpected_stderr");
  const body = parseError(output.stdout, output.exitCode, output.signal);
  const outcome = parseStartupOutcome(body, output.exitCode);
  const approval = request.startupGate.approval;
  if ((approval?.approved && (outcome.kind === "approval-required" || outcome.kind === "declined"))
    || (approval?.approved === false && outcome.kind !== "declined")
    || (!approval && (outcome.kind === "stale-approval" || outcome.kind === "declined"))) {
    throw new NativeMigrationApplyError("invalid_response");
  }
  if (outcome.kind === "complete" && outcome.report.manifestFingerprint !== request.expectedFingerprint) {
    throw new NativeMigrationApplyError("source_identity_mismatch");
  }
  return outcome;
}
