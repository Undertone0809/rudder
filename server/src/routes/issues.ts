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
  type IssueSearchField,
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
  messengerService,
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
import { registerIssueMutationRoutes } from "./issues.mutations.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;
const ISSUE_SEARCH_FIELDS = new Set<IssueSearchField>(["title", "description", "comment"]);

export function issueRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = issueService(db);
  const messengerSvc = messengerService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db);
  const agentsSvc = agentService(db);
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const executionWorkspacesSvc = runWorkspaceService(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const automationsSvc = automationService(db);
  const workspaceBrowser = organizationWorkspaceBrowserService(db);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  function withContentPath<T extends { id: string }>(attachment: T) {
    return {
      ...attachment,
      contentPath: `/api/attachments/${attachment.id}/content`,
    };
  }

  function normalizeWorkProductRunWorkspaceFields<T extends Record<string, unknown>>(body: T): T {
    const hasCanonical = Object.prototype.hasOwnProperty.call(body, "runWorkspaceId");
    const hasLegacy = Object.prototype.hasOwnProperty.call(body, "executionWorkspaceId");
    if (
      hasCanonical &&
      hasLegacy &&
      JSON.stringify(body.runWorkspaceId ?? null) !== JSON.stringify(body.executionWorkspaceId ?? null)
    ) {
      throw unprocessable("runWorkspaceId conflicts with deprecated executionWorkspaceId");
    }
    const normalized: Record<string, unknown> = { ...body };
    if (hasCanonical && !hasLegacy) {
      normalized.executionWorkspaceId = body.runWorkspaceId;
    }
    delete normalized.runWorkspaceId;
    return normalized as T;
  }

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function assertCanManageIssueApprovalLinks(req: Request, res: Response, orgId: string) {
    assertCompanyAccess(req, orgId);
    if (req.actor.type === "board") return true;
    if (!req.actor.agentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    const actorAgent = await agentsSvc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.orgId !== orgId) {
      res.status(403).json({ error: "Forbidden" });
      return false;
    }
    if (actorAgent.role === "ceo" || Boolean(actorAgent.permissions?.canCreateAgents)) return true;
    res.status(403).json({ error: "Missing permission to link approvals" });
    return false;
  }

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    if (agent.role === "ceo") return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanAssignTasks(req: Request, orgId: string) {
    assertCompanyAccess(req, orgId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(orgId, req.actor.userId, "tasks:assign");
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
      return;
    }
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const allowedByGrant = await access.hasPermission(orgId, "agent", req.actor.agentId, "tasks:assign");
      if (allowedByGrant) return;
      const actorAgent = await agentsSvc.getById(req.actor.agentId);
      if (actorAgent && actorAgent.orgId === orgId && canCreateAgentsLegacy(actorAgent)) return;
      throw forbidden("Missing permission: tasks:assign");
    }
    throw unauthorized();
  }

  function requireAgentRunId(req: Request, res: Response) {
    if (req.actor.type !== "agent") return null;
    const runId = req.actor.runId?.trim();
    if (runId) return runId;
    res.status(401).json({ error: "Agent run id required" });
    return null;
  }

  async function assertAgentRunCheckoutOwnership(
    req: Request,
    res: Response,
    issue: { id: string; orgId: string; status: string; assigneeAgentId: string | null },
  ) {
    if (req.actor.type !== "agent") return true;
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return false;
    }
    if (issue.status !== "in_progress" || issue.assigneeAgentId !== actorAgentId) {
      return true;
    }
    async function logOwnershipRejected(reason: string, details?: Record<string, unknown>) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: issue.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.run_ownership_rejected",
        entityType: "issue",
        entityId: issue.id,
        details: {
          reason,
          status: issue.status,
          assigneeAgentId: issue.assigneeAgentId,
          actorAgentId,
          actorRunId: actor.runId,
          ...details,
        },
      });
    }
    const runId = requireAgentRunId(req, res);
    if (!runId) {
      await logOwnershipRejected("missing_agent_run_id");
      return false;
    }
    if (!isUuidLike(runId)) {
      await logOwnershipRejected("invalid_agent_run_id");
      res.status(403).json({ error: "Run context is not valid for this issue" });
      return false;
    }
    let ownership;
    try {
      ownership = await svc.assertCheckoutOwner(issue.id, actorAgentId, runId);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        await logOwnershipRejected("checkout_owner_conflict", {
          error: err.message,
          errorDetails: err.details,
        });
      }
      throw err;
    }
    if (ownership.adoptedFromRunId) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: issue.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.checkout_lock_adopted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          previousCheckoutRunId: ownership.adoptedFromRunId,
          checkoutRunId: runId,
          reason: "stale_checkout_run",
        },
      });
    }
    return true;
  }

  function readIssueIdFromRunContext(contextSnapshot: unknown) {
    if (!contextSnapshot || typeof contextSnapshot !== "object") return null;
    const issueId = (contextSnapshot as Record<string, unknown>).issueId;
    return typeof issueId === "string" && issueId.trim() ? issueId.trim() : null;
  }

  async function resolveAgentIssueRunId(
    req: Request,
    res: Response,
    issue: {
      id: string;
      orgId: string;
      checkoutRunId?: string | null;
      executionRunId?: string | null;
    },
  ): Promise<{ ok: true; runId: string | null } | { ok: false }> {
    if (req.actor.type !== "agent") return { ok: true, runId: null };
    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return { ok: false };
    }

    const runId = req.actor.runId?.trim();
    if (!runId) return { ok: true, runId: null };
    if (!isUuidLike(runId)) {
      res.status(403).json({ error: "Run context is not valid for this issue" });
      return { ok: false };
    }

    const run = await heartbeat.getRun(runId);
    const runIssueId = readIssueIdFromRunContext(run?.contextSnapshot);
    const runBoundToIssue =
      issue.checkoutRunId === runId ||
      issue.executionRunId === runId ||
      runIssueId === issue.id;

    if (
      !run ||
      run.orgId !== issue.orgId ||
      run.agentId !== actorAgentId ||
      !runBoundToIssue
    ) {
      res.status(403).json({ error: "Run context is not valid for this issue" });
      return { ok: false };
    }

    return { ok: true, runId };
  }

  async function normalizeIssueIdentifier(rawId: string): Promise<string> {
    if (/^[A-Z]+-\d+$/i.test(rawId)) {
      const issue = await svc.getByIdentifier(rawId);
      if (issue) {
        return issue.id;
      }
    }
    return rawId;
  }

  function boardUserId(req: Request) {
    assertBoard(req);
    return req.actor.userId ?? "local-board";
  }

  function parseIssueSearchFields(raw: unknown): IssueSearchField[] | undefined {
    if (typeof raw !== "string") return undefined;
    const fields = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry): entry is IssueSearchField => ISSUE_SEARCH_FIELDS.has(entry as IssueSearchField));
    return fields.length > 0 ? fields : undefined;
  }

  function issueHasReviewer(issue: { reviewerAgentId: string | null; reviewerUserId: string | null }) {
    return Boolean(issue.reviewerAgentId || issue.reviewerUserId);
  }

  function isReviewerAgentForIssue(actor: ReturnType<typeof getActorInfo>, issue: { reviewerAgentId: string | null }) {
    return actor.actorType === "agent" && Boolean(actor.agentId) && actor.agentId === issue.reviewerAgentId;
  }

  function canAgentCompleteIssue(actor: ReturnType<typeof getActorInfo>, issue: {
    status: string;
    assigneeAgentId: string | null;
    reviewerAgentId: string | null;
  }) {
    if (actor.actorType !== "agent") return true;
    if (!actor.agentId) return false;
    if (statusAcceptsReviewerDecision(issue.status) && isReviewerAgentForIssue(actor, issue)) return true;
    return issue.status === "in_progress" && issue.assigneeAgentId === actor.agentId;
  }

  function statusForReviewDecision(decision: string) {
    switch (decision) {
      case "approve":
        return "done";
      case "request_changes":
        return "in_progress";
      case "blocked":
        return "blocked";
      case "needs_followup":
        return null;
      default:
        return null;
    }
  }

  function statusAcceptsReviewerDecision(status: string) {
    return status === "in_review" || status === "blocked";
  }

  function reviewerDecisionRequiresHumanHandoff(decision: string) {
    return decision === "blocked";
  }

  function commitSubject(message: string) {
    return message.split(/\r?\n/, 1)[0]?.trim() || message.trim();
  }

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for all /issues/:id routes
  router.param("id", async (req, res, next, rawId) => {
    try {
      req.params.id = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Resolve issue identifiers (e.g. "PAP-39") to UUIDs for organization-scoped attachment routes.
  router.param("issueId", async (req, res, next, rawId) => {
    try {
      req.params.issueId = await normalizeIssueIdentifier(rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  // Common malformed path when orgId is empty in "/api/orgs/{orgId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing orgId in path. Use /api/orgs/{orgId}/issues.",
    });
  });

  router.get("/orgs/:orgId/issues", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const assigneeUserFilterRaw = req.query.assigneeUserId as string | undefined;
    const reviewerUserFilterRaw = req.query.reviewerUserId as string | undefined;
    const touchedByUserFilterRaw = req.query.touchedByUserId as string | undefined;
    const unreadForUserFilterRaw = req.query.unreadForUserId as string | undefined;
    const assigneeUserId =
      assigneeUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : assigneeUserFilterRaw;
    const reviewerUserId =
      reviewerUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : reviewerUserFilterRaw;
    const touchedByUserId =
      touchedByUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : touchedByUserFilterRaw;
    const unreadForUserId =
      unreadForUserFilterRaw === "me" && req.actor.type === "board"
        ? req.actor.userId
        : unreadForUserFilterRaw;

    if (assigneeUserFilterRaw === "me" && (!assigneeUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "assigneeUserId=me requires board authentication" });
      return;
    }
    if (reviewerUserFilterRaw === "me" && (!reviewerUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "reviewerUserId=me requires board authentication" });
      return;
    }
    if (touchedByUserFilterRaw === "me" && (!touchedByUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "touchedByUserId=me requires board authentication" });
      return;
    }
    if (unreadForUserFilterRaw === "me" && (!unreadForUserId || req.actor.type !== "board")) {
      res.status(403).json({ error: "unreadForUserId=me requires board authentication" });
      return;
    }

    const result = await svc.list(orgId, {
      status: req.query.status as string | undefined,
      assigneeAgentId: req.query.assigneeAgentId as string | undefined,
      participantAgentId: req.query.participantAgentId as string | undefined,
      assigneeUserId,
      reviewerAgentId: req.query.reviewerAgentId as string | undefined,
      reviewerUserId,
      touchedByUserId,
      unreadForUserId,
      projectId: req.query.projectId as string | undefined,
      parentId: req.query.parentId as string | undefined,
      labelId: req.query.labelId as string | undefined,
      originKind: req.query.originKind as string | undefined,
      originId: req.query.originId as string | undefined,
      includeAutomationExecutions:
        req.query.includeAutomationExecutions === "true" || req.query.includeAutomationExecutions === "1",
      q: req.query.q as string | undefined,
      searchFields: parseIssueSearchFields(req.query.searchFields),
    });
    res.json(result);
  });

  router.post("/orgs/:orgId/issues/reorder", validate(reorderIssueSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const result = await svc.reorder(orgId, req.body);
    if (!result) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: result.issue.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.reordered",
      entityType: "issue",
      entityId: result.issue.id,
      details: {
        identifier: result.issue.identifier,
        status: result.issue.status,
        boardOrder: result.issue.boardOrder,
        previousIssueId: req.body.previousIssueId ?? null,
        nextIssueId: req.body.nextIssueId ?? null,
        position: req.body.position ?? null,
        _previous: {
          status: result.previousStatus,
          boardOrder: result.previousBoardOrder,
        },
      },
    });
    res.json(result.issue);
  });

  router.get("/orgs/:orgId/issues/follows", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const userId = req.actor.userId;
    if (!userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const rows = await svc.listFollows(orgId, userId);
    res.json(rows);
  });

  router.get("/orgs/:orgId/labels", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const result = await svc.listLabels(orgId);
    res.json(result);
  });

  router.post("/orgs/:orgId/labels", validate(createIssueLabelSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const label = await svc.createLabel(orgId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.created",
      entityType: "label",
      entityId: label.id,
      details: { name: label.name, color: label.color },
    });
    res.status(201).json(label);
  });

  router.patch("/labels/:labelId", validate(updateIssueLabelSchema), async (req, res) => {
    const labelId = req.params.labelId as string;
    const existing = await svc.getLabelById(labelId);
    if (!existing) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    const updated = await svc.updateLabel(labelId, req.body);
    if (!updated) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: updated.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.updated",
      entityType: "label",
      entityId: updated.id,
      details: { name: updated.name, color: updated.color },
    });
    res.json(updated);
  });

  router.delete("/labels/:labelId", async (req, res) => {
    const labelId = req.params.labelId as string;
    const existing = await svc.getLabelById(labelId);
    if (!existing) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    const removed = await svc.deleteLabel(labelId);
    if (!removed) {
      res.status(404).json({ error: "Label not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: removed.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "label.deleted",
      entityType: "label",
      entityId: removed.id,
      details: { name: removed.name, color: removed.color },
    });
    res.json(removed);
  });

  router.get("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    const [ancestors, project, goal, mentionedProjectIds, documentPayload] = await Promise.all([
      svc.getAncestors(issue.id),
      issue.projectId ? projectsSvc.getById(issue.projectId) : null,
      issue.goalId ? goalsSvc.getById(issue.goalId) : null,
      svc.findMentionedProjectIds(issue.id),
      documentsSvc.getIssueDocumentPayload(issue),
    ]);
    const mentionedProjects = mentionedProjectIds.length > 0
      ? await projectsSvc.listByIds(issue.orgId, mentionedProjectIds)
      : [];
    const currentRunWorkspace = issue.executionWorkspaceId
      ? await executionWorkspacesSvc.getById(issue.executionWorkspaceId)
      : null;
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json({
      ...issue,
      goalId: issue.goalId,
      ancestors,
      ...documentPayload,
      project: project ?? null,
      goal: goal ?? null,
      mentionedProjects,
      currentRunWorkspace,
      currentExecutionWorkspace: currentRunWorkspace,
      workProducts,
    });
  });

  router.get("/issues/:id/heartbeat-context", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);

    const wakeCommentId =
      typeof req.query.wakeCommentId === "string" && req.query.wakeCommentId.trim().length > 0
        ? req.query.wakeCommentId.trim()
        : null;

    const [ancestors, project, goal, commentCursor, wakeComment, documentPayload] = await Promise.all([
      svc.getAncestors(issue.id),
      issue.projectId ? projectsSvc.getById(issue.projectId) : null,
      issue.goalId ? goalsSvc.getById(issue.goalId) : null,
      svc.getCommentCursor(issue.id),
      wakeCommentId ? svc.getComment(wakeCommentId) : null,
      documentsSvc.getIssueDocumentPayload(issue),
    ]);

    res.json({
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: issue.goalId,
        parentId: issue.parentId,
        assigneeAgentId: issue.assigneeAgentId,
        assigneeUserId: issue.assigneeUserId,
        updatedAt: issue.updatedAt,
      },
      ancestors: ancestors.map((ancestor: Awaited<ReturnType<typeof svc.getAncestors>>[number]) => ({
        id: ancestor.id,
        identifier: ancestor.identifier,
        title: ancestor.title,
        status: ancestor.status,
        priority: ancestor.priority,
      })),
      project: project
        ? {
            id: project.id,
            name: project.name,
            status: project.status,
            targetDate: project.targetDate,
          }
        : null,
      goal: goal
        ? {
            id: goal.id,
            title: goal.title,
            status: goal.status,
            level: goal.level,
            parentId: goal.parentId,
          }
        : null,
      commentCursor,
      ...documentPayload,
      issueDocumentsPrompt: buildIssueDocumentsPrompt(documentPayload),
      wakeComment:
        wakeComment && wakeComment.issueId === issue.id
          ? wakeComment
          : null,
    });
  });

  router.get("/issues/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    const workProducts = await workProductsSvc.listForIssue(issue.id);
    res.json(workProducts);
  });

  router.get("/issues/:id/documents", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    const docs = await documentsSvc.listIssueDocuments(issue.id);
    res.json(docs);
  });

  router.get("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const doc = await documentsSvc.getIssueDocumentByKey(issue.id, keyParsed.data);
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  });

  router.put("/issues/:id/documents/:key", validate(upsertIssueDocumentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    if (req.actor.type === "agent") {
      throw forbidden("Agents must write new durable work files under `library:projects/<project-name>/`");
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const result = await documentsSvc.upsertIssueDocument({
      issueId: issue.id,
      key: keyParsed.data,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    const doc = result.document;

    if (!result.unchanged) {
      await logActivity(db, {
        orgId: issue.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: result.created ? "issue.document_created" : "issue.document_updated",
        entityType: "issue",
        entityId: issue.id,
        details: {
          key: doc.key,
          documentId: doc.id,
          title: doc.title,
          format: doc.format,
          revisionNumber: doc.latestRevisionNumber,
        },
      });
    }

    res.status(result.created ? 201 : 200).json(doc);
  });

  router.get("/issues/:id/documents/:key/revisions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const revisions = await documentsSvc.listIssueDocumentRevisions(issue.id, keyParsed.data);
    res.json(revisions);
  });

  router.delete("/issues/:id/documents/:key", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const keyParsed = issueDocumentKeySchema.safeParse(String(req.params.key ?? "").trim().toLowerCase());
    if (!keyParsed.success) {
      res.status(400).json({ error: "Invalid document key", details: keyParsed.error.issues });
      return;
    }
    const removed = await documentsSvc.deleteIssueDocument(issue.id, keyParsed.data);
    if (!removed) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: issue.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.document_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        key: removed.key,
        documentId: removed.id,
        title: removed.title,
      },
    });
    res.json({ ok: true });
  });

  router.post("/issues/:id/work-products", validate(createIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    const body = normalizeWorkProductRunWorkspaceFields(req.body);
    const product = await workProductsSvc.createForIssue(issue.id, issue.orgId, {
      ...body,
      projectId: body.projectId ?? issue.projectId ?? null,
    });
    if (!product) {
      res.status(422).json({ error: "Invalid work product payload" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: issue.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_created",
      entityType: "issue",
      entityId: issue.id,
      details: { workProductId: product.id, type: product.type, provider: product.provider },
    });
    res.status(201).json(product);
  });

  router.patch("/work-products/:id", validate(updateIssueWorkProductSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    const body = normalizeWorkProductRunWorkspaceFields(req.body);
    const product = await workProductsSvc.update(id, body);
    if (!product) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_updated",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: product.id, changedKeys: Object.keys(body).sort() },
    });
    res.json(product);
  });

  router.delete("/work-products/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await workProductsSvc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    const removed = await workProductsSvc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.work_product_deleted",
      entityType: "issue",
      entityId: existing.issueId,
      details: { workProductId: removed.id, type: removed.type },
    });
    res.json(removed);
  });

  router.post("/issues/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const readAt = new Date();
    const readState = await svc.markRead(issue.orgId, issue.id, req.actor.userId, readAt);
    await messengerSvc.setThreadRead(issue.orgId, req.actor.userId, `issue:${issue.id}`, readAt);
    res.json(readState);
  });

  router.post("/issues/:id/follow", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const userId = req.actor.userId;
    if (!userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const followed = await svc.followIssue(issue.orgId, issue.id, userId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: issue.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.followed",
      entityType: "issue",
      entityId: issue.id,
      details: {
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      },
    });

    res.status(201).json(followed);
  });

  router.delete("/issues/:id/follow", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board authentication required" });
      return;
    }
    const userId = req.actor.userId;
    if (!userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const removed = await svc.unfollowIssue(issue.orgId, issue.id, userId);
    if (removed) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: issue.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.unfollowed",
        entityType: "issue",
        entityId: issue.id,
        details: {
          issueId: issue.id,
          identifier: issue.identifier,
          title: issue.title,
        },
      });
    }

    res.json({ ok: true });
  });

  router.get("/issues/:id/approvals", async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.json(approvals);
  });

  router.post("/issues/:id/approvals", validate(linkIssueApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.orgId))) return;

    const actor = getActorInfo(req);
    const link = await issueApprovalsSvc.link(id, req.body.approvalId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      orgId: issue.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_linked",
      entityType: "issue",
      entityId: issue.id,
      details: {
        approvalId: req.body.approvalId,
        ...(link?.createdAt ? { linkCreatedAt: link.createdAt.toISOString() } : {}),
      },
    });

    const approvals = await issueApprovalsSvc.listApprovalsForIssue(id);
    res.status(201).json(approvals);
  });

  router.delete("/issues/:id/approvals/:approvalId", async (req, res) => {
    const id = req.params.id as string;
    const approvalId = req.params.approvalId as string;
    const issue = await svc.getById(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertCanManageIssueApprovalLinks(req, res, issue.orgId))) return;

    await issueApprovalsSvc.unlink(id, approvalId);

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: issue.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.approval_unlinked",
      entityType: "issue",
      entityId: issue.id,
      details: { approvalId },
    });

    res.json({ ok: true });
  });

  registerIssueMutationRoutes({
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
  });

  registerIssueCommentAttachmentRoutes({
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
  });
  return router;
}
