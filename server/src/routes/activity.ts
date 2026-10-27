import { heartbeatRuns, type Db } from "@rudderhq/db";
import { eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { badRequest, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { sanitizeRecord } from "../redaction.js";
import { sendActivityLinkRead } from "../services/activity-link-read-bridge.js";
import { activityListReadInput, sendActivityRead } from "../services/activity-read-bridge.js";
import { activityService } from "../services/activity.js";
import { resolveHeartbeatRunIdReference } from "../services/heartbeat-run-reference.js";
import { issueService } from "../services/index.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import { assertBoard, assertCompanyAccess, getAuthorizedOrgScope } from "./authz.js";

const USER_ACTIVITY_INCLUDES = new Set(["chat", "comments", "issues", "approvals", "activity"]);

const createActivitySchema = z.object({
  actorType: z.enum(["agent", "user", "system"]).optional().default("system"),
  actorId: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  agentId: z.string().uuid().optional().nullable(),
  details: z.record(z.unknown()).optional().nullable(),
});

export function activityRoutes(db: Db, rustFoundationBridge?: RustFoundationBridge) {
  const router = Router();
  const svc = activityService(db);
  const issueSvc = issueService(db);

  function stringQueryParam(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  function actorTypeQueryParam(value: unknown): "agent" | "user" | "system" | undefined {
    return value === "agent" || value === "user" || value === "system" ? value : undefined;
  }

  function positiveIntegerQueryParam(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw badRequest("invalid 'limit' value");
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) throw badRequest("invalid 'limit' value");
    return parsed;
  }

  function dateQueryParam(value: unknown, name: string): Date | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) throw badRequest(`invalid '${name}' value`);
    const raw = value.trim().toLowerCase();
    const now = new Date();
    if (raw === "today") {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    const relative = raw.match(/^(\d+)([hdw])$/);
    if (relative) {
      const amount = Number(relative[1]);
      const unit = relative[2];
      const hours = unit === "h" ? amount : unit === "d" ? amount * 24 : amount * 24 * 7;
      return new Date(now.getTime() - hours * 60 * 60 * 1000);
    }
    const parsed = new Date(value.trim());
    if (Number.isNaN(parsed.getTime())) throw badRequest(`invalid '${name}' value`);
    return parsed;
  }

  function includeQueryParam(value: unknown) {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw badRequest("invalid 'include' value");
    const includes = value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const include of includes) {
      if (!USER_ACTIVITY_INCLUDES.has(include)) {
        throw badRequest(`invalid 'include' value: ${include}`);
      }
    }
    return includes as Array<"chat" | "comments" | "issues" | "approvals" | "activity">;
  }

  function dateQueryWireValue(value: Date | undefined) {
    // Overflowing relative dates historically reach the database only after
    // ledger limit/cursor validation. Preserve that order across transport.
    return value === undefined ? undefined : Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }

  function resolveUserActivityUserId(req: Request, rawUserId: string) {
    if (rawUserId !== "me") return rawUserId;
    if (req.actor.type === "board") return req.actor.userId ?? "local-board";
    return "local-board";
  }

  async function resolveIssueByRef(rawId: string) {
    if (/^[A-Z][A-Z0-9]*-\d+$/i.test(rawId)) {
      return issueSvc.getByIdentifier(rawId);
    }
    return issueSvc.getById(rawId);
  }

  if (rustFoundationBridge?.publicIngressEnabled !== true) router.get("/orgs/:orgId/activity", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    const filters = {
      agentId: stringQueryParam(req.query.agentId),
      userId: stringQueryParam(req.query.userId),
      actorType: actorTypeQueryParam(req.query.actorType),
      actorId: stringQueryParam(req.query.actorId),
      entityType: stringQueryParam(req.query.entityType),
      entityId: stringQueryParam(req.query.entityId),
    };
    const limit = positiveIntegerQueryParam(req.query.limit);
    const cursor = stringQueryParam(req.query.cursor);
    await sendActivityRead(db, res, rustFoundationBridge, req.actor, orgId, activityListReadInput(filters, limit, cursor));
  });

  if (rustFoundationBridge?.publicIngressEnabled !== true) router.get("/orgs/:orgId/users/:userId/activity-ledger", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = resolveUserActivityUserId(req, req.params.userId as string);
    const filters = {
      orgId,
      userId,
      since: dateQueryParam(req.query.since, "since"),
      until: dateQueryParam(req.query.until, "until"),
      include: includeQueryParam(req.query.include),
      agentId: stringQueryParam(req.query.agentId),
      projectId: stringQueryParam(req.query.projectId),
      issueId: stringQueryParam(req.query.issueId),
      limit: positiveIntegerQueryParam(req.query.limit),
      cursor: stringQueryParam(req.query.cursor),
    };
    await sendActivityLinkRead(res, rustFoundationBridge, req.actor, orgId, {
      operation: "user-ledger", userId,
      since: dateQueryWireValue(filters.since), until: dateQueryWireValue(filters.until),
      include: filters.include, agentId: filters.agentId, projectId: filters.projectId,
      issueId: filters.issueId, limit: filters.limit, cursor: filters.cursor,
    }, db);
  });

  router.post("/orgs/:orgId/activity", validate(createActivitySchema), async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    const event = await svc.create({
      orgId,
      ...req.body,
      details: req.body.details ? sanitizeRecord(req.body.details) : null,
    });
    res.status(201).json(event);
  });

  if (rustFoundationBridge?.publicIngressEnabled !== true) router.get("/issues/:id/activity", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    await sendActivityRead(db, res, rustFoundationBridge, req.actor, issue.orgId, { operation: "issue", issueId: issue.id });
  });

  if (rustFoundationBridge?.publicIngressEnabled !== true) router.get("/issues/:id/runs", async (req, res) => {
    const rawId = req.params.id as string;
    const issue = await resolveIssueByRef(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);
    await sendActivityLinkRead(res, rustFoundationBridge, req.actor, issue.orgId, { operation: "issue-runs", issueId: issue.id }, db);
  });

  async function handleIssuesForRun(req: Request, res: Response, notFoundMessage: string) {
    const runId = await resolveHeartbeatRunIdReference(db, req.params.runId as string, {
      orgIds: getAuthorizedOrgScope(req),
      notFoundMessage,
      sideChatOwnerId: req.actor.type === "board" ? (req.actor.userId ?? "local-board") : null,
    });
    const run = await db
      .select({ orgId: heartbeatRuns.orgId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) throw notFound(notFoundMessage);
    assertCompanyAccess(req, run.orgId);

    await sendActivityLinkRead(res, rustFoundationBridge, req.actor, run.orgId, {
      operation: "run-issues", runId, runAlias: notFoundMessage === "Heartbeat run not found" ? "heartbeat" : "agent",
    }, db);
  }

  if (rustFoundationBridge?.publicIngressEnabled !== true) router.get("/heartbeat-runs/:runId/issues", (req, res) =>
    handleIssuesForRun(req, res, "Heartbeat run not found"));
  if (rustFoundationBridge?.publicIngressEnabled !== true) router.get("/agent-runs/:runId/issues", (req, res) =>
    handleIssuesForRun(req, res, "Agent run not found"));

  return router;
}
