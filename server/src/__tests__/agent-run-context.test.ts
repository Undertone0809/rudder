import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../home-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../home-paths.js")>();
  return {
    ...actual,
    ensureAgentWorkspaceLayout: vi.fn(async () => ({
      root: "/tmp/agent-home",
      instructionsDir: "/tmp/agent-home/instructions",
      memoryDir: "/tmp/agent-home/memory",
      lifeDir: "/tmp/agent-home/life",
      skillsDir: "/tmp/agent-home/skills",
    })),
    ensureOrganizationWorkspaceLayout: vi.fn(async () => ({
      root: "/tmp/org-home",
      agentsDir: "/tmp/org-home/agents",
      skillsDir: "/tmp/org-home/skills",
    })),
    ensureProjectLibraryLayout: vi.fn(async () => ({
      root: "/tmp/org-home/projects/product",
      relativePath: "projects/product",
      readmePath: "/tmp/org-home/projects/product/README.md",
    })),
  };
});

vi.mock("../services/agents.js", () => ({
  agentService: () => ({}),
}));

const mockResolveAdapterConfigForRuntime = vi.fn();
const mockGetEnabledSkillKeysForAgent = vi.fn();
const mockListRealizedSkillEntriesForAgent = vi.fn();
const mockListRuntimeToolsForAgent = vi.fn();
const mockListManagedRuntimeBindings = vi.fn();
const mockGetBrowserSettings = vi.fn();
const mockGetGeneralSettings = vi.fn();
const mockComputerBrokerAvailable = vi.fn();

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveAdapterConfigForRuntime: mockResolveAdapterConfigForRuntime,
  }),
}));

vi.mock("../services/organization-skills.js", () => ({
  organizationSkillService: () => ({
    getEnabledSkillKeysForAgent: mockGetEnabledSkillKeysForAgent,
    listRealizedSkillEntriesForAgent: mockListRealizedSkillEntriesForAgent,
  }),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getBrowser: mockGetBrowserSettings,
    getGeneral: mockGetGeneralSettings,
  }),
}));

vi.mock("../services/computer-broker.js", () => ({
  computerBrokerRegistry: {
    isAvailable: mockComputerBrokerAvailable,
  },
}));

vi.mock("../services/integrations/custom-integrations.js", () => ({
  customIntegrationService: () => ({
    listRuntimeToolsForAgent: mockListRuntimeToolsForAgent,
  }),
}));

vi.mock("../services/mcp/managed-bindings.js", () => ({
  managedMcpBindingService: () => ({
    listRuntimeBindings: mockListManagedRuntimeBindings,
  }),
}));

const mockListOrganizationResources = vi.fn();
const mockListProjectResourceAttachments = vi.fn();
const mockBuildAgentStartupContext = vi.fn();

vi.mock("../services/resource-catalog.js", () => ({
  listOrganizationResources: (...args: unknown[]) => mockListOrganizationResources(...args),
  listProjectResourceAttachments: (...args: unknown[]) => mockListProjectResourceAttachments(...args),
}));

vi.mock("../services/agent-startup-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-startup-context.js")>();
  return {
    ...actual,
    agentStartupContextService: (...args: unknown[]) => mockBuildAgentStartupContext(...args),
  };
});

const { agentRunContextService } = await import("../services/agent-run-context.js");

const browserSkillEntry = {
  key: "bundled:rudder/browser",
  runtimeName: "browser",
  source: "/tmp/browser-skill",
  name: "Browser",
  description: "Control the Rudder Browser.",
};

const rudderSkillEntry = {
  key: "bundled:rudder/rudder-docs",
  runtimeName: "rudder-docs",
  source: "/tmp/rudder-docs-skill",
  name: "rudder-docs",
  description: "Operate Rudder.",
};

async function makeTempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function managedInstructionsRoot(rudderHome: string, orgId: string, workspaceKey: string): string {
  return path.join(
    rudderHome,
    "instances",
    "test-instance",
    "organizations",
    orgId,
    "workspaces",
    "agents",
    workspaceKey,
    "instructions",
  );
}

