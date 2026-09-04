import type { RudderPluginPackageFileInput } from "@rudderhq/shared";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { unprocessable } from "../errors.js";

// HTTP accepts a 10 MiB compressed ZIP; PLUGIN.IMPORT.001 allows 100 MiB after expansion.
const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_PLUGIN_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATH_CHARS = 1_024;
const MAX_ARCHIVE_RATIO = 100;

function decodeBase64(value: string, label: string): Buffer {
  const compact = value.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw unprocessable(`Invalid base64 content for ${label}`);
  }
  return Buffer.from(compact, "base64");
}

export function unzipPluginPackageNode(content: string, label: string, stripPluginRoot: boolean): RudderPluginPackageFileInput[] {
  const archive = decodeBase64(content, label);
  if (archive.byteLength > MAX_ARCHIVE_BYTES) throw unprocessable("Plugin archive exceeds the 10 MiB transport limit");
  const files: RudderPluginPackageFileInput[] = [];
  let totalBytes = 0;
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    if (failure || file.name.endsWith("/")) return;
    if (Array.from(file.name).length > MAX_PATH_CHARS || /[\u0000-\u001f\u007f-\u009f]/u.test(file.name)) {
      failure = new Error(`Plugin archive path is invalid: ${file.name}`);
      file.terminate();
      return;
    }
    if (files.length >= 500) {
      failure = new Error("Plugin archive exceeds the 500-file V1 limit");
      file.terminate();
      return;
    }
    if (file.originalSize !== undefined && file.originalSize > MAX_FILE_BYTES) {
      failure = new Error(`Plugin archive entry exceeds 2 MiB: ${file.name}`);
      file.terminate();
      return;
    }
    if (file.size && file.originalSize && file.originalSize / file.size > MAX_ARCHIVE_RATIO) {
      failure = new Error(`Plugin archive entry exceeds the ${MAX_ARCHIVE_RATIO}:1 expansion limit: ${file.name}`);
      file.terminate();
      return;
    }
    const chunks: Buffer[] = [];
    let entryBytes = 0;
    file.ondata = (error, data, final) => {
      if (failure) return;
      if (error) {
        failure = error;
        return;
      }
      entryBytes += data.byteLength;
      totalBytes += data.byteLength;
      if (entryBytes > MAX_FILE_BYTES || totalBytes > MAX_PLUGIN_BYTES) {
        failure = new Error(entryBytes > MAX_FILE_BYTES
          ? `Plugin archive entry exceeds 2 MiB: ${file.name}`
          : "Plugin archive exceeds the 100 MiB expansion limit");
        file.terminate();
        return;
      }
      chunks.push(Buffer.from(data));
      if (final) {
        files.push({ path: file.name, content: Buffer.concat(chunks).toString("base64"), encoding: "base64" });
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try {
    unzip.push(archive, true);
  } catch (error) {
    throw unprocessable(`Invalid ZIP Plugin archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  const archiveFailure = failure as Error | null;
  if (archiveFailure) throw unprocessable(archiveFailure.message);
  if (files.length === 0) throw unprocessable("Invalid ZIP Plugin archive: archive contains no files");
  if (totalBytes > archive.byteLength * MAX_ARCHIVE_RATIO) {
    throw unprocessable(`Plugin archive exceeds the ${MAX_ARCHIVE_RATIO}:1 expansion limit`);
  }
  if (!stripPluginRoot || files.some((file) => file.path === ".codex-plugin/plugin.json")) return files;
  const manifests = files.filter((file) => file.path.endsWith("/.codex-plugin/plugin.json"));
  if (manifests.length !== 1) return files;
  const prefix = manifests[0]!.path.slice(0, -".codex-plugin/plugin.json".length);
  if (!files.every((file) => file.path.startsWith(prefix))) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
}
