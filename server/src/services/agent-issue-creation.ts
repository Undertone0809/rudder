import type { Db } from "@rudderhq/db";
import {
  agentIssueCreationRequests,
  agentWakeupRequests,
  agents,
  goals,
  heartbeatRuns,
  issues,
  projects,
} from "@rudderhq/db";
import type { AgentIssueCreationRequestStatus, CreateAgentIssueCreationRequest } from "@rudderhq/shared";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { resolveIssueReferenceInputs } from "./issue-references.js";

type AgentIssueCreationRequestRow = typeof agentIssueCreationRequests.$inferSelect;

type CreateRequestInput = CreateAgentIssueCreationRequest & {
  orgId: string;
  requestedByUserId: string;
};

type RequestUpdate = Partial<Pick<
  typeof agentIssueCreationRequests.$inferInsert,
  "status" | "wakeupAttempt" | "wakeupAttemptId" | "wakeupRequestId" | "runId" | "createdIssueId" | "error" | "startedAt" | "finishedAt"
>>;

type RequestUpdateOptions = {
  expectedStatuses?: AgentIssueCreationRequestStatus[];
};

export type AgentIssueCreationNotificationIntent = {
  orgId: string;
  agentId: string;
  runId: string;
  requestId: string;
  issueId: string;
};

export type AgentIssueCreationSettlementIntent = {
  orgId: string;
  agentId: string;
  runId: string;
  requestId: string;
};

const RUNTIME_OWNED_CONTEXT_KEYS = new Set([
  "agentId",
  "agentIssueCreationRequest",
  "agentIssueCreationRequestId",
  "approvalId",
  "approvalStatus",
  "commentId",
  "createdIssueId",
  "error",
  "goalId",
  "instruction",
  "issueId",
  "organizationId",
  "parentId",
  "projectId",
  "recovery",
  "relationship",
  "requestedByUserId",
  "role",
  "runId",
  "rudderScene",
  "status",
  "targetId",
  "targetType",
  "taskId",
  "taskKey",
  "wakeCommentId",
  "wakeReason",
  "wakeSource",
  "wakeTriggerDetail",
  "wakeupRequestId",
]);
const ACTIVE_REQUEST_STATUSES: AgentIssueCreationRequestStatus[] = ["queued", "running", "deferred"];

export function sanitizeAgentIssueCreationContextSnapshot(
  input: Record<string, unknown> | null | undefined,
) {
  return Object.fromEntries(
    Object.entries(input ?? {}).filter(([key]) =>
      !RUNTIME_OWNED_CONTEXT_KEYS.has(key) && !key.startsWith("rudder")),
  );
}

function sameRequest(
  existing: AgentIssueCreationRequestRow,
  input: CreateRequestInput,
) {
  return existing.agentId === input.agentId
    && existing.instruction === input.instruction
    && existing.projectId === (input.projectId ?? null)
    && existing.goalId === (input.goalId ?? null)
    && existing.parentId === (input.parentId ?? null);
}

function requestIdsFromRunContext(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  const ids: string[] = [];
  const directId = context.agentIssueCreationRequestId;
  if (typeof directId === "string" && directId.trim()) ids.push(directId.trim());
  const nested = context.agentIssueCreationRequest;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const nestedId = (nested as Record<string, unknown>).id;
    if (typeof nestedId === "string" && nestedId.trim()) ids.push(nestedId.trim());
  }
  return [...new Set(ids)];
}

function requestIdFromRunContext(contextSnapshot: unknown) {
  const ids = requestIdsFromRunContext(contextSnapshot);
  return ids?.length === 1 ? ids[0]! : null;
}

export function getAgentIssueCreationRequestIdFromRunContext(contextSnapshot: unknown) {
  return requestIdFromRunContext(contextSnapshot);
}

export function hasAgentIssueCreationRequestContext(contextSnapshot: unknown) {
  return (requestIdsFromRunContext(contextSnapshot)?.length ?? 0) > 0;
}

