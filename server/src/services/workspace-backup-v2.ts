import { resolveNativeCommand } from "@rudderhq/agent-runtime-utils";
import { createRudderNativeDiagnostic, resolveRudderNativeCapability, resolveRudderNativeTarget, type RudderNativeDiagnostic } from "@rudderhq/shared";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Node comparator for the v2 backup contract. The archive reader deliberately
 * supports only the uncompressed ZIP dialect emitted by this module. That
 * keeps the reader bounded and makes unsupported compression fail closed rather
 * than silently allowing an unbounded inflate path.
 */
export const WORKSPACE_BACKUP_V2_VERSION = 2 as const;
export const WORKSPACE_BACKUP_V2_POLICY_VERSION = "workspace-backup-v2-policy-1" as const;
export const WORKSPACE_BACKUP_V2_MANIFEST_PATH = ".rudder-backup/manifest-v2.json" as const;
export const WORKSPACE_BACKUP_V2_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const WORKSPACE_BACKUP_V2_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const WORKSPACE_BACKUP_V2_MAX_ARCHIVE_BYTES = WORKSPACE_BACKUP_V2_MAX_TOTAL_BYTES + 16 * 1024 * 1024;
const WORKSPACE_BACKUP_V2_MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_WARNING_COUNT = 200;
const EOCD_MIN_BYTES = 22;
const EOCD_MAX_SCAN_BYTES = 65_557;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const NATIVE_PROTOCOL_VERSION = 1;
const NATIVE_OUTPUT_LIMIT_BYTES = 256 * 1024;
const NATIVE_DIAGNOSTIC_DETAIL_BYTES = 180;

const SKIPPED_ENTRY_NAMES = new Set([
  ".DS_Store", ".cache", ".codex", ".config", ".git", ".gstack", ".local",
  ".mintlify", ".npm", ".nvm", ".pnpm-store", ".rudder", ".tmp", ".turbo",
  ".rudder-workspace-migrations.json", ".rudder-workspace.json",
  ".vite", "Library", "node_modules",
]);

export type WorkspaceBackupV2Entry = {
  path: string;
  kind: "directory" | "file";
  byteSize: number;
  mtimeMs: number | null;
  mode: number | null;
  sha256: string | null;
};

export type WorkspaceBackupV2Manifest = {
  version: typeof WORKSPACE_BACKUP_V2_VERSION;
  policyVersion: typeof WORKSPACE_BACKUP_V2_POLICY_VERSION;
  identity: { orgId: string; instanceId: string; rootPath: string };
  createdAt: string;
  entries: WorkspaceBackupV2Entry[];
  treeSha256: string;
  warnings: string[];
};

export type WorkspaceBackupV2Walk = {
  entries: WorkspaceBackupV2Entry[];
  warnings: string[];
  fileCount: number;
  byteSize: number;
  treeSha256: string;
};

export type WorkspaceBackupV2Artifact = WorkspaceBackupV2Walk & {
  archive: Buffer;
  manifest: WorkspaceBackupV2Manifest;
};

export type WorkspaceBackupV2NativeArtifact = WorkspaceBackupV2Walk & {
  artifactPath: string;
  archiveSha256: string;
  manifest: WorkspaceBackupV2Manifest;
};

export type WorkspaceBackupV2NativeDiagnosticCategory =
  | "capability"
  | "protocol"
  | "timeout"
  | "process"
  | "integrity"
  | "publication";

export type WorkspaceBackupV2NativeDiagnostic = {
  category: WorkspaceBackupV2NativeDiagnosticCategory;
  code: string;
  detail: string;
  fallbackAllowed: boolean;
  native: RudderNativeDiagnostic;
};

type PublicationOps = {
  link(source: string, destination: string): Promise<void>;
  rm(filePath: string): Promise<void>;
  syncParent(filePath: string): Promise<void>;
};

export class WorkspaceBackupV2NativeError extends Error {
  readonly diagnostic: WorkspaceBackupV2NativeDiagnostic;

  constructor(diagnostic: WorkspaceBackupV2NativeDiagnostic) {
    super(`Native archive ${diagnostic.category}/${diagnostic.code}: ${diagnostic.detail}`);
    this.name = "WorkspaceBackupV2NativeError";
    this.diagnostic = diagnostic;
  }
}

export function workspaceBackupV2NativeDiagnostic(error: unknown): WorkspaceBackupV2NativeDiagnostic {
  if (error instanceof WorkspaceBackupV2NativeError) return error.diagnostic;
  return nativeDiagnostic("process", "unexpected_error", error instanceof Error ? error.message : String(error)).diagnostic;
}

export function formatWorkspaceBackupV2NativeFallback(error: unknown) {
  const diagnostic = workspaceBackupV2NativeDiagnostic(error);
  return `Native archive fallback [${diagnostic.category}/${diagnostic.code}]: ${diagnostic.detail}`;
}

export type WorkspaceBackupV2FileArtifact = WorkspaceBackupV2Walk & {
  artifactPath: string;
  archiveSha256: string;
  compressedSize: number;
  manifest: WorkspaceBackupV2Manifest;
};

export type WorkspaceBackupV2ArchiveEntry = {
  archivePath: string;
  kind: "directory" | "file";
  compressedSize: number;
  byteSize: number;
  crc32: number;
  dataOffset: number;
};

export type WorkspaceBackupV2ArchiveIndex = {
  archiveSize: number;
  manifest: WorkspaceBackupV2Manifest;
  manifestEntry: WorkspaceBackupV2ArchiveEntry;
  entries: Map<string, WorkspaceBackupV2ArchiveEntry>;
};

export type WorkspaceBackupV2ReadPayload = {
  manifest: WorkspaceBackupV2Manifest;
  native: boolean;
  archiveSize: number;
  index?: WorkspaceBackupV2ArchiveIndex;
  rootPath: string;
  fallbackWarning?: string;
};

