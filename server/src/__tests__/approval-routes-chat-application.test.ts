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

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  chatService: () => mockChatService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
}));

vi.mock("../langfuse.js", () => ({
  withExecutionObservation: mockWithExecutionObservation,
  observeExecutionEvent: mockObserveExecutionEvent,
}));

function createApp() {
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
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("approval routes chat application", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue(null);
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
    mockChatService.applyApprovedApproval.mockResolvedValue(null);
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
