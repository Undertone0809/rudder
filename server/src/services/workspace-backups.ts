import {
  resolveOrganizationLegacyStorageKey,
  resolveOrganizationStorageKey,
} from "@rudderhq/agent-runtime-utils";
import {
  heartbeatRuns,
  workspaceBackups,
  type Db,
} from "@rudderhq/db";
import {
  WORKSPACE_BACKUP_DEFAULT_INTERVAL_HOURS,
  WORKSPACE_BACKUP_DEFAULT_RETENTION_DAYS,
  WORKSPACE_BACKUP_OFFLINE_INTERVAL_HOURS,
  WORKSPACE_BACKUP_RUNNING_INTERVAL_HOURS,
  type OrganizationWorkspaceFileDetail,
  type OrganizationWorkspaceFileEntry,
  type OrganizationWorkspaceFileList,
  type WorkspaceBackupRestoreResult,
  type WorkspaceBackupSummary,
  type WorkspaceBackupTriggerSource,
} from "@rudderhq/shared";
import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  ensureOrganizationWorkspaceLayout,
  resolveDefaultBackupDir,
  resolveOrganizationWorkspaceRoot,
  resolveRudderInstanceId,
} from "../home-paths.js";
import { organizationService } from "./orgs.js";

const ARTIFACT_VERSION = 1;
const MAX_PREVIEW_BYTES = 200_000;
const SKIPPED_ENTRY_NAMES = new Set([
  ".DS_Store",
  ".cache",
  ".codex",
  ".config",
  ".git",
  ".gstack",
  ".local",
  ".mintlify",
  ".npm",
  ".nvm",
  ".pnpm-store",
  ".rudder",
  ".tmp",
  ".turbo",
  ".vite",
  "Library",
  "node_modules",
]);
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const WORKSPACE_BACKUP_DEFAULT_INTERVAL_MS = WORKSPACE_BACKUP_DEFAULT_INTERVAL_HOURS * 60 * 60 * 1000;
export const WORKSPACE_BACKUP_RUNNING_INTERVAL_MS = WORKSPACE_BACKUP_RUNNING_INTERVAL_HOURS * 60 * 60 * 1000;
export const WORKSPACE_BACKUP_OFFLINE_INTERVAL_MS = WORKSPACE_BACKUP_OFFLINE_INTERVAL_HOURS * 60 * 60 * 1000;
const WORKSPACE_BACKUP_RUNNING_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_BACKUP_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BACKUP_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_WARNING_COUNT = 200;
const SPARSE_WORKSPACE_RECOVERY_MAX_CURRENT_FILES = 25;
const SPARSE_WORKSPACE_RECOVERY_MAX_RATIO = 0.25;
const SPARSE_WORKSPACE_RECOVERY_MIN_BACKUP_FILES = 10;

type WorkspaceBackupArtifactEntry = {
  path: string;
  kind: "directory" | "file";
  byteSize: number;
  mtimeMs: number | null;
  mode: number | null;
  sha256: string | null;
  dataBase64?: string;
};

type WorkspaceBackupArtifact = {
  version: typeof ARTIFACT_VERSION;
  orgId: string;
  instanceId: string;
  createdAt: string;
  rootPath: string;
  entries: WorkspaceBackupArtifactEntry[];
  warnings: string[];
};

type WorkspaceBackupRow = typeof workspaceBackups.$inferSelect;

type WorkspaceBackupWalkState = {
  byteSize: number;
};

type WorkspaceBackupWalkOptions = {
  includeFileData: boolean;
};

type WorkspaceBackupCreateInput = {
  orgId: string;
  triggerSource?: WorkspaceBackupTriggerSource;
  createdByUserId?: string | null;
  restoredFromBackupId?: string | null;
  retentionDays?: number;
};

type WorkspaceBackupArtifactMigration = {
  backupId: string;
  orgId: string;
  from: string;
  to: string;
  movedArtifact: boolean;
  updatedArtifact: boolean;
};

type WorkspaceBackupArtifactMigrationSkip = {
  backupId: string;
  orgId: string;
  from: string;
  to: string;
  reason: string;
};

export type WorkspaceBackupDownload = {
  artifactRef: string;
  filename: string;
  contentType: "application/json" | "application/zip";
  byteSize: number;
  archiveSha256: string | null;
  content: Buffer;
};

export type SparseWorkspaceRecoveryResult = {
  orgId: string;
  recovered: boolean;
  backupId: string | null;
  currentFileCount: number;
  backupFileCount: number;
  restoredFileCount: number;
  skippedConflictingFiles: string[];
  reason: string | null;
  error: string | null;
};

export type WorkspaceBackupScheduleSkip = {
  orgId: string;
  reason: "not_due" | "running" | "unchanged";
  comparedBackupId: string;
  treeSha256: string | null;
};

function timestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function addDays(date: Date, days: number) {
  const normalizedDays = Math.max(1, Math.trunc(days));
  return new Date(date.getTime() + normalizedDays * 24 * 60 * 60 * 1000);
}