function sha256(value: Uint8Array | string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function crc32(buffer: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    let current = (value ^ byte) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    value = (value >>> 8) ^ current;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function u16(value: number) {
  const result = Buffer.allocUnsafe(2);
  result.writeUInt16LE(value & 0xffff, 0);
  return result;
}

function u32(value: number) {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32LE(value >>> 0, 0);
  return result;
}

function dosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function compareEntries(left: WorkspaceBackupV2Entry, right: WorkspaceBackupV2Entry) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

// Cross-runtime backup browsing uses Unicode scalar order. Unlike localeCompare,
// this is stable across Node ICU versions and reproducible by native clients.
export function compareWorkspaceBackupFilenames(left: string, right: string) {
  let leftOffset = 0;
  let rightOffset = 0;
  while (leftOffset < left.length && rightOffset < right.length) {
    const leftCodePoint = left.codePointAt(leftOffset)!;
    const rightCodePoint = right.codePointAt(rightOffset)!;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint < rightCodePoint ? -1 : 1;
    leftOffset += leftCodePoint > 0xffff ? 2 : 1;
    rightOffset += rightCodePoint > 0xffff ? 2 : 1;
  }
  return leftOffset < left.length ? 1 : rightOffset < right.length ? -1 : 0;
}

function addWarning(warnings: string[], value: string) {
  if (warnings.length < MAX_WARNING_COUNT) warnings.push(value);
  else if (warnings.length === MAX_WARNING_COUNT) warnings.push("Additional backup warnings omitted.");
}

function isSkippedEntryName(name: string) {
  return SKIPPED_ENTRY_NAMES.has(name)
    || name.endsWith("~") || name.endsWith(".swp") || name.endsWith(".swo")
    || name.endsWith(".partial") || name.endsWith(".crdownload") || /\.tmp(?:[-.]|$)/.test(name);
}

function portableRelativePath(value: string) {
  return value.split(path.sep).join("/");
}

export function assertSafeWorkspaceBackupV2Path(value: string) {
  if (!value || value.includes("\0")) throw new Error("Backup path must be non-empty and NUL-free");
  const normalized = portableRelativePath(value);
  if (normalized.includes("\\") || normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
    throw new Error("Backup path must be relative and stay inside the workspace");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === ".")) throw new Error("Backup path must be canonical");
  return parts.join("/");
}

function treeHash(entries: WorkspaceBackupV2Entry[]) {
  const hash = crypto.createHash("sha256");
  for (const entry of [...entries].sort(compareEntries)) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.kind);
    hash.update("\0");
    hash.update(String(entry.byteSize));
    hash.update("\0");
    hash.update(entry.sha256 ?? "");
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function readBoundedFile(filePath: string, expectedSize: number) {
  const handle = await fs.open(filePath, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  const chunk = Buffer.allocUnsafe(256 * 1024);
  try {
    while (true) {
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (!result.bytesRead) break;
      total += result.bytesRead;
      if (total > WORKSPACE_BACKUP_V2_MAX_FILE_BYTES) throw new Error("file exceeds v2 backup limit");
      chunks.push(Buffer.from(chunk.subarray(0, result.bytesRead)));
    }
  } finally {
    await handle.close();
  }
  if (total !== expectedSize) throw new Error("file changed while creating v2 backup");
  return Buffer.concat(chunks, total);
}

export async function walkWorkspaceBackupV2(rootPath: string): Promise<WorkspaceBackupV2Walk> {
  const root = path.resolve(rootPath);
  const entries: WorkspaceBackupV2Entry[] = [];
  const warnings: string[] = [];
  let byteSize = 0;
  const queue = [root];
  while (queue.length) {
    const currentPath = queue.shift()!;
    const dirents = await fs.readdir(currentPath, { withFileTypes: true });
    dirents.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const dirent of dirents) {
      const absolutePath = path.join(currentPath, dirent.name);
      const relativePath = assertSafeWorkspaceBackupV2Path(portableRelativePath(path.relative(root, absolutePath)));
      if (isSkippedEntryName(dirent.name)) {
        addWarning(warnings, `Skipped ${relativePath}`);
        continue;
      }
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        addWarning(warnings, `Skipped symlink ${relativePath}`);
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory", byteSize: 0, mtimeMs: stat.mtimeMs, mode: stat.mode, sha256: null });
        queue.push(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        addWarning(warnings, `Skipped unsupported file ${relativePath}`);
        continue;
      }
      if (stat.size > WORKSPACE_BACKUP_V2_MAX_FILE_BYTES) {
        addWarning(warnings, `Skipped oversized file ${relativePath}`);
        continue;
      }
      if (byteSize + stat.size > WORKSPACE_BACKUP_V2_MAX_TOTAL_BYTES) {
        addWarning(warnings, `Skipped ${relativePath} because the backup size limit was reached`);
        continue;
      }
      const data = await readBoundedFile(absolutePath, stat.size);
      byteSize += data.byteLength;
      entries.push({ path: relativePath, kind: "file", byteSize: data.byteLength, mtimeMs: stat.mtimeMs, mode: stat.mode, sha256: sha256(data) });
    }
  }
  const sorted = entries.sort(compareEntries);
  return { entries: sorted, warnings, fileCount: sorted.filter((entry) => entry.kind === "file").length, byteSize, treeSha256: treeHash(sorted) };
}

function zipEntry(pathName: string, data: Buffer, mtimeMs: number | null, directory: boolean, offset: number) {
  const name = Buffer.from(pathName, "utf8");
  const { time, date } = dosDateTime(new Date(mtimeMs ?? 0));
  const checksum = crc32(data);
  const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(date), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
  const central = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(date), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(directory ? 0x10 : 0), u32(offset), name]);
  return { local, central };
}

function rootSegment(rootPath: string) {
  return path.basename(rootPath).replaceAll("\\", "/").split("/").filter(Boolean).join("-") || "workspace";
}

export async function createWorkspaceBackupV2(input: {
  rootPath: string;
  orgId: string;
  instanceId: string;
  createdAt?: Date;
}): Promise<WorkspaceBackupV2Artifact> {
  const walked = await walkWorkspaceBackupV2(input.rootPath);
  const manifest: WorkspaceBackupV2Manifest = {
    version: WORKSPACE_BACKUP_V2_VERSION,
    policyVersion: WORKSPACE_BACKUP_V2_POLICY_VERSION,
    identity: { orgId: input.orgId, instanceId: input.instanceId, rootPath: path.resolve(input.rootPath) },
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    entries: walked.entries,
    treeSha256: walked.treeSha256,
    warnings: walked.warnings,
  };
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const add = (name: string, data: Buffer, mtimeMs: number | null, directory = false) => {
    const parts = zipEntry(name, data, mtimeMs, directory, offset);
    local.push(parts.local);
    central.push(parts.central);
    offset += parts.local.length;
  };
  const root = rootSegment(input.rootPath);
  add(`${WORKSPACE_BACKUP_V2_MANIFEST_PATH}`, Buffer.from(JSON.stringify(manifest)), new Date(manifest.createdAt).getTime());
  add(`${root}/`, Buffer.alloc(0), new Date(manifest.createdAt).getTime(), true);
  for (const entry of walked.entries) {
    const name = `${root}/${entry.path}${entry.kind === "directory" ? "/" : ""}`;
    const data = entry.kind === "file" ? await readBoundedFile(path.join(input.rootPath, entry.path), entry.byteSize) : Buffer.alloc(0);
    add(name, data, entry.mtimeMs, entry.kind === "directory");
  }
  const directory = Buffer.concat(central);
  const entryCount = 2 + walked.entries.length;
  if (entryCount > 0xffff || directory.length > 0xffffffff || offset > 0xffffffff) throw new Error("v2 backup exceeds classic ZIP limits");
  const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entryCount), u16(entryCount), u32(directory.length), u32(offset), u16(0)]);
  return { ...walked, manifest, archive: Buffer.concat([...local, directory, end]) };
}

/**
 * Contract-equivalent Node comparator for the native writer. It keeps only a
 * bounded per-file Buffer and writes local records sequentially, so the full
 * archive is never materialized in the JS heap.
 */
