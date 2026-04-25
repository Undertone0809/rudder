import {
  definePlugin,
  runWorker,
  type PluginConfigValidationResult,
  type PluginContext,
} from "@rudder/plugin-sdk";
import type { Issue, Organization, Project } from "@rudder/shared";
import {
  ACTION_KEYS,
  DATA_KEYS,
  ENTITY_TYPE_LINEAR_ISSUE_LINK,
  ISSUE_LINK_STATE_KEY,
  LINEAR_IMPORT_ALL_LIMIT,
} from "./constants.js";
import { createLinearApiClient, isFixtureMode } from "./linear-api.js";
import type {
  ImportLinearIssuesActionInput,
  ImportLinearIssuesActionResult,
  ImportedLinearLink,
  IssueLinkData,
  LinearIssueListFilters,
  LinearIssueSummary,
  LinearLinkState,
  LinearOrganizationMapping,
  LinearPluginConfig,
  LinearTeamMapping,
  PageBootstrapData,
  SettingsCatalogData,
  SettingsBootstrapData,
} from "./types.js";

function emptyConfig(): LinearPluginConfig {
  return {
    apiTokenSecretRef: "",
    organizationMappings: [],
  };
}

export function normalizeConfig(raw: LinearPluginConfig | Record<string, unknown> | undefined | null): LinearPluginConfig {
  return {
    ...emptyConfig(),
    ...(raw as LinearPluginConfig),
    organizationMappings: Array.isArray((raw as LinearPluginConfig | undefined)?.organizationMappings)
      ? ((raw as LinearPluginConfig).organizationMappings ?? [])
      : [],
  };
}

async function getConfig(ctx: PluginContext): Promise<LinearPluginConfig> {
  return normalizeConfig(await ctx.config.get());
}

function adaptHostFetch(fetchImpl: PluginContext["http"]["fetch"]) {
  return async (input: string | URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : String(input);
    return await fetchImpl(url, init);
  };
}

function requireOrgId(params: Record<string, unknown>): string {
  const orgId = typeof params.orgId === "string" ? params.orgId : "";
  if (!orgId) throw new Error("orgId is required");
  return orgId;
}

function getOrgMapping(config: LinearPluginConfig, orgId: string): LinearOrganizationMapping | null {
  return config.organizationMappings.find((mapping) => mapping.orgId === orgId) ?? null;
}

function getAllowedTeamIds(mapping: LinearOrganizationMapping): string[] {
  return mapping.teamMappings.map((team) => team.teamId);
}

function sanitizeFilters(
  params: Record<string, unknown>,
  allowedTeamIds: string[],
): LinearIssueListFilters {
  return {
    allowedTeamIds,
    teamId: typeof params.teamId === "string" && params.teamId ? params.teamId : undefined,
    stateId: typeof params.stateId === "string" && params.stateId ? params.stateId : undefined,
    projectId: typeof params.projectId === "string" && params.projectId ? params.projectId : undefined,
    assigneeId: typeof params.assigneeId === "string" && params.assigneeId ? params.assigneeId : undefined,
    query: typeof params.query === "string" && params.query.trim() ? params.query.trim() : undefined,
  };
}

async function resolveLinearClient(ctx: PluginContext, orgId: string) {
  const config = await getConfig(ctx);
  const mapping = getOrgMapping(config, orgId);
  if (!config.apiTokenSecretRef) throw new Error("Add a Linear token in plugin settings.");
  if (!mapping) throw new Error("Connect Linear for this Rudder organization before importing issues.");
  const token = await ctx.secrets.resolve(config.apiTokenSecretRef);
  const client = createLinearApiClient(token, adaptHostFetch(ctx.http.fetch), {
    fixtureMode: config.fixtureMode === true,
  });
  return { client, config, mapping };
}

async function resolveLinearSettingsClient(ctx: PluginContext) {
  const config = await getConfig(ctx);
  if (!config.apiTokenSecretRef) throw new Error("Add a Linear token first.");
  const token = await ctx.secrets.resolve(config.apiTokenSecretRef);
  const client = createLinearApiClient(token, adaptHostFetch(ctx.http.fetch), {
    fixtureMode: config.fixtureMode === true,
  });
  return { client, config };
}

