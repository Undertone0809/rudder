import { Router, type Request } from "express";
import type { LangfuseObservation } from "@langfuse/tracing";
import { and, eq, inArray, sql } from "drizzle-orm";
import { issueLabels, issues, labels, type Db } from "@rudderhq/db";
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
  accessService,
  approvalService,
  chatService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import { forbidden, unprocessable } from "../errors.js";
import {
  wakeIssueAssigneeAfterChatConversion,
  type ChatConvertedIssue,
} from "./chat-issue-assignment-wakeup.js";

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

function isChatConvertedIssue(value: unknown): value is ChatConvertedIssue & { identifier?: string | null } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { orgId?: unknown }).orgId === "string" &&
    typeof (value as { title?: unknown }).title === "string" &&
    typeof (value as { status?: unknown }).status === "string" &&
    (
      (value as { assigneeAgentId?: unknown }).assigneeAgentId === null ||
      typeof (value as { assigneeAgentId?: unknown }).assigneeAgentId === "string"
    )
  );
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
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const chatsSvc = chatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const issuesSvc = issueService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.RUDDER_SECRETS_STRICT_MODE === "true";

  function proposalAssignsOrReviewsIssue(proposal: Record<string, unknown> | null | undefined) {
    if (!proposal) return false;
    return Boolean(
      (typeof proposal.assigneeAgentId === "string" && proposal.assigneeAgentId.trim().length > 0)
      || (typeof proposal.assigneeUserId === "string" && proposal.assigneeUserId.trim().length > 0)
      || (typeof proposal.reviewerAgentId === "string" && proposal.reviewerAgentId.trim().length > 0)
      || (typeof proposal.reviewerUserId === "string" && proposal.reviewerUserId.trim().length > 0),
    );
  }

  function assertChatIssueProposalOwnerDecision(proposal: Record<string, unknown> | null | undefined) {
    const hasAssignee = Boolean(
      (typeof proposal?.assigneeAgentId === "string" && proposal.assigneeAgentId.trim().length > 0)
      || (typeof proposal?.assigneeUserId === "string" && proposal.assigneeUserId.trim().length > 0),
    );
    const hasUnassignedReason =
      typeof proposal?.assigneeUnassignedReason === "string"
      && proposal.assigneeUnassignedReason.trim().length > 0;
    if (hasAssignee && hasUnassignedReason) {
      throw unprocessable("Issue proposals with an owner must not also include assigneeUnassignedReason");
    }
    if (!hasAssignee && !hasUnassignedReason) {
      throw unprocessable("Issue proposals without an owner must include assigneeUnassignedReason");
    }
  }

  async function assertCanApproveChatIssueConversion(req: Request, approval: { orgId: string; payload: Record<string, unknown> }) {
    const proposedIssue =
      approval.payload?.proposedIssue
      && typeof approval.payload.proposedIssue === "object"
      && !Array.isArray(approval.payload.proposedIssue)
        ? (approval.payload.proposedIssue as Record<string, unknown>)
        : null;
    assertChatIssueProposalOwnerDecision(proposedIssue);
    if (!proposalAssignsOrReviewsIssue(proposedIssue)) return;
    assertCompanyAccess(req, approval.orgId);
    if (req.actor.type === "board" && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) return;
    const allowed = await access.canUser(approval.orgId, req.actor.userId, "tasks:assign");
    if (!allowed) throw forbidden("Missing permission: tasks:assign");
  }

  async function assertChatIssueProposalLabelsIfNeeded(approval: { orgId: string; payload: Record<string, unknown> }) {
    const proposedByAgentId = typeof approval.payload.proposedByAgentId === "string"
      ? approval.payload.proposedByAgentId.trim()
      : "";
    if (!proposedByAgentId) return;

    const proposedIssue =
      approval.payload?.proposedIssue
      && typeof approval.payload.proposedIssue === "object"
      && !Array.isArray(approval.payload.proposedIssue)
        ? (approval.payload.proposedIssue as Record<string, unknown>)
        : null;
    const labelIds = Array.isArray(proposedIssue?.labelIds)
      ? proposedIssue.labelIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (labelIds.length > 0) {
      const uniqueLabelIds = [...new Set(labelIds)];
      const existingLabels = await db
        .select({ id: labels.id })
        .from(labels)
        .where(and(eq(labels.orgId, approval.orgId), inArray(labels.id, uniqueLabelIds)));
      if (existingLabels.length !== uniqueLabelIds.length) {
        throw unprocessable("One or more labels are invalid for this organization");
      }
      return;
    }

    const parentId = typeof proposedIssue?.parentId === "string" ? proposedIssue.parentId.trim() : "";
    if (parentId) {
      const parentLabelRows = await db
        .select({ labelId: issueLabels.labelId })
        .from(issueLabels)
        .innerJoin(issues, eq(issueLabels.issueId, issues.id))
        .where(and(eq(issues.id, parentId), eq(issues.orgId, approval.orgId), eq(issueLabels.orgId, approval.orgId)))
        .limit(1);
      if (parentLabelRows.length > 0) return;
    }

    const [labelCountRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(labels)
      .where(eq(labels.orgId, approval.orgId));
    const labelCount = Number(labelCountRow?.count ?? 0);
    if (labelCount < 5) return;

    throw unprocessable(
      `当前组织有 ${labelCount} 个 labels，agent 创建 issue 需要选择至少一个 label`,
      {
        code: "agent_issue_label_required",
        labelCount,
      },
    );
  }

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
      const links = await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
      for (const link of links) {
        await logActivity(db, {
          orgId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.approval_linked",
          entityType: "issue",
          entityId: link.issueId,
          details: {
            approvalId: approval.id,
            linkCreatedAt: link.createdAt.toISOString(),
          },
        });
      }
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
    const pendingApproval = await svc.getById(id);
    const payloadOverride =
      pendingApproval?.type === "chat_issue_creation"
      && req.body.payload
      && typeof req.body.payload === "object"
      && !Array.isArray(req.body.payload)
        ? (req.body.payload as Record<string, unknown>)
        : undefined;
    const approvalForValidation = pendingApproval && payloadOverride
      ? { ...pendingApproval, payload: payloadOverride }
      : pendingApproval;
    if (approvalForValidation?.type === "chat_issue_creation") {
      await assertCanApproveChatIssueConversion(req, approvalForValidation);
      await assertChatIssueProposalLabelsIfNeeded(approvalForValidation);
    }
    const { approval, applied } = await svc.approve(
      id,
      req.body.decidedByUserId ?? "board",
      req.body.decisionNote,
      payloadOverride,
    );

    if (applied) {
      let chatAppliedIssue: Awaited<ReturnType<typeof chatsSvc.applyApprovedApproval>> = null;
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
            chatAppliedIssue = await chatsSvc.applyApprovedApproval(approval, req.actor.userId ?? "board");
            await emitChatApprovalObservationEvent(chatObservation, {
              name: "chat.approval.applied",
              metadata: {
                approvalType: approval.type,
              },
            });
          },
        );
      } else {
        chatAppliedIssue = await chatsSvc.applyApprovedApproval(approval, req.actor.userId ?? "board");
      }

      if (approval.type === "chat_issue_creation" && isChatConvertedIssue(chatAppliedIssue)) {
        await wakeIssueAssigneeAfterChatConversion({
          db,
          heartbeat,
          issue: chatAppliedIssue,
          reason: "issue_assigned",
          mutation: "chat_approval_approved",
          contextSource: "chat.approval_approved",
          requestedByActorType: "user",
          requestedByActorId: req.actor.userId ?? "board",
          activityAction: "chat.issue_assignee_wakeup_queued",
          activityEntityType: "chat",
          activityEntityId:
            typeof approval.payload?.chatConversationId === "string" ? approval.payload.chatConversationId : approval.id,
          activityDetails: {
            approvalId: approval.id,
            issueIdentifier: chatAppliedIssue.identifier ?? null,
          },
          logActivityFn: logActivity,
        });
      }
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;
      const reactivatedLinkedIssueIds: string[] = [];

      for (const linkedIssue of linkedIssues) {
        if (linkedIssue.status !== "blocked") continue;

        const nextStatus = linkedIssue.assigneeAgentId || linkedIssue.assigneeUserId ? "in_progress" : "todo";
        const updatedIssue = await issuesSvc.update(linkedIssue.id, { status: nextStatus });
        if (!updatedIssue) continue;
        reactivatedLinkedIssueIds.push(updatedIssue.id);

        await logActivity(db, {
          orgId: approval.orgId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "issue.updated",
          entityType: "issue",
          entityId: updatedIssue.id,
          details: {
            status: updatedIssue.status,
            source: "approval.approved",
            approvalId: approval.id,
            identifier: updatedIssue.identifier,
            _previous: { status: "blocked" },
          },
        });

        if (updatedIssue.assigneeAgentId && updatedIssue.assigneeAgentId !== approval.requestedByAgentId) {
          try {
            const wakeRun = await heartbeat.wakeup(updatedIssue.assigneeAgentId, {
              source: "assignment",
              triggerDetail: "system",
              reason: "approval_approved",
              payload: {
                approvalId: approval.id,
                approvalStatus: approval.status,
                issueId: updatedIssue.id,
                mutation: "approval_approved",
              },
              requestedByActorType: "user",
              requestedByActorId: req.actor.userId ?? "board",
              contextSnapshot: {
                source: "approval.approved",
                approvalId: approval.id,
                approvalStatus: approval.status,
                issueId: updatedIssue.id,
                taskId: updatedIssue.id,
                wakeSource: "assignment",
                wakeReason: "approval_approved",
                issue: {
                  id: updatedIssue.id,
                  title: updatedIssue.title,
                  description: updatedIssue.description,
                  status: updatedIssue.status,
                  priority: updatedIssue.priority,
                },
              },
            });

            await logActivity(db, {
              orgId: approval.orgId,
              actorType: "user",
              actorId: req.actor.userId ?? "board",
              action: "approval.linked_issue_assignee_wakeup_queued",
              entityType: "approval",
              entityId: approval.id,
              details: {
                issueId: updatedIssue.id,
                assigneeAgentId: updatedIssue.assigneeAgentId,
                wakeRunId: wakeRun?.id ?? null,
              },
            });
          } catch (err) {
            logger.warn(
              {
                err,
                approvalId: approval.id,
                issueId: updatedIssue.id,
                assigneeAgentId: updatedIssue.assigneeAgentId,
              },
              "failed to queue linked issue assignee wakeup after approval",
            );
            await logActivity(db, {
              orgId: approval.orgId,
              actorType: "user",
              actorId: req.actor.userId ?? "board",
              action: "approval.linked_issue_assignee_wakeup_failed",
              entityType: "approval",
              entityId: approval.id,
              details: {
                issueId: updatedIssue.id,
                assigneeAgentId: updatedIssue.assigneeAgentId,
                error: err instanceof Error ? err.message : String(err),
              },
            });
          }
        }
      }

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
          reactivatedLinkedIssueIds,
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
