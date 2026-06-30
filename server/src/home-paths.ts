import {
  assertUniqueOrganizationStorageKeys,
  normalizeOrganizationStoragePathSegment,
  resolveOrganizationLegacyStorageKey,
  resolveOrganizationStorageKey,
} from "@rudderhq/agent-runtime-utils";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AgentWorkspaceLocator, resolveStoredOrDerivedAgentWorkspaceKey } from "./agent-workspace-key.js";

const DEFAULT_INSTANCE_ID = "default";
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const FRIENDLY_PATH_SEGMENT_RE = /[^a-zA-Z0-9._-]+/g;
const WORKSPACE_PERMISSION_ERROR_CODES = new Set(["EACCES", "EPERM", "EROFS"]);
const ORGANIZATION_WORKSPACE_MAP_FILE = ".rudder-organizations.json";
const RESERVED_ORGANIZATION_WORKSPACE_NAMES = new Set([
  ORGANIZATION_WORKSPACE_MAP_FILE,
  ".rudder",
  "backups",
  "data",
  "instances",
  "runtimes",
]);

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
    await mergeDirectoryContents(legacyRootPath, canonicalRootPath);
    await fs.rmdir(legacyRootPath);
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
    if (!legacyExists) continue;

    const canonicalExists = await directoryExists(canonicalRootPath);
    try {
      if (canonicalExists) {
        await assertCanMergeDirectoryContents(candidateLegacyRootPath, canonicalRootPath);
        await mergeDirectoryContents(candidateLegacyRootPath, canonicalRootPath);
        await fs.rmdir(candidateLegacyRootPath);
        migrated = true;
        migratedFromRootPath = candidateLegacyRootPath;
        mergedIntoExistingTarget = true;
        continue;
      }

      await fs.mkdir(path.dirname(canonicalRootPath), { recursive: true });
      await movePath(candidateLegacyRootPath, canonicalRootPath);
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
}> {
  const liveOrgIds = liveOrganizations.map((org) => typeof org === "string" ? org : org.id);
  assertUniqueOrganizationStorageKeys(liveOrgIds);
  const migrations = await Promise.all(liveOrgIds.map((orgId) => migrateOrganizationStorageRoot(orgId)));
  await Promise.all(liveOrganizations.map((org) => typeof org === "string" ? null : ensureOrganizationWorkspaceLayout(org)));
  const pruned = await pruneOrphanedOrganizationStorage(liveOrgIds);
  return { migrations, pruned };
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
  const tempPath = `${mapPath}.tmp`;
  await fs.mkdir(path.dirname(mapPath), { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(map, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, mapPath);
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
    if (existing && input.allowExistingBaseDirectory && folderName === base) return folderName;
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

async function mergeDirectoryContents(sourceRoot: string, targetRoot: string): Promise<void> {
  await fs.mkdir(targetRoot, { recursive: true });
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    const targetStat = await lstatIfExists(targetPath);
    if (!targetStat) {
      await movePath(sourcePath, targetPath);
      continue;
    }
    if (entry.isDirectory() && targetStat.isDirectory()) {
      await mergeDirectoryContents(sourcePath, targetPath);
      await fs.rmdir(sourcePath);
      continue;
    }
    throw new Error(
      `Cannot migrate organization storage root because '${targetPath}' already exists.`,
    );
  }
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

  const removedOrganizationDirNames = organizationDirNames.filter((dirName) => !liveOrgIdSet.has(dirName));
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
