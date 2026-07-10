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
  list: vi.fn(),
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

const mockExportJobService = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  getResult: vi.fn(),
  requiresInstanceAdmin: vi.fn(),
  cancel: vi.fn(),
}));

const mockOrganizationSkillService = vi.hoisted(() => ({
  syncWorkspaceFileChange: vi.fn(),
  hasLocalPathSkills: vi.fn(),
}));
const mockResourceCatalogService = vi.hoisted(() => ({
  listOrganizationResources: vi.fn(),
  createOrganizationResource: vi.fn(),
  updateOrganizationResource: vi.fn(),
  deleteOrganizationResource: vi.fn(),
}));
const mockDocumentService = vi.hoisted(() => ({
  listLibraryDocuments: vi.fn(),
  createLibraryDocument: vi.fn(),
  getLibraryDocumentById: vi.fn(),
  updateLibraryDocument: vi.fn(),
  deleteLibraryDocument: vi.fn(),
}));
const mockWorkspaceBackupService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
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
  organizationExportJobService: () => mockExportJobService,
  organizationPortabilityService: () => mockCompanyPortabilityService,
  organizationSkillService: () => mockOrganizationSkillService,
  resourceCatalogService: () => mockResourceCatalogService,
  documentService: () => mockDocumentService,
  workspaceBackupService: () => mockWorkspaceBackupService,
  organizationService: () => mockCompanyService,
  secretService: () => mockSecretService,
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
  logActivity: mockLogActivity,
}));

