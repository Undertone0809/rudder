import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";

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
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
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
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
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
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
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

  it("keeps task assignment enabled when agent creation privilege is enabled", async () => {
    mockAgentService.updatePermissions.mockResolvedValue({
      ...baseAgent,
      permissions: { canCreateAgents: true },
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
      .send({ canCreateAgents: true, canAssignTasks: false });

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
});
