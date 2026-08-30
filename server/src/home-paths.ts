import {
  assertUniqueOrganizationStorageKeys,
  normalizeOrganizationStoragePathSegment,
  resolveOrganizationLegacyStorageKey,
  resolveOrganizationStorageKey,
} from "@rudderhq/agent-runtime-utils";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AgentWorkspaceLocator, resolveStoredOrDerivedAgentWorkspaceKey } from "./agent-workspace-key.js";

const DEFAULT_INSTANCE_ID = "default";
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const FRIENDLY_PATH_SEGMENT_RE = /[^a-zA-Z0-9._-]+/g;
const FILE_COMPARE_CHUNK_BYTES = 64 * 1024;
const EXECUTABLE_MODE_BITS = 0o111;
const MIGRATION_BACKUP_DIR_NAME = ".rudder-migration-backups";
const WORKSPACE_PERMISSION_ERROR_CODES = new Set(["EACCES", "EPERM", "EROFS"]);
const ORGANIZATION_WORKSPACE_MAP_FILE = ".rudder-organizations.json";
const ORGANIZATION_WORKSPACE_MAP_LOCK = ".rudder-organizations.lock";
const ORGANIZATION_WORKSPACE_MAP_LOCK_OWNER_PREFIX = ".rudder-lock-owner-";
const ORGANIZATION_WORKSPACE_MAP_LOCK_KIND = "rudder-organization-workspace-map-lock";
const ORGANIZATION_WORKSPACE_MAP_RECLAIM_FILE = ".rudder-lock-reclaim.json";
const ORGANIZATION_WORKSPACE_IDENTITY_FILE = ".rudder-workspace.json";
const ORGANIZATION_WORKSPACE_MIGRATION_FILE = ".rudder-workspace-migrations.json";
const ORGANIZATION_WORKSPACE_MAP_LOCK_TIMEOUT_MS = 10_000;
const ORGANIZATION_WORKSPACE_MAP_STALE_LOCK_MS = 60_000;
const RESERVED_ORGANIZATION_WORKSPACE_NAMES = new Set([
  ORGANIZATION_WORKSPACE_MAP_FILE,
  ORGANIZATION_WORKSPACE_MAP_LOCK,
  MIGRATION_BACKUP_DIR_NAME,
  ".rudder",
  "backups",
  "data",
  "instances",
  "runtimes",
]);
let organizationWorkspaceMapUpdateQueue: Promise<unknown> = Promise.resolve();

type OrganizationWorkspaceLocator = {
  id: string;
  name?: string | null;
  urlKey?: string | null;
};

type OrganizationWorkspaceMapRecord = {
  instanceId: string;
  orgId: string;
  folderName: string;
  orgName?: string | null;
  createdAt: string;
  updatedAt: string;
};

type OrganizationWorkspaceMappingState = {
  record: OrganizationWorkspaceMapRecord;
  created: boolean;
};

type OrganizationWorkspaceMapFile = {
  version: 1;
  organizations: OrganizationWorkspaceMapRecord[];
};

type OrganizationWorkspaceMapFileState = {
  map: OrganizationWorkspaceMapFile;
  exists: boolean;
};

type OrganizationWorkspacePermissionFailure = {
  orgId: string;
  code: string | null;
  message: string;
};

type OrganizationWorkspaceMapLockOwner = {
  kind: typeof ORGANIZATION_WORKSPACE_MAP_LOCK_KIND;
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
};

type OrganizationWorkspaceMigrationFile = {
  version: 1;
  compatibilityAliases: string[];
};

function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export function resolveRudderHomeDir(): string {
  const envHome = process.env.RUDDER_HOME?.trim();
  if (envHome) return path.resolve(expandHomePrefix(envHome));
  return path.resolve(os.homedir(), ".rudder");
}

