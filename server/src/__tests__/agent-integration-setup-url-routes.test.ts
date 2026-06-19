import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    getMembership: vi.fn(),
    listPrincipalGrants: vi.fn(),
    ensureMembership: vi.fn(),
    setPrincipalPermission: vi.fn(),
  }),
  agentInstructionsService: () => ({
    getBundle: vi.fn(),
  }),
  agentService: () => mockAgentService,
  approvalService: () => ({ create: vi.fn() }),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({ linkManyForApproval: vi.fn() }),
  issueService: () => ({}),
  logActivity: vi.fn(),
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationSkillService: () => ({}),
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(),
    resolveAdapterConfigForRuntime: vi.fn(),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../agent-runtimes/index.js", () => ({
  findServerAdapter: vi.fn(() => null),
  listAgentRuntimeModels: vi.fn(),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeAgent() {
  return {
    id: agentId,
    orgId,
    name: "Builder",
    urlKey: "builder",
    role: "engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: {},
    permissions: { canCreateAgents: false, canManageSkills: true },
  };
}

describe("agent integration setup URL routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(makeAgent());
  });

  it("returns a browser-openable Feishu setup URL for board users", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .get(`/api/agents/${agentId}/integrations/feishu/setup-url?providerRegion=lark_global`)
      .set("Host", "rudder.example.test");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      provider: "feishu",
      providerRegion: "lark_global",
      expiresAt: null,
    });

    const setupUrl = new URL(res.body.setupUrl);
    expect(setupUrl.origin).toBe("https://open.larksuite.com");
    expect(setupUrl.searchParams.get("agentId")).toBe(agentId);
    expect(setupUrl.searchParams.get("orgId")).toBe(orgId);
    expect(setupUrl.searchParams.get("region")).toBe("lark_global");
    expect(setupUrl.searchParams.get("transport")).toBe("long_connection");
    expect(setupUrl.searchParams.get("callbackUrl")).toBe(
      `http://rudder.example.test/api/orgs/${orgId}/integrations/feishu/mock-inbound`,
    );
  });

  it("denies setup URL generation for agents from another organization", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-from-other-org",
      orgId: "33333333-3333-4333-8333-333333333333",
      source: "agent_key",
    }))
      .get(`/api/agents/${agentId}/integrations/feishu/setup-url`);

    expect(res.status).toBe(403);
  });
});
