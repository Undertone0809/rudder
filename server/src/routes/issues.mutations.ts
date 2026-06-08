import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@rudderhq/db";
import { buildIssueDocumentsPrompt } from "@rudderhq/agent-runtime-utils/server-utils";
import {
  addIssueCommentSchema,
  createIssueAttachmentMetadataSchema,
  createIssueWorkspaceAttachmentSchema,
  createIssueWorkProductSchema,
  createIssueLabelSchema,
  checkoutIssueSchema,
  createIssueSchema,
  linkIssueApprovalSchema,
  reportIssueCommitSchema,
  issueDocumentKeySchema,
  reorderIssueSchema,
  updateIssueLabelSchema,
  updateIssueWorkProductSchema,
  upsertIssueDocumentSchema,
  updateIssueSchema,
  isUuidLike,
} from "@rudderhq/shared";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  executionWorkspaceService,
  goalService,
  heartbeatService,
  issueApprovalService,
  issueService,
  documentService,
  logActivity,
  projectService,
  automationService,
  workProductService,
} from "../services/index.js";
import { organizationWorkspaceBrowserService } from "../services/organization-workspace-browser.js";
import { logger } from "../middleware/logger.js";
import { forbidden, HttpError, unauthorized, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import { buildIssueReviewWakeupOptions, queueIssueReviewWakeup } from "../services/issue-review-wakeup.js";
import { registerIssueCommentAttachmentRoutes } from "./issues.comments-attachments.js";


type IssueMutationRouteContext = {
  router: Router;
  db: Db;
  storage: StorageService;
  [key: string]: any;
};

type IssueActivityReference = {
  id: string;
  identifier: string | null;
  title: string | null;
};

const ISSUE_UPDATE_ACTIVITY_FIELDS = [
  "assigneeAgentId",
  "assigneeUserId",
  "assigneeAgentRuntimeOverrides",
  "billingCode",
  "description",
  "executionWorkspaceId",
  "executionWorkspacePreference",
  "executionWorkspaceSettings",
  "goalId",
  "hiddenAt",
  "labelIds",
  "parentId",
  "priority",
  "projectId",
  "projectWorkspaceId",
  "requestDepth",
  "reviewerAgentId",
  "reviewerUserId",
  "status",
  "title",
] as const;

function activityValueEquals(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const aTime = a instanceof Date ? a.getTime() : new Date(String(a)).getTime();
    const bTime = b instanceof Date ? b.getTime() : new Date(String(b)).getTime();
    return Number.isFinite(aTime) && Number.isFinite(bTime) && aTime === bTime;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => activityValueEquals(item, b[index]));
  }
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null
  ) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

function buildIssueUpdateActivityDetails(
  existing: Record<string, unknown>,
  updated: Record<string, unknown>,
  metadata: Record<string, unknown>,
) {
  const previous: Record<string, unknown> = {};
  const changed: Record<string, unknown> = {};
  for (const key of ISSUE_UPDATE_ACTIVITY_FIELDS) {
    if (!(key in existing) && !(key in updated)) continue;
    if (!activityValueEquals(existing[key], updated[key])) {
      changed[key] = updated[key];
      previous[key] = existing[key];
    }
  }
  return {
    hasFieldChanges: Object.keys(changed).length > 0,
    details: {
      ...changed,
      ...metadata,
      ...(Object.keys(previous).length > 0 ? { _previous: previous } : {}),
    },
  };
}

function toIssueActivityReference(issue: unknown): IssueActivityReference | null {
  if (typeof issue !== "object" || issue === null) return null;
  const row = issue as Record<string, unknown>;
  if (typeof row.id !== "string") return null;
  return {
    id: row.id,
    identifier: typeof row.identifier === "string" ? row.identifier : null,
    title: typeof row.title === "string" ? row.title : null,
  };
}

async function resolveIssueActivityReference(
  svc: { getById?: (id: string) => Promise<unknown> },
  orgId: string,
  issueId: unknown,
): Promise<IssueActivityReference | null> {
  if (typeof issueId !== "string" || !issueId) return null;
  const issue = await svc.getById?.(issueId);
  if (!issue || typeof issue !== "object" || (issue as Record<string, unknown>).orgId !== orgId) return null;
  return toIssueActivityReference(issue);
}

