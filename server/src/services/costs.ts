import { and, desc, eq, gte, isNotNull, lt, lte, or, sql, type SQLWrapper } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import { activityLog, agents, organizations, costEvents, costMonthlySpendRollups, issues, projects } from "@rudderhq/db";
import { ADDITIONAL_CACHED_INPUT_TOKEN_PROVIDERS } from "@rudderhq/shared";
import { notFound, unprocessable } from "../errors.js";
import { observeExecutionEvent } from "../langfuse.js";
import { budgetService, type BudgetServiceHooks } from "./budgets.js";

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

export interface CostTrendFilter {
  agentId?: string;
  projectId?: string;
}

const METERED_BILLING_TYPE = "metered_api";
const SUBSCRIPTION_BILLING_TYPES = ["subscription_included", "subscription_overage"] as const;
const ADDITIONAL_CACHED_INPUT_TOKEN_PROVIDER_SQL = sql.join(
  ADDITIONAL_CACHED_INPUT_TOKEN_PROVIDERS.map((provider) => sql`${provider}`),
  sql`, `,
);

function promptInputTokenValueSql() {
  return sql<number>`
    case
      when lower(${costEvents.provider}) in (${ADDITIONAL_CACHED_INPUT_TOKEN_PROVIDER_SQL})
        then ${costEvents.inputTokens} + ${costEvents.cachedInputTokens}
      else ${costEvents.inputTokens}
    end
  `;
}

function sumNumberSql(value: SQLWrapper) {
  return sql<number>`coalesce(sum(${value}), 0)::double precision`;
}

function promptInputTokenCountSql() {
  return sumNumberSql(promptInputTokenValueSql());
}

function totalTokenCountSql() {
  return sumNumberSql(sql`${promptInputTokenValueSql()} + ${costEvents.outputTokens}`);
}

function tokenEventCountSql() {
  return sql<number>`
    coalesce(sum(
      case when (${promptInputTokenValueSql()} + ${costEvents.outputTokens}) > 0 then 1 else 0 end
    ), 0)::int
  `;
}

function subscriptionPromptInputTokenCountSql() {
  return sumNumberSql(sql`
    case
      when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)})
        then ${promptInputTokenValueSql()}
      else 0
    end
  `);
}

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

type CostRollupDb = Pick<Db, "insert" | "select" | "update">;
type CostRollupScope = {
  orgId: string;
  scopeType: "organization" | "agent";
  scopeId: string;
  monthStart: Date;
  monthEnd: Date;
};

function isWithinWindow(value: Date, start: Date, end: Date) {
  const time = value.getTime();
  return time >= start.getTime() && time < end.getTime();
}

function costRollupIdentityWhere(input: Omit<CostRollupScope, "monthEnd">) {
  return and(
    eq(costMonthlySpendRollups.orgId, input.orgId),
    eq(costMonthlySpendRollups.scopeType, input.scopeType),
    eq(costMonthlySpendRollups.scopeId, input.scopeId),
    eq(costMonthlySpendRollups.monthStart, input.monthStart),
  );
}

async function calculateMonthlySpendForScope(db: CostRollupDb, input: CostRollupScope) {
  const [row] = await db
    .select({
      spendCents: sumNumberSql(costEvents.costCents),
    })
    .from(costEvents)
    .where(and(
      eq(costEvents.orgId, input.orgId),
      ...(input.scopeType === "agent" ? [eq(costEvents.agentId, input.scopeId)] : []),
      gte(costEvents.occurredAt, input.monthStart),
      lt(costEvents.occurredAt, input.monthEnd),
    ));
  return Number(row?.spendCents ?? 0);
}

async function reconcileInsertedMonthlySpendRollup(db: CostRollupDb, input: CostRollupScope) {
  const spendCents = await calculateMonthlySpendForScope(db, input);
  await db
    .update(costMonthlySpendRollups)
    .set({
      spendCents,
      updatedAt: new Date(),
    })
    .where(costRollupIdentityWhere(input));
  return spendCents;
}

