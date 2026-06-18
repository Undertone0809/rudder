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
  ".turbo",
  ".vite",
  "Library",
  "node_modules",
]);
const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const WORKSPACE_BACKUP_DEFAULT_INTERVAL_MS = WORKSPACE_BACKUP_DEFAULT_INTERVAL_HOURS * 60 * 60 * 1000;
const WORKSPACE_BACKUP_RUNNING_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_BACKUP_FILE_BYTES = 5 * 1024 * 1024;
const MAX_BACKUP_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_WARNING_COUNT = 200;

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

function timestamp(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function addDays(date: Date, days: number) {
  const normalizedDays = Math.max(1, Math.trunc(days));
  return new Date(date.getTime() + normalizedDays * 24 * 60 * 60 * 1000);
}

function sha256Buffer(buffer: Buffer | string) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
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
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
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

async function walkWorkspace(
  rootPath: string,
  currentPath: string,
  warnings: string[],
  entries: WorkspaceBackupArtifactEntry[] = [],
  state: WorkspaceBackupWalkState = { byteSize: 0 },
): Promise<WorkspaceBackupArtifactEntry[]> {
  const dirents = await fs.readdir(currentPath, { withFileTypes: true });

  for (const dirent of dirents) {
    if (SKIPPED_ENTRY_NAMES.has(dirent.name)) {
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
      await walkWorkspace(rootPath, absolutePath, warnings, entries, state);
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
        dataBase64: data.toString("base64"),
      });
      continue;
    }

    addWarning(warnings, `Skipped unsupported file ${relativePath}`);
  }

  return entries;
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

  async function readArtifact(row: WorkspaceBackupRow): Promise<WorkspaceBackupArtifact> {
    assertReadableBackup(row);
    if (!(await fileExists(row.artifactRef))) {
      throw notFound("Workspace backup artifact not found");
    }
    const raw = await fs.readFile(row.artifactRef, "utf8");
    if (row.archiveSha256 && sha256Buffer(raw) !== row.archiveSha256) {
      throw unprocessable("Workspace backup artifact checksum does not match the recorded backup metadata");
    }
    const parsed = JSON.parse(raw) as WorkspaceBackupArtifact;
    if (parsed.version !== ARTIFACT_VERSION || parsed.orgId !== row.orgId || !Array.isArray(parsed.entries)) {
      throw unprocessable("Workspace backup artifact is invalid");
    }
    for (const entry of parsed.entries) {
      assertSafeRelativePath(entry.path);
    }
    return parsed;
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

  const service = {
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

    async create(input: {
      orgId: string;
      triggerSource?: WorkspaceBackupTriggerSource;
      createdByUserId?: string | null;
      restoredFromBackupId?: string | null;
      retentionDays?: number;
    }): Promise<WorkspaceBackupSummary> {
      const organization = await orgs.getById(input.orgId);
      if (!organization) throw notFound("Organization not found");

      const startedAt = new Date();
      const expiresAt = addDays(startedAt, input.retentionDays ?? WORKSPACE_BACKUP_DEFAULT_RETENTION_DAYS);
      const backupId = crypto.randomUUID();
      const triggerSource = input.triggerSource ?? "manual";
      const organizationStorageKey = resolveOrganizationStorageKey(input.orgId);
      const backupDir = path.resolve(resolveDefaultBackupDir(), "workspaces", organizationStorageKey);
      const artifactRef = path.resolve(backupDir, `workspace-${organizationStorageKey}-${timestamp(startedAt)}-${backupId.slice(0, 8)}.json`);

      await fs.mkdir(backupDir, { recursive: true });
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

      try {
        const layout = await ensureOrganizationWorkspaceLayout(input.orgId);
        const warnings: string[] = [];
        const entries = await walkWorkspace(layout.root, layout.root, warnings);
        const fileCount = entries.filter((entry) => entry.kind === "file").length;
        const byteSize = entries.reduce((total, entry) => total + (entry.kind === "file" ? entry.byteSize : 0), 0);
        const treeSha256 = buildTreeHash(entries);
        const activeRunCount = await countActiveRuns(input.orgId);
        const artifact: WorkspaceBackupArtifact = {
          version: ARTIFACT_VERSION,
          orgId: input.orgId,
          instanceId: resolveRudderInstanceId(),
          createdAt: startedAt.toISOString(),
          rootPath: layout.root,
          entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
          warnings,
        };
        const manifest = buildManifest({ artifact, fileCount, byteSize, treeSha256, activeRunCount });
        const serialized = JSON.stringify(artifact, null, 2);
        const archiveSha256 = sha256Buffer(serialized);
        const tempArtifactRef = `${artifactRef}.tmp`;
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
          .where(eq(workspaceBackups.id, backupId))
          .returning();
        if (!row) throw new Error("Workspace backup row was not updated.");
        return mapBackupRow(row);
      } catch (error) {
        const finishedAt = new Date();
        const [row] = await db
          .update(workspaceBackups)
          .set({
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            finishedAt,
            updatedAt: finishedAt,
          })
          .where(eq(workspaceBackups.id, backupId))
          .returning();
        if (row) return mapBackupRow(row);
        if (!runningRow) throw new Error("Workspace backup row was not created.");
        return mapBackupRow(runningRow);
      }
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
      skipped: number;
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
      let skipped = 0;

      for (const organization of organizations) {
        try {
          const [latest] = await db
            .select()
            .from(workspaceBackups)
            .where(and(eq(workspaceBackups.orgId, organization.id), ne(workspaceBackups.status, "deleted")))
            .orderBy(desc(workspaceBackups.createdAt))
            .limit(1);

          if (latest?.status === "running" || (latest && latest.createdAt > dueBefore)) {
            skipped += 1;
            continue;
          }

          const backup = await service.create({
            orgId: organization.id,
            triggerSource: "scheduled",
            retentionDays: input?.retentionDays,
          });
          if (backup.status === "failed") failed.push(backup);
          else created.push(backup);
        } catch (error) {
          errors.push({
            orgId: organization.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return { created, failed, deleted, skipped, errors };
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
