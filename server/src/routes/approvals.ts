import { Router } from "express";
import type { LangfuseObservation } from "@langfuse/tracing";
import type { Db } from "@rudderhq/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
  type ExecutionObservabilityContext,
} from "@rudderhq/shared";
import { validate } from "../middleware/validate.js";
import { observeExecutionEvent, withExecutionObservation } from "../langfuse.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  chatService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

function buildChatApprovalObservabilityContext(
  approval: {
    id: string;
    orgId: string;
    type: string;
    payload: Record<string, unknown>;
  },
  input: {
    status?: string | null;
    metadata?: Record<string, unknown> | null;
  } = {},
): ExecutionObservabilityContext {
  const payload = approval.payload ?? {};
  const conversationId = typeof payload.chatConversationId === "string" ? payload.chatConversationId : null;
  const issueId =
    typeof payload.issueId === "string"
      ? payload.issueId
      : typeof payload.primaryIssueId === "string"
        ? payload.primaryIssueId
        : null;

  return {
    surface: "chat_action",
    rootExecutionId: approval.id,
    orgId: approval.orgId,
    issueId,
    sessionKey: conversationId,
    trigger: "approval_apply",
    status: input.status ?? null,
    metadata: {
      approvalId: approval.id,
      approvalType: approval.type,
      conversationId,
      ...(input.metadata ?? {}),
    },
  };
}

async function withChatApprovalObservation<T>(
  context: ExecutionObservabilityContext,
  input: {
    name: string;
    asType?: "span" | "agent" | "generation" | "tool" | "chain" | "retriever" | "evaluator" | "guardrail" | "embedding";
    input?: unknown;
    metadata?: Record<string, unknown>;
  },
  fn: (observation: LangfuseObservation | null) => Promise<T>,
) {
  let executionError: unknown = null;
  try {
    return await withExecutionObservation(context, input, async (observation) => {
      try {
        return await fn(observation);
      } catch (error) {
        executionError = error;
        throw error;
      }
    });
  } catch (error) {
    if (executionError && error === executionError) {
      throw error;
    }
    logger.warn(
      {
        rootExecutionId: context.rootExecutionId,
        trigger: context.trigger,
        err: error instanceof Error ? error.message : String(error),
      },
      "Failed to emit Langfuse chat approval observation",
    );
    return fn(null);
  }
}

async function emitChatApprovalObservationEvent(
  context: ExecutionObservabilityContext,
  input: Parameters<typeof observeExecutionEvent>[1],
) {
  try {
    await observeExecutionEvent(context, input);
  } catch (error) {
    logger.warn(
      {
        rootExecutionId: context.rootExecutionId,
        eventName: input.name,
        err: error instanceof Error ? error.message : String(error),
      },
      "Failed to emit Langfuse chat approval event",
    );
  }
}

export function approvalRoutes(db: Db) {
  const router = Router();
  const svc = approvalService(db);
  const heartbeat = heartbeatService(db);
  const chatsSvc = chatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.RUDDER_SECRETS_STRICT_MODE === "true";

  router.get("/orgs/:orgId/approvals", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const status = req.query.status as string | undefined;
    const result = await svc.list(orgId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.orgId);
    res.json(redactApprovalPayload(approval));
  });

  router.post("/orgs/:orgId/approvals", validate(createApprovalSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            orgId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await svc.create(orgId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.orgId);
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const { approval, applied } = await svc.approve(
      id,
      req.body.decidedByUserId ?? "board",
      req.body.decisionNote,
    );

    if (applied) {
      if (approval.type === "chat_issue_creation" || approval.type === "chat_operation") {
        const chatObservation = buildChatApprovalObservabilityContext(approval, {
          status: approval.status,
          metadata: {
            decisionNote: req.body.decisionNote ?? null,
          },
        });
        await withChatApprovalObservation(
          chatObservation,
          {
            name: "chat:approval_apply",
            asType: "tool",
            input: {
              approvalId: approval.id,
              approvalType: approval.type,
            },
          },
          async () => {
            await chatsSvc.applyApprovedApproval(approval, req.actor.userId ?? "board");
            await emitChatApprovalObservationEvent(chatObservation, {
              name: "chat.approval.applied",
              metadata: {
                approvalType: approval.type,
              },
            });
          },
        );
      } else {
        await chatsSvc.applyApprovedApproval(approval, req.actor.userId ?? "board");
      }
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      await logActivity(db, {
        orgId: approval.orgId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            orgId: approval.orgId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            orgId: approval.orgId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const { approval, applied } = await svc.reject(
      id,
      req.body.decidedByUserId ?? "board",
      req.body.decisionNote,
    );

    if (applied) {
      await logActivity(db, {
        orgId: approval.orgId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const approval = await svc.requestRevision(
        id,
        req.body.decidedByUserId ?? "board",
        req.body.decisionNote,
      );

      await logActivity(db, {
        orgId: approval.orgId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.orgId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: approval.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.orgId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.orgId);
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      orgId: approval.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  return router;
}
