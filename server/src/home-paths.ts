import {
  assertUniqueOrganizationStorageKeys,
  normalizeOrganizationStoragePathSegment,
  resolveOrganizationLegacyStorageKey,
  resolveOrganizationStorageKey,
} from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AgentWorkspaceLocator, resolveStoredOrDerivedAgentWorkspaceKey } from "./agent-workspace-key.js";

const DEFAULT_INSTANCE_ID = "default";
const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const FRIENDLY_PATH_SEGMENT_RE = /[^a-zA-Z0-9._-]+/g;

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

export async function ensureOrganizationWorkspaceLayout(orgId: string): Promise<{
  root: string;
  agentsDir: string;
  skillsDir: string;
  projectsDir: string;
}> {
  await migrateOrganizationStorageRoot(orgId);

  const root = resolveOrganizationWorkspaceRoot(orgId);
  const agentsDir = resolveOrganizationAgentsDir(orgId);
  const skillsDir = resolveOrganizationSkillsDir(orgId);
  const projectsDir = resolveOrganizationProjectsDir(orgId);
  await Promise.all([
    fs.mkdir(root, { recursive: true }),
    fs.mkdir(agentsDir, { recursive: true }),
    fs.mkdir(skillsDir, { recursive: true }),
    fs.mkdir(projectsDir, { recursive: true }),
  ]);
  return { root, agentsDir, skillsDir, projectsDir };
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

export async function reconcileOrganizationStorageRoots(
  liveOrgIds: readonly string[],
): Promise<{
  migrations: Array<Awaited<ReturnType<typeof migrateOrganizationStorageRoot>>>;
  pruned: Awaited<ReturnType<typeof pruneOrphanedOrganizationStorage>>;
}> {
  assertUniqueOrganizationStorageKeys(liveOrgIds);
  const migrations = await Promise.all(liveOrgIds.map((orgId) => migrateOrganizationStorageRoot(orgId)));
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

export async function removeOrganizationStorage(orgId: string): Promise<{
  organizationRootPath: string;
  legacyOrganizationRootPath: string;
  legacyProjectsRootPath: string;
}> {
  const normalizedOrgId = validatePathSegment(orgId, "org id");
  const organizationRootPath = resolveOrganizationRoot(normalizedOrgId);
  const legacyOrganizationRootPath = resolveLegacyOrganizationRoot(normalizedOrgId);
  const legacyProjectsRootPath = path.resolve(resolveRudderInstanceRoot(), "projects", normalizedOrgId);
  const removeLegacyOrganizationRoot = legacyOrganizationRootPath === organizationRootPath
    ? []
    : [fs.rm(legacyOrganizationRootPath, { recursive: true, force: true })];
  await Promise.all([
    fs.rm(organizationRootPath, { recursive: true, force: true }),
    ...removeLegacyOrganizationRoot,
    // Best-effort cleanup for legacy pre-org-workspace managed project paths.
    fs.rm(legacyProjectsRootPath, { recursive: true, force: true }),
  ]);
  return { organizationRootPath, legacyOrganizationRootPath, legacyProjectsRootPath };
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

async function mergeDirectoryContents(sourceRoot: string, targetRoot: string): Promise<void> {
  await fs.mkdir(targetRoot, { recursive: true });
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    const targetStat = await lstatIfExists(targetPath);
    if (!targetStat) {
      await fs.rename(sourcePath, targetPath);
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
    removedLegacyProjectDirNames,
    removedLegacyProjectsRoot: legacyProjectsRootExists,
  };
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
