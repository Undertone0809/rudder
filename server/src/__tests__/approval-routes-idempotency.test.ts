import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { approvalRoutes } from "../routes/approvals.js";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockChatService = vi.hoisted(() => ({
  getById: vi.fn(),
  applyApprovedApproval: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  update: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  approvalService: () => mockApprovalService,
  chatService: () => mockChatService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  orgIds: ["organization-1"],
  source: "session",
  isInstanceAdmin: false,
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("approval routes idempotent retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    mockChatService.getById.mockResolvedValue({ id: "chat-1", orgId: "organization-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "hire_agent",
      status: "approved",
      payload: {},
      requestedByAgentId: "agent-1",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        orgId: "organization-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "hire_agent",
      status: "rejected",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        orgId: "organization-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: false,
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects approval decisions outside the board member's organization scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-2",
      orgId: "organization-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    const app = createApp();

    const approveRes = await request(app).post("/api/approvals/approval-2/approve").send({});
    const rejectRes = await request(app).post("/api/approvals/approval-2/reject").send({});
    const revisionRes = await request(app).post("/api/approvals/approval-2/request-revision").send({});

    expect([approveRes.status, rejectRes.status, revisionRes.status]).toEqual([403, 403, 403]);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
    expect(mockApprovalService.reject).not.toHaveBeenCalled();
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("binds an agent-created approval to the authenticated requesting agent", async () => {
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockImplementation(async (_orgId, payload) => payload);
    mockApprovalService.create.mockImplementation(async (orgId, input) => ({
      id: "approval-1",
      orgId,
      ...input,
    }));
    mockIssueApprovalService.linkManyForApproval.mockResolvedValue([]);

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-authenticated",
      orgId: "organization-1",
      runId: "run-1",
    }))
      .post("/api/orgs/organization-1/approvals")
      .send({
        type: "hire_agent",
        requestedByAgentId: "00000000-0000-4000-8000-000000000002",
        payload: {},
      });

    expect(res.status).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({ requestedByAgentId: "agent-authenticated" }),
    );
  });

  it("requires instance-admin authority to approve a hire with host commands", async () => {
    const pendingApproval = {
      id: "approval-1",
      orgId: "organization-1",
      type: "hire_agent",
      status: "pending",
      payload: {
        agentId: "agent-1",
        name: "Configured Agent",
        agentRuntimeConfig: {
          workspaceRuntime: {
            services: [{ name: "host-command", command: "touch /tmp/rudder-approval-rce" }],
          },
        },
      },
    };
    mockApprovalService.getById.mockResolvedValue(pendingApproval);
    mockApprovalService.approve.mockResolvedValue({
      approval: { ...pendingApproval, status: "approved", requestedByAgentId: null },
      applied: false,
    });

    const memberRes = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});
    expect(memberRes.status).toBe(403);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();

    const adminRes = await request(createApp({
      type: "board",
      userId: "instance-admin",
      orgIds: [],
      source: "session",
      isInstanceAdmin: true,
    }))
      .post("/api/approvals/approval-1/approve")
      .send({});
    expect(adminRes.status, JSON.stringify(adminRes.body)).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalled();
  });

  it("requires instance-admin authority for non-process and persisted non-empty hire runtimes", async () => {
    mockApprovalService.getById.mockResolvedValueOnce({
      id: "approval-1",
      orgId: "organization-1",
      type: "hire_agent",
      status: "pending",
      payload: {
        requestedConfigurationSnapshot: {
          agentRuntimeType: "codex_local",
          agentRuntimeConfig: {},
          runtimeConfig: {},
        },
      },
    });
    const snapshotRes = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});
    expect(snapshotRes.status).toBe(403);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();

    mockApprovalService.getById.mockResolvedValueOnce({
      id: "approval-2",
      orgId: "organization-1",
      type: "hire_agent",
      status: "pending",
      payload: {
        agentId: "agent-2",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
        runtimeConfig: {},
      },
    });
    mockAgentService.getById.mockResolvedValueOnce({
      id: "agent-2",
      orgId: "organization-1",
      name: "Persisted Agent",
      agentRuntimeType: "process",
      agentRuntimeConfig: { model: "persisted-runtime-config" },
      runtimeConfig: {},
    });
    const persistedRes = await request(createApp())
      .post("/api/approvals/approval-2/approve")
      .send({});
    expect(persistedRes.status).toBe(403);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects a hire approval that targets an agent in another organization", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "hire_agent",
      status: "pending",
      payload: { agentId: "agent-2" },
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-2",
      orgId: "organization-2",
      name: "Other Organization Agent",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("approval organization");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects a chat approval that points at another organization's conversation", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "chat_operation",
      status: "pending",
      payload: {
        chatConversationId: "chat-2",
        operationProposal: {
          targetType: "organization",
          targetId: "organization-1",
          summary: "Rename organization",
          patch: { name: "Updated" },
        },
      },
    });
    mockChatService.getById.mockResolvedValue({ id: "chat-2", orgId: "organization-2" });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("approval organization");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects chat operation patches containing database identity fields before approval", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "chat_operation",
      status: "pending",
      payload: {
        chatConversationId: "chat-1",
        operationProposal: {
          targetType: "agent",
          targetId: "agent-1",
          summary: "Malicious identity rewrite",
          patch: {
            id: "attacker-controlled-id",
            orgId: "organization-2",
            name: "Compromised Agent",
          },
        },
      },
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(422);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("requires instance-admin authority for chat operation agent runtime patches", async () => {
    const pendingApproval = {
      id: "approval-1",
      orgId: "organization-1",
      type: "chat_operation",
      status: "pending",
      payload: {
        chatConversationId: "chat-1",
        operationProposal: {
          targetType: "agent",
          targetId: "agent-1",
          summary: "Change runtime",
          patch: {
            agentRuntimeConfig: {
              workspaceRuntime: {
                services: [{ name: "host-command", command: "touch /tmp/rudder-chat-rce" }],
              },
            },
          },
        },
      },
      requestedByAgentId: null,
    };
    mockApprovalService.getById.mockResolvedValue(pendingApproval);
    mockApprovalService.approve.mockResolvedValue({
      approval: { ...pendingApproval, status: "approved" },
      applied: false,
    });

    const memberRes = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});
    expect(memberRes.status).toBe(403);
    expect(mockApprovalService.approve).not.toHaveBeenCalled();

    const adminRes = await request(createApp({
      type: "board",
      userId: "instance-admin",
      orgIds: [],
      source: "session",
      isInstanceAdmin: true,
    }))
      .post("/api/approvals/approval-1/approve")
      .send({});
    expect(adminRes.status, JSON.stringify(adminRes.body)).toBe(200);
  });

  it("ignores spoofed decision user ids and records the authenticated board user", async () => {
    const pendingApproval = {
      id: "approval-1",
      orgId: "organization-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    };
    mockApprovalService.getById.mockResolvedValue(pendingApproval);
    mockApprovalService.approve.mockResolvedValue({
      approval: { ...pendingApproval, status: "approved" },
      applied: false,
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: { ...pendingApproval, status: "rejected" },
      applied: false,
    });
    mockApprovalService.requestRevision.mockResolvedValue({
      ...pendingApproval,
      status: "revision_requested",
    });
    const app = createApp();

    await request(app)
      .post("/api/approvals/approval-1/approve")
      .send({ decidedByUserId: "spoofed-user" });
    await request(app)
      .post("/api/approvals/approval-1/reject")
      .send({ decidedByUserId: "spoofed-user" });
    await request(app)
      .post("/api/approvals/approval-1/request-revision")
      .send({ decidedByUserId: "spoofed-user" });

    expect(mockApprovalService.approve).toHaveBeenCalledWith(
      "approval-1",
      "user-1",
      undefined,
      undefined,
    );
    expect(mockApprovalService.reject).toHaveBeenCalledWith("approval-1", "user-1", undefined);
    expect(mockApprovalService.requestRevision).toHaveBeenCalledWith("approval-1", "user-1", undefined);
  });
});
