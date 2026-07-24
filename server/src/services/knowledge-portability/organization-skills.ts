import type { RudderSkillEntry } from "@rudderhq/agent-runtime-utils/server-utils";
import { readRudderSkillSyncPreference, writeRudderSkillSyncPreference } from "@rudderhq/agent-runtime-utils/server-utils";
import type { Db } from "@rudderhq/db";
import { agents as agentRows, organizationSkills } from "@rudderhq/db";
import type {
  AgentSkillEntry,
  AgentSkillSnapshot,
  AgentSkillSyncMode,
  DeploymentMode,
  OrganizationSkill,
  OrganizationSkillCreateRequest,
  OrganizationSkillDetail,
  OrganizationSkillFileDetail,
  OrganizationSkillImportResult,
  OrganizationSkillListItem,
  OrganizationSkillUpdateStatus,
  OrganizationSkillUsageAgent,
} from "@rudderhq/shared";
import {
  getActiveRudderBundledSkillSlugs,
  getBundledRudderSkillSlug,
  isRetiredRudderCreationSkillReference,
  toBundledRudderSkillKey,
} from "@rudderhq/shared";
import { and, asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { conflict, notFound, unprocessable } from "../../errors.js";
import {
  resolveAgentSkillsDir,
  resolveOrganizationWorkspaceRoot,
} from "../../home-paths.js";
import { agentEnabledSkillsService } from "../agent-enabled-skills.js";
import { agentService } from "../agents.js";
import {
  type BrowserCapabilityServiceOptions,
  resolveBrowserCapability,
  resolveBrowserCapabilityDeployment,
} from "../browser-capability.js";
import { instanceSettingsService } from "../instance-settings.js";
import { projectService } from "../projects.js";

import {
  ADAPTER_SKILL_HOME_DEFINITIONS,
  AgentSkillCatalogEntry,
  AgentSkillSelectionResolution,
  AgentWorkspaceRow,
  COMMUNITY_PRESET_SKILLS,
  COMMUNITY_PRESET_SKILL_SLUGS,
  EnabledSkillsAgentRef,
  ImportPackageSkillResult,
  ImportedSkill,
  PackageSkillConflictStrategy,
  RuntimeSkillEntryOptions,
  applyDesiredSelectionsToCatalog,
  arraysEqual,
  asString,
  buildAgentPrivateSkillEntry,
  buildAgentSelectionKey,
  buildBundledSelectionKey,
  buildDraftSkillMarkdown,
  buildGlobalSelectionKey,
  buildOrganizationSelectionKey,
  buildSkillRuntimeName,
  compareOrganizationSkillListItems,
  deriveCanonicalSkillKey,
  deriveSkillSourceInfo,
  enrichSkill,
  findMissingLocalSkillIds,
  getRequiredBundledSkillKeys,
  getSkillMeta,
  inferLanguageFromPath,
  isBundledRudderSkillKey,
  isBundledRudderSourceKind,
  isMarkdownPath,
  isPlainRecord,
  listLegacyUserHomeLocalScanSkillIds,
  listStaleBundledSkillIds,
  listStaleCommunityPresetSkillIds,
  normalizePackageFileMap,
  normalizePortablePath,
  normalizeSafeRelativeSkillPath,
  normalizeSelectionRef,
  normalizeSkillDescription,
  normalizeSkillDirectory,
  normalizeSkillSlug,
  parseSelectionKey,
  readAdapterSkillCatalogEntries,
  readDiscoveredSkillEntries,
  resolveConfiguredHomeDir,
  resolveLocalSkillFilePath,
  resolveManagedSkillsRoot,
  resolveRequestedSkillKeysOrThrow,
  resolveWorkspaceEditPath,
  serializeFileInventory,
  skillInventoryRefreshPromises,
  sortUniqueSelectionRefs,
  statPath,
  toCompanySkill,
  toCompanySkillListItem,
  uniqueImportedSkillKey,
  uniqueSkillSlug
} from "./organization-skills.catalog.js";
import { createOrganizationSkillScanHandlers } from "./organization-skills.scans.js";
import {
  parseFrontmatterMarkdown,
  parseSkillImportSourceInput,
  readCommunityPresetFallbackImport,
  readInlineSkillImports,
  readLocalSkillImportFromDirectory,
  readLocalSkillImports,
  readUrlSkillImports,
  resolveBundledSkillsRoot,
  resolveCommunityPresetSkillsRoot,
  resolveGitHubCommitSha,
} from "./organization-skills.sources.js";

const ORGANIZATION_SKILL_INSTALLATION_VERSION = 1;
const skillInstallationPromises = new Map<string, Promise<string>>();
const skillMutationLocks = new Map<string, Promise<void>>();

export function organizationSkillService(
  db: Db,
  options: BrowserCapabilityServiceOptions = {},
) {
  const deploymentMode: DeploymentMode = resolveBrowserCapabilityDeployment(
    db,
    options.deploymentMode,
  );
  const agents = agentService(db);
  const enabledSkills = agentEnabledSkillsService(db);
  const projects = projectService(db);
  const { scanProjectWorkspaces, scanLocalSkillRoots } = createOrganizationSkillScanHandlers({
    ensureSkillInventoryCurrent,
    listFull,
    projects,
    upsertImportedSkills,
  });

  function normalizeInstalledFilePath(relativePath: string) {
    const normalized = normalizeSafeRelativeSkillPath(relativePath);
    if (!normalized) {
      throw unprocessable(`Invalid skill file path: ${relativePath}`);
    }
    return normalized;
  }

  function resolveInstalledSkillDirectory(orgId: string, key: string, slug: string) {
    const managedRoot = path.resolve(resolveManagedSkillsRoot(orgId));
    const installedRoot = path.resolve(managedRoot, "__installed__");
    const target = path.resolve(installedRoot, buildSkillRuntimeName(key, slug));
    const relative = path.relative(installedRoot, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw unprocessable("Invalid organization skill installation path.");
    }
    return target;
  }

  async function removeInstalledSkillDirectory(orgId: string, skill: OrganizationSkill) {
    if (getSkillMeta(skill).installationVersion !== ORGANIZATION_SKILL_INSTALLATION_VERSION) return;
    await fs.rm(
      resolveInstalledSkillDirectory(orgId, skill.key, skill.slug),
      { recursive: true, force: true },
    );
  }

  async function mapWithConcurrency<T>(
    values: T[],
    concurrency: number,
    operation: (value: T) => Promise<void>,
  ) {
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      async () => {
        while (nextIndex < values.length) {
          const index = nextIndex;
          nextIndex += 1;
          await operation(values[index]!);
        }
      },
    );
    await Promise.all(workers);
  }

  async function withSkillMutationLock<T>(
    orgId: string,
    skillKey: string,
    operation: () => Promise<T>,
  ) {
    const lockKey = `${orgId}:${skillKey}`;
    const previous = skillMutationLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    skillMutationLocks.set(lockKey, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (skillMutationLocks.get(lockKey) === current) {
        skillMutationLocks.delete(lockKey);
      }
    }
  }

  async function readImportedSkillFiles(skill: ImportedSkill) {
    const files = new Map<string, string | Uint8Array>();
    for (const [rawPath, content] of Object.entries(skill.files ?? {})) {
      files.set(normalizeInstalledFilePath(rawPath), content);
    }
    if (skill.packageDir) {
      await mapWithConcurrency(skill.fileInventory, 8, async (entry) => {
        const relativePath = normalizeInstalledFilePath(entry.path);
        if (files.has(relativePath)) return;
        files.set(
          relativePath,
          await fs.readFile(path.resolve(skill.packageDir!, relativePath)),
        );
      });
    }
    for (const entry of skill.fileInventory) {
      const relativePath = normalizeInstalledFilePath(entry.path);
      if (!files.has(relativePath)) {
        throw unprocessable(`Skill source did not provide declared file: ${relativePath}`);
      }
    }
    return files;
  }

  async function replaceInstalledSkillDirectory<T>(
    orgId: string,
    skill: Pick<ImportedSkill, "key" | "slug" | "fileInventory">,
    files: Map<string, string | Uint8Array>,
    persist: () => Promise<T>,
  ) {
    const target = resolveInstalledSkillDirectory(orgId, skill.key, skill.slug);
    const parent = path.dirname(target);
    const staging = path.join(parent, `.${path.basename(target)}.staging-${randomUUID()}`);
    const backup = path.join(parent, `.${path.basename(target)}.backup-${randomUUID()}`);
    let movedExisting = false;

    async function restorePreviousInstallation(originalError: unknown) {
      const displaced = path.join(
        parent,
        `.${path.basename(target)}.rollback-displaced-${randomUUID()}`,
      );
      let movedCurrentTarget = false;
      try {
        if (await fs.stat(target).catch(() => null)) {
          await fs.rename(target, displaced);
          movedCurrentTarget = true;
        }
        await fs.rename(backup, target);
        movedExisting = false;
        if (movedCurrentTarget) {
          await fs.rm(displaced, { recursive: true, force: true });
          movedCurrentTarget = false;
        }
      } catch (rollbackError) {
        if (
          movedCurrentTarget
          && !(await fs.stat(target).catch(() => null))
        ) {
          await fs.rename(displaced, target).catch(() => {});
        }
        throw conflict(
          "Organization skill installation consistency error: rollback could not restore the previous installation.",
          {
            target,
            backup,
            originalError: originalError instanceof Error
              ? originalError.message
              : String(originalError),
            rollbackError: rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
          },
        );
      }
    }

    async function removeFailedInstallation(originalError: unknown) {
      try {
        await fs.rm(target, { recursive: true, force: true });
      } catch (rollbackError) {
        throw conflict(
          "Organization skill installation consistency error: rollback could not remove the failed installation.",
          {
            target,
            originalError: originalError instanceof Error
              ? originalError.message
              : String(originalError),
            rollbackError: rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
          },
        );
      }
    }

    await fs.mkdir(staging, { recursive: true });
    try {
      await mapWithConcurrency(skill.fileInventory, 8, async (entry) => {
        const relativePath = normalizeInstalledFilePath(entry.path);
        const targetPath = path.resolve(staging, relativePath);
        const relativeTarget = path.relative(staging, targetPath);
        if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
          throw unprocessable(`Invalid skill file path: ${entry.path}`);
        }
        const content = files.get(relativePath);
        if (content === undefined) {
          throw unprocessable(`Skill source did not provide declared file: ${relativePath}`);
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content);
      });
      const skillFile = await fs.stat(path.join(staging, "SKILL.md")).catch(() => null);
      if (!skillFile?.isFile()) {
        throw unprocessable("Installed skill is missing SKILL.md.");
      }

      await fs.mkdir(parent, { recursive: true });
      const existing = await fs.stat(target).catch(() => null);
      if (existing) {
        await fs.rename(target, backup);
        movedExisting = true;
      }
      try {
        await fs.rename(staging, target);
      } catch (error) {
        if (movedExisting) {
          await restorePreviousInstallation(error);
        }
        throw error;
      }
      let persisted: T;
      try {
        persisted = await persist();
      } catch (error) {
        if (movedExisting) {
          await restorePreviousInstallation(error);
        } else {
          await removeFailedInstallation(error);
        }
        throw error;
      }
      if (movedExisting) {
        await fs.rm(backup, { recursive: true, force: true });
        movedExisting = false;
      }
      return persisted;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  async function installImportedSkill<T>(
    orgId: string,
    skill: ImportedSkill,
    persist: (installed: ImportedSkill) => Promise<T>,
  ) {
    const sourceKind = asString(skill.metadata?.sourceKind);
    if (isBundledRudderSourceKind(sourceKind)) return persist(skill);
    const installed = markImportedSkillInstalled(skill);
    const files = await readImportedSkillFiles(installed);
    return withSkillMutationLock(orgId, installed.key, () =>
      replaceInstalledSkillDirectory(
        orgId,
        installed,
        files,
        () => persist(installed),
      ));
  }

  function markImportedSkillInstalled(skill: ImportedSkill): ImportedSkill {
    return {
      ...skill,
      metadata: {
        ...(skill.metadata ?? {}),
        installationVersion: ORGANIZATION_SKILL_INSTALLATION_VERSION,
      },
    };
  }

  function hasUnchangedInstallationSource(
    current: OrganizationSkill,
    snapshot: OrganizationSkill,
  ) {
    return current.sourceType === snapshot.sourceType
      && current.sourceLocator === snapshot.sourceLocator
      && current.sourceRef === snapshot.sourceRef
      && getSkillMeta(current).installationVersion
      === getSkillMeta(snapshot).installationVersion
      && current.updatedAt.getTime() === snapshot.updatedAt.getTime();
  }

  async function resolveCurrentSkillDirectory(skill: OrganizationSkill) {
    const directory = normalizeSkillDirectory(skill);
    if (
      directory
      && (await fs.stat(path.join(directory, "SKILL.md")).catch(() => null))?.isFile()
    ) {
      return directory;
    }
    return null;
  }

  function isStrictlyWithinPath(root: string, target: string) {
    const relative = path.relative(root, target);
    return Boolean(relative)
      && !relative.startsWith("..")
      && !path.isAbsolute(relative);
  }

  async function resolveValidatedLocalSkillFilePath(
    skill: OrganizationSkill,
    relativePath: string,
  ) {
    const absolutePath = resolveLocalSkillFilePath(skill, relativePath);
    const skillRoot = normalizeSkillDirectory(skill);
    if (!absolutePath || !skillRoot) return null;
    const realRoot = await fs.realpath(skillRoot).catch(() => null);
    if (!realRoot) return null;

    const targetEntry = await fs.lstat(absolutePath).catch(() => null);
    if (targetEntry) {
      const realTarget = await fs.realpath(absolutePath).catch(() => null);
      return realTarget && isStrictlyWithinPath(realRoot, realTarget)
        ? absolutePath
        : null;
    }

    let existingAncestor = path.dirname(absolutePath);
    while (
      !(await fs.lstat(existingAncestor).catch(() => null))
      && existingAncestor !== path.dirname(existingAncestor)
    ) {
      existingAncestor = path.dirname(existingAncestor);
    }
    const realAncestor = await fs.realpath(existingAncestor).catch(() => null);
    if (
      !realAncestor
      || (realAncestor !== realRoot && !isStrictlyWithinPath(realRoot, realAncestor))
    ) {
      return null;
    }
    const projectedTarget = path.resolve(
      realAncestor,
      path.relative(existingAncestor, absolutePath),
    );
    return isStrictlyWithinPath(realRoot, projectedTarget) ? absolutePath : null;
  }

  async function assertDirectLocalSourceIsUnmanaged(orgId: string, skill: ImportedSkill) {
    const sourcePath = skill.packageDir ?? skill.sourceLocator;
    if (!sourcePath) throw unprocessable("Local skill source path is missing.");
    const sourceDirectory = path.basename(sourcePath).toLowerCase() === "skill.md"
      ? path.dirname(sourcePath)
      : sourcePath;
    const managedInstalledRoot = path.resolve(resolveManagedSkillsRoot(orgId), "__installed__");
    const [resolvedSource, resolvedManagedRoot] = await Promise.all([
      fs.realpath(path.resolve(sourceDirectory)).catch(() => path.resolve(sourceDirectory)),
      fs.realpath(managedInstalledRoot).catch(() => managedInstalledRoot),
    ]);
    const relative = path.relative(resolvedManagedRoot, resolvedSource);
    if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw unprocessable(
        "Managed organization skill installations cannot be imported as direct local sources.",
      );
    }
  }

  async function upsertDirectLocalSkill(
    orgId: string,
    skill: ImportedSkill,
  ): Promise<OrganizationSkill> {
    return withSkillMutationLock(orgId, skill.key, async () => {
      await assertDirectLocalSourceIsUnmanaged(orgId, skill);
      const existing = await getByKey(orgId, skill.key);
      if (
        existing
        && isBundledRudderSourceKind(asString(getSkillMeta(existing).sourceKind))
      ) {
        return existing;
      }

      const [persisted] = await upsertImportedSkills(orgId, [skill]);
      if (!persisted) throw notFound("Failed to persist organization skill");

      // The database transition must succeed before retiring the managed copy so
      // a failed local-path upsert leaves the previous installation runnable.
      if (
        existing
        && getSkillMeta(existing).installationVersion
        === ORGANIZATION_SKILL_INSTALLATION_VERSION
      ) {
        await removeInstalledSkillDirectory(orgId, existing);
      }
      return persisted;
    });
  }

  async function installAndUpsertImportedSkills(orgId: string, skills: ImportedSkill[]) {
    const out: OrganizationSkill[] = [];
    for (const skill of skills) {
      const existing = await getByKey(orgId, skill.key);
      if (
        existing
        && isBundledRudderSourceKind(asString(getSkillMeta(existing).sourceKind))
      ) {
        out.push(existing);
        continue;
      }
      if (skill.sourceType === "local_path") {
        out.push(await upsertDirectLocalSkill(orgId, skill));
        continue;
      }
      out.push(await installImportedSkill(
        orgId,
        skill,
        async (installed) => {
          const [persisted] = await upsertImportedSkills(orgId, [installed]);
          if (!persisted) throw notFound("Failed to persist organization skill");
          return persisted;
        },
      ));
    }
    return out;
  }

  async function getAgentWorkspaceRow(orgId: string, agentId: string): Promise<AgentWorkspaceRow> {
    const row = await db
      .select({
        id: agentRows.id,
        name: agentRows.name,
        workspaceKey: agentRows.workspaceKey,
      })
      .from(agentRows)
      .where(and(eq(agentRows.orgId, orgId), eq(agentRows.id, agentId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Agent not found");
    return row;
  }

  async function ensureBundledSkills(orgId: string) {
    const browserSettings = await instanceSettingsService(db).getBrowser();
    const browserCapability = resolveBrowserCapability({
      deploymentMode,
      browserEnabled: browserSettings.enabled,
    });
    const activeBundledSlugs = getActiveRudderBundledSkillSlugs(
      browserCapability.instanceEligible,
    );
    const activeBundledKeys = activeBundledSlugs.map((slug) => `rudder/${slug}`);
    for (const skillsRoot of resolveBundledSkillsRoot()) {
      const stats = await fs.stat(skillsRoot).catch(() => null);
      if (!stats?.isDirectory()) continue;
      let bundledSkillCandidates: Array<ImportedSkill | null> = [];
      try {
        bundledSkillCandidates = await Promise.all(
          activeBundledSlugs.map(async (slug) => {
            const skillDir = path.join(skillsRoot, slug);
            const skillStats = await fs.stat(skillDir).catch(() => null);
            if (!skillStats?.isDirectory()) return null;
            const imported = await readLocalSkillImportFromDirectory(orgId, skillDir, {
              metadata: {
                sourceKind: "rudder_bundled",
                skillKey: `rudder/${slug}`,
              },
            }).catch(() => null);
            if (!imported) return null;
            return {
              ...imported,
              key: `rudder/${slug}`,
              slug,
              metadata: {
                ...(imported.metadata ?? {}),
                sourceKind: "rudder_bundled",
                skillKey: `rudder/${slug}`,
              },
            };
          }),
        );
      } catch {
        bundledSkillCandidates = [];
      }
      const bundledSkills = bundledSkillCandidates.filter((skill): skill is ImportedSkill => skill !== null);
      if (bundledSkills.length === 0) continue;

      const persisted = await upsertImportedSkills(orgId, bundledSkills);
      const existingRows = await db
        .select({
          id: organizationSkills.id,
          key: organizationSkills.key,
          metadata: organizationSkills.metadata,
        })
        .from(organizationSkills)
        .where(eq(organizationSkills.orgId, orgId));
      const staleBundledIds = listStaleBundledSkillIds(existingRows, activeBundledKeys);
      if (staleBundledIds.length > 0) {
        const staleKeys = existingRows
          .filter((row) => staleBundledIds.includes(row.id))
          .map((row) => String(row.key));
        await enabledSkills.removeSkillKeys(orgId, staleKeys);
        for (const staleId of staleBundledIds) {
          await db.delete(organizationSkills).where(eq(organizationSkills.id, staleId));
        }
      }

      return persisted;
    }
    return [];
  }

  /**
   * Seed community presets into the org library without upgrading them to
   * bundled Rudder runtime skills.
   *
   * Reasoning:
   * - Presets should behave like optional organization skills in agent pickers.
   * - Existing non-preset rows with the same canonical key win, so a local
   *   org-managed replacement is not overwritten by refresh.
   * - Presets can come from repo-owned packages or GitHub-managed sources
   *   without changing their product meaning in the UI.
   *
   * Traceability:
   * - doc/plans/2026-04-19-community-preset-skills.md
   */
  async function ensureCommunityPresetSkills(orgId: string) {
    const currentCommunityPresetKeys = COMMUNITY_PRESET_SKILL_SLUGS.map((slug) => `organization/${orgId}/${slug}`);
    const localPresetRoots = resolveCommunityPresetSkillsRoot();

    const presetCandidates: Array<ImportedSkill | null> = await Promise.all(
      COMMUNITY_PRESET_SKILLS.map(async (preset): Promise<ImportedSkill | null> => {
        const skillKey = `organization/${orgId}/${preset.slug}`;
        if (preset.source === "repo") {
          for (const skillsRoot of localPresetRoots) {
            const stats = await fs.stat(skillsRoot).catch(() => null);
            if (!stats?.isDirectory()) continue;
            const skillDir = path.join(skillsRoot, preset.slug);
            const skillStats = await fs.stat(skillDir).catch(() => null);
            if (!skillStats?.isDirectory()) continue;
            const imported = await readLocalSkillImportFromDirectory(orgId, skillDir, {
              metadata: {
                sourceKind: "community_preset",
                skillKey,
              },
            }).catch(() => null);
            if (!imported) continue;
            return {
              ...imported,
              key: skillKey,
              slug: preset.slug,
              metadata: {
                ...(imported.metadata ?? {}),
                sourceKind: "community_preset",
                skillKey,
              },
            };
          }
          return null;
        }

        const imported = await readUrlSkillImports(orgId, preset.sourceUrl, preset.slug)
          .then((result) => result.skills.find((skill) => skill.slug === preset.slug) ?? result.skills[0] ?? null)
          .catch(() => null);
        const resolvedImported = imported ?? await readCommunityPresetFallbackImport(
          orgId,
          preset.slug,
          skillKey,
          preset.sourceUrl,
        );
        if (!resolvedImported) return null;
        return {
          ...resolvedImported,
          key: skillKey,
          slug: preset.slug,
          metadata: {
            ...(resolvedImported.metadata ?? {}),
            sourceKind: "community_preset",
            skillKey,
          },
        };
      }),
    );

    const presetSkills = presetCandidates.filter((skill): skill is ImportedSkill => skill !== null);
    const existingRows = await db
      .select({
        id: organizationSkills.id,
        key: organizationSkills.key,
        metadata: organizationSkills.metadata,
      })
      .from(organizationSkills)
      .where(eq(organizationSkills.orgId, orgId));
    const existingByKey = new Map(existingRows.map((row) => [String(row.key), row]));
    const toPersist = presetSkills.filter((skill) => {
      const existing = existingByKey.get(skill.key);
      if (!existing) return true;
      const existingMetadata = isPlainRecord(existing.metadata) ? existing.metadata : {};
      return asString(existingMetadata.sourceKind) === "community_preset"
        && existingMetadata.installationVersion !== ORGANIZATION_SKILL_INSTALLATION_VERSION;
    });
    const persisted = toPersist.length > 0 ? await upsertImportedSkills(orgId, toPersist) : [];
    const stalePresetIds = listStaleCommunityPresetSkillIds(existingRows, currentCommunityPresetKeys);
    if (stalePresetIds.length > 0) {
      const staleKeys = existingRows
        .filter((row) => stalePresetIds.includes(row.id))
        .map((row) => String(row.key));
      await enabledSkills.removeSkillKeys(orgId, staleKeys);
      for (const staleId of stalePresetIds) {
        await db.delete(organizationSkills).where(eq(organizationSkills.id, staleId));
      }
    }

    return persisted;
  }

  async function pruneMissingLocalPathSkills(orgId: string) {
    const rows = await db
      .select()
      .from(organizationSkills)
      .where(eq(organizationSkills.orgId, orgId));
    const skills = rows.map((row) => toCompanySkill(row));
    const missingIds = new Set(await findMissingLocalSkillIds(skills));
    if (missingIds.size === 0) return;

    for (const skill of skills) {
      if (!missingIds.has(skill.id)) continue;
      await db
        .delete(organizationSkills)
        .where(eq(organizationSkills.id, skill.id));
      await removeInstalledSkillDirectory(orgId, skill);
    }
  }

  async function pruneLegacyUserHomeLocalScanSkills(orgId: string) {
    const rows = await db
      .select()
      .from(organizationSkills)
      .where(eq(organizationSkills.orgId, orgId));
    const staleIds = new Set(listLegacyUserHomeLocalScanSkillIds(rows));
    if (staleIds.size === 0) return;

    const skills = rows.map((row) => toCompanySkill(row));
    const staleKeys = skills
      .filter((skill) => staleIds.has(skill.id))
      .map((skill) => skill.key);
    await enabledSkills.removeSkillKeys(orgId, staleKeys);

    for (const skill of skills) {
      if (!staleIds.has(skill.id)) continue;
      await db
        .delete(organizationSkills)
        .where(eq(organizationSkills.id, skill.id));
      await removeInstalledSkillDirectory(orgId, skill);
    }
  }

  async function backfillMissingSkillDescriptions(orgId: string) {
    const rows = await db
      .select()
      .from(organizationSkills)
      .where(eq(organizationSkills.orgId, orgId));

    for (const row of rows) {
      if (normalizeSkillDescription(row.description)) continue;

      const skill = toCompanySkill(row);
      let description = normalizeSkillDescription(parseFrontmatterMarkdown(skill.markdown).frontmatter.description);

      if (!description) {
        const skillDir = normalizeSkillDirectory(skill);
        if (skillDir) {
          const markdown = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8").catch(() => null);
          if (markdown) {
            description = normalizeSkillDescription(parseFrontmatterMarkdown(markdown).frontmatter.description);
          }
        }
      }

      if (!description) continue;

      await db
        .update(organizationSkills)
        .set({ description })
        .where(eq(organizationSkills.id, skill.id));
    }
  }

  async function ensureSkillInventoryCurrent(orgId: string) {
    const existingRefresh = skillInventoryRefreshPromises.get(orgId);
    if (existingRefresh) {
      await existingRefresh;
      return;
    }

    const refreshPromise = (async () => {
      await ensureBundledSkills(orgId);
      await ensureCommunityPresetSkills(orgId);
      await pruneLegacyUserHomeLocalScanSkills(orgId);
      await pruneMissingLocalPathSkills(orgId);
      await backfillMissingSkillDescriptions(orgId);
    })();

    skillInventoryRefreshPromises.set(orgId, refreshPromise);
    try {
      await refreshPromise;
    } finally {
      if (skillInventoryRefreshPromises.get(orgId) === refreshPromise) {
        skillInventoryRefreshPromises.delete(orgId);
      }
    }
  }

  function resolveSkillMode(agentRuntimeType: string): AgentSkillSyncMode {
    return ADAPTER_SKILL_HOME_DEFINITIONS[agentRuntimeType]?.mode ?? "unsupported";
  }

  function selectionRefsToOrganizationSkillKeys(
    skills: OrganizationSkill[],
    selectionRefs: string[],
  ) {
    const selected = new Set<string>(getRequiredBundledSkillKeys(skills));
    const skillKeys = new Set(skills.map((skill) => skill.key));
    for (const selectionRef of selectionRefs) {
      const parsed = parseSelectionKey(selectionRef);
      if (parsed.sourceClass === "bundled" && parsed.orgKey && skillKeys.has(parsed.orgKey)) {
        selected.add(parsed.orgKey);
        continue;
      }
      if (parsed.sourceClass === "organization" && parsed.orgKey && skillKeys.has(parsed.orgKey)) {
        selected.add(parsed.orgKey);
      }
    }
    return Array.from(selected).sort((left, right) => left.localeCompare(right));
  }

  function normalizeStoredSelectionRefs(
    orgId: string,
    agent: EnabledSkillsAgentRef,
    skills: OrganizationSkill[],
    refs: string[],
  ) {
    if (!agent) return [] as string[];
    const normalized = refs
      .map((reference) => normalizeSelectionRef(reference, skills, orgId, agent.agentRuntimeType))
      .filter((value): value is string => Boolean(value))
      .filter((value) => parseSelectionKey(value).sourceClass !== "bundled");
    return sortUniqueSelectionRefs(normalized);
  }

  async function migrateLegacyEnabledSkills(
    orgId: string,
    agent: EnabledSkillsAgentRef,
    skills: OrganizationSkill[],
  ): Promise<string[]> {
    if (!agent?.id) return [];

    const currentRefs = await enabledSkills.listKeys(agent.id);
    if (currentRefs.length > 0) {
      const normalizedCurrentRefs = normalizeStoredSelectionRefs(orgId, agent, skills, currentRefs);
      if (!arraysEqual(currentRefs, normalizedCurrentRefs)) {
        await enabledSkills.replaceKeys(orgId, agent.id, normalizedCurrentRefs);
      }
      return normalizedCurrentRefs;
    }

    const legacyPreference = readRudderSkillSyncPreference(
      (agent.agentRuntimeConfig as Record<string, unknown>) ?? {},
    );
    if (!legacyPreference.explicit && legacyPreference.desiredSkills.length === 0) {
      return [];
    }

    const migratedRefs = normalizeStoredSelectionRefs(
      orgId,
      agent,
      skills,
      legacyPreference.desiredSkills,
    );

    if (migratedRefs.length > 0) {
      await enabledSkills.addMissingKeys(orgId, agent.id, migratedRefs);
    }

    await agents.update(agent.id, {
      agentRuntimeConfig: writeRudderSkillSyncPreference(
        (agent.agentRuntimeConfig as Record<string, unknown>) ?? {},
        [],
      ),
    });

    return migratedRefs;
  }

  async function getEnabledSkillSelectionMap(
    orgId: string,
    skills: OrganizationSkill[],
    agentRows: Awaited<ReturnType<typeof agents.list>>,
  ) {
    const selectionMap = await enabledSkills.listKeyMap(agentRows.map((agent) => agent.id));

    for (const agent of agentRows) {
      const existing = selectionMap.get(agent.id);
      if (existing) {
        const normalizedExisting = normalizeStoredSelectionRefs(orgId, agent, skills, existing);
        if (!arraysEqual(existing, normalizedExisting)) {
          await enabledSkills.replaceKeys(orgId, agent.id, normalizedExisting);
        }
        selectionMap.set(agent.id, normalizedExisting);
        continue;
      }
      selectionMap.set(agent.id, await migrateLegacyEnabledSkills(orgId, agent, skills));
    }

    return selectionMap;
  }

  async function list(orgId: string): Promise<OrganizationSkillListItem[]> {
    const rows = await listFull(orgId);
    const agentRows = await agents.list(orgId);
    const enabledSkillSelectionMap = await getEnabledSkillSelectionMap(orgId, rows, agentRows);
    return rows.map((skill) => {
      const attachedAgentCount = agentRows.filter((agent) => {
        const desiredSelectionRefs = enabledSkillSelectionMap.get(agent.id) ?? [];
        return selectionRefsToOrganizationSkillKeys(rows, desiredSelectionRefs).includes(skill.key);
      }).length;
      return toCompanySkillListItem(skill, attachedAgentCount);
    }).sort(compareOrganizationSkillListItems);
  }

  async function listFull(orgId: string): Promise<OrganizationSkill[]> {
    await ensureSkillInventoryCurrent(orgId);
    const rows = await db
      .select()
      .from(organizationSkills)
      .where(eq(organizationSkills.orgId, orgId))
      .orderBy(asc(organizationSkills.name), asc(organizationSkills.key));
    return rows.map((row) => toCompanySkill(row));
  }

  async function buildAgentSkillCatalogEntries(
    orgId: string,
    agentId: string | null,
    agentRuntimeType: string,
    runtimeConfig: Record<string, unknown>,
    skills: OrganizationSkill[],
  ): Promise<AgentSkillCatalogEntry[]> {
    const entries: AgentSkillCatalogEntry[] = [];

    for (const skill of skills) {
      if (
        isRetiredRudderCreationSkillReference(skill.key)
        || isRetiredRudderCreationSkillReference(skill.slug)
      ) {
        continue;
      }
      const bundled = isBundledRudderSkillKey(skill.key);
      entries.push({
        key: skill.slug,
        selectionKey: bundled
          ? buildBundledSelectionKey(skill.key)
          : buildOrganizationSelectionKey(skill.key),
        runtimeName: skill.slug,
        description: skill.description ?? null,
        desired: bundled,
        configurable: !bundled,
        alwaysEnabled: bundled,
        managed: true,
        state: bundled ? "configured" : "available",
        sourceClass: bundled ? "bundled" : "organization",
        origin: "organization_managed",
        originLabel: bundled ? "Bundled by Rudder" : "Organization skill",
        locationLabel: null,
        readOnly: bundled,
        sourcePath: normalizeSkillDirectory(skill),
        targetPath: null,
        workspaceEditPath: resolveWorkspaceEditPath(orgId, normalizeSkillDirectory(skill)),
        detail: bundled ? "Always loaded by Rudder for every agent run." : null,
        organizationSkillKey: skill.key,
        runtimeSourcePath: null,
      });
    }

    if (agentId) {
      const agentWorkspace = await getAgentWorkspaceRow(orgId, agentId);
      entries.push(...await readDiscoveredSkillEntries(
        orgId,
        resolveAgentSkillsDir(orgId, agentWorkspace),
        (slug) => buildAgentSelectionKey(slug),
        {
          sourceClass: "agent_home",
          originLabel: "Agent skill",
          locationLabel: "AGENT_HOME/skills",
        },
      ));
    }

    const globalRoot = path.join(resolveConfiguredHomeDir(runtimeConfig), ".agents", "skills");
    entries.push(...await readDiscoveredSkillEntries(
      orgId,
      globalRoot,
      (slug) => buildGlobalSelectionKey(slug),
      {
        sourceClass: "global",
        originLabel: "Global skill",
        locationLabel: "~/.agents/skills",
      },
    ));

    entries.push(...await readAdapterSkillCatalogEntries(orgId, runtimeConfig));

    return entries.sort((left, right) =>
      left.key.localeCompare(right.key) || left.selectionKey.localeCompare(right.selectionKey));
  }

  function validateDesiredSelectionRefs(
    entries: AgentSkillCatalogEntry[],
    requestedDesiredRefs: string[],
  ): AgentSkillSelectionResolution {
    const bySelectionKey = new Map(entries.map((entry) => [entry.selectionKey, entry]));
    const desiredRefs = sortUniqueSelectionRefs(requestedDesiredRefs).filter((selectionRef) => {
      const entry = bySelectionKey.get(selectionRef);
      return entry?.configurable ?? true;
    });

    const unknownRefs = desiredRefs.filter((selectionRef) => !bySelectionKey.has(selectionRef));
    if (unknownRefs.length > 0) {
      throw unprocessable(`Invalid skill selection (unknown references: ${unknownRefs.join(", ")}).`);
    }

    const conflicts = new Map<string, string[]>();
    for (const selectionRef of desiredRefs) {
      const entry = bySelectionKey.get(selectionRef);
      if (!entry) continue;
      const existing = conflicts.get(entry.key) ?? [];
      existing.push(selectionRef);
      conflicts.set(entry.key, existing);
    }

    const conflictMessages = Array.from(conflicts.entries())
      .filter(([, refs]) => refs.length > 1)
      .map(([skillKey, refs]) => `${skillKey}: ${refs.join(", ")}`);
    if (conflictMessages.length > 0) {
      throw unprocessable(`Invalid skill selection (conflicting skill names: ${conflictMessages.join("; ")}).`);
    }

    return {
      desiredSkills: desiredRefs,
      warnings: [],
    };
  }

  async function getEnabledSkillSelectionRefsForAgent(
    orgId: string,
    agent: EnabledSkillsAgentRef,
    skills?: OrganizationSkill[],
  ) {
    const availableSkills = skills ?? await listFull(orgId);
    return migrateLegacyEnabledSkills(orgId, agent, availableSkills);
  }

  async function buildAgentSkillSnapshot(
    agent: EnabledSkillsAgentRef,
    runtimeConfig: Record<string, unknown>,
  ): Promise<AgentSkillSnapshot> {
    if (!agent) {
      return {
        agentRuntimeType: "",
        supported: false,
        mode: "unsupported",
        desiredSkills: [],
        entries: [],
        warnings: [],
      };
    }

    const skills = await listFull(agent.orgId);
    const desiredSkills = await getEnabledSkillSelectionRefsForAgent(agent.orgId, agent, skills);
    const entries = await buildAgentSkillCatalogEntries(
      agent.orgId,
      agent.id,
      agent.agentRuntimeType,
      runtimeConfig,
      skills,
    );
    const applied = applyDesiredSelectionsToCatalog(entries, desiredSkills, agent.agentRuntimeType);
    return {
      agentRuntimeType: agent.agentRuntimeType,
      supported: resolveSkillMode(agent.agentRuntimeType) !== "unsupported",
      mode: resolveSkillMode(agent.agentRuntimeType),
      desiredSkills: applied.desiredSkills,
      entries: applied.entries,
      warnings: applied.warnings,
    };
  }

  function resolveRequestedSelectionRefAgainstCatalog(
    reference: string,
    skills: OrganizationSkill[],
    catalogEntries: AgentSkillCatalogEntry[],
    agent: NonNullable<EnabledSkillsAgentRef>,
  ) {
    const trimmed = reference.trim();
    if (!trimmed) return { selectionKey: null as string | null, ambiguous: false };

    const parsed = parseSelectionKey(trimmed);
    if (parsed.sourceClass) {
      return {
        selectionKey: catalogEntries.some((entry) => entry.selectionKey === trimmed) ? trimmed : null,
        ambiguous: false,
      };
    }

    const normalized = normalizeSelectionRef(trimmed, skills, agent.orgId, agent.agentRuntimeType);
    if (normalized) {
      const normalizedParsed = parseSelectionKey(normalized);
      if (normalizedParsed.sourceClass === "bundled") {
        return { selectionKey: null, ambiguous: false };
      }
      if (catalogEntries.some((entry) => entry.selectionKey === normalized)) {
        return { selectionKey: normalized, ambiguous: false };
      }
    }

    const externalMatches = catalogEntries.filter((entry) =>
      entry.configurable
      && !entry.organizationSkillKey
      && (entry.key === normalizeSkillSlug(trimmed)
        || entry.runtimeName?.trim().toLowerCase() === trimmed.toLowerCase()),
    );
    if (externalMatches.length === 1) {
      return { selectionKey: externalMatches[0]!.selectionKey, ambiguous: false };
    }
    if (externalMatches.length > 1) {
      return { selectionKey: null, ambiguous: true };
    }

    return { selectionKey: null, ambiguous: false };
  }

  async function resolveDesiredSkillSelectionForAgent(
    agent: EnabledSkillsAgentRef,
    runtimeConfig: Record<string, unknown>,
    requestedDesiredSkills: string[] | undefined,
  ): Promise<AgentSkillSelectionResolution> {
    if (!agent) {
      return { desiredSkills: [], warnings: [] };
    }
    const skills = await listFull(agent.orgId);
    const catalogEntries = await buildAgentSkillCatalogEntries(
      agent.orgId,
      agent.id,
      agent.agentRuntimeType,
      runtimeConfig,
      skills,
    );
    const ambiguousRefs = new Set<string>();
    const unresolvedRefs = new Set<string>();
    const requestedRefs = sortUniqueSelectionRefs((requestedDesiredSkills ?? []).flatMap((reference) => {
      if (isRetiredRudderCreationSkillReference(reference)) {
        unresolvedRefs.add(reference.trim());
        return [];
      }
      const resolved = resolveRequestedSelectionRefAgainstCatalog(reference, skills, catalogEntries, agent);
      if (resolved.ambiguous) {
        ambiguousRefs.add(reference.trim());
        return [];
      }
      if (!resolved.selectionKey) {
        const normalized = normalizeSelectionRef(reference, skills, agent.orgId, agent.agentRuntimeType);
        if (!normalized || parseSelectionKey(normalized).sourceClass !== "bundled") {
          unresolvedRefs.add(reference.trim());
        }
        return [];
      }
      return [resolved.selectionKey];
    }));
    if (ambiguousRefs.size > 0 || unresolvedRefs.size > 0) {
      const problems: string[] = [];
      if (ambiguousRefs.size > 0) {
        problems.push(`ambiguous references: ${sortUniqueSelectionRefs(Array.from(ambiguousRefs)).join(", ")}`);
      }
      if (unresolvedRefs.size > 0) {
        problems.push(`unknown references: ${sortUniqueSelectionRefs(Array.from(unresolvedRefs)).join(", ")}`);
      }
      throw unprocessable(`Invalid skill selection (${problems.join("; ")}).`);
    }

    return validateDesiredSelectionRefs(catalogEntries, requestedRefs);
  }

  async function listRealizedSkillEntriesForAgent(
    orgId: string,
    agentId: string,
    agentRuntimeType: string,
    runtimeConfig: Record<string, unknown>,
    selectionRefs: string[],
    options: RuntimeSkillEntryOptions = {},
  ): Promise<RudderSkillEntry[]> {
    const skills = await listFull(orgId);
    const skillByKey = new Map(skills.map((skill) => [skill.key, skill]));
    const catalogEntries = await buildAgentSkillCatalogEntries(orgId, agentId, agentRuntimeType, runtimeConfig, skills);
    const bySelectionKey = new Map(catalogEntries.map((entry) => [entry.selectionKey, entry]));
    const desiredSet = new Set(selectionRefs);
    const activeEntries = catalogEntries.filter((entry) => entry.alwaysEnabled || desiredSet.has(entry.selectionKey));
    const out: RudderSkillEntry[] = [];

    for (const entry of activeEntries) {
      if (entry.organizationSkillKey) {
        const skill = skillByKey.get(entry.organizationSkillKey);
        if (!skill) continue;
        let source = normalizeSkillDirectory(skill);
        if (
          source
          && !(await fs.stat(path.join(source, "SKILL.md")).catch(() => null))?.isFile()
        ) {
          source = null;
        }
        if (!source) {
          source = options.materializeMissing === false
            ? null
            : await ensureInstalledSkill(orgId, skill).catch(() => null);
        }
        if (!source) continue;
        out.push({
          key: entry.selectionKey,
          runtimeName: entry.key,
          source,
          name: skill.name,
          description: skill.description,
        });
        continue;
      }

      const catalogEntry = bySelectionKey.get(entry.selectionKey);
      if (!catalogEntry?.runtimeSourcePath) continue;
      out.push({
        key: entry.selectionKey,
        runtimeName: entry.key,
        source: catalogEntry.runtimeSourcePath,
        name: catalogEntry.runtimeName ?? entry.key,
        description: catalogEntry.description ?? null,
      });
    }

    return out.sort((left, right) => left.key.localeCompare(right.key));
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(organizationSkills)
      .where(eq(organizationSkills.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkill(row) : null;
  }

  async function getByKey(orgId: string, key: string) {
    const exactRow = await db
      .select()
      .from(organizationSkills)
      .where(and(eq(organizationSkills.orgId, orgId), eq(organizationSkills.key, key)))
      .then((rows) => rows[0] ?? null);
    if (exactRow) return toCompanySkill(exactRow);

    const bundledSlug = getBundledRudderSkillSlug(key);
    if (!bundledSlug) return null;

    const canonicalKey = toBundledRudderSkillKey(bundledSlug);
    const legacyKey = canonicalKey ? `rudder/${canonicalKey}` : null;
    const alternateKey = key === canonicalKey ? legacyKey : canonicalKey;
    if (!alternateKey) return null;

    const alternateRow = await db
      .select()
      .from(organizationSkills)
      .where(and(eq(organizationSkills.orgId, orgId), eq(organizationSkills.key, alternateKey)))
      .then((rows) => rows[0] ?? null);
    return alternateRow ? toCompanySkill(alternateRow) : null;
  }

  async function usage(orgId: string, key: string): Promise<OrganizationSkillUsageAgent[]> {
    const skills = await listFull(orgId);
    const agentRows = await agents.list(orgId);
    const enabledSkillSelectionMap = await getEnabledSkillSelectionMap(orgId, skills, agentRows);
    const desiredAgents = agentRows.filter((agent) =>
      selectionRefsToOrganizationSkillKeys(skills, enabledSkillSelectionMap.get(agent.id) ?? []).includes(key));

    return Promise.all(
      desiredAgents.map(async (agent) => {
        const actualState = resolveSkillMode(agent.agentRuntimeType) === "unsupported"
          ? "unsupported"
          : "configured";

        return {
          id: agent.id,
          name: agent.name,
          urlKey: agent.urlKey,
          agentRuntimeType: agent.agentRuntimeType,
          desired: true,
          actualState,
        };
      }),
    );
  }

  async function detail(orgId: string, id: string): Promise<OrganizationSkillDetail | null> {
    await ensureSkillInventoryCurrent(orgId);
    const skill = await getById(id);
    if (!skill || skill.orgId !== orgId) return null;
    const usedByAgents = await usage(orgId, skill.key);
    return enrichSkill(skill, usedByAgents.length, usedByAgents);
  }

  async function updateStatus(orgId: string, skillId: string): Promise<OrganizationSkillUpdateStatus | null> {
    await ensureSkillInventoryCurrent(orgId);
    const skill = await getById(skillId);
    if (!skill || skill.orgId !== orgId) return null;

    if (skill.sourceType !== "github" && skill.sourceType !== "skills_sh") {
      return {
        supported: false,
        reason: "Only GitHub-managed skills support update checks.",
        trackingRef: null,
        currentRef: skill.sourceRef ?? null,
        latestRef: null,
        hasUpdate: false,
      };
    }

    const metadata = getSkillMeta(skill);
    const owner = asString(metadata.owner);
    const repo = asString(metadata.repo);
    const trackingRef = asString(metadata.trackingRef) ?? asString(metadata.ref);
    if (!owner || !repo || !trackingRef) {
      return {
        supported: false,
        reason: "This GitHub skill does not have enough metadata to track updates.",
        trackingRef: trackingRef ?? null,
        currentRef: skill.sourceRef ?? null,
        latestRef: null,
        hasUpdate: false,
      };
    }

    const latestRef = await resolveGitHubCommitSha(owner, repo, trackingRef);
    return {
      supported: true,
      reason: null,
      trackingRef,
      currentRef: skill.sourceRef ?? null,
      latestRef,
      hasUpdate: latestRef !== (skill.sourceRef ?? null),
    };
  }

  async function readFile(orgId: string, skillId: string, relativePath: string): Promise<OrganizationSkillFileDetail | null> {
    await ensureSkillInventoryCurrent(orgId);
    const skill = await getById(skillId);
    if (!skill || skill.orgId !== orgId) return null;

    const normalizedPath = normalizeSafeRelativeSkillPath(relativePath || "SKILL.md");
    if (!normalizedPath) throw notFound("Skill file not found");
    const fileEntry = skill.fileInventory.find((entry) => entry.path === normalizedPath);
    if (!fileEntry) {
      throw notFound("Skill file not found");
    }

    const source = deriveSkillSourceInfo(skill);
    let content = "";
    const localSkillDirectory = normalizeSkillDirectory(skill);

    if (localSkillDirectory) {
      const absolutePath = await resolveValidatedLocalSkillFilePath(skill, normalizedPath);
      if (absolutePath) {
        content = await fs.readFile(absolutePath, "utf8");
      } else if (normalizedPath === "SKILL.md") {
        content = skill.markdown;
      } else {
        throw notFound("Skill file not found");
      }
    } else if (normalizedPath === "SKILL.md") {
      content = skill.markdown;
    } else {
      throw notFound("Skill file is not installed yet.");
    }

    return {
      skillId: skill.id,
      path: normalizedPath,
      kind: fileEntry.kind,
      content,
      language: inferLanguageFromPath(normalizedPath),
      markdown: isMarkdownPath(normalizedPath),
      editable: source.editable,
    };
  }

  async function createLocalSkill(orgId: string, input: OrganizationSkillCreateRequest): Promise<OrganizationSkill> {
    const slug = normalizeSkillSlug(input.slug ?? input.name) ?? "skill";
    const managedRoot = resolveManagedSkillsRoot(orgId);
    const skillDir = path.resolve(managedRoot, slug);
    const skillFilePath = path.resolve(skillDir, "SKILL.md");

    await fs.mkdir(skillDir, { recursive: true });

    const markdown = buildDraftSkillMarkdown(input);

    await fs.writeFile(skillFilePath, markdown, "utf8");

    const parsed = parseFrontmatterMarkdown(markdown);
    const imported = await upsertImportedSkills(orgId, [{
      key: `organization/${orgId}/${slug}`,
      slug,
      name: asString(parsed.frontmatter.name) ?? input.name,
      description: normalizeSkillDescription(parsed.frontmatter.description) ?? input.description?.trim() ?? null,
      markdown,
      sourceType: "local_path",
      sourceLocator: skillDir,
      sourceRef: null,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "managed_local" },
    }]);

    return imported[0]!;
  }

  async function createAgentPrivateSkill(
    orgId: string,
    agentId: string,
    input: OrganizationSkillCreateRequest,
  ): Promise<AgentSkillEntry> {
    const slug = normalizeSkillSlug(input.slug ?? input.name) ?? "skill";
    const agentWorkspace = await getAgentWorkspaceRow(orgId, agentId);
    const skillsRoot = resolveAgentSkillsDir(orgId, agentWorkspace);
    const skillDir = path.resolve(skillsRoot, slug);
    const relativePath = path.relative(skillsRoot, skillDir);
    if (
      relativePath.startsWith("..")
      || path.isAbsolute(relativePath)
      || relativePath === ""
      || relativePath === "."
    ) {
      throw unprocessable("Invalid agent skill slug.");
    }

    const skillFilePath = path.resolve(skillDir, "SKILL.md");
    const existing = await statPath(skillFilePath);
    if (existing?.isFile()) {
      throw conflict(`Agent skill already exists: ${slug}`);
    }

    await fs.mkdir(skillDir, { recursive: true });
    const markdown = buildDraftSkillMarkdown(input);
    await fs.writeFile(skillFilePath, markdown, "utf8");

    const parsed = parseFrontmatterMarkdown(markdown);
    const description = normalizeSkillDescription(parsed.frontmatter.description) ?? input.description?.trim() ?? null;
    return buildAgentPrivateSkillEntry(orgId, slug, skillDir, description);
  }

  async function updateFile(orgId: string, skillId: string, relativePath: string, content: string): Promise<OrganizationSkillFileDetail> {
    await ensureSkillInventoryCurrent(orgId);
    const skill = await getById(skillId);
    if (!skill || skill.orgId !== orgId) throw notFound("Skill not found");

    const source = deriveSkillSourceInfo(skill);
    if (!source.editable) {
      throw unprocessable(source.editableReason ?? "This skill cannot be edited.");
    }
    await ensureInstalledSkill(orgId, skill);
    return withSkillMutationLock(orgId, skill.key, async () => {
      const current = await getById(skillId);
      if (!current || current.orgId !== orgId) throw notFound("Skill not found");
      const currentSource = deriveSkillSourceInfo(current);
      if (!currentSource.editable) {
        throw unprocessable(currentSource.editableReason ?? "This skill cannot be edited.");
      }

      const normalizedPath = normalizeSafeRelativeSkillPath(relativePath);
      if (!normalizedPath) throw notFound("Skill file not found");
      if (!current.fileInventory.some((entry) => entry.path === normalizedPath)) {
        throw notFound("Skill file not found");
      }
      const absolutePath = await resolveValidatedLocalSkillFilePath(current, normalizedPath);
      if (!absolutePath) throw notFound("Skill file not found");

      let previousContent: Buffer | null = null;
      let fileExisted = false;
      try {
        previousContent = await fs.readFile(absolutePath);
        fileExisted = true;
      } catch (error) {
        if (
          !(error instanceof Error)
          || !("code" in error)
          || error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");

      try {
        if (normalizedPath === "SKILL.md") {
          const parsed = parseFrontmatterMarkdown(content);
          await db
            .update(organizationSkills)
            .set({
              name: asString(parsed.frontmatter.name) ?? current.name,
              description: normalizeSkillDescription(parsed.frontmatter.description)
                ?? current.description,
              markdown: content,
              updatedAt: new Date(),
            })
            .where(eq(organizationSkills.id, current.id));
        } else {
          await db
            .update(organizationSkills)
            .set({ updatedAt: new Date() })
            .where(eq(organizationSkills.id, current.id));
        }
      } catch (persistenceError) {
        try {
          if (fileExisted) {
            await fs.writeFile(absolutePath, previousContent!);
          } else {
            await fs.rm(absolutePath, { force: true });
          }
        } catch (rollbackError) {
          throw conflict(
            "Organization skill edit consistency error: rollback could not restore the previous file.",
            {
              path: normalizedPath,
              persistenceError: persistenceError instanceof Error
                ? persistenceError.message
                : String(persistenceError),
              rollbackError: rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
            },
          );
        }
        throw persistenceError;
      }

      const detail = await readFile(orgId, skillId, normalizedPath);
      if (!detail) throw notFound("Skill file not found");
      return detail;
    });
  }

  async function syncWorkspaceFileChange(orgId: string, workspaceFilePath: string, content: string): Promise<void> {
    await ensureSkillInventoryCurrent(orgId);
    const normalizedWorkspaceFilePath = normalizePortablePath(workspaceFilePath);
    if (!normalizedWorkspaceFilePath) return;

    const absoluteTargetPath = path.resolve(resolveOrganizationWorkspaceRoot(orgId), normalizedWorkspaceFilePath);
    const skills = await listFull(orgId);
    const matchingSkill = skills.find((skill) => {
      const skillDir = normalizeSkillDirectory(skill);
      if (!skillDir) return false;
      const absoluteSkillDir = path.resolve(skillDir);
      return absoluteTargetPath === path.resolve(absoluteSkillDir, "SKILL.md")
        || absoluteTargetPath.startsWith(`${absoluteSkillDir}${path.sep}`);
    });
    if (!matchingSkill) return;

    const updatePatch: Partial<typeof organizationSkills.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (absoluteTargetPath === path.resolve(normalizeSkillDirectory(matchingSkill)!, "SKILL.md")) {
      const parsed = parseFrontmatterMarkdown(content);
      updatePatch.markdown = content;
      updatePatch.name = asString(parsed.frontmatter.name) ?? matchingSkill.name;
      updatePatch.description = normalizeSkillDescription(parsed.frontmatter.description) ?? matchingSkill.description;
    }

    await db
      .update(organizationSkills)
      .set(updatePatch)
      .where(eq(organizationSkills.id, matchingSkill.id));
  }

  async function installUpdate(orgId: string, skillId: string): Promise<OrganizationSkill | null> {
    await ensureSkillInventoryCurrent(orgId);
    const skill = await getById(skillId);
    if (!skill || skill.orgId !== orgId) return null;

    const status = await updateStatus(orgId, skillId);
    if (!status?.supported) {
      throw unprocessable(status?.reason ?? "This skill does not support updates.");
    }
    if (!skill.sourceLocator) {
      throw unprocessable("Skill source locator is missing.");
    }

    const result = await readUrlSkillImports(orgId, skill.sourceLocator, skill.slug);
    const matching = result.skills.find((entry) => entry.key === skill.key) ?? result.skills[0] ?? null;
    if (!matching) {
      throw unprocessable(`Skill ${skill.key} could not be re-imported from its source.`);
    }

    return installImportedSkill(
      orgId,
      {
        ...matching,
        key: skill.key,
        slug: skill.slug,
        sourceType: skill.sourceType,
        sourceLocator: skill.sourceLocator,
        metadata: {
          ...(skill.metadata ?? {}),
          ...(matching.metadata ?? {}),
          sourceKind: asString(skill.metadata?.sourceKind)
            ?? asString(matching.metadata?.sourceKind),
        },
      },
      async (installed) => {
        const current = await getById(skill.id);
        if (!current) throw conflict(`Skill ${skill.key} no longer exists.`);
        if (!hasUnchangedInstallationSource(current, skill)) {
          throw conflict(`Skill ${skill.key} changed while update was downloading.`);
        }
        const [persisted] = await upsertImportedSkills(orgId, [installed]);
        return persisted ?? null;
      },
    );
  }

  async function ensureInstalledSkill(orgId: string, skill: OrganizationSkill) {
    const existingDirectory = normalizeSkillDirectory(skill);
    if (
      existingDirectory
      && (await fs.stat(path.join(existingDirectory, "SKILL.md")).catch(() => null))?.isFile()
    ) {
      return existingDirectory;
    }
    if (isBundledRudderSourceKind(asString(skill.metadata?.sourceKind))) {
      throw unprocessable("Bundled Rudder skill files are unavailable.");
    }

    const lockKey = `${orgId}:${skill.id}`;
    const existingInstall = skillInstallationPromises.get(lockKey);
    if (existingInstall) return existingInstall;

    const installation = (async () => {
      const target = resolveInstalledSkillDirectory(orgId, skill.key, skill.slug);
      if ((await fs.stat(path.join(target, "SKILL.md")).catch(() => null))?.isFile()) {
        return withSkillMutationLock(orgId, skill.key, async () => {
          const current = await getById(skill.id);
          if (!current) throw notFound(`Skill ${skill.key} no longer exists.`);
          if (!hasUnchangedInstallationSource(current, skill)) {
            const currentDirectory = await resolveCurrentSkillDirectory(current);
            if (currentDirectory) return currentDirectory;
            throw conflict(`Skill ${skill.key} changed while installation was prepared.`);
          }
          if (
            getSkillMeta(current).installationVersion
            !== ORGANIZATION_SKILL_INSTALLATION_VERSION
          ) {
            await db
              .update(organizationSkills)
              .set({
                metadata: {
                  ...(current.metadata ?? {}),
                  installationVersion: ORGANIZATION_SKILL_INSTALLATION_VERSION,
                },
                updatedAt: new Date(),
              })
              .where(eq(organizationSkills.id, current.id));
          }
          return target;
        });
      }

      let imported: ImportedSkill | null = null;
      if (
        skill.sourceType === "github"
        || skill.sourceType === "skills_sh"
        || skill.sourceType === "url"
      ) {
        if (!skill.sourceLocator) {
          throw unprocessable("Skill source locator is missing.");
        }
        const skillMetadata = getSkillMeta(skill);
        const owner = asString(skillMetadata.owner);
        const repo = asString(skillMetadata.repo);
        const repoSkillDir = asString(skillMetadata.repoSkillDir);
        const migrationSource = (
          (skill.sourceType === "github" || skill.sourceType === "skills_sh")
          && skill.sourceRef
          && owner
          && repo
        )
          ? `https://github.com/${owner}/${repo}/tree/${skill.sourceRef}${repoSkillDir ? `/${repoSkillDir}` : ""}`
          : skill.sourceLocator;
        const parsed = parseSkillImportSourceInput(migrationSource);
        const result = await readUrlSkillImports(
          orgId,
          parsed.resolvedSource,
          parsed.requestedSkillSlug ?? skill.slug,
        );
        imported = result.skills.find((entry) => entry.key === skill.key)
          ?? result.skills.find((entry) => entry.slug === skill.slug)
          ?? result.skills[0]
          ?? null;
      } else if (
        (skill.sourceType === "local_path" || skill.sourceType === "catalog")
        && skill.sourceLocator
      ) {
        const sourceDirectory = path.basename(skill.sourceLocator).toLowerCase() === "skill.md"
          ? path.dirname(skill.sourceLocator)
          : skill.sourceLocator;
        imported = {
          key: skill.key,
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          markdown: skill.markdown,
          packageDir: path.resolve(sourceDirectory),
          sourceType: skill.sourceType,
          sourceLocator: skill.sourceLocator,
          sourceRef: skill.sourceRef,
          trustLevel: skill.trustLevel,
          compatibility: skill.compatibility,
          fileInventory: skill.fileInventory,
          metadata: skill.metadata ?? {},
        };
      }
      if (!imported) {
        throw unprocessable(`Skill ${skill.key} could not be installed from its source.`);
      }

      const installed = markImportedSkillInstalled({
        ...imported,
        key: skill.key,
        slug: skill.slug,
        sourceType: skill.sourceType,
        sourceLocator: skill.sourceLocator,
        sourceRef: skill.sourceRef ?? imported.sourceRef,
        metadata: {
          ...(skill.metadata ?? {}),
          ...(imported.metadata ?? {}),
          sourceKind: asString(skill.metadata?.sourceKind)
            ?? asString(imported.metadata?.sourceKind),
          trackingRef: asString(skill.metadata?.trackingRef)
            ?? asString(imported.metadata?.trackingRef),
        },
      });
      const files = await readImportedSkillFiles(installed);
      return withSkillMutationLock(orgId, skill.key, async () => {
        const current = await getById(skill.id);
        if (!current) throw notFound(`Skill ${skill.key} no longer exists.`);
        if (!hasUnchangedInstallationSource(current, skill)) {
          const currentDirectory = await resolveCurrentSkillDirectory(current);
          if (currentDirectory) return currentDirectory;
          throw conflict(`Skill ${skill.key} changed while installation was prepared.`);
        }
        return replaceInstalledSkillDirectory(
          orgId,
          installed,
          files,
          async () => {
            await db
              .update(organizationSkills)
              .set({
                name: installed.name,
                description: installed.description,
                markdown: installed.markdown,
                sourceRef: installed.sourceRef,
                trustLevel: installed.trustLevel,
                compatibility: installed.compatibility,
                fileInventory: serializeFileInventory(installed.fileInventory),
                metadata: installed.metadata,
                updatedAt: new Date(),
              })
              .where(eq(organizationSkills.id, skill.id));
            return resolveInstalledSkillDirectory(orgId, skill.key, skill.slug);
          },
        );
      });
    })();

    skillInstallationPromises.set(lockKey, installation);
    try {
      return await installation;
    } finally {
      if (skillInstallationPromises.get(lockKey) === installation) {
        skillInstallationPromises.delete(lockKey);
      }
    }
  }

  async function listRuntimeSkillEntries(
    orgId: string,
    options: RuntimeSkillEntryOptions = {},
  ): Promise<RudderSkillEntry[]> {
    const skills = await listFull(orgId);

    const out: RudderSkillEntry[] = [];
    for (const skill of skills) {
      if (
        isRetiredRudderCreationSkillReference(skill.key)
        || isRetiredRudderCreationSkillReference(skill.slug)
      ) {
        continue;
      }
      let source = normalizeSkillDirectory(skill);
      if (
        source
        && !(await fs.stat(path.join(source, "SKILL.md")).catch(() => null))?.isFile()
      ) {
        source = null;
      }
      if (!source) {
        source = options.materializeMissing === false
          ? null
          : await ensureInstalledSkill(orgId, skill).catch(() => null);
      }
      if (!source) continue;

      out.push({
        key: skill.key,
        runtimeName: buildSkillRuntimeName(skill.key, skill.slug),
        source,
        name: skill.name,
        description: skill.description,
      });
    }

    out.sort((left, right) => left.key.localeCompare(right.key));
    return out;
  }

  async function importPackageFiles(
    orgId: string,
    files: Record<string, string>,
    options?: {
      onConflict?: PackageSkillConflictStrategy;
    },
  ): Promise<ImportPackageSkillResult[]> {
    await ensureSkillInventoryCurrent(orgId);
    const normalizedFiles = normalizePackageFileMap(files);
    const importedSkills = readInlineSkillImports(orgId, normalizedFiles);
    if (importedSkills.length === 0) return [];

    for (const skill of importedSkills) {
      const packageDir = skill.packageDir ? normalizePortablePath(skill.packageDir) : null;
      if (!packageDir) continue;
      const packageFiles: Record<string, string> = {};
      for (const entry of skill.fileInventory) {
        const sourcePath = entry.path === "SKILL.md"
          ? `${packageDir}/SKILL.md`
          : `${packageDir}/${entry.path}`;
        const content = normalizedFiles[sourcePath];
        if (typeof content !== "string") {
          throw unprocessable(`Skill package did not provide declared file: ${sourcePath}`);
        }
        packageFiles[entry.path] = content;
      }
      skill.files = packageFiles;
      skill.packageDir = null;
    }

    const conflictStrategy = options?.onConflict ?? "replace";
    const existingSkills = await listFull(orgId);
    const existingByKey = new Map(existingSkills.map((skill) => [skill.key, skill]));
    const existingBySlug = new Map(
      existingSkills.map((skill) => [normalizeSkillSlug(skill.slug) ?? skill.slug, skill]),
    );
    const usedSlugs = new Set(existingBySlug.keys());
    const usedKeys = new Set(existingByKey.keys());

    const toPersist: ImportedSkill[] = [];
    const prepared: Array<{
      skill: ImportedSkill;
      originalKey: string;
      originalSlug: string;
      existingBefore: OrganizationSkill | null;
      actionHint: "created" | "updated";
      reason: string | null;
    }> = [];
    const out: ImportPackageSkillResult[] = [];

    for (const importedSkill of importedSkills) {
      const originalKey = importedSkill.key;
      const originalSlug = importedSkill.slug;
      const normalizedSlug = normalizeSkillSlug(importedSkill.slug) ?? importedSkill.slug;
      const existingByIncomingKey = existingByKey.get(importedSkill.key) ?? null;
      const existingByIncomingSlug = existingBySlug.get(normalizedSlug) ?? null;
      const conflict = existingByIncomingKey ?? existingByIncomingSlug;

      if (!conflict || conflictStrategy === "replace") {
        toPersist.push(importedSkill);
        prepared.push({
          skill: importedSkill,
          originalKey,
          originalSlug,
          existingBefore: existingByIncomingKey,
          actionHint: existingByIncomingKey ? "updated" : "created",
          reason: existingByIncomingKey ? "Existing skill key matched; replace strategy." : null,
        });
        usedSlugs.add(normalizedSlug);
        usedKeys.add(importedSkill.key);
        continue;
      }

      if (conflictStrategy === "skip") {
        out.push({
          skill: conflict,
          action: "skipped",
          originalKey,
          originalSlug,
          requestedRefs: Array.from(new Set([originalKey, originalSlug])),
          reason: "Existing skill matched; skip strategy.",
        });
        continue;
      }

      const renamedSlug = uniqueSkillSlug(normalizedSlug || "skill", usedSlugs);
      const renamedKey = uniqueImportedSkillKey(orgId, renamedSlug, usedKeys);
      const renamedSkill: ImportedSkill = {
        ...importedSkill,
        slug: renamedSlug,
        key: renamedKey,
        metadata: {
          ...(importedSkill.metadata ?? {}),
          skillKey: renamedKey,
          importedFromSkillKey: originalKey,
          importedFromSkillSlug: originalSlug,
        },
      };
      toPersist.push(renamedSkill);
      prepared.push({
        skill: renamedSkill,
        originalKey,
        originalSlug,
        existingBefore: null,
        actionHint: "created",
        reason: `Existing skill matched; renamed to ${renamedSlug}.`,
      });
      usedSlugs.add(renamedSlug);
      usedKeys.add(renamedKey);
    }

    if (toPersist.length === 0) return out;

    const persisted = await installAndUpsertImportedSkills(orgId, toPersist);
    for (let index = 0; index < prepared.length; index += 1) {
      const persistedSkill = persisted[index];
      const preparedSkill = prepared[index];
      if (!persistedSkill || !preparedSkill) continue;
      out.push({
        skill: persistedSkill,
        action: preparedSkill.actionHint,
        originalKey: preparedSkill.originalKey,
        originalSlug: preparedSkill.originalSlug,
        requestedRefs: Array.from(new Set([preparedSkill.originalKey, preparedSkill.originalSlug])),
        reason: preparedSkill.reason,
      });
    }

    return out;
  }

  async function upsertImportedSkills(orgId: string, imported: ImportedSkill[]): Promise<OrganizationSkill[]> {
    const out: OrganizationSkill[] = [];
    for (const skill of imported) {
      const existing = await getByKey(orgId, skill.key);
      const existingMeta = existing ? getSkillMeta(existing) : {};
      if (
        existing
        && isBundledRudderSourceKind(asString(existingMeta.sourceKind))
      ) {
        out.push(existing);
        continue;
      }

      const metadata = {
        ...(skill.sourceType !== "local_path"
          && existingMeta.installationVersion === ORGANIZATION_SKILL_INSTALLATION_VERSION
          ? { installationVersion: ORGANIZATION_SKILL_INSTALLATION_VERSION }
          : {}),
        ...(skill.metadata ?? {}),
        skillKey: skill.key,
      };
      const values = {
        orgId,
        key: skill.key,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        markdown: skill.markdown,
        sourceType: skill.sourceType,
        sourceLocator: skill.sourceLocator,
        sourceRef: skill.sourceRef,
        trustLevel: skill.trustLevel,
        compatibility: skill.compatibility,
        fileInventory: serializeFileInventory(skill.fileInventory),
        metadata,
        updatedAt: new Date(),
      };
      const row = existing
        ? await db
          .update(organizationSkills)
          .set(values)
          .where(eq(organizationSkills.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null)
        : await db
          .insert(organizationSkills)
          .values(values)
          .returning()
          .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Failed to persist organization skill");
      out.push(toCompanySkill(row));
    }
    return out;
  }

  async function importFromSource(orgId: string, source: string): Promise<OrganizationSkillImportResult> {
    await ensureSkillInventoryCurrent(orgId);
    const parsed = parseSkillImportSourceInput(source);
    const local = !/^https?:\/\//i.test(parsed.resolvedSource);
    const { skills, warnings } = local
      ? {
        skills: (await readLocalSkillImports(orgId, parsed.resolvedSource))
          .filter((skill) => !parsed.requestedSkillSlug || skill.slug === parsed.requestedSkillSlug),
        warnings: parsed.warnings,
      }
      : await readUrlSkillImports(orgId, parsed.resolvedSource, parsed.requestedSkillSlug)
        .then((result) => ({
          skills: result.skills,
          warnings: [...parsed.warnings, ...result.warnings],
        }));
    const filteredSkills = parsed.requestedSkillSlug
      ? skills.filter((skill) => skill.slug === parsed.requestedSkillSlug)
      : skills;
    if (filteredSkills.length === 0) {
      throw unprocessable(
        parsed.requestedSkillSlug
          ? `Skill ${parsed.requestedSkillSlug} was not found in the provided source.`
          : "No skills were found in the provided source.",
      );
    }
    if (parsed.originalSkillsShUrl) {
      for (const skill of filteredSkills) {
        skill.sourceType = "skills_sh";
        skill.sourceLocator = parsed.originalSkillsShUrl;
        if (skill.metadata) {
          (skill.metadata as Record<string, unknown>).sourceKind = "skills_sh";
        }
        skill.key = deriveCanonicalSkillKey(orgId, skill);
      }
    }
    const imported = await installAndUpsertImportedSkills(orgId, filteredSkills);
    return { imported, warnings };
  }

  async function deleteSkill(orgId: string, skillId: string): Promise<OrganizationSkill | null> {
    const initial = await getById(skillId);
    if (!initial || initial.orgId !== orgId) return null;
    return withSkillMutationLock(orgId, initial.key, async () => {
      const skill = await getById(skillId);
      if (!skill || skill.orgId !== orgId) return null;
      if (isBundledRudderSourceKind(asString(getSkillMeta(skill).sourceKind))) {
        throw unprocessable("Bundled Rudder skills are read-only.");
      }

      await enabledSkills.removeSkillKeys(orgId, [skill.key]);
      await db
        .delete(organizationSkills)
        .where(eq(organizationSkills.id, skillId));
      await removeInstalledSkillDirectory(orgId, skill);
      return skill;
    });
  }

  return {
    list,
    listFull,
    getById,
    getByKey,
    resolveRequestedSkillKeys: async (orgId: string, requestedReferences: string[]) => {
      const skills = await listFull(orgId);
      return resolveRequestedSkillKeysOrThrow(skills, requestedReferences, orgId);
    },
    detail,
    updateStatus,
    readFile,
    updateFile,
    syncWorkspaceFileChange,
    createLocalSkill,
    createAgentPrivateSkill,
    deleteSkill,
    importFromSource,
    scanProjectWorkspaces,
    scanLocalSkillRoots,
    importPackageFiles,
    installUpdate,
    listRuntimeSkillEntries,
    mergeWithRequiredSkillKeys: async (
      orgId: string,
      skillKeys: string[],
    ) => {
      const skills = await listFull(orgId);
      return sortUniqueSelectionRefs(
        skillKeys.flatMap((skillKey) => {
          const normalized = normalizeSelectionRef(skillKey, skills, orgId, "claude_local");
          if (!normalized) return [];
          return parseSelectionKey(normalized).sourceClass === "bundled" ? [] : [normalized];
        }),
      );
    },
    getEnabledSkillKeysForAgent: async (
      orgId: string,
      agent: EnabledSkillsAgentRef,
    ) => getEnabledSkillSelectionRefsForAgent(orgId, agent),
    buildAgentSkillSnapshot,
    resolveDesiredSkillSelectionForAgent,
    listRealizedSkillEntriesForAgent,
    replaceEnabledSkillKeysForAgent: async (
      orgId: string,
      agentId: string,
      skillKeys: string[],
    ) => enabledSkills.replaceKeys(orgId, agentId, sortUniqueSelectionRefs(skillKeys)),
    addEnabledSkillKeysForAgent: async (
      orgId: string,
      agentId: string,
      skillKeys: string[],
    ) => enabledSkills.addMissingKeys(orgId, agentId, sortUniqueSelectionRefs(skillKeys)),
  };
}
