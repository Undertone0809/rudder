import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderTemplate, selectPromptTemplate } from "@rudderhq/agent-runtime-utils/server-utils";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  checkout: vi.fn(),
  create: vi.fn(),
  findMentionedAgents: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  reportRunActivity: vi.fn(async () => undefined),
  wakeup: vi.fn(async () => undefined),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const ASSIGNEE_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "run-1";

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  automationService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createBoardActor() {
  return {
    type: "board" as const,
    userId: "local-board",
    orgIds: ["organization-1"],
    source: "local_implicit" as const,
    isInstanceAdmin: false,
  };
}

function createAgentActor() {
  return {
    type: "agent" as const,
    agentId: ASSIGNEE_AGENT_ID,
    orgId: "organization-1",
    orgIds: ["organization-1"],
    runId: RUN_ID,
  };
}

function createApp(actor = createBoardActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides?: Partial<{
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByUserId: string | null;
  executionRunId: string | null;
  identifier: string;
  projectId: string | null;
  status: "backlog" | "todo" | "in_progress" | "done";
  title: string;
}>) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "organization-1",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "local-board",
    executionRunId: null,
    identifier: "RUD-5",
    projectId: null,
    status: "todo" as const,
    title: "Lifecycle hardening",
    ...overrides,
  };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("issue lifecycle routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      orgId: "organization-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
  });

  it("queues an assignment wakeup when a new assigned issue is created", async () => {
    mockIssueService.create.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
      }),
    );

    const res = await request(createApp()).post("/api/orgs/organization-1/issues").send({
      title: "Lifecycle hardening",
      status: "todo",
      priority: "high",
      assigneeAgentId: ASSIGNEE_AGENT_ID,
    });

    expect(res.status).toBe(201);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: { issueId: "11111111-1111-4111-8111-111111111111", mutation: "create" },
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          source: "issue.create",
          wakeSource: "assignment",
          wakeReason: "issue_assigned",
          issue: expect.objectContaining({
            id: "11111111-1111-4111-8111-111111111111",
            title: "Lifecycle hardening",
            status: "todo",
          }),
        }),
      }),
    );
  });

  it("wakes the assignee when a backlog issue is moved back into the active queue", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: "backlog",
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: patch.status as "todo",
      }),
    );

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_status_changed",
        payload: { issueId: "11111111-1111-4111-8111-111111111111", mutation: "update" },
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          source: "issue.status_change",
          wakeSource: "automation",
          wakeReason: "issue_status_changed",
          issue: expect.objectContaining({
            id: "11111111-1111-4111-8111-111111111111",
            title: "Lifecycle hardening",
            status: "todo",
          }),
        }),
      }),
    );
  });

  it("coalesces assignee and mention wakeups into a single enqueue", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: null,
      }),
    );
    mockIssueService.update.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
      }),
    );
    mockIssueService.findMentionedAgents.mockResolvedValue([ASSIGNEE_AGENT_ID]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        comment: "@Founding Engineer please take this",
      });

    expect(res.status).toBe(200);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
      }),
    );
  });

  it("includes issue and comment context when mention wakeup is queued from comment endpoint", async () => {
    const mentionedAgentId = "33333333-3333-4333-8333-333333333333";
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: null,
      }),
    );
    mockIssueService.findMentionedAgents.mockResolvedValue([mentionedAgentId]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-mention-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      orgId: "organization-1",
      body: "@worker please check this",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "@worker please check this" });

    expect(res.status).toBe(201);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      mentionedAgentId,
      expect.objectContaining({
        source: "automation",
        reason: "issue_comment_mentioned",
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          commentId: "comment-mention-1",
          wakeCommentId: "comment-mention-1",
          wakeReason: "issue_comment_mentioned",
          wakeSource: "comment.mention",
          issue: expect.objectContaining({
            id: "11111111-1111-4111-8111-111111111111",
            title: "Lifecycle hardening",
            status: "todo",
          }),
          comment: expect.objectContaining({
            id: "comment-mention-1",
            body: "@worker please check this",
            authorUserId: "local-board",
          }),
        }),
      }),
    );

    const mentionWakeupCall = mockHeartbeatService.wakeup.mock.calls.find(
      (call) => call[0] === mentionedAgentId,
    );
    const mentionWakeup = mentionWakeupCall?.[1];
    expect(mentionWakeup).toBeDefined();
    const context = mentionWakeup?.contextSnapshot as Record<string, unknown>;
    const promptTemplate = selectPromptTemplate(undefined, context);
    const renderedPrompt = renderTemplate(promptTemplate, {
      agent: { id: mentionedAgentId, name: "Mentioned Agent" },
      context,
      issue: context.issue,
      comment: context.comment,
    });
    expect(renderedPrompt).toContain("You were mentioned in a comment and your attention is needed.");
    expect(renderedPrompt).toContain("Lifecycle hardening");
    expect(renderedPrompt).toContain("@worker please check this");
  });

  it("includes issue and comment context when assignee wakeup is queued from comment endpoint", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
      }),
    );
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-assignee-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      orgId: "organization-1",
      body: "please check the retry path",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "please check the retry path" });

    expect(res.status).toBe(201);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          commentId: "comment-assignee-1",
          wakeCommentId: "comment-assignee-1",
          wakeReason: "issue_commented",
          issue: expect.objectContaining({
            id: "11111111-1111-4111-8111-111111111111",
            title: "Lifecycle hardening",
            status: "todo",
          }),
          comment: expect.objectContaining({
            id: "comment-assignee-1",
            body: "please check the retry path",
            authorUserId: "local-board",
          }),
        }),
      }),
    );

    const assigneeWakeupCall = mockHeartbeatService.wakeup.mock.calls.find(
      (call) => call[0] === ASSIGNEE_AGENT_ID,
    );
    const assigneeWakeup = assigneeWakeupCall?.[1];
    expect(assigneeWakeup).toBeDefined();
    const context = assigneeWakeup?.contextSnapshot as Record<string, unknown>;
    const promptTemplate = selectPromptTemplate(undefined, context);
    const renderedPrompt = renderTemplate(promptTemplate, {
      agent: { id: ASSIGNEE_AGENT_ID, name: "Assigned Agent" },
      context,
      issue: context.issue,
      comment: context.comment,
    });
    expect(renderedPrompt).toContain("There is a new comment on an issue you own.");
    expect(renderedPrompt).toContain("Lifecycle hardening");
    expect(renderedPrompt).toContain("please check the retry path");
  });

  it("does not enqueue a duplicate wakeup when an agent checks out its own issue in-run", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: "todo",
      }),
    );
    mockIssueService.checkout.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        executionRunId: RUN_ID,
        status: "in_progress",
      }),
    );

    const res = await request(createApp(createAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/checkout")
      .set("X-Rudder-Run-Id", RUN_ID)
      .send({ agentId: ASSIGNEE_AGENT_ID, expectedStatuses: ["todo", "backlog", "blocked"] });

    expect(res.status).toBe(200);
    expect(mockIssueService.checkout).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      ASSIGNEE_AGENT_ID,
      ["todo", "backlog", "blocked"],
      RUN_ID,
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("wakes the assignee when a board actor checks out an issue on their behalf", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: "todo",
      }),
    );
    mockIssueService.checkout.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: "in_progress",
      }),
    );

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/checkout")
      .send({ agentId: ASSIGNEE_AGENT_ID, expectedStatuses: ["todo", "backlog", "blocked"] });

    expect(res.status).toBe(200);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_checked_out",
        payload: { issueId: "11111111-1111-4111-8111-111111111111", mutation: "checkout" },
        contextSnapshot: {
          issueId: "11111111-1111-4111-8111-111111111111",
          source: "issue.checkout",
        },
      }),
    );
  });
});