export function resolveRudderInstanceId(): string {
  const raw = process.env.RUDDER_INSTANCE_ID?.trim() || DEFAULT_INSTANCE_ID;
  if (!INSTANCE_ID_RE.test(raw)) {
    throw new Error(`Invalid RUDDER_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolveRudderInstanceRoot(): string {
  return path.resolve(resolveRudderHomeDir(), "instances", resolveRudderInstanceId());
}

export function resolveDefaultConfigPath(): string {
  return path.resolve(resolveRudderInstanceRoot(), "config.json");
}

export function resolveDefaultEmbeddedPostgresDir(): string {
  return path.resolve(resolveRudderInstanceRoot(), "db");
}

export function resolveDefaultLogsDir(): string {
  return path.resolve(resolveRudderInstanceRoot(), "logs");
}

export function resolveDefaultSecretsKeyFilePath(): string {
  return path.resolve(resolveRudderInstanceRoot(), "secrets", "master.key");
}

export function resolveDefaultStorageDir(): string {
  return path.resolve(resolveRudderInstanceRoot(), "data", "storage");
}

export function resolveDefaultBackupDir(): string {
  return path.resolve(resolveRudderInstanceRoot(), "data", "backups");
}

export function resolveOrganizationRoot(orgId: string): string {
  const normalizedOrgId = resolveOrganizationStorageKey(orgId);
  return path.resolve(
    resolveRudderInstanceRoot(),
    "organizations",
    normalizedOrgId,
  );
}

export function resolveLegacyOrganizationRoot(orgId: string): string {
  const legacyOrgId = resolveOrganizationLegacyStorageKey(orgId);
  return path.resolve(
    resolveRudderInstanceRoot(),
    "organizations",
    legacyOrgId,
  );
}

function validatePathSegment(value: string, label: string): string {
  return normalizeOrganizationStoragePathSegment(value, label);
}

function resolveAgentWorkspacePathSegment(agent: string | AgentWorkspaceLocator): string {
  if (typeof agent === "string") {
    return validatePathSegment(agent, "agent workspace key");
  }
  return validatePathSegment(resolveStoredOrDerivedAgentWorkspaceKey(agent), "agent workspace key");
}

export function resolveOrganizationWorkspaceRoot(orgId: string): string {
  const normalizedOrgId = resolveOrganizationStorageKey(orgId);
  if (usesFriendlyOrganizationWorkspaceHome()) {
    return path.resolve(
      resolveOrganizationWorkspaceHomeDir(),
      readOrganizationWorkspaceFolderName(orgId) ?? normalizedOrgId,
    );
  }
  return path.resolve(
    resolveOrganizationWorkspaceHomeDir(),
    normalizedOrgId,
    "workspaces",
  );
}

export function resolveLegacyOrganizationWorkspaceRoot(orgId: string): string {
  return path.resolve(resolveOrganizationRoot(orgId), "workspaces");
}

export function resolvePreviousDocumentsOrganizationWorkspaceRoot(orgId: string): string {
  const baseDir = process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME?.trim()
    ? resolveOrganizationWorkspaceHomeDir()
    : path.resolve(os.homedir(), "Documents", "Rudder");
  return path.resolve(
    baseDir,
    "instances",
    resolveRudderInstanceId(),
    "organizations",
    resolveOrganizationStorageKey(orgId),
    "workspaces",
  );
}

export function resolveOrganizationWorkspaceHomeDir(): string {
  const envHome = process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME?.trim();
  if (envHome) return path.resolve(expandHomePrefix(envHome));

  if (process.env.RUDDER_HOME?.trim()) {
    return path.resolve(resolveRudderInstanceRoot(), "organizations");
  }

  return path.resolve(os.homedir(), "Documents", "Rudder");
}

function usesFriendlyOrganizationWorkspaceHome(): boolean {
  return Boolean(process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME?.trim()) || !process.env.RUDDER_HOME?.trim();
}

export function resolveOrganizationWorkspaceMapPath(): string {
  return path.resolve(resolveOrganizationWorkspaceHomeDir(), ORGANIZATION_WORKSPACE_MAP_FILE);
}

export function resolveDefaultAgentWorkspaceDir(orgId: string, agent: string | AgentWorkspaceLocator): string {
  const normalizedWorkspaceKey = resolveAgentWorkspacePathSegment(agent);
  return path.resolve(resolveOrganizationWorkspaceRoot(orgId), "agents", normalizedWorkspaceKey);
}

export function resolveAgentInstructionsDir(orgId: string, agent: string | AgentWorkspaceLocator): string {
  return path.resolve(resolveDefaultAgentWorkspaceDir(orgId, agent), "instructions");
}

export function resolveAgentMemoryDir(orgId: string, agent: string | AgentWorkspaceLocator): string {
  return path.resolve(resolveDefaultAgentWorkspaceDir(orgId, agent), "memory");
}

export function resolveAgentLifeDir(orgId: string, agent: string | AgentWorkspaceLocator): string {
  return path.resolve(resolveDefaultAgentWorkspaceDir(orgId, agent), "life");
}

export function resolveAgentSkillsDir(orgId: string, agent: string | AgentWorkspaceLocator): string {
  return path.resolve(resolveDefaultAgentWorkspaceDir(orgId, agent), "skills");
}

export function resolveOrganizationSkillsDir(orgId: string): string {
  return path.resolve(resolveOrganizationWorkspaceRoot(orgId), "skills");
}

export function resolveOrganizationAgentsDir(orgId: string): string {
  return path.resolve(resolveOrganizationWorkspaceRoot(orgId), "agents");
}

export function resolveOrganizationProjectsDir(orgId: string): string {
  return path.resolve(resolveOrganizationWorkspaceRoot(orgId), "projects");
}

function deriveProjectLibraryKey(input: {
  projectId: string;
  projectName?: string | null;
  projectUrlKey?: string | null;
}): string {
  const explicitKey = sanitizeFriendlyPathSegment(input.projectUrlKey, "").toLowerCase();
  if (explicitKey) return explicitKey;

  const nameKey = sanitizeFriendlyPathSegment(input.projectName, "").toLowerCase();
  if (nameKey) return nameKey;

  return validatePathSegment(input.projectId, "project id");
}

export function resolveProjectLibraryRelativePath(input: {
  projectId: string;
  projectName?: string | null;
  projectUrlKey?: string | null;
}): string {
  return path.join("projects", deriveProjectLibraryKey(input));
}

export function resolveProjectLibraryDir(input: {
  orgId: string;
  projectId: string;
  projectName?: string | null;
  projectUrlKey?: string | null;
}): string {
  return path.resolve(resolveOrganizationWorkspaceRoot(input.orgId), resolveProjectLibraryRelativePath(input));
}

export function resolveManagedOrganizationCodebaseDir(input: {
  orgId: string;
  repoName?: string | null;
}): string {
  return path.resolve(
    resolveOrganizationWorkspaceRoot(input.orgId),
    "codebase",
    sanitizeFriendlyPathSegment(input.repoName, "_default"),
  );
}

export async function ensureOrganizationWorkspaceLayout(org: string | OrganizationWorkspaceLocator): Promise<{
  root: string;
  agentsDir: string;
  skillsDir: string;
  projectsDir: string;
}> {
  const orgId = typeof org === "string" ? org : org.id;
  await migrateOrganizationStorageRoot(orgId);
  let mappingState: OrganizationWorkspaceMappingState | null = null;
  if (typeof org !== "string") {
    mappingState = await ensureOrganizationWorkspaceMapping(org);
  } else if (usesFriendlyOrganizationWorkspaceHome()) {
    const map = await readOrganizationWorkspaceMapFile();
    const existing = findOrganizationWorkspaceMapRecord(map, orgId);
    if (existing) {
      mappingState = { record: existing, created: false };
    }
  }
  await migrateOrganizationWorkspaceRoot(orgId, {
    failIfMappedFolderMissing: Boolean(mappingState && !mappingState.created),
  });

  const root = resolveOrganizationWorkspaceRoot(orgId);
  const agentsDir = resolveOrganizationAgentsDir(orgId);
  const skillsDir = resolveOrganizationSkillsDir(orgId);
  const projectsDir = resolveOrganizationProjectsDir(orgId);
  try {
    await Promise.all([
      fs.mkdir(root, { recursive: true }),
      fs.mkdir(agentsDir, { recursive: true }),
      fs.mkdir(skillsDir, { recursive: true }),
      fs.mkdir(projectsDir, { recursive: true }),
    ]);
    await ensureOrganizationWorkspaceIdentity(root, orgId);
  } catch (error) {
    if (isPermissionError(error)) {
      throw new Error(formatOrganizationWorkspacePermissionMessage({
        operation: "create",
        code: errorCode(error),
        legacyRootPath: resolveLegacyOrganizationWorkspaceRoot(orgId),
        canonicalRootPath: root,
      }), { cause: error });
    }
    throw error;
  }
  return { root, agentsDir, skillsDir, projectsDir };
}

async function ensureOrganizationWorkspaceMapping(org: OrganizationWorkspaceLocator): Promise<OrganizationWorkspaceMappingState | null> {
  if (!usesFriendlyOrganizationWorkspaceHome()) return null;
  return await updateOrganizationWorkspaceMap(async () => {
    const orgId = validatePathSegment(org.id, "org id");
    const homeDir = resolveOrganizationWorkspaceHomeDir();
    const mapPath = resolveOrganizationWorkspaceMapPath();
    await fs.mkdir(homeDir, { recursive: true });

    const now = new Date().toISOString();
    const mapState = await readOrganizationWorkspaceMapFileState();
    const map = mapState.map;
    const existing = findOrganizationWorkspaceMapRecord(map, orgId);
    if (existing) {
      existing.orgName = org.name ?? existing.orgName ?? null;
      existing.updatedAt = now;
      await writeOrganizationWorkspaceMapFile(mapPath, map);
      return { record: existing, created: false };
    }

    const folderName = await allocateOrganizationWorkspaceFolderName({
      homeDir,
      map,
      orgId,
      orgName: org.name,
      orgUrlKey: org.urlKey,
      allowExistingBaseDirectory: !mapState.exists,
    });
    const record: OrganizationWorkspaceMapRecord = {
      instanceId: resolveRudderInstanceId(),
      orgId,
      folderName,
      orgName: org.name ?? null,
      createdAt: now,
      updatedAt: now,
    };
    map.organizations.push(record);
    await writeOrganizationWorkspaceMapFile(mapPath, map);
    return { record, created: true };
  });
}

async function updateOrganizationWorkspaceMap<T>(fn: () => Promise<T>): Promise<T> {
  const previous = organizationWorkspaceMapUpdateQueue.catch(() => {});
  const current = previous.then(
    () => withOrganizationWorkspaceMapLock(fn),
    () => withOrganizationWorkspaceMapLock(fn),
  );
  organizationWorkspaceMapUpdateQueue = current.catch(() => {});
  return await current;
}

async function withOrganizationWorkspaceMapLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockPath = path.resolve(resolveOrganizationWorkspaceHomeDir(), ORGANIZATION_WORKSPACE_MAP_LOCK);
  const startedAt = Date.now();
  const token = randomUUID();
  const ownerFileName = `${ORGANIZATION_WORKSPACE_MAP_LOCK_OWNER_PREFIX}${token}.json`;
  const ownerPath = path.join(lockPath, ownerFileName);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      const owner: OrganizationWorkspaceMapLockOwner = {
        kind: ORGANIZATION_WORKSPACE_MAP_LOCK_KIND,
        version: 1,
        token,
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      };
      const handle = await fs.open(ownerPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(lockPath);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        await fs.rmdir(lockPath).catch(() => {});
        throw error;
      }
      const existingOwner = await readOrganizationWorkspaceMapLockOwner(lockPath);
      if (!existingOwner) {
        const entries = await fs.readdir(lockPath).catch(() => []);
        if (entries.length === 0 && Date.now() - startedAt < ORGANIZATION_WORKSPACE_MAP_LOCK_TIMEOUT_MS) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          continue;
        }
        throw organizationWorkspaceMapLockCollision(lockPath);
      }
      const ownerAgeMs = Date.now() - Date.parse(existingOwner.createdAt);
      if (
        existingOwner.hostname === os.hostname()
        && ownerAgeMs > ORGANIZATION_WORKSPACE_MAP_STALE_LOCK_MS
        && !isProcessAlive(existingOwner.pid)
      ) {
        await reclaimStaleOrganizationWorkspaceMapLock(lockPath, existingOwner);
        continue;
      }
      if (Date.now() - startedAt >= ORGANIZATION_WORKSPACE_MAP_LOCK_TIMEOUT_MS) {
        throw Object.assign(new Error(
          `Timed out waiting for the organization workspace mapping lock at ${lockPath}.`,
        ), { code: "RUDDER_WORKSPACE_MAP_LOCK_TIMEOUT" });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await fn();
  } finally {
    await releaseOrganizationWorkspaceMapLock(lockPath, token);
  }
}

function organizationWorkspaceMapLockCollision(lockPath: string): Error {
  return Object.assign(new Error(
    `Refusing to replace the unrecognized organization workspace mapping lock path at ${lockPath}. `
      + "Rename or restore that directory before starting Rudder.",
  ), { code: "RUDDER_WORKSPACE_MAP_LOCK_COLLISION" });
}

async function reclaimStaleOrganizationWorkspaceMapLock(
  lockPath: string,
  observedOwner: OrganizationWorkspaceMapLockOwner,
): Promise<void> {
  const reclaimPath = path.join(lockPath, ORGANIZATION_WORKSPACE_MAP_RECLAIM_FILE);
  let reclaimHandle: Awaited<ReturnType<typeof fs.open>>;
  try {
    reclaimHandle = await fs.open(reclaimPath, "wx", 0o600);
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes(errorCode(error) ?? "")) return;
    throw error;
  }
  try {
    await reclaimHandle.writeFile(`${JSON.stringify({ token: observedOwner.token })}\n`, "utf8");
    await reclaimHandle.sync();
  } finally {
    await reclaimHandle.close();
  }

  const currentOwner = await readOrganizationWorkspaceMapLockOwner(lockPath);
  const stillStale = currentOwner?.token === observedOwner.token
    && currentOwner.hostname === os.hostname()
    && Date.now() - Date.parse(currentOwner.createdAt) > ORGANIZATION_WORKSPACE_MAP_STALE_LOCK_MS
    && !isProcessAlive(currentOwner.pid);
  if (!stillStale) {
    await fs.rm(reclaimPath, { force: true });
    return;
  }

  const tombstonePath = `${lockPath}.reclaimed-${observedOwner.token}-${randomUUID()}`;
  try {
    await fs.rename(lockPath, tombstonePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return;
  }
  // Only the positively identified directory captured by the atomic rename is removed.
  await fs.rm(tombstonePath, { recursive: true, force: true });
}

async function releaseOrganizationWorkspaceMapLock(lockPath: string, token: string): Promise<void> {
  const currentOwner = await readOrganizationWorkspaceMapLockOwner(lockPath);
  if (currentOwner?.token !== token) return;
  const tombstonePath = `${lockPath}.released-${token}-${randomUUID()}`;
  try {
    await fs.rename(lockPath, tombstonePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    return;
  }
  await fs.rm(tombstonePath, { recursive: true, force: true });
}

async function readOrganizationWorkspaceMapLockOwner(
  lockPath: string,
): Promise<OrganizationWorkspaceMapLockOwner | null> {
  try {
    const entries = await fs.readdir(lockPath, { withFileTypes: true });
    const ownerEntries = entries.filter((entry) =>
      entry.isFile()
      && entry.name.startsWith(ORGANIZATION_WORKSPACE_MAP_LOCK_OWNER_PREFIX)
      && entry.name.endsWith(".json")
    );
    if (ownerEntries.length !== 1) return null;
    if (entries.some((entry) =>
      entry.name !== ownerEntries[0]!.name && entry.name !== ORGANIZATION_WORKSPACE_MAP_RECLAIM_FILE
    )) return null;
    const fileName = ownerEntries[0]!.name;
    if (!fileName.startsWith(ORGANIZATION_WORKSPACE_MAP_LOCK_OWNER_PREFIX) || !fileName.endsWith(".json")) {
      return null;
    }
    const owner = JSON.parse(await fs.readFile(path.join(lockPath, fileName), "utf8")) as Partial<
      OrganizationWorkspaceMapLockOwner
    >;
    if (
      owner.kind !== ORGANIZATION_WORKSPACE_MAP_LOCK_KIND
      || owner.version !== 1
      || typeof owner.token !== "string"
      || fileName !== `${ORGANIZATION_WORKSPACE_MAP_LOCK_OWNER_PREFIX}${owner.token}.json`
      || !Number.isSafeInteger(owner.pid)
      || (owner.pid ?? 0) <= 0
      || typeof owner.hostname !== "string"
      || typeof owner.createdAt !== "string"
      || !Number.isFinite(Date.parse(owner.createdAt))
    ) return null;
    return owner as OrganizationWorkspaceMapLockOwner;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

export async function migrateOrganizationStorageRoot(orgId: string): Promise<{
  canonicalRootPath: string;
  legacyRootPath: string;
  migrated: boolean;
  mergedIntoExistingTarget: boolean;
  skippedBecauseTargetExists: boolean;
}> {
  const canonicalRootPath = resolveOrganizationRoot(orgId);
  const legacyRootPath = resolveLegacyOrganizationRoot(orgId);
  if (canonicalRootPath === legacyRootPath) {
    return {
      canonicalRootPath,
      legacyRootPath,
      migrated: false,
      mergedIntoExistingTarget: false,
      skippedBecauseTargetExists: false,
    };
  }

  const legacyExists = await directoryExists(legacyRootPath);
  if (!legacyExists) {
    return {
      canonicalRootPath,
      legacyRootPath,
      migrated: false,
      mergedIntoExistingTarget: false,
      skippedBecauseTargetExists: false,
    };
  }

  const canonicalExists = await directoryExists(canonicalRootPath);
  if (canonicalExists) {
    await assertCanMergeDirectoryContents(legacyRootPath, canonicalRootPath);
    const retainedDuplicates = await mergeDirectoryContents(legacyRootPath, canonicalRootPath);
    if (retainedDuplicates) await archiveRetainedMigrationSource(legacyRootPath);
    else await fs.rmdir(legacyRootPath);
    return {
      canonicalRootPath,
      legacyRootPath,
      migrated: true,
      mergedIntoExistingTarget: true,
      skippedBecauseTargetExists: false,
    };
  }

  await fs.mkdir(path.dirname(canonicalRootPath), { recursive: true });
  try {
    await fs.rename(legacyRootPath, canonicalRootPath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code === "ENOENT") {
      return {
        canonicalRootPath,
        legacyRootPath,
        migrated: false,
        mergedIntoExistingTarget: false,
        skippedBecauseTargetExists: false,
      };
    }
    if (code === "EEXIST") {
      return {
        canonicalRootPath,
        legacyRootPath,
        migrated: false,
        mergedIntoExistingTarget: false,
        skippedBecauseTargetExists: true,
      };
    }
    throw error;
  }

  return {
    canonicalRootPath,
    legacyRootPath,
    migrated: true,
    mergedIntoExistingTarget: false,
    skippedBecauseTargetExists: false,
  };
}

export async function migrateOrganizationWorkspaceRoot(orgId: string, options?: {
  failIfMappedFolderMissing?: boolean;
}): Promise<{
  canonicalRootPath: string;
  legacyRootPath: string;
  migrated: boolean;
  mergedIntoExistingTarget: boolean;
  skippedBecauseTargetExists: boolean;
}> {
  const canonicalRootPath = resolveOrganizationWorkspaceRoot(orgId);
  const legacyRootPath = resolveLegacyOrganizationWorkspaceRoot(orgId);
  const previousDocumentsRootPath = resolvePreviousDocumentsOrganizationWorkspaceRoot(orgId);
  const legacyRootPaths = [...new Set([previousDocumentsRootPath, legacyRootPath])].filter((candidate) =>
    path.resolve(candidate) !== path.resolve(canonicalRootPath)
  );
  if (legacyRootPaths.length === 0) {
    return {
      canonicalRootPath,
      legacyRootPath,
      migrated: false,
      mergedIntoExistingTarget: false,
      skippedBecauseTargetExists: false,
    };
  }

  let migrated = false;
  let mergedIntoExistingTarget = false;
  let skippedBecauseTargetExists = false;
  let firstLegacyRootPath = legacyRootPaths[0] ?? legacyRootPath;
  let migratedFromRootPath = firstLegacyRootPath;

  for (const candidateLegacyRootPath of legacyRootPaths) {
    firstLegacyRootPath = firstLegacyRootPath || candidateLegacyRootPath;
    const legacyExists = await directoryExists(candidateLegacyRootPath);
    if (!legacyExists) {
      if (
        await directoryExists(canonicalRootPath)
        && await workspaceIdentityMatches(canonicalRootPath, orgId)
        && await workspaceMigrationIncludesAlias(canonicalRootPath, candidateLegacyRootPath)
      ) {
        await fs.mkdir(path.dirname(candidateLegacyRootPath), { recursive: true });
        await createDirectoryCompatibilityAlias(candidateLegacyRootPath, canonicalRootPath);
        migrated = true;
        migratedFromRootPath = candidateLegacyRootPath;
      }
      continue;
    }
    if (await pathsReferenceSameDirectory(candidateLegacyRootPath, canonicalRootPath)) continue;

    const canonicalExists = await directoryExists(canonicalRootPath);
    try {
      if (canonicalExists) {
        await ensureOrganizationWorkspaceIdentity(canonicalRootPath, orgId);
        await ensureOrganizationWorkspaceIdentity(candidateLegacyRootPath, orgId);
        await recordWorkspaceCompatibilityAlias(canonicalRootPath, candidateLegacyRootPath);
        await assertCanMergeDirectoryContents(candidateLegacyRootPath, canonicalRootPath);
        const retainedDuplicates = await mergeDirectoryContents(candidateLegacyRootPath, canonicalRootPath);
        await preserveWorkspaceCompatibilityAlias(candidateLegacyRootPath, canonicalRootPath, retainedDuplicates);
        migrated = true;
        migratedFromRootPath = candidateLegacyRootPath;
        mergedIntoExistingTarget = true;
        continue;
      }

      await fs.mkdir(path.dirname(canonicalRootPath), { recursive: true });
      // The identity moves with the directory and makes a post-rename crash repairable.
      await ensureOrganizationWorkspaceIdentity(candidateLegacyRootPath, orgId);
      await recordWorkspaceCompatibilityAlias(candidateLegacyRootPath, candidateLegacyRootPath);
      await moveWorkspacePathWithCompatibilityAlias(candidateLegacyRootPath, canonicalRootPath);
      migrated = true;
      migratedFromRootPath = candidateLegacyRootPath;
    } catch (error) {
      if (isPermissionError(error)) {
        throw new Error(formatOrganizationWorkspacePermissionMessage({
          operation: "migrate",
          code: errorCode(error),
          legacyRootPath: candidateLegacyRootPath,
          canonicalRootPath,
        }), { cause: error });
      }
      const code = errorCode(error);
      if (code === "ENOENT") {
        continue;
      }
      if (code === "EEXIST") {
        skippedBecauseTargetExists = true;
        continue;
      }
      throw error;
    }
  }

  if (!migrated && !skippedBecauseTargetExists) {
    if (options?.failIfMappedFolderMissing && !(await directoryExists(canonicalRootPath))) {
      throw new Error([
        "Rudder could not find the mapped organization Library folder.",
        `Expected: ${canonicalRootPath}.`,
        `Mapping: ${resolveOrganizationWorkspaceMapPath()}.`,
        "If the folder was renamed or moved manually, restore the folder name or restore this organization from a workspace backup.",
      ].join(" "));
    }
    return {
      canonicalRootPath,
      legacyRootPath: firstLegacyRootPath,
      migrated: false,
      mergedIntoExistingTarget: false,
      skippedBecauseTargetExists: false,
    };
  }

  return {
    canonicalRootPath,
    legacyRootPath: migrated ? migratedFromRootPath : firstLegacyRootPath,
    migrated,
    mergedIntoExistingTarget,
    skippedBecauseTargetExists,
  };
}

export async function reconcileOrganizationStorageRoots(
  liveOrganizations: readonly (string | OrganizationWorkspaceLocator)[],
): Promise<{
  migrations: Array<Awaited<ReturnType<typeof migrateOrganizationStorageRoot>>>;
  pruned: Awaited<ReturnType<typeof pruneOrphanedOrganizationStorage>>;
  workspaceAvailableOrganizationIds: string[];
  workspacePermissionFailures: OrganizationWorkspacePermissionFailure[];
}> {
  const liveOrgIds = liveOrganizations.map((org) => typeof org === "string" ? org : org.id);
  assertUniqueOrganizationStorageKeys(liveOrgIds);
  const migrations = await Promise.all(liveOrgIds.map((orgId) => migrateOrganizationStorageRoot(orgId)));
  const workspaceAvailability = await Promise.all(liveOrganizations.map(async (org): Promise<{
    orgId: string;
    permissionFailure: OrganizationWorkspacePermissionFailure | null;
  }> => {
    if (typeof org === "string") return { orgId: org, permissionFailure: null };
    try {
      await ensureOrganizationWorkspaceLayout(org);
      return { orgId: org.id, permissionFailure: null };
    } catch (error) {
      if (!isPermissionError(error)) throw error;
      return {
        orgId: org.id,
        permissionFailure: {
          orgId: org.id,
          code: errorCode(error),
          message: organizationWorkspacePermissionFailureMessage(error, org.id),
        },
      };
    }
  }));
  const workspacePermissionFailures = workspaceAvailability.flatMap((result) =>
    result.permissionFailure ? [result.permissionFailure] : []
  );
  const workspaceAvailableOrganizationIds = workspaceAvailability.flatMap((result) =>
    result.permissionFailure ? [] : [result.orgId]
  );
  const pruned = await pruneOrphanedOrganizationStorage(liveOrgIds);
  return { migrations, pruned, workspaceAvailableOrganizationIds, workspacePermissionFailures };
}

export async function ensureProjectLibraryLayout(input: {
  orgId: string;
  projectId: string;
  projectName?: string | null;
  projectUrlKey?: string | null;
}): Promise<{
  root: string;
  relativePath: string;
  readmePath: string;
}> {
  await ensureOrganizationWorkspaceLayout(input.orgId);

  const relativePath = resolveProjectLibraryRelativePath(input);
  const root = resolveProjectLibraryDir(input);
  await fs.mkdir(root, { recursive: true });

  const readmePath = path.join(root, "README.md");
  try {
    await fs.writeFile(
      readmePath,
      [
        `# ${input.projectName?.trim() || "Project"}`,
        "",
        "Agents should keep durable project work files inside this folder.",
        "Attached Project Resources are surfaced in the Library tree under `resources/` as virtual references; external resources are not copied into this folder.",
        "",
      ].join("\n"),
      { flag: "wx" },
    );
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    if (code !== "EEXIST") {
      throw error;
    }
  }

  return { root, relativePath, readmePath };
}

