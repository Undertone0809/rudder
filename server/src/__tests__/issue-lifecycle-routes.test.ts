import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderTemplate, selectPromptTemplate } from "@rudderhq/agent-runtime-utils/server-utils";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  checkout: vi.fn(),
  create: vi.fn(),
  createAttachment: vi.fn(),
  findMentionedAgents: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  reorder: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  reportRunActivity: vi.fn(async () => undefined),
  wakeup: vi.fn(async () => undefined),
}));

const mockMessengerService = vi.hoisted(() => ({
  setThreadRead: vi.fn(async () => undefined),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(),
  upsertIssueDocument: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  createForIssue: vi.fn(),
  getById: vi.fn(),
  listForIssue: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockPublishLiveEvent = vi.hoisted(() => vi.fn());

const ASSIGNEE_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const REVIEWER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const PEER_AGENT_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const PEER_RUN_ID = "66666666-6666-4666-8666-666666666666";
const UNBOUND_RUN_ID = "77777777-7777-4777-8777-777777777777";

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentService,
  runWorkspaceService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  messengerService: () => mockMessengerService,
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  automationService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: mockPublishLiveEvent,
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

function createAgentActor(agentId = ASSIGNEE_AGENT_ID, runId: string | null = RUN_ID) {
  return {
    type: "agent" as const,
    agentId,
    orgId: "organization-1",
    orgIds: ["organization-1"],
    runId: runId ?? undefined,
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
  id: string;
  orgId: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  reviewerAgentId: string | null;
  reviewerUserId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  identifier: string;
  goalId: string | null;
  parentId: string | null;
  projectId: string | null;
  boardOrder: number;
  status: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done";
  title: string;
  description: string | null;
  priority: string;
}>) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "organization-1",
    assigneeAgentId: null,
    assigneeUserId: null,
    reviewerAgentId: null,
    reviewerUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    checkoutRunId: null,
    executionRunId: null,
    identifier: "RUD-5",
    goalId: null,
    parentId: null,
    projectId: null,
    boardOrder: 1000,
    status: "todo" as const,
    title: "Lifecycle hardening",
    description: null,
    priority: "medium",
    ...overrides,
  };
}

async function flushAsyncWork() {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("issue lifecycle routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockHeartbeatService.getRun.mockImplementation(async (runId: string) =>
      runId === RUN_ID
        ? {
          id: RUN_ID,
          orgId: "organization-1",
          agentId: ASSIGNEE_AGENT_ID,
          status: "running",
          contextSnapshot: { issueId: "11111111-1111-4111-8111-111111111111" },
        }
        : null,
    );
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockDocumentService.getIssueDocumentPayload.mockResolvedValue({
      planDocument: null,
      documentSummaries: [],
      legacyPlanDocument: null,
    });
    mockGoalService.getById.mockResolvedValue(null);
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue(null);
    mockProjectService.getById.mockResolvedValue(null);
    mockProjectService.listByIds.mockResolvedValue([]);
    mockWorkProductService.createForIssue.mockResolvedValue(null);
    mockWorkProductService.getById.mockResolvedValue(null);
    mockWorkProductService.listForIssue.mockResolvedValue([]);
    mockWorkProductService.remove.mockResolvedValue(null);
    mockWorkProductService.update.mockResolvedValue(null);
    mockIssueService.addComment.mockImplementation(async (_issueId: string, body: string, author: { agentId?: string; userId?: string }) => ({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      orgId: "organization-1",
      body,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      deletedByUserId: null,
      authorAgentId: author.agentId ?? null,
      authorUserId: author.userId ?? "local-board",
    }));
    mockIssueService.updateComment.mockImplementation(async (_issueId: string, commentId: string, body: string, author: { userId: string }) => ({
      id: commentId,
      issueId: "11111111-1111-4111-8111-111111111111",
      orgId: "organization-1",
      body,
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-01T00:01:00.000Z"),
      deletedAt: null,
      deletedByUserId: null,
      authorAgentId: null,
      authorUserId: author.userId,
    }));
    mockIssueService.deleteComment.mockImplementation(async (_issueId: string, commentId: string, author: { userId: string }) => ({
      id: commentId,
      issueId: "11111111-1111-4111-8111-111111111111",
      orgId: "organization-1",
      body: "",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: new Date("2026-05-01T00:02:00.000Z"),
      deletedAt: new Date("2026-05-01T00:02:00.000Z"),
      deletedByUserId: author.userId,
      authorAgentId: null,
      authorUserId: author.userId,
    }));
  });

  it("does not synthesize the default goal when reading an explicitly goal-less issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ goalId: null, projectId: null }));
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue({
      id: "dddddddd-dddd-4ddd-dddd-dddddddddddd",
      orgId: "organization-1",
      title: "Default organization goal",
      level: "organization",
      status: "active",
    });

    const res = await request(createApp())
      .get("/api/issues/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.goalId).toBeNull();
    expect(res.body.goal).toBeNull();
    expect(mockGoalService.getDefaultCompanyGoal).not.toHaveBeenCalled();
  });

  it("does not synthesize the default goal in heartbeat context for an explicitly goal-less issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ goalId: null, projectId: null }));
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue({
      id: "dddddddd-dddd-4ddd-dddd-dddddddddddd",
      orgId: "organization-1",
      title: "Default organization goal",
      level: "organization",
      status: "active",
    });

    const res = await request(createApp())
      .get("/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context");

    expect(res.status).toBe(200);
    expect(res.body.issue.goalId).toBeNull();
    expect(res.body.goal).toBeNull();
    expect(mockGoalService.getDefaultCompanyGoal).not.toHaveBeenCalled();
  });

  it("does not log activity for unchanged document saves", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockDocumentService.upsertIssueDocument.mockResolvedValue({
      created: false,
      unchanged: true,
      document: {
        id: "document-1",
        orgId: "organization-1",
        issueId: "11111111-1111-4111-8111-111111111111",
        key: "plan",
        title: null,
        format: "markdown",
        body: "# Plan",
        latestRevisionId: "33333333-3333-4333-8333-333333333333",
        latestRevisionNumber: 1,
        createdByAgentId: null,
        createdByUserId: "local-board",
        updatedByAgentId: null,
        updatedByUserId: "local-board",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const res = await request(createApp())
      .put("/api/issues/11111111-1111-4111-8111-111111111111/documents/plan")
      .send({
        title: null,
        format: "markdown",
        body: "# Plan",
        baseRevisionId: "33333333-3333-4333-8333-333333333333",
      });

    expect(res.status).toBe(200);
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "11111111-1111-4111-8111-111111111111",
        key: "plan",
        body: "# Plan",
        baseRevisionId: "33333333-3333-4333-8333-333333333333",
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects agent writes to legacy issue documents", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());

    const res = await request(createApp(createAgentActor()))
      .put("/api/issues/11111111-1111-4111-8111-111111111111/documents/plan")
      .send({
        title: "Plan",
        format: "markdown",
        body: "# Plan\n",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agents must write new durable work files under `library:projects/<project-key>/...`");
    expect(mockDocumentService.upsertIssueDocument).not.toHaveBeenCalled();
  });

  it("includes issue document references in heartbeat context without prompt body inlining", async () => {
    const issue = makeIssue({
      description: "Short issue summary",
      priority: "high",
    });
    const documentUpdatedAt = new Date("2026-05-07T00:00:00.000Z");
    mockIssueService.getById.mockResolvedValue(issue);
    mockDocumentService.getIssueDocumentPayload.mockResolvedValue({
      planDocument: {
        id: "44444444-4444-4444-8444-444444444444",
        orgId: "organization-1",
        issueId: issue.id,
        key: "plan",
        title: "Investigation Plan",
        format: "markdown",
        body: "# Plan\n\nConfirm whether agents can see issue docs.",
        latestRevisionId: "55555555-5555-4555-8555-555555555555",
        latestRevisionNumber: 1,
        createdByAgentId: null,
        createdByUserId: "local-board",
        updatedByAgentId: null,
        updatedByUserId: "local-board",
        createdAt: documentUpdatedAt,
        updatedAt: documentUpdatedAt,
      },
      documentSummaries: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          orgId: "organization-1",
          issueId: issue.id,
          key: "plan",
          title: "Investigation Plan",
          format: "markdown",
          latestRevisionId: "55555555-5555-4555-8555-555555555555",
          latestRevisionNumber: 1,
          createdByAgentId: null,
          createdByUserId: "local-board",
          updatedByAgentId: null,
          updatedByUserId: "local-board",
          createdAt: documentUpdatedAt,
          updatedAt: documentUpdatedAt,
        },
      ],
      legacyPlanDocument: null,
    });

    const res = await request(createApp())
      .get("/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context");

    expect(res.status).toBe(200);
    expect(mockDocumentService.getIssueDocumentPayload).toHaveBeenCalledWith(
      expect.objectContaining({ id: issue.id }),
    );
    expect(res.body.planDocument).toMatchObject({
      key: "plan",
      title: "Investigation Plan",
      body: "# Plan\n\nConfirm whether agents can see issue docs.",
    });
    expect(res.body.documentSummaries).toHaveLength(1);
    expect(res.body.issueDocumentsPrompt).toContain("## Legacy Issue Documents");
    expect(res.body.issueDocumentsPrompt).toContain("$RUDDER_PROJECT_LIBRARY_ROOT");
    expect(res.body.issueDocumentsPrompt).toContain("rudder library file ref");
    expect(res.body.issueDocumentsPrompt).toContain(`rudder issue documents get ${issue.id} plan --json`);
    expect(res.body.issueDocumentsPrompt).not.toContain("Confirm whether agents can see issue docs.");
  });

  it("records agent-reported commit activity with the authenticated agent and run", async () => {
    const issue = makeIssue({
      status: "in_progress",
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      checkoutRunId: RUN_ID,
      title: "Add commit activity",
    });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createApp(createAgentActor()))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/commit")
      .send({
        sha: "ABC1234def5678",
        message: "fix: record commit activity",
        branch: "feature/commit-activity",
        repoPath: "/repo/rudder",
        workspacePath: "/workspace/rudder",
        commitCount: 2,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      issueId: issue.id,
      sha: "abc1234def5678",
      shortSha: "abc1234",
      subject: "fix: record commit activity",
      runId: RUN_ID,
    });
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issue.id, ASSIGNEE_AGENT_ID, RUN_ID);
    expect(mockHeartbeatService.reportRunActivity).toHaveBeenCalledWith(RUN_ID);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: issue.orgId,
        actorType: "agent",
        actorId: ASSIGNEE_AGENT_ID,
        agentId: ASSIGNEE_AGENT_ID,
        runId: RUN_ID,
        action: "issue.code_committed",
        entityType: "issue",
        entityId: issue.id,
        details: expect.objectContaining({
          sha: "abc1234def5678",
          shortSha: "abc1234",
          subject: "fix: record commit activity",
          branch: "feature/commit-activity",
          repoPath: "/repo/rudder",
          workspacePath: "/workspace/rudder",
          commitCount: 2,
        }),
      }),
    );
  });

  it("rejects agent-reported commit activity when the run belongs to another agent", async () => {
    const issue = makeIssue({
      status: "todo",
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      title: "Add commit activity",
    });
    mockIssueService.getById.mockResolvedValue(issue);
    mockHeartbeatService.getRun.mockResolvedValueOnce({
      id: RUN_ID,
      orgId: issue.orgId,
      agentId: PEER_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: issue.id },
    });

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID, RUN_ID)))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/commit")
      .send({
        sha: "abc1234def5678",
        message: "fix: forged run attribution",
      });

    expect(res.status).toBe(403);
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.code_committed" }),
    );
    expect(mockHeartbeatService.reportRunActivity).not.toHaveBeenCalled();
  });

  it("rejects agent-reported commit activity when the run is not bound to the issue", async () => {
    const issue = makeIssue({
      status: "todo",
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      title: "Add commit activity",
    });
    mockIssueService.getById.mockResolvedValue(issue);
    mockHeartbeatService.getRun.mockResolvedValueOnce({
      id: UNBOUND_RUN_ID,
      orgId: issue.orgId,
      agentId: ASSIGNEE_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: "99999999-9999-4999-8999-999999999999" },
    });

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID, UNBOUND_RUN_ID)))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/commit")
      .send({
        sha: "abc1234def5678",
        message: "fix: arbitrary run attribution",
      });

    expect(res.status).toBe(403);
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.code_committed" }),
    );
    expect(mockHeartbeatService.reportRunActivity).not.toHaveBeenCalled();
  });

  it("records allowed agent-reported commit activity without run attribution", async () => {
    const issue = makeIssue({
      status: "todo",
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      title: "Add commit activity",
    });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID, null)))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/commit")
      .send({
        sha: "abc1234def5678",
        message: "fix: report without run",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true,
      issueId: issue.id,
      runId: null,
    });
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockHeartbeatService.reportRunActivity).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "agent",
        actorId: ASSIGNEE_AGENT_ID,
        agentId: ASSIGNEE_AGENT_ID,
        runId: null,
        action: "issue.code_committed",
      }),
    );
  });

  it("records separate commit activity rows for multiple reporting agents", async () => {
    const issue = makeIssue({
      status: "todo",
      assigneeAgentId: null,
      title: "Add commit activity",
    });
    mockIssueService.getById.mockResolvedValue(issue);
    mockHeartbeatService.getRun.mockImplementation(async (runId: string) => {
      if (runId === RUN_ID) {
        return {
          id: RUN_ID,
          orgId: issue.orgId,
          agentId: ASSIGNEE_AGENT_ID,
          status: "running",
          contextSnapshot: { issueId: issue.id },
        };
      }
      if (runId === PEER_RUN_ID) {
        return {
          id: PEER_RUN_ID,
          orgId: issue.orgId,
          agentId: PEER_AGENT_ID,
          status: "running",
          contextSnapshot: { issueId: issue.id },
        };
      }
      return null;
    });

    const [first, second] = await Promise.all([
      request(createApp(createAgentActor(ASSIGNEE_AGENT_ID, RUN_ID)))
        .post("/api/issues/11111111-1111-4111-8111-111111111111/commit")
        .send({
          sha: "abc1234def5678",
          message: "fix: first agent commit",
        }),
      request(createApp(createAgentActor(PEER_AGENT_ID, PEER_RUN_ID)))
        .post("/api/issues/11111111-1111-4111-8111-111111111111/commit")
        .send({
          sha: "def5678abc1234",
          message: "fix: peer agent commit",
        }),
    ]);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: ASSIGNEE_AGENT_ID,
        agentId: ASSIGNEE_AGENT_ID,
        runId: RUN_ID,
        action: "issue.code_committed",
        details: expect.objectContaining({ shortSha: "abc1234" }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: PEER_AGENT_ID,
        agentId: PEER_AGENT_ID,
        runId: PEER_RUN_ID,
        action: "issue.code_committed",
        details: expect.objectContaining({ shortSha: "def5678" }),
      }),
    );
    expect(mockHeartbeatService.reportRunActivity).toHaveBeenCalledWith(RUN_ID);
    expect(mockHeartbeatService.reportRunActivity).toHaveBeenCalledWith(PEER_RUN_ID);
  });

  it("reorders an issue within an organization lane and logs activity", async () => {
    const issue = makeIssue({
      boardOrder: 2000,
      status: "todo",
    });
    mockIssueService.reorder.mockResolvedValue({
      issue,
      previousStatus: "todo",
      previousBoardOrder: 3000,
    });

    const res = await request(createApp())
      .post("/api/orgs/organization-1/issues/reorder")
      .send({
        issueId: "11111111-1111-4111-8111-111111111111",
        targetStatus: "todo",
        previousIssueId: "22222222-2222-4222-8222-222222222222",
        nextIssueId: "33333333-3333-4333-8333-333333333333",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.reorder).toHaveBeenCalledWith("organization-1", {
      issueId: "11111111-1111-4111-8111-111111111111",
      targetStatus: "todo",
      previousIssueId: "22222222-2222-4222-8222-222222222222",
      nextIssueId: "33333333-3333-4333-8333-333333333333",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.reordered",
        entityType: "issue",
        entityId: issue.id,
        details: expect.objectContaining({
          identifier: "RUD-5",
          status: "todo",
          boardOrder: 2000,
          _previous: {
            status: "todo",
            boardOrder: 3000,
          },
        }),
      }),
    );
  });

  it("requires board access to reorder issue board lanes", async () => {
    const res = await request(createApp(createAgentActor()))
      .post("/api/orgs/organization-1/issues/reorder")
      .send({
        issueId: "11111111-1111-4111-8111-111111111111",
        targetStatus: "todo",
        position: "end",
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.reorder).not.toHaveBeenCalled();
  });

  it("stores inline comment uploads without logging them as issue attachments", async () => {
    const app = express();
    const storage = {
      provider: "local_disk" as const,
      putFile: vi.fn(async (input: {
        orgId: string;
        namespace: string;
        originalFilename: string | null;
        contentType: string;
        body: Buffer;
      }) => ({
        provider: "local_disk" as const,
        objectKey: `${input.namespace}/${input.originalFilename ?? "upload"}`,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: "sha256-sample",
        originalFilename: input.originalFilename,
      })),
      getObject: vi.fn(),
      headObject: vi.fn(),
      deleteObject: vi.fn(),
    };
    app.use((req, _res, next) => {
      (req as any).actor = createBoardActor();
      next();
    });
    app.use("/api", issueRoutes({} as any, storage));
    app.use(errorHandler);

    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.createAttachment.mockResolvedValue({
      id: "attachment-1",
      orgId: "organization-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      issueCommentId: null,
      assetId: "asset-1",
      usage: "comment_inline",
      provider: "local_disk",
      objectKey: "issues/11111111-1111-4111-8111-111111111111/note.txt",
      contentType: "text/plain",
      byteSize: 5,
      sha256: "sha256-sample",
      originalFilename: "note.txt",
      createdByAgentId: null,
      createdByUserId: "local-board",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/issues/11111111-1111-4111-8111-111111111111/attachments")
      .field("usage", "comment_inline")
      .attach("file", Buffer.from("hello"), { filename: "note.txt", contentType: "text/plain" });

    expect(res.status).toBe(201);
    expect(mockIssueService.createAttachment).toHaveBeenCalledWith(expect.objectContaining({
      issueId: "11111111-1111-4111-8111-111111111111",
      usage: "comment_inline",
      contentType: "text/plain",
      originalFilename: "note.txt",
    }));
    expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.attachment_added",
    }));
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

  it("defaults agent-created issues without an assignee to the creating agent", async () => {
    mockIssueService.create.mockImplementation(async (_orgId: string, data: Record<string, unknown>) =>
      makeIssue({
        assigneeAgentId: data.assigneeAgentId as string | null,
        assigneeUserId: (data.assigneeUserId as string | null | undefined) ?? null,
        createdByAgentId: data.createdByAgentId as string | null,
        createdByUserId: data.createdByUserId as string | null,
        status: data.status as "todo",
        title: data.title as string,
      }),
    );

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID)))
      .post("/api/orgs/organization-1/issues")
      .send({
        title: "Agent-created issue",
        status: "todo",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        title: "Agent-created issue",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        createdByAgentId: ASSIGNEE_AGENT_ID,
        createdByUserId: null,
      }),
    );
    expect(res.body.assigneeAgentId).toBe(ASSIGNEE_AGENT_ID);
    expect(res.body.createdByAgentId).toBe(ASSIGNEE_AGENT_ID);
  });

  it("preserves explicit assignee and explicit null on agent-created issues", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.create.mockImplementation(async (_orgId: string, data: Record<string, unknown>) =>
      makeIssue({
        assigneeAgentId: (data.assigneeAgentId as string | null | undefined) ?? null,
        assigneeUserId: (data.assigneeUserId as string | null | undefined) ?? null,
        createdByAgentId: data.createdByAgentId as string | null,
        createdByUserId: data.createdByUserId as string | null,
        status: data.status as "backlog" | "todo",
        title: data.title as string,
      }),
    );

    const explicitAssignee = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID)))
      .post("/api/orgs/organization-1/issues")
      .send({
        title: "Explicit assignee",
        status: "todo",
        assigneeAgentId: REVIEWER_AGENT_ID,
      });

    expect(explicitAssignee.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenLastCalledWith(
      "organization-1",
      expect.objectContaining({
        assigneeAgentId: REVIEWER_AGENT_ID,
        createdByAgentId: ASSIGNEE_AGENT_ID,
      }),
    );
    expect(explicitAssignee.body.assigneeAgentId).toBe(REVIEWER_AGENT_ID);

    const explicitNull = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID)))
      .post("/api/orgs/organization-1/issues")
      .send({
        title: "Explicit null assignee",
        status: "backlog",
        assigneeAgentId: null,
        assigneeUserId: null,
      });

    expect(explicitNull.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenLastCalledWith(
      "organization-1",
      expect.objectContaining({
        assigneeAgentId: null,
        assigneeUserId: null,
        createdByAgentId: ASSIGNEE_AGENT_ID,
      }),
    );
    expect(explicitNull.body.assigneeAgentId).toBeNull();
    expect(explicitNull.body.assigneeUserId).toBeNull();
  });

  it("leaves board-created issues unassigned when no assignee is supplied", async () => {
    mockIssueService.create.mockImplementation(async (_orgId: string, data: Record<string, unknown>) =>
      makeIssue({
        assigneeAgentId: (data.assigneeAgentId as string | null | undefined) ?? null,
        assigneeUserId: (data.assigneeUserId as string | null | undefined) ?? null,
        createdByAgentId: data.createdByAgentId as string | null,
        createdByUserId: data.createdByUserId as string | null,
        status: data.status as "backlog",
        title: data.title as string,
      }),
    );

    const res = await request(createApp())
      .post("/api/orgs/organization-1/issues")
      .send({
        title: "Board-created issue",
        status: "backlog",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        title: "Board-created issue",
        createdByAgentId: null,
        createdByUserId: "local-board",
      }),
    );
    expect(mockIssueService.create.mock.calls[0]?.[1]).not.toHaveProperty("assigneeAgentId");
    expect(mockIssueService.create.mock.calls[0]?.[1]).not.toHaveProperty("assigneeUserId");
    expect(res.body.assigneeAgentId).toBeNull();
  });

  it("accepts canonical run workspace fields when creating issues", async () => {
    const runWorkspaceId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    mockIssueService.create.mockImplementationOnce(async (_orgId: string, data: Record<string, unknown>) =>
      makeIssue({
        title: data.title as string,
      }),
    );

    const res = await request(createApp())
      .post("/api/orgs/organization-1/issues")
      .send({
        title: "Board-created issue",
        runWorkspaceId,
        runWorkspacePreference: "reuse_existing",
        runWorkspaceSettings: { mode: "reuse_existing" },
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        executionWorkspaceId: runWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "reuse_existing" },
      }),
    );
    expect(mockIssueService.create.mock.calls[0]?.[1]).not.toHaveProperty("runWorkspaceId");
    expect(mockIssueService.create.mock.calls[0]?.[1]).not.toHaveProperty("runWorkspacePreference");
    expect(mockIssueService.create.mock.calls[0]?.[1]).not.toHaveProperty("runWorkspaceSettings");
  });

  it("queues a review wakeup when a reviewer issue is created directly in review", async () => {
    mockIssueService.create.mockResolvedValue(
      makeIssue({
        status: "in_review",
        reviewerAgentId: ASSIGNEE_AGENT_ID,
      }),
    );

    const res = await request(createApp()).post("/api/orgs/organization-1/issues").send({
      title: "Lifecycle hardening",
      status: "in_review",
      priority: "high",
      reviewerAgentId: ASSIGNEE_AGENT_ID,
    });

    expect(res.status).toBe(201);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "review",
        reason: "issue_review_requested",
        payload: { issueId: "11111111-1111-4111-8111-111111111111", mutation: "create_in_review" },
        contextSnapshot: expect.objectContaining({
          source: "issue.create",
          wakeSource: "review",
          wakeReason: "issue_review_requested",
          role: "reviewer",
          reviewInstructions: expect.stringContaining("structured reviewer decision"),
        }),
      }),
    );
  });

  it("queues a review wakeup when an issue enters review", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "in_progress",
        reviewerAgentId: ASSIGNEE_AGENT_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        status: patch.status as "in_review",
        reviewerAgentId: ASSIGNEE_AGENT_ID,
      }),
    );

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "review",
        reason: "issue_review_requested",
        payload: { issueId: "11111111-1111-4111-8111-111111111111", mutation: "status_to_in_review" },
        contextSnapshot: expect.objectContaining({
          source: "issue.status_change",
          wakeSource: "review",
          wakeReason: "issue_review_requested",
          role: "reviewer",
        }),
      }),
    );
  });

  it("accepts canonical run workspace fields when updating issues", async () => {
    const runWorkspaceId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    mockIssueService.getById.mockResolvedValueOnce(makeIssue());
    mockIssueService.update.mockImplementationOnce(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        title: (patch.title as string | undefined) ?? "Lifecycle hardening",
      }),
    );

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        runWorkspaceId,
        runWorkspacePreference: "reuse_existing",
        runWorkspaceSettings: { mode: "reuse_existing" },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        executionWorkspaceId: runWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "reuse_existing" },
      }),
    );
    expect(mockIssueService.update.mock.calls[0]?.[1]).not.toHaveProperty("runWorkspaceId");
    expect(mockIssueService.update.mock.calls[0]?.[1]).not.toHaveProperty("runWorkspacePreference");
    expect(mockIssueService.update.mock.calls[0]?.[1]).not.toHaveProperty("runWorkspaceSettings");
  });

  it("rejects conflicting canonical and legacy run workspace fields", async () => {
    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        runWorkspaceId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        executionWorkspaceId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("runWorkspaceId conflicts");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("accepts canonical run workspace fields when creating work products", async () => {
    const runWorkspaceId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    mockIssueService.getById.mockResolvedValueOnce(makeIssue({ projectId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" }));
    mockWorkProductService.createForIssue.mockImplementationOnce(
      async (_issueId: string, _orgId: string, data: Record<string, unknown>) => ({
        id: "work-product-1",
        orgId: "organization-1",
        issueId: "11111111-1111-4111-8111-111111111111",
        type: data.type,
        provider: data.provider,
        executionWorkspaceId: data.executionWorkspaceId,
      }),
    );

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/work-products")
      .send({
        runWorkspaceId,
        type: "preview_url",
        provider: "custom",
        title: "Preview",
        url: "https://example.com/preview",
      });

    expect(res.status).toBe(201);
    expect(mockWorkProductService.createForIssue).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "organization-1",
      expect.objectContaining({
        executionWorkspaceId: runWorkspaceId,
      }),
    );
    expect(mockWorkProductService.createForIssue.mock.calls[0]?.[2]).not.toHaveProperty("runWorkspaceId");
  });

  it("logs activity details from the final persisted issue changes", async () => {
    const oldProjectId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const newProjectId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const oldGoalId = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    const newGoalId = "dddddddd-dddd-4ddd-dddd-dddddddddddd";

    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        projectId: oldProjectId,
        goalId: oldGoalId,
      }),
    );
    mockIssueService.update.mockResolvedValue(
      makeIssue({
        projectId: newProjectId,
        goalId: newGoalId,
      }),
    );

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ projectId: newProjectId });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          identifier: "RUD-5",
          projectId: newProjectId,
          goalId: newGoalId,
          _previous: expect.objectContaining({
            projectId: oldProjectId,
            goalId: oldGoalId,
          }),
        }),
      }),
    );
  });

  it("does not log low-signal title and description-only updates", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        title: "Original title",
        description: "Original description",
      }),
    );
    mockIssueService.update.mockResolvedValue(
      makeIssue({
        title: "Renamed title",
        description: "Edited description",
      }),
    );

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ title: "Renamed title", description: "Edited description" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        title: "Renamed title",
        description: "Edited description",
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockPublishLiveEvent).toHaveBeenCalledWith({
      orgId: "organization-1",
      type: "issue.content_updated",
      payload: expect.objectContaining({
        entityType: "issue",
        entityId: "11111111-1111-4111-8111-111111111111",
        actorType: "user",
        actorId: "local-board",
        details: expect.objectContaining({
          title: "Renamed title",
          description: "Edited description",
        }),
      }),
    });
  });

  it("includes parent issue references in parent update activity details", async () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const parentIssueId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const childIssue = makeIssue({ id: issueId });
    const updatedChildIssue = makeIssue({ id: issueId, parentId: parentIssueId });
    const parentIssue = makeIssue({
      id: parentIssueId,
      identifier: "RUD-42",
      title: "Messenger review parent",
    });

    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === issueId) return childIssue;
      if (id === parentIssueId) return parentIssue;
      return null;
    });
    mockIssueService.update.mockResolvedValue(updatedChildIssue);

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ parentId: parentIssueId });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        entityId: issueId,
        details: expect.objectContaining({
          parentId: parentIssueId,
          _references: {
            parentIssue: {
              id: parentIssueId,
              identifier: "RUD-42",
              title: "Messenger review parent",
            },
          },
          _previous: expect.objectContaining({ parentId: null }),
        }),
      }),
    );
  });

  it("does not log a generic issue update for comment-only patches", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue(issue);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "Leaving an evidence note." });

    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.updated" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          bodySnippet: "Leaving an evidence note.",
          identifier: "RUD-5",
        }),
      }),
    );
  });

  it("queues a reviewer wakeup when an assignee blocks a reviewed issue", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "in_progress",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        status: patch.status as "blocked",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "blocked", comment: "Blocked by missing credentials." });

    expect(res.status).toBe(200);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      REVIEWER_AGENT_ID,
      expect.objectContaining({
        source: "review",
        reason: "issue_review_requested",
        payload: { issueId: "11111111-1111-4111-8111-111111111111", mutation: "status_to_blocked" },
        contextSnapshot: expect.objectContaining({
          source: "issue.status_change",
          wakeSource: "review",
          wakeReason: "issue_review_requested",
          role: "reviewer",
          issue: expect.objectContaining({ status: "blocked" }),
          reviewInstructions: expect.stringContaining("human/external blocker"),
        }),
      }),
    );
  });

  it("normalizes assignee done on a reviewed issue into review and wakes the reviewer", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "in_progress",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: ASSIGNEE_AGENT_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        status: patch.status as "in_review",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: ASSIGNEE_AGENT_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "in_review" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          status: "in_review",
          normalizedFromStatus: "done",
          normalizedReason: "reviewed_issue_assignee_completion",
        }),
      }),
    );
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "review",
        reason: "issue_review_requested",
        contextSnapshot: expect.objectContaining({
          source: "issue.status_change",
          wakeReason: "issue_review_requested",
          role: "reviewer",
        }),
      }),
    );
  });

  it("allows the reviewer agent to mark an in-review issue done without another review wakeup", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "in_review",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        status: patch.status as "done",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(REVIEWER_AGENT_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("wakes the assignee with reviewer comment context when a reviewer requests changes", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "in_review",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        status: patch.status as "in_progress",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(REVIEWER_AGENT_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_progress", comment: "Please tighten the lifecycle tests." });

    expect(res.status).toBe(200);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_changes_requested",
        payload: {
          issueId: "11111111-1111-4111-8111-111111111111",
          mutation: "review_changes_requested",
          commentId: "comment-1",
        },
        contextSnapshot: expect.objectContaining({
          issueId: "11111111-1111-4111-8111-111111111111",
          taskId: "11111111-1111-4111-8111-111111111111",
          commentId: "comment-1",
          wakeCommentId: "comment-1",
          source: "issue.review_changes_requested",
          wakeSource: "assignment",
          wakeReason: "issue_changes_requested",
          issue: expect.objectContaining({ status: "in_progress" }),
          comment: expect.objectContaining({
            id: "comment-1",
            body: "Please tighten the lifecycle tests.",
            authorAgentId: REVIEWER_AGENT_ID,
          }),
        }),
      }),
    );

    const changesRequestedWakeup = mockHeartbeatService.wakeup.mock.calls.find(
      (call) => call[0] === ASSIGNEE_AGENT_ID,
    )?.[1];
    expect(changesRequestedWakeup).toBeDefined();
    const context = changesRequestedWakeup?.contextSnapshot as Record<string, unknown>;
    const promptTemplate = selectPromptTemplate(undefined, context);
    const renderedPrompt = renderTemplate(promptTemplate, {
      agent: { id: ASSIGNEE_AGENT_ID, name: "Assigned Agent" },
      context,
      issue: context.issue,
      comment: context.comment,
    });
    expect(renderedPrompt).toContain("A reviewer requested changes on an issue you own.");
    expect(renderedPrompt).toContain("Please tighten the lifecycle tests.");
  });

  it("wakes the assignee with reviewer comment context when a reviewer returns an issue to todo", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "in_review",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        status: patch.status as "todo",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(REVIEWER_AGENT_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "todo", comment: "Please rework the handoff payload." });

    expect(res.status).toBe(200);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_changes_requested",
        payload: expect.objectContaining({
          mutation: "review_changes_requested",
          commentId: "comment-1",
        }),
        contextSnapshot: expect.objectContaining({
          commentId: "comment-1",
          wakeCommentId: "comment-1",
          issue: expect.objectContaining({ status: "todo" }),
          comment: expect.objectContaining({ body: "Please rework the handoff payload." }),
        }),
      }),
    );
  });

  it("does not attach comment wake context when review return has no comment", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "in_review",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        status: patch.status as "in_progress",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(REVIEWER_AGENT_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    await flushAsyncWork();
    const changesRequestedWakeup = mockHeartbeatService.wakeup.mock.calls.find(
      (call) => call[0] === ASSIGNEE_AGENT_ID,
    )?.[1];
    expect(changesRequestedWakeup).toEqual(
      expect.objectContaining({
        reason: "issue_changes_requested",
        payload: expect.not.objectContaining({ commentId: expect.anything() }),
        contextSnapshot: expect.not.objectContaining({
          commentId: expect.anything(),
          wakeCommentId: expect.anything(),
          comment: expect.anything(),
        }),
      }),
    );
  });

  it("records a structured reviewer request-changes decision", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "in_review",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        status: patch.status as "in_progress",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(REVIEWER_AGENT_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        reviewDecision: "request_changes",
        comment: "Please add the missing E2E proof.",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "in_progress" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_decision_recorded",
        runId: RUN_ID,
        details: expect.objectContaining({
          decision: "request_changes",
          status: "in_progress",
          commentId: "comment-1",
        }),
      }),
    );
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_changes_requested",
        payload: expect.objectContaining({ commentId: "comment-1" }),
        contextSnapshot: expect.objectContaining({
          commentId: "comment-1",
          wakeCommentId: "comment-1",
          comment: expect.objectContaining({
            body: "Please add the missing E2E proof.",
            authorAgentId: REVIEWER_AGENT_ID,
          }),
        }),
      }),
    );
  });

  it("records a structured reviewer request-changes decision from blocked", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "blocked",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        status: patch.status as "in_progress",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(REVIEWER_AGENT_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        reviewDecision: "request_changes",
        comment: "Credentials are available; retry with the updated setup.",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "in_progress" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_decision_recorded",
        details: expect.objectContaining({
          decision: "request_changes",
          status: "in_progress",
        }),
      }),
    );
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ reason: "issue_changes_requested" }),
    );
  });

  it("records a structured reviewer approve decision from blocked as done", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "blocked",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        status: patch.status as "done",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(REVIEWER_AGENT_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        reviewDecision: "approve",
        comment: "Blocker is resolved and the existing work is acceptable.",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_decision_recorded",
        details: expect.objectContaining({
          decision: "approve",
          status: "done",
        }),
      }),
    );
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("records a blocked reviewer decision as a human handoff outcome", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "blocked",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        status: patch.status as "blocked",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(REVIEWER_AGENT_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        reviewDecision: "blocked",
        comment: "Confirmed: this needs operator input before the assignee can continue.",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "blocked" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_decision_recorded",
        details: expect.objectContaining({
          decision: "blocked",
          outcome: "human_handoff",
          operatorActionRequired: true,
          status: "blocked",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.human_intervention_required",
        details: expect.objectContaining({
          decision: "blocked",
          status: "blocked",
          commentId: "comment-1",
          previousReviewerAgentId: REVIEWER_AGENT_ID,
          nextAction: "Human/operator intervention is required before agent review can continue.",
        }),
      }),
    );
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("records a structured needs-followup reviewer decision without changing status", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "in_review",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        status: (patch.status as "in_review" | undefined) ?? "in_review",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(REVIEWER_AGENT_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        reviewDecision: "needs_followup",
        comment: "Waiting for the preview URL before final review.",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.not.objectContaining({ status: expect.anything() }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.review_decision_recorded",
        details: expect.objectContaining({
          decision: "needs_followup",
          status: "in_review",
        }),
      }),
    );
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects reviewer decisions from a non-reviewer agent", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "in_review",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        reviewDecision: "approve",
        comment: "Looks good.",
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
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

  it("records agent issue comments with the current run id", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: "in_progress",
        checkoutRunId: RUN_ID,
        executionRunId: RUN_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID, RUN_ID)))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "Close-out evidence." });

    expect(res.status).toBe(201);
    expect(mockHeartbeatService.reportRunActivity).toHaveBeenCalledWith(RUN_ID);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        entityId: "11111111-1111-4111-8111-111111111111",
        agentId: ASSIGNEE_AGENT_ID,
        runId: RUN_ID,
        details: expect.objectContaining({
          commentId: "comment-1",
          bodySnippet: "Close-out evidence.",
        }),
      }),
    );
  });

  it("allows a board user to edit their own issue comment and records safe activity", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1")
      .send({ body: "Updated comment body" });

    expect(res.status).toBe(200);
    expect(res.body.body).toBe("Updated comment body");
    expect(mockIssueService.updateComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "comment-1",
      "Updated comment body",
      { userId: "local-board" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "user",
        actorId: "local-board",
        action: "issue.comment_updated",
        entityType: "issue",
        entityId: "11111111-1111-4111-8111-111111111111",
        details: expect.objectContaining({
          commentId: "comment-1",
          identifier: "RUD-5",
        }),
      }),
    );
  });

  it("allows a board user to delete their own issue comment without logging the deleted body", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());

    const res = await request(createApp())
      .delete("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1");

    expect(res.status).toBe(200);
    expect(res.body.body).toBe("");
    expect(res.body.deletedByUserId).toBe("local-board");
    expect(mockIssueService.deleteComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "comment-1",
      { userId: "local-board" },
    );
    const activityCall = mockLogActivity.mock.calls.find((call) => call[1]?.action === "issue.comment_deleted");
    expect(activityCall?.[1]).toEqual(expect.objectContaining({
      details: expect.objectContaining({
        commentId: "comment-1",
        identifier: "RUD-5",
      }),
    }));
    expect(JSON.stringify(activityCall?.[1]?.details)).not.toContain("Original deleted body");
  });

  it("rejects agent attempts to edit or delete issue comments", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());

    const patchRes = await request(createApp(createAgentActor()))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1")
      .send({ body: "Agent edit" });
    const deleteRes = await request(createApp(createAgentActor()))
      .delete("/api/issues/11111111-1111-4111-8111-111111111111/comments/comment-1");

    expect(patchRes.status).toBe(403);
    expect(deleteRes.status).toBe(403);
    expect(mockIssueService.updateComment).not.toHaveBeenCalled();
    expect(mockIssueService.deleteComment).not.toHaveBeenCalled();
  });

  it("allows an assignee follow-up execution run with a null checkout lock to close out", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
        status: "in_progress",
        checkoutRunId: null,
        executionRunId: RUN_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        reviewerAgentId: REVIEWER_AGENT_ID,
        status: patch.status as "in_review",
        checkoutRunId: null,
        executionRunId: RUN_ID,
      }),
    );

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID, RUN_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done", comment: "Implemented the requested changes." });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      ASSIGNEE_AGENT_ID,
      RUN_ID,
    );
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "in_review" }),
    );
    expect(mockHeartbeatService.reportRunActivity).toHaveBeenCalledWith(RUN_ID);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        runId: RUN_ID,
        details: expect.objectContaining({
          status: "in_review",
          normalizedFromStatus: "done",
          normalizedReason: "reviewed_issue_assignee_completion",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        runId: RUN_ID,
        details: expect.objectContaining({
          bodySnippet: "Implemented the requested changes.",
        }),
      }),
    );
  });

  it("logs ownership rejection when an assignee close-out run does not own the issue", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: "in_progress",
        checkoutRunId: "99999999-9999-4999-8999-999999999999",
        executionRunId: "99999999-9999-4999-8999-999999999999",
      }),
    );
    mockIssueService.assertCheckoutOwner.mockRejectedValueOnce(new HttpError(409, "Issue run ownership conflict", {
      issueId: "11111111-1111-4111-8111-111111111111",
      checkoutRunId: "99999999-9999-4999-8999-999999999999",
      executionRunId: "99999999-9999-4999-8999-999999999999",
      actorRunId: RUN_ID,
    }));

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID, RUN_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done", comment: "This run should not close out." });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Issue run ownership conflict",
      details: expect.objectContaining({
        checkoutRunId: "99999999-9999-4999-8999-999999999999",
        executionRunId: "99999999-9999-4999-8999-999999999999",
        actorRunId: RUN_ID,
      }),
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.run_ownership_rejected",
        runId: RUN_ID,
        details: expect.objectContaining({
          reason: "checkout_owner_conflict",
          actorAgentId: ASSIGNEE_AGENT_ID,
          actorRunId: RUN_ID,
          error: "Issue run ownership conflict",
          errorDetails: expect.objectContaining({
            checkoutRunId: "99999999-9999-4999-8999-999999999999",
            executionRunId: "99999999-9999-4999-8999-999999999999",
            actorRunId: RUN_ID,
          }),
        }),
      }),
    );
  });


  it("does not fan out mention wakeups from agent-authored issue comments", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: "in_progress",
        checkoutRunId: RUN_ID,
        executionRunId: RUN_ID,
      }),
    );
    mockIssueService.findMentionedAgents.mockResolvedValue([PEER_AGENT_ID]);

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID, RUN_ID)))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "@Peer Agent I handled the review feedback." });

    expect(res.status).toBe(201);
    await flushAsyncWork();
    expect(mockIssueService.findMentionedAgents).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });
  it("does not update assignee when a comment mentions another agent", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
      }),
    );
    mockIssueService.findMentionedAgents.mockResolvedValue([PEER_AGENT_ID]);

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "@Peer Agent can you check the interaction copy?",
        assigneeAgentId: PEER_AGENT_ID,
        assigneeUserId: null,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "@Peer Agent can you check the interaction copy?",
      { userId: "local-board" },
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      PEER_AGENT_ID,
      expect.objectContaining({
        reason: "issue_comment_mentioned",
      }),
    );
  });

  it("rejects agent issue comments with invalid run context before persisting", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: "todo",
      }),
    );

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID, "chat-run-not-a-uuid")))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "This should not persist." });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Run context is not valid for this issue" });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.comment_added" }),
    );
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

  it("does not wake the assignee for ordinary comments on backlog issues", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: "backlog",
      }),
    );

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "parking this for later" });

    expect(res.status).toBe(201);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("wakes only mentioned agents for comments on backlog issues", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: "backlog",
      }),
    );
    mockIssueService.findMentionedAgents.mockResolvedValue([PEER_AGENT_ID]);

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "@Peer Agent can you look at the UX?" });

    expect(res.status).toBe(201);
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      PEER_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_comment_mentioned",
      }),
    );
  });

  it("keeps ordinary comment mentions as notification-only without reassigning user-owned issues", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        status: "todo",
      }),
    );
    mockIssueService.findMentionedAgents.mockResolvedValue([PEER_AGENT_ID]);

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "@Peer Agent can you take a look?" });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      PEER_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_comment_mentioned",
        contextSnapshot: expect.objectContaining({
          wakeSource: "comment.mention",
          wakeReason: "issue_comment_mentioned",
        }),
      }),
    );
  });

  it("treats comment plus explicit assignee change as an ownership handoff instead of a mention wake", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        status: "todo",
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        assigneeAgentId: patch.assigneeAgentId as string,
        assigneeUserId: null,
        status: "todo",
      }),
    );
    mockIssueService.findMentionedAgents.mockResolvedValue([PEER_AGENT_ID]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        comment: "@Peer Agent please own this one.",
        assigneeAgentId: PEER_AGENT_ID,
        assigneeUserId: null,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: PEER_AGENT_ID,
        assigneeUserId: null,
      }),
    );
    await flushAsyncWork();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      PEER_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        contextSnapshot: expect.objectContaining({
          wakeSource: "assignment",
          wakeReason: "issue_assigned",
        }),
      }),
    );
  });

  it("does not fan out mention wakeups from agent-authored issue update comments", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: "in_progress",
        checkoutRunId: RUN_ID,
        executionRunId: RUN_ID,
      }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      makeIssue({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: (patch.status as string | undefined) ?? "in_progress",
        checkoutRunId: RUN_ID,
        executionRunId: RUN_ID,
      }),
    );
    mockIssueService.findMentionedAgents.mockResolvedValue([PEER_AGENT_ID]);

    const res = await request(createApp(createAgentActor(ASSIGNEE_AGENT_ID, RUN_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "@Peer Agent I handled the review feedback." });

    expect(res.status).toBe(200);
    await flushAsyncWork();
    expect(mockIssueService.findMentionedAgents).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects issue completion from a mention-only agent run that does not own the issue", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        status: "todo",
      }),
    );
    mockHeartbeatService.getRun.mockResolvedValue({
      id: PEER_RUN_ID,
      orgId: "organization-1",
      agentId: PEER_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: "11111111-1111-4111-8111-111111111111", wakeSource: "comment.mention" },
    });

    const res = await request(createApp(createAgentActor(PEER_AGENT_ID, PEER_RUN_ID)))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only the checked-out assignee or reviewer can complete issue" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
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
