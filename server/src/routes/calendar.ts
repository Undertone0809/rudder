import { Router, type Request } from "express";
import type { Db } from "@rudderhq/db";
import {
  calendarEventListQuerySchema,
  createCalendarEventSchema,
  createCalendarSourceSchema,
  googleCalendarSyncSchema,
  updateCalendarEventSchema,
  updateCalendarSourceSchema,
} from "@rudderhq/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { calendarService, type CalendarEventFilters } from "../services/calendar.js";
import { logActivity } from "../services/activity-log.js";

function csv(value: string | undefined) {
  return value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function redirectUri(req: Request) {
  return `${req.protocol}://${req.get("host")}/api/orgs/${encodeURIComponent(req.params.orgId as string)}/calendar/google/callback`;
}

export function calendarRoutes(db: Db) {
  const router = Router();
  const svc = calendarService(db);

  router.get("/orgs/:orgId/calendar/sources", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    res.json(await svc.listSources(orgId));
  });

  router.post("/orgs/:orgId/calendar/sources", validate(createCalendarSourceSchema), async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const actor = getActorInfo(req);
    const source = await svc.createSource(orgId, req.body, { userId: actor.actorId });
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar.source_created",
      entityType: "calendar_source",
      entityId: source.id,
      details: { name: source.name, type: source.type, visibilityDefault: source.visibilityDefault },
    });
    res.status(201).json(source);
  });

  router.patch("/orgs/:orgId/calendar/sources/:sourceId", validate(updateCalendarSourceSchema), async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const actor = getActorInfo(req);
    const source = await svc.updateSource(orgId, req.params.sourceId as string, req.body, { userId: actor.actorId });
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar.source_updated",
      entityType: "calendar_source",
      entityId: source.id,
      details: { name: source.name, status: source.status, visibilityDefault: source.visibilityDefault },
    });
    res.json(source);
  });

  router.delete("/orgs/:orgId/calendar/sources/:sourceId", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const actor = getActorInfo(req);
    await svc.deleteSource(orgId, req.params.sourceId as string);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar.source_deleted",
      entityType: "calendar_source",
      entityId: req.params.sourceId as string,
    });
    res.json({ ok: true });
  });

  router.get("/orgs/:orgId/calendar/events", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const parsed = calendarEventListQuerySchema.parse(req.query);
    const filters: CalendarEventFilters = {
      start: parsed.start,
      end: parsed.end,
      agentIds: csv(parsed.agentIds),
      sourceIds: csv(parsed.sourceIds),
      eventKinds: csv(parsed.eventKinds),
      statuses: csv(parsed.statuses),
    };
    res.json({ events: await svc.listEvents(orgId, filters) });
  });

  router.post("/orgs/:orgId/calendar/events", validate(createCalendarEventSchema), async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const actor = getActorInfo(req);
    const event = await svc.createEvent(orgId, req.body, { userId: actor.actorId });
    if (!event) {
      res.status(500).json({ error: "Calendar event was not created" });
      return;
    }
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar.event_created",
      entityType: "calendar_event",
      entityId: event.id,
      details: svc.eventSummary(event),
    });
    res.status(201).json(event);
  });

  router.get("/orgs/:orgId/calendar/events/:eventId", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const event = await svc.getEvent(orgId, req.params.eventId as string);
    if (!event) {
      res.status(404).json({ error: "Calendar event not found" });
      return;
    }
    res.json(event);
  });

  router.patch("/orgs/:orgId/calendar/events/:eventId", validate(updateCalendarEventSchema), async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const actor = getActorInfo(req);
    const { previous, event } = await svc.updateEvent(orgId, req.params.eventId as string, req.body, { userId: actor.actorId });
    if (!event) {
      res.status(500).json({ error: "Calendar event was not updated" });
      return;
    }
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar.event_updated",
      entityType: "calendar_event",
      entityId: event.id,
      details: {
        previous: svc.eventSummary(previous),
        current: svc.eventSummary(event),
      },
    });
    res.json(event);
  });

  router.delete("/orgs/:orgId/calendar/events/:eventId", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const actor = getActorInfo(req);
    const deleted = await svc.deleteEvent(orgId, req.params.eventId as string, { userId: actor.actorId });
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "calendar.event_deleted",
      entityType: "calendar_event",
      entityId: deleted.id,
      details: svc.eventSummary(deleted),
    });
    res.json({ ok: true });
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
    res.redirect(303, "/calendar?google=connected");
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
