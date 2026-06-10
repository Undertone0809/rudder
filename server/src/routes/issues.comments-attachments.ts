import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@rudderhq/db";
import { buildIssueDocumentsPrompt } from "@rudderhq/agent-runtime-utils/server-utils";
import {
  addIssueCommentSchema,
  updateIssueCommentSchema,
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
  runWorkspaceService,
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


type IssueCommentAttachmentRouteContext = {
  router: Router;
  db: Db;
  storage: StorageService;
  [key: string]: any;
};

export function registerIssueCommentAttachmentRoutes(ctx: IssueCommentAttachmentRouteContext) {
  const {
    router,
    db,
    storage,
    svc,
    runSingleFileUpload,
    withContentPath,
    MAX_ISSUE_COMMENT_LIMIT,
    heartbeat,
    workspaceBrowser,
    assertAgentRunCheckoutOwnership,
    resolveAgentIssueRunId,
  } = ctx;
  router.get("/issues/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    const afterCommentId =
      typeof req.query.after === "string" && req.query.after.trim().length > 0
        ? req.query.after.trim()
        : typeof req.query.afterCommentId === "string" && req.query.afterCommentId.trim().length > 0
          ? req.query.afterCommentId.trim()
          : null;
    const order =
      typeof req.query.order === "string" && req.query.order.trim().toLowerCase() === "asc"
        ? "asc"
        : "desc";
    const limitRaw =
      typeof req.query.limit === "string" && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : null;
    const limit =
      limitRaw && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_ISSUE_COMMENT_LIMIT)
        : null;
    const comments = await svc.listComments(id, {
      afterCommentId,
      order,
      limit,
    });
    res.json(comments);
  });

  router.get("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.patch("/issues/:id/comments/:commentId", validate(updateIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    assertBoard(req);

    const actor = getActorInfo(req);
    const comment = await svc.updateComment(id, commentId, req.body.body, {
      userId: actor.actorId,
    });

    await logActivity(db, {
      orgId: issue.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        commentId: comment.id,
        identifier: issue.identifier,
        issueTitle: issue.title,
      },
    });

    res.json(comment);
  });

  router.delete("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    assertBoard(req);

    const actor = getActorInfo(req);
    const comment = await svc.deleteComment(id, commentId, {
      userId: actor.actorId,
    });

    await logActivity(db, {
      orgId: issue.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.comment_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        commentId: comment.id,
        identifier: issue.identifier,
        issueTitle: issue.title,
      },
    });

    res.json(comment);
  });

  router.post("/issues/:id/comments", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    if (!(await assertAgentRunCheckoutOwnership(req, res, issue))) return;
    const commentRun = await resolveAgentIssueRunId(req, res, issue);
    if (!commentRun.ok) return;

    const actor = getActorInfo(req);
    const reopenRequested = req.body.reopen === true;
    const interruptRequested = req.body.interrupt === true;
    const isClosed = issue.status === "done" || issue.status === "cancelled";
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue = issue;

    if (reopenRequested && isClosed) {
      const reopenedIssue = await svc.update(id, { status: "todo" });
      if (!reopenedIssue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      reopened = true;
      reopenFromStatus = issue.status;
      currentIssue = reopenedIssue;

      await logActivity(db, {
        orgId: currentIssue.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.updated",
        entityType: "issue",
        entityId: currentIssue.id,
        details: {
          status: "todo",
          reopened: true,
          reopenedFrom: reopenFromStatus,
          source: "comment",
          identifier: currentIssue.identifier,
        },
      });
    }

    if (interruptRequested) {
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      let runToInterrupt = currentIssue.executionRunId
        ? await heartbeat.getRun(currentIssue.executionRunId)
        : null;

      if (
        (!runToInterrupt || runToInterrupt.status !== "running") &&
        currentIssue.assigneeAgentId
      ) {
        const activeRun = await heartbeat.getActiveRunForAgent(currentIssue.assigneeAgentId);
        const activeIssueId =
          activeRun &&
            activeRun.contextSnapshot &&
            typeof activeRun.contextSnapshot === "object" &&
            typeof (activeRun.contextSnapshot as Record<string, unknown>).issueId === "string"
            ? ((activeRun.contextSnapshot as Record<string, unknown>).issueId as string)
            : null;
        if (activeRun && activeRun.status === "running" && activeIssueId === currentIssue.id) {
          runToInterrupt = activeRun;
        }
      }

      if (runToInterrupt && runToInterrupt.status === "running") {
        const cancelled = await heartbeat.cancelRun(runToInterrupt.id);
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            orgId: cancelled.orgId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            details: { agentId: cancelled.agentId, source: "issue_comment_interrupt", issueId: currentIssue.id },
          });
        }
      }
    }

    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    if (commentRun.runId) {
      await heartbeat.reportRunActivity(commentRun.runId).catch((err: unknown) =>
        logger.warn({ err, runId: commentRun.runId }, "failed to clear detached run warning after issue comment"));
    }

    await logActivity(db, {
      orgId: currentIssue.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: commentRun.runId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
      },
    });

    // Merge all wakeups from this comment into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      const wakeups = new Map<string, Parameters<typeof heartbeat.wakeup>[1]>();
      const assigneeId = currentIssue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      const backlogComment = currentIssue.status === "backlog";
      const skipWake = selfComment || isClosed || backlogComment;
      if (assigneeId && (reopened || !skipWake)) {
        if (reopened) {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_reopened_via_comment",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              reopenedFrom: reopenFromStatus,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              source: "issue.comment.reopen",
              wakeReason: "issue_reopened_via_comment",
              reopenedFrom: reopenFromStatus,
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          wakeups.set(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              mutation: "comment",
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment",
              wakeReason: "issue_commented",
              issue: {
                id: currentIssue.id,
                title: currentIssue.title,
                description: currentIssue.description,
                status: currentIssue.status,
                priority: currentIssue.priority,
              },
              comment: {
                id: comment.id,
                body: comment.body,
                authorAgentId: comment.authorAgentId,
                authorUserId: comment.authorUserId,
              },
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }
      }

      let mentionedIds: string[] = [];
      if (!actorIsAgent) {
        try {
          mentionedIds = await svc.findMentionedAgents(issue.orgId, req.body.body);
        } catch (err) {
          logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
        }
      }

      for (const mentionedId of mentionedIds) {
        if (wakeups.has(mentionedId)) continue;
        if (actorIsAgent && actor.actorId === mentionedId) continue;
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
              id: currentIssue.id,
              title: currentIssue.title,
              description: currentIssue.description,
              status: currentIssue.status,
              priority: currentIssue.priority,
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

      for (const [agentId, wakeup] of wakeups.entries()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .catch((err: unknown) => logger.warn({ err, issueId: currentIssue.id, agentId }, "failed to wake agent on issue comment"));
      }
    })();

    res.status(201).json(comment);
  });

  router.get("/issues/:id/attachments", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    const attachments = await svc.listAttachments(issueId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/orgs/:orgId/issues/:issueId/attachments", async (req, res) => {
    const orgId = req.params.orgId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, orgId);
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.orgId !== orgId) {
      res.status(422).json({ error: "Issue does not belong to organization" });
      return;
    }

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = (file.mimetype || "").toLowerCase();
    if (!isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported attachment type: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      orgId,
      namespace: `issues/${issueId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      issueId,
      issueCommentId: parsedMeta.data.issueCommentId ?? null,
      usage: parsedMeta.data.usage ?? "issue",
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    if (attachment.usage === "issue") {
      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.attachment_added",
        entityType: "issue",
        entityId: issueId,
        details: {
          attachmentId: attachment.id,
          usage: attachment.usage,
          originalFilename: attachment.originalFilename,
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
        },
      });
    }

    res.status(201).json(withContentPath(attachment));
  });

  router.post(
    "/orgs/:orgId/issues/:issueId/attachments/workspace-file",
    validate(createIssueWorkspaceAttachmentSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const issueId = req.params.issueId as string;
      assertCompanyAccess(req, orgId);
      const issue = await svc.getById(issueId);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      if (issue.orgId !== orgId) {
        res.status(422).json({ error: "Issue does not belong to organization" });
        return;
      }

      const workspaceFile = await workspaceBrowser.readAttachmentFile(orgId, req.body.path);
      if (workspaceFile.buffer.length <= 0) {
        res.status(422).json({ error: "Attachment is empty" });
        return;
      }
      if (workspaceFile.buffer.length > MAX_ATTACHMENT_BYTES) {
        res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
        return;
      }
      if (!isAllowedContentType(workspaceFile.contentType)) {
        res.status(422).json({ error: `Unsupported attachment type: ${workspaceFile.contentType || "unknown"}` });
        return;
      }

      const actor = getActorInfo(req);
      const stored = await storage.putFile({
        orgId,
        namespace: `issues/${issueId}`,
        originalFilename: workspaceFile.originalFilename,
        contentType: workspaceFile.contentType,
        body: workspaceFile.buffer,
      });

      const attachment = await svc.createAttachment({
        issueId,
        issueCommentId: null,
        usage: "issue",
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.attachment_added",
        entityType: "issue",
        entityId: issueId,
        details: {
          attachmentId: attachment.id,
          usage: attachment.usage,
          originalFilename: attachment.originalFilename,
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
          workspacePath: workspaceFile.normalizedPath,
        },
      });

      res.status(201).json(withContentPath(attachment));
    },
  );

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.orgId);

    const object = await storage.getObject(attachment.orgId, attachment.objectKey);
    res.setHeader("Content-Type", attachment.contentType || object.contentType || "application/octet-stream");
    res.setHeader("Content-Length", String(attachment.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    const filename = attachment.originalFilename ?? "attachment";
    res.setHeader("Content-Disposition", `inline; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await svc.getAttachmentById(attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }
    assertCompanyAccess(req, attachment.orgId);

    try {
      await storage.deleteObject(attachment.orgId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: removed.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.attachment_removed",
      entityType: "issue",
      entityId: removed.issueId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

}
