import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

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
  reportsTo: null,
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
  getChainOfCommand: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  resolveByReference: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeKey: vi.fn(),
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
  hasLocalPathSkills: vi.fn(),
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
  resolveDesiredSkillSelectionForAgent: vi.fn(),
  buildAgentSkillSnapshot: vi.fn(),
  replaceEnabledSkillKeysForAgent: vi.fn(),
  getEnabledSkillKeysForAgent: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockRunClaudeLogin = vi.hoisted(() => vi.fn());

vi.mock("@rudderhq/agent-runtime-claude-local/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rudderhq/agent-runtime-claude-local/server")>()),
  runClaudeLogin: mockRunClaudeLogin,
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

function createDbStub(options?: {
  schedulerRows?: Array<Record<string, unknown>>;
}) {
  const schedulerRows = options?.schedulerRows ?? [];
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
        innerJoin: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(schedulerRows),
        }),
      }),
    }),
  };
}

function createApp(
  actor: Record<string, unknown>,
  options?: {
    schedulerRows?: Array<Record<string, unknown>>;
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub(options) as any));
  app.use(errorHandler);
  return app;
}

describe("agent permission routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.getInternalById.mockResolvedValue(null);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.getConfigRevision.mockResolvedValue(null);
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
    mockCompanySkillService.hasLocalPathSkills.mockResolvedValue(false);
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
    mockRunClaudeLogin.mockResolvedValue({ status: "completed" });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("restricts Claude login to instance admins before loading an agent", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "organization-member",
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    })).post(`/api/agents/${agentId}/claude-login`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Instance admin access required" });
    expect(mockAgentService.getById).not.toHaveBeenCalled();
    expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
    expect(mockRunClaudeLogin).not.toHaveBeenCalled();
  });

  it.each(["pending_approval", "terminated"])(
    "rejects %s agents before resolving Claude runtime configuration",
    async (status) => {
      mockAgentService.getById.mockResolvedValue({
        ...baseAgent,
        status,
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {
          command: "sh -lc 'touch /tmp/rudder-claude-login-rce'",
        },
      });

      const res = await request(createApp({
        type: "board",
        userId: "instance-admin",
        source: "session",
        isInstanceAdmin: true,
        orgIds: [orgId],
      })).post(`/api/agents/${agentId}/claude-login`);

      expect(res.status).toBe(409);
      expect(res.body.error).toContain(status);
      expect(mockSecretService.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
      expect(mockRunClaudeLogin).not.toHaveBeenCalled();
    },
  );

  it("allows an instance admin to run Claude login for an approved active agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      status: "idle",
      agentRuntimeType: "claude_local",
      agentRuntimeConfig: { command: "claude" },
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: { command: "/trusted/claude" },
    });

    const res = await request(createApp({
      type: "board",
      userId: "instance-admin",
      source: "session",
      isInstanceAdmin: true,
      orgIds: [orgId],
    })).post(`/api/agents/${agentId}/claude-login`);

    expect(res.status).toBe(200);
    expect(mockRunClaudeLogin).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({ id: agentId, orgId }),
      config: { command: "/trusted/claude" },
    }));
  });

  it("replays deferred paused wakeups when an agent is resumed", async () => {
    mockAgentService.resume.mockResolvedValue({
      ...baseAgent,
      status: "idle",
    });

    const app = createApp({
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

  it("omits system-managed copilot agents from instance scheduler heartbeats", async () => {
    const app = createApp(
      {
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
        orgIds: [orgId],
      },
      {
        schedulerRows: [
          {
            id: agentId,
            orgId,
            agentName: "Builder",
            role: "engineer",
            title: "Builder",
            status: "idle",
            agentRuntimeType: "codex_local",
            runtimeConfig: {
              heartbeat: {
                enabled: true,
                intervalSec: 300,
              },
            },
            lastHeartbeatAt: null,
            metadata: null,
            organizationName: "Rudder",
            organizationIssuePrefix: "R",
          },
          {
            id: "33333333-3333-4333-8333-333333333333",
            orgId,
            agentName: "Rudder Copilot (system)",
            role: "engineer",
            title: "System-managed chat copilot",
            status: "idle",
            agentRuntimeType: "codex_local",
            runtimeConfig: {
              heartbeat: {
                enabled: true,
                intervalSec: 0,
              },
            },
            lastHeartbeatAt: null,
            metadata: {
              systemManaged: "rudder_copilot",
            },
            organizationName: "Rudder",
            organizationIssuePrefix: "R",
          },
        ],
      },
    );

    const res = await request(app).get("/api/instance/scheduler-heartbeats");
    const items = (Array.isArray(res.body) ? res.body : JSON.parse(res.text)) as Array<Record<string, unknown>>;

    expect(res.status).toBe(200);
    expect(items).toEqual([
      expect.objectContaining({
        id: agentId,
        agentName: "Builder",
        heartbeatEnabled: true,
        schedulerActive: true,
      }),
    ]);
  });

  it("grants tasks:assign by default when board creates a new agent", async () => {
    const app = createApp({
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

  it("rejects host filesystem instruction paths when a non-admin board member creates an agent", async () => {
    const app = createApp({
      type: "board",
      userId: "organization-member",
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    });

    const res = await request(app)
      .post(`/api/orgs/${orgId}/agents`)
      .send({
        name: "Unsafe Builder",
        role: "engineer",
        agentRuntimeType: "process",
        agentRuntimeConfig: {
          instructionsFilePath: "/etc/passwd",
        },
      });

    expect(res.status).toBe(403);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects explicit non-default runtimes when a non-admin board member directly creates an agent", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "organization-member",
      source: "session",
      isInstanceAdmin: false,
      orgIds: [orgId],
    }))
      .post(`/api/orgs/${orgId}/agents`)
      .send({
        name: "Configured Builder",
        role: "engineer",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      });

    expect(res.status).toBe(403);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("exposes explicit task assignment access on agent detail", async () => {
    mockAccessService.listPrincipalGrants.mockResolvedValue([
      {
        id: "grant-1",
        orgId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "tasks:assign",
        scope: null,
        grantedByUserId: "board-user",
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
        updatedAt: new Date("2026-03-19T00:00:00.000Z"),
      },
    ]);

    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      orgIds: [orgId],
    });

    const res = await request(app).get(`/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body.access.canAssignTasks).toBe(true);
    expect(res.body.access.taskAssignSource).toBe("explicit_grant");
  });

  it("exposes the instructions Library path for managed instruction bundles", async () => {
    mockAgentService.getInternalById.mockResolvedValue({
      ...baseAgent,
      workspaceKey: "builder--11111111",
    });

    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      orgIds: [orgId],
    });

    const res = await request(app).get(`/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body.workspaceKey).toBeUndefined();
    expect(res.body.instructionsLibraryPath).toBe("agents/builder--11111111/instructions");
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalledWith(expect.objectContaining({
      id: agentId,
      workspaceKey: "builder--11111111",
    }));
  });

  it("does not expose the instructions Library path for explicit external bundles", async () => {
    mockAgentInstructionsService.getBundle.mockResolvedValue({ mode: "external" });

    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      orgIds: [orgId],
    });

    const res = await request(app).get(`/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body.instructionsLibraryPath).toBeNull();
  });

  it("does not expose the instructions Library path for legacy external file configs", async () => {
    mockAgentService.getInternalById.mockResolvedValue({
      ...baseAgent,
      workspaceKey: "builder--11111111",
      agentRuntimeConfig: {
        instructionsFilePath: "/tmp/external-agent-instructions/AGENTS.md",
      },
    });
    mockAgentInstructionsService.getBundle.mockResolvedValue({ mode: "external" });

    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      orgIds: [orgId],
    });

    const res = await request(app).get(`/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body.instructionsLibraryPath).toBeNull();
    expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
  });

  it("does not let a legacy agents:create grant bypass an explicit agent creation denial", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);

    const app = createApp({
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

  it("keeps agent-initiated hires pending even when the organization normally skips approval", async () => {
    const creator = {
      ...baseAgent,
      permissions: { canCreateAgents: true, canManageSkills: true },
    };
    mockAgentService.getById.mockResolvedValue(creator);
    mockAgentService.create.mockImplementation(async (_orgId: string, input: Record<string, unknown>) => ({
      ...baseAgent,
      ...input,
      id: peerAgentId,
      orgId,
      agentRuntimeConfig: input.agentRuntimeConfig ?? {},
      runtimeConfig: input.runtimeConfig ?? {},
    }));
    mockApprovalService.create.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      orgId,
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(createApp({
      type: "agent",
      agentId,
      orgId,
      runId: "run-1",
    }))
      .post(`/api/orgs/${orgId}/agent-hires`)
      .send({
        name: "Pending Spawn",
        role: "general",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
        runtimeConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ status: "pending_approval" }),
    );
    expect(mockApprovalService.create).toHaveBeenCalled();
  });

  it("keeps configured hires from non-admin board members pending for privileged approval", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    mockAgentService.create.mockImplementation(async (_orgId: string, input: Record<string, unknown>) => ({
      ...baseAgent,
      ...input,
      id: peerAgentId,
      orgId,
      agentRuntimeConfig: input.agentRuntimeConfig ?? {},
      runtimeConfig: input.runtimeConfig ?? {},
    }));
    mockApprovalService.create.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      orgId,
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(createApp({
      type: "board",
      userId: "organization-member",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post(`/api/orgs/${orgId}/agent-hires`)
      .send({
        name: "Configured Spawn",
        role: "general",
        agentRuntimeType: "process",
        agentRuntimeConfig: { command: "sh -lc 'touch /tmp/rudder-hire-rce'" },
        runtimeConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({ status: "pending_approval" }),
    );
    expect(mockApprovalService.create).toHaveBeenCalled();
  });

  it("allows agent-authenticated profile edits but blocks runtime control-plane fields", async () => {
    mockAgentService.getInternalById.mockResolvedValue(baseAgent);
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...baseAgent,
      ...patch,
    }));
    const actor = {
      type: "agent",
      agentId,
      orgId,
      runId: "run-1",
    };

    const profileRes = await request(createApp(actor))
      .patch(`/api/agents/${agentId}`)
      .send({ title: "Updated Builder" });
    expect(profileRes.status, JSON.stringify(profileRes.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ title: "Updated Builder" }),
      expect.any(Object),
    );

    mockAgentService.update.mockClear();
    const runtimeRes = await request(createApp(actor))
      .patch(`/api/agents/${agentId}`)
      .send({
        agentRuntimeConfig: {
          workspaceRuntime: {
            services: [{ name: "host-command", command: "touch /tmp/rudder-rce" }],
          },
        },
      });
    expect(runtimeRes.status).toBe(403);
    expect(runtimeRes.body.error).toContain("blocked fields: agentRuntimeConfig");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects config revision rollback with agent authentication", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId,
      orgId,
      runId: "run-1",
    })).post(`/api/agents/${agentId}/config-revisions/77777777-7777-4777-8777-777777777777/rollback`);

    expect(res.status).toBe(403);
    expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
  });

  it("rejects cross-organization lifecycle and API key mutations", async () => {
    const app = createApp({
      type: "board",
      userId: "other-organization-member",
      orgIds: ["99999999-9999-4999-8999-999999999999"],
      source: "session",
      isInstanceAdmin: false,
    });

    const responses = await Promise.all([
      request(app).post(`/api/agents/${agentId}/pause`),
      request(app).post(`/api/agents/${agentId}/resume`),
      request(app).post(`/api/agents/${agentId}/terminate`),
      request(app).delete(`/api/agents/${agentId}`),
      request(app).get(`/api/agents/${agentId}/keys`),
      request(app).post(`/api/agents/${agentId}/keys`).send({ name: "stolen" }),
      request(app).delete(`/api/agents/${agentId}/keys/key-from-another-agent`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    expect(mockAgentService.pause).not.toHaveBeenCalled();
    expect(mockAgentService.resume).not.toHaveBeenCalled();
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
    expect(mockAgentService.remove).not.toHaveBeenCalled();
    expect(mockAgentService.listKeys).not.toHaveBeenCalled();
    expect(mockAgentService.createApiKey).not.toHaveBeenCalled();
    expect(mockAgentService.revokeKey).not.toHaveBeenCalled();
  });

  it("does not revoke an API key through a different agent path", async () => {
    mockAgentService.listKeys.mockResolvedValue([{ id: "owned-key", name: "default" }]);
    const res = await request(createApp({
      type: "board",
      userId: "organization-member",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    })).delete(`/api/agents/${agentId}/keys/key-from-another-agent`);

    expect(res.status).toBe(404);
    expect(mockAgentService.revokeKey).not.toHaveBeenCalled();
  });

  it("requires instance-admin authority to roll back to external instruction config", async () => {
    mockAgentService.getConfigRevision.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      afterConfig: {
        name: "Builder",
        agentRuntimeConfig: {
          instructionsBundleMode: "external",
          instructionsRootPath: "/etc",
          instructionsFilePath: "/etc/passwd",
        },
      },
    });

    const res = await request(createApp({
      type: "board",
      userId: "organization-member",
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
    })).post(`/api/agents/${agentId}/config-revisions/77777777-7777-4777-8777-777777777777/rollback`);

    expect(res.status).toBe(403);
    expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
  });

  it("allows instance admins to roll back to external instruction config", async () => {
    mockAgentService.getConfigRevision.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      afterConfig: {
        name: "Builder",
        agentRuntimeConfig: {
          instructionsBundleMode: "external",
          instructionsRootPath: "/srv/rudder-instructions",
          instructionsFilePath: "/srv/rudder-instructions/SOUL.md",
        },
      },
    });
    mockAgentService.rollbackConfigRevision.mockResolvedValue({
      ...baseAgent,
      agentRuntimeConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/srv/rudder-instructions",
        instructionsFilePath: "/srv/rudder-instructions/SOUL.md",
      },
    });

    const res = await request(createApp({
      type: "board",
      userId: "instance-admin",
      orgIds: [],
      source: "session",
      isInstanceAdmin: true,
    })).post(`/api/agents/${agentId}/config-revisions/77777777-7777-4777-8777-777777777777/rollback`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.rollbackConfigRevision).toHaveBeenCalled();
  });

  it("does not let a legacy agents:create grant expose agent configurations after explicit denial", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);

    const app = createApp({
      type: "agent",
      agentId,
      orgId,
      runId: "run-1",
    });

    const res = await request(app).get(`/api/orgs/${orgId}/agent-configurations`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Missing permission: can create agents" });
    expect(mockAccessService.hasPermission).not.toHaveBeenCalled();
    expect(mockAgentService.list).not.toHaveBeenCalled();
  });

  it("does not let same-org non-owner agent keys access another agent's custom integrations", async () => {
    const app = createApp({
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
    const app = createApp({
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

    const app = createApp({
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

  it("keeps task assignment enabled when agent creation privilege is enabled", async () => {
    mockAgentService.updatePermissions.mockResolvedValue({
      ...baseAgent,
      permissions: { canCreateAgents: true, canManageSkills: true },
    });

    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      orgIds: [orgId],
    });

    const res = await request(app)
      .patch(`/api/agents/${agentId}/permissions`)
      .send({ canCreateAgents: true, canManageSkills: true, canAssignTasks: false });

    expect(res.status).toBe(200);
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      orgId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "board-user",
    );
    expect(res.body.access.canAssignTasks).toBe(true);
    expect(res.body.access.taskAssignSource).toBe("agent_creator");
  });

  it("does not require clients to send skill management when updating other permissions", async () => {
    mockAgentService.updatePermissions.mockResolvedValue({
      ...baseAgent,
      permissions: { canCreateAgents: false, canManageSkills: false },
    });

    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      orgIds: [orgId],
    });

    const res = await request(app)
      .patch(`/api/agents/${agentId}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: true });

    expect(res.status).toBe(200);
    expect(mockAgentService.updatePermissions).toHaveBeenCalledWith(agentId, {
      canCreateAgents: false,
      canAssignTasks: true,
    });
    expect(res.body.permissions.canManageSkills).toBe(false);
  });
});
