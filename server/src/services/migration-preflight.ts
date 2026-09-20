import { resolveNativeCommand } from "@rudderhq/agent-runtime-utils";
import {
  createMigrationManifest,
  getMigrationSourcePaths,
  type MigrationSourcePaths,
  type MigrationState,
} from "@rudderhq/db";
import { resolveRudderNativeCapability } from "@rudderhq/shared";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATION_PREFLIGHT_SCHEMA = "rudder.migration-preflight/v1" as const;
export const MIGRATION_PREFLIGHT_PROTOCOL_VERSION = 1 as const;
export const MIGRATION_PREFLIGHT_DATABASE_URL_ENV = "RUDDER_MIGRATION_PREFLIGHT_DATABASE_URL" as const;
export const MIGRATION_PREFLIGHT_PATH_ENV = "RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH" as const;

const LEGACY_MIGRATION_PREFLIGHT_PATH_ENV = "RUDDER_MIGRATION_PREFLIGHT_PATH" as const;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_DATABASE_URL_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_HISTORY_ITEMS = 4_096;

const PREFLIGHT_STATUSES = [
  "bootstrap",
  "unsafe-legacy",
  "pending",
  "mismatch",
  "missing-core-schema",
  "current",
] as const;
const HISTORY_STATUSES = ["upToDate", "needsMigrations"] as const;
const HISTORY_REASONS = [
  "manifest-match",
  "migration-journal-missing",
  "empty-history",
  "pending-migrations",
  "manifest-mismatch",
  "migration-journal-invalid",
] as const;
const ERROR_CLASSIFICATIONS = ["protocol", "source", "configuration", "database"] as const;

export type MigrationPreflightStatus = (typeof PREFLIGHT_STATUSES)[number];
export type MigrationHistoryStatus = (typeof HISTORY_STATUSES)[number];
export type MigrationHistoryReason = (typeof HISTORY_REASONS)[number];
export type MigrationPreflightErrorClassification =
  | (typeof ERROR_CLASSIFICATIONS)[number]
  | "process";

export interface MigrationPreflightSource {
  migrationsDir: string;
  journalFile?: string;
  expectedFingerprint?: string;
}

export interface MigrationPreflightInput {
  databaseUrl: string;
  source: MigrationPreflightSource;
}

export interface MigrationHistoryIdentity {
  order: number;
  fileName: string;
  sha256: string;
  id: number | null;
  name: string | null;
  hash: string | null;
  createdAt: number | null;
}

export interface MigrationHistoryPreflight {
  status: MigrationHistoryStatus;
  reason: MigrationHistoryReason;
  manifestFingerprint: string;
  migrationTableSchema: string | null;
  journalEntryCount: number;
  appliedMigrations: MigrationHistoryIdentity[];
  pendingMigrations: MigrationHistoryIdentity[];
  diagnostics: string[];
}

export interface MigrationPreflightReport {
  status: MigrationPreflightStatus;
  tableCount: number;
  journalPresent: boolean;
  journalSchema: string | null;
  coreSchemaPresent: boolean;
  organizationsTablePresent: boolean;
  history: MigrationHistoryPreflight;
  diagnostics: string[];
}

export interface MigrationPreflightAdapterOptions {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  spawnProcess?: MigrationPreflightSpawn;
}

export type MigrationPreflightSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export class MigrationPreflightAdapterError extends Error {
  constructor(
    readonly classification: MigrationPreflightErrorClassification,
    readonly code: string,
  ) {
    super(`Migration preflight failed: ${code}`);
    this.name = "MigrationPreflightAdapterError";
  }
}

type MigrationPreflightLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
};

export type MigrationPreflightStartupResult = Readonly<{
  report: MigrationPreflightReport | null;
  required: boolean;
  manifestFingerprint: string | null;
  manifestMigrationFileNames: readonly string[] | null;
}>;

function expectedMigrationPreflightStatus(state: MigrationState): MigrationPreflightStatus {
  if (state.status === "upToDate") return "current";
  switch (state.reason) {
    case "no-migration-journal-empty-db":
      return "bootstrap";
    case "no-migration-journal-non-empty-db":
      return "unsafe-legacy";
    case "pending-migrations":
      return "pending";
    case "missing-core-schema":
      return "missing-core-schema";
  }
}

