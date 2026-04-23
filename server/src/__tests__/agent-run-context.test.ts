import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../home-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../home-paths.js")>();
  return {
    ...actual,
    ensureAgentWorkspaceLayout: vi.fn(async () => ({
      root: "/tmp/agent-home",
      instructionsDir: "/tmp/agent-home/instructions",
      memoryDir: "/tmp/agent-home/memory",
      skillsDir: "/tmp/agent-home/skills",
    })),
    ensureOrganizationWorkspaceLayout: vi.fn(async () => ({
      root: "/tmp/org-home",
      agentsDir: "/tmp/org-home/agents",
      skillsDir: "/tmp/org-home/skills",
      plansDir: "/tmp/org-home/plans",
    })),
  };
});

vi.mock("../services/agents.js", () => ({
  agentService: () => ({}),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({}),
}));

vi.mock("../services/organization-skills.js", () => ({
  organizationSkillService: () => ({}),
}));

const mockListOrganizationResources = vi.fn();
const mockListProjectResourceAttachments = vi.fn();

vi.mock("../services/resource-catalog.js", () => ({
  listOrganizationResources: (...args: unknown[]) => mockListOrganizationResources(...args),
  listProjectResourceAttachments: (...args: unknown[]) => mockListProjectResourceAttachments(...args),
}));

const { agentRunContextService } = await import("../services/agent-run-context.js");

describe("agentRunContextService buildSceneContext", () => {
  afterEach(() => {
    mockListOrganizationResources.mockReset();
    mockListProjectResourceAttachments.mockReset();
  });

  it("uses the resolved execution workspace cwd while preserving agent home metadata", async () => {
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
      agentSkillsDir: "/tmp/agent-home/skills",
      orgAgentsDir: "/tmp/org-home/agents",
      orgSkillsDir: "/tmp/org-home/skills",
      orgPlansDir: "/tmp/org-home/plans",
    }));
  });

  it("omits the org resource section when the org catalog is empty", async () => {
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
    expect(context.rudderOrganizationResources).toEqual([]);
  });

  it("injects structured org resources into the agent run prompt", async () => {
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

    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("## Organization Resources");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("Rudder repo");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("Main monorepo checkout");
    expect(context.rudderOrganizationResources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "Rudder repo",
        locator: "~/projects/rudder",
      }),
    ]));
  });

  it("injects attached project resources into the compiled run prompt", async () => {
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
          name: "Rudder repo",
          kind: "directory",
          locator: "~/projects/rudder",
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

    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("## Project Resources");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("[working_set] Rudder repo");
    expect(context.rudderWorkspace.orgResourcesPrompt).toContain("Work here first");
    expect(context.rudderProjectResources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectId: "project-1",
        resource: expect.objectContaining({
          name: "Rudder repo",
        }),
      }),
    ]));
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
      'Project workspace has no local cwd configured. Run will start in shared organization workspace "/tmp/org-home".',
    ]);
  });
});