async function listAllLinearLinks(ctx: PluginContext): Promise<LinearLinkState[]> {
  const links: LinearLinkState[] = [];
  let offset = 0;
  const pageSize = 200;
  while (offset <= 5000) {
    const page = await ctx.entities.list({
      entityType: ENTITY_TYPE_LINEAR_ISSUE_LINK,
      limit: pageSize,
      offset,
    });
    if (page.length === 0) break;
    for (const record of page) {
      const data = record.data as Partial<LinearLinkState>;
      if (!data.externalId || !data.rudderIssueId) continue;
      links.push({
        externalId: String(data.externalId),
        linearIdentifier: String(data.linearIdentifier ?? record.title ?? data.externalId),
        linearTitle: String(data.linearTitle ?? record.title ?? ""),
        linearUrl: String(data.linearUrl ?? ""),
        orgId: String(data.orgId ?? ""),
        rudderIssueId: String(data.rudderIssueId),
        rudderIssueIdentifier: typeof data.rudderIssueIdentifier === "string" ? data.rudderIssueIdentifier : null,
        teamId: String(data.teamId ?? ""),
        teamName: String(data.teamName ?? ""),
        projectId: typeof data.projectId === "string" ? data.projectId : null,
        projectName: typeof data.projectName === "string" ? data.projectName : null,
        stateId: String(data.stateId ?? ""),
        stateName: String(data.stateName ?? record.status ?? ""),
        importedAt: String(data.importedAt ?? record.createdAt),
        updatedAt: String(data.updatedAt ?? record.updatedAt),
      });
    }
    if (page.length < pageSize) break;
    offset += page.length;
  }
  return links;
}

async function buildImportedLinkIndex(ctx: PluginContext): Promise<Map<string, ImportedLinearLink>> {
  const index = new Map<string, ImportedLinearLink>();
  const links = await listAllLinearLinks(ctx);
  for (const link of links) {
    index.set(link.externalId, {
      externalId: link.externalId,
      rudderIssueId: link.rudderIssueId,
      rudderIssueIdentifier: link.rudderIssueIdentifier,
      orgId: link.orgId,
    });
  }
  return index;
}

function findTeamMapping(mapping: LinearOrganizationMapping, issue: LinearIssueSummary): LinearTeamMapping | null {
  return mapping.teamMappings.find((team) => team.teamId === issue.team.id) ?? null;
}

function assertIssueTeamAllowed(mapping: LinearOrganizationMapping, issue: LinearIssueSummary): void {
  if (findTeamMapping(mapping, issue)) return;
  throw new Error(
    `Linear issue ${issue.identifier} belongs to team ${issue.team.name} (${issue.team.id}), which is not allowed for this Rudder organization.`,
  );
}

export function resolveMappedStatus(mapping: LinearOrganizationMapping, issue: LinearIssueSummary): {
  status: Issue["status"];
  fallback: boolean;
} {
  const teamMapping = findTeamMapping(mapping, issue);
  const status = teamMapping?.stateMappings.find((entry) => entry.linearStateId === issue.state.id)?.rudderStatus;
  return {
    status: status ?? "backlog",
    fallback: !status,
  };
}

function resolveFinalImportStatus(status: Issue["status"]): {
  status: Issue["status"];
  adjusted: boolean;
} {
  if (status === "in_progress") {
    return {
      status: "todo",
      adjusted: true,
    };
  }
  return {
    status,
    adjusted: false,
  };
}

export function buildIssueDescription(issue: LinearIssueSummary): string {
  const sourceBlock = [
    "Source: Linear",
    `Linear Issue: ${issue.identifier}`,
    `Linear URL: ${issue.url}`,
  ].join("\n");

  if (issue.description?.trim()) {
    return `${issue.description.trim()}\n\n---\n${sourceBlock}`;
  }
  return sourceBlock;
}

async function buildSettingsBootstrap(ctx: PluginContext): Promise<SettingsBootstrapData> {
  const config = await getConfig(ctx);
  const organizations = await ctx.organizations.list({ limit: 200, offset: 0 }) as Array<Pick<Organization, "id" | "name" | "issuePrefix">>;
  return {
    config,
    organizations,
    fixtureMode: config.fixtureMode === true || isFixtureMode(),
  };
}

async function buildSettingsCatalog(ctx: PluginContext, params: Record<string, unknown>): Promise<SettingsCatalogData> {
  const { client } = await resolveLinearSettingsClient(ctx);
  const orgId = typeof params.orgId === "string" && params.orgId ? params.orgId : null;
  const catalog = await client.getCatalog();
  return {
    orgId,
    ...catalog,
  };
}