async function insertMissingMonthlySpendRollup(db: CostRollupDb, input: CostRollupScope) {
  const spendCents = await calculateMonthlySpendForScope(db, input);
  const [inserted] = await db
    .insert(costMonthlySpendRollups)
    .values({
      orgId: input.orgId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      monthStart: input.monthStart,
      spendCents,
    })
    .onConflictDoNothing({
      target: [
        costMonthlySpendRollups.orgId,
        costMonthlySpendRollups.scopeType,
        costMonthlySpendRollups.scopeId,
        costMonthlySpendRollups.monthStart,
      ],
    })
    .returning({ spendCents: costMonthlySpendRollups.spendCents });
  if (inserted) return Number(inserted.spendCents);

  const [existing] = await db
    .select({ spendCents: costMonthlySpendRollups.spendCents })
    .from(costMonthlySpendRollups)
    .where(costRollupIdentityWhere(input));
  return Number(existing?.spendCents ?? spendCents);
}

async function incrementMonthlySpendRollup(
  db: CostRollupDb,
  input: CostRollupScope & { costCents: number },
) {
  const [inserted] = await db
    .insert(costMonthlySpendRollups)
    .values({
      orgId: input.orgId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      monthStart: input.monthStart,
      spendCents: input.costCents,
    })
    .onConflictDoNothing({
      target: [
        costMonthlySpendRollups.orgId,
        costMonthlySpendRollups.scopeType,
        costMonthlySpendRollups.scopeId,
        costMonthlySpendRollups.monthStart,
      ],
    })
    .returning({ spendCents: costMonthlySpendRollups.spendCents });
  if (inserted) return reconcileInsertedMonthlySpendRollup(db, input);

  const [updated] = await db
    .update(costMonthlySpendRollups)
    .set({
      spendCents: sql`${costMonthlySpendRollups.spendCents} + ${input.costCents}`,
      updatedAt: new Date(),
    })
    .where(costRollupIdentityWhere(input))
    .returning({ spendCents: costMonthlySpendRollups.spendCents });
  return Number(updated?.spendCents ?? input.costCents);
}

async function getMonthlySpendTotalsFromRollups(
  db: CostRollupDb,
  event: { orgId: string; agentId: string },
) {
  const { start, end } = currentUtcMonthWindow();
  const rows = await db
    .select({
      scopeType: costMonthlySpendRollups.scopeType,
      scopeId: costMonthlySpendRollups.scopeId,
      spendCents: costMonthlySpendRollups.spendCents,
    })
    .from(costMonthlySpendRollups)
    .where(and(
      eq(costMonthlySpendRollups.orgId, event.orgId),
      eq(costMonthlySpendRollups.monthStart, start),
      or(
        and(
          eq(costMonthlySpendRollups.scopeType, "organization"),
          eq(costMonthlySpendRollups.scopeId, event.orgId),
        ),
        and(
          eq(costMonthlySpendRollups.scopeType, "agent"),
          eq(costMonthlySpendRollups.scopeId, event.agentId),
        ),
      ),
    ));
  const agentRow = rows.find((row) => row.scopeType === "agent" && row.scopeId === event.agentId);
  const organizationRow = rows.find((row) => row.scopeType === "organization" && row.scopeId === event.orgId);
  const agentTotal = agentRow?.spendCents ?? await insertMissingMonthlySpendRollup(db, {
    orgId: event.orgId,
    scopeType: "agent",
    scopeId: event.agentId,
    monthStart: start,
    monthEnd: end,
  });
  const organizationTotal = organizationRow?.spendCents ?? await insertMissingMonthlySpendRollup(db, {
    orgId: event.orgId,
    scopeType: "organization",
    scopeId: event.orgId,
    monthStart: start,
    monthEnd: end,
  });
  return {
    agentTotal: Number(agentTotal),
    organizationTotal: Number(organizationTotal),
  };
}

