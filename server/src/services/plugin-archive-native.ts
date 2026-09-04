import { resolveNativeCommand } from "@rudderhq/agent-runtime-utils";
import type { InspectRudderPluginArchive, RudderPluginPackageFileInput } from "@rudderhq/shared";
import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROTOCOL_VERSION = 1;
// HTTP accepts a 10 MiB compressed ZIP; PLUGIN.IMPORT.001 allows 100 MiB after expansion.
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_PLUGIN_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_EXPANSION_RATIO = 100;
const MAX_OUTPUT_BYTES = 170 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

const INPUT_ERROR_CODES = new Set([
  "plugin_archive_size_limit",
  "plugin_archive_invalid",
  "plugin_archive_path_invalid",
  "plugin_archive_path_unsafe",
  "plugin_archive_file_count_limit",
  "plugin_archive_file_size_limit",
  "plugin_archive_expansion_limit",
  "plugin_archive_total_size_limit",
  "plugin_archive_duplicate_path",
  "plugin_archive_size_mismatch",
  "plugin_archive_read_failed",
  "plugin_archive_empty",
]);

type NativeResponse = {
  ok?: unknown;
  operation?: unknown;
  protocolVersion?: unknown;
  files?: unknown;
  errorCode?: unknown;
};

export class PluginArchiveNativeError extends Error {
  constructor(
    readonly code: string,
    readonly fallbackAllowed: boolean,
    readonly inputRejected: boolean,
  ) {
    super(`Native Plugin archive inspection failed: ${code}`);
  }
}

function decodeBase64(value: string) {
  const compact = value.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new PluginArchiveNativeError("plugin_archive_base64_invalid", false, true);
  }
  return Buffer.from(compact, "base64");
}

export function resolveNativePluginArchiveBinary() {
  const configured = process.env.RUDDER_NATIVE_PLUGIN_ARCHIVE_PATH?.trim()
    || process.env.RUDDER_NATIVE_ARCHIVE_PATH?.trim();
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
  const configured = Number(process.env.RUDDER_NATIVE_PLUGIN_ARCHIVE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(configured) ? Math.max(10, Math.min(DEFAULT_TIMEOUT_MS, Math.floor(configured))) : DEFAULT_TIMEOUT_MS;
}

function parseFiles(response: NativeResponse): RudderPluginPackageFileInput[] {
  if (response.ok !== true
    || response.operation !== "inspectPluginArchive"
    || response.protocolVersion !== PROTOCOL_VERSION
    || !Array.isArray(response.files)) {
    throw new PluginArchiveNativeError("plugin_archive_envelope_mismatch", true, false);
  }
  return response.files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new PluginArchiveNativeError("plugin_archive_file_envelope_invalid", true, false);
    }
    const record = file as Record<string, unknown>;
    if (typeof record.path !== "string" || typeof record.content !== "string" || record.encoding !== "base64") {
      throw new PluginArchiveNativeError("plugin_archive_file_envelope_invalid", true, false);
    }
    return { path: record.path, content: record.content, encoding: "base64" };
  });
}

export async function inspectPluginArchiveNative(
  input: InspectRudderPluginArchive,
  signal?: AbortSignal,
): Promise<RudderPluginPackageFileInput[]> {
  const archive = decodeBase64(input.content);
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new PluginArchiveNativeError("plugin_archive_size_limit", false, true);
  }
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-plugin-archive-"));
  const archivePath = path.join(staging, "input.zip");
  try {
    await fs.writeFile(archivePath, archive);
    const command = resolveNativeCommand(resolveNativePluginArchiveBinary(), [
      "plugin",
      "inspect-archive",
      archivePath,
      String(MAX_ARCHIVE_BYTES),
      String(MAX_FILE_BYTES),
      String(MAX_PLUGIN_BYTES),
      String(MAX_FILES),
      String(MAX_EXPANSION_RATIO),
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
      const details = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown; signal?: unknown; name?: unknown };
      const output = typeof details.stdout === "string" ? details.stdout : "";
      const lines = output.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length === 1) {
        try {
          const parsed = JSON.parse(lines[0]!) as NativeResponse;
          if (typeof parsed.errorCode === "string") {
            const inputRejected = INPUT_ERROR_CODES.has(parsed.errorCode);
            throw new PluginArchiveNativeError(parsed.errorCode, !inputRejected, inputRejected);
          }
        } catch (parsedError) {
          if (parsedError instanceof PluginArchiveNativeError) throw parsedError;
        }
      }
      if (details.name === "AbortError") throw new PluginArchiveNativeError("plugin_archive_cancelled", false, false);
      if (details.killed || details.signal === "SIGTERM" || details.code === "ETIMEDOUT") {
        throw new PluginArchiveNativeError("plugin_archive_timeout", true, false);
      }
      throw new PluginArchiveNativeError("plugin_archive_process_failed", true, false);
    }
    if (stderr.trim()) throw new PluginArchiveNativeError("plugin_archive_unexpected_stderr", true, false);
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1) throw new PluginArchiveNativeError("plugin_archive_response_line_count", true, false);
    let response: NativeResponse;
    try {
      response = JSON.parse(lines[0]!) as NativeResponse;
    } catch {
      throw new PluginArchiveNativeError("plugin_archive_malformed_json", true, false);
    }
    return parseFiles(response);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