export function agentIssueCreationService(db: Db) {
  async function publishCreatedIssueNotification(
    database: Db,
    request: AgentIssueCreationRequestRow,
    input: { agentId: string; runId: string; issueId: string },
  ) {
    const [issue, agent] = await Promise.all([
      database
        .select({ identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(and(eq(issues.orgId, request.orgId), eq(issues.id, input.issueId)))
        .then((rows) => rows[0] ?? null),
      database
        .select({ name: agents.name })
        .from(agents)
        .where(and(eq(agents.orgId, request.orgId), eq(agents.id, input.agentId)))
        .then((rows) => rows[0] ?? null),
    ]);
    await logActivity(database, {
      orgId: request.orgId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      runId: input.runId,
      action: "agent.issue_created_notification",
      entityType: "issue",
      entityId: input.issueId,
      details: {
        issueId: input.issueId,
        identifier: issue?.identifier ?? null,
        title: issue?.title ?? null,
        agentId: input.agentId,
        agentName: agent?.name ?? null,
        requestId: request.id,
        userId: request.requestedByUserId,
        source: "agent.issue_created_notification",
      },
      idempotencyKey: `agent-issue-created-notification:${request.id}`,
    });
  }

  async function getById(orgId: string, id: string) {
    return db
      .select()
      .from(agentIssueCreationRequests)
      .where(and(eq(agentIssueCreationRequests.orgId, orgId), eq(agentIssueCreationRequests.id, id)))
      .then((rows) => rows[0] ?? null);
  }

  async function getByIdempotencyKey(orgId: string, requestedByUserId: string, idempotencyKey: string) {
    return db
      .select()
      .from(agentIssueCreationRequests)
      .where(and(
        eq(agentIssueCreationRequests.orgId, orgId),
        eq(agentIssueCreationRequests.requestedByUserId, requestedByUserId),
        eq(agentIssueCreationRequests.idempotencyKey, idempotencyKey),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function listForRequester(orgId: string, requestedByUserId: string) {
    return db
      .select()
      .from(agentIssueCreationRequests)
      .where(and(
        eq(agentIssueCreationRequests.orgId, orgId),
        eq(agentIssueCreationRequests.requestedByUserId, requestedByUserId),
        inArray(agentIssueCreationRequests.status, ["failed", "cancelled"]),
        isNull(agentIssueCreationRequests.createdIssueId),
      ))
      .orderBy(desc(agentIssueCreationRequests.updatedAt), desc(agentIssueCreationRequests.createdAt))
      .limit(100);
  }

  async function getByRunId(orgId: string, agentId: string, runId: string) {
    return db
      .select()
      .from(agentIssueCreationRequests)
      .where(and(
        eq(agentIssueCreationRequests.orgId, orgId),
        eq(agentIssueCreationRequests.agentId, agentId),
        eq(agentIssueCreationRequests.runId, runId),
        inArray(agentIssueCreationRequests.status, ACTIVE_REQUEST_STATUSES),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function reconcileTerminalSettlements() {
    const candidates = await db
      .select({ request: agentIssueCreationRequests, run: heartbeatRuns })
      .from(agentIssueCreationRequests)
      .innerJoin(heartbeatRuns, eq(agentIssueCreationRequests.runId, heartbeatRuns.id))
      .where(and(
        eq(agentIssueCreationRequests.orgId, heartbeatRuns.orgId),
        eq(agentIssueCreationRequests.agentId, heartbeatRuns.agentId),
        inArray(agentIssueCreationRequests.status, ACTIVE_REQUEST_STATUSES),
        inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out"]),
      ))
      .orderBy(asc(agentIssueCreationRequests.updatedAt), asc(agentIssueCreationRequests.createdAt))
      .limit(100);

    const settledRequestIds: string[] = [];
    for (const { request, run } of candidates) {
      try {
        const settled = await settleForRun({
          orgId: request.orgId,
          agentId: request.agentId,
          runId: run.id,
          requestId: request.id,
          runStatus: run.status as "succeeded" | "failed" | "cancelled" | "timed_out",
          error: run.error,
        });
        if (settled) settledRequestIds.push(settled.id);
      } catch (error) {
        logger.warn(
          {
            err: error,
            orgId: request.orgId,
            agentId: request.agentId,
            runId: run.id,
            requestId: request.id,
          },
          "failed to reconcile Agent Issue creation request after terminal run",
        );
      }
    }

    return { scanned: candidates.length, settledRequestIds };
  }

  async function getNotificationIntentForRun(
    orgId: string,
    agentId: string,
    runId: string,
  ): Promise<AgentIssueCreationNotificationIntent | null> {
    const request = await db
      .select()
      .from(agentIssueCreationRequests)
      .where(and(
        eq(agentIssueCreationRequests.orgId, orgId),
        eq(agentIssueCreationRequests.agentId, agentId),
        eq(agentIssueCreationRequests.runId, runId),
        eq(agentIssueCreationRequests.status, "succeeded"),
      ))
      .then((rows) => rows.find((row) => row.createdIssueId !== null) ?? null);
    if (!request?.createdIssueId) return null;

    const issue = await getAgentIssueCreationOriginIssue({
      orgId,
      requestId: request.id,
      runId,
      agentId,
      issueId: request.createdIssueId,
    });
    if (!issue) return null;

    return {
      orgId,
      agentId,
      runId,
      requestId: request.id,
      issueId: request.createdIssueId,
    };
  }

  async function resolveForRun(orgId: string, agentId: string, runId: string) {
    const persistedRequest = await getByRunId(orgId, agentId, runId);
    const run = await db
      .select({
        id: heartbeatRuns.id,
        orgId: heartbeatRuns.orgId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.orgId, orgId),
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.id, runId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!run) {
      const unscopedRun = await db
        .select({
          orgId: heartbeatRuns.orgId,
          agentId: heartbeatRuns.agentId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (unscopedRun && hasAgentIssueCreationRequestContext(unscopedRun.contextSnapshot)) {
        throw forbidden("Agent Issue creation run context does not belong to this organization and Agent");
      }
      return null;
    }

    const requestId = requestIdFromRunContext(run.contextSnapshot);
    if (!requestId) {
      if (hasAgentIssueCreationRequestContext(run.contextSnapshot)) {
        throw conflict("Agent Issue creation run context is ambiguous");
      }
      if (persistedRequest) {
        if (["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)) {
          throw conflict("Agent Issue creation run is already terminal");
        }
        return persistedRequest;
      }
      return null;
    }
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)) {
      throw conflict("Agent Issue creation run is already terminal");
    }
    if (persistedRequest) {
      if (persistedRequest.id !== requestId) {
        throw conflict("Agent Issue creation request does not match the active run");
      }
      return persistedRequest;
    }

    const request = await getById(orgId, requestId);
    if (
      !request
      || request.agentId !== agentId
      || (request.runId !== null && request.runId !== run.id)
      || !ACTIVE_REQUEST_STATUSES.includes(request.status as AgentIssueCreationRequestStatus)
    ) {
      throw conflict("Agent Issue creation request does not match the active run");
    }
    return request;
  }

  async function resolveTerminalRequestForRun(input: {
    orgId: string;
    agentId: string;
    runId: string;
    requestId?: string | null;
  }) {
    const persistedRequest = await db
      .select()
      .from(agentIssueCreationRequests)
      .where(and(
        eq(agentIssueCreationRequests.orgId, input.orgId),
        eq(agentIssueCreationRequests.agentId, input.agentId),
        eq(agentIssueCreationRequests.runId, input.runId),
      ))
      .then((rows) => rows[0] ?? null);
    const run = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.orgId, input.orgId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.id, input.runId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!run) return null;
    const contextRequestId = requestIdFromRunContext(run?.contextSnapshot);
    const explicitRequestId = input.requestId?.trim() || null;
    if (persistedRequest) {
      if (hasAgentIssueCreationRequestContext(run.contextSnapshot) && contextRequestId !== persistedRequest.id) {
        return null;
      }
      if (explicitRequestId !== null && explicitRequestId !== persistedRequest.id) return null;
      return { request: persistedRequest, requestId: persistedRequest.id };
    }
    if (!contextRequestId || (explicitRequestId !== null && explicitRequestId !== contextRequestId)) return null;
    const request = await getById(input.orgId, contextRequestId);
    if (
      !request
      || request.agentId !== input.agentId
      || (request.runId !== null && request.runId !== input.runId)
    ) {
      return null;
    }
    return { request, requestId: contextRequestId };
  }

  async function getSettlementIntentForRun(
    orgId: string,
    agentId: string,
    runId: string,
  ): Promise<AgentIssueCreationSettlementIntent | null> {
    const resolved = await resolveTerminalRequestForRun({ orgId, agentId, runId });
    if (
      !resolved
      || resolved.request.createdIssueId
      || !ACTIVE_REQUEST_STATUSES.includes(resolved.request.status as AgentIssueCreationRequestStatus)
    ) {
      return null;
    }
    return {
      orgId,
      agentId,
      runId,
      requestId: resolved.requestId,
    };
  }

  async function getAgentIssueCreationOriginIssue(input: {
    orgId: string;
    requestId: string;
    runId?: string | null;
    agentId?: string | null;
    issueId?: string | null;
  }) {
    const conditions = [
      eq(issues.orgId, input.orgId),
      eq(issues.originKind, "agent_issue_creation"),
      eq(issues.originId, input.requestId),
    ];
    if (input.runId !== undefined && input.runId !== null) {
      conditions.push(eq(issues.originRunId, input.runId));
    }
    if (input.agentId !== undefined && input.agentId !== null) {
      conditions.push(eq(issues.createdByAgentId, input.agentId));
    }
    if (input.issueId) conditions.push(eq(issues.id, input.issueId));
    return db
      .select({ id: issues.id, originRunId: issues.originRunId, createdByAgentId: issues.createdByAgentId })
      .from(issues)
      .where(and(...conditions))
      .then((rows) => rows[0] ?? null);
  }

  async function publishNotificationForRequest(input: AgentIssueCreationNotificationIntent) {
    const request = await getById(input.orgId, input.requestId);
    if (
      !request
      || request.agentId !== input.agentId
      || request.status !== "succeeded"
      || request.createdIssueId !== input.issueId
      || request.runId !== input.runId
    ) {
      throw conflict("Agent Issue creation notification does not match the completed request");
    }

    const issue = await getAgentIssueCreationOriginIssue({
      orgId: input.orgId,
      requestId: input.requestId,
      runId: input.runId,
      agentId: input.agentId,
      issueId: input.issueId,
    });
    if (!issue) {
      throw conflict("Agent Issue creation notification source Issue is unavailable");
    }

    await publishCreatedIssueNotification(db, request, {
      agentId: input.agentId,
      runId: input.runId,
      issueId: input.issueId,
    });
    return request;
  }

  async function getWakeupByIdempotencyKey(orgId: string, agentId: string, idempotencyKey: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.orgId, orgId),
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function assertRequestReferences(input: CreateRequestInput) {
    const agent = await db
      .select({ id: agents.id, orgId: agents.orgId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    if (agent.orgId !== input.orgId) throw unprocessable("Agent must belong to same organization");
    if (agent.status === "terminated") throw conflict("Cannot request work from a terminated agent");
    if (agent.status === "pending_approval") throw conflict("Cannot request work from a pending approval agent");

    if (input.projectId) {
      const project = await db
        .select({ id: projects.id, orgId: projects.orgId })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .then((rows) => rows[0] ?? null);
      if (!project) throw notFound("Project not found");
      if (project.orgId !== input.orgId) throw unprocessable("Project must belong to same organization");
    }

    if (input.goalId) {
      const goal = await db
        .select({ id: goals.id, orgId: goals.orgId })
        .from(goals)
        .where(eq(goals.id, input.goalId))
        .then((rows) => rows[0] ?? null);
      if (!goal) throw notFound("Goal not found");
      if (goal.orgId !== input.orgId) throw unprocessable("Goal must belong to same organization");
    }

    if (input.parentId) {
      const parent = await db
        .select({ id: issues.id, orgId: issues.orgId })
        .from(issues)
        .where(eq(issues.id, input.parentId))
        .then((rows) => rows[0] ?? null);
      if (!parent) throw notFound("Parent issue not found");
      if (parent.orgId !== input.orgId) throw unprocessable("Parent issue must belong to same organization");
    }
  }

  async function create(input: CreateRequestInput) {
    input = await resolveIssueReferenceInputs(
      db,
      input.orgId,
      input as unknown as Record<string, unknown>,
    ) as CreateRequestInput;
    const existing = await getByIdempotencyKey(input.orgId, input.requestedByUserId, input.idempotencyKey);
    if (existing) {
      if (!sameRequest(existing, input)) {
        throw conflict("Idempotency key is already used for a different Agent Issue request");
      }
      if (existing.status === "failed" || existing.status === "cancelled") {
        throw conflict("Agent Issue request is already terminal; use a new idempotency key to retry");
      }
      return {
        request: existing,
        created: false as const,
        needsAdmission: existing.status === "queued",
      };
    }

    await assertRequestReferences(input);
    const contextSnapshot = {
      ...sanitizeAgentIssueCreationContextSnapshot(input.contextSnapshot),
      organizationId: input.orgId,
      projectId: input.projectId ?? null,
      goalId: input.goalId ?? null,
      parentId: input.parentId ?? null,
    };
    const [request] = await db
      .insert(agentIssueCreationRequests)
      .values({
        orgId: input.orgId,
        requestedByUserId: input.requestedByUserId,
        agentId: input.agentId,
        instruction: input.instruction,
        projectId: input.projectId ?? null,
        goalId: input.goalId ?? null,
        parentId: input.parentId ?? null,
        contextSnapshot,
        idempotencyKey: input.idempotencyKey,
        status: "queued",
      })
      .onConflictDoNothing()
      .returning();
    if (request) return { request, created: true as const, needsAdmission: true };

    const raced = await getByIdempotencyKey(input.orgId, input.requestedByUserId, input.idempotencyKey);
    if (!raced) throw conflict("Agent Issue request could not be created");
    if (!sameRequest(raced, input)) {
      throw conflict("Idempotency key is already used for a different Agent Issue request");
    }
    if (raced.status === "failed" || raced.status === "cancelled") {
      throw conflict("Agent Issue request is already terminal; use a new idempotency key to retry");
    }
    return {
      request: raced,
      created: false as const,
      needsAdmission: raced.status === "queued",
    };
  }

  async function update(
    orgId: string,
    id: string,
    patch: RequestUpdate,
    options: RequestUpdateOptions = {},
  ) {
    const conditions = [
      eq(agentIssueCreationRequests.orgId, orgId),
      eq(agentIssueCreationRequests.id, id),
    ];
    if (options.expectedStatuses?.length) {
      conditions.push(inArray(agentIssueCreationRequests.status, options.expectedStatuses));
    }
    const [updated] = await db
      .update(agentIssueCreationRequests)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
    return updated ?? null;
  }

  async function retry(orgId: string, id: string, requestedByUserId: string) {
    const existing = await getById(orgId, id);
    if (!existing || existing.requestedByUserId !== requestedByUserId) {
      throw notFound("Agent Issue request not found");
    }
    if (existing.createdIssueId) {
      throw conflict("Agent Issue request already created an Issue");
    }
    if (existing.status !== "failed" && existing.status !== "cancelled") {
      throw conflict("Only failed or cancelled Agent Issue requests can be retried", {
        status: existing.status,
      });
    }

    const [retried] = await db
      .update(agentIssueCreationRequests)
      .set({
        status: "queued",
        wakeupAttempt: sql`${agentIssueCreationRequests.wakeupAttempt} + 1`,
        wakeupAttemptId: randomUUID(),
        wakeupRequestId: null,
        runId: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentIssueCreationRequests.orgId, orgId),
        eq(agentIssueCreationRequests.id, id),
        eq(agentIssueCreationRequests.requestedByUserId, requestedByUserId),
        isNull(agentIssueCreationRequests.createdIssueId),
        inArray(agentIssueCreationRequests.status, ["failed", "cancelled"]),
      ))
      .returning();
    if (retried) return retried;

    const current = await getById(orgId, id);
    if (!current || current.requestedByUserId !== requestedByUserId) {
      throw notFound("Agent Issue request not found");
    }
    throw conflict("Agent Issue request changed before retry", { status: current.status });
  }

  async function completeForCreatedIssue(input: {
    orgId: string;
    agentId: string;
    runId: string;
    issueId: string;
    requestId?: string | null;
  }) {
    const resolved = await resolveTerminalRequestForRun(input);
    if (!resolved) return null;
    const { requestId: contextRequestId } = resolved;
    const createdIssue = await getAgentIssueCreationOriginIssue({
      orgId: input.orgId,
      requestId: contextRequestId,
      runId: input.runId,
      agentId: input.agentId,
      issueId: input.issueId,
    });
    if (!createdIssue) return null;

    const updated = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(agentIssueCreationRequests)
        .set({
          status: "succeeded",
          runId: input.runId,
          createdIssueId: input.issueId,
          finishedAt: new Date(),
          error: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(agentIssueCreationRequests.orgId, input.orgId),
          eq(agentIssueCreationRequests.agentId, input.agentId),
          contextRequestId
            ? eq(agentIssueCreationRequests.id, contextRequestId)
            : eq(agentIssueCreationRequests.runId, input.runId),
          or(isNull(agentIssueCreationRequests.runId), eq(agentIssueCreationRequests.runId, input.runId)),
          isNull(agentIssueCreationRequests.createdIssueId),
          inArray(agentIssueCreationRequests.status, ACTIVE_REQUEST_STATUSES),
        ))
        .returning();
      return updated ?? null;
    });

    const completed = updated
      ?? (resolved.request.status === "succeeded" && resolved.request.createdIssueId === input.issueId
        ? resolved.request
        : null);
    if (completed) {
      try {
        // The request outcome is durable before notification delivery starts.
        // Terminal effects provide the retry path if this immediate attempt fails.
        await publishCreatedIssueNotification(db, completed, input);
      } catch (error) {
        logger.warn(
          {
            err: error,
            orgId: input.orgId,
            agentId: input.agentId,
            runId: input.runId,
            requestId: completed.id,
            issueId: input.issueId,
          },
          "failed to publish Agent Issue creation notification; terminal effects will retry",
        );
      }
    }
    return updated ?? null;
  }

  async function settleForRun(input: {
    orgId: string;
    agentId: string;
    runId: string;
    requestId?: string | null;
    runStatus: "succeeded" | "failed" | "cancelled" | "timed_out";
    error?: string | null;
  }) {
    const requestId = input.requestId?.trim() || null;
    const resolved = await resolveTerminalRequestForRun({ ...input, requestId });
    if (!resolved) return null;
    const { request } = resolved;

    const createdIssue = await getAgentIssueCreationOriginIssue({
      orgId: input.orgId,
      requestId: resolved.requestId,
      runId: input.runId,
      agentId: input.agentId,
    });
    if (createdIssue) {
      return await completeForCreatedIssue({
        orgId: input.orgId,
        agentId: input.agentId,
        runId: input.runId,
        issueId: createdIssue.id,
        requestId: resolved.requestId,
      });
    }

    // An origin-bearing Issue with a different owner or run is not evidence
    // that this request failed. Leave the request active for the producer that
    // owns that origin instead of mutating it from an unrelated terminal hook.
    const mismatchedOriginIssue = await getAgentIssueCreationOriginIssue({
      orgId: input.orgId,
      requestId: resolved.requestId,
    });
    if (mismatchedOriginIssue) return null;

    const requestStatus = input.runStatus === "cancelled" ? "cancelled" : "failed";
    const error = input.error?.trim()
      || (input.runStatus === "succeeded"
        ? "Agent run completed without creating an Issue"
        : `Agent run ${input.runStatus}`);
    const match = [
      eq(agentIssueCreationRequests.orgId, input.orgId),
      eq(agentIssueCreationRequests.agentId, input.agentId),
      eq(agentIssueCreationRequests.id, resolved.requestId),
      or(isNull(agentIssueCreationRequests.runId), eq(agentIssueCreationRequests.runId, input.runId)),
      isNull(agentIssueCreationRequests.createdIssueId),
      inArray(agentIssueCreationRequests.status, ACTIVE_REQUEST_STATUSES),
    ];
    const [updated] = await db
      .update(agentIssueCreationRequests)
      .set({
        status: requestStatus,
        runId: input.runId,
        error,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(...match))
      .returning();
    if (updated) {
      try {
        await logActivity(db, {
          orgId: input.orgId,
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          runId: input.runId,
          action: "agent.issue_creation_failed",
          entityType: "agent_issue_creation_request",
          entityId: updated.id,
          details: {
            requestId: updated.id,
            requestedByUserId: request.requestedByUserId,
            userId: request.requestedByUserId,
            agentId: input.agentId,
            runId: input.runId,
            status: requestStatus,
            error,
            source: "agent.issue_creation_failed",
          },
          idempotencyKey: `agent-issue-creation-failed:${updated.id}:${input.runId}`,
        });
      } catch (activityError) {
        logger.warn(
          {
            err: activityError,
            orgId: input.orgId,
            agentId: input.agentId,
            runId: input.runId,
            requestId: updated.id,
          },
          "failed to publish Agent Issue creation failure activity",
        );
      }
    }
    return updated ?? null;
  }

  return {
    create,
    completeForCreatedIssue,
    getById,
    getByIdempotencyKey,
    listForRequester,
    getNotificationIntentForRun,
    getSettlementIntentForRun,
    reconcileTerminalSettlements,
    publishNotificationForRequest,
    resolveForRun,
    getWakeupByIdempotencyKey,
    retry,
    settleForRun,
    update,
  };
}
