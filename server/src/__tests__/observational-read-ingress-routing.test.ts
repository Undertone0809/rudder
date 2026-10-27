import type { Db } from "@rudderhq/db";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { activityRoutes } from "../routes/activity.js";
import { costRoutes } from "../routes/costs.js";
import { dashboardRoutes } from "../routes/dashboard.js";
import { runWorkspaceRoutes } from "../routes/execution-workspaces.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

vi.mock("../services/activity.js", () => ({ activityService: () => ({}) }));
vi.mock("../services/runtime-kernel/heartbeat.js", () => ({ heartbeatService: () => ({}) }));
vi.mock("../services/index.js", () => ({
  agentService: () => ({}), budgetService: () => ({}), costService: () => ({}),
  financeService: () => ({}), heartbeatService: () => ({}), issueService: () => ({}),
  organizationService: () => ({}), runWorkspaceService: () => ({}),
  workspaceOperationService: () => ({}), logActivity: vi.fn(),
}));

describe("native observational public ingress", () => {
  it("omits all twelve GET/HEAD shapes from Node while retaining writes and skill analytics", async () => {
    const db = new Proxy({} as Db, { get() { throw new Error("Node DB authority executed"); } });
    const read = vi.fn(() => { throw new Error("Node read bridge executed"); });
    const bridge = { publicIngressEnabled: true, activityRead: read, activityLinkRead: read,
      overviewRead: read, runWorkspaceRead: read } as unknown as RustFoundationBridge;
    const routers = [activityRoutes(db, bridge), costRoutes(db, bridge), dashboardRoutes(db, bridge), runWorkspaceRoutes(db, bridge)];
    const app = express();
    for (const router of routers) app.use("/api", router);
    for (const path of [
      "/orgs/org/activity", "/issues/issue/activity", "/issues/issue/runs",
      "/heartbeat-runs/run/issues", "/agent-runs/run/issues", "/orgs/org/users/me/activity-ledger",
      "/orgs/org/dashboard", "/orgs/org/budgets/overview", "/orgs/org/run-workspaces",
      "/orgs/org/execution-workspaces", "/run-workspaces/workspace", "/execution-workspaces/workspace",
    ]) {
      expect((await request(app).get(`/api${path}`)).status, path).toBe(404);
      expect((await request(app).head(`/api${path}`)).status, path).toBe(404);
    }
    expect(read).not.toHaveBeenCalled();
    const registered = routers.flatMap((router) => router.stack.flatMap((layer) => layer.route ? [layer.route] : []));
    expect(registered.some((route) => route.path === "/orgs/:orgId/activity" && route.methods.post)).toBe(true);
    expect(registered.some((route) => Array.isArray(route.path) && route.path.includes("/run-workspaces/:id") && route.methods.patch)).toBe(true);
    expect(registered.some((route) => route.path === "/orgs/:orgId/dashboard/skills/analytics" && route.methods.get)).toBe(true);
  });
});
