import { approvals, chatConversations, issueLabels, issues, labels, type Db } from "@rudderhq/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@rudderhq/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Router, type Request } from "express";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { redactApprovalPayload } from "../redaction.js";
import {
  accessService,
  approvalService,
  chatService,
  goalService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
  secretService,
} from "../services/index.js";
import type {
  OrganizationMutationIntentCoordinator,
  OrganizationMutationIntentRow,
} from "../services/organization-mutation-intents.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  wakeIssueAssigneeAfterChatConversion,
  type ChatConvertedIssue,
} from "./chat-issue-assignment-wakeup.js";

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

function organizationChatOperationProposal(approval: {
  type: string;
  orgId: string;
  payload: Record<string, unknown>;
}) {
  if (approval.type !== "chat_operation") return null;
  const nested = approval.payload.operationProposal;
  const proposal = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : approval.payload;
  if (proposal.targetType !== "organization" || proposal.targetId !== approval.orgId) return null;
  const conversationId = typeof approval.payload.chatConversationId === "string"
    ? approval.payload.chatConversationId.trim()
    : "";
  const proposalMessageId = typeof approval.payload.chatMessageId === "string"
    ? approval.payload.chatMessageId.trim()
    : null;
  const patch = proposal.patch;
  if (
    !conversationId
    || !patch
    || typeof patch !== "object"
    || Array.isArray(patch)
  ) return null;
  return {
    conversationId,
    proposalMessageId: proposalMessageId || null,
    patch: patch as Record<string, unknown>,
    summary: typeof proposal.summary === "string" ? proposal.summary : "organization settings",
  };
}

export type ApprovalRoutesOptions = {
  organizationMutationCoordinator?: OrganizationMutationIntentCoordinator;
};

function durableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function durableStringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function approvalSnapshotFromIntent(intent: OrganizationMutationIntentRow): typeof approvals.$inferSelect {
  const targets = intent.downstreamTargets;
  const conversationId = durableString(targets.conversationId) ?? intent.conversationId;
  const proposalMessageId = durableString(targets.proposalMessageId) ?? intent.proposalMessageId;
  const approvalId = durableString(targets.approvalId) ?? intent.approvalId ?? intent.sourceId;
  const summary = durableString(targets.summary) ?? "organization settings";
  const requestedByAgentId = durableString(targets.requestedByAgentId);
  return {
    id: approvalId,
    orgId: intent.orgId,
    type: "chat_operation",
    requestedByAgentId,
    requestedByUserId: null,
    status: "approved",
    payload: {
      chatConversationId: conversationId,
      ...(proposalMessageId ? { chatMessageId: proposalMessageId } : {}),
      operationProposal: {
        targetType: "organization",
        targetId: intent.orgId,
        summary,
        patch: intent.patch,
      },
    },
    decisionNote: intent.decisionNote,
    decidedByUserId: intent.decidedByUserId,
    decidedAt: null,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}

export function approvalRoutes(db: Db, options: ApprovalRoutesOptions = {}) {
  const router = Router();
  const svc = approvalService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const goalsSvc = goalService(db);
  const chatsSvc = chatService(db, undefined, {
    organizationMutationCoordinator: options.organizationMutationCoordinator,
  });
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

  async function applyApprovedChatEffects(
    approval: Awaited<ReturnType<typeof svc.getById>>,
    actorUserId: string,
    intentId?: string,
    intent?: OrganizationMutationIntentRow,
  ) {
    const durableApproval = approval ?? (intent ? approvalSnapshotFromIntent(intent) : null);
    if (!durableApproval) return;
    const key = (suffix: string) => intentId
      ? `organization-mutation-intent:${intentId}:${suffix}`
      : undefined;
    let chatAppliedIssue: Awaited<ReturnType<typeof chatsSvc.applyApprovedApproval>> = null;
    let conversationPresent = true;
    if (intentId) {
      const [conversation] = await db
        .select({ id: chatConversations.id })
        .from(chatConversations)
        .where(and(
          eq(chatConversations.id, durableApproval.payload.chatConversationId as string),
          eq(chatConversations.orgId, durableApproval.orgId),
        ));
      conversationPresent = Boolean(conversation);
    }
    if (conversationPresent) {
      chatAppliedIssue = await chatsSvc.applyApprovedApproval(
        durableApproval,
        actorUserId,
        intentId
          ? {
              organizationMutationAlreadyApplied: true,
              intentId,
              organizationMutationDownstreamClaimToken: intent?.downstreamClaimToken,
            }
          : undefined,
      );
    } else if (intentId) {
      // The accepted intent owns the organization change after claim. A
      // deleted/expired Side Chat may no longer accept a system message, but
      // its organization activity must remain recoverable and idempotent.
      const proposal = durableApproval.payload.operationProposal;
      const proposalPatch = proposal && typeof proposal === "object" && !Array.isArray(proposal)
        ? (proposal as Record<string, unknown>).patch
        : null;
      await logActivity(db, {
        orgId: durableApproval.orgId,
        actorType: "user",
        actorId: actorUserId,
        action: "organization.updated",
        entityType: "organization",
        entityId: durableApproval.orgId,
        details: {
          source: "chat_approval_recovery",
          sourceMessageId: durableApproval.payload.chatMessageId ?? null,
          decisionNote: durableApproval.decisionNote,
          ...(proposalPatch && typeof proposalPatch === "object" && !Array.isArray(proposalPatch)
            ? proposalPatch
            : {}),
        },
        idempotencyKey: key("activity"),
      });
    }

    if (durableApproval.type === "chat_issue_creation" && isChatConvertedIssue(chatAppliedIssue)) {
      await wakeIssueAssigneeAfterChatConversion({
        db,
        heartbeat,
        issue: chatAppliedIssue,
        reason: "issue_assigned",
        mutation: "chat_approval_approved",
        contextSource: "chat.approval_approved",
        requestedByActorType: "user",
        requestedByActorId: actorUserId,
        activityAction: "chat.issue_assignee_wakeup_queued",
        activityEntityType: "chat",
        activityEntityId:
          typeof durableApproval.payload?.chatConversationId === "string"
            ? durableApproval.payload.chatConversationId
            : durableApproval.id,
        activityDetails: {
          approvalId: durableApproval.id,
          issueIdentifier: chatAppliedIssue.identifier ?? null,
        },
        logActivityFn: logActivity,
      });
    }
    const snapshotIssueIds = intent?.downstreamTargets
      ? durableStringList(intent.downstreamTargets.linkedIssueIds)
      : [];
    const linkedIssues = intent
      ? (await Promise.all(snapshotIssueIds.map((issueId) => issuesSvc.getById(issueId))))
        .filter((issue): issue is NonNullable<typeof issue> => Boolean(issue && issue.orgId === durableApproval.orgId))
      : await issueApprovalsSvc.listIssuesForApproval(durableApproval.id);
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
        orgId: durableApproval.orgId,
        actorType: "user",
        actorId: actorUserId,
        action: "issue.updated",
        entityType: "issue",
        entityId: updatedIssue.id,
        details: {
          status: updatedIssue.status,
          source: "approval.approved",
          approvalId: durableApproval.id,
          identifier: updatedIssue.identifier,
          _previous: { status: "blocked" },
        },
        idempotencyKey: key(`linked-issue:${updatedIssue.id}:activity`),
      });

      if (updatedIssue.assigneeAgentId && updatedIssue.assigneeAgentId !== durableApproval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(updatedIssue.assigneeAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: durableApproval.id,
              approvalStatus: durableApproval.status,
              issueId: updatedIssue.id,
              mutation: "approval_approved",
            },
            requestedByActorType: "user",
            requestedByActorId: actorUserId,
            idempotencyKey: key(`linked-issue:${updatedIssue.id}:wakeup`),
            contextSnapshot: {
              source: "approval.approved",
              approvalId: durableApproval.id,
              approvalStatus: durableApproval.status,
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
            orgId: durableApproval.orgId,
            actorType: "user",
            actorId: actorUserId,
            action: "approval.linked_issue_assignee_wakeup_queued",
            entityType: "approval",
            entityId: durableApproval.id,
            details: {
              issueId: updatedIssue.id,
              assigneeAgentId: updatedIssue.assigneeAgentId,
              wakeRunId: wakeRun?.id ?? null,
            },
            idempotencyKey: key(`linked-issue:${updatedIssue.id}:wakeup-activity`),
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: durableApproval.id,
              issueId: updatedIssue.id,
              assigneeAgentId: updatedIssue.assigneeAgentId,
            },
            "failed to queue linked issue assignee wakeup after approval",
          );
          await logActivity(db, {
            orgId: durableApproval.orgId,
            actorType: "user",
            actorId: actorUserId,
            action: "approval.linked_issue_assignee_wakeup_failed",
            entityType: "approval",
            entityId: durableApproval.id,
            details: {
              issueId: updatedIssue.id,
              assigneeAgentId: updatedIssue.assigneeAgentId,
              error: err instanceof Error ? err.message : String(err),
            },
            idempotencyKey: key(`linked-issue:${updatedIssue.id}:wakeup-failed`),
          });
        }
      }
    }

    await logActivity(db, {
      orgId: durableApproval.orgId,
      actorType: "user",
      actorId: actorUserId,
      action: "approval.approved",
      entityType: "approval",
      entityId: durableApproval.id,
      details: {
        type: durableApproval.type,
        requestedByAgentId: durableApproval.requestedByAgentId,
        linkedIssueIds,
        reactivatedLinkedIssueIds,
      },
      idempotencyKey: key("approval-activity"),
    });

    if (durableApproval.requestedByAgentId) {
      try {
        const wakeRun = await heartbeat.wakeup(durableApproval.requestedByAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "approval_approved",
          payload: {
            approvalId: durableApproval.id,
            approvalStatus: durableApproval.status,
            issueId: primaryIssueId,
            issueIds: linkedIssueIds,
          },
          requestedByActorType: "user",
          requestedByActorId: actorUserId,
          idempotencyKey: key("requester-wakeup"),
          contextSnapshot: {
            source: "approval.approved",
            approvalId: durableApproval.id,
            approvalStatus: durableApproval.status,
            issueId: primaryIssueId,
            issueIds: linkedIssueIds,
            taskId: primaryIssueId,
            wakeReason: "approval_approved",
          },
        });

        await logActivity(db, {
          orgId: durableApproval.orgId,
          actorType: "user",
          actorId: actorUserId,
          action: "approval.requester_wakeup_queued",
          entityType: "approval",
          entityId: durableApproval.id,
          details: {
            requesterAgentId: durableApproval.requestedByAgentId,
            wakeRunId: wakeRun?.id ?? null,
            linkedIssueIds,
          },
          idempotencyKey: key("requester-wakeup-activity"),
        });
      } catch (err) {
        logger.warn(
          {
            err,
            approvalId: durableApproval.id,
            requestedByAgentId: durableApproval.requestedByAgentId,
          },
          "failed to queue requester wakeup after approval",
        );
        await logActivity(db, {
          orgId: durableApproval.orgId,
          actorType: "user",
          actorId: actorUserId,
          action: "approval.requester_wakeup_failed",
          entityType: "approval",
          entityId: durableApproval.id,
          details: {
            requesterAgentId: durableApproval.requestedByAgentId,
            linkedIssueIds,
            error: err instanceof Error ? err.message : String(err),
          },
          idempotencyKey: key("requester-wakeup-failed"),
        });
      }
    }
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
    if (pendingApproval) assertCompanyAccess(req, pendingApproval.orgId);
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
    if (pendingApproval?.type === "goal_change") {
      const proposalId = typeof pendingApproval.payload?.proposalId === "string"
        ? pendingApproval.payload.proposalId
        : null;
      if (!proposalId) throw unprocessable("Goal change approval is missing its proposal reference");
      const actorId = req.actor.userId ?? "board";
      const { proposal, dispatch } = await goalsSvc.decideChangeProposal(proposalId, {
        decision: "approve",
        note: req.body.decisionNote,
      }, actorId);
      await heartbeat.wakeup(dispatch.ownerAgentId, {
        existingWakeupRequestId: dispatch.wakeupRequestId,
        source: dispatch.source,
        triggerDetail: dispatch.triggerDetail,
        reason: dispatch.reason,
        payload: dispatch.payload,
        contextSnapshot: dispatch.contextSnapshot,
        requestedByActorType: dispatch.requestedByActorType,
        requestedByActorId: dispatch.requestedByActorId,
        idempotencyKey: dispatch.idempotencyKey,
      });
      const approval = await svc.getById(id);
      if (!approval) throw unprocessable("Goal change approval disappeared after its decision");
      await logActivity(db, {
        orgId: approval.orgId,
        actorType: "user",
        actorId,
        action: "goal.change_approved",
        entityType: "goal",
        entityId: proposal.goalId,
        details: { approvalId: id, proposalId, status: proposal.status, appliedRevision: proposal.appliedRevision },
        idempotencyKey: `goal-change-decision:${proposalId}:approve`,
      });
      await logActivity(db, {
        orgId: approval.orgId,
        actorType: "user",
        actorId,
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, requestedByAgentId: approval.requestedByAgentId },
        idempotencyKey: `goal-change-approval:${proposalId}:approve`,
      });
      res.json(redactApprovalPayload(approval));
      return;
    }
    if (approvalForValidation?.type === "chat_issue_creation") {
      await assertCanApproveChatIssueConversion(req, approvalForValidation);
      await assertChatIssueProposalLabelsIfNeeded(approvalForValidation);
    }
    const organizationProposal = pendingApproval
      ? organizationChatOperationProposal(pendingApproval)
      : null;
    if (
      options.organizationMutationCoordinator
      && pendingApproval
      && (
        pendingApproval.status === "pending"
        || pendingApproval.status === "revision_requested"
        || pendingApproval.status === "approved"
      )
      && organizationProposal
    ) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(pendingApproval.id);
      const source = {
        kind: "chat_approval" as const,
        sourceId: pendingApproval.id,
        approvalId: pendingApproval.id,
        conversationId: organizationProposal.conversationId,
        proposalMessageId: organizationProposal.proposalMessageId,
      };
      let approvedForEffects: typeof pendingApproval | null = null;
      const result = await options.organizationMutationCoordinator.run({
        orgId: pendingApproval.orgId,
        source,
        actorUserId: req.actor.userId ?? null,
        // Rust's Board actor principal is the closed value "board"; the
        // immutable human identity is carried separately in actorUserId.
        actorPrincipal: "board",
        decidedByUserId: req.body.decidedByUserId ?? "board",
        decisionNote: req.body.decisionNote ?? null,
        generation: 1n,
        patch: organizationProposal.patch,
        rustIdempotencyKey: `chat-approval:${pendingApproval.id}:organization-settings`,
        downstreamTargets: {
          approvalId: pendingApproval.id,
          conversationId: organizationProposal.conversationId,
          proposalMessageId: organizationProposal.proposalMessageId,
          summary: organizationProposal.summary,
          requestedByAgentId: pendingApproval.requestedByAgentId,
          linkedIssueIds: linkedIssues.map((issue) => issue.id),
        },
      }, {
        beforeRust: async (context) => {
          const decision = await svc.approve(
            id,
            req.body.decidedByUserId ?? "board",
            req.body.decisionNote,
            payloadOverride,
            { organizationMutationClaimToken: context.claimToken },
          );
          if (decision.approval.status !== "approved") {
            throw unprocessable("Organization chat approval did not reach approved state");
          }
          approvedForEffects = decision.approval;
        },
        applyEffects: async ({ intent, runStep }) => {
          await runStep("approval_effects", `approval:${pendingApproval.id}`, async () => {
            const approved = approvedForEffects ?? await svc.getById(pendingApproval.id);
            await applyApprovedChatEffects(
              approved,
              intent.actorUserId ?? req.actor.userId ?? "board",
              intent.id,
              intent,
            );
          });
        },
      });
      if (result.status === "in_progress") {
        throw conflict("Organization chat approval is already being applied");
      }
      const approval = await svc.getById(id);
      if (!approval) throw unprocessable("Organization chat approval disappeared after its decision");
      res.json(redactApprovalPayload(approval));
      return;
    }
    const { approval, applied } = await svc.approve(
      id,
      req.body.decidedByUserId ?? "board",
      req.body.decisionNote,
      payloadOverride,
    );

    if (applied) {
      let chatAppliedIssue: Awaited<ReturnType<typeof chatsSvc.applyApprovedApproval>> = null;
      chatAppliedIssue = await chatsSvc.applyApprovedApproval(approval, req.actor.userId ?? "board");

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
    const pendingApproval = await svc.getById(id);
    if (pendingApproval) assertCompanyAccess(req, pendingApproval.orgId);
    if (pendingApproval?.type === "goal_change") {
      const proposalId = typeof pendingApproval.payload?.proposalId === "string"
        ? pendingApproval.payload.proposalId
        : null;
      if (!proposalId) throw unprocessable("Goal change approval is missing its proposal reference");
      const actorId = req.actor.userId ?? "board";
      const { proposal, dispatch } = await goalsSvc.decideChangeProposal(proposalId, {
        decision: "reject",
        note: req.body.decisionNote,
      }, actorId);
      await heartbeat.wakeup(dispatch.ownerAgentId, {
        existingWakeupRequestId: dispatch.wakeupRequestId,
        source: dispatch.source,
        triggerDetail: dispatch.triggerDetail,
        reason: dispatch.reason,
        payload: dispatch.payload,
        contextSnapshot: dispatch.contextSnapshot,
        requestedByActorType: dispatch.requestedByActorType,
        requestedByActorId: dispatch.requestedByActorId,
        idempotencyKey: dispatch.idempotencyKey,
      });
      const approval = await svc.getById(id);
      if (!approval) throw unprocessable("Goal change approval disappeared after its decision");
      await logActivity(db, {
        orgId: approval.orgId,
        actorType: "user",
        actorId,
        action: "goal.change_rejected",
        entityType: "goal",
        entityId: proposal.goalId,
        details: { approvalId: id, proposalId, status: proposal.status },
        idempotencyKey: `goal-change-decision:${proposalId}:reject`,
      });
      await logActivity(db, {
        orgId: approval.orgId,
        actorType: "user",
        actorId,
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, requestedByAgentId: approval.requestedByAgentId },
        idempotencyKey: `goal-change-approval:${proposalId}:reject`,
      });
      res.json(redactApprovalPayload(approval));
      return;
    }
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
      const existing = await svc.getById(id);
      if (existing?.type === "goal_change") {
        throw unprocessable("Reject this Goal update with feedback so the Owner can submit a new proposal");
      }
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
    if (existing.type === "goal_change") {
      throw unprocessable("A rejected Goal update requires a new proposal and approval");
    }

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