function migrationPreflightSummary(report: MigrationPreflightReport) {
  return {
    status: report.status,
    tableCount: report.tableCount,
    journalPresent: report.journalPresent,
    journalSchema: report.journalSchema,
    coreSchemaPresent: report.coreSchemaPresent,
    organizationsTablePresent: report.organizationsTablePresent,
    historyStatus: report.history.status,
    historyReason: report.history.reason,
    manifestFingerprint: report.history.manifestFingerprint,
  };
}

export async function runMigrationPreflightBeforeNodeInspection(options: {
  connectionString: string;
  label: string;
  logger: MigrationPreflightLogger;
  env?: NodeJS.ProcessEnv;
  sourcePaths?: MigrationSourcePaths;
}): Promise<MigrationPreflightStartupResult> {
  const policy = resolveRudderNativeCapability({
    capability: "migration-preflight",
    env: options.env ?? process.env,
  });
  if (!policy.enabled) {
    return {
      report: null,
      required: policy.required,
      manifestFingerprint: null,
      manifestMigrationFileNames: null,
    };
  }

  const sourcePaths = options.sourcePaths ?? getMigrationSourcePaths();
  const migrationManifest = await createMigrationManifest({
    migrationsFolder: sourcePaths.migrationsFolder,
    journalFile: sourcePaths.journalFile,
  });
  try {
    const report = await runMigrationPreflight({
      databaseUrl: options.connectionString,
      source: {
        migrationsDir: sourcePaths.migrationsFolder,
        journalFile: sourcePaths.journalFile,
        expectedFingerprint: migrationManifest.fingerprint,
      },
    });
    options.logger.info(
      { label: options.label, ...migrationPreflightSummary(report) },
      `${options.label} Rust migration preflight completed before Node migration inspection`,
    );
    return {
      report,
      required: policy.required,
      manifestFingerprint: migrationManifest.fingerprint,
      manifestMigrationFileNames: migrationManifest.entries.map(({ fileName }) => fileName),
    };
  } catch (error) {
    const code = error instanceof MigrationPreflightAdapterError ? error.code : "unknown";
    if (policy.required) {
      throw new Error(
        `${options.label} Rust migration preflight is required but failed (${code}); refusing to inspect or mutate migration state.`,
        { cause: error },
      );
    }
    options.logger.warn(
      { label: options.label, code },
      `${options.label} Rust migration preflight unavailable; continuing with the Node migration authority`,
    );
    return {
      report: null,
      required: false,
      manifestFingerprint: null,
      manifestMigrationFileNames: null,
    };
  }
}

export function assertMigrationPreflightAgreement(options: {
  label: string;
  state: MigrationState;
  report: MigrationPreflightReport | null;
  required: boolean;
  manifestFingerprint: string | null;
  manifestMigrationFileNames?: readonly string[] | null;
  logger: MigrationPreflightLogger;
}): void {
  if (!options.report) return;
  const expectedStatus = expectedMigrationPreflightStatus(options.state);
  if (options.report.status !== expectedStatus) {
    const detail = `${options.report.status} != ${expectedStatus}`;
    if (options.required) {
      throw new Error(
        `${options.label} Rust migration preflight disagreed with the Node migration inspection (${detail}); refusing to mutate migration state.`,
      );
    }
    options.logger.warn(
      { label: options.label, nativeStatus: options.report.status, nodeStatus: expectedStatus },
      `${options.label} Rust migration preflight disagreed with the Node migration inspection; continuing with the Node migration authority`,
    );
    return;
  }

  const nodeAppliedMigrations = options.state.appliedMigrations;
  const nodePendingMigrations = options.state.status === "needsMigrations"
    ? options.state.pendingMigrations
    : [];
  const orderedNodePendingMigrations = options.manifestMigrationFileNames
    ? orderMigrationsByManifest(nodePendingMigrations, options.manifestMigrationFileNames)
    : nodePendingMigrations;
  const nativeAppliedMigrations = options.report.history.appliedMigrations.map(({ fileName }) => fileName);
  const nativePendingMigrations = options.report.history.pendingMigrations.map(({ fileName }) => fileName);
  const expectedNativePendingMigrations = options.state.status === "needsMigrations"
    && options.state.reason === "missing-core-schema"
    ? []
    : orderedNodePendingMigrations;
  const disagreements: string[] = [];
  if (options.manifestFingerprint === null
    || options.report.history.manifestFingerprint !== options.manifestFingerprint) {
    disagreements.push("manifest-fingerprint");
  }
  if (!sameMigrationPlan(nativeAppliedMigrations, nodeAppliedMigrations)) {
    disagreements.push("applied-migrations");
  }
  if (!sameMigrationPlan(nativePendingMigrations, expectedNativePendingMigrations)) {
    disagreements.push("pending-migrations");
  }
  if (disagreements.length === 0) return;

  const detail = disagreements.join(", ");
  if (options.required) {
    throw new Error(
      `${options.label} Rust migration preflight disagreed with the Node migration plan (${detail}); refusing to mutate migration state.`,
    );
  }
  options.logger.warn(
    {
      label: options.label,
      nativeStatus: options.report.status,
      nodeStatus: expectedStatus,
      disagreements,
    },
    `${options.label} Rust migration preflight disagreed with the Node migration plan (${detail}); continuing with the Node migration authority`,
  );
}