async function buildIssueUpdateActivityReferences(
  svc: { getById?: (id: string) => Promise<unknown> },
  orgId: string,
  details: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const previous = typeof details._previous === "object" && details._previous !== null
    ? details._previous as Record<string, unknown>
    : {};
  const references: Record<string, unknown> = {};

  if (Object.prototype.hasOwnProperty.call(details, "parentId")) {
    const [parentIssue, previousParentIssue] = await Promise.all([
      resolveIssueActivityReference(svc, orgId, details.parentId),
      resolveIssueActivityReference(svc, orgId, previous.parentId),
    ]);
    if (parentIssue) references.parentIssue = parentIssue;
    if (previousParentIssue) references.previousParentIssue = previousParentIssue;
  }

  return Object.keys(references).length > 0 ? { _references: references } : {};
}

export function registerIssueMutationRoutes(ctx: IssueMutationRouteContext) {
  const {
    router,
    db,
    storage,
    svc,
    access,
    agentsSvc,
    projectsSvc,
    goalsSvc,
    heartbeat,
    issueApprovalsSvc,
    automationsSvc,
    executionWorkspacesSvc,
    assertCanAssignTasks,
    boardUserId,
    assertAgentRunCheckoutOwnership,
    resolveAgentIssueRunId,
    requireAgentRunId,
    issueHasReviewer,
    isReviewerAgentForIssue,
    canAgentCompleteIssue,
    statusForReviewDecision,
    statusAcceptsReviewerDecision,
    reviewerDecisionRequiresHumanHandoff,
    commitSubject,
  } = ctx;
  router.post("/orgs/:orgId/issues", validate(createIssueSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (req.body.assigneeAgentId || req.body.assigneeUserId || req.body.reviewerAgentId || req.body.reviewerUserId) {
      await assertCanAssignTasks(req, orgId);
    }

    const actor = getActorInfo(req);
    const createInput = {
      ...req.body,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    };
    const hasExplicitAssignee =
      Object.prototype.hasOwnProperty.call(req.body, "assigneeAgentId") ||
      Object.prototype.hasOwnProperty.call(req.body, "assigneeUserId");
    if (actor.actorType === "agent" && actor.agentId && !hasExplicitAssignee) {
      createInput.assigneeAgentId = actor.agentId;
    }

    const issue = await svc.create(orgId, {
      ...createInput,
    });

    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.created",
      entityType: "issue",
      entityId: issue.id,
      details: { title: issue.title, identifier: issue.identifier },
    });

    void queueIssueAssignmentWakeup({
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    void queueIssueReviewWakeup({
      heartbeat,
      issue,
      mutation: "create_in_review",
      contextSource: "issue.create",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
      actorAgentId: actor.agentId,
    });

    res.status(201).json(issue);
  });

  router.patch("/issues/:id", validate(updateIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    const assigneeWillChange =
      (req.body.assigneeAgentId !== undefined && req.body.assigneeAgentId !== existing.assigneeAgentId) ||
      (req.body.assigneeUserId !== undefined && req.body.assigneeUserId !== existing.assigneeUserId);
    const reviewerWillChange =
      (req.body.reviewerAgentId !== undefined && req.body.reviewerAgentId !== existing.reviewerAgentId) ||
      (req.body.reviewerUserId !== undefined && req.body.reviewerUserId !== existing.reviewerUserId);

    const isAgentReturningIssueToCreator =
      req.actor.type === "agent" &&
      !!req.actor.agentId &&
      existing.assigneeAgentId === req.actor.agentId &&
      req.body.assigneeAgentId === null &&
      typeof req.body.assigneeUserId === "string" &&
      !!existing.createdByUserId &&
      req.body.assigneeUserId === existing.createdByUserId;

    if (assigneeWillChange) {
      if (!isAgentReturningIssueToCreator) {
        await assertCanAssignTasks(req, existing.orgId);
      }
    }
    if (reviewerWillChange) {
      await assertCanAssignTasks(req, existing.orgId);
    }
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;

    const actor = getActorInfo(req);
    const isClosed = existing.status === "done" || existing.status === "cancelled";
    const {
      comment: commentBody,
      reopen: reopenRequested,
      hiddenAt: hiddenAtRaw,
      reviewDecision,
      ...updateFields
    } = req.body;
    if (hiddenAtRaw !== undefined) {
      updateFields.hiddenAt = hiddenAtRaw ? new Date(hiddenAtRaw) : null;
    }
    if (commentBody && reopenRequested === true && isClosed && updateFields.status === undefined) {
      updateFields.status = "todo";
    }
    if (reviewDecision !== undefined) {
      if (!commentBody) {
        throw unprocessable("Reviewer decisions require a comment");
      }
      if (!statusAcceptsReviewerDecision(existing.status)) {
        throw unprocessable("Reviewer decisions can only be recorded while the issue is in_review or blocked");
      }
      if (actor.actorType === "agent" && !isReviewerAgentForIssue(actor, existing)) {
        throw forbidden("Only the reviewer agent can record a reviewer decision");
      }
      const decisionStatus = statusForReviewDecision(reviewDecision);
      if (decisionStatus) {
        updateFields.status = decisionStatus;
      } else {
        delete updateFields.status;
      }
    }
    let reviewedCompletionNormalized = false;
    if (
      updateFields.status === "done" &&
      !canAgentCompleteIssue(actor, existing)
    ) {
      res.status(403).json({ error: "Only the checked-out assignee or reviewer can complete issue" });
      return;
    }
    if (
      updateFields.status === "done" &&
      issueHasReviewer(existing) &&
      actor.actorType === "agent" &&
      !(statusAcceptsReviewerDecision(existing.status) && isReviewerAgentForIssue(actor, existing))
    ) {
      updateFields.status = "in_review";
      reviewedCompletionNormalized = true;
    }
    let issue;
    try {
      issue = await svc.update(id, updateFields);
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        logger.warn(
          {
            issueId: id,
            orgId: existing.orgId,
            assigneePatch: {
              assigneeAgentId:
                req.body.assigneeAgentId === undefined ? "__omitted__" : req.body.assigneeAgentId,
              assigneeUserId:
                req.body.assigneeUserId === undefined ? "__omitted__" : req.body.assigneeUserId,
              reviewerAgentId:
                req.body.reviewerAgentId === undefined ? "__omitted__" : req.body.reviewerAgentId,
              reviewerUserId:
                req.body.reviewerUserId === undefined ? "__omitted__" : req.body.reviewerUserId,
            },
            currentAssignee: {
              assigneeAgentId: existing.assigneeAgentId,
              assigneeUserId: existing.assigneeUserId,
              reviewerAgentId: existing.reviewerAgentId,
              reviewerUserId: existing.reviewerUserId,
            },
            error: err.message,
            details: err.details,
          },
          "issue update rejected with 422",
        );
      }
      throw err;
    }
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    await automationsSvc.syncRunStatusForIssue(issue.id);

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err: unknown) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue activity"));
    }

    const issueUpdateActivity = buildIssueUpdateActivityDetails(
      existing as Record<string, unknown>,
      issue as Record<string, unknown>,
      {
        identifier: issue.identifier,
        ...(commentBody ? { source: "comment" } : {}),
        ...(reviewedCompletionNormalized
          ? {
              normalizedFromStatus: "done",
              normalizedReason: "reviewed_issue_assignee_completion",
            }
          : {}),
      },
    );
    const hasFieldChanges = issueUpdateActivity.hasFieldChanges;
    const reopened =
      commentBody &&
      reopenRequested === true &&
      isClosed &&
      (issueUpdateActivity.details._previous as Record<string, unknown> | undefined)?.status !== undefined &&
      issue.status === "todo";
    const reopenFromStatus = reopened ? existing.status : null;
    if (hasFieldChanges || reopened || reviewedCompletionNormalized) {
      const relationshipReferences = await buildIssueUpdateActivityReferences(
        svc,
        issue.orgId,
        issueUpdateActivity.details,
      );
      await logActivity(db, {
        orgId: issue.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          ...issueUpdateActivity.details,
          ...relationshipReferences,
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
        },
      });
    }

    let comment = null;
    if (commentBody) {
      comment = await svc.addComment(id, commentBody, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
      });

      await logActivity(db, {
        orgId: issue.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          bodySnippet: comment.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
          ...(hasFieldChanges ? { updated: true } : {}),
        },
      });

    }
    if (reviewDecision !== undefined) {
      const reviewOutcome = reviewDecision === "blocked" ? "human_handoff" : "review_closed";
      await logActivity(db, {
        orgId: issue.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.review_decision_recorded",
        entityType: "issue",
        entityId: issue.id,
        details: {
          decision: reviewDecision,
          outcome: reviewOutcome,
          operatorActionRequired: reviewOutcome === "human_handoff",
          status: issue.status,
          identifier: issue.identifier,
          commentId: comment?.id ?? null,
        },
      });
      if (reviewerDecisionRequiresHumanHandoff(reviewDecision)) {
        await logActivity(db, {
          orgId: issue.orgId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.human_intervention_required",
          entityType: "issue",
          entityId: issue.id,
          details: {
            decision: reviewDecision,
            status: issue.status,
            identifier: issue.identifier,
            issueTitle: issue.title,
            commentId: comment?.id ?? null,
            previousReviewerAgentId: existing.reviewerAgentId,
            previousReviewerUserId: existing.reviewerUserId,
            nextAction: "Human/operator intervention is required before agent review can continue.",
          },
        });
      }
    }

    const assigneeChanged = assigneeWillChange;
    const reviewerChanged = reviewerWillChange;
    const statusChangedFromBacklog =
      existing.status === "backlog" &&
      issue.status !== "backlog" &&
      updateFields.status !== undefined;
    const statusChangedToInReview =
      existing.status !== "in_review" &&
      issue.status === "in_review" &&
      updateFields.status !== undefined;
    const statusChangedToBlocked =
      existing.status !== "blocked" &&
      issue.status === "blocked" &&
      updateFields.status !== undefined;
    const statusReturnedFromReviewToAssignee =
      statusAcceptsReviewerDecision(existing.status) &&
      (issue.status === "in_progress" || issue.status === "todo") &&
      updateFields.status !== undefined;
    const reviewerChangedInReviewableStatus =
      reviewerChanged &&
      statusAcceptsReviewerDecision(existing.status) &&
      statusAcceptsReviewerDecision(issue.status);

    // Merge all wakeups from this update into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();

      if (assigneeChanged && issue.assigneeAgentId && issue.status !== "backlog") {
        wakeups.set(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: issue.id, mutation: "update" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: "issue.update",
            wakeSource: "assignment",
            wakeReason: "issue_assigned",
            issue: {
              id: issue.id,
              title: issue.title,
              description: issue.description,
              status: issue.status,
              priority: issue.priority,
            },
          },
        });
      }

      if (!assigneeChanged && statusChangedFromBacklog && issue.assigneeAgentId) {
        wakeups.set(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_status_changed",
          payload: { issueId: issue.id, mutation: "update" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: "issue.status_change",
            wakeSource: "automation",
            wakeReason: "issue_status_changed",
            issue: {
              id: issue.id,
              title: issue.title,
              description: issue.description,
              status: issue.status,
              priority: issue.priority,
            },
          },
        });
      }

      if (!assigneeChanged && statusReturnedFromReviewToAssignee && issue.assigneeAgentId) {
        const commentContext = comment
          ? {
              commentId: comment.id,
              wakeCommentId: comment.id,
              comment: {
                id: comment.id,
                body: comment.body,
                authorAgentId: comment.authorAgentId,
                authorUserId: comment.authorUserId,
              },
            }
          : {};
        wakeups.set(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_changes_requested",
          payload: {
            issueId: issue.id,
            mutation: "review_changes_requested",
            ...(comment ? { commentId: comment.id } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            source: "issue.review_changes_requested",
            wakeSource: "assignment",
            wakeReason: "issue_changes_requested",
            issue: {
              id: issue.id,
              title: issue.title,
              description: issue.description,
              status: issue.status,
              priority: issue.priority,
            },
            ...commentContext,
          },
        });
      }

      if ((statusChangedToInReview || statusChangedToBlocked || reviewerChangedInReviewableStatus) && issue.reviewerAgentId) {
        const mutation = statusChangedToInReview
          ? "status_to_in_review"
          : statusChangedToBlocked
            ? "status_to_blocked"
            : issue.status === "blocked"
              ? "reviewer_changed_blocked"
              : "reviewer_changed_in_review";
        const actorIsReviewerAgent = actor.actorType === "agent" && actor.actorId === issue.reviewerAgentId;
        const actorIsAssigneeAgent = actor.actorType === "agent" && actor.actorId === issue.assigneeAgentId;
        const assigneeHandoffToReview = (statusChangedToInReview || statusChangedToBlocked) && actorIsAssigneeAgent;
        if (!actorIsReviewerAgent || assigneeHandoffToReview) {
          wakeups.set(issue.reviewerAgentId, buildIssueReviewWakeupOptions({
            issue,
            mutation,
            contextSource: statusChangedToInReview || statusChangedToBlocked ? "issue.status_change" : "issue.reviewer_change",
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
          }));
        }
      }

      if (commentBody && comment) {
        let mentionedIds: string[] = [];
        if (actor.actorType !== "agent") {
          try {
            mentionedIds = await svc.findMentionedAgents(issue.orgId, commentBody);
          } catch (err) {
            logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
          }
        }

        for (const mentionedId of mentionedIds) {
          if (wakeups.has(mentionedId)) continue;
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          wakeups.set(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_mentioned",
              wakeSource: "comment.mention",
              source: "comment.mention",
              issue: {
                id: issue.id,
                title: issue.title,
                description: issue.description,
                status: issue.status,
                priority: issue.priority,
              },
              comment: {
                id: comment.id,
                body: comment.body,
                authorAgentId: comment.authorAgentId,
                authorUserId: comment.authorUserId,
              },
            },
          });
        }
      }

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err: unknown) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }
    })();

    res.json({ ...issue, comment });
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    const attachments = await svc.listAttachments(id);

    const issue = await svc.remove(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(attachment.orgId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: issue.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    res.json(issue);
  });

  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);

    if (issue.projectId) {
      const project = await projectsSvc.getById(issue.projectId);
      if (project?.pausedAt) {
        res.status(409).json({
          error:
            project.pauseReason === "budget"
              ? "Project is paused because its budget hard-stop was reached"
              : "Project is paused",
        });
        return;
      }
    }

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only checkout as itself" });
      return;
    }

    const checkoutRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !checkoutRunId) return;
    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId);
    const actor = getActorInfo(req);

    await logActivity(db, {
      orgId: issue.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issue.id,
      details: { agentId: req.body.agentId },
    });

    if (
      shouldWakeAssigneeOnCheckout({
        actorType: req.actor.type,
        actorAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        checkoutAgentId: req.body.agentId,
        checkoutRunId,
      })
    ) {
      void heartbeat
        .wakeup(req.body.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_checked_out",
          payload: { issueId: issue.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.checkout" },
        })
        .catch((err: unknown) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }

    res.json(updated);
  });

  router.post("/issues/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    if (!(await assertAgentRunCheckoutOwnership(req, res, existing))) return;
    const actorRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !actorRunId) return;

    const released = await svc.release(
      id,
      req.actor.type === "agent" ? req.actor.agentId : undefined,
      actorRunId,
    );
    if (!released) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: released.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
    });

    res.json(released);
  });

  router.post("/issues/:id/commit", validate(reportIssueCommitSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    if (req.actor.type !== "agent") {
      res.status(403).json({ error: "Agent authentication required" });
      return;
    }
    if (!(await assertAgentRunCheckoutOwnership(req, res, issue))) return;

    const actor = getActorInfo(req);
    const commitRun = await resolveAgentIssueRunId(req, res, issue);
    if (!commitRun.ok) return;
    const sha = req.body.sha.trim().toLowerCase();
    const subject = commitSubject(req.body.message);
    const shortSha = sha.slice(0, 7);

    if (commitRun.runId) {
      await heartbeat.reportRunActivity(commitRun.runId).catch((err: unknown) =>
        logger.warn({ err, runId: commitRun.runId }, "failed to clear detached run warning after issue commit activity"));
    }

    await logActivity(db, {
      orgId: issue.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: commitRun.runId,
      action: "issue.code_committed",
      entityType: "issue",
      entityId: issue.id,
      details: {
        sha,
        shortSha,
        message: req.body.message,
        subject,
        identifier: issue.identifier,
        issueTitle: issue.title,
        branch: req.body.branch ?? null,
        repoPath: req.body.repoPath ?? null,
        workspacePath: req.body.workspacePath ?? null,
        commitCount: req.body.commitCount ?? 1,
      },
    });

    res.status(201).json({
      ok: true,
      issueId: issue.id,
      sha,
      shortSha,
      message: req.body.message,
      subject,
      runId: commitRun.runId,
    });
  });
}
