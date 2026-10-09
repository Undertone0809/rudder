import type { Db } from "@rudderhq/db";
import {
  googleCalendarSyncSchema,
  updateGoogleCalendarOAuthConfigSchema,
} from "@rudderhq/shared";
import { Router, type Request } from "express";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { calendarService } from "../services/calendar.js";
import { calendarNativeRequest, type CalendarNativeBridge } from "../services/calendar-native-bridge.js";
import { RustFoundationBridgeError } from "../services/rust-foundation-bridge.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function redirectUri(req: Request) {
  return `${req.protocol}://${req.get("host")}/api/orgs/${encodeURIComponent(req.params.orgId as string)}/calendar/google/callback`;
}

export function calendarRoutes(db: Db, native?: CalendarNativeBridge) {
  const router = Router();
  const svc = calendarService(db);

  async function nativeRequest(req: Request, res: import("express").Response, body: Record<string, unknown>) {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (!native?.calendar) {
      res.status(503).json({ error: "Rust Calendar is unavailable", code: "rust_foundation_calendar_unavailable" });
      return;
    }
    const actor = getActorInfo(req);
    try {
      const result = await native.calendar(req.actor, orgId, calendarNativeRequest(body, actor.runId ?? null));
      res.status(result.status).setHeader("content-type", result.contentType).send(result.body);
    } catch (error) {
      if (!(error instanceof RustFoundationBridgeError)) throw error;
      res.status(503).json({ error: "Rust Calendar is unavailable", code: "rust_foundation_calendar_unavailable" });
    }
  }

  router.get("/orgs/:orgId/calendar/sources", async (req, res) => {
    await nativeRequest(req, res, { operation: "source.list" });
  });

  router.post("/orgs/:orgId/calendar/sources", async (req, res) => {
    await nativeRequest(req, res, { operation: "source.create", input: req.body });
  });

  router.patch("/orgs/:orgId/calendar/sources/:sourceId", async (req, res) => {
    await nativeRequest(req, res, { operation: "source.update", id: req.params.sourceId as string, input: req.body });
  });

  router.delete("/orgs/:orgId/calendar/sources/:sourceId", async (req, res) => {
    await nativeRequest(req, res, { operation: "source.delete", id: req.params.sourceId as string });
  });

  router.get("/orgs/:orgId/calendar/events", async (req, res) => {
    await nativeRequest(req, res, { operation: "event.list", filters: req.query as Record<string, unknown> });
  });

  router.post("/orgs/:orgId/calendar/events", async (req, res) => {
    await nativeRequest(req, res, { operation: "event.create", input: req.body });
  });

  router.get("/orgs/:orgId/calendar/events/:eventId", async (req, res) => {
    await nativeRequest(req, res, { operation: "event.detail", id: req.params.eventId as string });
  });

  router.patch("/orgs/:orgId/calendar/events/:eventId", async (req, res) => {
    await nativeRequest(req, res, { operation: "event.update", id: req.params.eventId as string, input: req.body });
  });

  router.delete("/orgs/:orgId/calendar/events/:eventId", async (req, res) => {
    await nativeRequest(req, res, { operation: "event.delete", id: req.params.eventId as string });
  });

  router.post("/orgs/:orgId/calendar/google/connect", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const actor = getActorInfo(req);
    const result = await svc.connectGoogle(orgId, redirectUri(req), { userId: actor.actorId });
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar.google_connected",
      entityType: "calendar_source",
      entityId: result.source.id,
      details: { status: result.status, visibilityDefault: result.source.visibilityDefault },
    });
    res.json(result);
  });

  router.get("/orgs/:orgId/calendar/google/config", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    res.json(await svc.getGoogleOAuthConfig(orgId, redirectUri(req)));
  });

  router.patch("/orgs/:orgId/calendar/google/config", validate(updateGoogleCalendarOAuthConfigSchema), async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const actor = getActorInfo(req);
    const config = await svc.updateGoogleOAuthConfig(orgId, req.body, redirectUri(req), { userId: actor.actorId });
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar.google_oauth_config_updated",
      entityType: "calendar_source",
      entityId: orgId,
      details: {
        clientIdConfigured: config.clientId.trim().length > 0,
        clientSecretConfigured: config.clientSecretConfigured,
        cleared: req.body.clear === true,
      },
    });
    res.json(config);
  });

  router.get("/orgs/:orgId/calendar/google/callback", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const actor = getActorInfo(req);
    const code = String(req.query.code ?? "");
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const source = await svc.completeGoogleCallback(orgId, { code, state, redirectUri: redirectUri(req) }, { userId: actor.actorId });
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar.google_authorized",
      entityType: "calendar_source",
      entityId: source.id,
      details: { visibilityDefault: source.visibilityDefault },
    });
    res.redirect(303, "/dashboard/calendar?google=connected");
  });

  router.post("/orgs/:orgId/calendar/google/sync", validate(googleCalendarSyncSchema), async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const actor = getActorInfo(req);
    const result = await svc.syncGoogle(orgId, req.body.sourceId);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar.google_synced",
      entityType: "calendar_source",
      entityId: result.source.id,
      details: { importedCount: result.importedCount, status: result.source.status },
    });
    res.json(result);
  });

  return router;
}
