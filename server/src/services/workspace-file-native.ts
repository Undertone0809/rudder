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
  "workspace_file_path_invalid",
  "workspace_file_not_found",
  "workspace_not_directory",
  "workspace_not_file",
  "non_utf8_workspace_path",
  "manifest_path_limit",
]);

const REJECTED_CONTENT_CODES = new Set(["non_utf8_workspace_file"]);
const NATIVE_FALLBACK_ERROR_CODES = new Set([
  "workspace_root_unavailable",
  "workspace_file_read_failed",
  "workspace_metadata_failed",
]);
const NATIVE_FAIL_CLOSED_ERROR_CODES = new Set([
  "workspace_file_containment_unproven",
  "workspace_file_identity_unavailable",
]);

function nativeFailureAllowsFallback(errorCode: string) {
  if (NATIVE_FAIL_CLOSED_ERROR_CODES.has(errorCode)) return false;
  return NATIVE_FALLBACK_ERROR_CODES.has(errorCode);
}

export type NativeWorkspaceFileRead = {
  filePath: string;
  byteSize: number;
  modifiedMillis: number;
  content: string;
};

export type NativeWorkspaceFileReadBytes = Omit<NativeWorkspaceFileRead, "content"> & {
  bytes: Buffer;
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
    this.name = "WorkspaceFileNativeError";
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
    throw new WorkspaceFileNativeError("workspace_file_output_invalid", false, false);
  }
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value)) {
    throw new WorkspaceFileNativeError("workspace_file_invalid_utf8", false, false);
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

function sameFileSnapshot(left: WorkspaceFileStat, right: WorkspaceFileStat) {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev
      && left.ino === right.ino
      && left.size === right.size
      && left.mtimeMs === right.mtimeMs
      && left.ctimeMs === right.ctimeMs;
  }
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameRootIdentity(left: WorkspaceFileStat, right: WorkspaceFileStat) {
  return left.isDirectory()
    && right.isDirectory()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && left.dev !== 0
    && left.ino !== 0
    && right.dev !== 0
    && right.ino !== 0
    && left.dev === right.dev
    && left.ino === right.ino
    && left.ctimeMs === right.ctimeMs;
}

async function ensureRootIdentity(rootPath: string, expected: WorkspaceFileStat) {
  let actual: WorkspaceFileStat;
  try {
    actual = await fs.lstat(rootPath);
  } catch {
    throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
  }
  if (!sameRootIdentity(expected, actual)) {
    throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
  }
}

async function ensureRootHandleIdentity(rootHandle: FileHandle, expected: WorkspaceFileStat) {
  let actual: WorkspaceFileStat;
  try {
    actual = await rootHandle.stat();
  } catch {
    throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
  }
  if (!sameRootIdentity(expected, actual)) {
    throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
  }
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
    throw new WorkspaceFileNativeError("workspace_file_envelope_mismatch", false, false);
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
    throw new WorkspaceFileNativeError("workspace_file_envelope_mismatch", false, false);
  }
  const contentBytes = Buffer.from(response.content, "utf8");
  if (contentBytes.toString("utf8") !== response.content) {
    throw new WorkspaceFileNativeError("workspace_file_response_invalid", false, false);
  }
  const byteSize = Number(response.byteSize);
  if (!validPortablePath(expectedFilePath)
    || Buffer.byteLength(expectedFilePath, "utf8") > WORKSPACE_FILE_PATH_MAX_BYTES
    || contentBytes.length !== byteSize
    || byteSize > WORKSPACE_FILE_READ_MAX_BYTES) {
    throw new WorkspaceFileNativeError("workspace_file_response_invalid", false, false);
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
  throwIfCancelled(signal);

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
    throwIfCancelled(signal);
    stdout = decodeNativeUtf8(result.stdout);
    stderr = decodeNativeUtf8(result.stderr);
  } catch (error) {
    if (error instanceof WorkspaceFileNativeError) throw error;
    const details = error as { stdout?: unknown; code?: unknown; killed?: unknown; signal?: unknown; name?: unknown };
    if (signal?.aborted || details.name === "AbortError") {
      throw cancelledError();
    }
    const output = details.stdout === undefined ? "" : decodeNativeUtf8(details.stdout);
    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length === 1) {
      let response: NativeResponse;
      try {
        response = JSON.parse(lines[0]!) as NativeResponse;
      } catch {
        throw new WorkspaceFileNativeError("workspace_file_protocol_invalid", false, false);
      }
      const errorCode = parseFailureCode(response);
      if (errorCode) {
        const pathRejected = REJECTED_PATH_CODES.has(errorCode);
        const limitExceeded = errorCode === "workspace_file_size_limit";
        const contentRejected = REJECTED_CONTENT_CODES.has(errorCode);
        throw new WorkspaceFileNativeError(
          errorCode,
          nativeFailureAllowsFallback(errorCode),
          pathRejected,
          limitExceeded,
          contentRejected,
        );
      }
      throw new WorkspaceFileNativeError("workspace_file_protocol_invalid", false, false);
    }
    if (output.trim()) {
      throw new WorkspaceFileNativeError("workspace_file_protocol_invalid", false, false);
    }
    if (details.killed || details.signal === "SIGTERM" || details.code === "ETIMEDOUT") {
      throw new WorkspaceFileNativeError("workspace_file_timeout", true, false);
    }
    throw new WorkspaceFileNativeError("workspace_file_process_failed", true, false);
  }
  if (stderr.trim()) {
    throw new WorkspaceFileNativeError("workspace_file_unexpected_stderr", false, false);
  }
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new WorkspaceFileNativeError("workspace_file_response_line_count", false, false);
  }
  let response: NativeResponse;
  try {
    response = JSON.parse(lines[0]!) as NativeResponse;
  } catch {
    throw new WorkspaceFileNativeError("workspace_file_malformed_json", false, false);
  }
  return parseResponse(response, filePath);
}