function sha256Buffer(buffer: Buffer | string) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(filePath: string) {
  const handle = await fs.open(filePath, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function compareCanonicalPaths(left: WorkspaceBackupArtifactEntry, right: WorkspaceBackupArtifactEntry) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function writeUInt16(value: number) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function writeUInt32(value: number) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function dosDateTime(date = new Date()): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

function buildWorkspaceBackupZip(artifact: WorkspaceBackupArtifact, rootFolderName: string): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const sortedEntries = [...artifact.entries].sort(compareCanonicalPaths);
  const normalizedRoot = sanitizeZipPathSegment(rootFolderName);
  const createdAt = new Date(artifact.createdAt);
  const zipEntries = [
    {
      path: `${normalizedRoot}/`,
      data: Buffer.alloc(0),
      isDirectory: true,
      mtimeMs: createdAt.getTime(),
    },
    ...sortedEntries.map((entry) => ({
      path: `${normalizedRoot}/${entry.path}${entry.kind === "directory" ? "/" : ""}`,
      data: entry.kind === "file" ? Buffer.from(entry.dataBase64 ?? "", "base64") : Buffer.alloc(0),
      isDirectory: entry.kind === "directory",
      mtimeMs: entry.mtimeMs ?? createdAt.getTime(),
    })),
  ];

  for (const entry of zipEntries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = entry.data;
    const checksum = crc32(data);
    const { time, date } = dosDateTime(new Date(entry.mtimeMs));
    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(time),
      writeUInt16(date),
      writeUInt32(checksum),
      writeUInt32(data.byteLength),
      writeUInt32(data.byteLength),
      writeUInt16(name.byteLength),
      writeUInt16(0),
      name,
    ]);
    localParts.push(localHeader, data);

    centralParts.push(Buffer.concat([
      writeUInt32(0x02014b50),
      writeUInt16(20),
      writeUInt16(20),
      writeUInt16(0x0800),
      writeUInt16(0),
      writeUInt16(time),
      writeUInt16(date),
      writeUInt32(checksum),
      writeUInt32(data.byteLength),
      writeUInt32(data.byteLength),
      writeUInt16(name.byteLength),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(entry.isDirectory ? 0x10 : 0),
      writeUInt32(offset),
      name,
    ]));
    offset += localHeader.byteLength + data.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(zipEntries.length),
    writeUInt16(zipEntries.length),
    writeUInt32(centralDirectory.byteLength),
    writeUInt32(offset),
    writeUInt16(0),
  ]);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function sanitizeZipPathSegment(value: string): string {
  return value.replaceAll("\\", "/").split("/").filter(Boolean).join("-") || "workspace";
}

function backupDownloadRootFolderName(artifact: WorkspaceBackupArtifact): string {
  const basename = path.basename(artifact.rootPath);
  if (basename && basename !== "workspaces") return basename;
  return `workspace-${resolveOrganizationStorageKey(artifact.orgId)}`;
}

function addWarning(warnings: string[], warning: string) {
  if (warnings.length < MAX_WARNING_COUNT) {
    warnings.push(warning);
    return;
  }
  if (warnings.length === MAX_WARNING_COUNT) {
    warnings.push("Additional backup warnings omitted.");
  }
}

function isSkippedEntryName(name: string) {
  if (SKIPPED_ENTRY_NAMES.has(name)) return true;
  return name.endsWith("~")
    || name.endsWith(".swp")
    || name.endsWith(".swo")
    || name.endsWith(".partial")
    || name.endsWith(".crdownload")
    || /\.tmp(?:[-.]|$)/.test(name);
}

function toPortableRelativePath(relativePath: string) {
  return relativePath.split(path.sep).join("/");
}

function normalizeRequestedPath(value: string | null | undefined) {
  return typeof value === "string" ? value.trim().replace(/^\/+/, "").replace(/\/+$/g, "") : "";
}

function assertSafeRelativePath(value: string) {
  const normalized = normalizeRequestedPath(value);
  if (!normalized) return "";
  if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw unprocessable("Backup path must stay inside the organization Library root");
  }
  return normalized;
}

function resolveWithinRoot(rootPath: string, relativePath: string) {
  const normalized = assertSafeRelativePath(relativePath);
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = normalized ? path.resolve(resolvedRoot, normalized) : resolvedRoot;
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw unprocessable("Backup path must stay inside the organization Library root");
  }
  return { resolvedRoot, resolvedTarget, normalizedPath: toPortableRelativePath(relative === "" ? "" : relative) };
}

function isBinaryBuffer(buffer: Buffer) {
  for (const byte of buffer) {
    if (byte === 0) return true;
  }
  return false;
}

