import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getInternalById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  reconcileBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn((_agent, config) => config));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  organizationSkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => ({}),
}));

vi.mock("../agent-runtimes/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAgentRuntimeModels: vi.fn(),
}));

function createApp() {
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
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeAgent() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "organization-1",
    name: "Agent",
    workspaceKey: "agent--11111111",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: {},
    permissions: null,
    updatedAt: new Date(),
  };
}

describe("agent instructions bundle routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.getInternalById.mockResolvedValue(makeAgent());
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent(),
      agentRuntimeConfig: patch.agentRuntimeConfig ?? {},
    }));
    mockAgentInstructionsService.getBundle.mockResolvedValue({
      agentId: "11111111-1111-4111-8111-111111111111",
      orgId: "organization-1",
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
      resolvedEntryPath: "/tmp/agent-1/AGENTS.md",
      editable: true,
      warnings: [],
      legacyPromptTemplateActive: false,
      legacyBootstrapPromptTemplateActive: false,
      files: [{
        path: "AGENTS.md",
        size: 12,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
      }],
    });
    mockAgentInstructionsService.reconcileBundle.mockResolvedValue({
      bundle: {
        agentId: "11111111-1111-4111-8111-111111111111",
        orgId: "organization-1",
        mode: "managed",
        rootPath: "/tmp/agent-1",
        managedRootPath: "/tmp/agent-1",
        entryFile: "AGENTS.md",
        resolvedEntryPath: "/tmp/agent-1/AGENTS.md",
        editable: true,
        warnings: [],
        legacyPromptTemplateActive: false,
        legacyBootstrapPromptTemplateActive: false,
        files: [{
          path: "AGENTS.md",
          size: 12,
          language: "markdown",
          markdown: true,
          isEntryFile: true,
          editable: true,
          deprecated: false,
          virtual: false,
        }],
      },
      agentRuntimeConfig: {},
      changed: false,
    });
    mockAgentInstructionsService.readFile.mockResolvedValue({
      path: "AGENTS.md",
      size: 12,
      language: "markdown",
      markdown: true,
      isEntryFile: true,
      editable: true,
      deprecated: false,
      virtual: false,
      content: "# Agent\n",
    });
    mockAgentInstructionsService.writeFile.mockResolvedValue({
      bundle: null,
      file: {
        path: "AGENTS.md",
        size: 18,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
        content: "# Updated Agent\n",
      },
      agentRuntimeConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
      },
    });
    mockAgentInstructionsService.deleteFile.mockResolvedValue({
      bundle: {
        agentId: "11111111-1111-4111-8111-111111111111",
        orgId: "organization-1",
        mode: "managed",
        rootPath: "/tmp/agent-1",
        managedRootPath: "/tmp/agent-1",
        entryFile: "AGENTS.md",
        resolvedEntryPath: "/tmp/agent-1/AGENTS.md",
        editable: true,
        warnings: [],
        legacyPromptTemplateActive: false,
        legacyBootstrapPromptTemplateActive: false,
        files: [],
      },
      agentRuntimeConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
      },
    });
  });

  it("returns bundle metadata", async () => {
    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle?orgId=organization-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
    });
    expect(mockAgentInstructionsService.reconcileBundle).toHaveBeenCalled();
  });

  it("persists healed managed bundle metadata when bundle metadata is read", async () => {
    mockAgentInstructionsService.reconcileBundle.mockResolvedValueOnce({
      bundle: {
        agentId: "11111111-1111-4111-8111-111111111111",
        orgId: "organization-1",
        mode: "managed",
        rootPath: "/tmp/agent-1",
        managedRootPath: "/tmp/agent-1",
        entryFile: "AGENTS.md",
        resolvedEntryPath: "/tmp/agent-1/AGENTS.md",
        editable: true,
        warnings: [],
        legacyPromptTemplateActive: false,
        legacyBootstrapPromptTemplateActive: false,
        files: [],
      },
      agentRuntimeConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
      },
      changed: true,
    });

    const res = await request(createApp())
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle?orgId=organization-1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        agentRuntimeConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
    );
  });

  it("writes a bundle file and persists compatibility config", async () => {
    const res = await request(createApp())
      .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?orgId=organization-1")
      .send({
        path: "AGENTS.md",
        content: "# Updated Agent\n",
        clearLegacyPromptTemplate: true,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      path: "AGENTS.md",
      content: "# Updated Agent\n",
    });
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        agentRuntimeConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("persists healed managed metadata when deleting a bundle file", async () => {
    const res = await request(createApp())
      .delete("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?orgId=organization-1&path=docs%2FTOOLS.md");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        agentRuntimeConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("preserves managed instructions config when switching adapters", async () => {
    const existingAgent = {
      ...makeAgent(),
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    };
    mockAgentService.getById.mockResolvedValue(existingAgent);
    mockAgentService.getInternalById.mockResolvedValue(existingAgent);

    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?orgId=organization-1")
      .send({
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: {
          model: "claude-sonnet-4",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: expect.objectContaining({
          model: "claude-sonnet-4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("merges same-adapter config patches so instructions metadata is not dropped", async () => {
    const existingAgent = {
      ...makeAgent(),
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    };
    mockAgentService.getById.mockResolvedValue(existingAgent);
    mockAgentService.getInternalById.mockResolvedValue(existingAgent);

    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?orgId=organization-1")
      .send({
        agentRuntimeConfig: {
          command: "codex --profile engineer",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        agentRuntimeConfig: expect.objectContaining({
          command: "codex --profile engineer",
          model: "gpt-5.4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("uses the internal agent lookup so rename preserves the stored workspace key", async () => {
    mockAgentService.getInternalById.mockResolvedValue({
      ...makeAgent(),
      name: "CTO",
      workspaceKey: "cto--11111111",
      agentRuntimeConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agents/cto--11111111/instructions",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agents/cto--11111111/instructions/AGENTS.md",
      },
    });

    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?orgId=organization-1")
      .send({
        name: "Ella",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.getInternalById).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(mockAgentService.getById).not.toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("replaces adapter config when replaceAgentRuntimeConfig is true", async () => {
    const existingAgent = {
      ...makeAgent(),
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    };
    mockAgentService.getById.mockResolvedValue(existingAgent);
    mockAgentService.getInternalById.mockResolvedValue(existingAgent);

    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?orgId=organization-1")
      .send({
        replaceAgentRuntimeConfig: true,
        agentRuntimeConfig: {
          command: "codex --profile engineer",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        agentRuntimeConfig: expect.objectContaining({
          command: "codex --profile engineer",
        }),
      }),
      expect.any(Object),
    );
    expect(res.body.agentRuntimeConfig).toMatchObject({
      command: "codex --profile engineer",
    });
    expect(res.body.agentRuntimeConfig.instructionsBundleMode).toBeUndefined();
    expect(res.body.agentRuntimeConfig.instructionsRootPath).toBeUndefined();
    expect(res.body.agentRuntimeConfig.instructionsEntryFile).toBeUndefined();
    expect(res.body.agentRuntimeConfig.instructionsFilePath).toBeUndefined();
  });
});
