import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { configureBrowserCapabilityDeployment } from "../services/browser-capability.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const mockAgentCore = vi.fn();

const agentId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const peerAgentId = "33333333-3333-4333-8333-333333333333";
const customIntegrationId = "44444444-4444-4444-8444-444444444444";
const customToolId = "55555555-5555-4555-8555-555555555555";

const baseAgent = {
  id: agentId,
  orgId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  capabilities: null,
  agentRuntimeType: "process",
  agentRuntimeConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false, canManageSkills: true },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getInternalById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
  resolveByReference: vi.fn(),
  resume: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resumeDeferredWakeupsForAgent: vi.fn(),
  resetRuntimeSession: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
}));
const mockAgentIntegrationService = vi.hoisted(() => ({
  listForAgent: vi.fn(),
  create: vi.fn(),
  revokeForAgent: vi.fn(),
}));
const mockCustomIntegrationService = vi.hoisted(() => ({
  listForAgent: vi.fn(),
  createForAgent: vi.fn(),
  updateBindingForAgent: vi.fn(),
  revokeForAgent: vi.fn(),
  recordToolCall: vi.fn(),
}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
  resolveDesiredSkillSelectionForAgent: vi.fn(),
  buildAgentSkillSnapshot: vi.fn(),
  replaceEnabledSkillKeysForAgent: vi.fn(),
  getEnabledSkillKeysForAgent: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockInstanceSettingsService = vi.hoisted(() => ({
  getBrowser: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  organizationSkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
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
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/integrations/agent-integrations.js", () => ({
  agentIntegrationService: () => mockAgentIntegrationService,
  summarizeAgentIntegration: vi.fn((row) => row),
}));

vi.mock("../services/integrations/custom-integrations.js", () => ({
  customIntegrationService: () => mockCustomIntegrationService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: orgId,
            name: "Rudder",
            requireBoardApprovalForNewAgents: false,
          }]),
        }),
      }),
    }),
  };
}

const activeServers = new Set<Server>();

async function createApp(
  actor: Record<string, unknown>,
) {
  const app = express();
  const db = createDbStub() as any;
  configureBrowserCapabilityDeployment(db, "local_trusted");
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db, undefined, { agentCore: mockAgentCore } as unknown as RustFoundationBridge));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

