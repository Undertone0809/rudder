import type { Db } from "@rudderhq/db";
import * as schemas from "@rudderhq/shared";
import express from "express";
import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { messengerRoutes } from "../routes/messenger.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import type { StorageService } from "../storage/types.js";

const { forbiddenNode } = vi.hoisted(() => ({ forbiddenNode: vi.fn(() => { throw new Error("Node Messenger authority executed"); }) }));
vi.mock("../services/messenger.js", () => ({ messengerService: () => new Proxy({}, { get: () => forbiddenNode }) }));
vi.mock("../services/product-intelligence.js", () => ({ productIntelligenceService: () => ({ execute: forbiddenNode }) }));
vi.mock("../services/index.js", () => Object.fromEntries([
  "accessService", "agentIssueCreationService", "agentService", "automationService", "goalService", "heartbeatService", "issueApprovalService", "issueService", "messengerService", "projectService", "runWorkspaceService", "workProductService", "requestService",
].map((key) => [key, () => new Proxy({}, { get: () => forbiddenNode })]).concat([["logActivity", forbiddenNode]])));
vi.mock("../services/organization-workspace-browser.js", () => ({ organizationWorkspaceBrowserService: () => ({}) }));

const entries = [
  ["post", "/orgs/org/messenger/saved-views/keep"], ["post", "/orgs/org/messenger/saved-views"], ["patch", "/orgs/org/messenger/saved-views/reorder"], ["patch", "/orgs/org/messenger/saved-views/id"], ["delete", "/orgs/org/messenger/saved-views/id"],
  ["post", "/orgs/org/messenger/groups"], ["patch", "/orgs/org/messenger/groups/id"], ["post", "/orgs/org/messenger/groups/id/separate"], ["delete", "/orgs/org/messenger/groups/id"], ["delete", "/orgs/org/messenger/groups/entries/chat%3Aid"], ["post", "/orgs/org/messenger/threads/chat%3Aid/user-state"],
  ["post", "/issues/id/follow"], ["delete", "/issues/id/follow"], ["post", "/orgs/org/messenger/groups/merge"], ["patch", "/orgs/org/messenger/groups/reorder"], ["post", "/orgs/org/messenger/groups/id/entries"], ["patch", "/orgs/org/messenger/groups/id/entries/reorder"], ["post", "/orgs/org/messenger/groups/id/title/regenerate"], ["post", "/orgs/org/messenger/threads/chat%3Aid/read"], ["post", "/orgs/org/messenger/unreads/dismiss"], ["post", "/issues/id/read"],
] as const;

describe("native Messenger personal-state ingress", () => {
  it("omits all 21 Node entries without invoking Node DB, business, bridge or title execution", async () => {
    const db = new Proxy({} as Db, { get: forbiddenNode });
    const bridge = { publicIngressEnabled: true, messengerState: forbiddenNode } as unknown as RustFoundationBridge;
    const messenger = messengerRoutes(db, bridge);
    const issues = issueRoutes(db, {} as StorageService, bridge, { nativeApprovalReads: true });
    const app = express().use("/api", messenger, issues);
    for (const [method, path] of entries) {
      expect((await request(app)[method](`/api${path}`).send({})).status, `${method} ${path}`).toBe(404);
    }
    expect(forbiddenNode).not.toHaveBeenCalled();
    const routes = issues.stack.flatMap((layer) => layer.route ? [layer.route] : []);
    expect(routes.some((route) => route.path === "/issues/:id/approvals" && route.methods.post)).toBe(true);
    expect(routes.some((route) => route.path === "/orgs/:orgId/labels" && route.methods.post)).toBe(true);
  });

  it.each([undefined, false])("preserves the legacy writes when publicIngressEnabled is %s", (publicIngressEnabled) => {
    const db = {} as Db;
    const bridge = { publicIngressEnabled } as RustFoundationBridge;
    const messenger = messengerRoutes(db, bridge);
    expect(messenger.stack.flatMap((layer) => layer.route ? [layer.route] : []).filter((route) => route.methods.post || route.methods.patch || route.methods.delete)).toHaveLength(18);
    const issues = issueRoutes(db, {} as StorageService, bridge);
    const routes = issues.stack.flatMap((layer) => layer.route ? [layer.route] : []);
    expect(routes.filter((route) => ["/issues/:id/read", "/issues/:id/follow"].includes(route.path) && (route.methods.post || route.methods.delete))).toHaveLength(3);
  });

  const byOperation = {
    savedViewKeep: schemas.keepMessengerSavedViewSchema, savedViewUpdate: schemas.updateMessengerSavedViewSchema, savedViewReorder: schemas.reorderMessengerSavedViewsSchema,
    groupCreate: schemas.createMessengerCustomGroupSchema, groupUpdate: schemas.updateMessengerCustomGroupSchema, groupMerge: schemas.createMessengerCustomGroupWithEntriesSchema,
    groupReorder: schemas.reorderMessengerCustomGroupsSchema, groupEntryAssign: schemas.assignMessengerCustomGroupEntrySchema, groupEntryReorder: schemas.reorderMessengerCustomGroupEntriesSchema,
    threadUserState: schemas.updateMessengerThreadUserStateSchema,
  };
  const goldens = JSON.parse(readFileSync(new URL("../../../native/crates/server-foundation/src/public_ingress/messenger_writes/validation-cases.json", import.meta.url), "utf8")) as Array<{ name: string; operation: keyof typeof byOperation; raw?: unknown; missing?: boolean; ok: boolean; value?: unknown; issues?: unknown }>;
  it.each(goldens)("binds current public schema oracle: $name", (golden) => {
    const result = byOperation[golden.operation].safeParse(golden.missing ? undefined : golden.raw);
    expect(result.success).toBe(golden.ok);
    if (result.success) expect(result.data).toEqual(golden.value);
    else expect(result.error.issues).toEqual(golden.issues);
  });
});
