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
): Promise<NativePayloadEnvelope> {
  let stdout = "";
  let stderr = "";
  try {
    const command = resolveNativeCommand(resolveNativePayloadBinary(), args);
    const result = await execFileAsync(command.command, command.args, {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT_BYTES,
      windowsHide: true,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const detail = error as { stdout?: unknown; stderr?: unknown; code?: unknown };
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

export async function verifyNativePayload(archivePath: string, expectedSha256: string, maxArchiveBytes: number) {
  return runNativePayload("payload.verify", [
    "payload", "verify", path.resolve(archivePath), expectedSha256, String(maxArchiveBytes),
  ], false);
}

export async function extractNativePayload(archivePath: string, stagingPath: string, maxArchiveBytes: number) {
  try {
    return await runNativePayload("payload.extract", [
      "payload", "extract", path.resolve(archivePath), "auto", path.resolve(stagingPath),
      String(maxArchiveBytes), String(maxArchiveBytes), String(maxArchiveBytes * 2), "0",
    ], true);
  } catch (error) {
    if (error instanceof NativePayloadError && error.code === "process_failed" && !existsSync(stagingPath)) {
      throw new NativePayloadError("process_failed", false, error.message);
    }
    throw error;
  }
}

export async function probeNativePayloadVersion(rootPath: string, executable: string) {
  return runNativePayload("payload.probeVersion", [
    "payload", "probe-version", path.resolve(rootPath), executable, "PostgreSQL 18.4",
  ], true);
}

export async function publishNativePayload(stagingPath: string, destinationPath: string) {
  return runNativePayload("payload.publish", [
    "payload", "publish", path.resolve(stagingPath), path.resolve(destinationPath),
  ], true);
}

export async function tryInstallNativePayload(input: {
  archivePath: string;
  extractPath: string;
  publishStagingPath: string;
  destinationPath: string;
  maxArchiveBytes: number;
  expectedSha256?: string | null;
  preparePublish(extractPath: string, publishStagingPath: string): Promise<string>;
  validatePublished(destinationPath: string): Promise<void>;
}): Promise<{ installed: boolean; fallbackCode: string | null; diagnostic: RudderNativeDiagnostic }> {
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
    const error = new NativePayloadError("trusted_digest_unavailable", false);
    if (!policy.fallbackAllowed) throw error;
    return {
      installed: false,
      fallbackCode: error.code,
      diagnostic: error.diagnostic,
    };
  }
  try {
    if (expectedSha256) {
      await verifyNativePayload(input.archivePath, expectedSha256, input.maxArchiveBytes);
    }
    await extractNativePayload(input.archivePath, input.extractPath, input.maxArchiveBytes);
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
    const versionExecutable = await input.preparePublish(input.extractPath, input.publishStagingPath);
    await probeNativePayloadVersion(input.publishStagingPath, versionExecutable);
    const published = await publishNativePayload(input.publishStagingPath, input.destinationPath);
    await input.validatePublished(input.destinationPath);
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
    await fs.rm(input.publishStagingPath, { recursive: true, force: true });
  }
}
