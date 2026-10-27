import type { Db } from "@rudderhq/db";
import express, { Router } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { registerAgentManagementRoutes } from "../routes/agents.management-routes.js";
import { calendarRoutes } from "../routes/calendar.js";
import { messengerRoutes } from "../routes/messenger.js";
import { organizationRoutes } from "../routes/orgs.js";
import { secretRoutes } from "../routes/secrets.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

vi.mock("../services/index.js", () => ({
  accessService: () => ({}), agentService: () => ({}), budgetService: () => ({}), documentService: () => ({}),
  organizationExportJobService: () => ({}), organizationIntelligenceProfileService: () => ({}),
  organizationIntelligenceRuntimeChainService: () => ({}), organizationPortabilityService: () => ({}),
  organizationService: () => ({}), organizationSkillService: () => ({}), resourceCatalogService: () => ({}),
  secretService: () => ({}), workspaceBackupService: () => ({}), organizationMemberService: () => ({}),
  issueService: () => ({}), logActivity: vi.fn(), syncInstructionsBundleConfigFromFilePath: vi.fn(),
  handoffOrganizationBrandingAuthority: vi.fn(),
}));
vi.mock("../services/calendar.js", () => ({ calendarService: () => ({}) }));
vi.mock("../services/messenger.js", () => ({ messengerService: () => ({}) }));
vi.mock("../services/product-intelligence.js", () => ({ productIntelligenceService: () => ({}) }));
vi.mock("../services/library-entries.js", () => ({ libraryEntryService: () => ({}) }));
vi.mock("../services/organization-workspace-browser.js", () => ({ organizationWorkspaceBrowserService: () => ({}) }));
vi.mock("../services/delegation-runs.js", () => ({ delegationRunService: () => ({}) }));

describe("last existing Rust reads public cutover", () => {
  it("omits all thirteen Node GET/HEAD registrations while keeping writes and adjacent reads", async () => {
    const db = new Proxy({} as Db, { get() { throw new Error("Node DB authority executed"); } });
    const bridge = { publicIngressEnabled: true } as RustFoundationBridge;
    const app = express();
    const calendar = calendarRoutes(db, bridge), secrets = secretRoutes(db, bridge), messenger = messengerRoutes(db, bridge);
    const organizations = organizationRoutes(db, undefined, undefined, bridge, { nativeResourceRoutes: true, nativeOrganizationWrites: true });
    const agents = Router(); registerAgentManagementRoutes({ router: agents, db, rustFoundationBridge: bridge });
    app.use("/api/orgs", organizations);
    for (const router of [calendar, secrets, messenger, agents]) app.use("/api", router);
    for (const path of ["/orgs/o/calendar/sources", "/orgs/o/calendar/events", "/orgs/o/calendar/events/e", "/orgs/o/secrets", "/orgs/o/secret-providers", "/orgs/o/messenger/saved-views", "/orgs/o/messenger/saved-views/s", "/orgs/o/live-runs", "/issues/i/live-runs", "/orgs/o/workspace/backups", "/orgs/o/workspace/backups/b/files", "/orgs/o/workspace/backups/b/file", "/orgs/o/workspace/backups/b/download"]) {
      expect((await request(app).get(`/api${path}`)).status, path).toBe(404);
      expect((await request(app).head(`/api${path}`)).status, path).toBe(404);
    }
    const routes = [calendar, secrets, messenger, organizations, agents].flatMap((router) => router.stack.flatMap((layer) => layer.route ? [layer.route] : []));
    expect(routes.some((route) => route.path === "/orgs/:orgId/calendar/sources" && route.methods.post)).toBe(true);
    expect(routes.some((route) => route.path === "/orgs/:orgId/calendar/google/config" && route.methods.get)).toBe(true);
    expect(routes.some((route) => route.path === "/orgs/:orgId/messenger/groups" && route.methods.get)).toBe(true);
    expect(routes.some((route) => route.path === "/:orgId/workspace/backups/:backupId/restore" && route.methods.post)).toBe(true);
    expect(routes.some((route) => route.path === "/agent-runs/:runId/log" && route.methods.get)).toBe(true);
  });
});