export async function ensureAgentWorkspaceLayout(agent: {
  orgId: string;
  id: string;
  name?: string | null;
  workspaceKey?: string | null;
}): Promise<{
  root: string;
  instructionsDir: string;
  memoryDir: string;
  lifeDir: string;
  skillsDir: string;
}> {
  await ensureOrganizationWorkspaceLayout(agent.orgId);

  const workspaceKey = resolveStoredOrDerivedAgentWorkspaceKey(agent);
  const root = resolveDefaultAgentWorkspaceDir(agent.orgId, workspaceKey);
  const instructionsDir = resolveAgentInstructionsDir(agent.orgId, workspaceKey);
  const memoryDir = resolveAgentMemoryDir(agent.orgId, workspaceKey);
  const lifeDir = resolveAgentLifeDir(agent.orgId, workspaceKey);
  const skillsDir = resolveAgentSkillsDir(agent.orgId, workspaceKey);
  await fs.mkdir(root, { recursive: true });
  await Promise.all([
    fs.mkdir(instructionsDir, { recursive: true }),
    fs.mkdir(memoryDir, { recursive: true }),
    fs.mkdir(lifeDir, { recursive: true }),
    fs.mkdir(skillsDir, { recursive: true }),
  ]);

  return {
    root,
    instructionsDir,
    memoryDir,
    lifeDir,
    skillsDir,
  };
}

