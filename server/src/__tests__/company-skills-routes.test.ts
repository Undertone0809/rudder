import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { organizationSkillRoutes } from "../routes/organization-skills.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  list: vi.fn(),
  hasLocalPathSkills: vi.fn(),
  getById: vi.fn(),
  detail: vi.fn(),
  updateStatus: vi.fn(),
  readFile: vi.fn(),
  createLocalSkill: vi.fn(),
  updateFile: vi.fn(),
  importFromSource: vi.fn(),
  scanProjectWorkspaces: vi.fn(),
  scanLocalSkillRoots: vi.fn(),
  deleteSkill: vi.fn(),
  installUpdate: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  organizationSkillService: () => mockCompanySkillService,
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
  logActivity: mockLogActivity,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", organizationSkillRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("organization skill mutation permissions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCompanySkillService.list.mockResolvedValue([]);
    mockCompanySkillService.hasLocalPathSkills.mockResolvedValue(false);
    mockCompanySkillService.getById.mockResolvedValue(null);
    mockCompanySkillService.detail.mockResolvedValue(null);
    mockCompanySkillService.updateStatus.mockResolvedValue(null);
    mockCompanySkillService.readFile.mockResolvedValue(null);
    mockCompanySkillService.updateFile.mockResolvedValue(null);
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [],
      warnings: [],
    });
    mockCompanySkillService.scanProjectWorkspaces.mockResolvedValue({
      scannedProjects: 0,
      scannedWorkspaces: 0,
      discovered: 0,
      imported: [],
      updated: [],
      skipped: [],
      conflicts: [],
      warnings: [],
    });
    mockCompanySkillService.scanLocalSkillRoots.mockResolvedValue({
      scannedRoots: 0,
      discovered: 0,
      imported: [],
      updated: [],
      skipped: [],
      conflicts: [],
      warnings: [],
    });
    mockCompanySkillService.deleteSkill.mockResolvedValue(null);
    mockCompanySkillService.installUpdate.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("allows local board operators to mutate organization skills", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "local-board",
      orgIds: ["organization-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/orgs/organization-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "organization-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("allows same-organization agents to mutate organization skills by default", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      permissions: {},
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: "run-1",
    }))
      .post("/api/orgs/organization-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "organization-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("blocks same-organization agents when skill management is explicitly disabled", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      permissions: { canCreateAgents: true, canManageSkills: false },
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: "run-1",
    }))
      .post("/api/orgs/organization-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Missing permission: can manage skills");
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("allows agents with canManageSkills to mutate organization skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      permissions: { canCreateAgents: false, canManageSkills: true },
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: "run-1",
    }))
      .post("/api/orgs/organization-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "organization-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it("requires skills:manage for non-admin board users", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(createApp({
      type: "board",
      userId: "board-user",
      orgIds: ["organization-1"],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post("/api/orgs/organization-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Missing permission: skills:manage");
    expect(mockAccessService.canUser).toHaveBeenCalledWith("organization-1", "board-user", "skills:manage");
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("keeps legacy agents:create board grants compatible for organization skill mutation", async () => {
    mockAccessService.canUser.mockImplementation(async (_orgId, _userId, permission) => permission === "agents:create");

    const res = await request(createApp({
      type: "board",
      userId: "board-user",
      orgIds: ["organization-1"],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post("/api/orgs/organization-1/skills/import")
      .send({ source: "https://github.com/vercel-labs/agent-browser" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAccessService.canUser).toHaveBeenCalledWith("organization-1", "board-user", "skills:manage");
    expect(mockAccessService.canUser).toHaveBeenCalledWith("organization-1", "board-user", "agents:create");
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "organization-1",
      "https://github.com/vercel-labs/agent-browser",
    );
  });

  it.each([
    "/etc/rudder-skill/SKILL.md",
    "/tmp/linked-skill",
    "file:///etc/rudder-skill/SKILL.md",
  ])("blocks non-admin board users from importing host source %s", async (source) => {
    const res = await request(createApp({
      type: "board",
      userId: "board-user",
      orgIds: ["organization-1"],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post("/api/orgs/organization-1/skills/import")
      .send({ source });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Instance admin access required");
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("blocks same-organization agents from importing host paths", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      permissions: { canManageSkills: true },
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: "run-1",
    }))
      .post("/api/orgs/organization-1/skills/import")
      .send({ source: "/tmp/linked-skill" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Board access required");
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("blocks non-admin boards and agents from every host-scanning route", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      permissions: { canManageSkills: true },
    });
    const boardApp = createApp({
      type: "board",
      userId: "board-user",
      orgIds: ["organization-1"],
      source: "session",
      isInstanceAdmin: false,
    });
    const agentApp = createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: "run-1",
    });

    for (const app of [boardApp, agentApp]) {
      const projectScan = await request(app)
        .post("/api/orgs/organization-1/skills/scan-projects")
        .send({});
      const localScan = await request(app)
        .post("/api/orgs/organization-1/skills/scan-local")
        .send({ roots: ["/tmp/linked-skills"] });

      expect(projectScan.status, JSON.stringify(projectScan.body)).toBe(403);
      expect(localScan.status, JSON.stringify(localScan.body)).toBe(403);
    }

    expect(mockCompanySkillService.scanProjectWorkspaces).not.toHaveBeenCalled();
    expect(mockCompanySkillService.scanLocalSkillRoots).not.toHaveBeenCalled();
  });

  it("permits instance admins to import and scan explicit host paths", async () => {
    const app = createApp({
      type: "board",
      userId: "instance-admin",
      orgIds: [],
      source: "session",
      isInstanceAdmin: true,
    });

    const importRes = await request(app)
      .post("/api/orgs/organization-1/skills/import")
      .send({ source: "/tmp/linked-skill" });
    const scanRes = await request(app)
      .post("/api/orgs/organization-1/skills/scan-local")
      .send({ roots: ["/tmp/linked-skills"] });

    expect(importRes.status, JSON.stringify(importRes.body)).toBe(201);
    expect(scanRes.status, JSON.stringify(scanRes.body)).toBe(200);
    expect(mockCompanySkillService.importFromSource).toHaveBeenCalledWith(
      "organization-1",
      "/tmp/linked-skill",
    );
    expect(mockCompanySkillService.scanLocalSkillRoots).toHaveBeenCalledWith(
      "organization-1",
      { roots: ["/tmp/linked-skills"] },
    );
  });

  it("rejects all original-path skill actions before filesystem-capable service dispatch", async () => {
    const skillId = "11111111-1111-4111-8111-111111111111";
    mockCompanySkillService.getById.mockResolvedValue({
      id: skillId,
      orgId: "organization-1",
      sourceType: "local_path",
      sourceLocator: "/tmp/linked-skill",
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      permissions: { canManageSkills: true },
    });
    const actors = [
      {
        type: "board",
        userId: "board-user",
        orgIds: ["organization-1"],
        source: "session",
        isInstanceAdmin: false,
      },
      {
        type: "agent",
        agentId: "agent-1",
        orgId: "organization-1",
        runId: "run-1",
      },
    ];

    for (const actor of actors) {
      const app = createApp(actor);
      const results = [
        await request(app).get(`/api/orgs/organization-1/skills/${skillId}`),
        await request(app).get(`/api/orgs/organization-1/skills/${skillId}/update-status`),
        await request(app).get(`/api/orgs/organization-1/skills/${skillId}/files?path=SKILL.md`),
        await request(app)
          .patch(`/api/orgs/organization-1/skills/${skillId}/files`)
          .send({ path: "SKILL.md", content: "changed" }),
        await request(app).delete(`/api/orgs/organization-1/skills/${skillId}`),
        await request(app).post(`/api/orgs/organization-1/skills/${skillId}/install-update`),
      ];

      expect(results.map((result) => result.status)).toEqual([403, 403, 403, 403, 403, 403]);
    }

    expect(mockCompanySkillService.detail).not.toHaveBeenCalled();
    expect(mockCompanySkillService.updateStatus).not.toHaveBeenCalled();
    expect(mockCompanySkillService.readFile).not.toHaveBeenCalled();
    expect(mockCompanySkillService.updateFile).not.toHaveBeenCalled();
    expect(mockCompanySkillService.deleteSkill).not.toHaveBeenCalled();
    expect(mockCompanySkillService.installUpdate).not.toHaveBeenCalled();
  });

  it("allows instance admins to read and update local skill files", async () => {
    const skillId = "11111111-1111-4111-8111-111111111111";
    mockCompanySkillService.getById.mockResolvedValue({
      id: skillId,
      orgId: "organization-1",
      sourceType: "local_path",
      sourceLocator: "/tmp/linked-skill",
    });
    mockCompanySkillService.readFile.mockResolvedValue({
      skillId,
      path: "SKILL.md",
      content: "original",
    });
    mockCompanySkillService.updateFile.mockResolvedValue({
      skillId,
      path: "SKILL.md",
      content: "changed",
      markdown: true,
    });
    const app = createApp({
      type: "board",
      userId: "instance-admin",
      orgIds: [],
      source: "session",
      isInstanceAdmin: true,
    });

    const readRes = await request(app)
      .get(`/api/orgs/organization-1/skills/${skillId}/files?path=SKILL.md`);
    const updateRes = await request(app)
      .patch(`/api/orgs/organization-1/skills/${skillId}/files`)
      .send({ path: "SKILL.md", content: "changed" });

    expect(readRes.status, JSON.stringify(readRes.body)).toBe(200);
    expect(updateRes.status, JSON.stringify(updateRes.body)).toBe(200);
    expect(mockCompanySkillService.readFile).toHaveBeenCalledWith(
      "organization-1",
      skillId,
      "SKILL.md",
    );
    expect(mockCompanySkillService.updateFile).toHaveBeenCalledWith(
      "organization-1",
      skillId,
      "SKILL.md",
      "changed",
    );
  });

  it("blocks local-skill list disclosure and managed host writes for non-admin managers", async () => {
    mockCompanySkillService.hasLocalPathSkills.mockResolvedValue(true);
    const app = createApp({
      type: "board",
      userId: "board-user",
      orgIds: ["organization-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const listRes = await request(app).get("/api/orgs/organization-1/skills");
    const createRes = await request(app)
      .post("/api/orgs/organization-1/skills")
      .send({ name: "Linked Skill", slug: "linked-skill" });

    expect(listRes.status, JSON.stringify(listRes.body)).toBe(403);
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(403);
    expect(mockCompanySkillService.list).not.toHaveBeenCalled();
    expect(mockCompanySkillService.createLocalSkill).not.toHaveBeenCalled();
  });
});
