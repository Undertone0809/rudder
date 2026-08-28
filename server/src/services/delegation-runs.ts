import type { Db } from "@rudderhq/db";
import { agentWakeupRequests, agents } from "@rudderhq/db";
import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { conflict, forbidden, notFound } from "../errors.js";

export const DELEGATION_RUN_SCENE = "delegation" as const;
export const DELEGATION_RUN_SOURCE = "delegation" as const;
export const DELEGATION_RUN_TRIGGER_REASON = "agent_run_created" as const;
export const DELEGATION_RUN_TASK_MAX_BYTES = 20_000;

type DelegationRunRecord = Awaited<ReturnType<DelegationHeartbeat["getRun"]>>;

type DelegationHeartbeat = {
  getRun: (runId: string) => Promise<Record<string, any> | null>;
  wakeup: (agentId: string, options: Record<string, unknown>) => Promise<Record<string, any> | null>;
};

type DelegationAccess = {
  hasPermission: (
    orgId: string,
    principalType: "user" | "agent",
    principalId: string,
    permissionKey: "tasks:assign" | string,
  ) => Promise<boolean>;
};

export type CreateDelegationRunInput = {
  sourceAgentId: string;
  sourceRunId: string;
  task: string;
  targetAgentId?: string;
  idempotencyKey: string;
  requestedByActorId?: string | null;
};

export type DelegationAdmissionStatus =
  | "queued"
  | "deferred"
  | "skipped"
  | "coalesced"
  | "replayed"
  | "completed"
  | "failed"
  | "cancelled";

export type DelegationRunAdmission = {
  run: DelegationRunRecord;
  runId: string | null;
  wakeupRequestId: string;
  sourceRunId: string;
  sourceAgentId: string;
  targetAgentId: string;
  scene: typeof DELEGATION_RUN_SCENE;
  admissionStatus: DelegationAdmissionStatus;
  replayed: boolean;
};

function textByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function readPayloadString(payload: unknown, key: string) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function delegationTaskKey(targetAgentId: string, idempotencyKey: string) {
  const digest = createHash("sha256")
    .update(`${targetAgentId}\0${idempotencyKey}`)
    .digest("hex");
  return `delegation:${digest}`;
}

function admissionStatusForRequest(status: string): DelegationAdmissionStatus {
  switch (status) {
    case "queued":
    case "claimed":
      return "queued";
    case "deferred_agent_paused":
    case "deferred_issue_execution":
    case "deferred_goal_focus":
    case "deferred_goal_blocked":
      return "deferred";
    case "coalesced":
      return "coalesced";
    case "skipped":
      return "skipped";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "queued";
  }
}