describe("agentRunContextService prepareRuntimeConfig", () => {
  const originalRudderHome = process.env.RUDDER_HOME;
  const originalRudderInstanceId = process.env.RUDDER_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  beforeEach(() => {
    mockGetBrowserSettings.mockResolvedValue({ enabled: true, openLinksIn: "built_in" });
    mockGetGeneralSettings.mockResolvedValue({
      experimentalSitesEnabled: false,
      experimentalComputerUseEnabled: false,
    });
    mockComputerBrokerAvailable.mockReturnValue(false);
    mockListManagedRuntimeBindings.mockResolvedValue([]);
  });

  afterEach(async () => {
    mockResolveAdapterConfigForRuntime.mockReset();
    mockGetEnabledSkillKeysForAgent.mockReset();
    mockListRealizedSkillEntriesForAgent.mockReset();
    mockListRuntimeToolsForAgent.mockReset();
    mockListManagedRuntimeBindings.mockReset();
    mockGetBrowserSettings.mockReset();
    mockGetGeneralSettings.mockReset();
    mockComputerBrokerAvailable.mockReset();
    if (originalRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalRudderHome;
    if (originalRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = originalRudderInstanceId;
    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("projects the live Browser capability into run config without trusting agent config", async () => {
    mockResolveAdapterConfigForRuntime.mockResolvedValue({
      config: { rudderBrowserEnabled: false },
      secretKeys: new Set<string>(),
    });
    mockGetEnabledSkillKeysForAgent.mockResolvedValue([
      browserSkillEntry.key,
      rudderSkillEntry.key,
    ]);
    mockListRealizedSkillEntriesForAgent.mockResolvedValue([
      browserSkillEntry,
      rudderSkillEntry,
    ]);

    const svc = agentRunContextService({} as any, { deploymentMode: "local_trusted" });
    const enabled = await svc.prepareRuntimeConfig({
      scene: "heartbeat",
      agent: {
        id: "agent-1",
        orgId: "organization-1",
        name: "Browser Agent",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { rudderBrowserEnabled: false },
      },
    });
    expect(enabled.runtimeConfig.rudderBrowserEnabled).toBe(true);
    expect(enabled.runtimeSkillEntries.map((entry) => entry.key)).toEqual([
      browserSkillEntry.key,
      rudderSkillEntry.key,
    ]);
    expect(enabled.runtimeConfig.rudderSkillSync).toEqual({
      desiredSkills: [browserSkillEntry.key, rudderSkillEntry.key],
    });

    mockGetBrowserSettings.mockResolvedValueOnce({ enabled: false, openLinksIn: "built_in" });
    const disabled = await svc.prepareRuntimeConfig({
      scene: "heartbeat",
      agent: {
        id: "agent-1",
        orgId: "organization-1",
        name: "Browser Agent",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { rudderBrowserEnabled: true },
      },
    });
    expect(disabled.runtimeConfig.rudderBrowserEnabled).toBe(false);
    expect(disabled.runtimeSkillEntries.map((entry) => entry.key)).toEqual([
      rudderSkillEntry.key,
    ]);
  });

  it("projects Computer Use only for an enabled Desktop-backed codex_local Run", async () => {
    mockResolveAdapterConfigForRuntime.mockResolvedValue({
      config: { rudderComputerEnabled: false },
      secretKeys: new Set<string>(),
    });
    mockGetEnabledSkillKeysForAgent.mockResolvedValue([]);
    mockListRealizedSkillEntriesForAgent.mockResolvedValue([]);
    mockGetGeneralSettings.mockResolvedValue({
      experimentalSitesEnabled: false,
      experimentalComputerUseEnabled: true,
    });
    mockComputerBrokerAvailable.mockReturnValue(true);

    const svc = agentRunContextService({} as any, { deploymentMode: "local_trusted" });
    const eligible = await svc.prepareRuntimeConfig({
      scene: "chat",
      agent: {
        id: "agent-1",
        orgId: "organization-1",
        name: "Desktop Agent",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { rudderComputerEnabled: false },
      },
    });
    expect(eligible.runtimeConfig.rudderComputerEnabled).toBe(true);

    const unsupported = await svc.prepareRuntimeConfig({
      scene: "chat",
      agent: {
        id: "agent-2",
        orgId: "organization-1",
        name: "Other Agent",
        agentRuntimeType: "claude_local",
        agentRuntimeConfig: { rudderComputerEnabled: true },
      },
    });
    expect(unsupported.runtimeConfig.rudderComputerEnabled).toBe(false);
  });

  it("injects only live provider-neutral managed MCP bindings into runtime config", async () => {
    mockResolveAdapterConfigForRuntime.mockResolvedValue({
      config: {
        managedExternalMcpBindings: [{
          bindingId: "attacker-controlled",
          provider: "supabase",
          accessToken: "must-not-survive",
        }],
      },
      secretKeys: new Set<string>(),
    });
    mockGetEnabledSkillKeysForAgent.mockResolvedValue([]);
    mockListRealizedSkillEntriesForAgent.mockResolvedValue([]);
    mockListManagedRuntimeBindings.mockResolvedValue([{
      bindingId: "22222222-2222-4222-8222-222222222222",
      serverName: "team-tools",
      accessMode: "read_only",
      toolPolicy: {
        mode: "allowlist",
        allowedToolNames: ["external.team-tools.search"],
      },
      required: true,
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
    }]);

    const prepared = await agentRunContextService({} as any).prepareRuntimeConfig({
      scene: "heartbeat",
      agent: {
        id: "11111111-1111-4111-8111-111111111111",
        orgId: "33333333-3333-4333-8333-333333333333",
        name: "Builder",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
    });

    expect(prepared.runtimeConfig.managedExternalMcpBindings).toEqual([{
      bindingId: "22222222-2222-4222-8222-222222222222",
      serverName: "team-tools",
      accessMode: "read_only",
      toolPolicy: {
        mode: "allowlist",
        allowedToolNames: ["external.team-tools.search"],
      },
      required: true,
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
    }]);
    expect(JSON.stringify(prepared.runtimeConfig.managedExternalMcpBindings))
      .not.toMatch(/provider|accessToken|connectionId|credential|url/iu);
    expect(mockListManagedRuntimeBindings).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("materializes missing runtime skills by default and supports side-effect-free descriptor reads", async () => {
    mockResolveAdapterConfigForRuntime.mockResolvedValue({
      config: { model: "gpt-5.4" },
      secretKeys: new Set<string>(),
    });
    mockGetEnabledSkillKeysForAgent.mockResolvedValue(["org/build-advisor"]);
    mockListRealizedSkillEntriesForAgent.mockResolvedValue([]);
    const agent = {
      id: "agent-1",
      orgId: "organization-1",
      name: "Builder",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: { model: "gpt-5.4" },
    };
    const svc = agentRunContextService({} as any);

    await svc.prepareRuntimeConfig({ scene: "chat", agent });
    await svc.prepareRuntimeConfig({
      scene: "chat",
      agent,
      materializeMissingRuntimeSkills: false,
    });

    expect(mockListRealizedSkillEntriesForAgent).toHaveBeenNthCalledWith(
      1,
      "organization-1",
      "agent-1",
      "codex_local",
      { model: "gpt-5.4" },
      ["org/build-advisor"],
      { materializeMissing: true },
    );
    expect(mockListRealizedSkillEntriesForAgent).toHaveBeenNthCalledWith(
      2,
      "organization-1",
      "agent-1",
      "codex_local",
      { model: "gpt-5.4" },
      ["org/build-advisor"],
      { materializeMissing: false },
    );
  });

  it("keeps runtime preparation available when managed MCP binding resolution fails", async () => {
    mockResolveAdapterConfigForRuntime.mockResolvedValue({
      config: {},
      secretKeys: new Set<string>(),
    });
    mockGetEnabledSkillKeysForAgent.mockResolvedValue([]);
    mockListRealizedSkillEntriesForAgent.mockResolvedValue([]);
    mockListManagedRuntimeBindings.mockRejectedValue(
      new Error("Required managed MCP connection supabase-main is unavailable"),
    );

    await expect(agentRunContextService({} as any).prepareRuntimeConfig({
      scene: "heartbeat",
      agent: {
        id: "11111111-1111-4111-8111-111111111111",
        orgId: "33333333-3333-4333-8333-333333333333",
        name: "Builder",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
    })).resolves.toMatchObject({
      runtimeConfig: {
        managedExternalMcpBindings: [],
      },
    });
  });

  it.each([
    ["authenticated deployments", "authenticated", "codex_local", false],
    ["unsupported local runtimes", "local_trusted", "gemini_local", true],
  ] as const)("does not project Browser skill or tools for %s", async (
    _label,
    deploymentMode,
    agentRuntimeType,
    instanceEligible,
  ) => {
    mockResolveAdapterConfigForRuntime.mockResolvedValue({
      config: { rudderBrowserEnabled: true },
      secretKeys: new Set<string>(),
    });
    mockGetEnabledSkillKeysForAgent.mockResolvedValue([
      browserSkillEntry.key,
      rudderSkillEntry.key,
    ]);
    mockListRealizedSkillEntriesForAgent.mockResolvedValue([
      browserSkillEntry,
      rudderSkillEntry,
    ]);

    const svc = agentRunContextService({} as any, { deploymentMode });
    const prepared = await svc.prepareRuntimeConfig({
      scene: "heartbeat",
      agent: {
        id: "agent-1",
        orgId: "organization-1",
        name: "Browser Agent",
        agentRuntimeType,
        agentRuntimeConfig: { rudderBrowserEnabled: true },
      },
    });

    expect(prepared.runtimeConfig.rudderBrowserEnabled).toBe(false);
    expect(prepared.runtimeSkillEntries.map((entry) => entry.key)).toEqual([
      rudderSkillEntry.key,
    ]);
    expect(prepared.runtimeConfig.rudderSkillSync).toEqual({
      desiredSkills: [rudderSkillEntry.key],
    });
    expect(prepared.runtimeConfig.rudderBrowserCapability).toEqual({
      instanceEligible,
      runtimeSkillEntries: instanceEligible ? [browserSkillEntry] : [],
    });
  });

  it("does not materialize a missing managed instructions entry while preparing runtime config", async () => {
    const rudderHome = await makeTempDir("rudder-agent-run-context-empty-managed-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = "organization-1";
    const workspaceKey = "builder--11111111";
    const rootPath = managedInstructionsRoot(rudderHome, orgId, workspaceKey);
    await fs.mkdir(rootPath, { recursive: true });
    const instructionsFilePath = path.join(rootPath, "SOUL.md");
    const baseConfig = {
      instructionsBundleMode: "managed",
      instructionsRootPath: rootPath,
      instructionsEntryFile: "SOUL.md",
      instructionsFilePath,
    };

    mockResolveAdapterConfigForRuntime.mockImplementation(async (_orgId: string, config: Record<string, unknown>) => ({
      config,
      secretKeys: new Set<string>(),
    }));
    mockGetEnabledSkillKeysForAgent.mockResolvedValue([]);
    mockListRealizedSkillEntriesForAgent.mockResolvedValue([]);

    const svc = agentRunContextService({} as any);
    const prepared = await svc.prepareRuntimeConfig({
      scene: "heartbeat",
      agent: {
        id: "11111111-1111-4111-8111-111111111111",
        orgId,
        name: "Builder",
        workspaceKey,
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: baseConfig,
      },
      baseConfig,
    });

    expect(prepared.runtimeConfig.instructionsFilePath).toBe(instructionsFilePath);
    await expect(fs.stat(instructionsFilePath)).rejects.toThrow();
  });

  it("passes explicitly materialized managed instructions metadata into secrets and skill resolution", async () => {
    const rudderHome = await makeTempDir("rudder-agent-run-context-reconciled-managed-");
    const staleRoot = await makeTempDir("rudder-agent-run-context-stale-root-");
    cleanupDirs.add(rudderHome);
    cleanupDirs.add(staleRoot);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = "organization-1";
    const workspaceKey = "builder--11111111";
    const managedRoot = managedInstructionsRoot(rudderHome, orgId, workspaceKey);
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "SOUL.md"), "# Managed Persona\n", "utf8");

    const baseConfig = {
      instructionsBundleMode: "managed",
      instructionsRootPath: staleRoot,
      instructionsEntryFile: "docs/MISSING.md",
      instructionsFilePath: path.join(staleRoot, "docs", "MISSING.md"),
    };
    const expectedInstructionsFilePath = path.join(managedRoot, "SOUL.md");

    mockResolveAdapterConfigForRuntime.mockImplementation(async (_orgId: string, config: Record<string, unknown>) => ({
      config,
      secretKeys: new Set<string>(),
    }));
    mockGetEnabledSkillKeysForAgent.mockResolvedValue([]);
    mockListRealizedSkillEntriesForAgent.mockResolvedValue([]);

    const svc = agentRunContextService({} as any);
    const materializedConfig = await svc.materializeManagedInstructionsForRun({
      id: "11111111-1111-4111-8111-111111111111",
      orgId,
      name: "Builder",
      workspaceKey,
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: baseConfig,
    });
    const prepared = await svc.prepareRuntimeConfig({
      scene: "heartbeat",
      agent: {
        id: "11111111-1111-4111-8111-111111111111",
        orgId,
        name: "Builder",
        workspaceKey,
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: materializedConfig,
      },
      baseConfig: materializedConfig,
    });

    expect(mockResolveAdapterConfigForRuntime).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({
        instructionsBundleMode: "managed",
        instructionsRootPath: managedRoot,
        instructionsEntryFile: "SOUL.md",
        instructionsFilePath: expectedInstructionsFilePath,
      }),
    );
    expect(mockGetEnabledSkillKeysForAgent).toHaveBeenCalledWith(
      orgId,
      expect.objectContaining({
        agentRuntimeConfig: expect.objectContaining({
          instructionsRootPath: managedRoot,
          instructionsFilePath: expectedInstructionsFilePath,
        }),
      }),
    );
    expect(prepared.runtimeConfig.instructionsFilePath).toBe(expectedInstructionsFilePath);
  });

  it("does not write per-run baseConfig instruction overrides into the managed bundle", async () => {
    const rudderHome = await makeTempDir("rudder-agent-run-context-per-run-override-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = "organization-1";
    const workspaceKey = "builder--11111111";
    const managedRoot = managedInstructionsRoot(rudderHome, orgId, workspaceKey);
    await fs.mkdir(managedRoot, { recursive: true });

    const durableConfig = {
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "SOUL.md",
      instructionsFilePath: path.join(managedRoot, "SOUL.md"),
      promptTemplate: "# Durable Persona\n\nPersisted agent instructions.",
    };

    mockResolveAdapterConfigForRuntime.mockImplementation(async (_orgId: string, config: Record<string, unknown>) => ({
      config,
      secretKeys: new Set<string>(),
    }));
    mockGetEnabledSkillKeysForAgent.mockResolvedValue([]);
    mockListRealizedSkillEntriesForAgent.mockResolvedValue([]);

    const svc = agentRunContextService({} as any);
    const materializedConfig = await svc.materializeManagedInstructionsForRun({
      id: "11111111-1111-4111-8111-111111111111",
      orgId,
      name: "Builder",
      workspaceKey,
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: durableConfig,
    });
    const perRunConfig = {
      ...materializedConfig,
      promptTemplate: "# Issue Override\n\nThis prompt is only for the current run.",
    };

    await svc.prepareRuntimeConfig({
      scene: "heartbeat",
      agent: {
        id: "11111111-1111-4111-8111-111111111111",
        orgId,
        name: "Builder",
        workspaceKey,
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: materializedConfig,
      },
      baseConfig: perRunConfig,
    });

    await expect(fs.readFile(path.join(managedRoot, "SOUL.md"), "utf8")).resolves.toBe("# Durable Persona\n\nPersisted agent instructions.");
    expect(mockResolveAdapterConfigForRuntime).toHaveBeenLastCalledWith(
      orgId,
      expect.objectContaining({ promptTemplate: "# Issue Override\n\nThis prompt is only for the current run." }),
    );
  });

  it("uses the agent role when restoring default managed instructions for execution", async () => {
    const rudderHome = await makeTempDir("rudder-agent-run-context-role-managed-");
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = "organization-1";
    const workspaceKey = "operator--11111111";
    const managedRoot = managedInstructionsRoot(rudderHome, orgId, workspaceKey);
    await fs.mkdir(managedRoot, { recursive: true });

    const baseConfig = {
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "SOUL.md",
      instructionsFilePath: path.join(managedRoot, "SOUL.md"),
    };

    const svc = agentRunContextService({} as any);
    await svc.materializeManagedInstructionsForRun({
      id: "11111111-1111-4111-8111-111111111111",
      orgId,
      name: "Operator",
      role: "ceo",
      workspaceKey,
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: baseConfig,
    });

    await expect(fs.readFile(path.join(managedRoot, "SOUL.md"), "utf8")).resolves.toContain("# SOUL.md -- Operator Assistant Persona");
  });
});

describe("agentRunContextService buildSceneContext", () => {
  beforeEach(() => {
    mockListRuntimeToolsForAgent.mockResolvedValue([]);
  });

  afterEach(() => {
    mockResolveAdapterConfigForRuntime.mockReset();
    mockGetEnabledSkillKeysForAgent.mockReset();
    mockListRealizedSkillEntriesForAgent.mockReset();
    mockListRuntimeToolsForAgent.mockReset();
    mockListOrganizationResources.mockReset();
    mockListProjectResourceAttachments.mockReset();
    mockBuildAgentStartupContext.mockReset();
  });

  function mockEmptyStartupContext() {
    mockListRuntimeToolsForAgent.mockResolvedValue([]);
    mockBuildAgentStartupContext.mockReturnValue({
      buildForRun: vi.fn(async () => ({
        markdown: "",
        version: "agent-startup-context/v1",
        sections: [],
        sourceRefs: [],
        metrics: {
          version: "agent-startup-context/v1",
          totalChars: 0,
          limitChars: 12000,
          recentIssuesCount: 0,
          recentChatsCount: 0,
          omittedIssues: 0,
          omittedChats: 0,
        },
        omissions: [],
      })),
    });
  }

  it("uses the resolved execution workspace cwd while preserving agent home metadata", async () => {
    mockEmptyStartupContext();
    const svc = agentRunContextService({} as any);

    const context = await svc.buildSceneContext({
      scene: "chat",
      agent: {
        id: "agent-1",
        orgId: "organization-1",
        name: "Builder",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      resolvedWorkspace: {
        cwd: "/tmp/project-workspace",
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: "https://github.com/acme/repo.git",
        repoRef: "main",
        workspaceHints: [],
        warnings: [],
      },
      runtimeConfig: {},
    });

    expect(context.rudderWorkspace).toEqual(expect.objectContaining({
      cwd: "/tmp/project-workspace",
      executionWorkspaceCwd: "/tmp/project-workspace",
      source: "project_primary",
      agentHome: "/tmp/agent-home",
      agentRoot: "/tmp/agent-home",
      instructionsDir: "/tmp/agent-home/instructions",
      memoryDir: "/tmp/agent-home/memory",
      lifeDir: "/tmp/agent-home/life",
      agentSkillsDir: "/tmp/agent-home/skills",
      orgAgentsDir: "/tmp/org-home/agents",
      orgSkillsDir: "/tmp/org-home/skills",
    }));
  });

  it("omits the resources prompt when the selected project has no attached resources", async () => {
    mockEmptyStartupContext();
    mockListOrganizationResources.mockResolvedValue([]);
    mockListProjectResourceAttachments.mockResolvedValue([]);

    const svc = agentRunContextService({ select: vi.fn() } as any);
    const context = await svc.buildSceneContext({
      scene: "chat",
      agent: {
        id: "agent-1",
        orgId: "organization-1",
        name: "Builder",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      resolvedWorkspace: {
        cwd: "/tmp/project-workspace",
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: "https://github.com/acme/repo.git",
        repoRef: "main",
        workspaceHints: [],
        warnings: [],
      },
      runtimeConfig: {},
    });

    expect(context.rudderWorkspace.orgResourcesPrompt).toBe("");
    expect(context.rudderWorkspace.resourcesPrompt).toBe("");
    expect(context.rudderOrganizationResources).toEqual([]);
    expect(mockListOrganizationResources).not.toHaveBeenCalled();
    expect(mockListProjectResourceAttachments).toHaveBeenCalledWith(expect.anything(), "organization-1", "project-1");
  });

  it("does not inject structured org catalog resources into the agent run prompt by default", async () => {
    mockEmptyStartupContext();
    mockListOrganizationResources.mockResolvedValue([
      {
        id: "resource-1",
        orgId: "organization-1",
        name: "Rudder repo",
        kind: "directory",
        locator: "~/projects/rudder",
        description: "Main monorepo checkout",
        metadata: null,
        createdAt: new Date("2026-04-18T09:00:00.000Z"),
        updatedAt: new Date("2026-04-18T09:00:00.000Z"),
      },
    ]);
    mockListProjectResourceAttachments.mockResolvedValue([]);

    const svc = agentRunContextService({ select: vi.fn() } as any);
    const context = await svc.buildSceneContext({
      scene: "chat",
      agent: {
        id: "agent-1",
        orgId: "organization-1",
        name: "Builder",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      resolvedWorkspace: {
        cwd: "/tmp/project-workspace",
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: "https://github.com/acme/repo.git",
        repoRef: "main",
        workspaceHints: [],
        warnings: [],
      },
      runtimeConfig: {},
    });

    expect(context.rudderWorkspace.orgResourcesPrompt).toBe("");
    expect(context.rudderWorkspace.resourcesPrompt).toBe("");
    expect(context.rudderOrganizationResources).toEqual([]);
    expect(mockListOrganizationResources).not.toHaveBeenCalled();
  });

  it("appends assigned automation context to the compiled run prompt", async () => {
    mockEmptyStartupContext();
    const automationOrderBy = vi.fn(async () => [
      {
        id: "automation-1",
        title: "Daily reviewer | follow-up",
        outputMode: "track_issue",
        lastTriggeredAt: new Date("2026-06-14T09:30:00.000Z"),
      },
      {
        id: "automation-2",
        title: "Release channel watch",
        outputMode: "chat_output",
        lastTriggeredAt: null,
      },
    ]);
    const automationWhere = vi.fn(() => ({ orderBy: automationOrderBy }));
    const automationFrom = vi.fn(() => ({ where: automationWhere }));
    const triggerOrderBy = vi.fn(async () => [
      {
        automationId: "automation-1",
        id: "trigger-1",
        kind: "schedule",
        label: "Weekday\nmorning",
        enabled: true,
        nextRunAt: new Date("2026-06-16T09:00:00.000Z"),
        lastFiredAt: new Date("2026-06-14T09:30:00.000Z"),
      },
      {
        automationId: "automation-2",
        id: "trigger-2",
        kind: "webhook",
        label: "Release webhook",
        enabled: false,
        nextRunAt: null,
        lastFiredAt: null,
      },
    ]);
    const triggerWhere = vi.fn(() => ({ orderBy: triggerOrderBy }));
    const triggerFrom = vi.fn(() => ({ where: triggerWhere }));
    const db = {
      select: vi.fn()
        .mockReturnValueOnce({ from: automationFrom })
        .mockReturnValueOnce({ from: triggerFrom }),
    } as any;

    const svc = agentRunContextService(db);
    const context = await svc.buildSceneContext({
      scene: "heartbeat",
      agent: {
        id: "agent-1",
        orgId: "organization-1",
        name: "Builder",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      resolvedWorkspace: {
        cwd: "/tmp/agent-home",
        source: "agent_home",
        projectId: null,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        workspaceHints: [],
        warnings: [],
      },
      runtimeConfig: {},
    });

    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("## Your Current Automations");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain(
      "These are your current automations; use the ID to inspect details when needed.",
    );
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("| Automation | ID | Output | Last run | Triggers |");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("| --- | --- | --- | --- | --- |");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain(
      "| Daily reviewer \\| follow-up | `automation-1` | issue | 2026-06-14T09:30:00.000Z | Weekday morning (schedule); enabled; next trigger: 2026-06-16T09:00:00.000Z; last fired: 2026-06-14T09:30:00.000Z |",
    );
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain(
      "| Release channel watch | `automation-2` | chat | never | Release webhook (webhook); disabled; next trigger: event-driven; last fired: never |",
    );
    expect(context.rudderWorkspace.orgResourcesPrompt).not.toContain("status");
    expect(context.rudderWorkspace.orgResourcesPrompt).toBe(context.rudderWorkspace.resourcesPrompt);
    expect(automationOrderBy).toHaveBeenCalledOnce();
    expect(triggerOrderBy).toHaveBeenCalledOnce();
    expect(mockListProjectResourceAttachments).not.toHaveBeenCalled();
  });

  it("appends compact startup context after curated run resources", async () => {
    mockListProjectResourceAttachments.mockResolvedValue([
      {
        id: "attachment-1",
        orgId: "organization-1",
        projectId: "project-1",
        resourceId: "resource-1",
        role: "working_set",
        note: null,
        sortOrder: 0,
        resource: {
          id: "resource-1",
          orgId: "organization-1",
          name: "Rudder repo",
          kind: "directory",
          sourceType: "library",
          locator: "projects/product/product-brief.md",
          description: null,
          metadata: null,
          createdAt: new Date("2026-04-16T09:00:00.000Z"),
          updatedAt: new Date("2026-04-16T09:00:00.000Z"),
        },
        createdAt: new Date("2026-04-16T09:00:00.000Z"),
        updatedAt: new Date("2026-04-16T09:00:00.000Z"),
      },
    ]);
    const buildForRun = vi.fn(async () => ({
      markdown: [
        "## Recent Rudder Context",
        "",
        "#### today memory: 2026-06-19.md",
        "- Morning calibration",
        "",
        "#### yesterday memory: 2026-06-18.md",
        "- Launch context",
        "",
        "#### recent issues",
        "| Issue | Status | Role | Assignee | Reviewer | Created | Updated | Title | Summary |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        "| `RD-421` | `in_review` | assignee | agent:agent-1 | empty | 2026-06-18T10:00:00.000Z | 2026-06-19T00:00:00.000Z | Agent startup memory context | Define bounded startup context. |",
        "",
        "#### recent chats",
        "| Chat | Last active | Title | Summary |",
        "| --- | --- | --- | --- |",
        "| `chat_01JY9M2V8Q6Z` | 2026-06-19T00:33:00.000Z | Agent run startup memory | 默认装载今天和昨天的 memory md |",
      ].join("\n"),
      version: "agent-startup-context/v1",
      sections: ["daily_memory", "recent_issues", "recent_chats"],
      sourceRefs: [],
      metrics: {
        version: "agent-startup-context/v1",
        totalChars: 924,
        limitChars: 12000,
        recentIssuesCount: 1,
        recentChatsCount: 1,
        omittedIssues: 0,
        omittedChats: 0,
      },
      omissions: [],
    }));
    mockBuildAgentStartupContext.mockReturnValue({ buildForRun });

    const limit = vi.fn(async () => [{ id: "project-1", name: "Product" }]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) } as any;
    const svc = agentRunContextService(db);
    const context = await svc.buildSceneContext({
      scene: "heartbeat",
      agent: {
        id: "agent-1",
        orgId: "organization-1",
        name: "Builder",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      resolvedWorkspace: {
        cwd: "/tmp/project-workspace",
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: "https://github.com/acme/repo.git",
        repoRef: "main",
        workspaceHints: [],
        warnings: [],
      },
      runtimeConfig: {},
      issueId: "issue-1",
    });

    expect(context.rudderWorkspace.resourcesPrompt).toContain("## Project Context Resources");
    expect(context.rudderWorkspace.resourcesPrompt).toContain("## Recent Rudder Context");
    expect(context.rudderWorkspace.resourcesPrompt.indexOf("## Project Context Resources")).toBeLessThan(
      context.rudderWorkspace.resourcesPrompt.indexOf("## Recent Rudder Context"),
    );
    expect(context.rudderWorkspace.resourcesPrompt).toContain("#### today memory: 2026-06-19.md");
    expect(context.rudderWorkspace.resourcesPrompt).toContain("| `RD-421` | `in_review` | assignee | agent:agent-1 | empty");
    expect(context.rudderWorkspace.resourcesPrompt).toContain("| `chat_01JY9M2V8Q6Z` | 2026-06-19T00:33:00.000Z");
    expect(context.rudderWorkspace.resourcesPrompt).not.toContain("#### startup context metadata");
    expect(context.rudderWorkspace.resourcesPrompt).not.toContain("recent runs");
    expect(context.rudderWorkspace.orgResourcesPrompt).toBe(context.rudderWorkspace.resourcesPrompt);
    expect(context.rudderStartupContext).toMatchObject({ version: "agent-startup-context/v1" });
    expect(context.rudderStartupContextMetrics).toMatchObject({
      recentIssuesCount: 1,
      recentChatsCount: 1,
    });
    expect(buildForRun).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "organization-1",
      agentId: "agent-1",
      memoryDir: "/tmp/agent-home/memory",
      scene: "heartbeat",
      issueId: "issue-1",
      projectId: "project-1",
    }));
  });

  it("injects attached project resources into the compiled run prompt", async () => {
    mockEmptyStartupContext();
    mockListOrganizationResources.mockResolvedValue([]);
    mockListProjectResourceAttachments.mockResolvedValue([
      {
        id: "attachment-1",
        orgId: "organization-1",
        projectId: "project-1",
        resourceId: "resource-1",
        role: "working_set",
        note: "Work here first",
        sortOrder: 0,
        resource: {
          id: "resource-1",
          orgId: "organization-1",
          name: "Rudder | repo",
          kind: "directory",
          sourceType: "library",
          locator: "projects/product/brief`v1`.md",
          description: "Main monorepo checkout",
          metadata: null,
          createdAt: new Date("2026-04-16T09:00:00.000Z"),
          updatedAt: new Date("2026-04-16T09:00:00.000Z"),
        },
        createdAt: new Date("2026-04-16T09:00:00.000Z"),
        updatedAt: new Date("2026-04-16T09:00:00.000Z"),
      },
    ]);

    const svc = agentRunContextService({ select: vi.fn() } as any);
    const context = await svc.buildSceneContext({
      scene: "chat",
      agent: {
        id: "agent-1",
        orgId: "organization-1",
        name: "Builder",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      resolvedWorkspace: {
        cwd: "/tmp/project-workspace",
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: "https://github.com/acme/repo.git",
        repoRef: "main",
        workspaceHints: [],
        warnings: [],
      },
      runtimeConfig: {},
    });

    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("## Project Context Resources");
    expect(context.rudderWorkspace.resourcesPrompt).toContain("## Project Context Resources");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("| Role | Name | Source | Kind | Locator | Description | Project note |");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("| --- | --- | --- | --- | --- | --- | --- |");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("| working_set | Rudder \\| repo | library | directory | `projects/product/brief'v1'.md` | Main monorepo checkout | Work here first |");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("Library resource guidance:");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("`library:projects/product/brief'v1'.md`");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("`$RUDDER_ORG_WORKSPACE_ROOT/projects/product/brief'v1'.md`");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain('`rudder library file ref "projects/product/brief\'v1\'.md" --json`');
    expect(context.rudderOrganizationResources).toEqual([]);
    expect(context.rudderProjectResources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectId: "project-1",
        resource: expect.objectContaining({
          name: "Rudder | repo",
        }),
      }),
    ]));
    expect(mockListOrganizationResources).not.toHaveBeenCalled();
  });

  it("exposes the project Library root for project-scoped local runs", async () => {
    mockEmptyStartupContext();
    const limit = vi.fn(async () => [{ id: "project-1", name: "Product" }]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) } as any;
    mockListProjectResourceAttachments.mockResolvedValue([]);

    const svc = agentRunContextService(db);
    const context = await svc.buildSceneContext({
      scene: "heartbeat",
      agent: {
        id: "agent-1",
        orgId: "organization-1",
        name: "Builder",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      resolvedWorkspace: {
        cwd: "/tmp/project-workspace",
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: "https://github.com/acme/repo.git",
        repoRef: "main",
        workspaceHints: [],
        warnings: [],
      },
      runtimeConfig: {},
    });

    expect(context.rudderWorkspace).toEqual(expect.objectContaining({
      projectLibraryRoot: "/tmp/org-home/projects/product",
      projectLibraryRelativePath: "projects/product",
    }));
  });
});

function makeProjectWorkspaceQueryDb(projectWorkspaceRows: Array<{
  id: string;
  orgId: string;
  projectId: string;
  cwd: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
}>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => projectWorkspaceRows),
        })),
      })),
    })),
  };
}