function sanitizeFriendlyPathSegment(value: string | null | undefined, fallback = "_default"): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  const sanitized = trimmed
    .replace(FRIENDLY_PATH_SEGMENT_RE, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

function sanitizeOrganizationWorkspaceFolderName(value: string | null | undefined, fallback: string): string {
  const sanitized = sanitizeFriendlyPathSegment(value, fallback)
    .replace(/[.]+$/g, "")
    .toLowerCase();
  const normalized = sanitized && !RESERVED_ORGANIZATION_WORKSPACE_NAMES.has(sanitized)
    ? sanitized
    : fallback;
  return normalized || fallback;
}

async function readOrganizationWorkspaceMapFileState(): Promise<OrganizationWorkspaceMapFileState> {
  const mapPath = resolveOrganizationWorkspaceMapPath();
  try {
    const raw = await fs.readFile(mapPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<OrganizationWorkspaceMapFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.organizations)) {
      throw new Error(
        `Invalid organization workspace mapping file at ${mapPath}. Restore the mapping file or restore organizations from workspace backups before starting Rudder.`,
      );
    }
    return {
      exists: true,
      map: {
        version: 1,
        organizations: parsed.organizations.filter((entry): entry is OrganizationWorkspaceMapRecord =>
          typeof entry === "object"
          && entry !== null
          && typeof entry.instanceId === "string"
          && typeof entry.orgId === "string"
          && typeof entry.folderName === "string"
          && typeof entry.createdAt === "string"
          && typeof entry.updatedAt === "string"
        ),
      },
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { exists: false, map: { version: 1, organizations: [] } };
    if (isPermissionError(error)) {
      const code = errorCode(error);
      const permissionError = new Error([
        `Rudder could not read the organization workspace mapping${code ? ` (${code})` : ""}.`,
        `Mapping: ${mapPath}.`,
        "This usually means the operating system blocked access to the Documents workspace location.",
        "Grant Rudder permission to access Documents or choose a writable folder with RUDDER_ORGANIZATION_WORKSPACE_HOME.",
      ].join(" "), { cause: error });
      if (code) Object.assign(permissionError, { code });
      throw permissionError;
    }
    throw error;
  }
}

async function readOrganizationWorkspaceMapFile(): Promise<OrganizationWorkspaceMapFile> {
  return (await readOrganizationWorkspaceMapFileState()).map;
}

function findOrganizationWorkspaceMapRecord(
  map: OrganizationWorkspaceMapFile,
  orgId: string,
): OrganizationWorkspaceMapRecord | undefined {
  return map.organizations.find((entry) => entry.instanceId === resolveRudderInstanceId() && entry.orgId === orgId);
}

function readOrganizationWorkspaceFolderName(orgId: string): string | null {
  if (!usesFriendlyOrganizationWorkspaceHome()) return null;
  try {
    const raw = fsSync.readFileSync(resolveOrganizationWorkspaceMapPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<OrganizationWorkspaceMapFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.organizations)) return null;
    const record = parsed.organizations.find((entry) =>
      typeof entry === "object"
      && entry !== null
      && entry.instanceId === resolveRudderInstanceId()
      && entry.orgId === orgId
      && typeof entry.folderName === "string"
    );
    return record?.folderName ?? null;
  } catch {
    return null;
  }
}

