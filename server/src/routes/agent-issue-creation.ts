import type { Db } from "@rudderhq/db";
import { createAgentIssueCreationRequestSchema } from "@rudderhq/shared";
import { Router, type Request } from "express";
import { forbidden, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import type { LogActivityInput } from "../services/activity-log.js";
import type { agentIssueCreationService } from "../services/agent-issue-creation.js";
import type { WakeupOptions } from "../services/runtime-kernel/heartbeat.core.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

type AgentIssueCreationService = ReturnType<typeof agentIssueCreationService>;

type AgentIssueCreationHeartbeat = {
  wakeup: (agentId: string, options: WakeupOptions) => Promise<{
    id: string;
    status: string;
    wakeupRequestId: string | null;
  } | null>;
  startNextQueuedRunForAgent: (agentId: string) => Promise<unknown>;
};

type AgentIssueCreationRouteContext = {
  router: Router;
  service: AgentIssueCreationService;
  heartbeat: AgentIssueCreationHeartbeat;
  assertCanAssignTasks: (req: Request, orgId: string) => Promise<void>;
  logActivity: (db: Db, input: LogActivityInput) => Promise<unknown>;
  db: Db;
};

const REQUEST_WAKEUP_REASON = "agent_issue_creation_requested";

function requestWakeupIdempotencyKey(requestId: string, wakeupAttemptId: string) {
  return `agent-issue-creation:${requestId}:${wakeupAttemptId}`;
}

function isDeferredWakeup(status: string | null | undefined) {
  return typeof status === "string" && status.startsWith("deferred_");
}

function isRecoverableWakeup(status: string | null | undefined) {
  return status === "queued" || status === "running" || isDeferredWakeup(status);
}

export function registerAgentIssueCreationRoutes(ctx: AgentIssueCreationRouteContext) {
  const { router, service, heartbeat, assertCanAssignTasks, logActivity, db } = ctx;

  type AgentIssueCreationRequestRow = NonNullable<Awaited<ReturnType<AgentIssueCreationService["getById"]>>>;

  async function admitRequest(
    req: Request,
    orgId: string,
    request: AgentIssueCreationRequestRow,
    activityAction: "agent.issue_creation_requested" | "agent.issue_creation_retry_requested",
  ) {
    const actor = getActorInfo(req);
    const wakeupKey = requestWakeupIdempotencyKey(request.id, request.wakeupAttemptId);
    let wakeupCompleted = false;
    let linkedRun: Awaited<ReturnType<AgentIssueCreationHeartbeat["wakeup"]>> = null;
    let linkedWakeup: Awaited<ReturnType<AgentIssueCreationService["getWakeupByIdempotencyKey"]>> | null = null;
    try {
      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: null,
        runId: null,
        action: activityAction,
        entityType: "agent_issue_creation_request",
        entityId: request.id,
        details: {
          requestId: request.id,
          requestedByUserId: request.requestedByUserId,
          agentId: request.agentId,
          projectId: request.projectId,
          goalId: request.goalId,
          parentId: request.parentId,
          idempotencyKey: request.idempotencyKey,
        },
        idempotencyKey: `${activityAction}:${request.id}:${request.idempotencyKey}`,
      });

      const run = await heartbeat.wakeup(request.agentId, {
        source: "on_demand",
        triggerDetail: "system",
        reason: REQUEST_WAKEUP_REASON,
        idempotencyKey: wakeupKey,
        // Link the durable request before a fast runtime can reach terminal state.
        // The start below preserves normal immediate execution after linkage.
        startImmediately: false,
        requestedByActorType: "user",
        requestedByActorId: req.actor.userId,
        payload: {
          agentIssueCreationRequestId: request.id,
          instruction: request.instruction,
        },
        contextSnapshot: {
          ...(request.contextSnapshot ?? {}),
          agentIssueCreationRequest: {
            id: request.id,
            requestedByUserId: request.requestedByUserId,
            agentId: request.agentId,
            instruction: request.instruction,
            projectId: request.projectId,
            goalId: request.goalId,
            parentId: request.parentId,
          },
          targetType: "agent_issue_creation",
          targetId: request.id,
          taskKey: `agent-issue-creation:${request.id}`,
          agentIssueCreationRequestId: request.id,
          instruction: request.instruction,
          projectId: request.projectId,
          goalId: request.goalId,
          parentId: request.parentId,
        },
      });
      wakeupCompleted = true;
      linkedRun = run;
      const wakeup = await service.getWakeupByIdempotencyKey(orgId, request.agentId, wakeupKey);
      linkedWakeup = wakeup;
      const nextStatus = run
        ? run.status === "running" ? "running" : "queued"
        : isDeferredWakeup(wakeup?.status)
          ? "deferred"
          : "failed";
      const error = nextStatus === "failed"
        ? wakeup?.error ?? "Agent wakeup was not accepted"
        : null;
      const updated = await service.update(orgId, request.id, {
        status: nextStatus,
        wakeupRequestId: wakeup?.id ?? run?.wakeupRequestId ?? null,
        runId: run?.id ?? wakeup?.runId ?? null,
        ...(run?.status === "running" ? { startedAt: new Date() } : {}),
        ...(nextStatus === "failed" ? { finishedAt: new Date(), error } : { error: null }),
      }, { expectedStatuses: ["queued"] });
      const admitted = updated ?? await service.getById(orgId, request.id);
      if (!admitted) throw new Error("Agent Issue request disappeared after wakeup admission");
      if (nextStatus === "failed") {
        throw unprocessable(error ?? "Agent wakeup was not accepted");
      }
      if (admitted.status === "queued") {
        try {
          await heartbeat.startNextQueuedRunForAgent(request.agentId);
        } catch (startError) {
          logger.warn(
            { err: startError, orgId, requestId: request.id, agentId: request.agentId },
            "failed to start admitted Agent Issue creation run; leaving it queued for recovery",
          );
        }
      }
      return admitted;
    } catch (error) {
      try {
        const recoverable = wakeupCompleted && (
          (linkedRun?.status === "queued" || linkedRun?.status === "running")
          || isRecoverableWakeup(linkedWakeup?.status)
        );
        if (recoverable) {
          await service.update(orgId, request.id, {
            status: linkedRun?.status === "running"
              ? "running"
              : isDeferredWakeup(linkedWakeup?.status)
                ? "deferred"
                : "queued",
            wakeupRequestId: linkedWakeup?.id ?? linkedRun?.wakeupRequestId ?? null,
            runId: linkedRun?.id ?? linkedWakeup?.runId ?? null,
            error: null,
            finishedAt: null,
            ...(linkedRun?.status === "running" ? { startedAt: new Date() } : {}),
          }, { expectedStatuses: ["queued", "deferred", "running"] });
        } else {
          await service.update(orgId, request.id, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            finishedAt: new Date(),
          }, { expectedStatuses: ["queued", "deferred"] });
        }
      } catch (settlementError) {
        // Preserve the original admission error while retaining a signal for
        // an operator if the failure status itself cannot be persisted.
        logger.warn(
          { err: settlementError, orgId, requestId: request.id },
          "failed to settle Agent Issue creation request admission error",
        );
      }
      throw error;
    }
  }

  router.post(
    "/orgs/:orgId/agent-issue-creation-requests",
    validate(createAgentIssueCreationRequestSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCompanyAccess(req, orgId);
      if (req.actor.type !== "board" || !req.actor.userId) {
        throw forbidden("User authentication required");
      }
      await assertCanAssignTasks(req, orgId);

      const result = await service.create({
        ...req.body,
        orgId,
        requestedByUserId: req.actor.userId,
      });
      if (!result.created && !result.needsAdmission) {
        res.status(result.request.status === "succeeded" ? 200 : 202).json(result.request);
        return;
      }

      const request = await admitRequest(req, orgId, result.request, "agent.issue_creation_requested");
      res.status(202).json(request);
    },
  );

  router.get("/orgs/:orgId/agent-issue-creation-requests", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw forbidden("User authentication required");
    }
    res.json(await service.listForRequester(orgId, req.actor.userId));
  });

  router.post("/orgs/:orgId/agent-issue-creation-requests/:id/retry", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw forbidden("User authentication required");
    }
    await assertCanAssignTasks(req, orgId);

    const request = await service.retry(orgId, req.params.id as string, req.actor.userId);
    const admitted = await admitRequest(req, orgId, request, "agent.issue_creation_retry_requested");
    res.status(202).json(admitted);
  });

  router.get("/orgs/:orgId/agent-issue-creation-requests/:id", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw forbidden("User authentication required");
    }
    const request = await service.getById(orgId, req.params.id as string);
    if (!request || request.requestedByUserId !== req.actor.userId) {
      res.status(404).json({ error: "Agent Issue request not found" });
      return;
    }
    res.json(request);
  });
}
