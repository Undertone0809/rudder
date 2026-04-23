import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
}));
const mockBudgetService = vi.hoisted(() => ({}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  list: vi.fn(),
  listRuntimeSkillEntries: vi.fn(),
  mergeWithRequiredSkillKeys: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
  getEnabledSkillKeysForAgent: vi.fn(),
  buildAgentSkillSnapshot: vi.fn(),
  resolveDesiredSkillSelectionForAgent: vi.fn(),
  replaceEnabledSkillKeysForAgent: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockAdapter = vi.hoisted(() => ({
  listSkills: vi.fn(),
  syncSkills: vi.fn(),
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
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../agent-runtimes/index.js", () => ({
  findServerAdapter: vi.fn(() => mockAdapter),
  listAgentRuntimeModels: vi.fn(),
}));

function createDb(requireBoardApprovalForNewAgents = false) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "organization-1",
            requireBoardApprovalForNewAgents,
          },
        ]),
      })),
    })),
  };
}

function createApp(db: Record<string, unknown> = createDb()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      orgIds: ["organization-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

function makeAgent(agentRuntimeType: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "organization-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    agentRuntimeType,
    agentRuntimeConfig: {},
    runtimeConfig: {},
    permissions: null,
    updatedAt: new Date(),
  };
}

function normalizeDesiredSkillSelectionRefs(agentRuntimeType: string, requested: string[]) {
  return Array.from(new Set(requested.flatMap((value) => {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed === "rudder" || trimmed === "rudder/rudder" || trimmed === "bundled:rudder/rudder") {
      return [];
    }
    if (trimmed === "alpha-test" || trimmed === "organization/organization-1/alpha-test") {
      return ["org:organization/organization-1/alpha-test"];
    }
    if (trimmed === "build-advisor") {
      return [`adapter:${agentRuntimeType}:build-advisor`];
    }
    if (
      trimmed.startsWith("org:")
      || trimmed.startsWith("global:")
      || trimmed.startsWith("adapter:")
      || trimmed.startsWith("bundled:")
    ) {
      return trimmed.startsWith("bundled:") ? [] : [trimmed];
    }
    return [];
  }))).sort((left, right) => left.localeCompare(right));
}

function buildMockSkillSnapshot(agentRuntimeType: string, desiredSkills: string[]) {
  const mode = agentRuntimeType === "claude_local" || agentRuntimeType === "opencode_local"
    ? "ephemeral"
    : "persistent";
  const hasBuildAdvisor = desiredSkills.includes(`adapter:${agentRuntimeType}:build-advisor`);
  return {
    agentRuntimeType,
    supported: true,
    mode,
    desiredSkills,
    entries: [
      {
        key: "rudder",
        selectionKey: "bundled:rudder/rudder",
        runtimeName: "rudder",
        description: "Bundled Rudder skill",
        desired: true,
        configurable: false,
        alwaysEnabled: true,
        managed: true,
        state: "configured",
        sourceClass: "bundled",
        origin: "organization_managed",
        originLabel: "Bundled by Rudder",
      },
      {
        key: "alpha-test",
        selectionKey: "org:organization/organization-1/alpha-test",
        runtimeName: "alpha-test",
        description: "Alpha Test",
        desired: desiredSkills.includes("org:organization/organization-1/alpha-test"),
        configurable: true,
        alwaysEnabled: false,
        managed: true,
        state: desiredSkills.includes("org:organization/organization-1/alpha-test") ? "configured" : "available",
        sourceClass: "organization",
        origin: "organization_managed",
        originLabel: "Organization skill",
      },
      {
        key: "build-advisor",
        selectionKey: `adapter:${agentRuntimeType}:build-advisor`,
        runtimeName: "build-advisor",
        description: "External build advisor skill.",
        desired: hasBuildAdvisor,
        configurable: true,
        alwaysEnabled: false,
        managed: false,
        state: hasBuildAdvisor ? "configured" : "external",
        sourceClass: "adapter_home",
        origin: "user_installed",
        originLabel: "Adapter skill",
        locationLabel: "~/.claude/skills",
      },
    ],
    warnings: [],
  };
}

