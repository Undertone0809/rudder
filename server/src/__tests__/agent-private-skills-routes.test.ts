import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const peerAgentId = "33333333-3333-4333-8333-333333333333";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockOrganizationSkillService = vi.hoisted(() => ({
  buildAgentSkillSnapshot: vi.fn(),
  createAgentPrivateSkill: vi.fn(),
  resolveDesiredSkillSelectionForAgent: vi.fn(),
  replaceEnabledSkillKeysForAgent: vi.fn(),
  getEnabledSkillKeysForAgent: vi.fn(),
  listRuntimeSkillEntries: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_orgId: string, config: Record<string, unknown>) => config),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({
    getBundle: vi.fn(),
    readFile: vi.fn(),
    updateBundle: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    exportFiles: vi.fn(),
    ensureManagedBundle: vi.fn(),
    materializeManagedBundle: vi.fn(),
  }),
  accessService: () => mockAccessService,
  approvalService: () => ({ create: vi.fn() }),
  organizationSkillService: () => mockOrganizationSkillService,
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({ linkManyForApproval: vi.fn() }),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
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

function makeAgent(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    orgId,
    name: id === agentId ? "Builder" : "Peer",
    urlKey: id === agentId ? "builder" : "peer",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: {},
    permissions: { canCreateAgents: false },
    updatedAt: new Date("2026-04-16T00:00:00.000Z"),
    ...overrides,
  };
}

describe("agent private skill routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({ config: { env: {} } });
    mockOrganizationSkillService.buildAgentSkillSnapshot.mockResolvedValue({
      agentRuntimeType: "codex_local",
      supported: true,
      mode: "persistent",
      desiredSkills: [],
      entries: [],
      warnings: [],
    });
    mockOrganizationSkillService.createAgentPrivateSkill.mockResolvedValue({
      key: "agent-helper",
      selectionKey: "agent:agent-helper",
      runtimeName: "agent-helper",
      description: "Private helper skill.",
      desired: false,
      configurable: true,
      alwaysEnabled: false,
      managed: false,
      state: "external",
      sourceClass: "agent_home",
      origin: "user_installed",
      originLabel: "Agent skill",
      locationLabel: "AGENT_HOME/skills",
      sourcePath: "/tmp/agent-helper",
      targetPath: null,
      detail: "Created in AGENT_HOME/skills.",
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("allows same-agent auth to read its own skill snapshot", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent(agentId));

    const res = await request(createApp({
      type: "agent",
      agentId,
      orgId,
      runId: "run-1",
    })).get(`/api/agents/${agentId}/skills`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockOrganizationSkillService.buildAgentSkillSnapshot).toHaveBeenCalled();
  });

  it("allows an agent to create a private skill for itself", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent(agentId));

    const res = await request(createApp({
      type: "agent",
      agentId,
      orgId,
      runId: "run-1",
    }))
      .post(`/api/agents/${agentId}/skills/private`)
      .send({
        name: "Agent Helper",
        slug: "agent-helper",
        description: "Private helper skill.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockOrganizationSkillService.createAgentPrivateSkill).toHaveBeenCalledWith(
      orgId,
      agentId,
      expect.objectContaining({
        name: "Agent Helper",
        slug: "agent-helper",
        description: "Private helper skill.",
      }),
    );
    expect(res.body).toMatchObject({
      key: "agent-helper",
      selectionKey: "agent:agent-helper",
      sourceClass: "agent_home",
    });
  });

  it("blocks a non-privileged agent from creating a private skill for a peer", async () => {
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === peerAgentId) return makeAgent(peerAgentId);
      if (id === agentId) return makeAgent(agentId);
      return null;
    });

    const res = await request(createApp({
      type: "agent",
      agentId,
      orgId,
      runId: "run-1",
    }))
      .post(`/api/agents/${peerAgentId}/skills/private`)
      .send({
        name: "Peer Helper",
        slug: "peer-helper",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockOrganizationSkillService.createAgentPrivateSkill).not.toHaveBeenCalled();
  });
});
