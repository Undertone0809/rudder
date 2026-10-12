import type { Db } from "@rudderhq/db";
import { cancelAssistanceRequestSchema, listRequestsQuerySchema, resolveAssistanceRequestSchema } from "@rudderhq/shared";
import { Router } from "express";
import { validate } from "../middleware/validate.js";
import { redactApprovalPayload } from "../redaction.js";
import { heartbeatService, requestService } from "../services/index.js";
import { sendRequestRead } from "../services/request-read-bridge.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function requestRoutes(db: Db, rustFoundationBridge?: RustFoundationBridge) {
  const router = Router();
  const svc = requestService(db);
  const heartbeat = heartbeatService(db);

  router.get("/orgs/:orgId/requests", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const query = listRequestsQuerySchema.parse(req.query);
    const result = await svc.list(orgId, query);
    res.json(result.map((request) => request.kind === "approval"
      ? redactApprovalPayload(request as typeof request & { payload: Record<string, unknown> })
      : request));
  });

  router.get("/requests/:id", async (req, res) => {
    const request = await svc.readIdentity(req.params.id as string);
    if (!request) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    assertCompanyAccess(req, request.orgId as string);
    await sendRequestRead(res, rustFoundationBridge, req.actor, request.orgId, { operation: "detail", requestId: request.id }, db);
  });

  router.get("/requests/:id/block-audit-attempts", async (req, res) => {
    const request = await svc.readIdentity(req.params.id as string);
    if (!request) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    assertCompanyAccess(req, request.orgId as string);
    await sendRequestRead(res, rustFoundationBridge, req.actor, request.orgId, { operation: "block-audit-attempts", requestId: request.id }, db);
  });

  router.post(
    "/requests/:id/resolve",
    validate(resolveAssistanceRequestSchema),
    async (req, res) => {
      const existing = await svc.getById(req.params.id as string);
      if (!existing) {
        res.status(404).json({ error: "Request not found" });
        return;
      }
      assertCompanyAccess(req, existing.orgId as string);
      const actor = getActorInfo(req);
      if (actor.actorType !== "user") {
        res.status(403).json({ error: "Only a human operator can resolve an Assistance Request" });
        return;
      }

      const result = await svc.resolveAssistance({
        id: existing.id as string,
        resolution: req.body.resolution,
        response: req.body.response,
        resolvedByUserId: actor.actorId,
      });
      let wakeRun = null;
      if (result.wakeAgentId && result.wakeupRequestId && result.issue) {
        wakeRun = await heartbeat.wakeup(result.wakeAgentId, {
          source: "assignment",
          triggerDetail: "user",
          reason: "assistance_request_resolved",
          idempotencyKey: `assistance-request:${existing.id}:resolved`,
          existingWakeupRequestId: result.wakeupRequestId,
          payload: {
            requestId: existing.id,
            issueId: result.issue.id,
            resolution: req.body.resolution,
            expectedAssigneeAgentId: result.wakeAgentId,
            expectedIssueStatus: result.issue.status,
          },
          requestedByActorType: "user",
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            source: "request.resolved",
            requestId: existing.id,
            requestKind: "assistance",
            requestResolution: req.body.resolution,
            requestResponse: result.request.response,
            issueId: result.issue.id,
            taskId: result.issue.id,
            wakeSource: "assignment",
            wakeReason: "assistance_request_resolved",
            issue: {
              id: result.issue.id,
              title: result.issue.title,
              description: result.issue.description,
              status: result.issue.status,
              priority: result.issue.priority,
            },
          },
        });
      }
      res.json({ ...result.request, wakeRunId: wakeRun?.id ?? null });
    },
  );

  router.post(
    "/requests/:id/cancel",
    validate(cancelAssistanceRequestSchema),
    async (req, res) => {
      const existing = await svc.getById(req.params.id as string);
      if (!existing) {
        res.status(404).json({ error: "Request not found" });
        return;
      }
      assertCompanyAccess(req, existing.orgId as string);
      const actor = getActorInfo(req);
      if (actor.actorType !== "user") {
        res.status(403).json({ error: "Only a human operator can cancel an Assistance Request" });
        return;
      }
      const result = await svc.cancelAssistance({
        id: existing.id as string,
        reason: req.body.reason,
        cancelledByUserId: actor.actorId,
      });
      res.json(result.request);
    },
  );

  return router;
}
