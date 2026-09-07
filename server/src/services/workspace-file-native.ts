import { resolveNativeCommand } from "@rudderhq/agent-runtime-utils";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
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

const REJECTED_CONTENT_CODES = new Set(["non_utf8_workspace_file"]);

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
    readonly limitExceeded = code === "workspace_file_size_limit",
    readonly contentRejected = code === "non_utf8_workspace_file",
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

type WorkspaceFileStat = Awaited<ReturnType<typeof fs.stat>>;

function sameFileIdentity(left: WorkspaceFileStat, right: WorkspaceFileStat) {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function isWithinRoot(rootPath: string, targetPath: string) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function cancelledError() {
  return new WorkspaceFileNativeError("workspace_file_cancelled", false, false);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
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
          const limitExceeded = errorCode === "workspace_file_size_limit";
          const contentRejected = REJECTED_CONTENT_CODES.has(errorCode);
          throw new WorkspaceFileNativeError(
            errorCode,
            !pathRejected && !limitExceeded && !contentRejected,
            pathRejected,
            limitExceeded,
            contentRejected,
          );
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

export async function readWorkspaceFileNode(
  rootPath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<NativeWorkspaceFileRead> {
  if (!validPortablePath(filePath) || Buffer.byteLength(filePath, "utf8") > WORKSPACE_FILE_PATH_MAX_BYTES) {
    throw new WorkspaceFileNativeError("workspace_file_path_invalid", false, false);
  }
  throwIfCancelled(signal);

  const resolvedRoot = path.resolve(rootPath);
  let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootStat = await fs.lstat(resolvedRoot);
  } catch {
    throw new WorkspaceFileNativeError("workspace_root_unavailable", false, true);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new WorkspaceFileNativeError("workspace_not_directory", false, true);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(resolvedRoot);
  } catch {
    throw new WorkspaceFileNativeError("workspace_root_unavailable", false, true);
  }
  const canonicalTarget = path.resolve(canonicalRoot, filePath);
  if (!isWithinRoot(canonicalRoot, canonicalTarget) || canonicalTarget === canonicalRoot) {
    throw new WorkspaceFileNativeError("workspace_path_escape", false, true);
  }

  let expectedStat: WorkspaceFileStat;
  try {
    expectedStat = await fs.stat(canonicalTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkspaceFileNativeError("workspace_file_not_found", false, true);
    }
    throw new WorkspaceFileNativeError("workspace_file_read_failed", false, false);
  }
  throwIfCancelled(signal);
  if (!expectedStat.isFile()) {
    throw new WorkspaceFileNativeError("workspace_not_file", false, true);
  }
  if (expectedStat.size > WORKSPACE_FILE_READ_MAX_BYTES) {
    throw new WorkspaceFileNativeError("workspace_file_size_limit", false, false, true);
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(
      canonicalTarget,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    throw new WorkspaceFileNativeError("workspace_file_read_failed", false, false);
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close().catch(() => undefined);
  };
  const abort = () => {
    void close();
  };

  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameFileIdentity(expectedStat, openedStat)) {
      throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
    }
    if (openedStat.size > WORKSPACE_FILE_READ_MAX_BYTES) {
      throw new WorkspaceFileNativeError("workspace_file_size_limit", false, false, true);
    }

    const stableTarget = await fs.realpath(canonicalTarget);
    if (!isWithinRoot(canonicalRoot, stableTarget)) {
      throw new WorkspaceFileNativeError("workspace_path_escape", false, true);
    }
    const stablePathStat = await fs.stat(canonicalTarget);
    if (!sameFileIdentity(stablePathStat, openedStat)) {
      throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
    }

    const bytes = Buffer.alloc(WORKSPACE_FILE_READ_MAX_BYTES + 1);
    let offset = 0;
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (offset < bytes.length) {
        throwIfCancelled(signal);
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      throwIfCancelled(signal);
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      if (error instanceof WorkspaceFileNativeError) throw error;
      throw new WorkspaceFileNativeError("workspace_file_read_failed", false, false);
    } finally {
      signal?.removeEventListener("abort", abort);
    }

    if (offset > WORKSPACE_FILE_READ_MAX_BYTES) {
      throw new WorkspaceFileNativeError("workspace_file_size_limit", false, false, true);
    }
    const stableMetadata = await handle.stat();
    if (!stableMetadata.isFile()
      || !sameFileIdentity(stableMetadata, openedStat)
      || stableMetadata.size !== openedStat.size) {
      throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
    }
    const content = bytes.subarray(0, offset);
    const decoded = content.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(content)) {
      throw new WorkspaceFileNativeError("non_utf8_workspace_file", false, false, false, true);
    }
    return {
      filePath,
      byteSize: openedStat.size,
      modifiedMillis: Math.max(0, Math.floor(openedStat.mtimeMs)),
      content: decoded,
    };
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    if (error instanceof WorkspaceFileNativeError) throw error;
    throw new WorkspaceFileNativeError("workspace_file_read_failed", false, false);
  } finally {
    await close();
  }
}