function sameMigrationPlan(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((fileName, index) => fileName === right[index]);
}

function orderMigrationsByManifest(
  migrations: readonly string[],
  manifestFileNames: readonly string[],
): string[] {
  const orderByFileName = new Map(manifestFileNames.map((fileName, order) => [fileName, order]));
  return migrations
    .map((fileName, originalOrder) => ({ fileName, originalOrder }))
    .sort((left, right) => {
      const leftOrder = orderByFileName.get(left.fileName);
      const rightOrder = orderByFileName.get(right.fileName);
      if (leftOrder === undefined && rightOrder === undefined) {
        return left.originalOrder - right.originalOrder;
      }
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;
      return leftOrder - rightOrder;
    })
    .map(({ fileName }) => fileName);
}

export function resolveMigrationPreflightBinary(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[MIGRATION_PREFLIGHT_PATH_ENV]?.trim()
    || env[LEGACY_MIGRATION_PREFLIGHT_PATH_ENV]?.trim();
  if (configured) return path.resolve(configured);

  const binaryName = process.platform === "win32"
    ? "migration-preflight.exe"
    : "migration-preflight";
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const target = resolveNativeTarget();
  const resourcesPath = env.RUDDER_DESKTOP_RESOURCES_PATH?.trim()
    || (typeof (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath === "string"
      ? (process as NodeJS.Process & { resourcesPath: string }).resourcesPath
      : "");
  const candidates = [
    path.resolve(moduleDir, "../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../native", target ?? "unsupported", binaryName),
    resourcesPath && target ? path.resolve(resourcesPath, "native", target, binaryName) : "",
    path.resolve(moduleDir, "../../../native/target/release", binaryName),
    path.resolve(moduleDir, "../../../../native/target/release", binaryName),
    target ? path.resolve(moduleDir, "../../../native/target", target, "release", binaryName) : "",
    target ? path.resolve(moduleDir, "../../../../native/target", target, "release", binaryName) : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export async function runMigrationPreflight(
  input: MigrationPreflightInput,
  options: MigrationPreflightAdapterOptions = {},
): Promise<MigrationPreflightReport> {
  const request = createMigrationPreflightRequest(input.source);
  validateDatabaseUrl(input.databaseUrl);

  const binaryPath = options.binaryPath ?? resolveMigrationPreflightBinary(options.env);
  const command = resolveNativeCommand(binaryPath);
  const env = {
    ...(options.env ?? process.env),
    [MIGRATION_PREFLIGHT_DATABASE_URL_ENV]: input.databaseUrl,
  };
  const timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const result = await runPreflightProcess(
    command.command,
    command.args,
    request,
    env,
    timeoutMs,
    options,
  );
  return parsePreflightResponse(result.stdout, result.stderr, result.exitCode, result.signal);
}

export function createMigrationPreflightRequest(source: MigrationPreflightSource): string {
  const request = JSON.stringify({
    schema: MIGRATION_PREFLIGHT_SCHEMA,
    protocolVersion: MIGRATION_PREFLIGHT_PROTOCOL_VERSION,
    source: {
      migrationsDir: source.migrationsDir,
      ...(source.journalFile === undefined ? {} : { journalFile: source.journalFile }),
      ...(source.expectedFingerprint === undefined
        ? {}
        : { expectedFingerprint: source.expectedFingerprint }),
    },
  });
  if (Buffer.byteLength(request, "utf8") > MAX_REQUEST_BYTES) {
    throw new MigrationPreflightAdapterError("protocol", "input_too_large");
  }
  return request;
}

function resolveNativeTarget(): string | null {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "aarch64-apple-darwin";
    if (process.arch === "x64") return "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    if (process.arch === "arm64") return "aarch64-unknown-linux-gnu";
    if (process.arch === "x64") return "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    if (process.arch === "arm64") return "aarch64-pc-windows-msvc";
    if (process.arch === "x64") return "x86_64-pc-windows-msvc";
  }
  return null;
}

function validateDatabaseUrl(databaseUrl: string): void {
  if (!databaseUrl) {
    throw new MigrationPreflightAdapterError("configuration", "database_url_missing");
  }
  if (Buffer.byteLength(databaseUrl, "utf8") > MAX_DATABASE_URL_BYTES) {
    throw new MigrationPreflightAdapterError("configuration", "database_url_too_large");
  }
  if (!databaseUrl.startsWith("postgres://") && !databaseUrl.startsWith("postgresql://")) {
    throw new MigrationPreflightAdapterError("configuration", "database_url_protocol_unsupported");
  }
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new MigrationPreflightAdapterError("configuration", "timeout_invalid");
  }
  return timeoutMs;
}

interface PreflightProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
}