async function buildPageBootstrap(ctx: PluginContext, orgId: string): Promise<PageBootstrapData> {
  const config = await getConfig(ctx);
  const mapping = getOrgMapping(config, orgId);
  const projects = await ctx.projects.list({ orgId, limit: 200, offset: 0 }) as Array<Pick<Project, "id" | "name">>;
  if (!config.apiTokenSecretRef) {
    return {
      configured: false,
      message: "Connect Linear in plugin settings before importing issues.",
      projects,
      teamMappings: [],
    };
  }
  if (!mapping) {
    return {
      configured: false,
      message: "Refresh Linear settings for this Rudder organization before importing issues.",
      projects,
      teamMappings: [],
    };
  }
  if (mapping.teamMappings.length === 0) {
    return {
      configured: false,
      message: "Add at least one allowed Linear team for this organization.",
      projects,
      teamMappings: [],
    };
  }
  return {
    configured: true,
    message: null,
    projects,
    teamMappings: mapping.teamMappings,
  };
}

async function findIssueLink(ctx: PluginContext, orgId: string, issueId: string): Promise<LinearLinkState | null> {
  const direct = await ctx.state.get({
    scopeKind: "issue",
    scopeId: issueId,
    stateKey: ISSUE_LINK_STATE_KEY,
  }) as LinearLinkState | null;
  if (direct?.externalId) return direct;
  const links = await listAllLinearLinks(ctx);
  return links.find((link) => link.orgId === orgId && link.rudderIssueId === issueId) ?? null;
}

async function storeIssueLink(
  ctx: PluginContext,
  orgId: string,
  rudderIssue: { id: string; identifier?: string | null },
  linearIssue: LinearIssueSummary,
): Promise<LinearLinkState> {
  const link: LinearLinkState = {
    externalId: linearIssue.id,
    linearIdentifier: linearIssue.identifier,
    linearTitle: linearIssue.title,
    linearUrl: linearIssue.url,
    orgId,
    rudderIssueId: rudderIssue.id,
    rudderIssueIdentifier: rudderIssue.identifier ?? null,
    teamId: linearIssue.team.id,
    teamName: linearIssue.team.name,
    projectId: linearIssue.project?.id ?? null,
    projectName: linearIssue.project?.name ?? null,
    stateId: linearIssue.state.id,
    stateName: linearIssue.state.name,
    importedAt: new Date().toISOString(),
    updatedAt: linearIssue.updatedAt,
  };

  await ctx.entities.upsert({
    entityType: ENTITY_TYPE_LINEAR_ISSUE_LINK,
    scopeKind: "issue",
    scopeId: rudderIssue.id,
    externalId: linearIssue.id,
    title: `${linearIssue.identifier} ${linearIssue.title}`,
    status: linearIssue.state.name,
    data: link,
  });
  await ctx.state.set(
    { scopeKind: "issue", scopeId: rudderIssue.id, stateKey: ISSUE_LINK_STATE_KEY },
    link,
  );
  return link;
}