export function delegationRunService(
  db: Db,
  dependencies: { heartbeat: DelegationHeartbeat; access: DelegationAccess },
) {
  async function findRequest(orgId: string, idempotencyKey: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.orgId, orgId),
        eq(agentWakeupRequests.delegationIdempotencyKey, idempotencyKey),
      ))
      .orderBy(desc(agentWakeupRequests.createdAt), desc(agentWakeupRequests.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function loadRun(request: typeof agentWakeupRequests.$inferSelect) {
    if (!request.runId) return null;
    const run = await dependencies.heartbeat.getRun(request.runId);
    if (!run || run.orgId !== request.orgId || run.agentId !== request.agentId) return null;
    return run;
  }

  function assertRequestMatches(
    request: typeof agentWakeupRequests.$inferSelect,
    input: { task: string; targetAgentId: string; idempotencyKey: string },
  ) {
    const existingTask = readPayloadString(request.payload, "delegationTask");
    if (request.agentId !== input.targetAgentId || existingTask !== input.task) {
      throw conflict("Delegation idempotency key conflicts with an existing task or target", {
        idempotencyKey: input.idempotencyKey,
        existingTargetAgentId: request.agentId,
      });
    }
  }

  async function validateInput(input: CreateDelegationRunInput) {
    const task = input.task.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!task) throw conflict("Delegation task must not be empty");
    if (textByteLength(task) > DELEGATION_RUN_TASK_MAX_BYTES) {
      throw conflict("Delegation task must be no more than 20,000 UTF-8 bytes");
    }
    if (!idempotencyKey) throw conflict("Delegation idempotency key must not be empty");

    const sourceRun = await dependencies.heartbeat.getRun(input.sourceRunId);
    if (!sourceRun) throw notFound("Source Run not found");
    if (sourceRun.agentId !== input.sourceAgentId) {
      throw forbidden("Source Run does not belong to the authenticated Agent");
    }
    if (sourceRun.status !== "queued" && sourceRun.status !== "running") {
      throw conflict("Source Run is no longer active", { status: sourceRun.status });
    }

    const sourceAgent = await db
      .select({ id: agents.id, orgId: agents.orgId })
      .from(agents)
      .where(eq(agents.id, input.sourceAgentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!sourceAgent) throw notFound("Source Agent not found");
    if (sourceAgent.orgId !== sourceRun.orgId) {
      throw forbidden("Source Run organization does not match the authenticated Agent");
    }

    const targetAgentId = input.targetAgentId?.trim() || input.sourceAgentId;
    const targetAgent = await db
      .select({ id: agents.id, orgId: agents.orgId })
      .from(agents)
      .where(eq(agents.id, targetAgentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!targetAgent) throw notFound("Target Agent not found");
    if (targetAgent.orgId !== sourceAgent.orgId) {
      throw forbidden("Target Agent must belong to the same organization");
    }
    if (targetAgentId !== input.sourceAgentId) {
      const allowed = await dependencies.access.hasPermission(
        sourceAgent.orgId,
        "agent",
        input.sourceAgentId,
        "tasks:assign",
      );
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
    }

    return {
      orgId: sourceAgent.orgId,
      task,
      idempotencyKey,
      targetAgentId,
      sourceRun,
    };
  }

  async function create(input: CreateDelegationRunInput): Promise<DelegationRunAdmission> {
    const validated = await validateInput(input);
    const existing = await findRequest(validated.orgId, validated.idempotencyKey);
    if (existing) {
      assertRequestMatches(existing, validated);
      const existingRun = await loadRun(existing);
      const existingSourceRunId = readPayloadString(existing.payload, "sourceRunId")
        ?? (existingRun && typeof existingRun.sourceRunId === "string" ? existingRun.sourceRunId : null)
        ?? input.sourceRunId;
      return {
        run: existingRun,
        runId: existing.runId ?? existingRun?.id ?? null,
        wakeupRequestId: existing.id,
        sourceRunId: existingSourceRunId,
        sourceAgentId: input.sourceAgentId,
        targetAgentId: validated.targetAgentId,
        scene: DELEGATION_RUN_SCENE,
        admissionStatus: "replayed",
        replayed: true,
      };
    }

    const taskKey = delegationTaskKey(validated.targetAgentId, validated.idempotencyKey);
    const contextSnapshot = {
      scene: DELEGATION_RUN_SCENE,
      rudderScene: DELEGATION_RUN_SCENE,
      triggerKind: DELEGATION_RUN_TRIGGER_REASON,
      targetType: "wakeup_request",
      sourceRunId: input.sourceRunId,
      sourceAgentId: input.sourceAgentId,
      targetAgentId: validated.targetAgentId,
      delegationTask: validated.task,
      taskKey,
      wakeReason: DELEGATION_RUN_TRIGGER_REASON,
      wakeSource: DELEGATION_RUN_SOURCE,
      forceFreshSession: true,
    };
    const payload = {
      delegationTask: validated.task,
      delegationTargetAgentId: validated.targetAgentId,
      sourceRunId: input.sourceRunId,
    };

    let run: Record<string, any> | null = null;
    try {
      run = await dependencies.heartbeat.wakeup(validated.targetAgentId, {
        source: DELEGATION_RUN_SOURCE,
        triggerDetail: "agent_run_created",
        reason: DELEGATION_RUN_TRIGGER_REASON,
        payload,
        idempotencyKey: validated.idempotencyKey,
        delegationIdempotencyKey: validated.idempotencyKey,
        sourceRunId: input.sourceRunId,
        requestedByActorType: "agent",
        requestedByActorId: input.sourceAgentId,
        contextSnapshot,
      });
    } catch (error) {
      const raced = await findRequest(validated.orgId, validated.idempotencyKey);
      if (!raced) throw error;
      assertRequestMatches(raced, validated);
    }

    const request = run?.wakeupRequestId
      ? await db
        .select()
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.orgId, validated.orgId),
          eq(agentWakeupRequests.id, run.wakeupRequestId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null)
      : await findRequest(validated.orgId, validated.idempotencyKey);
    if (!request) throw conflict("Delegation admission did not persist a traceable wakeup request");
    assertRequestMatches(request, validated);

    const admittedRun = await loadRun(request) ?? run;
    return {
      run: admittedRun,
      runId: request.runId ?? admittedRun?.id ?? null,
      wakeupRequestId: request.id,
      sourceRunId: input.sourceRunId,
      sourceAgentId: input.sourceAgentId,
      targetAgentId: validated.targetAgentId,
      scene: DELEGATION_RUN_SCENE,
      admissionStatus: admissionStatusForRequest(request.status),
      replayed: false,
    };
  }

  return { create };
}