export async function createWorkspaceBackupV2File(input: {
  rootPath: string;
  orgId: string;
  instanceId: string;
  artifactPath: string;
  createdAt?: Date;
  additionalWarnings?: string[];
  beforePublish?: () => Promise<void>;
  publicationOps?: PublicationOps;
}): Promise<WorkspaceBackupV2FileArtifact> {
  const walked = await walkWorkspaceBackupV2(input.rootPath);
  if (input.additionalWarnings?.length) walked.warnings.unshift(...input.additionalWarnings);
  const manifest: WorkspaceBackupV2Manifest = {
    version: WORKSPACE_BACKUP_V2_VERSION,
    policyVersion: WORKSPACE_BACKUP_V2_POLICY_VERSION,
    identity: { orgId: input.orgId, instanceId: input.instanceId, rootPath: path.resolve(input.rootPath) },
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    entries: walked.entries,
    treeSha256: walked.treeSha256,
    warnings: walked.warnings,
  };
  const tempPath = `${input.artifactPath}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(input.artifactPath), { recursive: true });
  if (await fs.stat(input.artifactPath).then(() => true).catch(() => false)) throw new Error("v2 backup output already exists");
  const handle = await fs.open(tempPath, "wx", 0o600);
  const archiveHash = crypto.createHash("sha256");
  const central: Buffer[] = [];
  let offset = 0;
  const write = async (chunk: Buffer) => {
    let written = 0;
    while (written < chunk.length) {
      const result = await handle.write(chunk, written, chunk.length - written);
      if (!result.bytesWritten) throw new Error("Node v2 archive writer made no progress");
      written += result.bytesWritten;
      archiveHash.update(chunk.subarray(written - result.bytesWritten, written));
    }
  };
  try {
    const root = rootSegment(input.rootPath);
    const manifestData = Buffer.from(JSON.stringify(manifest));
    const records: Array<{ name: string; data: Buffer; mtimeMs: number | null; directory: boolean }> = [];
    const writeRecord = async (record: { name: string; data: Buffer; mtimeMs: number | null; directory: boolean }) => {
      const parts = zipEntry(record.name, record.data, record.mtimeMs, record.directory, offset);
      const localHeaderSize = parts.local.length - record.data.length;
      await write(parts.local.subarray(0, localHeaderSize));
      if (record.data.length) await write(record.data);
      central.push(parts.central);
      offset += parts.local.length;
      records.push({ ...record, data: Buffer.alloc(0) });
    };
    await writeRecord({ name: WORKSPACE_BACKUP_V2_MANIFEST_PATH, data: manifestData, mtimeMs: new Date(manifest.createdAt).getTime(), directory: false });
    await writeRecord({ name: `${root}/`, data: Buffer.alloc(0), mtimeMs: new Date(manifest.createdAt).getTime(), directory: true });
    for (const entry of walked.entries) {
      const data = entry.kind === "file" ? await readBoundedFile(path.join(input.rootPath, entry.path), entry.byteSize) : Buffer.alloc(0);
      await writeRecord({
        name: `${root}/${entry.path}${entry.kind === "directory" ? "/" : ""}`,
        data,
        mtimeMs: entry.mtimeMs,
        directory: entry.kind === "directory",
      });
    }
    const directory = Buffer.concat(central);
    const entryCount = records.length;
    if (entryCount > 0xffff || directory.length > 0xffffffff || offset > 0xffffffff) throw new Error("v2 backup exceeds classic ZIP limits");
    await write(directory);
    const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entryCount), u16(entryCount), u32(directory.length), u32(offset), u16(0)]);
    await write(end);
    if (offset + directory.length + end.length > WORKSPACE_BACKUP_V2_MAX_ARCHIVE_BYTES) throw new Error("v2 backup archive exceeds the bounded archive limit");
    if (process.platform !== "win32") await handle.sync();
    const archiveSha256 = archiveHash.digest("hex");
    await handle.close();
    await input.beforePublish?.();
    await publishNoReplace(tempPath, input.artifactPath, input.publicationOps);
    const stat = await fs.stat(input.artifactPath);
    return { ...walked, artifactPath: input.artifactPath, archiveSha256, compressedSize: stat.size, manifest };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function syncParent(filePath: string) {
  const parent = await fs.open(path.dirname(filePath), "r");
  try { if (process.platform !== "win32") await parent.sync(); } finally { await parent.close(); }
}

const defaultPublicationOps: PublicationOps = {
  link: async (source, destination) => { await fs.link(source, destination); },
  rm: async (filePath) => { await fs.rm(filePath); },
  syncParent,
};

async function publishNoReplace(tempPath: string, finalPath: string, overrides?: PublicationOps) {
  const ops = overrides ?? defaultPublicationOps;
  try {
    await ops.link(tempPath, finalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw nativeDiagnostic("publication", "final_exists", "destination already exists", false);
    throw error;
  }
  try {
    await ops.syncParent(finalPath);
  } catch (error) {
    try {
      await ops.rm(finalPath);
      await ops.syncParent(finalPath);
    } catch (rollbackError) {
      throw nativeDiagnostic("publication", "publication_recovery_required", rollbackError, false);
    }
    throw nativeDiagnostic("publication", "output_publish_failed", error, false);
  }
  try {
    await ops.rm(tempPath);
    await ops.syncParent(finalPath);
  } catch (error) {
    throw nativeDiagnostic("publication", "published_output_cleanup_failed", error, false);
  }
}

async function removePublishedForFallback(finalPath: string, overrides?: PublicationOps) {
  const ops = overrides ?? defaultPublicationOps;
  try {
    await ops.rm(finalPath);
    await ops.syncParent(finalPath);
  } catch (error) {
    throw nativeDiagnostic("publication", "publication_recovery_required", error, false);
  }
}

type NativeArchiveJson = {
  ok?: unknown;
  accepted?: unknown;
  operation?: unknown;
  protocolVersion?: unknown;
  capability?: unknown;
  target?: unknown;
  binaryVersion?: unknown;
  capabilities?: unknown;
  errorCode?: unknown;
  byteSize?: unknown;
  sha256?: unknown;
  manifestSha256?: unknown;
  treeSha256?: unknown;
  manifestBase64?: unknown;
  entryCount?: unknown;
};

function boundedDiagnosticDetail(value: unknown) {
  const text = String(value ?? "unknown").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, NATIVE_DIAGNOSTIC_DETAIL_BYTES) || "unknown";
}

function nativeDiagnostic(
  category: WorkspaceBackupV2NativeDiagnosticCategory,
  code: string,
  detail: unknown,
  fallbackAllowed = category !== "publication",
) {
  return new WorkspaceBackupV2NativeError({
    category,
    code: boundedDiagnosticDetail(code),
    detail: boundedDiagnosticDetail(detail),
    fallbackAllowed,
    native: createRudderNativeDiagnostic({
      capability: "workspace-backup",
      target: resolveRudderNativeTarget(),
      binaryVersion: "unavailable",
      protocolVersion: String(NATIVE_PROTOCOL_VERSION),
      effectiveEngine: "rust",
      fallbackCode: boundedDiagnosticDetail(code),
    }),
  });
}

function nativeTarget() {
  return resolveRudderNativeTarget();
}

export function resolveNativeArchiveBinary() {
  const configured = process.env.RUDDER_NATIVE_ARCHIVE_PATH?.trim();
  if (configured) return path.resolve(configured);
  const binaryName = process.platform === "win32" ? "rudder-native.exe" : "rudder-native";
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const target = nativeTarget();
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  const resourcesPath = process.env.RUDDER_DESKTOP_RESOURCES_PATH?.trim()
    || (typeof electronProcess.resourcesPath === "string" ? electronProcess.resourcesPath : "");
  const candidates = [
    path.resolve(moduleDir, "../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../../native/target/debug", binaryName),
    path.resolve(moduleDir, "../../../native", target ?? "unsupported", binaryName),
    resourcesPath && target ? path.resolve(resourcesPath, "native", target, binaryName) : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

async function sha256FileBounded(filePath: string) {
  const handle = await fs.open(filePath, "r");
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.allocUnsafe(256 * 1024);
  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function runNativeArchive(binary: string, args: string[], timeoutMs = Number(process.env.RUDDER_NATIVE_ARCHIVE_TIMEOUT_MS) || 30_000): Promise<NativeArchiveJson> {
  let result: { stdout: string; stderr: string };
  try {
    const command = resolveNativeCommand(binary, args);
    result = await execFileAsync(command.command, command.args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: NATIVE_OUTPUT_LIMIT_BYTES,
      windowsHide: true,
    });
  } catch (error) {
    const maybe = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown; signal?: unknown };
    if (maybe.killed || maybe.signal === "SIGTERM" || maybe.code === "ETIMEDOUT") {
      throw nativeDiagnostic("timeout", "process_timeout", `${timeoutMs}ms`);
    }
    if (maybe.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw nativeDiagnostic("protocol", "output_limit", `${NATIVE_OUTPUT_LIMIT_BYTES} bytes`);
    }
    const stdout = typeof maybe.stdout === "string" ? maybe.stdout : "";
    const stderr = typeof maybe.stderr === "string" ? maybe.stderr : "";
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length === 1) {
      try {
        const parsed = JSON.parse(lines[0]!) as NativeArchiveJson;
        if (parsed && typeof parsed === "object" && typeof parsed.errorCode === "string") {
          const accepted = parsed.accepted === true;
          throw nativeDiagnostic("process", parsed.errorCode, stderr || `exit ${String(maybe.code ?? "unknown")}`, !accepted);
        }
      } catch (parsedError) {
        if (parsedError instanceof WorkspaceBackupV2NativeError) throw parsedError;
      }
    }
    throw nativeDiagnostic("process", "nonzero_exit", `${String(maybe.code ?? "unknown")}: ${stderr}`);
  }
  if (result.stderr.trim()) throw nativeDiagnostic("protocol", "unexpected_stderr", result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw nativeDiagnostic("protocol", "response_line_count", lines.length);
  let parsed: unknown;
  try { parsed = JSON.parse(lines[0]!); } catch { throw nativeDiagnostic("protocol", "malformed_json", lines[0]); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw nativeDiagnostic("protocol", "malformed_envelope", typeof parsed);
  return parsed as NativeArchiveJson;
}

async function ensureNativeArchiveCapability(capability: "archive.inspectManifest" | "archive.extractFile") {
  const response = await runNativeArchive(resolveNativeArchiveBinary(), ["archive", "capabilities"]);
  if (response.ok !== true || response.protocolVersion !== NATIVE_PROTOCOL_VERSION || !Array.isArray(response.capabilities) || !response.capabilities.includes(capability)) {
    throw nativeDiagnostic("capability", `${capability.replaceAll(".", "_")}_unavailable`, JSON.stringify(response.capabilities));
  }
}

function parseNativeManifest(response: NativeArchiveJson): WorkspaceBackupV2Manifest {
  if (response.ok !== true || response.operation !== "inspectManifest" || response.protocolVersion !== NATIVE_PROTOCOL_VERSION || typeof response.manifestBase64 !== "string") {
    throw nativeDiagnostic("protocol", "inspect_manifest_envelope_mismatch", JSON.stringify({ operation: response.operation, protocolVersion: response.protocolVersion }));
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(response.manifestBase64, "base64");
  } catch (error) {
    throw nativeDiagnostic("integrity", "manifest_base64_invalid", error);
  }
  const manifest = parseManifest(bytes);
  if (typeof response.sha256 === "string" && response.sha256 !== sha256(bytes)) {
    throw nativeDiagnostic("integrity", "manifest_hash_mismatch", "native manifest hash differs from payload");
  }
  return manifest;
}

export async function inspectWorkspaceBackupV2FileNative(filePath: string): Promise<{
  manifest: WorkspaceBackupV2Manifest;
  archiveSize: number;
}> {
  await ensureNativeArchiveCapability("archive.inspectManifest");
  const response = await runNativeArchive(resolveNativeArchiveBinary(), [
    "archive", "inspect-manifest", path.resolve(filePath),
    String(WORKSPACE_BACKUP_V2_MAX_ARCHIVE_BYTES),
    String(WORKSPACE_BACKUP_V2_MAX_FILE_BYTES),
  ]);
  const manifest = parseNativeManifest(response);
  // Native inspection reads only the manifest entry. Independently validate
  // the central directory before accepting it so unlisted entries cannot pass
  // through the native path.
  let nodeInspection: WorkspaceBackupV2ArchiveIndex;
  try {
    nodeInspection = await inspectWorkspaceBackupV2File(filePath);
  } catch (error) {
    throw nativeDiagnostic("integrity", "archive_manifest_entry_mismatch", error instanceof Error ? error.message : error);
  }
  if (JSON.stringify(nodeInspection.manifest) !== JSON.stringify(manifest)) {
    throw nativeDiagnostic("integrity", "native_manifest_archive_mismatch", "native and archive manifests differ");
  }
  const archiveStat = await fs.stat(filePath);
  if (!archiveStat.isFile() || !Number.isSafeInteger(response.byteSize) || Number(response.byteSize) <= 0) {
    throw nativeDiagnostic("integrity", "inspect_manifest_size_invalid", response.byteSize);
  }
  return { manifest, archiveSize: archiveStat.size };
}

export async function readWorkspaceBackupV2FileNative(filePath: string, relativePath: string, rootPath?: string): Promise<Buffer> {
  const normalized = assertSafeWorkspaceBackupV2Path(relativePath);
  const archiveEntry = rootPath ? `${rootSegment(rootPath)}/${normalized}` : normalized;
  await ensureNativeArchiveCapability("archive.extractFile");
  const staging = await fs.mkdtemp(path.join(path.dirname(path.resolve(filePath)), ".rudder-native-extract-"));
  const output = path.join(staging, "entry");
  try {
    const response = await runNativeArchive(resolveNativeArchiveBinary(), [
      "archive", "extract-file", path.resolve(filePath), archiveEntry, output,
      String(WORKSPACE_BACKUP_V2_MAX_ARCHIVE_BYTES),
      String(WORKSPACE_BACKUP_V2_MAX_FILE_BYTES),
    ]);
    if (response.ok !== true || response.operation !== "extractFile" || response.protocolVersion !== NATIVE_PROTOCOL_VERSION || response.accepted !== true) {
      throw nativeDiagnostic("protocol", "extract_file_envelope_mismatch", JSON.stringify({ operation: response.operation, protocolVersion: response.protocolVersion, accepted: response.accepted }), response.accepted !== true);
    }
    const data = await fs.readFile(output);
    if (!Number.isSafeInteger(response.byteSize) || Number(response.byteSize) !== data.byteLength || typeof response.sha256 !== "string" || response.sha256 !== sha256(data)) {
      throw nativeDiagnostic("integrity", "extracted_file_mismatch", normalized, false);
    }
    return data;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function inspectWorkspaceBackupV2ForService(filePath: string, orgId: string, expectedArchiveSha256?: string | null): Promise<WorkspaceBackupV2ReadPayload> {
  const policy = resolveRudderNativeCapability({ capability: "workspace-backup", env: process.env, legacyToggleEnvs: ["RUDDER_WORKSPACE_BACKUP_V2_NATIVE"] });
  let fallbackWarning: string | undefined;
  if (policy.enabled) {
    try {
      const inspected = await inspectWorkspaceBackupV2FileNative(filePath);
      if (expectedArchiveSha256 && await sha256FileBounded(filePath) !== expectedArchiveSha256) throw new Error("Workspace backup artifact checksum does not match the recorded backup metadata");
      if (inspected.manifest.identity.orgId !== orgId) throw new Error("organization identity mismatch");
      return { ...inspected, native: true, rootPath: inspected.manifest.identity.rootPath };
    } catch (error) {
      const diagnostic = workspaceBackupV2NativeDiagnostic(error);
      if (!policy.fallbackAllowed || !diagnostic.fallbackAllowed) throw error;
      fallbackWarning = formatWorkspaceBackupV2NativeFallback(error);
    }
  }
  const index = await inspectWorkspaceBackupV2File(filePath);
  if (expectedArchiveSha256 && await sha256FileBounded(filePath) !== expectedArchiveSha256) throw new Error("Workspace backup artifact checksum does not match the recorded backup metadata");
  if (index.manifest.identity.orgId !== orgId) throw new Error("organization identity mismatch");
  return { manifest: index.manifest, native: false, archiveSize: index.archiveSize, index, rootPath: index.manifest.identity.rootPath, fallbackWarning };
}

export function isWorkspaceBackupV2FeatureEnabled() {
  const explicit = process.env.RUDDER_WORKSPACE_BACKUP_V2_ENABLED?.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(explicit ?? "");
}

export function isWorkspaceBackupV2NativeEnabled() {
  return isWorkspaceBackupV2FeatureEnabled()
    && resolveRudderNativeCapability({ capability: "workspace-backup", env: process.env, legacyToggleEnvs: ["RUDDER_WORKSPACE_BACKUP_V2_NATIVE"] }).enabled;
}

export async function readWorkspaceBackupV2EntryForService(filePath: string, rootPath: string, relativePath: string): Promise<Buffer> {
  const policy = resolveRudderNativeCapability({ capability: "workspace-backup", env: process.env, legacyToggleEnvs: ["RUDDER_WORKSPACE_BACKUP_V2_NATIVE"] });
  if (policy.enabled) {
    try {
      return await readWorkspaceBackupV2FileNative(filePath, relativePath, rootPath);
    } catch (error) {
      const diagnostic = workspaceBackupV2NativeDiagnostic(error);
      if (!policy.fallbackAllowed || !diagnostic.fallbackAllowed) throw error;
    }
  }
  const index = await inspectWorkspaceBackupV2File(filePath);
  return readWorkspaceBackupV2File(filePath, index, relativePath);
}

function requireNativeString(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw nativeDiagnostic("integrity", `invalid_${label.replaceAll(" ", "_")}`, value);
  return value;
}

export async function createWorkspaceBackupV2Native(input: {
  rootPath: string;
  orgId: string;
  instanceId: string;
  artifactPath: string;
  createdAt?: Date;
  onNativeStart?: () => void | Promise<void>;
  beforePublish?: () => Promise<void>;
  publicationOps?: PublicationOps;
}): Promise<WorkspaceBackupV2NativeArtifact> {
  const walked = await walkWorkspaceBackupV2(input.rootPath);
  const manifest: WorkspaceBackupV2Manifest = {
    version: WORKSPACE_BACKUP_V2_VERSION,
    policyVersion: WORKSPACE_BACKUP_V2_POLICY_VERSION,
    identity: { orgId: input.orgId, instanceId: input.instanceId, rootPath: path.resolve(input.rootPath) },
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    entries: walked.entries,
    treeSha256: walked.treeSha256,
    warnings: walked.warnings,
  };
  const binary = resolveNativeArchiveBinary();
  const capabilities = await runNativeArchive(binary, ["archive", "capabilities"]);
  if (capabilities.ok !== true || !Array.isArray(capabilities.capabilities) || !capabilities.capabilities.includes("archive.create")) {
    throw nativeDiagnostic("capability", "create_unavailable", JSON.stringify(capabilities.capabilities));
  }
  if (capabilities.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    throw nativeDiagnostic("protocol", "version_mismatch", `${String(capabilities.protocolVersion)} != ${NATIVE_PROTOCOL_VERSION}`);
  }

  const staging = await fs.mkdtemp(path.join(path.dirname(input.artifactPath), ".rudder-native-archive-"));
  const manifestPath = path.join(staging, "manifest-v2.json");
  const planPath = path.join(staging, "create-plan.json");
  const nativeOutput = path.join(staging, "archive.zip");
  try {
    await input.onNativeStart?.();
    await fs.writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    const entries = [
      { kind: "directory", archivePath: `${rootSegment(input.rootPath)}/` },
      ...walked.entries.map((entry) => entry.kind === "directory"
        ? { kind: "directory", archivePath: `${rootSegment(input.rootPath)}/${entry.path}/` }
        : { kind: "file", archivePath: `${rootSegment(input.rootPath)}/${entry.path}`, sourcePath: path.join(input.rootPath, entry.path) }),
    ];
    await fs.writeFile(planPath, JSON.stringify({
      protocolVersion: 1,
      manifestSource: manifestPath,
      treeSha256: manifest.treeSha256,
      entries,
    }), { mode: 0o600 });
    const response = await runNativeArchive(binary, [
      "archive", "create", planPath, nativeOutput,
      String(WORKSPACE_BACKUP_V2_MAX_ARCHIVE_BYTES),
      String(WORKSPACE_BACKUP_V2_MAX_FILE_BYTES),
      String(WORKSPACE_BACKUP_V2_MAX_TOTAL_BYTES),
    ]);
    if (response.ok !== true) {
      const code = typeof response.errorCode === "string" ? response.errorCode : "create_failed";
      const publication = ["published_output_cleanup_failed", "publication_recovery_required"].includes(code);
      throw nativeDiagnostic(publication ? "publication" : "process", code, "create response", !publication);
    }
    if (response.operation !== "create" || response.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
      throw nativeDiagnostic("protocol", "create_envelope_mismatch", `${String(response.operation)}/${String(response.protocolVersion)}`);
    }
    const archiveSha256 = requireNativeString(response.sha256, "archive hash");
    const manifestSha256 = requireNativeString(response.manifestSha256, "manifest hash");
    if (response.treeSha256 !== manifest.treeSha256 || response.manifestSha256 !== sha256(JSON.stringify(manifest))) {
      throw nativeDiagnostic("integrity", "manifest_mismatch", "native evidence differs from TypeScript manifest");
    }
    const stat = await fs.stat(nativeOutput);
    if (!stat.isFile() || stat.size !== response.byteSize || await sha256FileBounded(nativeOutput) !== archiveSha256) {
      throw nativeDiagnostic("integrity", "output_mismatch", "size or SHA-256 differs from native evidence");
    }
    await fs.mkdir(path.dirname(input.artifactPath), { recursive: true });
    if (await fs.stat(input.artifactPath).then(() => true).catch(() => false)) {
      throw nativeDiagnostic("publication", "final_exists", "destination already exists", false);
    }
    await input.beforePublish?.();
    await publishNoReplace(nativeOutput, input.artifactPath, input.publicationOps);
    let inspected: { manifest: WorkspaceBackupV2Manifest; archiveSize: number };
    try {
      inspected = await inspectWorkspaceBackupV2FileNative(input.artifactPath);
    } catch (error) {
      try {
        await removePublishedForFallback(input.artifactPath, input.publicationOps);
      } catch (cleanupError) {
        if (cleanupError instanceof WorkspaceBackupV2NativeError) throw cleanupError;
        throw nativeDiagnostic("publication", "published_output_cleanup_failed", cleanupError, false);
      }
      throw nativeDiagnostic("integrity", "published_archive_invalid", error instanceof Error ? error.message : error);
    }
    if (inspected.manifest.identity.orgId !== input.orgId || inspected.manifest.identity.instanceId !== input.instanceId || inspected.manifest.treeSha256 !== manifest.treeSha256) {
      try {
        await removePublishedForFallback(input.artifactPath, input.publicationOps);
      } catch (cleanupError) {
        if (cleanupError instanceof WorkspaceBackupV2NativeError) throw cleanupError;
        throw nativeDiagnostic("publication", "published_output_cleanup_failed", cleanupError, false);
      }
      throw nativeDiagnostic("integrity", "published_manifest_mismatch", "published archive identity differs");
    }
    return { ...walked, artifactPath: input.artifactPath, archiveSha256, manifest };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

type ZipRecord = WorkspaceBackupV2ArchiveEntry & { flags: number; method: number; nameBytes: Buffer };

function decodeUtf8(value: Buffer, label: string) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  if (text.includes("\0")) throw new Error(`${label} contains NUL`);
  return text;
}

function findEocd(archive: Uint8Array) {
  const start = Math.max(0, archive.byteLength - EOCD_MAX_SCAN_BYTES);
  for (let offset = archive.byteLength - EOCD_MIN_BYTES; offset >= start; offset -= 1) {
    if (archive[offset] === 0x50 && archive[offset + 1] === 0x4b && archive[offset + 2] === 0x05 && archive[offset + 3] === 0x06) {
      return offset;
    }
  }
  throw new Error("v2 backup ZIP end record is missing");
}

function parseZipRecords(archive: Uint8Array): ZipRecord[] {
  if (archive.byteLength > WORKSPACE_BACKUP_V2_MAX_ARCHIVE_BYTES) throw new Error("v2 backup archive exceeds the bounded archive limit");
  const eocd = findEocd(archive);
  const commentLength = archive[eocd + 20]! | (archive[eocd + 21]! << 8);
  if (eocd + EOCD_MIN_BYTES + commentLength !== archive.byteLength) throw new Error("v2 backup ZIP has trailing bytes");
  const disk = archive[eocd + 4]! | (archive[eocd + 5]! << 8);
  const centralDisk = archive[eocd + 6]! | (archive[eocd + 7]! << 8);
  const entriesOnDisk = archive[eocd + 8]! | (archive[eocd + 9]! << 8);
  const entryCount = archive[eocd + 10]! | (archive[eocd + 11]! << 8);
  const centralSize = archive[eocd + 12]! | (archive[eocd + 13]! << 8) | (archive[eocd + 14]! << 16) | (archive[eocd + 15]! << 24);
  const centralOffset = archive[eocd + 16]! | (archive[eocd + 17]! << 8) | (archive[eocd + 18]! << 16) | (archive[eocd + 19]! << 24);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || centralSize < 0 || centralSize > WORKSPACE_BACKUP_V2_MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new Error("v2 backup ZIP multi-disk or central-directory limits are unsupported");
  }
  if (entryCount === 0xffff || centralSize + centralOffset > eocd) throw new Error("v2 backup ZIP uses unsupported ZIP64 or has an invalid central directory");
  const records: ZipRecord[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + ZIP_CENTRAL_HEADER_BYTES > centralOffset + centralSize || archive[cursor] !== 0x50 || archive[cursor + 1] !== 0x4b || archive[cursor + 2] !== 0x01 || archive[cursor + 3] !== 0x02) {
      throw new Error("v2 backup ZIP central directory is malformed");
    }
    const flags = archive[cursor + 8]! | (archive[cursor + 9]! << 8);
    const method = archive[cursor + 10]! | (archive[cursor + 11]! << 8);
    const crc = (archive[cursor + 16]! | (archive[cursor + 17]! << 8) | (archive[cursor + 18]! << 16) | (archive[cursor + 19]! << 24)) >>> 0;
    const compressedSize = (archive[cursor + 20]! | (archive[cursor + 21]! << 8) | (archive[cursor + 22]! << 16) | (archive[cursor + 23]! << 24)) >>> 0;
    const byteSize = (archive[cursor + 24]! | (archive[cursor + 25]! << 8) | (archive[cursor + 26]! << 16) | (archive[cursor + 27]! << 24)) >>> 0;
    const nameLength = archive[cursor + 28]! | (archive[cursor + 29]! << 8);
    const extraLength = archive[cursor + 30]! | (archive[cursor + 31]! << 8);
    const commentLength = archive[cursor + 32]! | (archive[cursor + 33]! << 8);
    const externalAttributes = (archive[cursor + 38]! | (archive[cursor + 39]! << 8) | (archive[cursor + 40]! << 16) | (archive[cursor + 41]! << 24)) >>> 0;
    const localOffset = (archive[cursor + 42]! | (archive[cursor + 43]! << 8) | (archive[cursor + 44]! << 16) | (archive[cursor + 45]! << 24)) >>> 0;
    const end = cursor + ZIP_CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
    if (end > centralOffset + centralSize) throw new Error("v2 backup ZIP central entry exceeds its directory");
    const nameBytes = Buffer.from(archive.subarray(cursor + ZIP_CENTRAL_HEADER_BYTES, cursor + ZIP_CENTRAL_HEADER_BYTES + nameLength));
    const archivePath = decodeUtf8(nameBytes, "v2 backup ZIP path");
    if ((flags & 0x0001) !== 0 || (flags & 0x0008) !== 0 || method !== 0) throw new Error(`v2 backup ZIP entry is encrypted, uses a descriptor, or has unsupported compression: ${archivePath}`);
    if (compressedSize !== byteSize || byteSize > WORKSPACE_BACKUP_V2_MAX_FILE_BYTES) throw new Error(`v2 backup ZIP entry exceeds safe uncompressed limits: ${archivePath}`);
    const directory = archivePath.endsWith("/");
    if (directory && byteSize !== 0) throw new Error(`v2 backup directory has data: ${archivePath}`);
    if (!directory && (externalAttributes & 0x10) !== 0) throw new Error(`v2 backup file has directory attributes: ${archivePath}`);
    if (localOffset + ZIP_LOCAL_HEADER_BYTES > centralOffset) throw new Error(`v2 backup local entry offset is invalid: ${archivePath}`);
    const local = archive.subarray(localOffset, localOffset + ZIP_LOCAL_HEADER_BYTES);
    if (local[0] !== 0x50 || local[1] !== 0x4b || local[2] !== 0x03 || local[3] !== 0x04) throw new Error(`v2 backup local entry is malformed: ${archivePath}`);
    const localFlags = local[6]! | (local[7]! << 8);
    const localMethod = local[8]! | (local[9]! << 8);
    const localNameLength = local[26]! | (local[27]! << 8);
    const localExtraLength = local[28]! | (local[29]! << 8);
    const dataOffset = localOffset + ZIP_LOCAL_HEADER_BYTES + localNameLength + localExtraLength;
    if (localFlags !== flags || localMethod !== method || !Buffer.from(archive.subarray(localOffset + ZIP_LOCAL_HEADER_BYTES, dataOffset)).equals(nameBytes) || dataOffset + compressedSize > centralOffset) {
      throw new Error(`v2 backup local entry does not match its central directory: ${archivePath}`);
    }
    records.push({ archivePath, kind: directory ? "directory" : "file", compressedSize, byteSize, crc32: crc, dataOffset, flags, method, nameBytes });
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("v2 backup ZIP central directory has trailing records");
  const names = new Set<string>();
  const foldedNames = new Set<string>();
  let totalBytes = 0;
  for (const record of records) {
    if (names.has(record.archivePath)) throw new Error(`duplicate v2 backup ZIP path: ${record.archivePath}`);
    const folded = record.archivePath.toLowerCase();
    if (foldedNames.has(folded)) throw new Error(`case-colliding v2 backup ZIP path: ${record.archivePath}`);
    names.add(record.archivePath);
    foldedNames.add(folded);
    totalBytes += record.kind === "file" && record.archivePath !== WORKSPACE_BACKUP_V2_MANIFEST_PATH ? record.byteSize : 0;
    if (totalBytes > WORKSPACE_BACKUP_V2_MAX_TOTAL_BYTES) throw new Error("v2 backup ZIP exceeds the total uncompressed byte limit");
    if (record.kind === "file") assertSafeWorkspaceBackupV2Path(record.archivePath);
    else if (!assertSafeWorkspaceBackupV2Path(record.archivePath.slice(0, -1))) throw new Error(`invalid v2 backup directory path: ${record.archivePath}`);
  }
  return records;
}

function parseManifest(value: Buffer): WorkspaceBackupV2Manifest {
  let manifest: unknown;
  try { manifest = JSON.parse(value.toString("utf8")); } catch { throw new Error("v2 backup manifest is malformed"); }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("v2 backup manifest is malformed");
  const candidate = manifest as Partial<WorkspaceBackupV2Manifest>;
  if (candidate.version !== WORKSPACE_BACKUP_V2_VERSION || candidate.policyVersion !== WORKSPACE_BACKUP_V2_POLICY_VERSION || !Array.isArray(candidate.entries)) throw new Error("unsupported v2 backup manifest");
  if (!candidate.identity || typeof candidate.identity !== "object" || Array.isArray(candidate.identity)) throw new Error("v2 backup manifest identity is malformed");
  const identity = candidate.identity as Partial<WorkspaceBackupV2Manifest["identity"]>;
  if (![identity.orgId, identity.instanceId, identity.rootPath].every((item) => typeof item === "string" && item.length > 0 && !item.includes("\0"))) throw new Error("v2 backup manifest identity is malformed");
  if (typeof candidate.createdAt !== "string" || Number.isNaN(new Date(candidate.createdAt).getTime()) || !/^[a-f0-9]{64}$/.test(candidate.treeSha256 ?? "") || !Array.isArray(candidate.warnings)) throw new Error("v2 backup manifest metadata is malformed");
  const entries = candidate.entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("v2 backup manifest entry is malformed");
    const item = entry as Partial<WorkspaceBackupV2Entry>;
    if (typeof item.path !== "string" || !["file", "directory"].includes(item.kind ?? "") || !Number.isSafeInteger(item.byteSize) || item.byteSize! < 0 || item.byteSize! > WORKSPACE_BACKUP_V2_MAX_FILE_BYTES) throw new Error("v2 backup manifest entry is malformed");
    assertSafeWorkspaceBackupV2Path(item.path);
    if (item.kind === "directory" && (item.byteSize !== 0 || item.sha256 !== null)) throw new Error(`v2 backup directory metadata is malformed: ${item.path}`);
    if (item.kind === "file" && (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))) throw new Error(`v2 backup file metadata is malformed: ${item.path}`);
    return {
      path: item.path,
      kind: item.kind as WorkspaceBackupV2Entry["kind"],
      byteSize: item.byteSize!,
      mtimeMs: typeof item.mtimeMs === "number" || item.mtimeMs === null ? item.mtimeMs : null,
      mode: typeof item.mode === "number" || item.mode === null ? item.mode : null,
      sha256: item.sha256 ?? null,
    };
  });
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`duplicate v2 backup manifest path: ${entry.path}`);
    const folded = entry.path.toLowerCase();
    if (foldedPaths.has(folded)) throw new Error(`case-colliding v2 backup manifest path: ${entry.path}`);
    paths.add(entry.path);
    foldedPaths.add(folded);
  }
  const result: WorkspaceBackupV2Manifest = { version: WORKSPACE_BACKUP_V2_VERSION, policyVersion: WORKSPACE_BACKUP_V2_POLICY_VERSION, identity: { orgId: identity.orgId!, instanceId: identity.instanceId!, rootPath: identity.rootPath! }, createdAt: candidate.createdAt, entries, treeSha256: candidate.treeSha256!, warnings: candidate.warnings.filter((warning): warning is string => typeof warning === "string") };
  if (treeHash(result.entries) !== result.treeSha256) throw new Error("v2 backup tree checksum mismatch");
  return result;
}

function validateArchiveAgainstManifest(records: ZipRecord[], manifest: WorkspaceBackupV2Manifest, readEntry?: (record: ZipRecord) => Buffer): WorkspaceBackupV2ArchiveIndex {
  const byName = new Map(records.map((record) => [record.archivePath, record]));
  const root = rootSegment(manifest.identity.rootPath);
  const expected = new Set<string>([WORKSPACE_BACKUP_V2_MANIFEST_PATH, `${root}/`]);
  const entries = new Map<string, WorkspaceBackupV2ArchiveEntry>();
  const manifestRecord = byName.get(WORKSPACE_BACKUP_V2_MANIFEST_PATH);
  if (!manifestRecord || manifestRecord.kind !== "file") throw new Error("v2 backup manifest is missing");
  for (const entry of manifest.entries) {
    const archivePath = `${root}/${entry.path}${entry.kind === "directory" ? "/" : ""}`;
    expected.add(archivePath);
    const record = byName.get(archivePath);
    if (!record || record.kind !== entry.kind || record.byteSize !== entry.byteSize) throw new Error(`v2 backup archive entry mismatch: ${entry.path}`);
    if (entry.kind === "file" && readEntry) {
      const data = readEntry(record);
      if (sha256(data) !== entry.sha256) throw new Error(`v2 backup checksum mismatch: ${entry.path}`);
    }
    entries.set(entry.path, record);
  }
  for (const record of records) if (!expected.has(record.archivePath)) throw new Error(`unlisted v2 backup archive entry: ${record.archivePath}`);
  return { archiveSize: 0, manifest, manifestEntry: manifestRecord, entries };
}

function readBufferEntry(archive: Uint8Array, record: ZipRecord) {
  const data = Buffer.from(archive.subarray(record.dataOffset, record.dataOffset + record.byteSize));
  if (crc32(data) !== record.crc32) throw new Error(`v2 backup checksum mismatch: ${record.archivePath}`);
  return data;
}

export function inspectWorkspaceBackupV2(archive: Uint8Array): { manifest: WorkspaceBackupV2Manifest; files: Map<string, Buffer> } {
  const records = parseZipRecords(archive);
  const manifestRecord = records.find((record) => record.archivePath === WORKSPACE_BACKUP_V2_MANIFEST_PATH);
  if (!manifestRecord) throw new Error("v2 backup manifest is missing");
  const manifest = parseManifest(readBufferEntry(archive, manifestRecord));
  validateArchiveAgainstManifest(records, manifest, (record) => readBufferEntry(archive, record));
  const files = new Map<string, Buffer>();
  for (const entry of manifest.entries) if (entry.kind === "file") files.set(entry.path, readBufferEntry(archive, records.find((record) => record.archivePath === `${rootSegment(manifest.identity.rootPath)}/${entry.path}`)!));
  return { manifest, files };
}

async function readAt(handle: fs.FileHandle, offset: number, length: number) {
  const result = Buffer.alloc(length);
  let position = 0;
  while (position < length) {
    const read = await handle.read(result, position, length - position, offset + position);
    if (!read.bytesRead) throw new Error("v2 backup ZIP ended before the requested range");
    position += read.bytesRead;
  }
  return result;
}

function parseCentralDirectory(central: Uint8Array, centralOffset: number, centralSize: number, entryCount: number): ZipRecord[] {
  const records: ZipRecord[] = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + ZIP_CENTRAL_HEADER_BYTES > central.length || central[cursor] !== 0x50 || central[cursor + 1] !== 0x4b || central[cursor + 2] !== 0x01 || central[cursor + 3] !== 0x02) {
      throw new Error("v2 backup ZIP central directory is malformed");
    }
    const flags = central[cursor + 8]! | (central[cursor + 9]! << 8);
    const method = central[cursor + 10]! | (central[cursor + 11]! << 8);
    const crc = (central[cursor + 16]! | (central[cursor + 17]! << 8) | (central[cursor + 18]! << 16) | (central[cursor + 19]! << 24)) >>> 0;
    const compressedSize = (central[cursor + 20]! | (central[cursor + 21]! << 8) | (central[cursor + 22]! << 16) | (central[cursor + 23]! << 24)) >>> 0;
    const byteSize = (central[cursor + 24]! | (central[cursor + 25]! << 8) | (central[cursor + 26]! << 16) | (central[cursor + 27]! << 24)) >>> 0;
    const nameLength = central[cursor + 28]! | (central[cursor + 29]! << 8);
    const extraLength = central[cursor + 30]! | (central[cursor + 31]! << 8);
    const commentLength = central[cursor + 32]! | (central[cursor + 33]! << 8);
    const externalAttributes = (central[cursor + 38]! | (central[cursor + 39]! << 8) | (central[cursor + 40]! << 16) | (central[cursor + 41]! << 24)) >>> 0;
    const localOffset = (central[cursor + 42]! | (central[cursor + 43]! << 8) | (central[cursor + 44]! << 16) | (central[cursor + 45]! << 24)) >>> 0;
    const end = cursor + ZIP_CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
    if (end > central.length) throw new Error("v2 backup ZIP central entry exceeds its directory");
    const nameBytes = Buffer.from(central.subarray(cursor + ZIP_CENTRAL_HEADER_BYTES, cursor + ZIP_CENTRAL_HEADER_BYTES + nameLength));
    const archivePath = decodeUtf8(nameBytes, "v2 backup ZIP path");
    if ((flags & 0x0001) !== 0 || (flags & 0x0008) !== 0 || method !== 0) throw new Error(`v2 backup ZIP entry is encrypted, uses a descriptor, or has unsupported compression: ${archivePath}`);
    if (compressedSize !== byteSize || byteSize > WORKSPACE_BACKUP_V2_MAX_FILE_BYTES) throw new Error(`v2 backup ZIP entry exceeds safe uncompressed limits: ${archivePath}`);
    const directory = archivePath.endsWith("/");
    if (directory && byteSize !== 0) throw new Error(`v2 backup directory has data: ${archivePath}`);
    if (!directory && (externalAttributes & 0x10) !== 0) throw new Error(`v2 backup file has directory attributes: ${archivePath}`);
    if (localOffset + ZIP_LOCAL_HEADER_BYTES > centralOffset) throw new Error(`v2 backup local entry offset is invalid: ${archivePath}`);
    records.push({ archivePath, kind: directory ? "directory" : "file", compressedSize, byteSize, crc32: crc, dataOffset: localOffset, flags, method, nameBytes });
    cursor = end;
  }
  if (cursor !== central.length) throw new Error("v2 backup ZIP central directory has trailing records");
  const names = new Set<string>();
  const foldedNames = new Set<string>();
  let totalBytes = 0;
  for (const record of records) {
    if (names.has(record.archivePath)) throw new Error(`duplicate v2 backup ZIP path: ${record.archivePath}`);
    const folded = record.archivePath.toLowerCase();
    if (foldedNames.has(folded)) throw new Error(`case-colliding v2 backup ZIP path: ${record.archivePath}`);
    names.add(record.archivePath);
    foldedNames.add(folded);
    totalBytes += record.kind === "file" && record.archivePath !== WORKSPACE_BACKUP_V2_MANIFEST_PATH ? record.byteSize : 0;
    if (totalBytes > WORKSPACE_BACKUP_V2_MAX_TOTAL_BYTES) throw new Error("v2 backup ZIP exceeds the total uncompressed byte limit");
    if (record.kind === "file") assertSafeWorkspaceBackupV2Path(record.archivePath);
    else assertSafeWorkspaceBackupV2Path(record.archivePath.slice(0, -1));
  }
  return records;
}

async function parseZipRecordsFile(handle: fs.FileHandle, archiveSize: number) {
  if (archiveSize > WORKSPACE_BACKUP_V2_MAX_ARCHIVE_BYTES) throw new Error("v2 backup archive exceeds the bounded archive limit");
  const tailSize = Math.min(archiveSize, EOCD_MAX_SCAN_BYTES);
  const tail = await readAt(handle, archiveSize - tailSize, tailSize);
  const eocdOffset = findEocd(tail);
  const absoluteEocd = archiveSize - tailSize + eocdOffset;
  const commentLength = tail[eocdOffset + 20]! | (tail[eocdOffset + 21]! << 8);
  if (absoluteEocd + EOCD_MIN_BYTES + commentLength !== archiveSize) throw new Error("v2 backup ZIP has trailing bytes");
  const entryCount = tail[eocdOffset + 10]! | (tail[eocdOffset + 11]! << 8);
  const entriesOnDisk = tail[eocdOffset + 8]! | (tail[eocdOffset + 9]! << 8);
  const disk = tail[eocdOffset + 4]! | (tail[eocdOffset + 5]! << 8);
  const centralDisk = tail[eocdOffset + 6]! | (tail[eocdOffset + 7]! << 8);
  const centralSize = (tail[eocdOffset + 12]! | (tail[eocdOffset + 13]! << 8) | (tail[eocdOffset + 14]! << 16) | (tail[eocdOffset + 15]! << 24)) >>> 0;
  const centralOffset = (tail[eocdOffset + 16]! | (tail[eocdOffset + 17]! << 8) | (tail[eocdOffset + 18]! << 16) | (tail[eocdOffset + 19]! << 24)) >>> 0;
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff || centralSize > WORKSPACE_BACKUP_V2_MAX_CENTRAL_DIRECTORY_BYTES || centralOffset + centralSize > absoluteEocd) throw new Error("v2 backup ZIP central directory is unsupported or invalid");
  const central = await readAt(handle, centralOffset, centralSize);
  const records = parseCentralDirectory(central, centralOffset, centralSize, entryCount);
  for (const record of records) {
    const local = await readAt(handle, record.dataOffset, ZIP_LOCAL_HEADER_BYTES);
    if (local[0] !== 0x50 || local[1] !== 0x4b || local[2] !== 0x03 || local[3] !== 0x04) throw new Error(`v2 backup local entry is malformed: ${record.archivePath}`);
    const localFlags = local[6]! | (local[7]! << 8);
    const localMethod = local[8]! | (local[9]! << 8);
    const localNameLength = local[26]! | (local[27]! << 8);
    const localExtraLength = local[28]! | (local[29]! << 8);
    const name = await readAt(handle, record.dataOffset + ZIP_LOCAL_HEADER_BYTES, localNameLength + localExtraLength);
    const dataOffset = record.dataOffset + ZIP_LOCAL_HEADER_BYTES + localNameLength + localExtraLength;
    if (localFlags !== record.flags || localMethod !== record.method || !name.subarray(0, localNameLength).equals(record.nameBytes) || dataOffset + record.compressedSize > centralOffset) {
      throw new Error(`v2 backup local entry does not match its central directory: ${record.archivePath}`);
    }
    record.dataOffset = dataOffset;
  }
  return records;
}

// Parse a file-backed archive without reading its local data records. The
// central directory is the only unbounded metadata surface and is capped above.
async function inspectWorkspaceBackupV2FileInternal(filePath: string): Promise<WorkspaceBackupV2ArchiveIndex> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("v2 backup artifact is not a regular file");
  const handle = await fs.open(filePath, "r");
  try {
    const records = await parseZipRecordsFile(handle, stat.size);
    const manifestRecord = records.find((record) => record.archivePath === WORKSPACE_BACKUP_V2_MANIFEST_PATH);
    if (!manifestRecord) throw new Error("v2 backup manifest is missing");
    const manifest = parseManifest(await readZipFileEntry(handle, manifestRecord));
    const index = validateArchiveAgainstManifest(records, manifest);
    // Manifest metadata is validated above. Per-file bytes are verified only on
    // target read or restore, keeping list/browse bounded by the central dir.
    for (const entry of manifest.entries) {
      const record = index.entries.get(entry.path)!;
      if (record.byteSize !== entry.byteSize) throw new Error(`v2 backup archive entry mismatch: ${entry.path}`);
    }
    return { ...index, archiveSize: stat.size };
  } finally {
    await handle.close();
  }
}

async function readZipFileEntry(handle: fs.FileHandle, record: WorkspaceBackupV2ArchiveEntry) {
  if (record.byteSize > WORKSPACE_BACKUP_V2_MAX_FILE_BYTES) throw new Error(`v2 backup entry exceeds safe read limit: ${record.archivePath}`);
  const data = await readAt(handle, record.dataOffset, record.byteSize);
  if (crc32(data) !== record.crc32) throw new Error(`v2 backup checksum mismatch: ${record.archivePath}`);
  return data;
}

export async function inspectWorkspaceBackupV2File(filePath: string): Promise<WorkspaceBackupV2ArchiveIndex> {
  const index = await inspectWorkspaceBackupV2FileInternal(filePath);
  const handle = await fs.open(filePath, "r");
  try {
    await readZipFileEntry(handle, index.manifestEntry);
    return index;
  } finally {
    await handle.close();
  }
}

export async function readWorkspaceBackupV2File(filePath: string, index: WorkspaceBackupV2ArchiveIndex, relativePath: string): Promise<Buffer> {
  const normalized = assertSafeWorkspaceBackupV2Path(relativePath);
  const record = index.entries.get(normalized);
  if (!record || record.kind !== "file") throw new Error(`v2 backup file not found: ${normalized}`);
  const handle = await fs.open(filePath, "r");
  try {
    const data = await readZipFileEntry(handle, record);
    const manifestEntry = index.manifest.entries.find((entry) => entry.path === normalized);
    if (!manifestEntry || sha256(data) !== manifestEntry.sha256) throw new Error(`v2 backup checksum mismatch: ${normalized}`);
    return data;
  } finally {
    await handle.close();
  }
}