async function runPreflightProcess(
  command: string,
  args: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  options: MigrationPreflightAdapterOptions,
): Promise<PreflightProcessResult> {
  const spawnProcess: MigrationPreflightSpawn = options.spawnProcess ?? ((file, argv, spawnOptions) => (
    spawn(file, argv, spawnOptions) as ChildProcessWithoutNullStreams
  ));
  return await new Promise<PreflightProcessResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(command, args, {
        env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      reject(new MigrationPreflightAdapterError("process", "spawn_failed"));
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let processClosed = false;
    let terminationRequested = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settleError = (error: MigrationPreflightAdapterError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already have exited; the original failure is enough.
      }
      if (processClosed) return;
      forceKill = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may already have exited.
        }
        forceKill = undefined;
      }, 250);
      forceKill.unref?.();
    };
    const onAbort = () => {
      terminate();
      settleError(new MigrationPreflightAdapterError("process", "aborted"));
    };
    const appendOutput = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const next = Buffer.concat([target === "stdout" ? stdout : stderr, bytes]);
      if (next.byteLength > MAX_OUTPUT_BYTES) {
        terminate();
        settleError(new MigrationPreflightAdapterError("protocol", "output_too_large"));
        return;
      }
      if (target === "stdout") stdout = next;
      else stderr = next;
    };

    child.stdout.on("data", (chunk: Buffer | string) => appendOutput("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer | string) => appendOutput("stderr", chunk));
    child.once("error", () => settleError(new MigrationPreflightAdapterError("process", "process_failed")));
    child.once("close", (exitCode, signal) => {
      processClosed = true;
      if (settled) {
        if (forceKill) clearTimeout(forceKill);
        forceKill = undefined;
        return;
      }
      settled = true;
      cleanup();
      if (forceKill) clearTimeout(forceKill);
      forceKill = undefined;
      resolve({ stdout, stderr, exitCode, signal });
    });
    child.stdin.once("error", () => settleError(new MigrationPreflightAdapterError("process", "stdin_write_failed")));

    timeout = setTimeout(() => {
      terminate();
      settleError(new MigrationPreflightAdapterError("process", "timeout"));
    }, timeoutMs);
    timeout.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    try {
      child.stdin.end(input, "utf8");
    } catch {
      settleError(new MigrationPreflightAdapterError("process", "stdin_write_failed"));
    }
  });
}

