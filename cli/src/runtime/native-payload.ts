import { resolveNativeCommand } from "@rudderhq/agent-runtime-utils";
import {
  createRudderNativeDiagnostic,
  resolveRudderNativeCapability,
  resolveRudderNativeTarget,
  type RudderNativeDiagnostic,
} from "@rudderhq/shared";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROTOCOL_VERSION = 1;
const OUTPUT_LIMIT_BYTES = 256 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;

type NativePayloadEnvelope = Record<string, unknown> & {
  ok?: unknown;
  capability?: unknown;
  protocolVersion?: unknown;
  accepted?: unknown;
  fallbackSafe?: unknown;
  errorCode?: unknown;
};

export interface NativePayloadDeadlineContext {
  signal: AbortSignal;
  remainingMs(): number | undefined;
}

export class NativePayloadError extends Error {
  readonly code: string;
  readonly accepted: boolean;
  readonly fallbackSafe: boolean;
  readonly diagnostic: RudderNativeDiagnostic;

  constructor(code: string, accepted: boolean, detail?: unknown, envelope?: NativePayloadEnvelope) {
    const bounded = String(detail ?? code).replace(/\s+/g, " ").trim().slice(0, 180);
    super(`Native runtime payload ${code}: ${bounded}`);
    this.name = "NativePayloadError";
    this.code = code.slice(0, 80);
    this.accepted = accepted;
    // A digest mismatch is an integrity failure, not a capability or spawn
    // failure. Falling back would let the Node extractor publish unverified
    // bytes, so it must fail closed even though Rust has not accepted them.
    this.fallbackSafe = !accepted && this.code !== "sha256_mismatch";
    this.diagnostic = createRudderNativeDiagnostic({
      capability: "runtime-payload",
      target: typeof envelope?.target === "string" ? envelope.target : nativeTarget(),
      binaryVersion: typeof envelope?.binaryVersion === "string" ? envelope.binaryVersion : "unavailable",
      protocolVersion: typeof envelope?.protocolVersion === "number" ? String(envelope.protocolVersion) : String(PROTOCOL_VERSION),
      effectiveEngine: accepted ? "rust" : "node",
      fallbackCode: code.slice(0, 80),
    });
  }
}

function nativeTarget() {
  return resolveRudderNativeTarget();
}