function mapBackupRow(row: WorkspaceBackupRow): WorkspaceBackupSummary {
  const expiresAt = row.expiresAt ?? addDays(row.createdAt, WORKSPACE_BACKUP_DEFAULT_RETENTION_DAYS);
  return {
    id: row.id,
    orgId: row.orgId,
    status: row.status as WorkspaceBackupSummary["status"],
    triggerSource: row.triggerSource as WorkspaceBackupTriggerSource,
    artifactProvider: "local_file",
    artifactRef: row.artifactRef,
    archiveSha256: row.archiveSha256,
    treeSha256: row.treeSha256,
    fileCount: row.fileCount,
    byteSize: row.byteSize,
    compressedSize: row.compressedSize,
    manifest: row.manifest ?? null,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    expiresAt: expiresAt.toISOString(),
    restoredFromBackupId: row.restoredFromBackupId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function buildTreeHash(entries: WorkspaceBackupArtifactEntry[]) {
  const hash = crypto.createHash("sha256");
  for (const entry of [...entries].sort(compareCanonicalPaths)) {
    // Scheduled identity is content-based: timestamps and permission bits do not create new versions.
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

function resolveMigratedWorkspaceBackupArtifactRef(input: {
  artifactRef: string;
  legacyDir: string;
  canonicalDir: string;
  legacyStorageKey: string;
  storageKey: string;
}): string | null {
  const artifactRef = path.resolve(input.artifactRef);
  const legacyDir = path.resolve(input.legacyDir);
  const relativePath = path.relative(legacyDir, artifactRef);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  const rewrittenRelativePath = relativePath
    .split(path.sep)
    .map((segment) => segment.split(input.legacyStorageKey).join(input.storageKey))
    .join(path.sep);
  return path.resolve(input.canonicalDir, rewrittenRelativePath);
}

function rewriteWorkspaceBackupArtifactRootPath(raw: string, orgId: string): {
  serialized: string;
  updated: boolean;
} {
  try {
    const parsed = JSON.parse(raw) as WorkspaceBackupArtifact;
    if (parsed.version !== ARTIFACT_VERSION || parsed.orgId !== orgId || !Array.isArray(parsed.entries)) {
      return { serialized: raw, updated: false };
    }
    const canonicalRootPath = resolveOrganizationWorkspaceRoot(orgId);
    if (parsed.rootPath === canonicalRootPath) return { serialized: raw, updated: false };
    return {
      serialized: `${JSON.stringify({ ...parsed, rootPath: canonicalRootPath }, null, 2)}\n`,
      updated: true,
    };
  } catch {
    return { serialized: raw, updated: false };
  }
}

function rewriteWorkspaceBackupManifestRootPath(
  manifest: WorkspaceBackupRow["manifest"],
  orgId: string,
): WorkspaceBackupRow["manifest"] {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return manifest;
  if (!("rootPath" in manifest) || typeof manifest.rootPath !== "string") return manifest;
  const canonicalRootPath = resolveOrganizationWorkspaceRoot(orgId);
  if (manifest.rootPath === canonicalRootPath) return manifest;
  return { ...manifest, rootPath: canonicalRootPath };
}

async function removeDirectoryIfEmpty(directoryPath: string): Promise<void> {
  try {
    await fs.rmdir(directoryPath);
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTEMPTY")
    ) {
      return;
    }
    throw error;
  }
}

export async function reconcileWorkspaceBackupArtifactStorage(
  db: Db,
  liveOrgIds: readonly string[],
): Promise<{
  migrated: WorkspaceBackupArtifactMigration[];
  skipped: WorkspaceBackupArtifactMigrationSkip[];
}> {
  const migrated: WorkspaceBackupArtifactMigration[] = [];
  const skipped: WorkspaceBackupArtifactMigrationSkip[] = [];

  for (const orgId of liveOrgIds) {
    const storageKey = resolveOrganizationStorageKey(orgId);
    const legacyStorageKey = resolveOrganizationLegacyStorageKey(orgId);
    if (storageKey === legacyStorageKey) continue;

    const legacyDir = path.resolve(resolveDefaultBackupDir(), "workspaces", legacyStorageKey);
    const canonicalDir = path.resolve(resolveDefaultBackupDir(), "workspaces", storageKey);
    const rows = await db
      .select()
      .from(workspaceBackups)
      .where(eq(workspaceBackups.orgId, orgId));

    for (const row of rows) {
      const nextArtifactRef = resolveMigratedWorkspaceBackupArtifactRef({
        artifactRef: row.artifactRef,
        legacyDir,
        canonicalDir,
        legacyStorageKey,
        storageKey,
      });
      if (!nextArtifactRef || nextArtifactRef === row.artifactRef) continue;

      const sourceExists = await fileExists(row.artifactRef);
      const targetExists = await fileExists(nextArtifactRef);
      let nextArchiveSha256 = row.archiveSha256;
      let updatedArtifact = false;

      if (sourceExists) {
        const raw = await fs.readFile(row.artifactRef, "utf8");
        const rewritten = rewriteWorkspaceBackupArtifactRootPath(raw, orgId);
        const serialized = rewritten.serialized;
        updatedArtifact = rewritten.updated;
        nextArchiveSha256 = sha256Buffer(serialized);

        await fs.mkdir(path.dirname(nextArtifactRef), { recursive: true });
        if (targetExists) {
          const existing = await fs.readFile(nextArtifactRef, "utf8");
          if (existing !== serialized) {
            skipped.push({
              backupId: row.id,
              orgId,
              from: row.artifactRef,
              to: nextArtifactRef,
              reason: "target artifact already exists with different content",
            });
            continue;
          }
          await fs.rm(row.artifactRef, { force: true });
        } else {
          const tempArtifactRef = `${nextArtifactRef}.tmp`;
          await fs.writeFile(tempArtifactRef, serialized, { encoding: "utf8", mode: 0o600 });
          await fs.rename(tempArtifactRef, nextArtifactRef);
          await fs.rm(row.artifactRef, { force: true });
        }
      }

      await db
        .update(workspaceBackups)
        .set({
          artifactRef: nextArtifactRef,
          archiveSha256: nextArchiveSha256,
          manifest: rewriteWorkspaceBackupManifestRootPath(row.manifest, orgId),
          updatedAt: new Date(),
        })
        .where(eq(workspaceBackups.id, row.id));
      migrated.push({
        backupId: row.id,
        orgId,
        from: row.artifactRef,
        to: nextArtifactRef,
        movedArtifact: sourceExists,
        updatedArtifact,
      });
    }

    await removeDirectoryIfEmpty(legacyDir);
  }

  return { migrated, skipped };
}

function directChildrenFromArtifact(
  artifact: WorkspaceBackupArtifact,
  directoryPath: string,
): OrganizationWorkspaceFileEntry[] {
  const normalizedDirectory = assertSafeRelativePath(directoryPath);
  const prefix = normalizedDirectory ? `${normalizedDirectory}/` : "";
  const children = new Map<string, OrganizationWorkspaceFileEntry>();

  for (const entry of artifact.entries) {
    if (normalizedDirectory && entry.path === normalizedDirectory && entry.kind === "directory") continue;
    if (!entry.path.startsWith(prefix)) continue;

    const remainder = entry.path.slice(prefix.length);
    if (!remainder) continue;
    const [name] = remainder.split("/");
    if (!name) continue;

    const isNested = remainder.includes("/");
    const childPath = prefix ? `${prefix}${name}` : name;
    const current = children.get(childPath);
    const isDirectory = isNested || entry.kind === "directory";
    if (!current || isDirectory) {
      children.set(childPath, {
        name,
        path: childPath,
        isDirectory,
      });
    }
  }

  return [...children.values()].sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function findArtifactFile(artifact: WorkspaceBackupArtifact, filePath: string) {
  const normalized = assertSafeRelativePath(filePath);
  return artifact.entries.find((entry) => entry.path === normalized && entry.kind === "file") ?? null;
}

async function fileExists(filePath: string) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function backupArtifactLooksUsable(row: WorkspaceBackupRow) {
  try {
    const stat = await fs.stat(row.artifactRef);
    if (!stat.isFile() || (row.compressedSize > 0 && stat.size !== row.compressedSize)) return false;
    return !row.archiveSha256 || await sha256File(row.artifactRef) === row.archiveSha256;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function pathExists(targetPath: string) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function walkWorkspace(
  rootPath: string,
  currentPath: string,
  warnings: string[],
  entries: WorkspaceBackupArtifactEntry[] = [],
  state: WorkspaceBackupWalkState = { byteSize: 0 },
  options: WorkspaceBackupWalkOptions = { includeFileData: true },
): Promise<WorkspaceBackupArtifactEntry[]> {
  const dirents = await fs.readdir(currentPath, { withFileTypes: true });

  for (const dirent of dirents) {
    if (isSkippedEntryName(dirent.name)) {
      const skippedPath = toPortableRelativePath(path.relative(rootPath, path.join(currentPath, dirent.name)));
      addWarning(warnings, `Skipped ${skippedPath}`);
      continue;
    }

    const absolutePath = path.join(currentPath, dirent.name);
    const relativePath = assertSafeRelativePath(toPortableRelativePath(path.relative(rootPath, absolutePath)));
    const stat = await fs.lstat(absolutePath);

    if (stat.isSymbolicLink()) {
      addWarning(warnings, `Skipped symlink ${relativePath}`);
      continue;
    }

    if (stat.isDirectory()) {
      entries.push({
        path: relativePath,
        kind: "directory",
        byteSize: 0,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode,
        sha256: null,
      });
      await walkWorkspace(rootPath, absolutePath, warnings, entries, state, options);
      continue;
    }

    if (stat.isFile()) {
      if (stat.size > MAX_BACKUP_FILE_BYTES) {
        addWarning(warnings, `Skipped oversized file ${relativePath}`);
        continue;
      }
      if (state.byteSize + stat.size > MAX_BACKUP_TOTAL_BYTES) {
        addWarning(warnings, `Skipped ${relativePath} because the backup size limit was reached`);
        continue;
      }
      const data = await fs.readFile(absolutePath);
      state.byteSize += data.byteLength;
      entries.push({
        path: relativePath,
        kind: "file",
        byteSize: data.byteLength,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode,
        sha256: sha256Buffer(data),
        ...(options.includeFileData ? { dataBase64: data.toString("base64") } : {}),
      });
      continue;
    }

    addWarning(warnings, `Skipped unsupported file ${relativePath}`);
  }

  return entries;
}

async function countBackupEligibleWorkspaceFiles(
  currentPath: string,
  stopAfter: number,
  state = { byteSize: 0, fileCount: 0 },
): Promise<number> {
  const dirents = await fs.readdir(currentPath, { withFileTypes: true });
  for (const dirent of dirents) {
    if (state.fileCount > stopAfter) break;
    if (isSkippedEntryName(dirent.name)) continue;

    const absolutePath = path.join(currentPath, dirent.name);
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      await countBackupEligibleWorkspaceFiles(absolutePath, stopAfter, state);
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_BACKUP_FILE_BYTES) continue;
    if (state.byteSize + stat.size > MAX_BACKUP_TOTAL_BYTES) continue;
    state.byteSize += stat.size;
    state.fileCount += 1;
  }
  return state.fileCount;
}

function buildManifest(input: {
  artifact: WorkspaceBackupArtifact;
  fileCount: number;
  byteSize: number;
  treeSha256: string;
  activeRunCount: number;
}) {
  return {
    version: input.artifact.version,
    orgId: input.artifact.orgId,
    instanceId: input.artifact.instanceId,
    rootPath: input.artifact.rootPath,
    createdAt: input.artifact.createdAt,
    entryCount: input.artifact.entries.length,
    fileCount: input.fileCount,
    byteSize: input.byteSize,
    treeSha256: input.treeSha256,
    activeRunCount: input.activeRunCount,
    warnings: input.artifact.warnings,
  };
}

function lastScheduledCheckAt(row: WorkspaceBackupRow) {
  const value = row.manifest?.lastScheduledCheck;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checkedAt = (value as Record<string, unknown>).checkedAt;
  if (typeof checkedAt !== "string") return null;
  const parsed = new Date(checkedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function manifestWithUnchangedCheck(row: WorkspaceBackupRow, checkedAt: Date, treeSha256: string) {
  const manifest = row.manifest && typeof row.manifest === "object" && !Array.isArray(row.manifest)
    ? row.manifest
    : {};
  return {
    ...manifest,
    lastScheduledCheck: {
      checkedAt: checkedAt.toISOString(),
      result: "unchanged",
      treeSha256,
    },
  };
}

async function restoreMissingArtifactFiles(input: {
  artifact: WorkspaceBackupArtifact;
  workspaceRoot: string;
}): Promise<{ restoredFileCount: number; skippedConflictingFiles: string[] }> {
  let restoredFileCount = 0;
  const skippedConflictingFiles: string[] = [];
  const blockedDirectoryPrefixes: string[] = [];
  const directories = input.artifact.entries.filter((entry) => entry.kind === "directory");
  const files = input.artifact.entries.filter((entry) => entry.kind === "file");

  for (const entry of directories) {
    const { resolvedTarget } = resolveWithinRoot(input.workspaceRoot, entry.path);
    const existing = await pathExists(resolvedTarget);
    if (existing && !existing.isDirectory()) {
      skippedConflictingFiles.push(entry.path);
      blockedDirectoryPrefixes.push(`${entry.path}/`);
      continue;
    }
    await fs.mkdir(resolvedTarget, { recursive: true });
  }

  for (const entry of files) {
    if (blockedDirectoryPrefixes.some((prefix) => entry.path.startsWith(prefix))) {
      skippedConflictingFiles.push(entry.path);
      continue;
    }
    const { resolvedTarget } = resolveWithinRoot(input.workspaceRoot, entry.path);
    const existing = await pathExists(resolvedTarget);
    if (existing) {
      if (!existing.isFile()) {
        skippedConflictingFiles.push(entry.path);
        continue;
      }
      if (entry.sha256) {
        const current = await fs.readFile(resolvedTarget);
        if (sha256Buffer(current) !== entry.sha256) {
          skippedConflictingFiles.push(entry.path);
        }
      }
      continue;
    }
    await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
    await fs.writeFile(resolvedTarget, Buffer.from(entry.dataBase64 ?? "", "base64"), { mode: entry.mode ?? 0o600 });
    restoredFileCount += 1;
  }

  return { restoredFileCount, skippedConflictingFiles };
}

export function workspaceBackupService(db: Db) {
  const orgs = organizationService(db);

  async function getBackupRow(orgId: string, backupId: string) {
    const [row] = await db
      .select()
      .from(workspaceBackups)
      .where(and(eq(workspaceBackups.orgId, orgId), eq(workspaceBackups.id, backupId)));
    if (!row || row.status === "deleted") throw notFound("Workspace backup not found");
    return row;
  }

  function assertReadableBackup(row: WorkspaceBackupRow) {
    if (row.status === "running") {
      throw conflict("Workspace backup is still running and cannot be browsed yet");
    }
    if (row.status === "failed") {
      throw unprocessable(row.error ? `Workspace backup failed: ${row.error}` : "Workspace backup failed");
    }
  }

  async function readArtifactPayload(row: WorkspaceBackupRow): Promise<{ raw: Buffer; artifact: WorkspaceBackupArtifact }> {
    assertReadableBackup(row);
    if (!(await fileExists(row.artifactRef))) {
      throw notFound("Workspace backup artifact not found");
    }
    const raw = await fs.readFile(row.artifactRef);
    if (row.archiveSha256 && sha256Buffer(raw) !== row.archiveSha256) {
      throw unprocessable("Workspace backup artifact checksum does not match the recorded backup metadata");
    }
    const parsed = JSON.parse(raw.toString("utf8")) as WorkspaceBackupArtifact;
    if (parsed.version !== ARTIFACT_VERSION || parsed.orgId !== row.orgId || !Array.isArray(parsed.entries)) {
      throw unprocessable("Workspace backup artifact is invalid");
    }
    for (const entry of parsed.entries) {
      assertSafeRelativePath(entry.path);
    }
    return { raw, artifact: parsed };
  }

  async function readArtifact(row: WorkspaceBackupRow): Promise<WorkspaceBackupArtifact> {
    const payload = await readArtifactPayload(row);
    return payload.artifact;
  }

  async function countActiveRuns(orgId: string) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.orgId, orgId), inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES])));
    return row?.count ?? 0;
  }

  async function failStaleRunningBackups(now: Date) {
    const cutoff = new Date(now.getTime() - WORKSPACE_BACKUP_RUNNING_TIMEOUT_MS);
    const finishedAt = now;
    const rows = await db
      .update(workspaceBackups)
      .set({
        status: "failed",
        error: "Workspace backup timed out before writing an artifact",
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(and(
        eq(workspaceBackups.status, "running"),
        or(
          lte(workspaceBackups.startedAt, cutoff),
          and(isNull(workspaceBackups.startedAt), lte(workspaceBackups.createdAt, cutoff)),
        ),
      ))
      .returning();
    return rows.map(mapBackupRow);
  }

  async function recoverSparseWorkspaceFromLatestBackup(orgId: string): Promise<SparseWorkspaceRecoveryResult> {
    const layout = await ensureOrganizationWorkspaceLayout(orgId);
    const currentFileCount = await countBackupEligibleWorkspaceFiles(
      layout.root,
      SPARSE_WORKSPACE_RECOVERY_MAX_CURRENT_FILES,
    );
    if (currentFileCount > SPARSE_WORKSPACE_RECOVERY_MAX_CURRENT_FILES) {
      return {
        orgId,
        recovered: false,
        backupId: null,
        currentFileCount,
        backupFileCount: 0,
        restoredFileCount: 0,
        skippedConflictingFiles: [],
        reason: "workspace is not sparse",
        error: null,
      };
    }

    const rows = await db
      .select()
      .from(workspaceBackups)
      .where(and(
        eq(workspaceBackups.orgId, orgId),
        or(eq(workspaceBackups.status, "succeeded"), eq(workspaceBackups.status, "restored")),
      ))
      .orderBy(desc(workspaceBackups.fileCount), desc(workspaceBackups.createdAt));
    const candidates = rows.filter((backup) =>
      backup.fileCount >= SPARSE_WORKSPACE_RECOVERY_MIN_BACKUP_FILES
      && currentFileCount <= Math.floor(backup.fileCount * SPARSE_WORKSPACE_RECOVERY_MAX_RATIO)
    );

    if (candidates.length === 0) {
      return {
        orgId,
        recovered: false,
        backupId: null,
        currentFileCount,
        backupFileCount: 0,
        restoredFileCount: 0,
        skippedConflictingFiles: [],
        reason: "no richer backup candidate",
        error: null,
      };
    }

    let lastError: string | null = null;
    for (const candidate of candidates) {
      try {
        const artifact = await readArtifact(candidate);
        const restored = await restoreMissingArtifactFiles({ artifact, workspaceRoot: layout.root });
        return {
          orgId,
          recovered: restored.restoredFileCount > 0,
          backupId: candidate.id,
          currentFileCount,
          backupFileCount: candidate.fileCount,
          restoredFileCount: restored.restoredFileCount,
          skippedConflictingFiles: restored.skippedConflictingFiles,
          reason: restored.restoredFileCount > 0 ? null : "no missing files restored",
          error: null,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      orgId,
      recovered: false,
      backupId: candidates[0]?.id ?? null,
      currentFileCount,
      backupFileCount: candidates[0]?.fileCount ?? 0,
      restoredFileCount: 0,
      skippedConflictingFiles: [],
      reason: "richer backup recovery failed",
      error: lastError,
    };
  }

  async function claimBackup(input: WorkspaceBackupCreateInput): Promise<WorkspaceBackupRow> {
    const organization = await orgs.getById(input.orgId);
    if (!organization) throw notFound("Organization not found");

    const startedAt = new Date();
    const expiresAt = addDays(startedAt, input.retentionDays ?? WORKSPACE_BACKUP_DEFAULT_RETENTION_DAYS);
    const backupId = crypto.randomUUID();
    const triggerSource = input.triggerSource ?? "manual";
    const organizationStorageKey = resolveOrganizationStorageKey(input.orgId);
    const backupDir = path.resolve(resolveDefaultBackupDir(), "workspaces", organizationStorageKey);
    const artifactRef = path.resolve(backupDir, `workspace-${organizationStorageKey}-${timestamp(startedAt)}-${backupId.slice(0, 8)}.json`);
    const [runningRow] = await db
      .insert(workspaceBackups)
      .values({
        id: backupId,
        orgId: input.orgId,
        status: "running",
        triggerSource,
        artifactProvider: "local_file",
        artifactRef,
        startedAt,
        expiresAt,
        createdByUserId: input.createdByUserId ?? null,
        restoredFromBackupId: input.restoredFromBackupId ?? null,
      })
      .returning();
    if (!runningRow) throw new Error("Workspace backup row was not created.");
    return runningRow;
  }

  async function finalizeClaimedBackup(runningRow: WorkspaceBackupRow): Promise<WorkspaceBackupSummary> {
    const backupId = runningRow.id;
    const artifactRef = runningRow.artifactRef;
    const tempArtifactRef = `${artifactRef}.tmp`;

    try {
      await fs.mkdir(path.dirname(artifactRef), { recursive: true });
      const layout = await ensureOrganizationWorkspaceLayout(runningRow.orgId);
      const warnings: string[] = [];
      const entries = await walkWorkspace(layout.root, layout.root, warnings);
      const fileCount = entries.filter((entry) => entry.kind === "file").length;
      const byteSize = entries.reduce((total, entry) => total + (entry.kind === "file" ? entry.byteSize : 0), 0);
      const treeSha256 = buildTreeHash(entries);
      const activeRunCount = await countActiveRuns(runningRow.orgId);
      const artifact: WorkspaceBackupArtifact = {
        version: ARTIFACT_VERSION,
        orgId: runningRow.orgId,
        instanceId: resolveRudderInstanceId(),
        createdAt: runningRow.startedAt?.toISOString() ?? runningRow.createdAt.toISOString(),
        rootPath: layout.root,
        entries: entries.sort(compareCanonicalPaths),
        warnings,
      };
      const manifest = buildManifest({ artifact, fileCount, byteSize, treeSha256, activeRunCount });
      const serialized = JSON.stringify(artifact, null, 2);
      const archiveSha256 = sha256Buffer(serialized);
      await fs.writeFile(tempArtifactRef, serialized, { encoding: "utf8", mode: 0o600 });
      await fs.rename(tempArtifactRef, artifactRef);
      const stat = await fs.stat(artifactRef);
      const finishedAt = new Date();
      const [row] = await db
        .update(workspaceBackups)
        .set({
          status: "succeeded",
          archiveSha256,
          treeSha256,
          fileCount,
          byteSize,
          compressedSize: stat.size,
          manifest,
          warnings,
          finishedAt,
          updatedAt: finishedAt,
        })
        .where(and(
          eq(workspaceBackups.id, backupId),
          eq(workspaceBackups.status, "running"),
        ))
        .returning();
      if (row) return mapBackupRow(row);

      const [currentRow] = await db
        .select()
        .from(workspaceBackups)
        .where(eq(workspaceBackups.id, backupId))
        .limit(1);
      if (currentRow) return mapBackupRow(currentRow);
      throw new Error("Workspace backup row was not updated.");
    } catch (error) {
      await fs.rm(tempArtifactRef, { force: true }).catch(() => undefined);
      const finishedAt = new Date();
      const [row] = await db
        .update(workspaceBackups)
        .set({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          finishedAt,
          updatedAt: finishedAt,
        })
        .where(and(
          eq(workspaceBackups.id, backupId),
          eq(workspaceBackups.status, "running"),
        ))
        .returning();
      if (row) return mapBackupRow(row);

      const [currentRow] = await db
        .select()
        .from(workspaceBackups)
        .where(eq(workspaceBackups.id, backupId))
        .limit(1);
      if (currentRow) return mapBackupRow(currentRow);
      return mapBackupRow(runningRow);
    }
  }

  const service = {
    recoverSparseWorkspaceFromLatestBackup,
    claimBackup,
    finalizeClaimedBackup,

    async list(orgId: string): Promise<WorkspaceBackupSummary[]> {
      const organization = await orgs.getById(orgId);
      if (!organization) throw notFound("Organization not found");
      const rows = await db
        .select()
        .from(workspaceBackups)
        .where(and(eq(workspaceBackups.orgId, orgId), sql`${workspaceBackups.status} <> 'deleted'`))
        .orderBy(desc(workspaceBackups.createdAt));
      return rows.map(mapBackupRow);
    },

    async create(input: WorkspaceBackupCreateInput): Promise<WorkspaceBackupSummary> {
      const runningRow = await claimBackup(input);
      return await finalizeClaimedBackup(runningRow);
    },

    async listFiles(orgId: string, backupId: string, directoryPath = ""): Promise<OrganizationWorkspaceFileList> {
      const row = await getBackupRow(orgId, backupId);
      const artifact = await readArtifact(row);
      const normalizedPath = assertSafeRelativePath(directoryPath);
      const entries = directChildrenFromArtifact(artifact, normalizedPath);
      return {
        source: "org_root",
        rootPath: `backup:${backupId}`,
        repoUrl: null,
        directoryPath: normalizedPath,
        rootExists: true,
        entries,
        message: entries.length === 0 ? "This backup folder is empty." : null,
      };
    },

    async readFile(orgId: string, backupId: string, filePath: string): Promise<OrganizationWorkspaceFileDetail> {
      const row = await getBackupRow(orgId, backupId);
      const artifact = await readArtifact(row);
      const normalizedPath = assertSafeRelativePath(filePath);
      const file = findArtifactFile(artifact, normalizedPath);
      if (!file?.dataBase64) throw notFound("File not found inside the workspace backup");
      const buffer = Buffer.from(file.dataBase64, "base64");
      if (isBinaryBuffer(buffer)) {
        return {
          source: "org_root",
          rootPath: `backup:${backupId}`,
          repoUrl: null,
          filePath: normalizedPath,
          libraryEntryId: null,
          mentionHref: null,
          markdownLink: null,
          rootExists: true,
          content: null,
          contentType: "application/octet-stream",
          previewKind: "binary",
          contentPath: null,
          message: "Binary files are not previewed in workspace backups.",
          truncated: false,
        };
      }
      const truncated = buffer.byteLength > MAX_PREVIEW_BYTES;
      return {
        source: "org_root",
        rootPath: `backup:${backupId}`,
        repoUrl: null,
        filePath: normalizedPath,
        libraryEntryId: null,
        mentionHref: null,
        markdownLink: null,
        rootExists: true,
        content: buffer.subarray(0, MAX_PREVIEW_BYTES).toString("utf8"),
        contentType: "text/plain",
        previewKind: "text",
        contentPath: null,
        message: truncated ? "Preview truncated to the first 200 KB." : null,
        truncated,
      };
    },

    async getDownload(orgId: string, backupId: string): Promise<WorkspaceBackupDownload> {
      const row = await getBackupRow(orgId, backupId);
      const payload = await readArtifactPayload(row);
      const zip = buildWorkspaceBackupZip(payload.artifact, backupDownloadRootFolderName(payload.artifact));
      return {
        artifactRef: row.artifactRef,
        filename: `${path.basename(row.artifactRef, ".json")}.zip`,
        contentType: "application/zip",
        byteSize: zip.byteLength,
        archiveSha256: sha256Buffer(zip),
        content: zip,
      };
    },

    async remove(orgId: string, backupId: string): Promise<WorkspaceBackupSummary> {
      const row = await getBackupRow(orgId, backupId);
      await fs.rm(row.artifactRef, { force: true });
      const updatedAt = new Date();
      const [updated] = await db
        .update(workspaceBackups)
        .set({ status: "deleted", updatedAt })
        .where(eq(workspaceBackups.id, backupId))
        .returning();
      if (!updated) throw notFound("Workspace backup not found");
      return mapBackupRow(updated);
    },

    async pruneExpired(now = new Date()): Promise<WorkspaceBackupSummary[]> {
      const legacyCutoff = new Date(now.getTime() - WORKSPACE_BACKUP_DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const rows = await db
        .select()
        .from(workspaceBackups)
        .where(and(
          ne(workspaceBackups.status, "deleted"),
          ne(workspaceBackups.status, "running"),
          or(
            and(isNotNull(workspaceBackups.expiresAt), lte(workspaceBackups.expiresAt, now)),
            and(isNull(workspaceBackups.expiresAt), lte(workspaceBackups.createdAt, legacyCutoff)),
          ),
        ));

      const deleted: WorkspaceBackupSummary[] = [];
      for (const row of rows) {
        deleted.push(await service.remove(row.orgId, row.id));
      }
      return deleted;
    },

    async runScheduledBackups(input?: {
      now?: Date;
      intervalMs?: number;
      retentionDays?: number;
    }): Promise<{
      created: WorkspaceBackupSummary[];
      failed: WorkspaceBackupSummary[];
      deleted: WorkspaceBackupSummary[];
      sparseRecoveries: SparseWorkspaceRecoveryResult[];
      skipped: number;
      skippedDetails: WorkspaceBackupScheduleSkip[];
      errors: Array<{ orgId: string; message: string }>;
    }> {
      const now = input?.now ?? new Date();
      const intervalMs = Math.max(60_000, Math.trunc(input?.intervalMs ?? WORKSPACE_BACKUP_DEFAULT_INTERVAL_MS));
      const dueBefore = new Date(now.getTime() - intervalMs);
      const deleted = await service.pruneExpired(now);
      const staleFailed = await failStaleRunningBackups(now);
      const organizations = (await orgs.list()).filter((organization) => organization.status === "active");
      const created: WorkspaceBackupSummary[] = [];
      const failed: WorkspaceBackupSummary[] = [...staleFailed];
      const errors: Array<{ orgId: string; message: string }> = [];
      const sparseRecoveries: SparseWorkspaceRecoveryResult[] = [];
      const skippedDetails: WorkspaceBackupScheduleSkip[] = [];

      for (const organization of organizations) {
        try {
          const outcome = await db.transaction(async (tx) => {
            await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`workspace-backup-scheduled:${organization.id}`}))`);
            const lockedService = workspaceBackupService(tx as unknown as Db);

            const [running] = await tx
              .select()
              .from(workspaceBackups)
              .where(and(
                eq(workspaceBackups.orgId, organization.id),
                eq(workspaceBackups.status, "running"),
              ))
              .orderBy(desc(workspaceBackups.createdAt))
              .limit(1);
            if (running) {
              return {
                kind: "skipped" as const,
                detail: {
                  orgId: organization.id,
                  reason: "running" as const,
                  comparedBackupId: running.id,
                  treeSha256: running.treeSha256,
                },
                sparseRecovery: null,
              };
            }

            const [latestSuccessful] = await tx
              .select()
              .from(workspaceBackups)
              .where(and(
                eq(workspaceBackups.orgId, organization.id),
                inArray(workspaceBackups.status, ["succeeded", "restored"]),
              ))
              .orderBy(desc(workspaceBackups.createdAt))
              .limit(1);
            const unchangedCheckAt = latestSuccessful ? lastScheduledCheckAt(latestSuccessful) : null;
            const latestCheckAt = latestSuccessful
              ? new Date(Math.max(latestSuccessful.createdAt.getTime(), unchangedCheckAt?.getTime() ?? 0))
              : null;
            if (latestSuccessful && latestCheckAt && latestCheckAt > dueBefore) {
              return {
                kind: "skipped" as const,
                detail: {
                  orgId: organization.id,
                  reason: "not_due" as const,
                  comparedBackupId: latestSuccessful.id,
                  treeSha256: latestSuccessful.treeSha256,
                },
                sparseRecovery: null,
              };
            }

            const sparseRecovery = await lockedService.recoverSparseWorkspaceFromLatestBackup(organization.id);
            if (sparseRecovery.error) {
              return {
                kind: "error" as const,
                message: `Sparse workspace recovery failed before scheduled backup: ${sparseRecovery.error}`,
                sparseRecovery,
              };
            }

            if (
              latestSuccessful?.treeSha256
              && await backupArtifactLooksUsable(latestSuccessful)
            ) {
              try {
                const layout = await ensureOrganizationWorkspaceLayout(organization.id);
                const warnings: string[] = [];
                const entries = await walkWorkspace(
                  layout.root,
                  layout.root,
                  warnings,
                  [],
                  { byteSize: 0 },
                  { includeFileData: false },
                );
                const treeSha256 = buildTreeHash(entries);
                if (treeSha256 === latestSuccessful.treeSha256) {
                  await tx
                    .update(workspaceBackups)
                    .set({
                      manifest: manifestWithUnchangedCheck(latestSuccessful, now, treeSha256),
                      updatedAt: now,
                    })
                    .where(eq(workspaceBackups.id, latestSuccessful.id));
                  return {
                    kind: "skipped" as const,
                    detail: {
                      orgId: organization.id,
                      reason: "unchanged" as const,
                      comparedBackupId: latestSuccessful.id,
                      treeSha256,
                    },
                    sparseRecovery,
                  };
                }
              } catch {
                // Preserve the existing failed-backup row behavior by letting create() retry the full snapshot.
              }
            }

            const backup = await lockedService.claimBackup({
              orgId: organization.id,
              triggerSource: "scheduled",
              retentionDays: input?.retentionDays,
            });
            return {
              kind: "claimed" as const,
              backup,
              sparseRecovery,
            };
          });

          if (outcome.sparseRecovery && (outcome.sparseRecovery.recovered || outcome.sparseRecovery.error)) {
            sparseRecoveries.push(outcome.sparseRecovery);
          }
          if (outcome.kind === "skipped") skippedDetails.push(outcome.detail);
          else if (outcome.kind === "claimed") {
            const backup = await service.finalizeClaimedBackup(outcome.backup);
            if (backup.status === "failed") failed.push(backup);
            else created.push(backup);
          }
          else if (outcome.kind === "error") errors.push({ orgId: organization.id, message: outcome.message });
        } catch (error) {
          errors.push({
            orgId: organization.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        created,
        failed,
        deleted,
        sparseRecoveries,
        skipped: skippedDetails.length,
        skippedDetails,
        errors,
      };
    },

    async restore(orgId: string, backupId: string, input?: { createdByUserId?: string | null }): Promise<WorkspaceBackupRestoreResult> {
      const row = await getBackupRow(orgId, backupId);
      const activeRunCount = await countActiveRuns(orgId);
      if (activeRunCount > 0) {
        throw conflict("Workspace restore is blocked while this organization has active runs.", { activeRunCount });
      }

      const artifact = await readArtifact(row);
      const preRestoreBackup = await service.create({
        orgId,
        triggerSource: "pre_restore",
        createdByUserId: input?.createdByUserId ?? null,
        restoredFromBackupId: backupId,
      });
      if (preRestoreBackup.status !== "succeeded") {
        throw conflict("Pre-restore backup failed; workspace was not changed.", { backupId: preRestoreBackup.id });
      }
      const activeRunCountAfterPreRestore = await countActiveRuns(orgId);
      if (activeRunCountAfterPreRestore > 0) {
        throw conflict("Workspace restore is blocked while this organization has active runs.", {
          activeRunCount: activeRunCountAfterPreRestore,
          preRestoreBackupId: preRestoreBackup.id,
        });
      }

      const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
      const stagingRoot = path.resolve(resolveDefaultBackupDir(), "workspace-restore-staging", `${orgId}-${backupId}-${Date.now()}`);
      await fs.rm(stagingRoot, { recursive: true, force: true });
      await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });

      try {
        const directories = artifact.entries.filter((entry) => entry.kind === "directory");
        const files = artifact.entries.filter((entry) => entry.kind === "file");
        for (const entry of directories) {
          const { resolvedTarget } = resolveWithinRoot(stagingRoot, entry.path);
          await fs.mkdir(resolvedTarget, { recursive: true });
        }
        for (const entry of files) {
          const { resolvedTarget } = resolveWithinRoot(stagingRoot, entry.path);
          await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
          await fs.writeFile(resolvedTarget, Buffer.from(entry.dataBase64 ?? "", "base64"), { mode: entry.mode ?? 0o600 });
        }

        await fs.rm(workspaceRoot, { recursive: true, force: true });
        await fs.mkdir(path.dirname(workspaceRoot), { recursive: true });
        await fs.rename(stagingRoot, workspaceRoot);
        await ensureOrganizationWorkspaceLayout(orgId);
      } finally {
        await fs.rm(stagingRoot, { recursive: true, force: true });
      }

      const updatedAt = new Date();
      const [restoredRow] = await db
        .update(workspaceBackups)
        .set({ status: "restored", updatedAt })
        .where(eq(workspaceBackups.id, backupId))
        .returning();
      if (!restoredRow) throw notFound("Workspace backup not found");

      return {
        restoredBackup: mapBackupRow(restoredRow),
        preRestoreBackup,
      };
    },
  };

  return service;
}
