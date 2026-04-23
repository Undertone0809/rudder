import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockOrganizationSkillService = vi.hoisted(() => ({
  syncWorkspaceFileChange: vi.fn(),
}));
const mockResourceCatalogService = vi.hoisted(() => ({
  listOrganizationResources: vi.fn(),
  createOrganizationResource: vi.fn(),
  updateOrganizationResource: vi.fn(),
  deleteOrganizationResource: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown> | null | undefined) => ({
    config: config ?? {},
  })),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  organizationPortabilityService: () => mockCompanyPortabilityService,
  organizationSkillService: () => mockOrganizationSkillService,
  resourceCatalogService: () => mockResourceCatalogService,
  organizationService: () => mockCompanyService,
  secretService: () => mockSecretService,
  logActivity: mockLogActivity,
}));

async function createApp(actor: Record<string, unknown>) {
  const { organizationRoutes } = await import("../routes/orgs.js");
  const { errorHandler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/orgs", organizationRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("organization portability routes", () => {
  beforeEach(() => {
    vi.resetModules();
    mockAgentService.getById.mockReset();
    mockCompanyPortabilityService.exportBundle.mockReset();
    mockCompanyPortabilityService.previewExport.mockReset();
    mockCompanyPortabilityService.previewImport.mockReset();
    mockCompanyPortabilityService.importBundle.mockReset();
    mockLogActivity.mockReset();
  });

  it("rejects non-CEO agents from CEO-safe export preview routes", { timeout: 10000 }, async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/orgs/11111111-1111-4111-8111-111111111111/exports/preview")
      .send({ include: { organization: true, agents: true, projects: true } });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
  });

  it("allows CEO agents to use organization-scoped export preview routes", { timeout: 10000 }, async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      role: "ceo",
    });
    mockCompanyPortabilityService.previewExport.mockResolvedValue({
      rootPath: "rudder",
      manifest: { agents: [], skills: [], projects: [], issues: [], envInputs: [], includes: { organization: true, agents: true, projects: true, issues: false, skills: false }, organization: null, schemaVersion: 1, generatedAt: new Date().toISOString(), source: null },
      files: {},
      fileInventory: [],
      counts: { files: 0, agents: 0, skills: 0, projects: 0, issues: 0 },
      warnings: [],
      rudderExtensionPath: ".rudder.yaml",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/orgs/11111111-1111-4111-8111-111111111111/exports/preview")
      .send({ include: { organization: true, agents: true, projects: true } });

    expect(res.status).toBe(200);
    expect(mockCompanyPortabilityService.previewExport).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      include: { organization: true, agents: true, projects: true },
    });
  });

  it("rejects replace collision strategy on CEO-safe import routes", { timeout: 10000 }, async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      role: "ceo",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/orgs/11111111-1111-4111-8111-111111111111/imports/preview")
      .send({
        source: { type: "inline", files: { "ORGANIZATION.md": "---\nname: Test\n---\n" } },
        include: { organization: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_organization", orgId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "replace",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("does not allow replace");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it("keeps global import preview routes board-only", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/orgs/import/preview")
      .send({
        source: { type: "inline", files: { "ORGANIZATION.md": "---\nname: Test\n---\n" } },
        include: { organization: true, agents: true, projects: false, issues: false },
        target: { mode: "existing_organization", orgId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "rename",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
  });
});