export async function readWorkspaceFileNodeBytes(
  rootPath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<NativeWorkspaceFileReadBytes> {
  if (!validPortablePath(filePath) || Buffer.byteLength(filePath, "utf8") > WORKSPACE_FILE_PATH_MAX_BYTES) {
    throw new WorkspaceFileNativeError("workspace_file_path_invalid", false, false);
  }
  throwIfCancelled(signal);
  if (process.platform === "win32") {
    throw new WorkspaceFileNativeError("workspace_file_node_fallback_unsupported", false, false);
  }

  const resolvedRoot = path.resolve(rootPath);
  let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootStat = await fs.lstat(resolvedRoot);
  } catch {
    throw new WorkspaceFileNativeError("workspace_root_unavailable", false, false);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new WorkspaceFileNativeError("workspace_not_directory", false, true);
  }
  await ensureRootIdentity(resolvedRoot, rootStat);

  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(resolvedRoot);
  } catch {
    throw new WorkspaceFileNativeError("workspace_root_unavailable", false, false);
  }
  let expectedRootStat: WorkspaceFileStat;
  try {
    expectedRootStat = await fs.stat(canonicalRoot);
  } catch {
    throw new WorkspaceFileNativeError("workspace_root_unavailable", false, false);
  }
  const requestedTarget = path.resolve(canonicalRoot, filePath);
  if (!isWithinRoot(canonicalRoot, requestedTarget) || requestedTarget === canonicalRoot) {
    throw new WorkspaceFileNativeError("workspace_path_escape", false, true);
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = await fs.realpath(requestedTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkspaceFileNativeError("workspace_file_not_found", false, true);
    }
    throw new WorkspaceFileNativeError("workspace_file_read_failed", false, false);
  }
  if (!isWithinRoot(canonicalRoot, canonicalTarget)) {
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

  let rootHandle: FileHandle;
  try {
    rootHandle = await fs.open(
      resolvedRoot,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
    }
    throw new WorkspaceFileNativeError("workspace_root_unavailable", false, false);
  }
  let rootClosed = false;
  const closeRoot = async () => {
    if (rootClosed) return;
    rootClosed = true;
    await rootHandle.close().catch(() => undefined);
  };

  let handle: FileHandle;
  try {
    await ensureRootHandleIdentity(rootHandle, expectedRootStat);
    await ensureRootIdentity(resolvedRoot, rootStat);
    handle = await fs.open(
      canonicalTarget,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    await closeRoot();
    if (signal?.aborted) throw cancelledError();
    if (error instanceof WorkspaceFileNativeError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new WorkspaceFileNativeError("workspace_path_escape", false, true);
    }
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
    await ensureRootHandleIdentity(rootHandle, expectedRootStat);
    await ensureRootIdentity(resolvedRoot, rootStat);
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameFileSnapshot(expectedStat, openedStat)) {
      throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
    }
    if (openedStat.size > WORKSPACE_FILE_READ_MAX_BYTES) {
      throw new WorkspaceFileNativeError("workspace_file_size_limit", false, false, true);
    }

    const stableTarget = await fs.realpath(requestedTarget);
    if (!isWithinRoot(canonicalRoot, stableTarget)) {
      throw new WorkspaceFileNativeError("workspace_path_escape", false, true);
    }
    const stablePathStat = await fs.stat(stableTarget);
    if (!sameFileSnapshot(stablePathStat, openedStat)) {
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
    await ensureRootHandleIdentity(rootHandle, expectedRootStat);
    await ensureRootIdentity(resolvedRoot, rootStat);
    const stableMetadata = await handle.stat();
    const stableRootStat = await fs.stat(canonicalRoot).catch(() => null);
    if (!stableMetadata.isFile()
      || !sameFileSnapshot(stableMetadata, openedStat)
      || !stableRootStat
      || !sameFileSnapshot(stableRootStat, expectedRootStat)) {
      throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
    }
    let finalTarget: string;
    try {
      finalTarget = await fs.realpath(requestedTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
      }
      throw new WorkspaceFileNativeError("workspace_file_read_failed", false, false);
    }
    if (!isWithinRoot(canonicalRoot, finalTarget)) {
      throw new WorkspaceFileNativeError("workspace_path_escape", false, true);
    }
    let finalPathStat: WorkspaceFileStat;
    try {
      finalPathStat = await fs.stat(finalTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
      }
      throw new WorkspaceFileNativeError("workspace_file_read_failed", false, false);
    }
    if (!sameFileSnapshot(finalPathStat, openedStat)) {
      throw new WorkspaceFileNativeError("workspace_file_changed", false, false);
    }
    await ensureRootHandleIdentity(rootHandle, expectedRootStat);
    await ensureRootIdentity(resolvedRoot, rootStat);
    throwIfCancelled(signal);
    const content = bytes.subarray(0, offset);
    return {
      filePath,
      byteSize: openedStat.size,
      modifiedMillis: Math.max(0, Math.floor(openedStat.mtimeMs)),
      bytes: content,
    };
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    if (error instanceof WorkspaceFileNativeError) throw error;
    throw new WorkspaceFileNativeError("workspace_file_read_failed", false, false);
  } finally {
    await close();
    await closeRoot();
  }
}

export async function readWorkspaceFileNode(
  rootPath: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<NativeWorkspaceFileRead> {
  const result = await readWorkspaceFileNodeBytes(rootPath, filePath, signal);
  const decoded = result.bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(result.bytes)) {
    throw new WorkspaceFileNativeError("non_utf8_workspace_file", false, false, false, true);
  }
  return {
    filePath: result.filePath,
    byteSize: result.byteSize,
    modifiedMillis: result.modifiedMillis,
    content: decoded,
  };
}