async function importIssuesAction(
  ctx: PluginContext,
  input: ImportLinearIssuesActionInput,
): Promise<ImportLinearIssuesActionResult> {
  if (!input.orgId) throw new Error("orgId is required");
  if (!input.targetProjectId) throw new Error("Choose a target project before importing.");

  const project = await ctx.projects.get(input.targetProjectId, input.orgId);
  if (!project) throw new Error("Selected Rudder project was not found.");

  const { client, mapping } = await resolveLinearClient(ctx, input.orgId);
  const importedIndex = await buildImportedLinkIndex(ctx);
  const allowedTeamIds = getAllowedTeamIds(mapping);
  const filters = sanitizeFilters((input.filters ?? {}) as Record<string, unknown>, allowedTeamIds);

  let candidates: LinearIssueSummary[] = [];
  if (input.mode === "allMatching") {
    const batch = await client.listIssues(filters, LINEAR_IMPORT_ALL_LIMIT + 1);
    if (batch.nodes.length > LINEAR_IMPORT_ALL_LIMIT) {
      throw new Error(`Import all is limited to ${LINEAR_IMPORT_ALL_LIMIT} matching issues. Narrow the filters and try again.`);
    }
    candidates = batch.nodes;
  } else {
    const issueIds = Array.isArray(input.issueIds) ? input.issueIds.filter(Boolean) : [];
    if (issueIds.length === 0) {
      throw new Error("Select at least one Linear issue to import.");
    }
    candidates = (await Promise.all(issueIds.map((issueId) => client.getIssue(issueId)))).filter(Boolean) as LinearIssueSummary[];
  }

  const duplicateIssueIds: string[] = [];
  const importedIssues: ImportLinearIssuesActionResult["importedIssues"] = [];

  for (const linearIssue of candidates) {
    assertIssueTeamAllowed(mapping, linearIssue);
    const duplicate = importedIndex.get(linearIssue.id);
    if (duplicate) {
      duplicateIssueIds.push(linearIssue.id);
      continue;
    }

    const mapped = resolveMappedStatus(mapping, linearIssue);
    const resolvedStatus = resolveFinalImportStatus(mapped.status);
    const created = await ctx.issues.create({
      orgId: input.orgId,
      projectId: input.targetProjectId,
      title: linearIssue.title,
      description: buildIssueDescription(linearIssue),
      status: resolvedStatus.status,
      priority: "medium",
    });
    const link = await storeIssueLink(ctx, input.orgId, created, linearIssue);
    await ctx.activity.log({
      orgId: input.orgId,
      entityType: "issue",
      entityId: created.id,
      message: `Imported Linear issue ${linearIssue.identifier}`,
      metadata: {
        linearIssueId: linearIssue.id,
        linearIdentifier: linearIssue.identifier,
        targetProjectId: input.targetProjectId,
        fallbackStatus: mapped.fallback,
        adjustedStatus: resolvedStatus.adjusted,
        mappedStatus: mapped.status,
        finalStatus: resolvedStatus.status,
      },
    });
    importedIndex.set(linearIssue.id, {
      externalId: linearIssue.id,
      rudderIssueId: created.id,
      rudderIssueIdentifier: created.identifier ?? null,
      orgId: input.orgId,
    });
    importedIssues.push({
      linearId: linearIssue.id,
      rudderIssueId: link.rudderIssueId,
      rudderIssueIdentifier: link.rudderIssueIdentifier,
      fallbackStatus: mapped.fallback,
      adjustedStatus: resolvedStatus.adjusted,
      finalStatus: resolvedStatus.status,
    });
  }

  return {
    importedCount: importedIssues.length,
    duplicateCount: duplicateIssueIds.length,
    fallbackCount: importedIssues.filter((issue) => issue.fallbackStatus).length,
    adjustedCount: importedIssues.filter((issue) => issue.adjustedStatus).length,
    importedIssues,
    duplicateIssueIds,
  };
}

