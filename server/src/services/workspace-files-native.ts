import { resolveNativeCommand } from "@rudderhq/agent-runtime-utils";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROTOCOL_VERSION = 1;
const MAX_ENTRIES = 10_000;
const MAX_PATH_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

const REJECTED_PATH_CODES = new Set([
  "unsafe_workspace_path",
  "workspace_path_escape",
  "workspace_directory_not_found",
  "workspace_not_directory",
  "non_utf8_workspace_path",
  "manifest_entry_limit",
  "manifest_path_limit",
]);

export type NativeWorkspaceDirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

type NativeResponse = {
  ok?: unknown;
  capability?: unknown;
  operation?: unknown;
  protocolVersion?: unknown;
  directoryPath?: unknown;
  entries?: unknown;
  errorCode?: unknown;
};

export class WorkspaceFilesNativeError extends Error {
  constructor(
    readonly code: string,
    readonly fallbackAllowed: boolean,
    readonly pathRejected: boolean,
  ) {
    super(`Native workspace directory listing failed: ${code}`);
  }
}

export function resolveNativeWorkspaceFilesBinary() {
  const configured = process.env.RUDDER_NATIVE_WORKSPACE_FILES_PATH?.trim()
    || process.env.RUDDER_NATIVE_WORKSPACE_MANIFEST_PATH?.trim()
    || process.env.RUDDER_NATIVE_PATH?.trim();
  if (configured) return path.resolve(configured);
  const binaryName = process.platform === "win32" ? "rudder-native.exe" : "rudder-native";
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const target = process.platform === "darwin"
    ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
    : process.platform === "win32"
      ? `${process.arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`
      : `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
  const resourcesPath = process.env.RUDDER_DESKTOP_RESOURCES_PATH?.trim()
    || (typeof (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath === "string"
      ? (process as NodeJS.Process & { resourcesPath: string }).resourcesPath
      : "");
  const candidates = [
    path.resolve(moduleDir, "../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../native", target, binaryName),
    resourcesPath ? path.resolve(resourcesPath, "native", target, binaryName) : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function timeoutMs() {
  const configured = Number(process.env.RUDDER_NATIVE_WORKSPACE_FILES_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(configured)
    ? Math.max(10, Math.min(DEFAULT_TIMEOUT_MS, Math.floor(configured)))
    : DEFAULT_TIMEOUT_MS;
}

function parseEntries(response: NativeResponse, expectedDirectoryPath: string): NativeWorkspaceDirectoryEntry[] {
  if (response.ok !== true
    || response.capability !== "workspace.list"
    || response.operation !== "listWorkspaceDirectory"
    || response.protocolVersion !== PROTOCOL_VERSION
    || response.directoryPath !== expectedDirectoryPath
    || !Array.isArray(response.entries)
    || response.entries.length > MAX_ENTRIES) {
    throw new WorkspaceFilesNativeError("workspace_list_envelope_mismatch", true, false);
  }
  const seen = new Set<string>();
  return response.entries.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WorkspaceFilesNativeError("workspace_list_entry_invalid", true, false);
    }
    const entry = value as Record<string, unknown>;
    const expectedPath = expectedDirectoryPath
      ? `${expectedDirectoryPath}/${String(entry.name ?? "")}`
      : String(entry.name ?? "");
    if (typeof entry.name !== "string" || !entry.name
      || typeof entry.path !== "string" || !entry.path
      || entry.path !== expectedPath
      || typeof entry.isDirectory !== "boolean"
      || entry.name.includes("/") || entry.name.includes("\\")
      || entry.path.includes("\\") || entry.path.startsWith("/")
      || entry.path.split("/").some((segment) => !segment || segment === "." || segment === "..")
      || seen.has(entry.path)) {
      throw new WorkspaceFilesNativeError("workspace_list_entry_invalid", true, false);
    }
    seen.add(entry.path);
    return {
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDirectory,
    };
  });
}

export async function listWorkspaceDirectoryNative(
  rootPath: string,
  directoryPath: string,
  signal?: AbortSignal,
): Promise<NativeWorkspaceDirectoryEntry[]> {
  const command = resolveNativeCommand(resolveNativeWorkspaceFilesBinary(), [
    "workspace",
    "list",
    path.resolve(rootPath),
    directoryPath,
    String(MAX_ENTRIES),
    String(MAX_PATH_BYTES),
  ]);
  let stdout: string;
  let stderr: string;
  try {
    const result = await execFileAsync(command.command, command.args, {
      encoding: "utf8",
      timeout: timeoutMs(),
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      signal,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const details = error as { stdout?: unknown; code?: unknown; killed?: unknown; signal?: unknown; name?: unknown };
    const output = typeof details.stdout === "string" ? details.stdout : "";
    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length === 1) {
      try {
        const response = JSON.parse(lines[0]!) as NativeResponse;
        if (typeof response.errorCode === "string") {
          const pathRejected = REJECTED_PATH_CODES.has(response.errorCode);
          throw new WorkspaceFilesNativeError(response.errorCode, !pathRejected, pathRejected);
        }
      } catch (parsedError) {
        if (parsedError instanceof WorkspaceFilesNativeError) throw parsedError;
      }
    }
    if (details.name === "AbortError") {
      throw new WorkspaceFilesNativeError("workspace_list_cancelled", false, false);
    }
    if (details.killed || details.signal === "SIGTERM" || details.code === "ETIMEDOUT") {
      throw new WorkspaceFilesNativeError("workspace_list_timeout", true, false);
    }
    throw new WorkspaceFilesNativeError("workspace_list_process_failed", true, false);
  }
  if (stderr.trim()) {
    throw new WorkspaceFilesNativeError("workspace_list_unexpected_stderr", true, false);
  }
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new WorkspaceFilesNativeError("workspace_list_response_line_count", true, false);
  }
  let response: NativeResponse;
  try {
    response = JSON.parse(lines[0]!) as NativeResponse;
  } catch {
    throw new WorkspaceFilesNativeError("workspace_list_malformed_json", true, false);
  }
  return parseEntries(response, directoryPath);
}
