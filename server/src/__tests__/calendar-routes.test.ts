import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { calendarRoutes } from "../routes/calendar.js";

const mockCalendarService = vi.hoisted(() => ({
  listSources: vi.fn(),
  createSource: vi.fn(),
  updateSource: vi.fn(),
  deleteSource: vi.fn(),
  listEvents: vi.fn(),
  getEvent: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  connectGoogle: vi.fn(),
  completeGoogleCallback: vi.fn(),
  syncGoogle: vi.fn(),
  eventSummary: vi.fn((event: { title: string; eventStatus: string }) => ({
    title: event.title,
    eventStatus: event.eventStatus,
  })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/calendar.js", () => ({
  calendarService: () => mockCalendarService,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

const ORG_ID = "organization-1";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "33333333-3333-4333-8333-333333333333";

function createBoardActor() {
  return {
    type: "board" as const,
    userId: "local-board",
    orgIds: [ORG_ID],
    source: "local_implicit" as const,
    isInstanceAdmin: false,
  };
}

function createAgentActor() {
  return {
    type: "agent" as const,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    orgIds: [ORG_ID],
    runId: "run-1",
  };
}

function createApp(actor = createBoardActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", calendarRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeCalendarEvent() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: ORG_ID,
    sourceId: null,
    eventKind: "agent_work_block",
    eventStatus: "planned",
    ownerType: "agent",
    ownerUserId: null,
    ownerAgentId: AGENT_ID,
    title: "CEO · Review pricing issue",
    description: null,
    startAt: new Date("2026-04-30T10:00:00.000Z"),
    endAt: new Date("2026-04-30T11:00:00.000Z"),
    timezone: "UTC",
    allDay: false,
    visibility: "full",
    issueId: ISSUE_ID,
    projectId: null,
    goalId: null,
    approvalId: null,
    heartbeatRunId: null,
    activityId: null,
    sourceMode: "manual",
    externalProvider: null,
    externalCalendarId: null,
    externalEventId: null,
    externalEtag: null,
    externalUpdatedAt: null,
    createdByUserId: "local-board",
    updatedByUserId: "local-board",
    createdAt: new Date("2026-04-30T09:00:00.000Z"),
    updatedAt: new Date("2026-04-30T09:00:00.000Z"),
    deletedAt: null,
  };
}

function createEventPayload() {
  return {
    eventKind: "agent_work_block",
    eventStatus: "planned",
    ownerType: "agent",
    ownerAgentId: AGENT_ID,
    title: "CEO · Review pricing issue",
    startAt: "2026-04-30T10:00:00.000Z",
    endAt: "2026-04-30T11:00:00.000Z",
    timezone: "UTC",
    allDay: false,
    visibility: "full",
    issueId: ISSUE_ID,
    sourceMode: "manual",
  };
}

describe("calendar routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCalendarService.listSources.mockResolvedValue([]);
    mockCalendarService.listEvents.mockResolvedValue([]);
  });

  it("creates planned agent work blocks as board-only calendar annotations and logs activity", async () => {
    const created = makeCalendarEvent();
    mockCalendarService.createEvent.mockResolvedValue(created);

    const res = await request(createApp())
      .post(`/api/orgs/${ORG_ID}/calendar/events`)
      .send(createEventPayload());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: created.id,
      eventKind: "agent_work_block",
      eventStatus: "planned",
      ownerAgentId: AGENT_ID,
      issueId: ISSUE_ID,
      sourceMode: "manual",
    });
    expect(mockCalendarService.createEvent).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({
        eventKind: "agent_work_block",
        eventStatus: "planned",
        ownerAgentId: AGENT_ID,
        issueId: ISSUE_ID,
      }),
      { userId: "local-board" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        actorType: "user",
        actorId: "local-board",
        action: "calendar.event_created",
        entityType: "calendar_event",
        entityId: created.id,
      }),
    );
  });

  it("rejects agent keys for calendar reads", async () => {
    const res = await request(createApp(createAgentActor()))
      .get(`/api/orgs/${ORG_ID}/calendar/events`)
      .query({
        start: "2026-04-30T00:00:00.000Z",
        end: "2026-05-01T00:00:00.000Z",
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Board access required" });
    expect(mockCalendarService.listEvents).not.toHaveBeenCalled();
  });

  it("rejects agent keys for calendar mutations", async () => {
    const res = await request(createApp(createAgentActor()))
      .post(`/api/orgs/${ORG_ID}/calendar/events`)
      .send(createEventPayload());

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Board access required" });
    expect(mockCalendarService.createEvent).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
