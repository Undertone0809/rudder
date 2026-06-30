import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unprocessable } from "../errors.js";
import { errorHandler } from "../middleware/index.js";

const mockOrganizationIntelligenceProfiles = vi.hoisted(() => ({
  list: vi.fn(),
  getByPurpose: vi.fn(),
  upsert: vi.fn(),
  ensureDefaultsFromRuntime: vi.fn(),
}));
const mockOrganizationIntelligenceRuntimeChain = vi.hoisted(() => ({
  assertUsable: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_orgId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_orgId: string, config: Record<string, unknown>) => ({
    config,
    secretKeys: new Set<string>(),
  })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTestEnvironment = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn(() => ({
  type: "codex_local",
  execute: vi.fn(),
  testEnvironment: mockTestEnvironment,
})));

vi.mock("../agent-runtimes/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ ensureMembership: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  documentService: () => ({
    listLibraryDocuments: vi.fn(),
    createLibraryDocument: vi.fn(),
    getLibraryDocumentById: vi.fn(),
    updateLibraryDocument: vi.fn(),
    deleteLibraryDocument: vi.fn(),
  }),
  organizationExportJobService: () => ({
    create: vi.fn(),
    get: vi.fn(),
    getResult: vi.fn(),
    cancel: vi.fn(),
  }),
  organizationIntelligenceProfileService: () => mockOrganizationIntelligenceProfiles,
  organizationIntelligenceRuntimeChainService: () => mockOrganizationIntelligenceRuntimeChain,
  organizationPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  organizationService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  organizationSkillService: () => ({ syncWorkspaceFileChange: vi.fn() }),
  resourceCatalogService: () => ({
    listOrganizationResources: vi.fn(),
    createOrganizationResource: vi.fn(),
    updateOrganizationResource: vi.fn(),
    deleteOrganizationResource: vi.fn(),
  }),
  secretService: () => mockSecretService,
  workspaceBackupService: () => ({
    list: vi.fn(),
    create: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    restore: vi.fn(),
    remove: vi.fn(),
  }),
  logActivity: mockLogActivity,
}));

async function createApp() {
  const { organizationRoutes } = await import("../routes/orgs.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: "user-1",
      orgIds: ["org-1"],
    };
    next();
  });
  app.use("/api/orgs", organizationRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function profile(status: "configured" | "disabled" | "invalid") {
  return {
    id: "profile-lightweight",
    orgId: "org-1",
    purpose: "lightweight",
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: { model: "gpt-5.4-mini" },
    status,
    lastError: null,
    lastVerifiedAt: new Date("2026-06-18T00:00:00.000Z"),
    createdAt: new Date("2026-06-18T00:00:00.000Z"),
    updatedAt: new Date("2026-06-18T00:00:00.000Z"),
  };
}

describe("organization intelligence profile routes", () => {
  beforeEach(() => {
    mockOrganizationIntelligenceProfiles.upsert.mockReset();
    mockSecretService.normalizeAdapterConfigForPersistence.mockClear();
    mockSecretService.resolveAdapterConfigForRuntime.mockClear();
    mockLogActivity.mockReset();
    mockOrganizationIntelligenceRuntimeChain.assertUsable.mockReset();
    mockTestEnvironment.mockReset();
    mockFindServerAdapter.mockClear();
    mockTestEnvironment.mockResolvedValue({
      agentRuntimeType: "codex_local",
      status: "pass",
      testedAt: "2026-06-18T00:00:00.000Z",
      checks: [],
    });
    mockOrganizationIntelligenceProfiles.upsert.mockImplementation(async (_orgId, purpose, input) => ({
      ...profile(input.status),
      purpose,
      agentRuntimeType: input.agentRuntimeType,
      agentRuntimeConfig: input.agentRuntimeConfig,
      lastVerifiedAt: input.lastVerifiedAt ?? null,
      lastError: input.lastError ?? null,
    }));
  });

  it("runs the full runtime chain before accepting configured status", async () => {
    const app = await createApp();

    const res = await request(app)
      .put("/api/orgs/org-1/intelligence-profiles/lightweight")
      .send({
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4-mini",
          modelReasoningEffort: "low",
          modelFallbacks: [{
            agentRuntimeType: "claude_local",
            model: "claude-sonnet-4-5",
            config: {
              effort: "medium",
            },
          }],
        },
        status: "configured",
    });

    expect(res.status).toBe(200);
    expect(mockOrganizationIntelligenceRuntimeChain.assertUsable).toHaveBeenCalledWith(
      "org-1",
      "codex_local",
      {
        model: "gpt-5.4-mini",
        modelReasoningEffort: "low",
        modelFallbacks: [{
          agentRuntimeType: "claude_local",
          model: "claude-sonnet-4-5",
          config: {
            effort: "medium",
          },
        }],
      },
    );
    expect(mockOrganizationIntelligenceProfiles.upsert).toHaveBeenCalledWith(
      "org-1",
      "lightweight",
      expect.objectContaining({
        status: "configured",
        lastVerifiedAt: expect.any(Date),
        lastError: null,
      }),
    );
  });

  it("rejects configured status when the runtime chain does not pass", async () => {
    mockOrganizationIntelligenceRuntimeChain.assertUsable.mockRejectedValueOnce(
      unprocessable("Runtime chain test failed for Primary: Model is not available."),
    );
    const app = await createApp();

    const res = await request(app)
      .put("/api/orgs/org-1/intelligence-profiles/lightweight")
      .send({
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {
          model: "gpt-5.4-mini",
        },
        status: "configured",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Runtime chain test failed for Primary");
    expect(mockOrganizationIntelligenceProfiles.upsert).not.toHaveBeenCalled();
  });
});
