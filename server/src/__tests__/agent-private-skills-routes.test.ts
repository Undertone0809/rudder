import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

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
  hasLocalPathSkills: vi.fn(),
  buildAgentSkillSnapshot: vi.fn(),
  createAgentPrivateSkill: vi.fn(),
  resolveDesiredSkillSelectionForAgent: vi.fn(),
  replaceEnabledSkillKeysForAgent: vi.fn(),
  getEnabledSkillKeysForAgent: vi.fn(),
  addEnabledSkillKeysForAgent: vi.fn(),
  listRuntimeSkillEntries: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_orgId: string, config: Record<string, unknown>) => config),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAdapterTestEnvironment = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn());

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
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../agent-runtimes/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
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
    permissions: { canCreateAgents: false, canManageSkills: true },
    updatedAt: new Date("2026-04-16T00:00:00.000Z"),
    ...overrides,
  };
}

describe("agent private skill routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({ config: { env: {} } });
    mockOrganizationSkillService.hasLocalPathSkills.mockResolvedValue(false);
    mockFindServerAdapter.mockReturnValue({
      testEnvironment: mockAdapterTestEnvironment,
    });
    mockAdapterTestEnvironment.mockResolvedValue({
      status: "pass",
      agentRuntimeType: "opencode_local",
      checks: [],
    });
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
      detail: "Installed, not enabled. Future runs will not load it until enabled.",
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

  it("blocks agents and ordinary board members from snapshots when local organization skills exist", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent(agentId));
    mockOrganizationSkillService.hasLocalPathSkills.mockResolvedValue(true);
    const agentApp = createApp({
      type: "agent",
      agentId,
      orgId,
      runId: "run-1",
    });
    const boardApp = createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const agentRes = await request(agentApp).get(`/api/agents/${agentId}/skills`);
    const boardRes = await request(boardApp).get(`/api/agents/${agentId}/skills`);

    expect(agentRes.status, JSON.stringify(agentRes.body)).toBe(403);
    expect(boardRes.status, JSON.stringify(boardRes.body)).toBe(403);
    expect(mockSecretService.resolveAdapterConfigForRuntime).toHaveBeenCalledTimes(2);
    expect(mockOrganizationSkillService.buildAgentSkillSnapshot).not.toHaveBeenCalled();
  });

  it("blocks non-admin enabled-skill mutations before local catalog resolution", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent(agentId));
    mockOrganizationSkillService.hasLocalPathSkills.mockResolvedValue(true);
    const app = createApp({
      type: "agent",
      agentId,
      orgId,
      runId: "run-1",
    });

    const syncRes = await request(app)
      .post(`/api/agents/${agentId}/skills/sync`)
      .send({ desiredSkills: ["org:linked-skill"] });
    const enableRes = await request(app)
      .post(`/api/agents/${agentId}/skills/enable`)
      .send({ skills: ["org:linked-skill"] });

    expect(syncRes.status, JSON.stringify(syncRes.body)).toBe(403);
    expect(enableRes.status, JSON.stringify(enableRes.body)).toBe(403);
    expect(mockOrganizationSkillService.resolveDesiredSkillSelectionForAgent).not.toHaveBeenCalled();
    expect(mockOrganizationSkillService.replaceEnabledSkillKeysForAgent).not.toHaveBeenCalled();
    expect(mockOrganizationSkillService.addEnabledSkillKeysForAgent).not.toHaveBeenCalled();
  });

  it("allows instance admins to inspect agents with local organization skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent(agentId));
    mockOrganizationSkillService.hasLocalPathSkills.mockResolvedValue(true);

    const res = await request(createApp({
      type: "board",
      userId: "admin-1",
      orgIds: [],
      source: "session",
      isInstanceAdmin: true,
    })).get(`/api/agents/${agentId}/skills`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockOrganizationSkillService.buildAgentSkillSnapshot).toHaveBeenCalled();
  });

  it("blocks agents from creating a private skill through a pre-planted workspace symlink", async () => {
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

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAgentService.getById).not.toHaveBeenCalled();
    expect(mockOrganizationSkillService.createAgentPrivateSkill).not.toHaveBeenCalled();
  });

  it("blocks ordinary organization board members from private host writes", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post(`/api/agents/${agentId}/skills/private`)
      .send({ name: "Linked Skill", slug: "linked-skill" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAgentService.getById).not.toHaveBeenCalled();
    expect(mockOrganizationSkillService.createAgentPrivateSkill).not.toHaveBeenCalled();
  });

  it("allows instance admins to create a private managed skill", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent(agentId));

    const res = await request(createApp({
      type: "board",
      userId: "admin-1",
      orgIds: [],
      source: "session",
      isInstanceAdmin: true,
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
      expect.objectContaining({ name: "Agent Helper", slug: "agent-helper" }),
    );
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

  it("blocks organization board users from testing a host adapter even with agents:create", async () => {
    mockAccessService.canUser.mockResolvedValue(true);

    const res = await request(createApp({
      type: "board",
      userId: "user-1",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post(`/api/orgs/${orgId}/adapters/opencode_local/test-environment`)
      .send({
        agentRuntimeConfig: {
          command: "/bin/sh",
          cwd: "/tmp/attacker-workspace",
          model: "attacker/model",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockAccessService.canUser).not.toHaveBeenCalled();
    expect(mockFindServerAdapter).not.toHaveBeenCalled();
    expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
    expect(mockAdapterTestEnvironment).not.toHaveBeenCalled();
  });

  it("allows an instance admin to enter the adapter environment test", async () => {
    const inputConfig = { command: "opencode", model: "provider/model" };

    const res = await request(createApp({
      type: "board",
      userId: "admin-1",
      orgIds: [],
      source: "session",
      isInstanceAdmin: true,
    }))
      .post(`/api/orgs/${orgId}/adapters/opencode_local/test-environment`)
      .send({ agentRuntimeConfig: inputConfig });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSecretService.normalizeAdapterConfigForPersistence).toHaveBeenCalledWith(
      orgId,
      inputConfig,
      { strictMode: false },
    );
    expect(mockAdapterTestEnvironment).toHaveBeenCalledWith({
      orgId,
      agentRuntimeType: "opencode_local",
      config: { env: {} },
    });
  });
});
