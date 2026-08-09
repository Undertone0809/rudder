import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  agentInstructionsService: () => ({}),
  agentService: () => ({}),
  approvalService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
  logActivity: vi.fn(),
  organizationSkillService: () => ({}),
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn(),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/assets.js", () => ({
  assetService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({}),
}));

vi.mock("../agent-runtimes/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAgentRuntimeModels: vi.fn(() => []),
}));

vi.mock("@rudderhq/agent-runtime-claude-local/server", () => ({
  runClaudeLogin: vi.fn(),
}));

vi.mock("@rudderhq/agent-runtime-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(),
}));

const activeServers = new Set<Server>();

async function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      orgId: "org-1",
      orgIds: ["org-1"],
      runId: "run-1",
    };
    next();
  });
  app.use("/api", agentRoutes({} as any, {} as any));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

function issue(overrides: Record<string, unknown>) {
  return {
    id: "issue-1",
    identifier: "RUD-1",
    title: "Issue",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    updatedAt: new Date("2026-05-07T10:00:00.000Z"),
    activeRun: null,
    ...overrides,
  };
}

describe("agent inbox reviewer rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
  });

  it("returns assignee and reviewer work with relationships", async () => {
    mockIssueService.list
      .mockResolvedValueOnce([
        issue({
          id: "assignee-issue",
          identifier: "RUD-1",
          title: "Implement fix",
          status: "in_progress",
          priority: "medium",
          updatedAt: new Date("2026-05-07T11:00:00.000Z"),
        }),
        issue({
          id: "blocked-review-issue",
          identifier: "RUD-3",
          title: "Review blocker",
          status: "blocked",
          priority: "low",
          updatedAt: new Date("2026-05-07T08:00:00.000Z"),
        }),
      ])
      .mockResolvedValueOnce([
        issue({
          id: "review-issue",
          identifier: "RUD-2",
          title: "Review fix",
          status: "in_review",
          priority: "high",
          updatedAt: new Date("2026-05-07T09:00:00.000Z"),
        }),
        issue({
          id: "blocked-review-issue",
          identifier: "RUD-3",
          title: "Review blocker",
          status: "blocked",
          priority: "low",
          updatedAt: new Date("2026-05-07T08:00:00.000Z"),
        }),
      ]);

    const res = await request(await createApp()).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenNthCalledWith(1, "org-1", {
      assigneeAgentId: "agent-1",
      includeAutomationExecutions: true,
      status: "todo,in_progress,blocked",
    });
    expect(mockIssueService.list).toHaveBeenNthCalledWith(2, "org-1", {
      includeAutomationExecutions: true,
      reviewerAgentId: "agent-1",
      status: "in_review,blocked",
      excludeReviewerRecordedBlockedDecision: true,
    });
    expect(res.body).toMatchObject([
      {
        id: "review-issue",
        relationship: "reviewer",
        status: "in_review",
      },
      {
        id: "assignee-issue",
        relationship: "assignee",
        status: "in_progress",
      },
      {
        id: "blocked-review-issue",
        relationship: "reviewer",
        status: "blocked",
      },
    ]);
    expect(res.body).toHaveLength(3);
  });
});
