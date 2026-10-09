import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const mockAgentCore = vi.fn();

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

async function createApp(withBridge = true) {
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
  app.use("/api", agentRoutes({} as any, {} as any, withBridge ? { agentCore: mockAgentCore } as unknown as RustFoundationBridge : undefined));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
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

  // Business selection, deduplication and ordering are exercised against actual
  // Rust + PostgreSQL in agent-core-real-entry.test.ts ("preserves legacy inbox").
  it("relays the Rust inbox result and authenticated actor without querying Node issue policy", async () => {
    const rows = [
      { id: "review-issue", relationship: "reviewer", status: "in_review" },
      { id: "assignee-issue", relationship: "assignee", status: "in_progress" },
      { id: "blocked-review-issue", relationship: "reviewer", status: "blocked" },
    ];
    mockAgentCore.mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(rows)) });

    const res = await request(await createApp()).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    expect(mockAgentCore).toHaveBeenCalledExactlyOnceWith(
      { type: "agent", agentId: "agent-1", orgId: "org-1", orgIds: ["org-1"], runId: "run-1" },
      expect.objectContaining({ operation: "inbox", orgId: null, id: null, query: {} }),
    );
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("fails closed without a Rust bridge and never falls back to Node issue queries", async () => {
    const res = await request(await createApp(false)).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Rust Agent core is unavailable", code: "rust_foundation_agent_core_unavailable" });
    expect(mockAgentCore).not.toHaveBeenCalled();
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });
});