async function writeOrganizationWorkspaceMapFile(
  mapPath: string,
  map: OrganizationWorkspaceMapFile,
): Promise<void> {
  const tempPath = `${mapPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.mkdir(path.dirname(mapPath), { recursive: true });
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(map, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, mapPath);
  await syncDirectory(path.dirname(mapPath));
}

async function ensureOrganizationWorkspaceIdentity(root: string, orgId: string): Promise<void> {
  const identityPath = path.join(root, ORGANIZATION_WORKSPACE_IDENTITY_FILE);
  const expectedOrgId = validatePathSegment(orgId, "org id");
  try {
    const existing = JSON.parse(await fs.readFile(identityPath, "utf8")) as { orgId?: unknown };
    if (existing.orgId !== expectedOrgId) {
      throw new Error(`Organization workspace identity mismatch at ${identityPath}.`);
    }
    return;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await fs.writeFile(
    identityPath,
    `${JSON.stringify({ version: 1, orgId: expectedOrgId }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  ).catch(async (error) => {
    if (errorCode(error) !== "EEXIST" || !(await workspaceIdentityMatches(root, expectedOrgId))) {
      throw error;
    }
  });
}

async function workspaceIdentityMatches(root: string, orgId: string): Promise<boolean> {
  try {
    const identity = JSON.parse(
      await fs.readFile(path.join(root, ORGANIZATION_WORKSPACE_IDENTITY_FILE), "utf8"),
    ) as { orgId?: unknown };
    return identity.orgId === validatePathSegment(orgId, "org id");
  } catch {
    return false;
  }
}

async function recordWorkspaceCompatibilityAlias(root: string, aliasPath: string): Promise<void> {
  const migrationPath = path.join(root, ORGANIZATION_WORKSPACE_MIGRATION_FILE);
  let state: OrganizationWorkspaceMigrationFile = { version: 1, compatibilityAliases: [] };
  try {
    const parsed = JSON.parse(await fs.readFile(migrationPath, "utf8")) as Partial<
      OrganizationWorkspaceMigrationFile
    >;
    if (parsed.version !== 1 || !Array.isArray(parsed.compatibilityAliases)) {
      throw new Error(`Invalid organization workspace migration state at ${migrationPath}.`);
    }
    state = {
      version: 1,
      compatibilityAliases: parsed.compatibilityAliases.filter((entry): entry is string => typeof entry === "string"),
    };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const normalizedAliasPath = path.resolve(aliasPath);
  if (state.compatibilityAliases.includes(normalizedAliasPath)) return;
  state.compatibilityAliases.push(normalizedAliasPath);
  state.compatibilityAliases.sort();

  const tempPath = `${migrationPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, migrationPath);
  await syncDirectory(root);
}

async function workspaceMigrationIncludesAlias(root: string, aliasPath: string): Promise<boolean> {
  try {
    const state = JSON.parse(
      await fs.readFile(path.join(root, ORGANIZATION_WORKSPACE_MIGRATION_FILE), "utf8"),
    ) as Partial<OrganizationWorkspaceMigrationFile>;
    return state.version === 1
      && Array.isArray(state.compatibilityAliases)
      && state.compatibilityAliases.includes(path.resolve(aliasPath));
  } catch {
    return false;
  }
}

async function allocateOrganizationWorkspaceFolderName(input: {
  homeDir: string;
  map: OrganizationWorkspaceMapFile;
  orgId: string;
  orgName?: string | null;
  orgUrlKey?: string | null;
  allowExistingBaseDirectory?: boolean;
}): Promise<string> {
  const fallback = resolveOrganizationStorageKey(input.orgId);
  const base = sanitizeOrganizationWorkspaceFolderName(input.orgName ?? input.orgUrlKey, fallback);
  const usedFolders = new Set(
    input.map.organizations
      .filter((entry) => entry.instanceId === resolveRudderInstanceId() && entry.orgId !== input.orgId)
      .map((entry) => entry.folderName),
  );
  for (let attempt = 1; attempt < 10000; attempt += 1) {
    const folderName = attempt === 1 ? base : `${base}-${attempt}`;
    if (usedFolders.has(folderName)) continue;
    const existing = await pathExists(path.resolve(input.homeDir, folderName));
    if (existing && !existing.isDirectory()) continue;
    if (
      existing
      && input.allowExistingBaseDirectory
      && folderName === base
      && await workspaceIdentityMatches(path.resolve(input.homeDir, folderName), input.orgId)
    ) return folderName;
    if (existing) {
      const owned = input.map.organizations.some((entry) =>
        entry.instanceId === resolveRudderInstanceId()
        && entry.orgId === input.orgId
        && entry.folderName === folderName
      );
      if (!owned) continue;
    }
    return folderName;
  }
  throw new Error("Unable to allocate organization workspace folder name");
}

export async function removeOrganizationStorage(orgId: string): Promise<{
  organizationRootPath: string;
  legacyOrganizationRootPath: string;
  workspaceRootPath: string;
  legacyProjectsRootPath: string;
}> {
  const normalizedOrgId = validatePathSegment(orgId, "org id");
  const organizationRootPath = resolveOrganizationRoot(normalizedOrgId);
  const legacyOrganizationRootPath = resolveLegacyOrganizationRoot(normalizedOrgId);
  const workspaceRootPath = resolveOrganizationWorkspaceRoot(normalizedOrgId);
  const legacyProjectsRootPath = path.resolve(resolveRudderInstanceRoot(), "projects", normalizedOrgId);
  const removeLegacyOrganizationRoot = legacyOrganizationRootPath === organizationRootPath
    ? []
    : [fs.rm(legacyOrganizationRootPath, { recursive: true, force: true })];
  await Promise.all([
    fs.rm(organizationRootPath, { recursive: true, force: true }),
    fs.rm(workspaceRootPath, { recursive: true, force: true }),
    ...removeLegacyOrganizationRoot,
    // Best-effort cleanup for legacy pre-org-workspace managed project paths.
    fs.rm(legacyProjectsRootPath, { recursive: true, force: true }),
  ]);
  return { organizationRootPath, legacyOrganizationRootPath, workspaceRootPath, legacyProjectsRootPath };
}

async function listDirectoryNames(rootPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function directoryExists(rootPath: string): Promise<boolean> {
  try {
    return (await fs.stat(rootPath)).isDirectory();
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

function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && code.trim().length > 0 ? code : null;
}

function isPermissionError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== null && WORKSPACE_PERMISSION_ERROR_CODES.has(code);
}

function organizationWorkspacePermissionFailureMessage(error: unknown, orgId: string): string {
  const existingMessage = error instanceof Error ? error.message : "";
  if (/Grant Rudder permission to access Documents/i.test(existingMessage)) return existingMessage;
  return formatOrganizationWorkspacePermissionMessage({
    operation: "access",
    code: errorCode(error),
    legacyRootPath: resolveLegacyOrganizationWorkspaceRoot(orgId),
    canonicalRootPath: resolveOrganizationWorkspaceHomeDir(),
  });
}

function formatOrganizationWorkspacePermissionMessage(input: {
  operation: string;
  code: string | null;
  legacyRootPath: string;
  canonicalRootPath: string;
}): string {
  const codeSuffix = input.code ? ` (${input.code})` : "";
  return [
    `Rudder could not ${input.operation} the organization workspace to the Documents workspace location${codeSuffix}.`,
    `Source: ${input.legacyRootPath}.`,
    `Target: ${input.canonicalRootPath}.`,
    "This usually means the target folder is not writable or the operating system blocked access.",
    "Grant Rudder permission to access Documents, choose a writable folder with RUDDER_ORGANIZATION_WORKSPACE_HOME, or on Windows try running Rudder as administrator if the folder policy requires it.",
  ].join(" ");
}

async function lstatIfExists(targetPath: string) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function movePath(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await fs.rename(sourcePath, targetPath);
    return;
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
  }

  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  await fs.rm(sourcePath, { recursive: true, force: false });
}

async function pathsReferenceSameDirectory(first: string, second: string): Promise<boolean> {
  try {
    const [firstRealPath, secondRealPath] = await Promise.all([fs.realpath(first), fs.realpath(second)]);
    return firstRealPath === secondRealPath;
  } catch {
    return false;
  }
}

async function createDirectoryCompatibilityAlias(aliasPath: string, targetPath: string): Promise<void> {
  await fs.symlink(targetPath, aliasPath, process.platform === "win32" ? "junction" : "dir");
  await syncDirectory(path.dirname(aliasPath));
}

async function moveWorkspacePathWithCompatibilityAlias(sourcePath: string, targetPath: string): Promise<void> {
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    if (errorCode(error) === "EXDEV") {
      throw Object.assign(new Error(
        `Cannot atomically migrate organization workspace across filesystems from ${sourcePath} to ${targetPath}.`,
      ), { code: "RUDDER_WORKSPACE_CROSS_DEVICE_MIGRATION" });
    }
    throw error;
  }
  try {
    await createDirectoryCompatibilityAlias(sourcePath, targetPath);
  } catch (error) {
    await fs.rename(targetPath, sourcePath).catch(() => {});
    throw error;
  }
}

async function preserveWorkspaceCompatibilityAlias(
  sourcePath: string,
  targetPath: string,
  retainedDuplicates: boolean,
): Promise<void> {
  const archivedPath = await archiveRetainedMigrationSource(sourcePath);
  try {
    await createDirectoryCompatibilityAlias(sourcePath, targetPath);
  } catch (error) {
    await fs.rename(archivedPath, sourcePath).catch(() => {});
    throw error;
  }
  if (!retainedDuplicates) {
    // Keep the renamed directory inode for active processes whose cwd was the legacy root.
    await fs.writeFile(
      path.join(archivedPath, ".rudder-migrated-workspace"),
      `${JSON.stringify({ targetPath }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(directory, "r");
  } catch (error) {
    if (["EISDIR", "EINVAL", "ENOTSUP"].includes(errorCode(error) ?? "")) return;
    throw error;
  }
  try {
    await handle.sync().catch((error) => {
      if (!["EINVAL", "ENOTSUP"].includes(errorCode(error) ?? "")) throw error;
    });
  } finally {
    await handle.close();
  }
}

async function regularFilesHaveIdenticalContents(sourcePath: string, targetPath: string): Promise<boolean> {
  const sourceFile = await fs.open(sourcePath, "r");
  try {
    const targetFile = await fs.open(targetPath, "r");
    try {
      const [sourceStat, targetStat] = await Promise.all([sourceFile.stat(), targetFile.stat()]);
      if (
        !sourceStat.isFile() ||
        !targetStat.isFile() ||
        sourceStat.size !== targetStat.size ||
        (sourceStat.mode & EXECUTABLE_MODE_BITS) !== (targetStat.mode & EXECUTABLE_MODE_BITS)
      ) {
        return false;
      }

      const sourceBuffer = Buffer.allocUnsafe(FILE_COMPARE_CHUNK_BYTES);
      const targetBuffer = Buffer.allocUnsafe(FILE_COMPARE_CHUNK_BYTES);
      let position = 0;

      while (position < sourceStat.size) {
        const bytesToRead = Math.min(FILE_COMPARE_CHUNK_BYTES, sourceStat.size - position);
        const [sourceRead, targetRead] = await Promise.all([
          sourceFile.read(sourceBuffer, 0, bytesToRead, position),
          targetFile.read(targetBuffer, 0, bytesToRead, position),
        ]);
        if (
          sourceRead.bytesRead === 0 ||
          sourceRead.bytesRead !== targetRead.bytesRead ||
          !sourceBuffer.subarray(0, sourceRead.bytesRead).equals(targetBuffer.subarray(0, targetRead.bytesRead))
        ) {
          return false;
        }
        position += sourceRead.bytesRead;
      }

      return true;
    } finally {
      await targetFile.close();
    }
  } finally {
    await sourceFile.close();
  }
}

async function archiveRetainedMigrationSource(sourceRoot: string): Promise<string> {
  const backupHome = path.join(path.dirname(sourceRoot), MIGRATION_BACKUP_DIR_NAME);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupHome, `${path.basename(sourceRoot)}-${timestamp}-${randomUUID()}`);
  await fs.mkdir(backupHome, { recursive: true });
  await fs.rename(sourceRoot, backupPath);
  return backupPath;
}

async function mergeDirectoryContents(sourceRoot: string, targetRoot: string): Promise<boolean> {
  await fs.mkdir(targetRoot, { recursive: true });
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  let retainedDuplicates = false;

  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    const targetStat = await lstatIfExists(targetPath);
    if (!targetStat) {
      await movePath(sourcePath, targetPath);
      continue;
    }
    if (entry.isDirectory() && targetStat.isDirectory()) {
      const retainedInChild = await mergeDirectoryContents(sourcePath, targetPath);
      if (retainedInChild) retainedDuplicates = true;
      else await fs.rmdir(sourcePath);
      continue;
    }
    if (entry.isFile() && targetStat.isFile()) {
      if (await regularFilesHaveIdenticalContents(sourcePath, targetPath)) {
        // Preserve the duplicate in an atomic sibling backup instead of racing external filesystem writers.
        retainedDuplicates = true;
        continue;
      }
    }
    throw new Error(
      `Cannot migrate organization storage root because '${targetPath}' already exists.`,
    );
  }
  return retainedDuplicates;
}

async function assertCanMergeDirectoryContents(sourceRoot: string, targetRoot: string): Promise<void> {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    const targetStat = await lstatIfExists(targetPath);
    if (!targetStat) continue;
    if (entry.isDirectory() && targetStat.isDirectory()) {
      await assertCanMergeDirectoryContents(sourcePath, targetPath);
      continue;
    }
    if (entry.isFile() && targetStat.isFile()) {
      if (await regularFilesHaveIdenticalContents(sourcePath, targetPath)) continue;
    }
    throw new Error(
      `Cannot migrate organization storage root because '${targetPath}' already exists.`,
    );
  }
}

