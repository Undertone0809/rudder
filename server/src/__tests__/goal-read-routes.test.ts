import type { Db } from "@rudderhq/db";
import express, { type Request } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { goalRoutes } from "../routes/goals.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const { svc } = vi.hoisted(() => ({ svc: {
  getById: vi.fn(), resolveByReference: vi.fn(), list: vi.fn(), detail: vi.fn(), previewStart: vi.fn(),
  listActivities: vi.fn(), history: vi.fn(), dependencies: vi.fn(),
} }));
vi.mock("../services/index.js", () => ({ goalService: () => svc, heartbeatService: () => ({}), logActivity: vi.fn() }));
const ORG = "10000000-0000-4000-8000-000000000001";
const GOAL = "30000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const BOARD = { type: "board", source: "local_implicit" } as const;
function app(actor: Request["actor"] = BOARD, bridge?: RustFoundationBridge, nativeGoalWrites = false) {
  const result = express();
  result.use(express.json());
  result.use((req, _res, next) => { req.actor = actor; next(); });
  result.use("/api", goalRoutes({} as Db, bridge, { nativeGoalWrites }));
  result.use(errorHandler);
  return result;
}
function registeredGoalRoutes(nativeGoalWrites: boolean) {
  return (goalRoutes({} as Db, undefined, { nativeGoalWrites }) as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
  }).stack.flatMap((layer) => layer.route ? [{ path: layer.route.path, methods: layer.route.methods }] : []);
}
beforeEach(() => {
  vi.clearAllMocks();
  svc.getById.mockResolvedValue({ id: GOAL, orgId: ORG });
  svc.resolveByReference.mockResolvedValue({ goal: { id: GOAL }, ambiguous: false });
});
const selections = [
  { path: `/orgs/${ORG}/goals`, view: "list", goalId: null },
  { path: `/goals/${GOAL}`, view: "detail", goalId: GOAL },
  { path: `/goals/${GOAL}/activities`, view: "activities", goalId: GOAL },
  { path: `/goals/${GOAL}/history?limit=7&cursor=page-two`, view: "history", goalId: GOAL },
  { path: `/goals/${GOAL}/dependencies`, view: "dependencies", goalId: GOAL },
];
describe("Rust Goal GET authority", () => {
  it("unmounts Rust-owned Goal writes and preview only in native mode", () => {
    const writers = [
      ["post", "/orgs/:orgId/goals"],
      ["post", "/orgs/:orgId/goals/start-preview"],
      ["patch", "/goals/:id"],
      ["post", "/goals/:id/activate"],
      ["post", "/goals/:id/plan"],
      ["post", "/goals/:id/activities"],
      ["post", "/goals/:id/owner"],
      ["delete", "/goals/:id"],
    ] as const;
    const legacyRoutes = registeredGoalRoutes(false);
    const nativeRoutes = registeredGoalRoutes(true);

    for (const [method, path] of writers) {
      expect(legacyRoutes.some((route) => route.path === path && route.methods[method])).toBe(true);
      expect(nativeRoutes.some((route) => route.path === path && route.methods[method])).toBe(false);
    }
    for (const [method, path] of [
      ["post", "/orgs/:orgId/goals/start"],
      ["post", "/goals/:id/checkpoint"],
      ["post", "/goals/:id/focus"],
      ["post", "/goals/:id/feedback"],
    ] as const) {
      expect(nativeRoutes.some((route) => route.path === path && route.methods[method])).toBe(true);
    }
  });
  it("keeps the legacy preview service only when the native Goal writer is disabled", async () => {
    const preview = { valid: false, blockers: [{ code: "outcome_required" }] };
    svc.previewStart.mockResolvedValue(preview);
    const body = { title: "A clear result", context: null, ownerAgentId: null, targetTime: null };
    const response = await request(app()).post(`/api/orgs/${ORG}/goals/start-preview`).send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(preview);
    expect(svc.previewStart).toHaveBeenCalledWith(ORG, body);
    const native = await request(app(BOARD, undefined, true)).post(`/api/orgs/${ORG}/goals/start-preview`).send(body);
    expect(native.status).toBe(404);
    expect(svc.previewStart).toHaveBeenCalledTimes(1);
  });

  it.each(selections)("forwards exact native response for $view with mutation pilots off", async ({ path, view, goalId }) => {
    const bytes = Buffer.from('{"native":"public response","long":"' + "x".repeat(100_000) + '"}');
    const goalRead = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body: bytes });
    const response = await request(app(BOARD, { goalRead, mode: "off", projectGoalSetMode: "off" } as unknown as RustFoundationBridge)).get(`/api${path}`);
    expect(response.status).toBe(200);
    expect(response.text).toBe(bytes.toString());
    expect(goalRead).toHaveBeenCalledWith(BOARD, ORG, { view, goalId, ...(view === "history" ? { limit: "7", cursor: "page-two" } : {}) });
    for (const name of ["list", "detail", "listActivities", "history", "dependencies"] as const) expect(svc[name]).not.toHaveBeenCalled();
    if (view === "list") expect(svc.getById).not.toHaveBeenCalled();
  });
  it.each(selections)("fails closed without Rust and on transport failure for $view", async ({ path }) => {
    for (const bridge of [undefined, { goalRead: vi.fn().mockRejectedValue(new Error("stopped")) } as unknown as RustFoundationBridge]) {
      const response = await request(app(BOARD, bridge)).get(`/api${path}`);
      expect(response.status).toBe(503);
      expect(response.body.error).toBe("Rust Goal reads are unavailable");
    }
    for (const name of ["list", "detail", "listActivities", "history", "dependencies"] as const) expect(svc[name]).not.toHaveBeenCalled();
  });
  it.each(selections)("rejects foreign agents and ungranted board access before $view", async ({ path }) => {
    const goalRead = vi.fn();
    for (const actor of [{ type: "agent", source: "agent_key", orgId: OTHER, agentId: "agent" }, { type: "board", source: "session", userId: "user", orgIds: [OTHER] }, { type: "none" }] as Request["actor"][]) {
      const response = await request(app(actor, { goalRead } as unknown as RustFoundationBridge)).get(`/api${path}`);
      expect([401, 403]).toContain(response.status);
    }
    expect(goalRead).not.toHaveBeenCalled();
  });
  it("resolves an authorized short ref and preserves missing/ambiguous behavior", async () => {
    const actor = { type: "agent", source: "agent_key", orgId: ORG, agentId: "agent" } as const;
    const goalRead = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from("{}") });
    const server = app(actor, { goalRead } as unknown as RustFoundationBridge);
    expect((await request(server).get("/api/goals/gol_30000000")).status).toBe(200);
    expect(goalRead).toHaveBeenCalledWith(actor, ORG, { view: "detail", goalId: GOAL });
    goalRead.mockClear(); svc.resolveByReference.mockResolvedValue({ goal: null, ambiguous: true });
    expect((await request(server).get("/api/goals/gol_30000000")).status).toBe(409);
    expect(goalRead).not.toHaveBeenCalled();
    svc.getById.mockResolvedValue(null);
    expect((await request(server).get(`/api/goals/${GOAL}`)).status).toBe(404);
    expect(goalRead).not.toHaveBeenCalled();
  });
  it.each([400, 404, 422, 500, 503])("preserves native failure %s without Node re-execution", async (status) => {
    const body = Buffer.from('{"error":"native error","code":"native_code"}');
    const goalRead = vi.fn().mockResolvedValue({ status, contentType: "application/json", body });
    const response = await request(app(BOARD, { goalRead } as unknown as RustFoundationBridge)).get(`/api/goals/${GOAL}/history?limit=NaN`);
    expect(response.status).toBe(status); expect(response.text).toBe(body.toString());
    expect(goalRead).toHaveBeenCalledWith(BOARD, ORG, { view: "history", goalId: GOAL, cursor: null, limit: "NaN" });
    expect(svc.history).not.toHaveBeenCalled();
  });
});