function parsePreflightResponse(
  stdout: Buffer,
  stderr: Buffer,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): MigrationPreflightReport {
  const output = decodeUtf8(stdout, "output_invalid_utf8");
  const stderrOutput = decodeUtf8(stderr, "stderr_invalid_utf8");
  if (stderrOutput.trim()) {
    throw new MigrationPreflightAdapterError("protocol", "unexpected_stderr");
  }

  const line = output.trim();
  if (!line || line.split(/\r?\n/).length !== 1) {
    throw new MigrationPreflightAdapterError("protocol", "response_line_count");
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new MigrationPreflightAdapterError("protocol", "malformed_json");
  }
  const response = asObject(value, "response_envelope_mismatch");
  assertKeys(response, ["schema", "protocolVersion", "status", "report", "error"], "response_envelope_mismatch");
  if (response.schema !== MIGRATION_PREFLIGHT_SCHEMA
    || response.protocolVersion !== MIGRATION_PREFLIGHT_PROTOCOL_VERSION
    || typeof response.status !== "string") {
    throw new MigrationPreflightAdapterError("protocol", "response_envelope_mismatch");
  }

  if (response.status === "error") {
    if (exitCode !== 2 || signal !== null || response.report !== undefined || response.error === undefined) {
      throw new MigrationPreflightAdapterError("protocol", "error_exit_code_mismatch");
    }
    throw parseRemoteError(response.error);
  }

  if (!isPreflightStatus(response.status)
    || exitCode !== 0
    || signal !== null
    || response.error !== undefined
    || response.report === undefined) {
    throw new MigrationPreflightAdapterError("protocol", "response_envelope_mismatch");
  }
  const report = parseReport(response.report);
  assertReportSemantics(report);
  if (report.status !== response.status) {
    throw new MigrationPreflightAdapterError("protocol", "report_status_mismatch");
  }
  return report;
}

function parseRemoteError(value: unknown): MigrationPreflightAdapterError {
  const error = asObject(value, "error_envelope_mismatch");
  assertKeys(error, ["classification", "code", "message"], "error_envelope_mismatch");
  if (!isErrorClassification(error.classification)
    || !isSafeToken(error.code)
    || typeof error.message !== "string") {
    throw new MigrationPreflightAdapterError("protocol", "error_envelope_mismatch");
  }
  return new MigrationPreflightAdapterError(error.classification, error.code);
}

function parseReport(value: unknown): MigrationPreflightReport {
  const report = asObject(value, "report_envelope_mismatch");
  assertKeys(report, [
    "status",
    "tableCount",
    "journalPresent",
    "journalSchema",
    "coreSchemaPresent",
    "organizationsTablePresent",
    "history",
    "diagnostics",
  ], "report_envelope_mismatch");
  if (!isPreflightStatus(report.status)
    || !isSafeNonNegativeInteger(report.tableCount)
    || typeof report.journalPresent !== "boolean"
    || !isStringOrNull(report.journalSchema)
    || typeof report.coreSchemaPresent !== "boolean"
    || typeof report.organizationsTablePresent !== "boolean"
    || !Array.isArray(report.diagnostics)) {
    throw new MigrationPreflightAdapterError("protocol", "report_envelope_mismatch");
  }
  const diagnostics = parseStringList(report.diagnostics, "report_diagnostics_invalid");
  const history = parseHistory(report.history);
  return {
    status: report.status,
    tableCount: report.tableCount,
    journalPresent: report.journalPresent,
    journalSchema: report.journalSchema,
    coreSchemaPresent: report.coreSchemaPresent,
    organizationsTablePresent: report.organizationsTablePresent,
    history,
    diagnostics,
  };
}

function assertReportSemantics(report: MigrationPreflightReport): void {
  if ((report.journalPresent && report.journalSchema === null)
    || (!report.journalPresent && report.journalSchema !== null)) {
    throw new MigrationPreflightAdapterError("protocol", "report_semantics_invalid");
  }

  const historyNeedsMigrations = report.history.status === "needsMigrations";
  const reasonNeedsMigrations = report.history.reason !== "manifest-match";
  if (historyNeedsMigrations !== reasonNeedsMigrations) {
    throw new MigrationPreflightAdapterError("protocol", "report_semantics_invalid");
  }

  const validStatus = (() => {
    switch (report.status) {
      case "bootstrap":
        return !report.journalPresent
          && report.tableCount === 0
          && report.history.reason === "migration-journal-missing";
      case "unsafe-legacy":
        return !report.journalPresent
          && report.tableCount > 0
          && report.history.reason === "migration-journal-missing";
      case "pending":
        return report.journalPresent
          && (report.history.reason === "pending-migrations" || report.history.reason === "empty-history");
      case "mismatch":
        return report.journalPresent
          && (report.history.reason === "manifest-mismatch" || report.history.reason === "migration-journal-invalid");
      case "missing-core-schema":
        return report.journalPresent
          && report.history.reason === "manifest-match"
          && (!report.coreSchemaPresent || !report.organizationsTablePresent);
      case "current":
        return report.journalPresent
          && report.history.reason === "manifest-match"
          && report.coreSchemaPresent
          && report.organizationsTablePresent;
    }
  })();
  if (!validStatus) {
    throw new MigrationPreflightAdapterError("protocol", "report_semantics_invalid");
  }
}

