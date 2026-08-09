import express, { Router } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { registerAgentIssueCreationRoutes } from "../routes/agent-issue-creation.js";
import { sanitizeAgentIssueCreationContextSnapshot } from "../services/agent-issue-creation.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const GOAL_ID = "44444444-4444-4444-8444-444444444444";
const PARENT_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const WAKEUP_ID = "77777777-7777-4777-8777-777777777777";
const RUN_ID = "88888888-8888-4888-8888-888888888888";
const WAKEUP_ATTEMPT_ID = "99999999-9999-4999-8999-999999999999";
const RETRY_WAKEUP_ATTEMPT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const mockService = {
  create: vi.fn(),
  getById: vi.fn(),
  getWakeupByIdempotencyKey: vi.fn(),
  listForRequester: vi.fn(),
  retry: vi.fn(),
  update: vi.fn(),
};
const mockHeartbeat = {
  wakeup: vi.fn(),
  startNextQueuedRunForAgent: vi.fn(),
};
const mockAssertCanAssignTasks = vi.fn(async () => undefined);
const mockLogActivity = vi.fn(async () => undefined);

const baseRequest = {
  id: REQUEST_ID,
  orgId: ORG_ID,
  requestedByUserId: "user-1",
  agentId: AGENT_ID,
  instruction: "Create an issue for the onboarding regression.",
  projectId: PROJECT_ID,
  goalId: GOAL_ID,
  parentId: PARENT_ID,
  contextSnapshot: { organizationId: ORG_ID, source: "new-issue-dialog" },
  idempotencyKey: "request-1",
  wakeupAttempt: 0,
  wakeupAttemptId: WAKEUP_ATTEMPT_ID,
  wakeupRequestId: null,
  runId: null,
  createdIssueId: null,
  status: "queued",
  error: null,
  requestedAt: new Date("2026-08-07T00:00:00.000Z"),
  startedAt: null,
  finishedAt: null,
  createdAt: new Date("2026-08-07T00:00:00.000Z"),
  updatedAt: new Date("2026-08-07T00:00:00.000Z"),
};

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  orgIds: [ORG_ID],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const router = Router();
  registerAgentIssueCreationRoutes({
    router,
    service: mockService as any,
    heartbeat: mockHeartbeat,
    assertCanAssignTasks: mockAssertCanAssignTasks,
    logActivity: mockLogActivity as any,
    db: {} as any,
  });
  app.use("/api", router);
  app.use(errorHandler);
  return app;
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    agentId: AGENT_ID,
    instruction: "Create an issue for the onboarding regression.",
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    parentId: PARENT_ID,
    contextSnapshot: { source: "new-issue-dialog" },
    idempotencyKey: "request-1",
    ...overrides,
  };
}