describe("agentRunContextService resolveWorkspaceForRun", () => {
  it("uses the shared organization workspace root for project-linked runs without project workspaces", async () => {
    const svc = agentRunContextService(makeProjectWorkspaceQueryDb([]) as any);

    const resolved = await svc.resolveWorkspaceForRun(
      {
        id: "agent-1",
        orgId: "organization-1",
        name: "Builder",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      { projectId: "project-1" },
      null,
    );

    expect(resolved).toEqual({
      cwd: "/tmp/org-home",
      source: "project_primary",
      projectId: "project-1",
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints: [],
      warnings: [],
    });
  });

  it("falls back to the shared organization workspace when legacy project workspaces have no local cwd", async () => {
    const svc = agentRunContextService(makeProjectWorkspaceQueryDb([
      {
        id: "workspace-1",
        orgId: "organization-1",
        projectId: "project-1",
        cwd: null,
        repoUrl: "https://github.com/acme/repo.git",
        repoRef: "main",
      },
    ]) as any);

    const resolved = await svc.resolveWorkspaceForRun(
      {
        id: "agent-1",
        orgId: "organization-1",
        name: "Builder",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      { projectId: "project-1" },
      null,
    );

    expect(resolved.cwd).toBe("/tmp/org-home");
    expect(resolved.source).toBe("project_primary");
    expect(resolved.workspaceId).toBe("workspace-1");
    expect(resolved.workspaceHints).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: null,
        repoUrl: "https://github.com/acme/repo.git",
        repoRef: "main",
      },
    ]);
    expect(resolved.warnings).toEqual([
      'Project has no local working directory configured. Run will start in shared organization directory "/tmp/org-home".',
    ]);
  });
});
