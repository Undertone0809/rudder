import type { Db } from "@rudderhq/db";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { messengerRoutes } from "../routes/messenger.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const { legacyRead } = vi.hoisted(() => ({ legacyRead: vi.fn(() => { throw new Error("Node Messenger business executed"); }) }));
vi.mock("../services/messenger.js", () => ({ messengerService: () => new Proxy({}, { get: () => legacyRead }) }));
vi.mock("../services/product-intelligence.js", () => ({ productIntelligenceService: () => ({}) }));

const shapes = ["groups", "threads", "chat/:conversationId", "issues", "approvals", "system/:threadKind"];

describe("native Messenger read ingress", () => {
  it("omits all six Node GET/HEAD handlers and preserves the existing Saved View cutover alongside native writes", async () => {
    const db = new Proxy({} as Db, { get() { throw new Error("Node DB executed"); } });
    const bridge = { publicIngressEnabled: true } as RustFoundationBridge;
    const router = messengerRoutes(db, bridge);
    const app = express().use("/api", router);
    for (const shape of shapes) {
      const path = `/api/orgs/org/messenger/${shape.replace(":conversationId", "chat").replace(":threadKind", "failed-runs")}`;
      expect((await request(app).get(path)).status, path).toBe(404);
      expect((await request(app).head(path)).status, path).toBe(404);
    }
    expect(legacyRead).not.toHaveBeenCalled();
    const routes = router.stack.flatMap((layer) => layer.route ? [layer.route] : []);
    for (const path of ["/orgs/:orgId/messenger/groups", "/orgs/:orgId/messenger/groups/merge", "/orgs/:orgId/messenger/threads/:threadKey/read", "/orgs/:orgId/messenger/unreads/dismiss", "/orgs/:orgId/messenger/saved-views/keep"]) {
      expect(routes.some((route) => route.path === path && route.methods.post), path).toBe(false);
    }
    expect(routes.some((route) => route.path === "/orgs/:orgId/messenger/saved-views" && route.methods.get)).toBe(false);
  });

  it.each([undefined, false])("retains legacy read registrations when publicIngressEnabled is %s", (publicIngressEnabled) => {
    const router = messengerRoutes({} as Db, { publicIngressEnabled } as RustFoundationBridge);
    const routes = router.stack.flatMap((layer) => layer.route ? [layer.route] : []);
    for (const shape of shapes) {
      expect(routes.some((route) => route.path === `/orgs/:orgId/messenger/${shape}` && route.methods.get), shape).toBe(true);
    }
  });
});