export async function pruneOrphanedOrganizationStorage(
  liveOrgIds: readonly string[],
): Promise<{
  removedOrganizationDirNames: string[];
  removedWorkspaceDirNames: string[];
  removedLegacyProjectDirNames: string[];
  removedLegacyProjectsRoot: boolean;
}> {
  assertUniqueOrganizationStorageKeys(liveOrgIds);
  const liveOrgIdSet = new Set(
    liveOrgIds.flatMap((orgId) => [
      resolveOrganizationStorageKey(orgId),
      resolveOrganizationLegacyStorageKey(orgId),
    ]),
  );
  const organizationRoot = path.resolve(resolveRudderInstanceRoot(), "organizations");
  const legacyProjectsRoot = path.resolve(resolveRudderInstanceRoot(), "projects");
  const organizationDirNames = await listDirectoryNames(organizationRoot);
  const legacyProjectDirNames = await listDirectoryNames(legacyProjectsRoot);
  const legacyProjectsRootExists = await directoryExists(legacyProjectsRoot);

  const removedOrganizationDirNames = organizationDirNames.filter((dirName) =>
    dirName !== MIGRATION_BACKUP_DIR_NAME && !liveOrgIdSet.has(dirName)
  );
  const removedLegacyProjectDirNames = legacyProjectDirNames;

  await Promise.all([
    ...removedOrganizationDirNames.map((dirName) =>
      fs.rm(path.resolve(organizationRoot, dirName), { recursive: true, force: true })),
    ...(legacyProjectsRootExists
      ? [fs.rm(legacyProjectsRoot, { recursive: true, force: true })]
      : []),
  ]);

  return {
    removedOrganizationDirNames,
    removedWorkspaceDirNames: [],
    removedLegacyProjectDirNames,
    removedLegacyProjectsRoot: legacyProjectsRootExists,
  };
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