export function costService(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  const budgets = budgetService(db, budgetHooks);
  return {
    createEvent: async (orgId: string, data: Omit<typeof costEvents.$inferInsert, "orgId">) => {
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, data.agentId))
        .then((rows) => rows[0] ?? null);

      if (!agent) throw notFound("Agent not found");
      if (agent.orgId !== orgId) {
        throw unprocessable("Agent does not belong to organization");
      }

      const event = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(costEvents)
          .values({
            ...data,
            orgId,
            biller: data.biller ?? data.provider,
            billingType: data.billingType ?? "unknown",
            cachedInputTokens: data.cachedInputTokens ?? 0,
          })
          .returning()
          .then((rows) => rows[0]);

        const { start, end } = currentUtcMonthWindow();
        const totals = isWithinWindow(inserted.occurredAt, start, end)
          ? {
            agentTotal: await incrementMonthlySpendRollup(tx, {
              orgId,
              scopeType: "agent",
              scopeId: inserted.agentId,
              monthStart: start,
              monthEnd: end,
              costCents: inserted.costCents,
            }),
            organizationTotal: await incrementMonthlySpendRollup(tx, {
              orgId,
              scopeType: "organization",
              scopeId: orgId,
              monthStart: start,
              monthEnd: end,
              costCents: inserted.costCents,
            }),
          }
          : await getMonthlySpendTotalsFromRollups(tx, inserted);

        await tx
          .update(agents)
          .set({
            spentMonthlyCents: totals.agentTotal,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, inserted.agentId));

        await tx
          .update(organizations)
          .set({
            spentMonthlyCents: totals.organizationTotal,
            updatedAt: new Date(),
          })
          .where(eq(organizations.id, orgId));

        return inserted;
      });

      await budgets.evaluateCostEvent(event);

      if (event.heartbeatRunId) {
        void observeExecutionEvent(
          {
            surface: "cost_event",
            rootExecutionId: event.heartbeatRunId,
            orgId,
            agentId: event.agentId,
            issueId: event.issueId ?? null,
            status: event.billingType ?? event.provider,
            metadata: {
              costEventId: event.id,
              provider: event.provider,
              model: event.model,
              billingType: event.billingType,
            },
          },
          {
            name: "cost.ingested",
            asType: "event",
            input: {
              costCents: event.costCents,
              inputTokens: event.inputTokens,
              cachedInputTokens: event.cachedInputTokens,
              outputTokens: event.outputTokens,
            },
            metadata: {
              provider: event.provider,
              model: event.model,
              billingType: event.billingType,
              biller: event.biller,
            },
          },
        ).catch(() => {});
      }

      return event;
    },

    summary: async (orgId: string, range?: CostDateRange) => {
      const organization = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .then((rows) => rows[0] ?? null);

      if (!organization) throw notFound("Organization not found");

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.orgId, orgId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const [summaryRow] = await db
        .select({
          total: sumNumberSql(costEvents.costCents),
          inputTokens: promptInputTokenCountSql(),
          cachedInputTokens: sumNumberSql(costEvents.cachedInputTokens),
          outputTokens: sumNumberSql(costEvents.outputTokens),
          totalTokens: totalTokenCountSql(),
          eventCount: sql<number>`count(*)::int`,
          tokenEventCount: tokenEventCountSql(),
        })
        .from(costEvents)
        .where(and(...conditions));

      const {
        total,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens,
        eventCount,
        tokenEventCount,
      } = summaryRow;

      const spendCents = Number(total);
      const utilization =
        organization.budgetMonthlyCents > 0
          ? (spendCents / organization.budgetMonthlyCents) * 100
          : 0;

      return {
        orgId,
        spendCents,
        budgetCents: organization.budgetMonthlyCents,
        utilizationPercent: Number(utilization.toFixed(2)),
        inputTokens: Number(inputTokens),
        cachedInputTokens: Number(cachedInputTokens),
        outputTokens: Number(outputTokens),
        totalTokens: Number(totalTokens),
        eventCount: Number(eventCount),
        tokenEventCount: Number(tokenEventCount),
      };
    },

    trend: async (orgId: string, range?: CostDateRange, filter: CostTrendFilter = {}) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.orgId, orgId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));
      if (filter.agentId) conditions.push(eq(costEvents.agentId, filter.agentId));

      const dateBucket = sql<string>`to_char(date_trunc('day', ${costEvents.occurredAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
      const costCentsExpr = sumNumberSql(costEvents.costCents);
      const inputTokensExpr = promptInputTokenCountSql();
      const cachedInputTokensExpr = sumNumberSql(costEvents.cachedInputTokens);
      const outputTokensExpr = sumNumberSql(costEvents.outputTokens);
      const totalTokensExpr = totalTokenCountSql();

      if (filter.projectId) {
        const issueIdAsText = sql<string>`${issues.id}::text`;
        const runProjectLinks = db
          .selectDistinctOn([activityLog.runId, issues.projectId], {
            runId: activityLog.runId,
            projectId: issues.projectId,
          })
          .from(activityLog)
          .innerJoin(
            issues,
            and(
              eq(activityLog.entityType, "issue"),
              eq(activityLog.entityId, issueIdAsText),
            ),
          )
          .where(
            and(
              eq(activityLog.orgId, orgId),
              eq(issues.orgId, orgId),
              isNotNull(activityLog.runId),
              isNotNull(issues.projectId),
            ),
          )
          .orderBy(activityLog.runId, issues.projectId, desc(activityLog.createdAt))
          .as("run_project_links");
        const effectiveProjectId = sql<string | null>`coalesce(${costEvents.projectId}, ${runProjectLinks.projectId})`;
        conditions.push(sql`${effectiveProjectId} = ${filter.projectId}` as ReturnType<typeof eq>);

        return db
          .select({
            date: dateBucket,
            costCents: costCentsExpr,
            inputTokens: inputTokensExpr,
            cachedInputTokens: cachedInputTokensExpr,
            outputTokens: outputTokensExpr,
            totalTokens: totalTokensExpr,
            eventCount: sql<number>`count(*)::int`,
          })
          .from(costEvents)
          .leftJoin(runProjectLinks, eq(costEvents.heartbeatRunId, runProjectLinks.runId))
          .where(and(...conditions))
          .groupBy(dateBucket)
          .orderBy(dateBucket);
      }

      return db
        .select({
          date: dateBucket,
          costCents: costCentsExpr,
          inputTokens: inputTokensExpr,
          cachedInputTokens: cachedInputTokensExpr,
          outputTokens: outputTokensExpr,
          totalTokens: totalTokensExpr,
          eventCount: sql<number>`count(*)::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(dateBucket)
        .orderBy(dateBucket);
    },

    byAgent: async (orgId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.orgId, orgId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentIcon: agents.icon,
          agentRole: agents.role,
          agentStatus: agents.status,
          costCents: sumNumberSql(costEvents.costCents),
          inputTokens: promptInputTokenCountSql(),
          cachedInputTokens: sumNumberSql(costEvents.cachedInputTokens),
          outputTokens: sumNumberSql(costEvents.outputTokens),
          cachedInputTokenSemantics: sql<"included_in_input">`'included_in_input'`,
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens: sumNumberSql(sql`case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end`),
          subscriptionInputTokens: subscriptionPromptInputTokenCountSql(),
          subscriptionOutputTokens: sumNumberSql(sql`case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end`),
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(costEvents.agentId, agents.name, agents.icon, agents.role, agents.status)
        .orderBy(desc(sumNumberSql(costEvents.costCents)));
    },

    byProvider: async (orgId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.orgId, orgId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumNumberSql(costEvents.costCents),
          inputTokens: promptInputTokenCountSql(),
          cachedInputTokens: sumNumberSql(costEvents.cachedInputTokens),
          outputTokens: sumNumberSql(costEvents.outputTokens),
          cachedInputTokenSemantics: sql<"included_in_input">`'included_in_input'`,
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens: sumNumberSql(sql`case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end`),
          subscriptionInputTokens: subscriptionPromptInputTokenCountSql(),
          subscriptionOutputTokens: sumNumberSql(sql`case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end`),
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model)
        .orderBy(desc(sumNumberSql(costEvents.costCents)));
    },

    byBiller: async (orgId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.orgId, orgId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          biller: costEvents.biller,
          costCents: sumNumberSql(costEvents.costCents),
          inputTokens: promptInputTokenCountSql(),
          cachedInputTokens: sumNumberSql(costEvents.cachedInputTokens),
          outputTokens: sumNumberSql(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionCachedInputTokens: sumNumberSql(sql`case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end`),
          subscriptionInputTokens: subscriptionPromptInputTokenCountSql(),
          subscriptionOutputTokens: sumNumberSql(sql`case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end`),
          providerCount: sql<number>`count(distinct ${costEvents.provider})::int`,
          modelCount: sql<number>`count(distinct ${costEvents.model})::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.biller)
        .orderBy(desc(sumNumberSql(costEvents.costCents)));
    },

    /**
     * aggregates cost_events by provider for each of three rolling windows:
     * last 5 hours, last 24 hours, last 7 days.
     * purely internal consumption data, no external rate-limit sources.
     */
    windowSpend: async (orgId: string) => {
      const windows = [
        { label: "5h", hours: 5 },
        { label: "24h", hours: 24 },
        { label: "7d", hours: 168 },
      ] as const;

      const results = await Promise.all(
        windows.map(async ({ label, hours }) => {
          const since = new Date(Date.now() - hours * 60 * 60 * 1000);
          const rows = await db
            .select({
              provider: costEvents.provider,
              biller: sql<string>`case when count(distinct ${costEvents.biller}) = 1 then min(${costEvents.biller}) else 'mixed' end`,
              costCents: sumNumberSql(costEvents.costCents),
              inputTokens: promptInputTokenCountSql(),
              cachedInputTokens: sumNumberSql(costEvents.cachedInputTokens),
              outputTokens: sumNumberSql(costEvents.outputTokens),
              cachedInputTokenSemantics: sql<"included_in_input">`'included_in_input'`,
            })
            .from(costEvents)
            .where(
              and(
                eq(costEvents.orgId, orgId),
                gte(costEvents.occurredAt, since),
              ),
            )
            .groupBy(costEvents.provider)
            .orderBy(desc(sumNumberSql(costEvents.costCents)));

          return rows.map((row) => ({
            provider: row.provider,
            biller: row.biller,
            window: label as string,
            windowHours: hours,
            costCents: row.costCents,
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            outputTokens: row.outputTokens,
            cachedInputTokenSemantics: row.cachedInputTokenSemantics,
          }));
        }),
      );

      return results.flat();
    },

    byAgentModel: async (orgId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.orgId, orgId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      // single query: group by agent + provider + model.
      // the (orgId, agentId, occurredAt) composite index covers this well.
      // order by provider + model for stable db-level ordering; cost-desc sort
      // within each agent's sub-rows is done client-side in the ui memo.
      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumNumberSql(costEvents.costCents),
          inputTokens: promptInputTokenCountSql(),
          cachedInputTokens: sumNumberSql(costEvents.cachedInputTokens),
          outputTokens: sumNumberSql(costEvents.outputTokens),
          cachedInputTokenSemantics: sql<"included_in_input">`'included_in_input'`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(
          costEvents.agentId,
          agents.name,
          costEvents.provider,
          costEvents.biller,
          costEvents.billingType,
          costEvents.model,
        )
        .orderBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model);
    },

    byProject: async (orgId: string, range?: CostDateRange) => {
      const issueIdAsText = sql<string>`${issues.id}::text`;
      const runProjectLinks = db
        .selectDistinctOn([activityLog.runId, issues.projectId], {
          runId: activityLog.runId,
          projectId: issues.projectId,
        })
        .from(activityLog)
        .innerJoin(
          issues,
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            eq(activityLog.orgId, orgId),
            eq(issues.orgId, orgId),
            isNotNull(activityLog.runId),
            isNotNull(issues.projectId),
          ),
        )
        .orderBy(activityLog.runId, issues.projectId, desc(activityLog.createdAt))
        .as("run_project_links");

      const effectiveProjectId = sql<string | null>`coalesce(${costEvents.projectId}, ${runProjectLinks.projectId})`;
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.orgId, orgId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const costCentsExpr = sumNumberSql(costEvents.costCents);

      return db
        .select({
          projectId: effectiveProjectId,
          projectName: projects.name,
          costCents: costCentsExpr,
          inputTokens: promptInputTokenCountSql(),
          cachedInputTokens: sumNumberSql(costEvents.cachedInputTokens),
          outputTokens: sumNumberSql(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(runProjectLinks, eq(costEvents.heartbeatRunId, runProjectLinks.runId))
        .innerJoin(projects, sql`${projects.id} = ${effectiveProjectId}`)
        .where(and(...conditions, sql`${effectiveProjectId} is not null`))
        .groupBy(effectiveProjectId, projects.name)
        .orderBy(desc(costCentsExpr));
    },
  };
}