function parseHistory(value: unknown): MigrationHistoryPreflight {
  const history = asObject(value, "history_envelope_mismatch");
  assertKeys(history, [
    "status",
    "reason",
    "manifestFingerprint",
    "migrationTableSchema",
    "journalEntryCount",
    "appliedMigrations",
    "pendingMigrations",
    "diagnostics",
  ], "history_envelope_mismatch");
  if (!isHistoryStatus(history.status)
    || !isHistoryReason(history.reason)
    || typeof history.manifestFingerprint !== "string"
    || !isStringOrNull(history.migrationTableSchema)
    || !isSafeNonNegativeInteger(history.journalEntryCount)
    || !Array.isArray(history.appliedMigrations)
    || !Array.isArray(history.pendingMigrations)
    || !Array.isArray(history.diagnostics)
    || history.appliedMigrations.length > MAX_HISTORY_ITEMS
    || history.pendingMigrations.length > MAX_HISTORY_ITEMS) {
    throw new MigrationPreflightAdapterError("protocol", "history_envelope_mismatch");
  }
  return {
    status: history.status,
    reason: history.reason,
    manifestFingerprint: history.manifestFingerprint,
    migrationTableSchema: history.migrationTableSchema,
    journalEntryCount: history.journalEntryCount,
    appliedMigrations: history.appliedMigrations.map(parseHistoryIdentity),
    pendingMigrations: history.pendingMigrations.map(parseHistoryIdentity),
    diagnostics: parseStringList(history.diagnostics, "history_diagnostics_invalid"),
  };
}

function parseHistoryIdentity(value: unknown): MigrationHistoryIdentity {
  const identity = asObject(value, "history_identity_invalid");
  assertKeys(identity, ["order", "fileName", "sha256", "id", "name", "hash", "createdAt"], "history_identity_invalid");
  if (!isSafeNonNegativeInteger(identity.order)
    || typeof identity.fileName !== "string"
    || typeof identity.sha256 !== "string"
    || !isPositiveIntegerOrNull(identity.id)
    || !isStringOrNull(identity.name)
    || !isStringOrNull(identity.hash)
    || !isNonNegativeIntegerOrNull(identity.createdAt)) {
    throw new MigrationPreflightAdapterError("protocol", "history_identity_invalid");
  }
  return {
    order: identity.order,
    fileName: identity.fileName,
    sha256: identity.sha256,
    id: identity.id,
    name: identity.name,
    hash: identity.hash,
    createdAt: identity.createdAt,
  };
}

function parseStringList(value: unknown[], code: string): string[] {
  if (value.length > MAX_HISTORY_ITEMS) {
    throw new MigrationPreflightAdapterError("protocol", code);
  }
  if (!value.every((item) => typeof item === "string")) {
    throw new MigrationPreflightAdapterError("protocol", code);
  }
  return value as string[];
}

function decodeUtf8(value: Buffer, code: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new MigrationPreflightAdapterError("protocol", code);
  }
}

function asObject(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MigrationPreflightAdapterError("protocol", code);
  }
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new MigrationPreflightAdapterError("protocol", code);
  }
}

function isPreflightStatus(value: unknown): value is MigrationPreflightStatus {
  return typeof value === "string"
    && (PREFLIGHT_STATUSES as readonly string[]).includes(value);
}

function isHistoryStatus(value: unknown): value is MigrationHistoryStatus {
  return typeof value === "string"
    && (HISTORY_STATUSES as readonly string[]).includes(value);
}

function isHistoryReason(value: unknown): value is MigrationHistoryReason {
  return typeof value === "string"
    && (HISTORY_REASONS as readonly string[]).includes(value);
}

function isErrorClassification(value: unknown): value is (typeof ERROR_CLASSIFICATIONS)[number] {
  return typeof value === "string"
    && (ERROR_CLASSIFICATIONS as readonly string[]).includes(value);
}

function isSafeToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveIntegerOrNull(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && typeof value === "number" && value > 0);
}

function isNonNegativeIntegerOrNull(value: unknown): value is number | null {
  return value === null || isSafeNonNegativeInteger(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
