import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { organizationRoutes } from "../routes/orgs.js";

vi.mock("../services/index.js", () => ({
  organizationService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  organizationPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  organizationSkillService: () => ({
    syncWorkspaceFileChange: vi.fn(),
  }),
  resourceCatalogService: () => ({
    listOrganizationResources: vi.fn(),
    createOrganizationResource: vi.fn(),
    updateOrganizationResource: vi.fn(),
    deleteOrganizationResource: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    ensureMembership: vi.fn(),
  }),
  budgetService: () => ({
    upsertPolicy: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(async (_companyId, config) => ({ config: config ?? {} })),
  }),
  logActivity: vi.fn(),
}));

describe("organization routes malformed issue path guard", () => {
  it("returns a clear error when orgId is missing for issues list path", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: "agent-1",
        orgId: "organization-1",
        source: "agent_key",
      };
      next();
    });
    app.use("/api/orgs", organizationRoutes({} as any));

    const res = await request(app).get("/api/orgs/issues");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Missing orgId in path. Use /api/orgs/{orgId}/issues.",
    });
  });
});
