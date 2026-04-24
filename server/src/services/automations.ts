import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  agents,
  organizationSecrets,
  goals,
  heartbeatRuns,
  issues,
  projects,
  automationRuns,
  automations,
  automationTriggers,
} from "@rudderhq/db";
import type {
  CreateAutomation,
  CreateAutomationTrigger,
  Automation,
  AutomationDetail,
  AutomationListItem,
  AutomationRunSummary,
  AutomationTrigger,
  AutomationTriggerSecretMaterial,
  RunAutomation,
  UpdateAutomation,
  UpdateAutomationTrigger,
} from "@rudderhq/shared";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import { secretService } from "./secrets.js";
import { parseCron, validateCron } from "./cron.js";
import { heartbeatService } from "./heartbeat.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { logActivity } from "./activity-log.js";

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running"];
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const MAX_CATCH_UP_RUNS = 25;
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

type Actor = { agentId?: string | null; userId?: string | null };

function assertTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw unprocessable(`Invalid timezone: ${timeZone}`);
  }
}

function floorToMinute(date: Date) {
  const copy = new Date(date.getTime());
  copy.setUTCSeconds(0, 0);
  return copy;
}

function getZonedMinuteParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
  if (weekday == null) {
    throw new Error(`Unable to resolve weekday for timezone ${timeZone}`);
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday,
  };
}

function matchesCronMinute(expression: string, timeZone: string, date: Date) {
  const cron = parseCron(expression);
  const parts = getZonedMinuteParts(date, timeZone);
  return (
    cron.minutes.includes(parts.minute) &&
    cron.hours.includes(parts.hour) &&
    cron.daysOfMonth.includes(parts.day) &&
    cron.months.includes(parts.month) &&
    cron.daysOfWeek.includes(parts.weekday)
  );
}