afterEach(async () => {
  await Promise.all(Array.from(activeServers, (server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  activeServers.clear();
});

describe("agent permission routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.getInternalById.mockResolvedValue(null);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAgentService.create.mockResolvedValue(baseAgent);
    mockAgentService.resume.mockResolvedValue(baseAgent);
    mockAgentService.updatePermissions.mockResolvedValue(baseAgent);
    mockAccessService.getMembership.mockResolvedValue({
      id: "membership-1",
      orgId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(async (_companyId, requested) => requested);
    mockCompanySkillService.replaceEnabledSkillKeysForAgent.mockResolvedValue(undefined);
    mockCompanySkillService.getEnabledSkillKeysForAgent.mockResolvedValue([]);
    mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
    mockHeartbeatService.resumeDeferredWakeupsForAgent.mockResolvedValue({
      replayed: 0,
      wakeupRequestIds: [],
    });
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>, files: Record<string, string>) => ({
        bundle: null,
        agentRuntimeConfig: {
          ...((agent.agentRuntimeConfig as Record<string, unknown> | undefined) ?? {}),
          instructionsBundleMode: "managed",
          instructionsRootPath: `/tmp/${String(agent.id)}/instructions`,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: `/tmp/${String(agent.id)}/instructions/AGENTS.md`,
          promptTemplate: files["AGENTS.md"] ?? "",
        },
      }),
    );
    mockAgentInstructionsService.getBundle.mockResolvedValue({ mode: "managed" });
    mockAgentIntegrationService.listForAgent.mockResolvedValue([]);
    mockInstanceSettingsService.getBrowser.mockResolvedValue({
      enabled: true,
      openLinksIn: "built_in",
    });
    mockCustomIntegrationService.listForAgent.mockResolvedValue([]);
    mockCustomIntegrationService.createForAgent.mockResolvedValue({ id: customIntegrationId });
    mockCustomIntegrationService.updateBindingForAgent.mockResolvedValue({ id: customIntegrationId });
    mockCustomIntegrationService.revokeForAgent.mockResolvedValue({ id: customIntegrationId });
    mockCustomIntegrationService.recordToolCall.mockResolvedValue({ id: "66666666-6666-4666-8666-666666666666" });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => requested,
    );
    mockCompanySkillService.resolveDesiredSkillSelectionForAgent.mockResolvedValue({
      desiredSkills: [],
      warnings: [],
    });
    mockCompanySkillService.buildAgentSkillSnapshot.mockResolvedValue({
      agentRuntimeType: "process",
      supported: true,
      mode: "persistent",
      desiredSkills: [],
      entries: [],
      warnings: [],
    });
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("replays deferred paused wakeups when an agent is resumed", async () => {
    mockAgentService.resume.mockResolvedValue({
      ...baseAgent,
      status: "idle",
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      orgIds: [orgId],
    });

    const res = await request(app).post(`/api/agents/${agentId}/resume`);

    expect(res.status).toBe(200);
    expect(mockAgentService.resume).toHaveBeenCalledWith(agentId);
    expect(mockHeartbeatService.resumeDeferredWakeupsForAgent).toHaveBeenCalledWith(agentId);
  });

  // System-copilot filtering is proved with persisted agents in the real Rust
  // fixture (agent-core-real-entry.test.ts, "preserves legacy scheduler").
  it("relays the Rust scheduler receipt and authenticated board actor", async () => {
    const actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true, orgIds: [orgId] };
    const rows = [{ id: agentId, agentName: "Builder", heartbeatEnabled: true, schedulerActive: true }];
    mockAgentCore.mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(rows)) });
    const app = await createApp(actor);

    const res = await request(app).get("/api/instance/scheduler-heartbeats");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    expect(mockAgentCore).toHaveBeenCalledExactlyOnceWith(actor, expect.objectContaining({ operation: "scheduler-heartbeats", orgId: null, id: null, query: {} }));
    expect(mockAgentService.list).not.toHaveBeenCalled();
  });

  it("grants tasks:assign by default when board creates a new agent", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      orgIds: [orgId],
    });

    const res = await request(app)
      .post(`/api/orgs/${orgId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
      });

    expect(res.status).toBe(201);
    expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
      orgId,
      "agent",
      agentId,
      "member",
      "active",
    );
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      orgId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "board-user",
    );
  });

  // Business assertions for these migrated routes execute against real Rust/PG
  // in agent-core-real-entry.test.ts, the "Agent detail" groups: explicit grant,
  // core/browser enabled/disabled/unsupported, restricted projection and all
  // managed/external/legacy Library paths. Here only the transport is mocked.
  it.each(["detail", "me", "permissions"])("relays %s receipts and trusted host facts without Node business callbacks", async (operation) => {
    const actor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true, orgIds: [orgId] };
    const receipt = { opaque: "native receipt", instructionsLibraryPath: null };
    mockAgentCore.mockResolvedValueOnce({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ orgId, id: agentId })) })
      .mockResolvedValueOnce({ status: 207, contentType: "application/json", body: Buffer.from(JSON.stringify(receipt)) });
    const app = await createApp(actor);
    const response = operation === "permissions"
      ? await request(app).patch(`/api/agents/${agentId}/permissions`).send({ canCreateAgents: false, canAssignTasks: true })
      : await request(app).get(operation === "me" ? "/api/agents/me" : `/api/agents/${agentId}`);
    expect(response.status).toBe(207);expect(response.body).toEqual(receipt);
    expect(mockAgentCore).toHaveBeenNthCalledWith(1,actor,expect.objectContaining({ operation, resolveOnly: true }));
    expect(mockAgentCore).toHaveBeenNthCalledWith(2,actor,expect.objectContaining({ operation, id:agentId, instructionsHost:expect.objectContaining({ instanceRoot:expect.any(String), workspaceHome:expect.any(String), hostname:expect.any(String) }) }));
    expect(mockAgentService.getById).not.toHaveBeenCalled();expect(mockAgentService.updatePermissions).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();expect(mockAccessService.setPrincipalPermission).not.toHaveBeenCalled();expect(mockInstanceSettingsService.getBrowser).not.toHaveBeenCalled();
  });

  it("does not let a legacy agents:create grant bypass an explicit agent creation denial", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);

    const app = await createApp({
      type: "agent",
      agentId,
      orgId,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/orgs/${orgId}/agent-hires`)
      .send({
        name: "Denied Spawn",
        role: "general",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
        runtimeConfig: {},
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Missing permission: can create agents" });
    expect(mockAccessService.hasPermission).not.toHaveBeenCalled();
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  // Explicit false taking precedence over an existing agents:create grant is
  // proved in PostgreSQL by the real Rust fixture ("preserves legacy explicit").
  it("relays Rust configuration permission denial without evaluating Node grants", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentCore.mockResolvedValue({ status: 403, contentType: "application/json", body: Buffer.from(JSON.stringify({ error: "Missing permission: can create agents" })) });
    const actor = { type: "agent", agentId, orgId, runId: "run-1" };
    const app = await createApp(actor);

    const res = await request(app).get(`/api/orgs/${orgId}/agent-configurations`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Missing permission: can create agents" });
    expect(mockAgentCore).toHaveBeenCalledExactlyOnceWith(actor, expect.objectContaining({ operation: "configurations", orgId, id: null, query: {} }));
    expect(mockAccessService.hasPermission).not.toHaveBeenCalled();
    expect(mockAgentService.list).not.toHaveBeenCalled();
  });

  it("does not let same-org non-owner agent keys access another agent's custom integrations", async () => {
    const app = await createApp({
      type: "agent",
      agentId: peerAgentId,
      orgId,
      runId: "run-1",
    });

    const createPayload = {
      scope: "agent",
      kind: "custom_api",
      displayName: "Private API",
      tools: [{ externalToolName: "lookup" }],
    };
    const bindPayload = { enabledToolIds: [customToolId] };
    const callPayload = { toolId: customToolId, input: { query: "acme" } };

    const listRes = await request(app).get(`/api/agents/${agentId}/custom-integrations`);
    const createRes = await request(app).post(`/api/agents/${agentId}/custom-integrations`).send(createPayload);
    const bindRes = await request(app)
      .patch(`/api/agents/${agentId}/custom-integrations/${customIntegrationId}/binding`)
      .send(bindPayload);
    const revokeRes = await request(app).delete(`/api/agents/${agentId}/custom-integrations/${customIntegrationId}`);
    const callRes = await request(app)
      .post(`/api/agents/${agentId}/custom-integrations/${customIntegrationId}/tool-calls`)
      .send(callPayload);

    expect(listRes.status).toBe(403);
    expect(createRes.status).toBe(403);
    expect(bindRes.status).toBe(403);
    expect(revokeRes.status).toBe(403);
    expect(callRes.status).toBe(403);
    expect(mockCustomIntegrationService.listForAgent).not.toHaveBeenCalled();
    expect(mockCustomIntegrationService.createForAgent).not.toHaveBeenCalled();
    expect(mockCustomIntegrationService.updateBindingForAgent).not.toHaveBeenCalled();
    expect(mockCustomIntegrationService.revokeForAgent).not.toHaveBeenCalled();
    expect(mockCustomIntegrationService.recordToolCall).not.toHaveBeenCalled();
  });

  it("lets an owner agent key access only its own custom integration runtime surface", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      orgId,
      runId: "run-1",
    });

    const listRes = await request(app).get(`/api/agents/${agentId}/custom-integrations`);
    const callRes = await request(app)
      .post(`/api/agents/${agentId}/custom-integrations/${customIntegrationId}/tool-calls`)
      .send({ toolId: customToolId, input: { query: "acme" } });

    expect(listRes.status).toBe(200);
    expect(callRes.status).toBe(202);
    expect(mockCustomIntegrationService.listForAgent).toHaveBeenCalledWith(orgId, agentId);
    expect(mockCustomIntegrationService.recordToolCall).toHaveBeenCalledWith(
      orgId,
      agentId,
      customIntegrationId,
      { toolId: customToolId, input: { query: "acme" } },
    );
  });

  it("does not let a legacy agents:create grant update another agent after explicit denial", async () => {
    const targetAgentId = "33333333-3333-4333-8333-333333333333";
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getInternalById.mockResolvedValue({
      ...baseAgent,
      id: targetAgentId,
      name: "Target",
    });

    const app = await createApp({
      type: "agent",
      agentId,
      orgId,
      runId: "run-1",
    });

    const res = await request(app)
      .patch(`/api/agents/${targetAgentId}`)
      .send({ title: "Updated Target" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only CEO or agent creators can modify other agents" });
    expect(mockAccessService.hasPermission).not.toHaveBeenCalledWith(
      orgId,
      "agent",
      agentId,
      "agents:create",
    );
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // Creator-implies-assignment and omitted canManageSkills preservation are
  // covered by the real Rust permission transaction group in the same fixture.
});
