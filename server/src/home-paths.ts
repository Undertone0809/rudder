import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AgentWorkspaceLocator, resolveStoredOrDerivedAgentWorkspaceKey } from "./agent-workspace-key.js";

const DEFAULT_INSTANCE_ID = "default";
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;
const FRIENDLY_PATH_SEGMENT_RE = /[^a-zA-Z0-9._-]+/g;
const LEGACY_PROJECT_ARTIFACTS_DIR_NAME = "legacy-project-artifacts";
const IGNORED_LEGACY_STORAGE_ENTRIES = new Set([".DS_Store"]);

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
  const normalizedOrgId = validatePathSegment(orgId, "org id");
  return path.resolve(
    resolveRudderInstanceRoot(),
    "organizations",
    normalizedOrgId,
  );
}

function validatePathSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid ${label} for workspace path '${value}'.`);
  }
  return trimmed;
}

function resolveAgentWorkspacePathSegment(agent: string | AgentWorkspaceLocator): string {
  if (typeof agent === "string") {
    return validatePathSegment(agent, "agent workspace key");
  }
  return validatePathSegment(resolveStoredOrDerivedAgentWorkspaceKey(agent), "agent workspace key");
}

export function resolveOrganizationWorkspaceRoot(orgId: string): string {
  return path.resolve(
    resolveOrganizationRoot(orgId),
    "workspaces",
  );
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

export function resolveAgentSkillsDir(orgId: string, agent: string | AgentWorkspaceLocator): string {
  return path.resolve(resolveDefaultAgentWorkspaceDir(orgId, agent), "skills");
}

export function resolveOrganizationSkillsDir(orgId: string): string {
  return path.resolve(resolveOrganizationWorkspaceRoot(orgId), "skills");
}

export function resolveOrganizationPlansDir(orgId: string): string {
  return path.resolve(resolveOrganizationWorkspaceRoot(orgId), "plans");
}

export function resolveOrganizationAgentsDir(orgId: string): string {
  return path.resolve(resolveOrganizationWorkspaceRoot(orgId), "agents");
}

export function resolveLegacyProjectArtifactsDir(orgId: string): string {
  return path.resolve(resolveOrganizationWorkspaceRoot(orgId), LEGACY_PROJECT_ARTIFACTS_DIR_NAME);
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

export async function ensureOrganizationWorkspaceLayout(orgId: string): Promise<{
  root: string;
  agentsDir: string;
  skillsDir: string;
  plansDir: string;
}> {
  const root = resolveOrganizationWorkspaceRoot(orgId);
  const agentsDir = resolveOrganizationAgentsDir(orgId);
  const skillsDir = resolveOrganizationSkillsDir(orgId);
  const plansDir = resolveOrganizationPlansDir(orgId);
  await Promise.all([
    fs.mkdir(root, { recursive: true }),
    fs.mkdir(agentsDir, { recursive: true }),
    fs.mkdir(skillsDir, { recursive: true }),
    fs.mkdir(plansDir, { recursive: true }),
  ]);
  return { root, agentsDir, skillsDir, plansDir };
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
  skillsDir: string;
}> {
  await ensureOrganizationWorkspaceLayout(agent.orgId);

  const workspaceKey = resolveStoredOrDerivedAgentWorkspaceKey(agent);
  const root = resolveDefaultAgentWorkspaceDir(agent.orgId, workspaceKey);
  const instructionsDir = resolveAgentInstructionsDir(agent.orgId, workspaceKey);
  const memoryDir = resolveAgentMemoryDir(agent.orgId, workspaceKey);
  const skillsDir = resolveAgentSkillsDir(agent.orgId, workspaceKey);
  await fs.mkdir(root, { recursive: true });
  await Promise.all([
    fs.mkdir(instructionsDir, { recursive: true }),
    fs.mkdir(memoryDir, { recursive: true }),
    fs.mkdir(skillsDir, { recursive: true }),
  ]);

  return {
    root,
    instructionsDir,
    memoryDir,
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

export async function removeOrganizationStorage(orgId: string): Promise<{
  organizationRootPath: string;
  legacyProjectsRootPath: string;
}> {
  const normalizedOrgId = validatePathSegment(orgId, "org id");
  const organizationRootPath = resolveOrganizationRoot(normalizedOrgId);
  const legacyProjectsRootPath = path.resolve(resolveRudderInstanceRoot(), "projects", normalizedOrgId);
  await Promise.all([
    fs.rm(organizationRootPath, { recursive: true, force: true }),
    // Best-effort cleanup for legacy pre-org-workspace managed project paths.
    fs.rm(legacyProjectsRootPath, { recursive: true, force: true }),
  ]);
  return { organizationRootPath, legacyProjectsRootPath };
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

async function listDirectoryEntries(rootPath: string): Promise<Array<{ name: string; path: string }>> {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries
      .map((entry) => ({ name: entry.name, path: path.resolve(rootPath, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fs.stat(targetPath).then(() => true).catch((error) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  });
}

async function allocateAvailableDestination(parentPath: string, entryName: string): Promise<string> {
  const extension = path.extname(entryName);
  const basename = extension ? entryName.slice(0, -extension.length) : entryName;
  let candidate = path.resolve(parentPath, entryName);
  if (!(await pathExists(candidate))) return candidate;

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    candidate = path.resolve(parentPath, `${basename}-${suffix}${extension}`);
    if (!(await pathExists(candidate))) return candidate;
  }

  throw new Error(`Unable to allocate archive path for legacy project artifact '${entryName}'.`);
}

async function movePath(sourcePath: string, destinationPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EXDEV") {
      await fs.cp(sourcePath, destinationPath, { recursive: true, force: false, errorOnExist: true });
      await fs.rm(sourcePath, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

async function archiveLegacyProjectStorageForLiveOrg(orgId: string, legacyOrgRootPath: string): Promise<number> {
  const entries = await listDirectoryEntries(legacyOrgRootPath);
  const entriesToMove = entries.filter((entry) => !IGNORED_LEGACY_STORAGE_ENTRIES.has(entry.name));
  await Promise.all(
    entries
      .filter((entry) => IGNORED_LEGACY_STORAGE_ENTRIES.has(entry.name))
      .map((entry) => fs.rm(entry.path, { recursive: true, force: true })),
  );

  if (entriesToMove.length === 0) {
    await fs.rm(legacyOrgRootPath, { recursive: true, force: true });
    return 0;
  }

  const archiveRoot = resolveLegacyProjectArtifactsDir(orgId);
  await ensureOrganizationWorkspaceLayout(orgId);
  await fs.mkdir(archiveRoot, { recursive: true });

  let movedEntryCount = 0;
  for (const entry of entriesToMove) {
    const destinationPath = await allocateAvailableDestination(archiveRoot, entry.name);
    await movePath(entry.path, destinationPath);
    movedEntryCount += 1;
  }

  await fs.rm(legacyOrgRootPath, { recursive: true, force: true });
  return movedEntryCount;
}

async function removeIgnoredRootEntries(rootPath: string): Promise<void> {
  await Promise.all(
    Array.from(IGNORED_LEGACY_STORAGE_ENTRIES).map((entryName) =>
      fs.rm(path.resolve(rootPath, entryName), { recursive: true, force: true })),
  );
}

async function removeDirectoryIfEmpty(rootPath: string): Promise<boolean> {
  try {
    await fs.rmdir(rootPath);
    return true;
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && (error.code === "ENOENT" || error.code === "ENOTEMPTY")
    ) {
      return false;
    }
    throw error;
  }
}

export async function pruneOrphanedOrganizationStorage(
  liveOrgIds: readonly string[],
): Promise<{
  removedOrganizationDirNames: string[];
  removedLegacyProjectDirNames: string[];
  archivedLegacyProjectDirNames: string[];
  removedLegacyProjectsRoot: boolean;
}> {
  const liveOrgIdSet = new Set(liveOrgIds.map((orgId) => validatePathSegment(orgId, "org id")));
  const organizationRoot = path.resolve(resolveRudderInstanceRoot(), "organizations");
  const legacyProjectsRoot = path.resolve(resolveRudderInstanceRoot(), "projects");
  const organizationDirNames = await listDirectoryNames(organizationRoot);
  const legacyProjectDirNames = await listDirectoryNames(legacyProjectsRoot);

  const removedOrganizationDirNames = organizationDirNames.filter((dirName) => !liveOrgIdSet.has(dirName));
  const removedLegacyProjectDirNames: string[] = [];
  const archivedLegacyProjectDirNames: string[] = [];

  await Promise.all([
    ...removedOrganizationDirNames.map((dirName) =>
      fs.rm(path.resolve(organizationRoot, dirName), { recursive: true, force: true })),
  ]);

  for (const dirName of legacyProjectDirNames) {
    const legacyOrgRootPath = path.resolve(legacyProjectsRoot, dirName);
    if (!liveOrgIdSet.has(dirName)) {
      await fs.rm(legacyOrgRootPath, { recursive: true, force: true });
      removedLegacyProjectDirNames.push(dirName);
      continue;
    }

    // Top-level `instances/<id>/projects` is retired. Preserve any old live-org
    // artifacts under that org's managed workspace, then remove the legacy path.
    const movedEntryCount = await archiveLegacyProjectStorageForLiveOrg(dirName, legacyOrgRootPath);
    if (movedEntryCount > 0) archivedLegacyProjectDirNames.push(dirName);
  }
  await removeIgnoredRootEntries(legacyProjectsRoot);
  const removedLegacyProjectsRoot = await removeDirectoryIfEmpty(legacyProjectsRoot);

  return {
    removedOrganizationDirNames,
    removedLegacyProjectDirNames,
    archivedLegacyProjectDirNames,
    removedLegacyProjectsRoot,
  };
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
