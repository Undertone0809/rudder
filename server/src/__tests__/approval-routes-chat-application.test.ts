import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";

const mockWithExecutionObservation = vi.hoisted(() => vi.fn(async (_context, _input, fn) => fn(null)));
const mockObserveExecutionEvent = vi.hoisted(() => vi.fn().mockResolvedValue(null));

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

const mockChatService = vi.hoisted(() => ({
  applyApprovedApproval: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
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
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

vi.mock("../langfuse.js", () => ({
  withExecutionObservation: mockWithExecutionObservation,
  observeExecutionEvent: mockObserveExecutionEvent,
}));

function createApp(db: any = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      orgIds: ["organization-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("approval routes chat application", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue(null);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueService.update.mockResolvedValue(null);
    mockChatService.applyApprovedApproval.mockResolvedValue(null);
    mockAccessService.canUser.mockResolvedValue(true);
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "chat_issue_creation",
      status: "pending",
      payload: { chatConversationId: "chat-1" },
    });
  });

  it("applies chat approval side effects when a chat issue proposal is approved", async () => {
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        orgId: "organization-1",
        type: "chat_issue_creation",
        status: "approved",
        payload: { chatConversationId: "chat-1" },
        requestedByAgentId: null,
      },
      applied: true,
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({ decisionNote: "Looks good" });

    expect(res.status).toBe(200);
    expect(mockChatService.applyApprovedApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "approval-1",
        type: "chat_issue_creation",
      }),
      "user-1",
    );
    expect(mockWithExecutionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chat_action",
        rootExecutionId: "approval-1",
        trigger: "approval_apply",
        status: "approved",
      }),
      expect.objectContaining({
        name: "chat:approval_apply",
        asType: "tool",
      }),
      expect.any(Function),
    );
    expect(mockObserveExecutionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chat_action",
        rootExecutionId: "approval-1",
      }),
      expect.objectContaining({
        name: "chat.approval.applied",
      }),
    );
  });

  it("reactivates blocked linked issues and wakes their assignee after approval is applied", async () => {
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      {
        id: "issue-1",
        status: "blocked",
        assigneeAgentId: "agent-assignee",
        assigneeUserId: null,
        title: "Create follow-up agent",
        description: "Waiting for board approval.",
        priority: "medium",
      },
    ]);
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      identifier: "RUD-1",
      status: "in_progress",
      assigneeAgentId: "agent-assignee",
      title: "Create follow-up agent",
      description: "Waiting for board approval.",
      priority: "medium",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        orgId: "organization-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-requester",
      },
      applied: true,
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({ decisionNote: "Approved" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("issue-1", { status: "in_progress" });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        details: expect.objectContaining({
          status: "in_progress",
          source: "approval.approved",
          approvalId: "approval-1",
          _previous: { status: "blocked" },
        }),
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-assignee",
      expect.objectContaining({
        source: "assignment",
        triggerDetail: "system",
        reason: "approval_approved",
        payload: expect.objectContaining({
          approvalId: "approval-1",
          issueId: "issue-1",
          mutation: "approval_approved",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: "issue-1",
          taskId: "issue-1",
          wakeSource: "assignment",
          wakeReason: "approval_approved",
          issue: expect.objectContaining({
            status: "in_progress",
          }),
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.approved",
        details: expect.objectContaining({
          linkedIssueIds: ["issue-1"],
          reactivatedLinkedIssueIds: ["issue-1"],
        }),
      }),
    );
  });

  it("requires task assignment permission before approving reviewer-bearing chat issue proposals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "chat_issue_creation",
      status: "pending",
      payload: {
        chatConversationId: "chat-1",
        proposedIssue: {
          title: "Reviewed work",
          description: "Needs a reviewer.",
          reviewerAgentId: "10000000-0000-4000-8000-000000000077",
        },
      },
    });
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({ decisionNote: "Looks good" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
    expect(mockChatService.applyApprovedApproval).not.toHaveBeenCalled();
  });

  it("requires labels before approving agent-proposed chat issues once the label taxonomy is mature", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "chat_issue_creation",
      status: "pending",
      payload: {
        chatConversationId: "chat-1",
        proposedByAgentId: "agent-1",
        proposedIssue: {
          title: "Needs label",
          description: "Agent proposed this issue from chat.",
        },
      },
    });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ count: 5 }]),
        })),
      })),
    };

    const res = await request(createApp(db))
      .post("/api/approvals/approval-1/approve")
      .send({ decisionNote: "Looks good" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "agent_issue_label_required",
      labelCount: 5,
    });
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
    expect(mockChatService.applyApprovedApproval).not.toHaveBeenCalled();
  });

  it("approves agent-proposed chat issues with operator-selected labels from the approve request", async () => {
    const payload = {
      chatConversationId: "chat-1",
      proposedByAgentId: "agent-1",
      proposedIssue: {
        title: "Needs label",
        description: "Agent proposed this issue from chat.",
        labelIds: ["label-1"],
      },
    };
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "chat_issue_creation",
      status: "pending",
      payload: {
        chatConversationId: "chat-1",
        proposedByAgentId: "agent-1",
        proposedIssue: {
          title: "Needs label",
          description: "Agent proposed this issue from chat.",
        },
      },
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        orgId: "organization-1",
        type: "chat_issue_creation",
        status: "approved",
        payload,
        requestedByAgentId: null,
      },
      applied: true,
    });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ id: "label-1" }]),
        })),
      })),
    };

    const res = await request(createApp(db))
      .post("/api/approvals/approval-1/approve")
      .send({ payload });

    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalledWith(
      "approval-1",
      "board",
      undefined,
      payload,
    );
    expect(mockChatService.applyApprovedApproval).toHaveBeenCalledWith(
      expect.objectContaining({ payload }),
      "user-1",
    );
  });

  it("wakes the requester agent with linked issue context after approval is applied", async () => {
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }, { id: "issue-2" }]);
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        orgId: "organization-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: true,
    });

    const res = await request(createApp())
      .post("/api/approvals/approval-1/approve")
      .send({ decisionNote: "Ship it" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-1",
      {
        source: "automation",
        triggerDetail: "system",
        reason: "approval_approved",
        payload: {
          approvalId: "approval-1",
          approvalStatus: "approved",
          issueId: "issue-1",
          issueIds: ["issue-1", "issue-2"],
        },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
        contextSnapshot: {
          source: "approval.approved",
          approvalId: "approval-1",
          approvalStatus: "approved",
          issueId: "issue-1",
          issueIds: ["issue-1", "issue-2"],
          taskId: "issue-1",
          wakeReason: "approval_approved",
        },
      },
    );
    expect(mockLogActivity).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        action: "approval.requester_wakeup_queued",
        entityId: "approval-1",
        details: expect.objectContaining({
          requesterAgentId: "agent-1",
          wakeRunId: "wake-1",
          linkedIssueIds: ["issue-1", "issue-2"],
        }),
      }),
    );
  });
});