async function createApp(
  actor: Record<string, unknown> | ((req: express.Request) => Record<string, unknown>),
) {
  const { organizationRoutes } = await import("../routes/orgs.js");
  const { errorHandler } = await import("../middleware/index.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = typeof actor === "function" ? actor(req) : actor;
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
    mockAgentService.list.mockReset().mockResolvedValue([]);
    mockCompanyPortabilityService.exportBundle.mockReset();
    mockCompanyPortabilityService.previewExport.mockReset();
    mockCompanyPortabilityService.previewImport.mockReset();
    mockCompanyPortabilityService.importBundle.mockReset();
    mockExportJobService.create.mockReset();
    mockExportJobService.get.mockReset();
    mockExportJobService.getResult.mockReset();
    mockExportJobService.requiresInstanceAdmin.mockReset().mockReturnValue(false);
    mockExportJobService.cancel.mockReset();
    mockOrganizationSkillService.hasLocalPathSkills.mockReset().mockResolvedValue(false);
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
    mockAgentService.list.mockResolvedValue([{
      id: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      name: "CEO",
      status: "active",
      agentRuntimeConfig: {},
    }]);
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

  it("rejects external instruction exports from CEO agents and non-admin board members", { timeout: 10000 }, async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      role: "ceo",
    });
    mockAgentService.list.mockResolvedValue([{
      id: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      name: "CEO",
      status: "active",
      agentRuntimeConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/etc",
        instructionsFilePath: "/etc/passwd",
      },
    }]);

    const agentApp = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });
    const boardApp = await createApp({
      type: "board",
      userId: "organization-member",
      orgIds: ["11111111-1111-4111-8111-111111111111"],
      source: "session",
      isInstanceAdmin: false,
    });

    const agentRes = await request(agentApp)
      .post("/api/orgs/11111111-1111-4111-8111-111111111111/exports/preview")
      .send({ include: { organization: true, agents: true } });
    const boardRes = await request(boardApp)
      .post("/api/orgs/11111111-1111-4111-8111-111111111111/export")
      .send({ include: { organization: true, agents: true } });

    expect(agentRes.status).toBe(403);
    expect(boardRes.status).toBe(403);
    expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.exportBundle).not.toHaveBeenCalled();
  });

  it("allows instance admins to export agents with external instructions", async () => {
    mockOrganizationSkillService.hasLocalPathSkills.mockResolvedValue(true);
    mockAgentService.list.mockResolvedValue([{
      id: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      name: "External Agent",
      status: "active",
      agentRuntimeConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/srv/rudder-instructions",
        instructionsFilePath: "/srv/rudder-instructions/SOUL.md",
      },
    }]);
    mockCompanyPortabilityService.exportBundle.mockResolvedValue({
      rootPath: "rudder",
      manifest: {},
      files: {},
      warnings: [],
    });
    const app = await createApp({
      type: "board",
      userId: "instance-admin",
      orgIds: [],
      source: "session",
      isInstanceAdmin: true,
    });

    const res = await request(app)
      .post("/api/orgs/11111111-1111-4111-8111-111111111111/export")
      .send({ include: { organization: true, agents: true } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanyPortabilityService.exportBundle).toHaveBeenCalled();
  });

  it("blocks local skill export and safe-import surfaces for CEO agents and ordinary boards", { timeout: 10000 }, async () => {
    mockOrganizationSkillService.hasLocalPathSkills.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      role: "ceo",
    });
    const agentApp = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      source: "agent_key",
      runId: "run-1",
    });
    const boardApp = await createApp({
      type: "board",
      userId: "organization-member",
      orgIds: ["11111111-1111-4111-8111-111111111111"],
      source: "session",
      isInstanceAdmin: false,
    });

    const agentExport = await request(agentApp)
      .post("/api/orgs/11111111-1111-4111-8111-111111111111/exports/preview")
      .send({ include: { organization: true, agents: false, skills: true } });
    const boardExport = await request(boardApp)
      .post("/api/orgs/11111111-1111-4111-8111-111111111111/export")
      .send({ include: { organization: true, agents: false, skills: true } });
    const agentImport = await request(agentApp)
      .post("/api/orgs/11111111-1111-4111-8111-111111111111/imports/preview")
      .send({
        source: { type: "inline", files: { "ORGANIZATION.md": "---\nname: Test\n---\n" } },
        include: { organization: true, agents: false, projects: false, issues: false, skills: true },
        target: { mode: "existing_organization", orgId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "rename",
      });

    expect(agentExport.status, JSON.stringify(agentExport.body)).toBe(403);
    expect(boardExport.status, JSON.stringify(boardExport.body)).toBe(403);
    expect(agentImport.status, JSON.stringify(agentImport.body)).toBe(403);
    expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.exportBundle).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it("keeps external-instruction export job results restricted to instance admins", async () => {
    mockAgentService.list.mockResolvedValue([{
      id: "agent-1",
      orgId: "11111111-1111-4111-8111-111111111111",
      name: "External Agent",
      status: "active",
      agentRuntimeConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/srv/rudder-instructions",
        instructionsFilePath: "/srv/rudder-instructions/SOUL.md",
      },
    }]);
    const job = {
      id: "77777777-7777-4777-8777-777777777777",
      orgId: "11111111-1111-4111-8111-111111111111",
      status: "succeeded",
      resultAvailable: true,
    };
    mockExportJobService.create.mockReturnValue(job);
    mockExportJobService.get.mockReturnValue(job);
    mockExportJobService.requiresInstanceAdmin.mockReturnValue(true);
    mockExportJobService.getResult.mockReturnValue({ files: { "agents/external/SOUL.md": "secret" } });

    const app = await createApp((req) => req.header("x-test-admin") === "true"
      ? {
          type: "board",
          userId: "instance-admin",
          orgIds: [],
          source: "session",
          isInstanceAdmin: true,
        }
      : {
          type: "board",
          userId: "organization-member",
          orgIds: ["11111111-1111-4111-8111-111111111111"],
          source: "session",
          isInstanceAdmin: false,
        });

    const createRes = await request(app)
      .post("/api/orgs/11111111-1111-4111-8111-111111111111/exports/jobs")
      .set("x-test-admin", "true")
      .send({ include: { organization: true, agents: true } });
    const memberResultRes = await request(app)
      .get("/api/orgs/11111111-1111-4111-8111-111111111111/exports/jobs/77777777-7777-4777-8777-777777777777/result");

    expect(createRes.status, JSON.stringify(createRes.body)).toBe(202);
    expect(mockExportJobService.create).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.any(Function),
      { requiresInstanceAdmin: true },
    );
    expect(memberResultRes.status).toBe(403);
    expect(mockExportJobService.getResult).not.toHaveBeenCalled();
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

  it("requires instance-admin authority for board-full imports containing executable entities", async () => {
    const app = await createApp({
      type: "board",
      userId: "organization-member",
      orgIds: ["11111111-1111-4111-8111-111111111111"],
      source: "session",
      isInstanceAdmin: false,
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
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
  });

  it.each([
    ["preview", "/api/orgs/import/preview"],
    ["apply", "/api/orgs/import"],
  ])("requires instance-admin authority for organization-and-skill-only replace %s", async (_label, route) => {
    const app = await createApp({
      type: "board",
      userId: "organization-member",
      orgIds: ["11111111-1111-4111-8111-111111111111"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(route)
      .send({
        source: { type: "inline", files: { "ORGANIZATION.md": "---\nname: Test\n---\n" } },
        include: { organization: true, agents: false, projects: false, issues: false, skills: true },
        target: { mode: "existing_organization", orgId: "11111111-1111-4111-8111-111111111111" },
        collisionStrategy: "replace",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Instance admin access required");
    expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
    expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
  });
});
