import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { organizationSkillRoutes } from "../routes/organization-skills.js";
import { errorHandler } from "../middleware/index.js";

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
    vi.clearAllMocks();
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

  it("blocks same-organization agents without management permission from mutating organization skills", async () => {
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

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockCompanySkillService.importFromSource).not.toHaveBeenCalled();
  });

  it("allows agents with canCreateAgents to mutate organization skills", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      permissions: { canCreateAgents: true },
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
});