describe("agent skill routes", () => {
  let enabledSkillState: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    enabledSkillState = [];
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: makeAgent("claude_local"),
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({ config: { env: {} } });
    mockCompanySkillService.list.mockResolvedValue([
      {
        id: "skill-rudder",
        orgId: "organization-1",
        key: "rudder/rudder",
        slug: "rudder",
        name: "rudder",
        sourceBadge: "rudder",
      },
    ]);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([
      {
        key: "rudder/rudder",
        runtimeName: "rudder",
        source: "/tmp/rudder",
      },
    ]);
    mockCompanySkillService.mergeWithRequiredSkillKeys.mockImplementation(
      async (_orgId: string, skillKeys: string[]) =>
        Array.from(new Set(["rudder/rudder", ...skillKeys])).sort((left, right) => left.localeCompare(right)),
    );
    mockCompanySkillService.getEnabledSkillKeysForAgent.mockImplementation(
      async () => enabledSkillState,
    );
    mockCompanySkillService.replaceEnabledSkillKeysForAgent.mockImplementation(
      async (_orgId: string, _agentId: string, skillKeys: string[]) => {
        enabledSkillState = skillKeys;
        return enabledSkillState;
      },
    );
    mockCompanySkillService.resolveDesiredSkillSelectionForAgent.mockImplementation(
      async (agent: { agentRuntimeType: string }, _runtimeConfig: Record<string, unknown>, requested: string[] | undefined) => ({
        desiredSkills: normalizeDesiredSkillSelectionRefs(agent.agentRuntimeType, requested ?? []),
        warnings: [],
      }),
    );
    mockCompanySkillService.buildAgentSkillSnapshot.mockImplementation(
      async (agent: { agentRuntimeType: string }) => buildMockSkillSnapshot(agent.agentRuntimeType, enabledSkillState),
    );
    mockAdapter.listSkills.mockResolvedValue({
      agentRuntimeType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["rudder/rudder"],
      entries: [],
      warnings: [],
    });
    mockAdapter.syncSkills.mockResolvedValue({
      agentRuntimeType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["rudder/rudder"],
      entries: [],
      warnings: [],
    });
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent("claude_local"),
      agentRuntimeConfig: patch.agentRuntimeConfig ?? {},
    }));
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      ...makeAgent(String(input.agentRuntimeType ?? "claude_local")),
      ...input,
      agentRuntimeConfig: input.agentRuntimeConfig ?? {},
      runtimeConfig: input.runtimeConfig ?? {},
      budgetMonthlyCents: Number(input.budgetMonthlyCents ?? 0),
      permissions: null,
    }));
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "approval-1",
      orgId: "organization-1",
      type: "hire_agent",
      status: "pending",
      payload: input.payload ?? {},
    }));
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
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  });

  it("skips runtime materialization when listing Claude skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?orgId=organization-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.buildAgentSkillSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntimeType: "claude_local" }),
      expect.objectContaining({ env: {} }),
    );
    expect(mockAdapter.listSkills).not.toHaveBeenCalled();
  });

  it("keeps runtime materialization for persistent skill adapters", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("codex_local"));

    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?orgId=organization-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.buildAgentSkillSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ agentRuntimeType: "codex_local" }),
      expect.objectContaining({ env: {} }),
    );
  });

  it("skips runtime materialization when syncing Claude skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(createApp())
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?orgId=organization-1")
      .send({ desiredSkills: ["rudder/rudder"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.replaceEnabledSkillKeysForAgent).toHaveBeenCalledWith(
      "organization-1",
      "11111111-1111-4111-8111-111111111111",
      [],
    );
    expect(mockAdapter.syncSkills).not.toHaveBeenCalled();
  });

  it("canonicalizes desired skill references before syncing", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(createApp())
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?orgId=organization-1")
      .send({ desiredSkills: ["rudder"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.replaceEnabledSkillKeysForAgent).toHaveBeenCalledWith(
      "organization-1",
      "11111111-1111-4111-8111-111111111111",
      [],
    );
  });

  it("accepts explicitly enabled user-installed skills when the adapter exposes an ephemeral managed surface", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(createApp())
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?orgId=organization-1")
      .send({ desiredSkills: ["build-advisor"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.replaceEnabledSkillKeysForAgent).toHaveBeenCalledWith(
      "organization-1",
      "11111111-1111-4111-8111-111111111111",
      ["adapter:claude_local:build-advisor"],
    );
  });

  it("keeps bundled Rudder skills enabled when users clear optional skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await request(createApp())
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?orgId=organization-1")
      .send({ desiredSkills: [] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.replaceEnabledSkillKeysForAgent).toHaveBeenCalledWith(
      "organization-1",
      "11111111-1111-4111-8111-111111111111",
      [],
    );
  });

  it("persists canonical desired skills when creating an agent directly", async () => {
    const res = await request(createApp())
      .post("/api/orgs/organization-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        agentRuntimeType: "claude_local",
        desiredSkills: ["rudder"],
        agentRuntimeConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        agentRuntimeConfig: {},
      }),
    );
    expect(mockCompanySkillService.replaceEnabledSkillKeysForAgent).toHaveBeenCalledWith(
      "organization-1",
      "11111111-1111-4111-8111-111111111111",
      [],
    );
  });

  it("allows direct agent creation without an explicit name", async () => {
    const res = await request(createApp())
      .post("/api/orgs/organization-1/agents")
      .send({
        role: "engineer",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const createInput = mockAgentService.create.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
    expect(createInput).toBeDefined();
    expect(createInput).not.toHaveProperty("name");
  });

  it("materializes a managed AGENTS.md for directly created local agents", async () => {
    const res = await request(createApp())
      .post("/api/orgs/organization-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {
          promptTemplate: "You are QA.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        agentRuntimeType: "claude_local",
      }),
      expect.objectContaining({
        "AGENTS.md": "You are QA.",
        "HEARTBEAT.md": expect.any(String),
        "SOUL.md": expect.any(String),
        "TOOLS.md": expect.any(String),
      }),
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        agentRuntimeConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/11111111-1111-4111-8111-111111111111/instructions/AGENTS.md",
        }),
      }),
    );
    expect(mockAgentService.update.mock.calls.at(-1)?.[1]).not.toMatchObject({
      agentRuntimeConfig: expect.objectContaining({
        promptTemplate: expect.anything(),
      }),
    });
  });

  it("materializes the bundled CEO instruction set for default CEO agents", async () => {
    const res = await request(createApp())
      .post("/api/orgs/organization-1/agents")
      .send({
        name: "CEO",
        role: "ceo",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        role: "ceo",
        agentRuntimeType: "claude_local",
      }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("You are the CEO."),
        "HEARTBEAT.md": expect.stringContaining("CEO Heartbeat Checklist"),
        "SOUL.md": expect.stringContaining("CEO Persona"),
        "TOOLS.md": expect.stringContaining("# Tools"),
      }),
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
    const ceoBundle = mockAgentInstructionsService.materializeManagedBundle.mock.calls[0]?.[1] as Record<string, string>;
    expect(ceoBundle["AGENTS.md"]).toContain(
      "When you write issue comments or chat replies, match the language of the user's or board's most recent substantive message unless they explicitly ask for a different language.",
    );
    expect(ceoBundle["AGENTS.md"]).toContain(
      "Use them when you need a refresh, when the task context changes, or when you are editing the system itself.",
    );
    expect(ceoBundle["AGENTS.md"]).not.toContain("These files are essential. Read them.");
  });

  it("materializes the bundled default instruction set for non-CEO agents with no prompt template", async () => {
    const res = await request(createApp())
      .post("/api/orgs/organization-1/agents")
      .send({
        name: "Engineer",
        role: "engineer",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        role: "engineer",
        agentRuntimeType: "claude_local",
      }),
      expect.objectContaining({
        "AGENTS.md": expect.stringContaining("Keep the work moving until it's done."),
      }),
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
    const defaultBundle = mockAgentInstructionsService.materializeManagedBundle.mock.calls[0]?.[1] as Record<string, string>;
    expect(defaultBundle["AGENTS.md"]).toContain(
      "When you write issue comments or chat replies, match the language of the user's or board's most recent substantive message unless they explicitly ask for a different language.",
    );
  });

  it("includes canonical desired skills in hire approvals", async () => {
    const db = createDb(true);

    const res = await request(createApp(db))
      .post("/api/orgs/organization-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        agentRuntimeType: "claude_local",
        desiredSkills: ["rudder"],
        agentRuntimeConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.replaceEnabledSkillKeysForAgent).toHaveBeenCalledWith(
      "organization-1",
      "11111111-1111-4111-8111-111111111111",
      [],
    );
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          desiredSkills: [],
          requestedConfigurationSnapshot: expect.objectContaining({
            desiredSkills: [],
          }),
        }),
      }),
    );
  });

  it("stores the assigned agent name in hire approvals when the request omits one", async () => {
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      ...makeAgent(String(input.agentRuntimeType ?? "claude_local")),
      ...input,
      name: "Nia",
      status: "pending_approval",
      agentRuntimeConfig: input.agentRuntimeConfig ?? {},
      runtimeConfig: input.runtimeConfig ?? {},
      budgetMonthlyCents: Number(input.budgetMonthlyCents ?? 0),
      permissions: null,
    }));
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent("claude_local"),
      name: "Nia",
      agentRuntimeConfig: patch.agentRuntimeConfig ?? {},
      runtimeConfig: {},
    }));

    const res = await request(createApp(createDb(true)))
      .post("/api/orgs/organization-1/agent-hires")
      .send({
        role: "engineer",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          name: "Nia",
        }),
      }),
    );
  });

  it("uses managed AGENTS config in hire approval payloads", async () => {
    const res = await request(createApp(createDb(true)))
      .post("/api/orgs/organization-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {
          promptTemplate: "You are QA.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          agentRuntimeConfig: expect.objectContaining({
            instructionsBundleMode: "managed",
            instructionsEntryFile: "AGENTS.md",
            instructionsFilePath: "/tmp/11111111-1111-4111-8111-111111111111/instructions/AGENTS.md",
          }),
        }),
      }),
    );
    const approvalInput = mockApprovalService.create.mock.calls.at(-1)?.[1] as
      | { payload?: { agentRuntimeConfig?: Record<string, unknown> } }
      | undefined;
    expect(approvalInput?.payload?.agentRuntimeConfig?.promptTemplate).toBeUndefined();
  });
});
