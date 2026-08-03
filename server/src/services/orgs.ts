import type { Db } from "@rudderhq/db";
import {
  activityLog,
  agentApiKeys,
  agentConfigRevisions,
  agentRuntimeState,
  agents,
  agentTaskSessions,
  agentWakeupRequests,
  approvalComments,
  approvals,
  assets,
  budgetIncidents,
  budgetPolicies,
  chatAttachments,
  chatContextLinks,
  chatConversations,
  chatMessages,
  costEvents,
  costMonthlySpendRollups,
  documentRevisions,
  documents,
  executionWorkspaces,
  financeEvents,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  invites,
  issueApprovals,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueReadStates,
  issues,
  issueWorkProducts,
  joinRequests,
  labels,
  organizationIssuePrefixAliases,
  organizationLogos,
  organizationMemberships,
  organizations,
  organizationSecrets,
  organizationSkills,
  principalPermissionGrants,
  projectGoals,
  projects,
  projectWorkspaces,
  workspaceOperations,
  workspaceRuntimeServices,
} from "@rudderhq/db";
import {
  deriveOrganizationIssueKey,
  deriveOrganizationUrlKey,
  normalizeOrganizationIssueKey,
} from "@rudderhq/shared";
import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { conflict, notFound, unprocessable } from "../errors.js";
import { ensureOrganizationWorkspaceLayout, removeOrganizationStorage } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { isPostgresError } from "./postgres-errors.js";
import { recordProductAnalyticsEvent } from "./product-analytics.js";

type OrganizationCreationPath = "onboarding" | "manual" | "import" | "fixture";
type OrganizationCreateInput = typeof organizations.$inferInsert & {
  analytics?: {
    creationPath?: OrganizationCreationPath;
    templateKind?: string;
    isUserInitiated?: boolean;
  };
};

