import { promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import { agents as agentRows, organizationSkills } from "@rudderhq/db";
import { readRudderSkillSyncPreference, writeRudderSkillSyncPreference } from "@rudderhq/agent-runtime-utils/server-utils";
import type { RudderSkillEntry } from "@rudderhq/agent-runtime-utils/server-utils";
import type {
  AgentSkillEntry,
  AgentSkillSnapshot,
  AgentSkillSyncMode,
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
  RUDDER_BUNDLED_SKILL_SLUGS,
  getBundledRudderSkillSlug,
  toBundledRudderSkillKey,
} from "@rudderhq/shared";
import {
  resolveAgentSkillsDir,
  resolveOrganizationSkillsDir,
  resolveOrganizationWorkspaceRoot,
} from "../../home-paths.js";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { agentEnabledSkillsService } from "../agent-enabled-skills.js";
import { agentService } from "../agents.js";
import { projectService } from "../projects.js";

import {
  ADAPTER_SKILL_HOME_DEFINITIONS,
  CANONICAL_BUNDLED_SKILL_KEYS,
  COMMUNITY_PRESET_SKILLS,
  COMMUNITY_PRESET_SKILL_SLUGS,
  AgentSkillCatalogEntry,
  AgentSkillSelectionResolution,
  AgentWorkspaceRow,
  EnabledSkillsAgentRef,
  ImportPackageSkillResult,
  ImportedSkill,
  PackageSkillConflictStrategy,
  RuntimeSkillEntryOptions,
  applyDesiredSelectionsToCatalog,
  arraysEqual,
  asString,
  buildAdapterSelectionKey,
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
  normalizeGitHubSkillDirectory,
  normalizePackageFileMap,
  normalizePortablePath,
  normalizeSelectionRef,
  normalizeSkillDescription,
  normalizeSkillDirectory,
  normalizeSkillSlug,
  normalizeSourceLocatorDirectory,
  parseSelectionKey,
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
  uniqueSkillSlug,
} from "./organization-skills.catalog.js";
import {
  fetchText,
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
  resolveRawGitHubUrl,
} from "./organization-skills.sources.js";
import { createOrganizationSkillScanHandlers } from "./organization-skills.scans.js";

export function organizationSkillService(db: Db) {
  const agents = agentService(db);
  const enabledSkills = agentEnabledSkillsService(db);
  const projects = projectService(db);
  const { scanProjectWorkspaces, scanLocalSkillRoots } = createOrganizationSkillScanHandlers({
    ensureSkillInventoryCurrent,
    listFull,
    projects,
    upsertImportedSkills,
  });

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
    for (const skillsRoot of resolveBundledSkillsRoot()) {
      const stats = await fs.stat(skillsRoot).catch(() => null);
      if (!stats?.isDirectory()) continue;
      let bundledSkillCandidates: Array<ImportedSkill | null> = [];
      try {
        bundledSkillCandidates = await Promise.all(
          RUDDER_BUNDLED_SKILL_SLUGS.map(async (slug) => {
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
      const staleBundledIds = listStaleBundledSkillIds(existingRows, Array.from(CANONICAL_BUNDLED_SKILL_KEYS));
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
      return asString((existing.metadata as Record<string, unknown> | null | undefined)?.sourceKind) === "community_preset";
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
      await fs.rm(resolveRuntimeSkillMaterializedPath(orgId, skill), { recursive: true, force: true });
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
      await fs.rm(resolveRuntimeSkillMaterializedPath(orgId, skill), { recursive: true, force: true });
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

    const adapterHome = ADAPTER_SKILL_HOME_DEFINITIONS[agentRuntimeType];
    if (adapterHome) {
      entries.push(...await readDiscoveredSkillEntries(
        orgId,
        adapterHome.resolveRoot(runtimeConfig),
        (slug) => buildAdapterSelectionKey(agentRuntimeType, slug),
        {
          sourceClass: "adapter_home",
          originLabel: "Adapter skill",
          locationLabel: adapterHome.locationLabel,
        },
      ));
    }

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
        if (!source) {
          source = options.materializeMissing === false
            ? resolveRuntimeSkillMaterializedPath(orgId, skill)
            : await materializeRuntimeSkillFiles(orgId, skill).catch(() => null);
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

    const normalizedPath = normalizePortablePath(relativePath || "SKILL.md");
    const fileEntry = skill.fileInventory.find((entry) => entry.path === normalizedPath);
    if (!fileEntry) {
      throw notFound("Skill file not found");
    }

    const source = deriveSkillSourceInfo(skill);
    let content = "";

    if (skill.sourceType === "local_path" || skill.sourceType === "catalog") {
      const absolutePath = resolveLocalSkillFilePath(skill, normalizedPath);
      if (absolutePath) {
        content = await fs.readFile(absolutePath, "utf8");
      } else if (normalizedPath === "SKILL.md") {
        content = skill.markdown;
      } else {
        throw notFound("Skill file not found");
      }
    } else if (skill.sourceType === "github" || skill.sourceType === "skills_sh") {
      const metadata = getSkillMeta(skill);
      const owner = asString(metadata.owner);
      const repo = asString(metadata.repo);
      const ref = skill.sourceRef ?? asString(metadata.ref) ?? "main";
      const repoSkillDir = normalizeGitHubSkillDirectory(asString(metadata.repoSkillDir), skill.slug);
      if (!owner || !repo) {
        throw unprocessable("Skill source metadata is incomplete.");
      }
      const repoPath = normalizePortablePath(path.posix.join(repoSkillDir, normalizedPath));
      content = await fetchText(resolveRawGitHubUrl(owner, repo, ref, repoPath));
    } else if (skill.sourceType === "url") {
      if (normalizedPath !== "SKILL.md") {
        throw notFound("This skill source only exposes SKILL.md");
      }
      content = skill.markdown;
    } else {
      throw unprocessable("Unsupported skill source.");
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
    if (!source.editable || skill.sourceType !== "local_path") {
      throw unprocessable(source.editableReason ?? "This skill cannot be edited.");
    }

    const normalizedPath = normalizePortablePath(relativePath);
    const absolutePath = resolveLocalSkillFilePath(skill, normalizedPath);
    if (!absolutePath) throw notFound("Skill file not found");

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");

    if (normalizedPath === "SKILL.md") {
      const parsed = parseFrontmatterMarkdown(content);
      await db
        .update(organizationSkills)
        .set({
          name: asString(parsed.frontmatter.name) ?? skill.name,
          description: normalizeSkillDescription(parsed.frontmatter.description) ?? skill.description,
          markdown: content,
          updatedAt: new Date(),
        })
        .where(eq(organizationSkills.id, skill.id));
    } else {
      await db
        .update(organizationSkills)
        .set({ updatedAt: new Date() })
        .where(eq(organizationSkills.id, skill.id));
    }

    const detail = await readFile(orgId, skillId, normalizedPath);
    if (!detail) throw notFound("Skill file not found");
    return detail;
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

    const imported = await upsertImportedSkills(orgId, [matching]);
    return imported[0] ?? null;
  }

  async function materializeCatalogSkillFiles(
    orgId: string,
    skill: ImportedSkill,
    normalizedFiles: Record<string, string>,
  ) {
    const packageDir = skill.packageDir ? normalizePortablePath(skill.packageDir) : null;
    if (!packageDir) return null;
    const catalogRoot = path.resolve(resolveManagedSkillsRoot(orgId), "__catalog__");
    const skillDir = path.resolve(catalogRoot, buildSkillRuntimeName(skill.key, skill.slug));
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });

    for (const entry of skill.fileInventory) {
      const sourcePath = entry.path === "SKILL.md"
        ? `${packageDir}/SKILL.md`
        : `${packageDir}/${entry.path}`;
      const content = normalizedFiles[sourcePath];
      if (typeof content !== "string") continue;
      const targetPath = path.resolve(skillDir, entry.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");
    }

    return skillDir;
  }

  async function materializeRuntimeSkillFiles(orgId: string, skill: OrganizationSkill) {
    const runtimeRoot = path.resolve(resolveManagedSkillsRoot(orgId), "__runtime__");
    const skillDir = path.resolve(runtimeRoot, buildSkillRuntimeName(skill.key, skill.slug));
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });

    for (const entry of skill.fileInventory) {
      const detail = await readFile(orgId, skill.id, entry.path).catch(() => null);
      if (!detail) continue;
      const targetPath = path.resolve(skillDir, entry.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, detail.content, "utf8");
    }

    return skillDir;
  }

  function resolveRuntimeSkillMaterializedPath(orgId: string, skill: OrganizationSkill) {
    const runtimeRoot = path.resolve(resolveManagedSkillsRoot(orgId), "__runtime__");
    return path.resolve(runtimeRoot, buildSkillRuntimeName(skill.key, skill.slug));
  }

  async function listRuntimeSkillEntries(
    orgId: string,
    options: RuntimeSkillEntryOptions = {},
  ): Promise<RudderSkillEntry[]> {
    const skills = await listFull(orgId);

    const out: RudderSkillEntry[] = [];
    for (const skill of skills) {
      let source = normalizeSkillDirectory(skill);
      if (!source) {
        source = options.materializeMissing === false
          ? resolveRuntimeSkillMaterializedPath(orgId, skill)
          : await materializeRuntimeSkillFiles(orgId, skill).catch(() => null);
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
      if (skill.sourceType !== "catalog") continue;
      const materializedDir = await materializeCatalogSkillFiles(orgId, skill, normalizedFiles);
      if (materializedDir) {
        skill.sourceLocator = materializedDir;
      }
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

    const persisted = await upsertImportedSkills(orgId, toPersist);
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
      const incomingMeta = skill.metadata && isPlainRecord(skill.metadata) ? skill.metadata : {};
      const incomingOwner = asString(incomingMeta.owner);
      const incomingRepo = asString(incomingMeta.repo);
      const incomingKind = asString(incomingMeta.sourceKind);
      if (
        existing
        && isBundledRudderSourceKind(asString(existingMeta.sourceKind))
        && incomingKind === "github"
        && incomingOwner === "rudder"
        && incomingRepo === "rudder"
      ) {
        out.push(existing);
        continue;
      }

      const metadata = {
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
    const imported = await upsertImportedSkills(orgId, filteredSkills);
    return { imported, warnings };
  }

  async function deleteSkill(orgId: string, skillId: string): Promise<OrganizationSkill | null> {
    const row = await db
      .select()
      .from(organizationSkills)
      .where(and(eq(organizationSkills.id, skillId), eq(organizationSkills.orgId, orgId)))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;

    const skill = toCompanySkill(row);

    await enabledSkills.removeSkillKeys(orgId, [skill.key]);

    await db
      .delete(organizationSkills)
      .where(eq(organizationSkills.id, skillId));

    await fs.rm(resolveRuntimeSkillMaterializedPath(orgId, skill), { recursive: true, force: true });

    return skill;
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
