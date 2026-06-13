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
  importFromSource: vi.fn(),
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
    mockCompanySkillService.importFromSource.mockResolvedValue({
      imported: [],
      warnings: [],
    });
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
});
