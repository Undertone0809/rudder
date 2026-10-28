import type { Db } from "@rudderhq/db";
import { createIssueLabelSchema, updateIssueLabelSchema } from "@rudderhq/shared";
import express, { type Request } from "express";
import { readFileSync } from "node:fs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import type { StorageService } from "../storage/types.js";

const org = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const agent = "33333333-3333-4333-8333-333333333333";
const row = { id, orgId: org, name: "Roadmap", color: "#aB10Ef", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const mocks = vi.hoisted(() => ({ getLabelById: vi.fn(), createLabel: vi.fn(), updateLabel: vi.fn(), deleteLabel: vi.fn(), audit: vi.fn() }));
vi.mock("../services/index.js", () => ({
  issueService: () => mocks, logActivity: (...args: unknown[]) => mocks.audit(...args),
  accessService: () => ({}), agentService: () => ({}), agentIssueCreationService: () => ({}),
  automationService: () => ({}), goalService: () => ({}), heartbeatService: () => ({}),
  issueApprovalService: () => ({}), messengerService: () => ({}), projectService: () => ({}),
  runWorkspaceService: () => ({}), workProductService: () => ({}), requestService: () => ({}),
  organizationIntelligenceProfileService: () => ({}), organizationIntelligenceRuntimeChainService: () => ({}),
}));
vi.mock("../services/organization-workspace-browser.js", () => ({ organizationWorkspaceBrowserService: () => ({}) }));
const actors: Request["actor"][] = [
  { type: "board", source: "local_implicit", userId: "label-board" },
  { type: "agent", source: "agent_key", agentId: agent, orgId: org },
];
const writes = [
  { method: "post", path: `/api/orgs/${org}/labels`, body: { name: "  Roadmap  ", color: "#aB10Ef", unknown: true } },
  { method: "patch", path: `/api/labels/${id}`, body: { color: "#aB10Ef", unknown: true } },
  { method: "delete", path: `/api/labels/${id}`, body: undefined },
] as const;
function app(selected: boolean, actor: Request["actor"], bridge?: RustFoundationBridge) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  const db = new Proxy({} as Db, { get() { throw new Error("Node DB authority executed"); } });
  const router = issueRoutes(db, {} as StorageService, bridge, { nativeApprovalReads: selected });
  app.use("/api", router); app.use(errorHandler); return { app, router };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.getLabelById.mockResolvedValue(row); mocks.deleteLabel.mockResolvedValue(row);
  mocks.createLabel.mockImplementation(async (_org: string, body: Record<string, unknown>) => ({ ...row, ...body }));
  mocks.updateLabel.mockImplementation(async (_id: string, body: Record<string, unknown>) => ({ ...row, ...body }));
  mocks.audit.mockResolvedValue(undefined);
});
describe("Label writes at required native ingress", () => {
  it.each(writes)("omits $method $path before Node validation, lookup, persistence and activity", async ({ method, path, body }) => {
    for (const bridge of [undefined, { publicIngressEnabled: true } as RustFoundationBridge]) {
      for (const actor of [...actors, { type: "none" } as Request["actor"]]) {
        for (const input of [body, { forged: true }]) expect((await request(app(true, actor, bridge).app)[method](path).send(input)).status).toBe(404);
      }
    }
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
  it.each(writes)("keeps unselected Board and Agent compatibility for $method $path", async ({ method, path, body }) => {
    for (const actor of actors) expect((await request(app(false, actor).app)[method](path).send(body)).status).toBe(method === "post" ? 201 : 200);
    expect(mocks.audit).toHaveBeenCalledTimes(2);
  });
  it("keeps legacy schema validation before lookup and strips undeclared fields", async () => {
    const server = app(false, actors[0]!).app;
    expect((await request(server).patch(`/api/labels/${id}`).send({ unknown: true })).body).toEqual({ error: "Validation error", details: [{ code: "custom", message: "At least one label field must be provided", path: [] }] });
    expect(mocks.getLabelById).not.toHaveBeenCalled();
    expect((await request(server).post(`/api/orgs/${org}/labels`).send(writes[0].body)).status).toBe(201);
    expect(mocks.createLabel).toHaveBeenCalledWith(org, { name: "Roadmap", color: "#aB10Ef" });
  });
  it("keeps already-migrated Label reads omitted under the same native selection", () => {
    const selected = app(true, actors[0]!).router.stack.flatMap((layer) => layer.route ? [layer.route] : []);
    expect(selected.some((route) => route.path === "/orgs/:orgId/labels")).toBe(false);
    const legacy = app(false, actors[0]!).router.stack.flatMap((layer) => layer.route ? [layer.route] : []);
    expect(legacy.some((route) => route.path === "/orgs/:orgId/labels" && route.methods.get)).toBe(true);
  });
});
const cases = JSON.parse(readFileSync(new URL("../../../native/crates/d1-persistence/src/label_writes-validation-cases.json", import.meta.url), "utf8")) as Array<{ operation: string; input?: unknown; output?: unknown; issues?: unknown[] }>;
describe("Label Rust validation oracle against the existing shared schemas", () => {
  it.each(cases)("pins $operation input $input", ({ operation, input, output, issues }) => {
    const result = (operation === "create" ? createIssueLabelSchema : updateIssueLabelSchema).safeParse(input);
    if (issues) { expect(result.success).toBe(false); if (!result.success) expect(result.error.issues).toEqual(issues); }
    else { expect(result.success).toBe(true); if (result.success) expect(result.data).toEqual(output); }
  });
});