function nextCronTickInTimeZone(expression: string, timeZone: string, after: Date) {
  const trimmed = expression.trim();
  assertTimeZone(timeZone);
  const error = validateCron(trimmed);
  if (error) {
    throw unprocessable(error);
  }

  const cursor = floorToMinute(after);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60 * 5;
  for (let i = 0; i < limit; i += 1) {
    if (matchesCronMinute(trimmed, timeZone, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

function nextResultText(status: string, issueId?: string | null) {
  if (status === "issue_created" && issueId) return `Created execution issue ${issueId}`;
  if (status === "coalesced") return "Coalesced into an existing live execution issue";
  if (status === "skipped") return "Skipped because a live execution issue already exists";
  if (status === "completed") return "Execution issue completed";
  if (status === "failed") return "Execution failed";
  return status;
}

function normalizeWebhookTimestampMs(rawTimestamp: string) {
  const parsed = Number(rawTimestamp);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1e12 ? parsed : parsed * 1000;
}

export function automationService(db: Db, deps: { heartbeat?: IssueAssignmentWakeupDeps } = {}) {
  const issueSvc = issueService(db);
  const secretsSvc = secretService(db);
  const heartbeat = deps.heartbeat ?? heartbeatService(db);

  async function getAutomationById(id: string) {
    return db
      .select()
      .from(automations)
      .where(eq(automations.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getTriggerById(id: string) {
    return db
      .select()
      .from(automationTriggers)
      .where(eq(automationTriggers.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function assertAutomationAccess(orgId: string, automationId: string) {
    const automation = await getAutomationById(automationId);
    if (!automation) throw notFound("Automation not found");
    if (automation.orgId !== orgId) throw forbidden("Automation must belong to same organization");
    return automation;
  }

  async function assertAssignableAgent(orgId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id, orgId: agents.orgId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Assignee agent not found");
    if (agent.orgId !== orgId) throw unprocessable("Assignee must belong to same organization");
    if (agent.status === "pending_approval") throw conflict("Cannot assign automations to pending approval agents");
    if (agent.status === "terminated") throw conflict("Cannot assign automations to terminated agents");
  }

  async function assertProject(orgId: string, projectId: string) {
    const project = await db
      .select({ id: projects.id, orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");
    if (project.orgId !== orgId) throw unprocessable("Project must belong to same organization");
  }

  async function assertGoal(orgId: string, goalId: string) {
    const goal = await db
      .select({ id: goals.id, orgId: goals.orgId })
      .from(goals)
      .where(eq(goals.id, goalId))
      .then((rows) => rows[0] ?? null);
    if (!goal) throw notFound("Goal not found");
    if (goal.orgId !== orgId) throw unprocessable("Goal must belong to same organization");
  }

  async function assertParentIssue(orgId: string, issueId: string) {
    const parentIssue = await db
      .select({ id: issues.id, orgId: issues.orgId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!parentIssue) throw notFound("Parent issue not found");
    if (parentIssue.orgId !== orgId) throw unprocessable("Parent issue must belong to same organization");
  }

  async function listTriggersForAutomationIds(orgId: string, automationIds: string[]) {
    if (automationIds.length === 0) return new Map<string, AutomationTrigger[]>();
    const rows = await db
      .select()
      .from(automationTriggers)
      .where(and(eq(automationTriggers.orgId, orgId), inArray(automationTriggers.automationId, automationIds)))
      .orderBy(asc(automationTriggers.createdAt), asc(automationTriggers.id));
    const map = new Map<string, AutomationTrigger[]>();
    for (const row of rows) {
      const list = map.get(row.automationId) ?? [];
      list.push(row);
      map.set(row.automationId, list);
    }
    return map;
  }

  async function listLatestRunByAutomationIds(orgId: string, automationIds: string[]) {
    if (automationIds.length === 0) return new Map<string, AutomationRunSummary>();
    const rows = await db
      .selectDistinctOn([automationRuns.automationId], {
        id: automationRuns.id,
        orgId: automationRuns.orgId,
        automationId: automationRuns.automationId,
        triggerId: automationRuns.triggerId,
        source: automationRuns.source,
        status: automationRuns.status,
        triggeredAt: automationRuns.triggeredAt,
        idempotencyKey: automationRuns.idempotencyKey,
        triggerPayload: automationRuns.triggerPayload,
        linkedIssueId: automationRuns.linkedIssueId,
        coalescedIntoRunId: automationRuns.coalescedIntoRunId,
        failureReason: automationRuns.failureReason,
        completedAt: automationRuns.completedAt,
        createdAt: automationRuns.createdAt,
        updatedAt: automationRuns.updatedAt,
        triggerKind: automationTriggers.kind,
        triggerLabel: automationTriggers.label,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        issueStatus: issues.status,
        issuePriority: issues.priority,
        issueUpdatedAt: issues.updatedAt,
      })
      .from(automationRuns)
      .leftJoin(automationTriggers, eq(automationRuns.triggerId, automationTriggers.id))
      .leftJoin(issues, eq(automationRuns.linkedIssueId, issues.id))
      .where(and(eq(automationRuns.orgId, orgId), inArray(automationRuns.automationId, automationIds)))
      .orderBy(automationRuns.automationId, desc(automationRuns.createdAt), desc(automationRuns.id));

    const map = new Map<string, AutomationRunSummary>();
    for (const row of rows) {
      map.set(row.automationId, {
        id: row.id,
        orgId: row.orgId,
        automationId: row.automationId,
        triggerId: row.triggerId,
        source: row.source as AutomationRunSummary["source"],
        status: row.status as AutomationRunSummary["status"],
        triggeredAt: row.triggeredAt,
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        linkedIssueId: row.linkedIssueId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier,
            title: row.issueTitle ?? "Automation execution",
            status: row.issueStatus ?? "todo",
            priority: row.issuePriority ?? "medium",
            updatedAt: row.issueUpdatedAt ?? row.updatedAt,
          }
          : null,
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<AutomationRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      });
    }
    return map;
  }

  async function listLiveIssueByAutomationIds(orgId: string, automationIds: string[]) {
    if (automationIds.length === 0) return new Map<string, AutomationListItem["activeIssue"]>();
    const executionBoundRows = await db
      .selectDistinctOn([issues.originId], {
        originId: issues.originId,
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.orgId, orgId),
          eq(issues.originKind, "automation_execution"),
          inArray(issues.originId, automationIds),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

    const rowsByOriginId = new Map<string, (typeof executionBoundRows)[number]>();
    for (const row of executionBoundRows) {
      if (!row.originId) continue;
      rowsByOriginId.set(row.originId, row);
    }

    const missingAutomationIds = automationIds.filter((automationId) => !rowsByOriginId.has(automationId));
    if (missingAutomationIds.length > 0) {
      const legacyRows = await db
        .selectDistinctOn([issues.originId], {
          originId: issues.originId,
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .innerJoin(
          heartbeatRuns,
          and(
            eq(heartbeatRuns.orgId, issues.orgId),
            inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
          ),
        )
        .where(
          and(
            eq(issues.orgId, orgId),
            eq(issues.originKind, "automation_execution"),
            inArray(issues.originId, missingAutomationIds),
            inArray(issues.status, OPEN_ISSUE_STATUSES),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

      for (const row of legacyRows) {
        if (!row.originId) continue;
        rowsByOriginId.set(row.originId, row);
      }
    }

    const map = new Map<string, AutomationListItem["activeIssue"]>();
    for (const row of rowsByOriginId.values()) {
      if (!row.originId) continue;
      map.set(row.originId, {
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        status: row.status,
        priority: row.priority,
        updatedAt: row.updatedAt,
      });
    }
    return map;
  }

  async function updateAutomationTouchedState(input: {
    automationId: string;
    triggerId?: string | null;
    triggeredAt: Date;
    status: string;
    issueId?: string | null;
    nextRunAt?: Date | null;
  }, executor: Db = db) {
    await executor
      .update(automations)
      .set({
        lastTriggeredAt: input.triggeredAt,
        lastEnqueuedAt: input.issueId ? input.triggeredAt : undefined,
        updatedAt: new Date(),
      })
      .where(eq(automations.id, input.automationId));

    if (input.triggerId) {
      await executor
        .update(automationTriggers)
        .set({
          lastFiredAt: input.triggeredAt,
          lastResult: nextResultText(input.status, input.issueId),
          nextRunAt: input.nextRunAt === undefined ? undefined : input.nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(automationTriggers.id, input.triggerId));
    }
  }

  async function findLiveExecutionIssue(automation: typeof automations.$inferSelect, executor: Db = db) {
    const executionBoundIssue = await executor
      .select()
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.orgId, automation.orgId),
          eq(issues.originKind, "automation_execution"),
          eq(issues.originId, automation.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
    if (executionBoundIssue) return executionBoundIssue;

    return executor
      .select()
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.orgId, issues.orgId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
        ),
      )
      .where(
        and(
          eq(issues.orgId, automation.orgId),
          eq(issues.originKind, "automation_execution"),
          eq(issues.originId, automation.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
  }

  async function finalizeRun(runId: string, patch: Partial<typeof automationRuns.$inferInsert>, executor: Db = db) {
    return executor
      .update(automationRuns)
      .set({
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(automationRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function createWebhookSecret(
    orgId: string,
    automationId: string,
    actor: Actor,
  ) {
    const secretValue = crypto.randomBytes(24).toString("hex");
    const secret = await secretsSvc.create(
      orgId,
      {
        name: `automation-${automationId}-${crypto.randomBytes(6).toString("hex")}`,
        provider: "local_encrypted",
        value: secretValue,
        description: `Webhook auth for automation ${automationId}`,
      },
      actor,
    );
    return { secret, secretValue };
  }

  async function resolveTriggerSecret(trigger: typeof automationTriggers.$inferSelect, orgId: string) {
    if (!trigger.secretId) throw notFound("Automation trigger secret not found");
    const secret = await db
      .select()
      .from(organizationSecrets)
      .where(eq(organizationSecrets.id, trigger.secretId))
      .then((rows) => rows[0] ?? null);
    if (!secret || secret.orgId !== orgId) throw notFound("Automation trigger secret not found");
    const value = await secretsSvc.resolveSecretValue(orgId, trigger.secretId, "latest");
    return value;
  }

  async function dispatchAutomationRun(input: {
    automation: typeof automations.$inferSelect;
    trigger: typeof automationTriggers.$inferSelect | null;
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
  }) {
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(
        sql`select id from ${automations} where ${automations.id} = ${input.automation.id} and ${automations.orgId} = ${input.automation.orgId} for update`,
      );

      if (input.idempotencyKey) {
        const existing = await txDb
          .select()
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.orgId, input.automation.orgId),
              eq(automationRuns.automationId, input.automation.id),
              eq(automationRuns.source, input.source),
              eq(automationRuns.idempotencyKey, input.idempotencyKey),
              input.trigger ? eq(automationRuns.triggerId, input.trigger.id) : isNull(automationRuns.triggerId),
            ),
          )
          .orderBy(desc(automationRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) return existing;
      }

      const triggeredAt = new Date();
      const [createdRun] = await txDb
        .insert(automationRuns)
        .values({
          orgId: input.automation.orgId,
          automationId: input.automation.id,
          triggerId: input.trigger?.id ?? null,
          source: input.source,
          status: "received",
          triggeredAt,
          idempotencyKey: input.idempotencyKey ?? null,
          triggerPayload: input.payload ?? null,
        })
        .returning();

      const nextRunAt = input.trigger?.kind === "schedule" && input.trigger.cronExpression && input.trigger.timezone
        ? nextCronTickInTimeZone(input.trigger.cronExpression, input.trigger.timezone, triggeredAt)
        : undefined;

      let createdIssue: Awaited<ReturnType<typeof issueSvc.create>> | null = null;
      try {
        const activeIssue = await findLiveExecutionIssue(input.automation, txDb);
        if (activeIssue && input.automation.concurrencyPolicy !== "always_enqueue") {
          const status = input.automation.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: activeIssue.id,
            coalescedIntoRunId: activeIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb);
          await updateAutomationTouchedState({
            automationId: input.automation.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status,
            issueId: activeIssue.id,
            nextRunAt,
          }, txDb);
          return updated ?? createdRun;
        }

        try {
          createdIssue = await issueSvc.create(input.automation.orgId, {
            projectId: input.automation.projectId,
            goalId: input.automation.goalId,
            parentId: input.automation.parentIssueId,
            title: input.automation.title,
            description: input.automation.description,
            status: "todo",
            priority: input.automation.priority,
            assigneeAgentId: input.automation.assigneeAgentId,
            originKind: "automation_execution",
            originId: input.automation.id,
            originRunId: createdRun.id,
          });
        } catch (error) {
          const isOpenExecutionConflict =
            !!error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: string }).code === "23505" &&
            "constraint" in error &&
            (error as { constraint?: string }).constraint === "issues_open_automation_execution_uq";
          if (!isOpenExecutionConflict || input.automation.concurrencyPolicy === "always_enqueue") {
            throw error;
          }

          const existingIssue = await findLiveExecutionIssue(input.automation, txDb);
          if (!existingIssue) throw error;
          const status = input.automation.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: existingIssue.id,
            coalescedIntoRunId: existingIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb);
          await updateAutomationTouchedState({
            automationId: input.automation.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status,
            issueId: existingIssue.id,
            nextRunAt,
          }, txDb);
          return updated ?? createdRun;
        }

        // Keep the dispatch lock until the issue is linked to a queued heartbeat run.
        await queueIssueAssignmentWakeup({
          heartbeat,
          issue: createdIssue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "automation.dispatch",
          requestedByActorType: input.source === "schedule" ? "system" : undefined,
          rethrowOnError: true,
        });
        const updated = await finalizeRun(createdRun.id, {
          status: "issue_created",
          linkedIssueId: createdIssue.id,
        }, txDb);
        await updateAutomationTouchedState({
          automationId: input.automation.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          status: "issue_created",
          issueId: createdIssue.id,
          nextRunAt,
        }, txDb);
        return updated ?? createdRun;
      } catch (error) {
        if (createdIssue) {
          await txDb.delete(issues).where(eq(issues.id, createdIssue.id));
        }
        const failureReason = error instanceof Error ? error.message : String(error);
        const failed = await finalizeRun(createdRun.id, {
          status: "failed",
          failureReason,
          completedAt: new Date(),
        }, txDb);
        await updateAutomationTouchedState({
          automationId: input.automation.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          status: "failed",
          nextRunAt,
        }, txDb);
        return failed ?? createdRun;
      }
    });

    if (input.source === "schedule" || input.source === "webhook") {
      const actorId = input.source === "schedule" ? "automation-scheduler" : "automation-webhook";
      try {
        await logActivity(db, {
          orgId: input.automation.orgId,
          actorType: "system",
          actorId,
          action: "automation.run_triggered",
          entityType: "automation_run",
          entityId: run.id,
          details: {
            automationId: input.automation.id,
            triggerId: input.trigger?.id ?? null,
            source: run.source,
            status: run.status,
          },
        });
      } catch (err) {
        logger.warn({ err, automationId: input.automation.id, runId: run.id }, "failed to log automated run");
      }
    }

    return run;
  }

  return {
    get: getAutomationById,
    getTrigger: getTriggerById,

    list: async (orgId: string): Promise<AutomationListItem[]> => {
      const rows = await db
        .select()
        .from(automations)
        .where(eq(automations.orgId, orgId))
        .orderBy(desc(automations.updatedAt), asc(automations.title));
      const automationIds = rows.map((row) => row.id);
      const [triggersByAutomation, latestRunByAutomation, activeIssueByAutomation] = await Promise.all([
        listTriggersForAutomationIds(orgId, automationIds),
        listLatestRunByAutomationIds(orgId, automationIds),
        listLiveIssueByAutomationIds(orgId, automationIds),
      ]);
      return rows.map((row) => ({
        ...row,
        triggers: (triggersByAutomation.get(row.id) ?? []).map((trigger) => ({
          id: trigger.id,
          kind: trigger.kind as AutomationListItem["triggers"][number]["kind"],
          label: trigger.label,
          enabled: trigger.enabled,
          nextRunAt: trigger.nextRunAt,
          lastFiredAt: trigger.lastFiredAt,
          lastResult: trigger.lastResult,
        })),
        lastRun: latestRunByAutomation.get(row.id) ?? null,
        activeIssue: activeIssueByAutomation.get(row.id) ?? null,
      }));
    },

    getDetail: async (id: string): Promise<AutomationDetail | null> => {
      const row = await getAutomationById(id);
      if (!row) return null;
      const [project, assignee, parentIssue, triggers, recentRuns, activeIssue] = await Promise.all([
        db.select().from(projects).where(eq(projects.id, row.projectId)).then((rows) => rows[0] ?? null),
        db.select().from(agents).where(eq(agents.id, row.assigneeAgentId)).then((rows) => rows[0] ?? null),
        row.parentIssueId ? issueSvc.getById(row.parentIssueId) : null,
        db.select().from(automationTriggers).where(eq(automationTriggers.automationId, row.id)).orderBy(asc(automationTriggers.createdAt)),
        db
          .select({
            id: automationRuns.id,
            orgId: automationRuns.orgId,
            automationId: automationRuns.automationId,
            triggerId: automationRuns.triggerId,
            source: automationRuns.source,
            status: automationRuns.status,
            triggeredAt: automationRuns.triggeredAt,
            idempotencyKey: automationRuns.idempotencyKey,
            triggerPayload: automationRuns.triggerPayload,
            linkedIssueId: automationRuns.linkedIssueId,
            coalescedIntoRunId: automationRuns.coalescedIntoRunId,
            failureReason: automationRuns.failureReason,
            completedAt: automationRuns.completedAt,
            createdAt: automationRuns.createdAt,
            updatedAt: automationRuns.updatedAt,
            triggerKind: automationTriggers.kind,
            triggerLabel: automationTriggers.label,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            issueStatus: issues.status,
            issuePriority: issues.priority,
            issueUpdatedAt: issues.updatedAt,
          })
          .from(automationRuns)
          .leftJoin(automationTriggers, eq(automationRuns.triggerId, automationTriggers.id))
          .leftJoin(issues, eq(automationRuns.linkedIssueId, issues.id))
          .where(eq(automationRuns.automationId, row.id))
          .orderBy(desc(automationRuns.createdAt))
          .limit(25)
          .then((runs) =>
            runs.map((run) => ({
              id: run.id,
              orgId: run.orgId,
              automationId: run.automationId,
              triggerId: run.triggerId,
              source: run.source as AutomationRunSummary["source"],
              status: run.status as AutomationRunSummary["status"],
              triggeredAt: run.triggeredAt,
              idempotencyKey: run.idempotencyKey,
              triggerPayload: run.triggerPayload as Record<string, unknown> | null,
              linkedIssueId: run.linkedIssueId,
              coalescedIntoRunId: run.coalescedIntoRunId,
              failureReason: run.failureReason,
              completedAt: run.completedAt,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              linkedIssue: run.linkedIssueId
                ? {
                  id: run.linkedIssueId,
                  identifier: run.issueIdentifier,
                  title: run.issueTitle ?? "Automation execution",
                  status: run.issueStatus ?? "todo",
                  priority: run.issuePriority ?? "medium",
                  updatedAt: run.issueUpdatedAt ?? run.updatedAt,
                }
                : null,
              trigger: run.triggerId
                ? {
                  id: run.triggerId,
                  kind: run.triggerKind as NonNullable<AutomationRunSummary["trigger"]>["kind"],
                  label: run.triggerLabel,
                }
                : null,
            })),
          ),
        findLiveExecutionIssue(row),
      ]);

      return {
        ...row,
        project,
        assignee,
        parentIssue,
        triggers: triggers as AutomationTrigger[],
        recentRuns,
        activeIssue,
      };
    },

    create: async (orgId: string, input: CreateAutomation, actor: Actor): Promise<Automation> => {
      await assertProject(orgId, input.projectId);
      await assertAssignableAgent(orgId, input.assigneeAgentId);
      if (input.goalId) await assertGoal(orgId, input.goalId);
      if (input.parentIssueId) await assertParentIssue(orgId, input.parentIssueId);
      const [created] = await db
        .insert(automations)
        .values({
          orgId,
          projectId: input.projectId,
          goalId: input.goalId ?? null,
          parentIssueId: input.parentIssueId ?? null,
          title: input.title,
          description: input.description ?? null,
          assigneeAgentId: input.assigneeAgentId,
          priority: input.priority,
          status: input.status,
          concurrencyPolicy: input.concurrencyPolicy,
          catchUpPolicy: input.catchUpPolicy,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();
      return created;
    },

    update: async (id: string, patch: UpdateAutomation, actor: Actor): Promise<Automation | null> => {
      const existing = await getAutomationById(id);
      if (!existing) return null;
      const nextProjectId = patch.projectId ?? existing.projectId;
      const nextAssigneeAgentId = patch.assigneeAgentId ?? existing.assigneeAgentId;
      if (patch.projectId) await assertProject(existing.orgId, nextProjectId);
      if (patch.assigneeAgentId) await assertAssignableAgent(existing.orgId, nextAssigneeAgentId);
      if (patch.goalId) await assertGoal(existing.orgId, patch.goalId);
      if (patch.parentIssueId) await assertParentIssue(existing.orgId, patch.parentIssueId);
      const [updated] = await db
        .update(automations)
        .set({
          projectId: nextProjectId,
          goalId: patch.goalId === undefined ? existing.goalId : patch.goalId,
          parentIssueId: patch.parentIssueId === undefined ? existing.parentIssueId : patch.parentIssueId,
          title: patch.title ?? existing.title,
          description: patch.description === undefined ? existing.description : patch.description,
          assigneeAgentId: nextAssigneeAgentId,
          priority: patch.priority ?? existing.priority,
          status: patch.status ?? existing.status,
          concurrencyPolicy: patch.concurrencyPolicy ?? existing.concurrencyPolicy,
          catchUpPolicy: patch.catchUpPolicy ?? existing.catchUpPolicy,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(automations.id, id))
        .returning();
      return updated ?? null;
    },

    createTrigger: async (
      automationId: string,
      input: CreateAutomationTrigger,
      actor: Actor,
    ): Promise<{ trigger: AutomationTrigger; secretMaterial: AutomationTriggerSecretMaterial | null }> => {
      const automation = await getAutomationById(automationId);
      if (!automation) throw notFound("Automation not found");

      let secretMaterial: AutomationTriggerSecretMaterial | null = null;
      let secretId: string | null = null;
      let publicId: string | null = null;
      let nextRunAt: Date | null = null;

      if (input.kind === "schedule") {
        const timeZone = input.timezone || "UTC";
        assertTimeZone(timeZone);
        const error = validateCron(input.cronExpression);
        if (error) throw unprocessable(error);
        nextRunAt = nextCronTickInTimeZone(input.cronExpression, timeZone, new Date());
      }

      if (input.kind === "webhook") {
        publicId = crypto.randomBytes(12).toString("hex");
        const created = await createWebhookSecret(automation.orgId, automation.id, actor);
        secretId = created.secret.id;
        secretMaterial = {
          webhookUrl: `${process.env.RUDDER_API_URL}/api/automation-triggers/public/${publicId}/fire`,
          webhookSecret: created.secretValue,
        };
      }

      const [trigger] = await db
        .insert(automationTriggers)
        .values({
          orgId: automation.orgId,
          automationId: automation.id,
          kind: input.kind,
          label: input.label ?? null,
          enabled: input.enabled ?? true,
          cronExpression: input.kind === "schedule" ? input.cronExpression : null,
          timezone: input.kind === "schedule" ? (input.timezone || "UTC") : null,
          nextRunAt,
          publicId,
          secretId,
          signingMode: input.kind === "webhook" ? input.signingMode : null,
          replayWindowSec: input.kind === "webhook" ? input.replayWindowSec : null,
          lastRotatedAt: input.kind === "webhook" ? new Date() : null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();

      return {
        trigger: trigger as AutomationTrigger,
        secretMaterial,
      };
    },

    updateTrigger: async (id: string, patch: UpdateAutomationTrigger, actor: Actor): Promise<AutomationTrigger | null> => {
      const existing = await getTriggerById(id);
      if (!existing) return null;

      let nextRunAt = existing.nextRunAt;
      let cronExpression = existing.cronExpression;
      let timezone = existing.timezone;

      if (existing.kind === "schedule") {
        if (patch.cronExpression !== undefined) {
          if (patch.cronExpression == null) throw unprocessable("Scheduled triggers require cronExpression");
          const error = validateCron(patch.cronExpression);
          if (error) throw unprocessable(error);
          cronExpression = patch.cronExpression;
        }
        if (patch.timezone !== undefined) {
          if (patch.timezone == null) throw unprocessable("Scheduled triggers require timezone");
          assertTimeZone(patch.timezone);
          timezone = patch.timezone;
        }
        if (cronExpression && timezone) {
          nextRunAt = nextCronTickInTimeZone(cronExpression, timezone, new Date());
        }
      }

      const [updated] = await db
        .update(automationTriggers)
        .set({
          label: patch.label === undefined ? existing.label : patch.label,
          enabled: patch.enabled ?? existing.enabled,
          cronExpression,
          timezone,
          nextRunAt,
          signingMode: patch.signingMode === undefined ? existing.signingMode : patch.signingMode,
          replayWindowSec: patch.replayWindowSec === undefined ? existing.replayWindowSec : patch.replayWindowSec,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(automationTriggers.id, id))
        .returning();

      return (updated as AutomationTrigger | undefined) ?? null;
    },

    deleteTrigger: async (id: string): Promise<boolean> => {
      const existing = await getTriggerById(id);
      if (!existing) return false;
      await db.delete(automationTriggers).where(eq(automationTriggers.id, id));
      return true;
    },

    rotateTriggerSecret: async (
      id: string,
      actor: Actor,
    ): Promise<{ trigger: AutomationTrigger; secretMaterial: AutomationTriggerSecretMaterial }> => {
      const existing = await getTriggerById(id);
      if (!existing) throw notFound("Automation trigger not found");
      if (existing.kind !== "webhook" || !existing.publicId || !existing.secretId) {
        throw unprocessable("Only webhook triggers can rotate secrets");
      }

      const secretValue = crypto.randomBytes(24).toString("hex");
      await secretsSvc.rotate(existing.secretId, { value: secretValue }, actor);
      const [updated] = await db
        .update(automationTriggers)
        .set({
          lastRotatedAt: new Date(),
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(automationTriggers.id, id))
        .returning();

      return {
        trigger: updated as AutomationTrigger,
        secretMaterial: {
          webhookUrl: `${process.env.RUDDER_API_URL}/api/automation-triggers/public/${existing.publicId}/fire`,
          webhookSecret: secretValue,
        },
      };
    },

    runAutomation: async (id: string, input: RunAutomation) => {
      const automation = await getAutomationById(id);
      if (!automation) throw notFound("Automation not found");
      if (automation.status === "archived") throw conflict("Automation is archived");
      const trigger = input.triggerId ? await getTriggerById(input.triggerId) : null;
      if (trigger && trigger.automationId !== automation.id) throw forbidden("Trigger does not belong to automation");
      if (trigger && !trigger.enabled) throw conflict("Automation trigger is not active");
      return dispatchAutomationRun({
        automation,
        trigger,
        source: input.source,
        payload: input.payload as Record<string, unknown> | null | undefined,
        idempotencyKey: input.idempotencyKey,
      });
    },

    firePublicTrigger: async (publicId: string, input: {
      authorizationHeader?: string | null;
      signatureHeader?: string | null;
      timestampHeader?: string | null;
      idempotencyKey?: string | null;
      rawBody?: Buffer | null;
      payload?: Record<string, unknown> | null;
    }) => {
      const trigger = await db
        .select()
        .from(automationTriggers)
        .where(and(eq(automationTriggers.publicId, publicId), eq(automationTriggers.kind, "webhook")))
        .then((rows) => rows[0] ?? null);
      if (!trigger) throw notFound("Automation trigger not found");
      const automation = await getAutomationById(trigger.automationId);
      if (!automation) throw notFound("Automation not found");
      if (!trigger.enabled || automation.status !== "active") throw conflict("Automation trigger is not active");

      const secretValue = await resolveTriggerSecret(trigger, automation.orgId);
      if (trigger.signingMode === "bearer") {
        const expected = `Bearer ${secretValue}`;
        const provided = input.authorizationHeader?.trim() ?? "";
        const expectedBuf = Buffer.from(expected);
        const providedBuf = Buffer.alloc(expectedBuf.length);
        providedBuf.write(provided.slice(0, expectedBuf.length));
        const valid =
          provided.length === expected.length &&
          crypto.timingSafeEqual(providedBuf, expectedBuf);
        if (!valid) {
          throw unauthorized();
        }
      } else {
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        const providedSignature = input.signatureHeader?.trim() ?? "";
        const providedTimestamp = input.timestampHeader?.trim() ?? "";
        if (!providedSignature || !providedTimestamp) throw unauthorized();
        const tsMillis = normalizeWebhookTimestampMs(providedTimestamp);
        if (tsMillis == null) throw unauthorized();
        const replayWindowSec = trigger.replayWindowSec ?? 300;
        if (Math.abs(Date.now() - tsMillis) > replayWindowSec * 1000) {
          throw unauthorized();
        }
        const expectedHmac = crypto
          .createHmac("sha256", secretValue)
          .update(`${providedTimestamp}.`)
          .update(rawBody)
          .digest("hex");
        const normalizedSignature = providedSignature.replace(/^sha256=/, "");
        const valid =
          normalizedSignature.length === expectedHmac.length &&
          crypto.timingSafeEqual(Buffer.from(normalizedSignature), Buffer.from(expectedHmac));
        if (!valid) throw unauthorized();
      }

      return dispatchAutomationRun({
        automation,
        trigger,
        source: "webhook",
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      });
    },

    listRuns: async (automationId: string, limit = 50): Promise<AutomationRunSummary[]> => {
      const cappedLimit = Math.max(1, Math.min(limit, 200));
      const rows = await db
        .select({
          id: automationRuns.id,
          orgId: automationRuns.orgId,
          automationId: automationRuns.automationId,
          triggerId: automationRuns.triggerId,
          source: automationRuns.source,
          status: automationRuns.status,
          triggeredAt: automationRuns.triggeredAt,
          idempotencyKey: automationRuns.idempotencyKey,
          triggerPayload: automationRuns.triggerPayload,
          linkedIssueId: automationRuns.linkedIssueId,
          coalescedIntoRunId: automationRuns.coalescedIntoRunId,
          failureReason: automationRuns.failureReason,
          completedAt: automationRuns.completedAt,
          createdAt: automationRuns.createdAt,
          updatedAt: automationRuns.updatedAt,
          triggerKind: automationTriggers.kind,
          triggerLabel: automationTriggers.label,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
          issuePriority: issues.priority,
          issueUpdatedAt: issues.updatedAt,
        })
        .from(automationRuns)
        .leftJoin(automationTriggers, eq(automationRuns.triggerId, automationTriggers.id))
        .leftJoin(issues, eq(automationRuns.linkedIssueId, issues.id))
        .where(eq(automationRuns.automationId, automationId))
        .orderBy(desc(automationRuns.createdAt))
        .limit(cappedLimit);

      return rows.map((row) => ({
        id: row.id,
        orgId: row.orgId,
        automationId: row.automationId,
        triggerId: row.triggerId,
        source: row.source as AutomationRunSummary["source"],
        status: row.status as AutomationRunSummary["status"],
        triggeredAt: row.triggeredAt,
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        linkedIssueId: row.linkedIssueId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier,
            title: row.issueTitle ?? "Automation execution",
            status: row.issueStatus ?? "todo",
            priority: row.issuePriority ?? "medium",
            updatedAt: row.issueUpdatedAt ?? row.updatedAt,
          }
          : null,
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<AutomationRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      }));
    },

    tickScheduledTriggers: async (now: Date = new Date()) => {
      const due = await db
        .select({
          trigger: automationTriggers,
          automation: automations,
        })
        .from(automationTriggers)
        .innerJoin(automations, eq(automationTriggers.automationId, automations.id))
        .where(
          and(
            eq(automationTriggers.kind, "schedule"),
            eq(automationTriggers.enabled, true),
            eq(automations.status, "active"),
            isNotNull(automationTriggers.nextRunAt),
            lte(automationTriggers.nextRunAt, now),
          ),
        )
        .orderBy(asc(automationTriggers.nextRunAt), asc(automationTriggers.createdAt));

      let triggered = 0;
      for (const row of due) {
        if (!row.trigger.nextRunAt || !row.trigger.cronExpression || !row.trigger.timezone) continue;

        let runCount = 1;
        let claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, now);

        if (row.automation.catchUpPolicy === "enqueue_missed_with_cap") {
          let cursor: Date | null = row.trigger.nextRunAt;
          runCount = 0;
          while (cursor && cursor <= now && runCount < MAX_CATCH_UP_RUNS) {
            runCount += 1;
            claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, cursor);
            cursor = claimedNextRunAt;
          }
        }

        const claimed = await db
          .update(automationTriggers)
          .set({
            nextRunAt: claimedNextRunAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(automationTriggers.id, row.trigger.id),
              eq(automationTriggers.enabled, true),
              eq(automationTriggers.nextRunAt, row.trigger.nextRunAt),
            ),
          )
          .returning({ id: automationTriggers.id })
          .then((rows) => rows[0] ?? null);
        if (!claimed) continue;

        for (let i = 0; i < runCount; i += 1) {
          await dispatchAutomationRun({
            automation: row.automation,
            trigger: row.trigger,
            source: "schedule",
          });
          triggered += 1;
        }
      }

      return { triggered };
    },

    syncRunStatusForIssue: async (issueId: string) => {
      const issue = await db
        .select({
          id: issues.id,
          status: issues.status,
          originKind: issues.originKind,
          originRunId: issues.originRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue || issue.originKind !== "automation_execution" || !issue.originRunId) return null;
      if (issue.status === "done") {
        return finalizeRun(issue.originRunId, {
          status: "completed",
          completedAt: new Date(),
        });
      }
      if (issue.status === "blocked" || issue.status === "cancelled") {
        return finalizeRun(issue.originRunId, {
          status: "failed",
          failureReason: `Execution issue moved to ${issue.status}`,
          completedAt: new Date(),
        });
      }
      return null;
    },
  };
}
