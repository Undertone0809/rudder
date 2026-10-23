import type { Db } from "@rudderhq/db";
import express, { type Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { organizationRoutes } from "../routes/orgs.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const ORG = "10000000-0000-4000-8000-000000000001";
const RESOURCE = "20000000-0000-4000-8000-000000000001";
const BOARD = { type: "board", source: "local_implicit", userId: "synthetic-user" } as const;

const mocks = vi.hoisted(() => {
  const resources = {
    createOrganizationResource: vi.fn(),
    updateOrganizationResource: vi.fn(),
    removeOrganizationResource: vi.fn(),
  };
  return {
    resources,
    resourceCatalogService: vi.fn(() => resources),
    logActivity: vi.fn(),
  };
});

vi.mock("../services/resource-catalog.js", () => ({
  resourceCatalogService: mocks.resourceCatalogService,
}));
vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));

function app(actor: Request["actor"] = BOARD, nativeResourceRoutes = false) {
  const result = express();
  result.use(express.json());
  const organizationCatalogRead = vi.fn().mockResolvedValue({
    status: 200,
    contentType: "application/json",
    body: Buffer.from("[]"),
  });
  const organizationResourceMutation = vi.fn();
  const dbExecute = vi.fn().mockResolvedValue([{ timezone: "UTC", requires_rust: false }]);
  const db = { execute: dbExecute } as unknown as Db;
  const bridge = { organizationCatalogRead, organizationResourceMutation } as unknown as RustFoundationBridge;
  result.use((req, _res, next) => { req.actor = actor; next(); });
  result.use("/api/orgs", organizationRoutes(db, undefined, undefined, bridge, { nativeResourceRoutes }));
  result.use(errorHandler);
  return { app: result, organizationCatalogRead, organizationResourceMutation, dbExecute };
}

describe("Organization catalog route authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resources.createOrganizationResource.mockResolvedValue({
      id: RESOURCE,
      orgId: ORG,
      name: "Created through Node",
      kind: "file",
      sourceType: "external",
      locator: "https://example.test/resource",
    });
    mocks.resources.updateOrganizationResource.mockResolvedValue({
      id: RESOURCE,
      orgId: ORG,
      name: "Updated through Node",
    });
    mocks.resources.removeOrganizationResource.mockResolvedValue({
      id: RESOURCE,
      orgId: ORG,
      name: "Updated through Node",
    });
  });

  it("keeps the legacy Node catalog flow available when native public ingress is off", async () => {
    const instance = app();
    const resources = await request(instance.app).get(`/api/orgs/${ORG}/resources`);
    const profiles = await request(instance.app).get(`/api/orgs/${ORG}/intelligence-profiles`);
    const created = await request(instance.app)
      .post(`/api/orgs/${ORG}/resources`)
      .send({ name: "Created through Node", kind: "file", locator: "https://example.test/resource" });
    const updated = await request(instance.app)
      .patch(`/api/orgs/${ORG}/resources/${RESOURCE}`)
      .send({ name: "Updated through Node" });
    const deleted = await request(instance.app).delete(`/api/orgs/${ORG}/resources/${RESOURCE}`);

    expect(resources.status).toBe(200);
    expect(profiles.status).toBe(200);
    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(deleted.status).toBe(200);
    expect(mocks.resourceCatalogService).toHaveBeenCalledOnce();
    expect(mocks.resources.createOrganizationResource).toHaveBeenCalledWith(ORG, expect.objectContaining({
      name: "Created through Node",
      kind: "file",
      sourceType: "external",
      locator: "https://example.test/resource",
    }));
    expect(mocks.resources.updateOrganizationResource).toHaveBeenCalledWith(ORG, RESOURCE, {
      name: "Updated through Node",
    });
    expect(mocks.resources.removeOrganizationResource).toHaveBeenCalledWith(ORG, RESOURCE);
    expect(mocks.logActivity).toHaveBeenCalledTimes(3);
    expect(instance.organizationCatalogRead).toHaveBeenCalledTimes(2);
    expect(instance.organizationResourceMutation).not.toHaveBeenCalled();
  });

  it("does not register the five legacy handlers when native public ingress is configured", async () => {
    const instance = app(BOARD, true);
    const requests = [
      () => request(instance.app).get(`/api/orgs/${ORG}/resources`),
      () => request(instance.app).post(`/api/orgs/${ORG}/resources`).send({ name: "No Node create", kind: "file", locator: "https://example.test/resource" }),
      () => request(instance.app).patch(`/api/orgs/${ORG}/resources/${RESOURCE}`).send({ name: "No Node update" }),
      () => request(instance.app).delete(`/api/orgs/${ORG}/resources/${RESOURCE}`),
      () => request(instance.app).get(`/api/orgs/${ORG}/intelligence-profiles`),
    ];

    for (const makeRequest of requests) {
      expect((await makeRequest()).status).toBe(404);
    }
    expect(mocks.resourceCatalogService).not.toHaveBeenCalled();
    expect(instance.organizationCatalogRead).not.toHaveBeenCalled();
    expect(instance.organizationResourceMutation).not.toHaveBeenCalled();
    expect(instance.dbExecute).not.toHaveBeenCalled();
  });
});