describe("Agent Issue creation request routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAssertCanAssignTasks.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockHeartbeat.wakeup.mockResolvedValue({ id: RUN_ID, status: "queued", wakeupRequestId: WAKEUP_ID });
    mockHeartbeat.startNextQueuedRunForAgent.mockResolvedValue([]);
    mockService.create.mockResolvedValue({ request: baseRequest, created: true });
    mockService.getWakeupByIdempotencyKey.mockResolvedValue({
      id: WAKEUP_ID,
      status: "queued",
      runId: RUN_ID,
      error: null,
    });
    mockService.update.mockResolvedValue({
      ...baseRequest,
      status: "queued",
      wakeupRequestId: WAKEUP_ID,
      runId: RUN_ID,
    });
    mockService.getById.mockResolvedValue(baseRequest);
    mockService.listForRequester.mockResolvedValue([{ ...baseRequest, status: "failed", error: "Agent did not create an Issue" }]);
    mockService.retry.mockResolvedValue({
      ...baseRequest,
      status: "queued",
      wakeupAttempt: 1,
      wakeupAttemptId: RETRY_WAKEUP_ATTEMPT_ID,
      wakeupRequestId: null,
      runId: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    });
  });

  it("persists and admits a new user request with dedicated wake context", async () => {
    const response = await request(createApp())
      .post(`/api/orgs/${ORG_ID}/agent-issue-creation-requests`)
      .send(body());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ id: REQUEST_ID, status: "queued", runId: RUN_ID });
    expect(mockAssertCanAssignTasks).toHaveBeenCalledWith(expect.anything(), ORG_ID);
    expect(mockLogActivity).toHaveBeenCalledWith({}, expect.objectContaining({
      action: "agent.issue_creation_requested",
      entityId: REQUEST_ID,
    }));
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(AGENT_ID, expect.objectContaining({
      source: "on_demand",
      reason: "agent_issue_creation_requested",
      idempotencyKey: `agent-issue-creation:${REQUEST_ID}:${WAKEUP_ATTEMPT_ID}`,
      startImmediately: false,
      payload: expect.objectContaining({ agentIssueCreationRequestId: REQUEST_ID }),
      contextSnapshot: expect.objectContaining({
        targetType: "agent_issue_creation",
        targetId: REQUEST_ID,
        taskKey: `agent-issue-creation:${REQUEST_ID}`,
        instruction: baseRequest.instruction,
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        goalId: GOAL_ID,
        parentId: PARENT_ID,
      }),
    }));
    expect(mockService.update).toHaveBeenCalledWith(
      ORG_ID,
      REQUEST_ID,
      expect.objectContaining({ status: "queued", wakeupRequestId: WAKEUP_ID, runId: RUN_ID }),
      { expectedStatuses: ["queued"] },
    );
    expect(mockHeartbeat.startNextQueuedRunForAgent).toHaveBeenCalledWith(AGENT_ID);
  });

  it("returns the existing request for an idempotent replay without waking again", async () => {
    mockService.create.mockResolvedValue({
      request: { ...baseRequest, status: "running", runId: RUN_ID },
      created: false,
      needsAdmission: false,
    });

    const response = await request(createApp())
      .post(`/api/orgs/${ORG_ID}/agent-issue-creation-requests`)
      .send(body());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ id: REQUEST_ID, status: "running" });
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("re-admits a queued idempotent replay instead of stranding it", async () => {
    mockService.create.mockResolvedValue({
      request: baseRequest,
      created: false,
      needsAdmission: true,
    });

    const response = await request(createApp())
      .post(`/api/orgs/${ORG_ID}/agent-issue-creation-requests`)
      .send(body());

    expect(response.status).toBe(202);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ idempotencyKey: `agent-issue-creation:${REQUEST_ID}:${WAKEUP_ATTEMPT_ID}` }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith({}, expect.objectContaining({ entityId: REQUEST_ID }));
  });

  it("resets a failed request and admits a fresh wakeup attempt for its requester", async () => {
    const response = await request(createApp())
      .post(`/api/orgs/${ORG_ID}/agent-issue-creation-requests/${REQUEST_ID}/retry`)
      .send({});

    expect(response.status).toBe(202);
    expect(mockService.retry).toHaveBeenCalledWith(ORG_ID, REQUEST_ID, "user-1");
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(AGENT_ID, expect.objectContaining({
      idempotencyKey: `agent-issue-creation:${REQUEST_ID}:${RETRY_WAKEUP_ATTEMPT_ID}`,
      startImmediately: false,
    }));
    expect(mockHeartbeat.startNextQueuedRunForAgent).toHaveBeenCalledWith(AGENT_ID);
    expect(mockLogActivity).toHaveBeenCalledWith({}, expect.objectContaining({
      action: "agent.issue_creation_retry_requested",
      entityId: REQUEST_ID,
    }));
  });

  it("strips runtime-owned fields from user-supplied context metadata", () => {
    expect(sanitizeAgentIssueCreationContextSnapshot({
      source: "new-issue-dialog",
      safeMetadata: { surface: "issues" },
      organizationId: "attacker-org",
      projectId: "attacker-project",
      wakeReason: "issue_comment_mentioned",
      rudderScene: "review",
      agentIssueCreationRequest: { id: "attacker-request" },
    })).toEqual({
      source: "new-issue-dialog",
      safeMetadata: { surface: "issues" },
    });
  });

  it("accepts a paused Agent wake as deferred work", async () => {
    mockHeartbeat.wakeup.mockResolvedValue(null);
    mockService.getWakeupByIdempotencyKey.mockResolvedValue({
      id: WAKEUP_ID,
      status: "deferred_agent_paused",
      runId: null,
      error: null,
    });
    mockService.update.mockResolvedValue({ ...baseRequest, status: "deferred", wakeupRequestId: WAKEUP_ID });

    const response = await request(createApp())
      .post(`/api/orgs/${ORG_ID}/agent-issue-creation-requests`)
      .send(body());

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ id: REQUEST_ID, status: "deferred", wakeupRequestId: WAKEUP_ID });
  });

  it("rejects agent callers and users outside the organization", async () => {
    const agentResponse = await request(createApp({
      type: "agent",
      agentId: AGENT_ID,
      orgId: ORG_ID,
    }))
      .post(`/api/orgs/${ORG_ID}/agent-issue-creation-requests`)
      .send(body());
    expect(agentResponse.status).toBe(403);

    const crossOrgResponse = await request(createApp({
      type: "board",
      userId: "user-1",
      orgIds: ["99999999-9999-4999-8999-999999999999"],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post(`/api/orgs/${ORG_ID}/agent-issue-creation-requests`)
      .send(body());
    expect(crossOrgResponse.status).toBe(403);
    expect(mockService.create).not.toHaveBeenCalled();
  });

  it("only exposes a request to its originating user", async () => {
    const response = await request(createApp())
      .get(`/api/orgs/${ORG_ID}/agent-issue-creation-requests/${REQUEST_ID}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: REQUEST_ID, requestedByUserId: "user-1" });

    const otherUserResponse = await request(createApp({
      type: "board",
      userId: "user-2",
      orgIds: [ORG_ID],
      source: "session",
      isInstanceAdmin: false,
    }))
      .get(`/api/orgs/${ORG_ID}/agent-issue-creation-requests/${REQUEST_ID}`);

    expect(otherUserResponse.status).toBe(404);
  });

  it("lists only the requesting user's terminal failures", async () => {
    const response = await request(createApp())
      .get(`/api/orgs/${ORG_ID}/agent-issue-creation-requests`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject([{ id: REQUEST_ID, status: "failed" }]);
    expect(mockService.listForRequester).toHaveBeenCalledWith(ORG_ID, "user-1");
  });

  it("keeps an admitted request recoverable when linkage persistence fails after wakeup", async () => {
    mockService.update.mockRejectedValueOnce(new Error("request linkage unavailable"));

    const response = await request(createApp())
      .post(`/api/orgs/${ORG_ID}/agent-issue-creation-requests`)
      .send(body());

    expect(response.status).toBe(500);
    expect(mockService.update).toHaveBeenLastCalledWith(
      ORG_ID,
      REQUEST_ID,
      expect.objectContaining({
        status: "queued",
        wakeupRequestId: WAKEUP_ID,
        runId: RUN_ID,
        error: null,
      }),
      { expectedStatuses: ["queued", "deferred", "running"] },
    );
    expect(mockService.update.mock.calls.some((call) => call[2]?.status === "failed")).toBe(false);
  });

  it("persists a failed request when wakeup admission throws", async () => {
    mockHeartbeat.wakeup.mockRejectedValue(new Error("wake service unavailable"));

    const response = await request(createApp())
      .post(`/api/orgs/${ORG_ID}/agent-issue-creation-requests`)
      .send(body());

    expect(response.status).toBe(500);
    expect(mockService.update).toHaveBeenLastCalledWith(
      ORG_ID,
      REQUEST_ID,
      expect.objectContaining({ status: "failed", error: "wake service unavailable" }),
      { expectedStatuses: ["queued", "deferred"] },
    );
  });

  it("persists a failed request when the initial activity cannot be written", async () => {
    mockLogActivity.mockRejectedValueOnce(new Error("activity store unavailable"));

    const response = await request(createApp())
      .post(`/api/orgs/${ORG_ID}/agent-issue-creation-requests`)
      .send(body());

    expect(response.status).toBe(500);
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
    expect(mockService.update).toHaveBeenLastCalledWith(
      ORG_ID,
      REQUEST_ID,
      expect.objectContaining({ status: "failed", error: "activity store unavailable" }),
      { expectedStatuses: ["queued", "deferred"] },
    );
  });
});