async function validateConfig(ctx: PluginContext, config: LinearPluginConfig): Promise<PluginConfigValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.apiTokenSecretRef?.trim()) {
    errors.push("Linear token is required.");
  }
  if (!Array.isArray(config.organizationMappings) || config.organizationMappings.length === 0) {
    warnings.push("No Rudder organization has been prepared for import yet. Use Refresh from Linear in settings.");
  }

  const seenOrgs = new Set<string>();
  for (const mapping of config.organizationMappings ?? []) {
    if (!mapping.orgId) {
      errors.push("Each Rudder organization setup must choose an organization.");
      continue;
    }
    if (seenOrgs.has(mapping.orgId)) {
      errors.push(`This Rudder organization is configured more than once: ${mapping.orgId}`);
    }
    seenOrgs.add(mapping.orgId);
    const seenTeams = new Set<string>();
    if (!Array.isArray(mapping.teamMappings) || mapping.teamMappings.length === 0) {
      errors.push(`Organization ${mapping.orgId} must include at least one Linear team.`);
      continue;
    }
    for (const team of mapping.teamMappings) {
      if (!team.teamId?.trim()) {
        errors.push(`Organization ${mapping.orgId} has a Linear team choice with no team.`);
        continue;
      }
      if (seenTeams.has(team.teamId)) {
        errors.push(`Linear team ${team.teamName ?? team.teamId} is selected more than once.`);
      }
      seenTeams.add(team.teamId);
      for (const stateMapping of team.stateMappings ?? []) {
        if (stateMapping.rudderStatus === "in_progress") {
          warnings.push(
            `Linear team ${team.teamName ?? team.teamId} has a status rule that imports as in progress. Imports stay unassigned in v1, so those issues are downgraded to todo.`,
          );
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  try {
    const token = await ctx.secrets.resolve(config.apiTokenSecretRef!.trim());
    const client = createLinearApiClient(token, adaptHostFetch(ctx.http.fetch), {
      fixtureMode: config.fixtureMode === true,
    });
    await client.getViewer();
    if (config.fixtureMode === true || isFixtureMode()) {
      warnings.push("Linear fixture mode is enabled; external API calls are stubbed.");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, warnings };
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    currentContext = ctx;
    ctx.data.register(DATA_KEYS.settingsBootstrap, async () => {
      return await buildSettingsBootstrap(ctx);
    });

    ctx.data.register(DATA_KEYS.pageBootstrap, async (params: Record<string, unknown>) => {
      return await buildPageBootstrap(ctx, requireOrgId(params));
    });

    ctx.data.register(DATA_KEYS.settingsCatalog, async (params: Record<string, unknown>) => {
      return await buildSettingsCatalog(ctx, params);
    });

    ctx.data.register(DATA_KEYS.catalog, async (params: Record<string, unknown>) => {
      const orgId = requireOrgId(params);
      try {
        const { client, mapping } = await resolveLinearClient(ctx, orgId);
        const catalog = await client.getCatalog(getAllowedTeamIds(mapping));
        return {
          orgId,
          ...catalog,
        };
      } catch {
        return {
          orgId,
          teams: [],
          projects: [],
          users: [],
        };
      }
    });

    ctx.data.register(DATA_KEYS.issues, async (params: Record<string, unknown>) => {
      const orgId = requireOrgId(params);
      try {
        const { client, mapping } = await resolveLinearClient(ctx, orgId);
        const limit = typeof params.limit === "number" ? Math.max(1, Math.min(100, Math.floor(params.limit))) : 25;
        const after = typeof params.after === "string" && params.after ? params.after : undefined;
        const filters = sanitizeFilters(params, getAllowedTeamIds(mapping));
        const importedIndex = await buildImportedLinkIndex(ctx);
        const connection = await client.listIssues(filters, limit, after);
        return {
          rows: connection.nodes.map((issue) => {
            const imported = importedIndex.get(issue.id) ?? null;
            return {
              ...issue,
              imported: Boolean(imported),
              importedRudderIssueId: imported?.rudderIssueId ?? null,
              importedRudderIssueIdentifier: imported?.rudderIssueIdentifier ?? null,
              importedOrgId: imported?.orgId ?? null,
            };
          }),
          endCursor: connection.endCursor,
          hasNextPage: connection.hasNextPage,
          totalShown: connection.nodes.length,
        };
      } catch {
        return {
          rows: [],
          endCursor: null,
          hasNextPage: false,
          totalShown: 0,
        };
      }
    });

    ctx.data.register(DATA_KEYS.issueLink, async (params: Record<string, unknown>): Promise<IssueLinkData> => {
      const orgId = requireOrgId(params);
      const issueId = typeof params.issueId === "string" ? params.issueId : "";
      if (!issueId) throw new Error("issueId is required");
      const issue = await ctx.issues.get(issueId, orgId);
      if (!issue) throw new Error("Rudder issue not found");
      const link = await findIssueLink(ctx, orgId, issueId);
      if (!link) {
        return {
          linked: false,
          issueTitle: issue.title,
          searchQuery: issue.title,
        };
      }
      try {
        const { client } = await resolveLinearClient(ctx, orgId);
        const latestIssue = await client.getIssue(link.externalId);
        return {
          linked: true,
          issueTitle: issue.title,
          link,
          latestIssue,
          staleReason: latestIssue ? null : "The linked Linear issue could not be fetched; showing the last imported snapshot.",
        };
      } catch (error) {
        return {
          linked: true,
          issueTitle: issue.title,
          link,
          latestIssue: null,
          staleReason: error instanceof Error ? error.message : String(error),
        };
      }
    });

    ctx.actions.register(ACTION_KEYS.importIssues, async (params: Record<string, unknown>) => {
      return await importIssuesAction(ctx, params as unknown as ImportLinearIssuesActionInput);
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Linear plugin worker is running.",
      details: {
        fixtureMode: isFixtureMode(),
      },
    };
  },

  async onValidateConfig(config: Record<string, unknown>) {
    if (!currentContext) {
      return {
        ok: false,
        errors: ["Plugin context is not ready for configuration validation."],
      };
    }
    return await validateConfig(currentContext, normalizeConfig(config as LinearPluginConfig));
  },
});

let currentContext: PluginContext | null = null;

export default plugin;
runWorker(plugin, import.meta.url);
