import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const orgId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const automationId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const otherAgentId = "55555555-5555-4555-8555-555555555555";

const automation = {
  id: automationId,
  orgId,
  projectId,
  goalId: null,
  parentIssueId: null,
  title: "Daily automation",
  description: null,
  assigneeAgentId: agentId,
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: null,
  lastEnqueuedAt: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};
const pausedAutomation = {
  ...automation,
  status: "paused",
};
const trigger = {
  id: "66666666-6666-4666-8666-666666666666",
  orgId,
  automationId,
  kind: "schedule",
  label: "weekday",
  enabled: false,
  cronExpression: "0 10 * * 1-5",
  timezone: "UTC",
  nextRunAt: null,
  lastFiredAt: null,
  publicId: null,
  secretId: null,
  signingMode: null,
  replayWindowSec: null,
  lastRotatedAt: null,
  lastResult: null,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

const mockAutomationService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  getDetail: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  listRuns: vi.fn(),
  createTrigger: vi.fn(),
  getTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  rotateTriggerSecret: vi.fn(),
  runAutomation: vi.fn(),
  firePublicTrigger: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

async function createApp(actor: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    logActivity: mockLogActivity,
    automationService: () => mockAutomationService,
  }));
  const { automationRoutes } = await import("../routes/automations.js");
  const { errorHandler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", automationRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("automation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAutomationService.create.mockResolvedValue(automation);
    mockAutomationService.get.mockResolvedValue(automation);
    mockAutomationService.getTrigger.mockResolvedValue(trigger);
    mockAutomationService.update.mockResolvedValue({ ...automation, assigneeAgentId: otherAgentId });
    mockAutomationService.runAutomation.mockResolvedValue({
      id: "run-1",
      source: "manual",
      status: "issue_created",
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("requires tasks:assign permission for non-admin board automation creation", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    });

    const res = await request(app)
      .post(`/api/orgs/${orgId}/automations`)
      .send({
        projectId,
        title: "Daily automation",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockAutomationService.create).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to retarget an automation assignee", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    });

    const res = await request(app)
      .patch(`/api/automations/${automationId}`)
      .send({
        assigneeAgentId: otherAgentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockAutomationService.update).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to reactivate an automation", async () => {
    mockAutomationService.get.mockResolvedValue(pausedAutomation);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    });

    const res = await request(app)
      .patch(`/api/automations/${automationId}`)
      .send({
        status: "active",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockAutomationService.update).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to create a trigger", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    });

    const res = await request(app)
      .post(`/api/automations/${automationId}/triggers`)
      .send({
        kind: "schedule",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockAutomationService.createTrigger).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to update a trigger", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    });

    const res = await request(app)
      .patch(`/api/automation-triggers/${trigger.id}`)
      .send({
        enabled: true,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockAutomationService.updateTrigger).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to manually run an automation", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    });

    const res = await request(app)
      .post(`/api/automations/${automationId}/run`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockAutomationService.runAutomation).not.toHaveBeenCalled();
  });

  it("allows automation creation when the board user has tasks:assign", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    });

    const res = await request(app)
      .post(`/api/orgs/${orgId}/automations`)
      .send({
        projectId,
        title: "Daily automation",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(201);
    expect(mockAutomationService.create).toHaveBeenCalledWith(orgId, expect.objectContaining({
      projectId,
      title: "Daily automation",
      assigneeAgentId: agentId,
    }), {
      agentId: null,
      userId: "board-user",
    });
  });
});
