import { and, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  organizations,
  organizationLogos,
  assets,
  labels,
  agents,
  agentConfigRevisions,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  issues,
  issueApprovals,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueReadStates,
  issueWorkProducts,
  projects,
  projectGoals,
  projectWorkspaces,
  goals,
  heartbeatRuns,
  heartbeatRunEvents,
  costEvents,
  financeEvents,
  approvalComments,
  approvals,
  activityLog,
  chatAttachments,
  chatContextLinks,
  chatConversations,
  chatMessages,
  organizationSecrets,
  joinRequests,
  invites,
  budgetIncidents,
  budgetPolicies,
  documents,
  documentRevisions,
  executionWorkspaces,
  principalPermissionGrants,
  organizationMemberships,
  organizationSkills,
  workspaceOperations,
  workspaceRuntimeServices,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { notFound, unprocessable } from "../errors.js";
import { ensureOrganizationWorkspaceLayout, removeOrganizationStorage } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

export function organizationService(db: Db) {
  const ISSUE_PREFIX_FALLBACK = "CMP";
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
    defaultChatAgentRuntimeType: organizations.defaultChatAgentRuntimeType,
    defaultChatAgentRuntimeConfig: organizations.defaultChatAgentRuntimeConfig,
    brandColor: organizations.brandColor,
    logoAssetId: organizationLogos.assetId,
    createdAt: organizations.createdAt,
    updatedAt: organizations.updatedAt,
  };

  function enrichCompany<T extends { logoAssetId: string | null }>(organization: T) {
    return {
      ...organization,
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

  function deriveIssuePrefixBase(name: string) {
    const normalized = name.toUpperCase().replace(/[^A-Z]/g, "");
    return normalized.slice(0, 3) || ISSUE_PREFIX_FALLBACK;
  }

  function suffixForAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return "A".repeat(attempt - 1);
  }

  function suffixForUrlKeyAttempt(attempt: number) {
    if (attempt <= 1) return "";
    return `-${attempt}`;
  }

  function isUniqueConstraintConflict(error: unknown, constraintName: string) {
    const constraint = typeof error === "object" && error !== null && "constraint" in error
      ? (error as { constraint?: string }).constraint
      : typeof error === "object" && error !== null && "constraint_name" in error
        ? (error as { constraint_name?: string }).constraint_name
        : undefined;
    return typeof error === "object"
      && error !== null
      && "code" in error
      && (error as { code?: string }).code === "23505"
      && constraint === constraintName;
  }

  async function createCompanyWithUniqueKeys(
    database: Pick<Db, "transaction">,
    data: typeof organizations.$inferInsert,
  ) {
    const base = deriveIssuePrefixBase(data.name);
    const urlKeyBase = deriveOrganizationUrlKey(data.name);
    let suffix = 1;
    while (suffix < 10000) {
      const candidate = `${base}${suffixForAttempt(suffix)}`;
      const candidateUrlKey = `${urlKeyBase}${suffixForUrlKeyAttempt(suffix)}`;
      try {
        const created = await database.transaction(async (tx) => {
          const rows = await tx
            .insert(organizations)
            .values({ ...data, issuePrefix: candidate, urlKey: candidateUrlKey })
            .returning();
          return rows[0];
        });
        return created;
      } catch (error) {
        if (
          !isUniqueConstraintConflict(error, "organizations_issue_prefix_idx")
          && !isUniqueConstraintConflict(error, "organizations_url_key_idx")
        ) {
          throw error;
        }
      }
      suffix += 1;
    }
    throw new Error("Unable to allocate unique organization url key");
  }

  return {
    list: async () => {
      const rows = await getCompanyQuery(db);
      const hydrated = await hydrateCompanySpend(rows);
      return hydrated.map((row) => enrichCompany(row));
    },

    getById: async (id: string) => {
      const row = await getCompanyQuery(db)
        .where(eq(organizations.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [hydrated] = await hydrateCompanySpend([row], db);
      return enrichCompany(hydrated);
    },

    create: (data: typeof organizations.$inferInsert) =>
      db.transaction(async (tx) => {
        const { workspace, ...organizationData } = data as typeof organizations.$inferInsert & {
          workspace?: unknown;
        };
        void workspace;
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

        await ensureOrganizationWorkspaceLayout(created.id);

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
          urlKey: _ignoredUrlKey,
          workspace,
          ...companyPatch
        } = data as Partial<typeof organizations.$inferInsert> & {
          logoAssetId?: string | null;
          workspace?: unknown;
        };
        void workspace;

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

        return enrichCompany(hydrated);
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