export function organizationService(db: Db) {
  const DEFAULT_ISSUE_LABELS = [
    { name: "Bug", color: "#ef4444" },
    { name: "Feature", color: "#a855f7" },
    { name: "UI", color: "#06b6d4" },
  ] as const;

  const companySelection = {
    id: organizations.id,
    urlKey: organizations.urlKey,
    name: organizations.name,
    description: organizations.description,
    status: organizations.status,
    pauseReason: organizations.pauseReason,
    pausedAt: organizations.pausedAt,
    issuePrefix: organizations.issuePrefix,
    issueCounter: organizations.issueCounter,
    budgetMonthlyCents: organizations.budgetMonthlyCents,
    spentMonthlyCents: organizations.spentMonthlyCents,
    requireBoardApprovalForNewAgents: organizations.requireBoardApprovalForNewAgents,
    defaultChatIssueCreationMode: organizations.defaultChatIssueCreationMode,
    brandColor: organizations.brandColor,
    logoAssetId: organizationLogos.assetId,
    createdAt: organizations.createdAt,
    updatedAt: organizations.updatedAt,
  };

  function enrichCompany<T extends { logoAssetId: string | null }>(organization: T, issuePrefixAliases: string[] = []) {
    return {
      ...organization,
      issuePrefixAliases,
      workspace: null,
      logoUrl: organization.logoAssetId ? `/api/assets/${organization.logoAssetId}/content` : null,
    };
  }

  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  async function getMonthlySpendByCompanyIds(
    orgIds: string[],
    database: Pick<Db, "select"> = db,
  ) {
    if (orgIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await database
      .select({
        orgId: costEvents.orgId,
        spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      })
      .from(costEvents)
      .where(
        and(
          inArray(costEvents.orgId, orgIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.orgId);
    return new Map(rows.map((row) => [row.orgId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateCompanySpend<T extends { id: string; spentMonthlyCents: number }>(
    rows: T[],
    database: Pick<Db, "select"> = db,
  ) {
    const spendByCompanyId = await getMonthlySpendByCompanyIds(rows.map((row) => row.id), database);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByCompanyId.get(row.id) ?? 0,
    }));
  }

  function getCompanyQuery(database: Pick<Db, "select">) {
    return database
      .select(companySelection)
      .from(organizations)
      .leftJoin(organizationLogos, eq(organizationLogos.orgId, organizations.id));
  }

  function suffixForUrlKeyAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return `-${attempt}`;
  }

  function suffixForIssueKeyAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return String(attempt);
  }

  function isUniqueConstraintConflict(error: unknown, constraintName: string) {
    return isPostgresError(error, "23505", constraintName);
  }

  async function isRouteKeyOwnedByAnotherOrganization(
    database: Pick<Db, "select">,
    routeKey: string,
    allowedOrgId?: string,
  ) {
    const organizationOwner = await database
      .select({ id: organizations.id })
      .from(organizations)
      .where(sql`
        lower(${organizations.urlKey}) = lower(${routeKey})
        or lower(${organizations.issuePrefix}) = lower(${routeKey})
      `)
      .then((rows) => rows.find((row) => row.id !== allowedOrgId) ?? null);
    if (organizationOwner) return true;

    const aliasOwner = await database
      .select({ orgId: organizationIssuePrefixAliases.orgId })
      .from(organizationIssuePrefixAliases)
      .where(sql`lower(${organizationIssuePrefixAliases.prefix}) = lower(${routeKey})`)
      .then((rows) => rows.find((row) => row.orgId !== allowedOrgId) ?? null);
    return Boolean(aliasOwner);
  }

  async function createCompanyWithUniqueKeys(
    database: Pick<Db, "transaction">,
    data: typeof organizations.$inferInsert,
  ) {
    const hasExplicitIssuePrefix = data.issuePrefix !== undefined;
    const issuePrefixBase = data.issuePrefix === undefined
      ? deriveOrganizationIssueKey(data.name)
      : normalizeOrganizationIssueKey(data.issuePrefix);
    if (!issuePrefixBase) {
      throw unprocessable("Issue key must start with a letter and contain only letters and numbers");
    }
    const urlKeyBase = deriveOrganizationUrlKey(data.name);
    let issueKeyAttempt = 1;
    let urlKeyAttempt = 1;
    while (issueKeyAttempt < 10000 && urlKeyAttempt < 10000) {
      const issuePrefix = hasExplicitIssuePrefix
        ? issuePrefixBase
        : `${issuePrefixBase}${suffixForIssueKeyAttempt(issueKeyAttempt)}`;
      const candidateUrlKey = `${urlKeyBase}${suffixForUrlKeyAttempt(urlKeyAttempt)}`;
      try {
        const created = await database.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext('rudder:organization-issue-prefix'))`);
          if (await isRouteKeyOwnedByAnotherOrganization(tx, issuePrefix)) {
            if (hasExplicitIssuePrefix) {
              throw conflict(`Issue key "${issuePrefix}" is already in use. Choose another key.`);
            }
            return "issue-key-conflict" as const;
          }
          if (await isRouteKeyOwnedByAnotherOrganization(tx, candidateUrlKey)) {
            return "url-key-conflict" as const;
          }
          const rows = await tx
            .insert(organizations)
            .values({ ...data, issuePrefix, urlKey: candidateUrlKey })
            .returning();
          return rows[0];
        });
        if (created === "issue-key-conflict") {
          issueKeyAttempt += 1;
          continue;
        }
        if (created === "url-key-conflict") {
          urlKeyAttempt += 1;
          continue;
        }
        return created;
      } catch (error) {
        if (isUniqueConstraintConflict(error, "organizations_issue_prefix_idx")) {
          if (hasExplicitIssuePrefix) {
            throw conflict(`Issue key "${issuePrefix}" is already in use. Choose another key.`);
          }
          issueKeyAttempt += 1;
          continue;
        }
        if (!isUniqueConstraintConflict(error, "organizations_url_key_idx")) throw error;
        urlKeyAttempt += 1;
      }
    }
    throw new Error("Unable to allocate unique organization keys");
  }

  return {
    list: async () => {
      const rows = await getCompanyQuery(db);
      const hydrated = await hydrateCompanySpend(rows);
      const aliases = await db
        .select({ orgId: organizationIssuePrefixAliases.orgId, prefix: organizationIssuePrefixAliases.prefix })
        .from(organizationIssuePrefixAliases);
      const aliasesByOrg = new Map<string, string[]>();
      for (const alias of aliases) {
        const current = aliasesByOrg.get(alias.orgId) ?? [];
        current.push(alias.prefix);
        aliasesByOrg.set(alias.orgId, current);
      }
      return hydrated.map((row) => enrichCompany(row, aliasesByOrg.get(row.id) ?? []));
    },

    getById: async (id: string) => {
      const row = await getCompanyQuery(db)
        .where(eq(organizations.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [hydrated] = await hydrateCompanySpend([row], db);
      const aliases = await db
        .select({ prefix: organizationIssuePrefixAliases.prefix })
        .from(organizationIssuePrefixAliases)
        .where(eq(organizationIssuePrefixAliases.orgId, id));
      return enrichCompany(hydrated, aliases.map((alias) => alias.prefix));
    },

    create: (data: OrganizationCreateInput) =>
      db.transaction(async (tx) => {
        const { workspace, analytics, ...organizationData } = data as OrganizationCreateInput & {
          workspace?: unknown;
        };
        void workspace;
        const existingOrganizations = await tx
          .select({ id: organizations.id })
          .from(organizations)
          .limit(1);
        const created = await createCompanyWithUniqueKeys(tx, {
          ...organizationData,
        });

        await tx.insert(labels).values(
          DEFAULT_ISSUE_LABELS.map((label) => ({
            orgId: created.id,
            name: label.name,
            color: label.color,
          })),
        );

        await ensureOrganizationWorkspaceLayout({
          id: created.id,
          name: created.name,
          urlKey: created.urlKey,
        });

        await recordProductAnalyticsEvent(tx as unknown as Db, {
          orgId: created.id,
          eventName: "organization_created",
          occurredAt: created.createdAt,
          sourceTransition: "organization.create",
          confidence: "exact",
          actorType: "system",
          entityType: "organization",
          entityId: created.id,
          dedupeKey: `organization_created:${created.id}`,
          properties: {
            creation_flow: analytics?.creationPath ?? "manual",
            template_kind: analytics?.templateKind ?? "custom",
            is_first_organization: existingOrganizations.length === 0,
            is_user_initiated: analytics?.isUserInitiated ?? true,
          },
        });

        const row = await getCompanyQuery(tx)
          .where(eq(organizations.id, created.id))
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Organization not found after creation");
        const [hydrated] = await hydrateCompanySpend([row], tx);
        return enrichCompany(hydrated);
      }),

    update: (
      id: string,
      data: Partial<typeof organizations.$inferInsert> & { logoAssetId?: string | null },
    ) =>
      db.transaction(async (tx) => {
        const existing = await getCompanyQuery(tx)
          .where(eq(organizations.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const {
          logoAssetId,
          issuePrefix: requestedIssuePrefixInput,
          urlKey: _ignoredUrlKey,
          workspace,
          ...companyPatch
        } = data as Partial<typeof organizations.$inferInsert> & {
          logoAssetId?: string | null;
          workspace?: unknown;
        };
        void workspace;

        const requestedIssuePrefix = requestedIssuePrefixInput === undefined
          ? undefined
          : normalizeOrganizationIssueKey(requestedIssuePrefixInput);
        if (requestedIssuePrefixInput !== undefined && !requestedIssuePrefix) {
          throw unprocessable("Issue key must start with a letter and contain only letters and numbers");
        }

        if (requestedIssuePrefix && requestedIssuePrefix !== existing.issuePrefix) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext('rudder:organization-issue-prefix'))`);
          if (await isRouteKeyOwnedByAnotherOrganization(tx, requestedIssuePrefix, id)) {
            throw conflict(`Issue key "${requestedIssuePrefix}" is already in use. Choose another key.`);
          }
          const aliasOwner = await tx
            .select({ orgId: organizationIssuePrefixAliases.orgId })
            .from(organizationIssuePrefixAliases)
            .where(eq(organizationIssuePrefixAliases.prefix, requestedIssuePrefix))
            .then((rows) => rows[0] ?? null);
          if (aliasOwner && aliasOwner.orgId !== id) {
            throw conflict(`Issue key "${requestedIssuePrefix}" is already in use. Choose another key.`);
          }
          if (aliasOwner?.orgId === id) {
            await tx
              .delete(organizationIssuePrefixAliases)
              .where(eq(organizationIssuePrefixAliases.prefix, requestedIssuePrefix));
          }
          await tx
            .insert(organizationIssuePrefixAliases)
            .values({ orgId: id, prefix: existing.issuePrefix })
            .onConflictDoNothing({ target: organizationIssuePrefixAliases.prefix });
          await tx
            .update(issues)
            .set({ identifier: sql`${requestedIssuePrefix} || '-' || ${issues.issueNumber}::text` })
            .where(and(eq(issues.orgId, id), sql`${issues.issueNumber} is not null`));
        }

        if (logoAssetId !== undefined && logoAssetId !== null) {
          const nextLogoAsset = await tx
            .select({ id: assets.id, orgId: assets.orgId })
            .from(assets)
            .where(eq(assets.id, logoAssetId))
            .then((rows) => rows[0] ?? null);
          if (!nextLogoAsset) throw notFound("Logo asset not found");
          if (nextLogoAsset.orgId !== existing.id) {
            throw unprocessable("Logo asset must belong to the same organization");
          }
        }

        const updated = await tx
          .update(organizations)
          .set({
            ...companyPatch,
            ...(requestedIssuePrefix ? { issuePrefix: requestedIssuePrefix } : {}),
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        if (logoAssetId === null) {
          await tx.delete(organizationLogos).where(eq(organizationLogos.orgId, id));
        } else if (logoAssetId !== undefined) {
          await tx
            .insert(organizationLogos)
            .values({
              orgId: id,
              assetId: logoAssetId,
            })
            .onConflictDoUpdate({
              target: organizationLogos.orgId,
              set: {
                assetId: logoAssetId,
                updatedAt: new Date(),
              },
            });
        }

        if (logoAssetId !== undefined && existing.logoAssetId && existing.logoAssetId !== logoAssetId) {
          await tx.delete(assets).where(eq(assets.id, existing.logoAssetId));
        }

        const [hydrated] = await hydrateCompanySpend([{
          ...updated,
          logoAssetId: logoAssetId === undefined ? existing.logoAssetId : logoAssetId,
        }], tx);

        const aliases = await tx
          .select({ prefix: organizationIssuePrefixAliases.prefix })
          .from(organizationIssuePrefixAliases)
          .where(eq(organizationIssuePrefixAliases.orgId, id));
        return enrichCompany(hydrated, aliases.map((alias) => alias.prefix));
      }),

    archive: (id: string) =>
      db.transaction(async (tx) => {
        const updated = await tx
          .update(organizations)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(organizations.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        const row = await getCompanyQuery(tx)
          .where(eq(organizations.id, id))
          .then((rows) => rows[0] ?? null);
        if (!row) return null;
        const [hydrated] = await hydrateCompanySpend([row], tx);
        return enrichCompany(hydrated);
      }),

    remove: (id: string) =>
      db.transaction(async (tx) => {
        // Delete from child tables in dependency order
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.orgId, id));
        await tx.delete(activityLog).where(eq(activityLog.orgId, id));
        await tx.delete(workspaceOperations).where(eq(workspaceOperations.orgId, id));
        await tx.delete(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.orgId, id));
        await tx.delete(executionWorkspaces).where(eq(executionWorkspaces.orgId, id));
        await tx.delete(projectWorkspaces).where(eq(projectWorkspaces.orgId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.orgId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.orgId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.orgId, id));
        await tx.delete(agentConfigRevisions).where(eq(agentConfigRevisions.orgId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.orgId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.orgId, id));
        await tx.delete(issueApprovals).where(eq(issueApprovals.orgId, id));
        await tx.delete(issueAttachments).where(eq(issueAttachments.orgId, id));
        await tx.delete(issueDocuments).where(eq(issueDocuments.orgId, id));
        await tx.delete(issueComments).where(eq(issueComments.orgId, id));
        await tx.delete(issueReadStates).where(eq(issueReadStates.orgId, id));
        await tx.delete(issueWorkProducts).where(eq(issueWorkProducts.orgId, id));
        await tx.delete(costEvents).where(eq(costEvents.orgId, id));
        await tx.delete(costMonthlySpendRollups).where(eq(costMonthlySpendRollups.orgId, id));
        await tx.delete(financeEvents).where(eq(financeEvents.orgId, id));
        await tx.delete(documentRevisions).where(eq(documentRevisions.orgId, id));
        await tx.delete(documents).where(eq(documents.orgId, id));
        await tx.delete(approvalComments).where(eq(approvalComments.orgId, id));
        await tx.delete(approvals).where(eq(approvals.orgId, id));
        await tx.delete(chatAttachments).where(eq(chatAttachments.orgId, id));
        await tx.delete(chatMessages).where(eq(chatMessages.orgId, id));
        await tx.delete(chatContextLinks).where(eq(chatContextLinks.orgId, id));
        await tx.delete(chatConversations).where(eq(chatConversations.orgId, id));
        await tx.delete(organizationSecrets).where(eq(organizationSecrets.orgId, id));
        await tx.delete(organizationSkills).where(eq(organizationSkills.orgId, id));
        await tx.delete(joinRequests).where(eq(joinRequests.orgId, id));
        await tx.delete(invites).where(eq(invites.orgId, id));
        await tx.delete(budgetIncidents).where(eq(budgetIncidents.orgId, id));
        await tx.delete(budgetPolicies).where(eq(budgetPolicies.orgId, id));
        await tx.delete(principalPermissionGrants).where(eq(principalPermissionGrants.orgId, id));
        await tx.delete(organizationMemberships).where(eq(organizationMemberships.orgId, id));
        await tx.delete(issues).where(eq(issues.orgId, id));
        await tx.delete(organizationLogos).where(eq(organizationLogos.orgId, id));
        await tx.delete(organizationIssuePrefixAliases).where(eq(organizationIssuePrefixAliases.orgId, id));
        await tx.delete(assets).where(eq(assets.orgId, id));
        await tx.delete(projectGoals).where(eq(projectGoals.orgId, id));
        await tx.delete(goals).where(eq(goals.orgId, id));
        await tx.delete(projects).where(eq(projects.orgId, id));
        await tx.delete(agents).where(eq(agents.orgId, id));
        const rows = await tx
          .delete(organizations)
          .where(eq(organizations.id, id))
          .returning();
        return rows[0] ?? null;
      }).then(async (removed) => {
        if (!removed) return null;
        try {
          await removeOrganizationStorage(id);
        } catch (err) {
          logger.warn({ err, orgId: id }, "removed organization record but failed to prune local organization storage");
        }
        return removed;
      }),

    stats: () =>
      Promise.all([
        db
          .select({ orgId: agents.orgId, count: count() })
          .from(agents)
          .groupBy(agents.orgId),
        db
          .select({ orgId: issues.orgId, count: count() })
          .from(issues)
          .groupBy(issues.orgId),
      ]).then(([agentRows, issueRows]) => {
        const result: Record<string, { agentCount: number; issueCount: number }> = {};
        for (const row of agentRows) {
          result[row.orgId] = { agentCount: row.count, issueCount: 0 };
        }
        for (const row of issueRows) {
          if (result[row.orgId]) {
            result[row.orgId].issueCount = row.count;
          } else {
            result[row.orgId] = { agentCount: 0, issueCount: row.count };
          }
        }
        return result;
      }),
  };
}