export function resolveNativePayloadBinary() {
  const configured = process.env.RUDDER_NATIVE_PAYLOAD_PATH?.trim() || process.env.RUDDER_NATIVE_PATH?.trim();
  if (configured) return path.resolve(configured);
  const binaryName = process.platform === "win32" ? "rudder-native.exe" : "rudder-native";
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const target = nativeTarget();
  const candidates = [
    path.resolve(moduleDir, "../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../native", target ?? "unsupported", binaryName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function parseEnvelope(stdout: string, capability: string): NativePayloadEnvelope {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new NativePayloadError("response_line_count", false, lines.length);
  let envelope: NativePayloadEnvelope;
  try {
    envelope = JSON.parse(lines[0]!) as NativePayloadEnvelope;
  } catch {
    throw new NativePayloadError("malformed_json", false, lines[0]);
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || envelope.capability !== capability || envelope.protocolVersion !== PROTOCOL_VERSION) {
    throw new NativePayloadError("envelope_mismatch", Boolean(envelope?.accepted));
  }
  return envelope;
}

async function runNativePayload(
  capability: string,
  args: string[],
  commandMayAccept: boolean,
  timeoutMs = TIMEOUT_MS,
): Promise<NativePayloadEnvelope> {
  let stdout = "";
  let stderr = "";
  try {
    const command = resolveNativeCommand(resolveNativePayloadBinary(), args);
    const result = await execFileAsync(command.command, command.args, {
      encoding: "utf8",
      timeout: Math.max(1, Math.min(TIMEOUT_MS, timeoutMs)),
      maxBuffer: OUTPUT_LIMIT_BYTES,
      windowsHide: true,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const detail = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      killed?: unknown;
      signal?: unknown;
    };
    stdout = typeof detail.stdout === "string" ? detail.stdout : "";
    stderr = typeof detail.stderr === "string" ? detail.stderr : "";
    if (stdout.trim()) {
      const envelope = parseEnvelope(stdout, capability);
      throw new NativePayloadError(
        typeof envelope.errorCode === "string" ? envelope.errorCode : "native_failed",
        envelope.accepted === true || envelope.fallbackSafe === false,
        stderr || detail.code,
        envelope,
      );
    }
    if (detail.code === "ETIMEDOUT" || detail.killed === true || detail.signal === "SIGTERM") {
      throw new NativePayloadError("deadline_exceeded", commandMayAccept, detail.code ?? detail.signal);
    }
    const failedBeforeSpawn = detail.code === "ENOENT" || detail.code === "EACCES";
    throw new NativePayloadError("process_failed", commandMayAccept && !failedBeforeSpawn, stderr || detail.code);
  }
  if (stderr.trim()) throw new NativePayloadError("unexpected_stderr", commandMayAccept, stderr);
  const envelope = parseEnvelope(stdout, capability);
  if (envelope.ok !== true) {
    throw new NativePayloadError(
      typeof envelope.errorCode === "string" ? envelope.errorCode : "native_failed",
      envelope.accepted === true || envelope.fallbackSafe === false,
      undefined,
      envelope,
    );
  }
  return envelope;
}

export function nativePayloadPolicy() {
  return resolveRudderNativeCapability({
    capability: "runtime-payload",
    env: process.env,
    legacyToggleEnvs: ["RUDDER_NATIVE_RUNTIME_PAYLOAD"],
  });
}

export async function verifyNativePayload(archivePath: string, expectedSha256: string, maxArchiveBytes: number, timeoutMs?: number) {
  return runNativePayload("payload.verify", [
    "payload", "verify", path.resolve(archivePath), expectedSha256, String(maxArchiveBytes),
  ], false, timeoutMs);
}

export async function extractNativePayload(archivePath: string, stagingPath: string, maxArchiveBytes: number, timeoutMs?: number) {
  try {
    return await runNativePayload("payload.extract", [
      "payload", "extract", path.resolve(archivePath), "auto", path.resolve(stagingPath),
      String(maxArchiveBytes), String(maxArchiveBytes), String(maxArchiveBytes * 2), "0",
    ], true, timeoutMs);
  } catch (error) {
    if (error instanceof NativePayloadError && error.code === "process_failed" && !existsSync(stagingPath)) {
      throw new NativePayloadError("process_failed", false, error.message);
    }
    throw error;
  }
}

export async function probeNativePayloadVersion(rootPath: string, executable: string, timeoutMs?: number) {
  return runNativePayload("payload.probeVersion", [
    "payload", "probe-version", path.resolve(rootPath), executable, "PostgreSQL 18.4",
  ], true, timeoutMs);
}

export async function publishNativePayload(stagingPath: string, destinationPath: string, timeoutMs?: number) {
  return runNativePayload("payload.publish", [
    "payload", "publish", path.resolve(stagingPath), path.resolve(destinationPath),
  ], true, timeoutMs);
}

export async function tryInstallNativePayload(input: {
  archivePath: string;
  extractPath: string;
  publishStagingPath: string;
  destinationPath: string;
  maxArchiveBytes: number;
  expectedSha256?: string | null;
  timeoutMs?: number;
  /** Test-only monotonic clock injection. */
  now?: () => number;
  /** Test-only staging cleanup injection. */
  cleanupPublishStaging?: (publishStagingPath: string) => Promise<void>;
  preparePublish(
    extractPath: string,
    publishStagingPath: string,
    context: NativePayloadDeadlineContext,
  ): Promise<string>;
  validatePublished(destinationPath: string, context: NativePayloadDeadlineContext): Promise<void>;
}): Promise<{ installed: boolean; fallbackCode: string | null; diagnostic: RudderNativeDiagnostic }> {
  const now = input.now ?? (() => performance.now());
  const expiresAt = input.timeoutMs === undefined ? null : now() + input.timeoutMs;
  const remainingTimeout = (accepted: boolean) => {
    if (expiresAt === null) return undefined;
    const remaining = Math.ceil(expiresAt - now());
    if (remaining <= 0) throw new NativePayloadError("deadline_exceeded", accepted);
    return remaining;
  };
  const runCallbackWithinDeadline = async <T>(
    accepted: boolean,
    callback: (context: NativePayloadDeadlineContext) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    const timeoutMs = remainingTimeout(accepted);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = timeoutMs === undefined
      ? null
      : new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new NativePayloadError("deadline_exceeded", accepted));
          }, timeoutMs);
        });
    const context: NativePayloadDeadlineContext = {
      signal: controller.signal,
      remainingMs: () => remainingTimeout(accepted),
    };
    try {
      const operation = callback(context);
      return timeoutPromise ? await Promise.race([operation, timeoutPromise]) : await operation;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const policy = nativePayloadPolicy();
  if (!policy.enabled) return {
    installed: false,
    fallbackCode: policy.disabledBy,
    diagnostic: {
      capability: "runtime-payload", target: nativeTarget() ?? "unsupported",
      binaryVersion: "not_started", protocolVersion: String(PROTOCOL_VERSION),
      effectiveEngine: "node", fallbackCode: policy.disabledBy,
    },
  };
  const expectedSha256 = input.expectedSha256?.trim().toLowerCase() || null;
  if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new NativePayloadError("trusted_digest_invalid", false);
  }
  if (!expectedSha256) {
    // An unpinned archive cannot be published automatically. Explicit node
    // mode and capability disables return before this point, so auto mode
    // must fail closed instead of handing unverified bytes to the Node writer.
    throw new NativePayloadError("trusted_digest_unavailable", false);
  }
  try {
    if (expectedSha256) {
      await verifyNativePayload(input.archivePath, expectedSha256, input.maxArchiveBytes, remainingTimeout(false));
    }
    await extractNativePayload(input.archivePath, input.extractPath, input.maxArchiveBytes, remainingTimeout(false));
  } catch (error) {
    const fallbackSafe = error instanceof NativePayloadError && error.fallbackSafe;
    if (!policy.fallbackAllowed || !fallbackSafe) throw error;
    const fallbackCode = error instanceof NativePayloadError ? error.code : "unexpected_error";
    return {
      installed: false,
      fallbackCode,
      diagnostic: error instanceof NativePayloadError ? error.diagnostic : {
        capability: "runtime-payload", target: nativeTarget() ?? "unsupported",
        binaryVersion: "unavailable", protocolVersion: String(PROTOCOL_VERSION),
        effectiveEngine: "node", fallbackCode,
      },
    };
  }
  try {
    const versionExecutable = await runCallbackWithinDeadline(
      true,
      (context) => input.preparePublish(input.extractPath, input.publishStagingPath, context),
    );
    await probeNativePayloadVersion(input.publishStagingPath, versionExecutable, remainingTimeout(true));
    const published = await publishNativePayload(input.publishStagingPath, input.destinationPath, remainingTimeout(true));
    await runCallbackWithinDeadline(
      true,
      (context) => input.validatePublished(input.destinationPath, context),
    );
    return {
      installed: true,
      fallbackCode: null,
      diagnostic: {
        capability: "runtime-payload",
        target: typeof published.target === "string" ? published.target : nativeTarget() ?? "unsupported",
        binaryVersion: typeof published.binaryVersion === "string" ? published.binaryVersion : "unknown",
        protocolVersion: String(published.protocolVersion),
        effectiveEngine: "rust",
        fallbackCode: null,
      },
    };
  } finally {
    const cleanup = input.cleanupPublishStaging
      ?? ((publishStagingPath: string) => fs.rm(publishStagingPath, { recursive: true, force: true }));
    // A slow staging deletion must not extend the shared runtime deadline.
    void cleanup(input.publishStagingPath).catch(() => {});
  }
}
