import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { organizationRoutes } from "../routes/orgs.js";
import { errorHandler } from "../middleware/index.js";

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
  organizationExportJobService: () => ({
    create: vi.fn(),
    get: vi.fn(),
    getResult: vi.fn(),
    cancel: vi.fn(),
  }),
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
  logActivity: mockLogActivity,
}));

function createOrganization() {
  const now = new Date("2026-03-19T02:00:00.000Z");
  return {
    id: "organization-1",
    name: "Rudder",
    description: null,
    status: "active",
    issuePrefix: "PAP",
    issueCounter: 568,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    brandColor: "#123456",
    logoAssetId: "11111111-1111-4111-8111-111111111111",
    logoUrl: "/api/assets/11111111-1111-4111-8111-111111111111/content",
    createdAt: now,
    updatedAt: now,
  };
}

function createApp(actor: Record<string, unknown>) {
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

describe("PATCH /api/orgs/:orgId/branding", () => {
  beforeEach(() => {
    mockCompanyService.update.mockReset();
    mockAgentService.getById.mockReset();
    mockLogActivity.mockReset();
  });

  it("rejects non-CEO agent callers", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "engineer",
    });
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/orgs/organization-1/branding")
      .send({ logoAssetId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("allows CEO agent callers to update branding fields", async () => {
    const organization = createOrganization();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "ceo",
    });
    mockCompanyService.update.mockResolvedValue(organization);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/orgs/organization-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        brandColor: "#123456",
      });

    expect(res.status).toBe(200);
    expect(res.body.logoAssetId).toBe(organization.logoAssetId);
    expect(mockCompanyService.update).toHaveBeenCalledWith("organization-1", {
      logoAssetId: "11111111-1111-4111-8111-111111111111",
      brandColor: "#123456",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
        action: "organization.branding_updated",
        details: {
          logoAssetId: "11111111-1111-4111-8111-111111111111",
          brandColor: "#123456",
        },
      }),
    );
  });

  it("allows board callers to update branding fields", async () => {
    const organization = createOrganization();
    mockCompanyService.update.mockResolvedValue({
      ...organization,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/orgs/organization-1/branding")
      .send({ brandColor: null, logoAssetId: null });

    expect(res.status).toBe(200);
    expect(res.body.brandColor).toBeNull();
    expect(res.body.logoAssetId).toBeNull();
  });

  it("rejects non-branding fields in the request body", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/orgs/organization-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        status: "archived",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});

describe("organization workspace file agent access", () => {
  beforeEach(() => {
    mockAgentService.getById.mockReset();
    mockLogActivity.mockReset();
  });

  it("limits agent workspace file reads to project Library paths", async () => {
    const app = createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app).get("/api/orgs/organization-1/workspace/files?path=agents");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent Library file access is limited to `library:projects/<project-name>/`");
  });

  it("rejects agent workspace file reads that traverse out of project Library paths", async () => {
    const app = createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app).get("/api/orgs/organization-1/workspace/files?path=projects/../agents");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent Library file access is limited to `library:projects/<project-name>/`");
  });

  it("limits agent workspace file writes to project Library paths", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "engineer",
    });
    const app = createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/workspace/file")
      .send({ filePath: "skills/agent-team-design.md", content: "# Design\n" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent Library file access is limited to `library:projects/<project-name>/`");
  });

  it("rejects agent workspace file writes directly under the projects root", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "engineer",
    });
    const app = createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/workspace/file")
      .send({ filePath: "projects/spec.md", content: "# Spec\n" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent Library file access is limited to `library:projects/<project-name>/`");
  });

  it("rejects agent workspace file writes that traverse out of project Library paths", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "engineer",
    });
    const app = createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/workspace/file")
      .send({ filePath: "projects/../skills/agent-team-design.md", content: "# Design\n" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent Library file access is limited to `library:projects/<project-name>/`");
  });
});
