import { resolveNativeCommand } from "@rudderhq/agent-runtime-utils";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveNativeWorkspaceFilesBinary } from "./workspace-files-native.js";

const execFileAsync = promisify(execFile);
const PROTOCOL_VERSION = 1;
export const WORKSPACE_FILE_READ_MAX_BYTES = 1_000_000;
export const WORKSPACE_FILE_PATH_MAX_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

const REJECTED_PATH_CODES = new Set([
  "unsafe_workspace_path",
  "workspace_path_escape",
  "workspace_file_not_found",
  "workspace_not_directory",
  "workspace_not_file",
  "non_utf8_workspace_path",
  "manifest_path_limit",
]);

export type NativeWorkspaceFileRead = {
  filePath: string;
  byteSize: number;
  modifiedMillis: number;
  content: string;
};

type NativeResponse = {
  ok?: unknown;
  capability?: unknown;
  operation?: unknown;
  protocolVersion?: unknown;
  accepted?: unknown;
  filePath?: unknown;
  byteSize?: unknown;
  modifiedMillis?: unknown;
  content?: unknown;
  errorCode?: unknown;
};

export class WorkspaceFileNativeError extends Error {
  constructor(
    readonly code: string,
    readonly fallbackAllowed: boolean,
    readonly pathRejected: boolean,
  ) {
    super(`Native workspace file read failed: ${code}`);
  }
}

function timeoutMs() {
  const configured = Number(process.env.RUDDER_NATIVE_WORKSPACE_FILE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(configured)
    ? Math.max(10, Math.min(DEFAULT_TIMEOUT_MS, Math.floor(configured)))
    : DEFAULT_TIMEOUT_MS;
}

function decodeNativeUtf8(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Buffer.isBuffer(value)) {
    throw new WorkspaceFileNativeError("workspace_file_output_invalid", true, false);
  }
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value)) {
    throw new WorkspaceFileNativeError("workspace_file_invalid_utf8", true, false);
  }
  return decoded;
}

function validPortablePath(value: string) {
  return value.length > 0
    && !value.includes("\\")
    && !value.startsWith("/")
    && !value.includes("\0")
    && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function parseResponse(response: NativeResponse, expectedFilePath: string): NativeWorkspaceFileRead {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new WorkspaceFileNativeError("workspace_file_envelope_mismatch", true, false);
  }
  if (response.ok !== true
    || response.capability !== "workspace.read"
    || response.operation !== "readWorkspaceFile"
    || response.protocolVersion !== PROTOCOL_VERSION
    || response.accepted !== false
    || response.filePath !== expectedFilePath
    || !Number.isSafeInteger(response.byteSize)
    || Number(response.byteSize) < 0
    || !Number.isSafeInteger(response.modifiedMillis)
    || Number(response.modifiedMillis) < 0
    || typeof response.content !== "string") {
    throw new WorkspaceFileNativeError("workspace_file_envelope_mismatch", true, false);
  }
  const byteSize = Number(response.byteSize);
  if (!validPortablePath(expectedFilePath)
    || Buffer.byteLength(expectedFilePath, "utf8") > WORKSPACE_FILE_PATH_MAX_BYTES
    || Buffer.byteLength(response.content, "utf8") !== byteSize
    || byteSize > WORKSPACE_FILE_READ_MAX_BYTES) {
    throw new WorkspaceFileNativeError("workspace_file_response_invalid", true, false);
  }
  return {
    filePath: expectedFilePath,
    byteSize,
    modifiedMillis: Number(response.modifiedMillis),
    content: response.content,
  };
}

function parseFailureCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as NativeResponse;
  if (response.ok !== false
    || response.capability !== "workspace.read"
    || response.protocolVersion !== PROTOCOL_VERSION
    || response.accepted !== false
    || (response.operation !== undefined && response.operation !== "readWorkspaceFile")
    || typeof response.errorCode !== "string"
    || !response.errorCode) {
    return null;
  }
  return response.errorCode;
}

export async function readWorkspaceFileNative(
  rootPath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<NativeWorkspaceFileRead> {
  if (!validPortablePath(filePath) || Buffer.byteLength(filePath, "utf8") > WORKSPACE_FILE_PATH_MAX_BYTES) {
    throw new WorkspaceFileNativeError("workspace_file_path_invalid", false, false);
  }
  const configured = process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH?.trim();
  const binary = configured ? path.resolve(configured) : resolveNativeWorkspaceFilesBinary();
  const command = resolveNativeCommand(binary, [
    "workspace",
    "read",
    path.resolve(rootPath),
    filePath,
    String(WORKSPACE_FILE_READ_MAX_BYTES),
    String(WORKSPACE_FILE_PATH_MAX_BYTES),
  ]);
  let stdout: string;
  let stderr: string;
  try {
    const result = await execFileAsync(command.command, command.args, {
      encoding: "buffer",
      timeout: timeoutMs(),
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      signal,
    });
    stdout = decodeNativeUtf8(result.stdout);
    stderr = decodeNativeUtf8(result.stderr);
  } catch (error) {
    const details = error as { stdout?: unknown; code?: unknown; killed?: unknown; signal?: unknown; name?: unknown };
    const output = details.stdout === undefined ? "" : decodeNativeUtf8(details.stdout);
    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length === 1) {
      try {
        const response = JSON.parse(lines[0]!) as NativeResponse;
        const errorCode = parseFailureCode(response);
        if (errorCode) {
          const pathRejected = REJECTED_PATH_CODES.has(errorCode);
          throw new WorkspaceFileNativeError(errorCode, !pathRejected, pathRejected);
        }
      } catch (parsedError) {
        if (parsedError instanceof WorkspaceFileNativeError) throw parsedError;
      }
    }
    if (details.name === "AbortError") {
      throw new WorkspaceFileNativeError("workspace_file_cancelled", false, false);
    }
    if (details.killed || details.signal === "SIGTERM" || details.code === "ETIMEDOUT") {
      throw new WorkspaceFileNativeError("workspace_file_timeout", true, false);
    }
    throw new WorkspaceFileNativeError("workspace_file_process_failed", true, false);
  }
  if (stderr.trim()) {
    throw new WorkspaceFileNativeError("workspace_file_unexpected_stderr", true, false);
  }
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new WorkspaceFileNativeError("workspace_file_response_line_count", true, false);
  }
  let response: NativeResponse;
  try {
    response = JSON.parse(lines[0]!) as NativeResponse;
  } catch {
    throw new WorkspaceFileNativeError("workspace_file_malformed_json", true, false);
  }
  return parseResponse(response, filePath);
}
