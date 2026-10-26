import {
  agentApiKeys, agents, applyPendingMigrations, assets, authUsers, boardApiKeys,
  createDb, createLocalPostgresInstance, ensurePostgresDatabase, issueAttachments,
  issueFollows, issueWorkProducts, issues, organizationIntelligenceProfiles,
  organizationMemberships, organizationResources, organizations, type LocalPostgresInstance,
} from "@rudderhq/db";
import { parseShortRef } from "@rudderhq/shared";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { unprocessable } from "../errors.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { assertBoard, assertCompanyAccess, getAuthorizedOrgScope } from "../routes/authz.js";
import { issueRoutes } from "../routes/issues.js";
import { organizationRoutes } from "../routes/orgs.js";
import { requestIssueMetadataRead } from "../services/issue-metadata-read-bridge.js";
import { resolveIssueReference } from "../services/issue-references.js";
import { issueService } from "../services/issues.js";
import { requestOrganizationCatalogRead } from "../services/organization-catalog-read-bridge.js";
import { organizationIntelligenceProfileService } from "../services/organization-intelligence-profiles.js";
import { resourceCatalogService } from "../services/resource-catalog.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import { workProductService } from "../services/work-products.js";
import type { StorageService } from "../storage/types.js";
import { nativeIdentityIngressFixture } from "./helpers/native-identity-ingress.js";

const interception = vi.hoisted(() => ({ afterIdentity: undefined as undefined | ((id: string) => Promise<void>) }));
vi.mock("../services/index.js", async (original) => {
  const services = await original<typeof import("../services/index.js")>();
  const forbidden = () => { throw new Error("Node metadata/catalog business reader must not execute"); };
  return { ...services,
    issueService: (...args: Parameters<typeof services.issueService>) => ({ ...services.issueService(...args), getById: forbidden, listAttachments: forbidden, listFollows: forbidden }),
    workProductService: (...args: Parameters<typeof services.workProductService>) => ({ ...services.workProductService(...args), listForIssue: forbidden }),
    resourceCatalogService: (...args: Parameters<typeof services.resourceCatalogService>) => ({ ...services.resourceCatalogService(...args), listOrganizationResources: forbidden }),
    organizationIntelligenceProfileService: (...args: Parameters<typeof services.organizationIntelligenceProfileService>) => ({ ...services.organizationIntelligenceProfileService(...args), list: forbidden }),
  };
});
async function afterIdentity(id: string) {
  const hook = interception.afterIdentity; interception.afterIdentity = undefined;
  if (hook) await hook(id);
}
// Same public contract and real legacy projections after the separately proven
// organization isolation repair. The selected production handlers never use these.
function legacyRoutes(db: ReturnType<typeof createDb>) {
  const router = express.Router(), svc = issueService(db), products = workProductService(db);
  const resources = resourceCatalogService(db), profiles = organizationIntelligenceProfileService(db);
  router.param("id", async (req, _res, next, rawId) => {
    try {
      if (/^[A-Z][A-Z0-9]*-\d+$/i.test(rawId)) { const row = await svc.getByIdentifier(rawId); if (row) { req.params.id = row.id; next(); return; } }
      const parsed = parseShortRef(rawId);
      if (parsed) {
        if (parsed.kind !== "issue") throw unprocessable("Issue ID must be a UUID, issue identifier, or typed iss_<prefix> reference");
        req.params.id = await resolveIssueReference(db, rawId, { orgIds: getAuthorizedOrgScope(req) });
      } else if (/^[a-z]{3}_/i.test(rawId)) throw unprocessable("Issue ID must be a UUID, issue identifier, or typed iss_<prefix> reference");
      next();
    } catch (error) { next(error); }
  });
  for (const operation of ["attachments", "work-products"] as const) router.get(`/issues/:id/${operation}`, async (req, res) => {
    const issue = await svc.getById(req.params.id as string);
    if (!issue) { res.status(404).json({ error: "Issue not found" }); return; }
    assertCompanyAccess(req, issue.orgId); await afterIdentity(issue.id);
    if (operation === "attachments") res.json((await svc.listAttachments(issue.id, issue.orgId)).map((row) => ({ ...row, contentPath: `/api/attachments/${row.id}/content` })));
    else res.json(await products.listForIssue(issue.id, issue.orgId));
  });
  router.get("/orgs/:orgId/issues/follows", async (req, res) => {
    const orgId = req.params.orgId as string; assertCompanyAccess(req, orgId);
    if (req.actor.type !== "board") { res.status(403).json({ error: "Board authentication required" }); return; }
    if (!req.actor.userId) { res.status(403).json({ error: "Board user context required" }); return; }
    res.json(await svc.listFollows(orgId, req.actor.userId));
  });
  router.get("/orgs/:orgId/resources", async (req, res) => { const orgId = req.params.orgId as string; assertCompanyAccess(req, orgId); if (req.actor.type !== "agent") assertBoard(req); res.json(await resources.listOrganizationResources(orgId)); });
  router.get("/orgs/:orgId/intelligence-profiles", async (req, res) => { const orgId = req.params.orgId as string; assertCompanyAccess(req, orgId); assertBoard(req); res.json(await profiles.list(orgId)); });
  return router;
}
async function freePort() { const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening"); const port = (socket.address() as net.AddressInfo).port; await new Promise<void>((resolve) => socket.close(() => resolve())); return port; }
const modes = process.env.RUDDER_METADATA_NODE_ORACLE_ONLY === "1"
  ? ["node"] as const
  : process.env.RUDDER_METADATA_TEST_DATABASE_URL
    ? ["required"] as const
    : ["off", "required"] as const;

describe.each(modes)("Issue metadata and organization catalog public contracts (%s)", (mode) => {
  let db: ReturnType<typeof createDb>, pg: LocalPostgresInstance, server: Server, oracleServer: Server, directory: string;
  let bridge: RustFoundationBridge | undefined, target: Server | string;
  const org = randomUUID(), other = randomUUID(), agent = randomUUID(), foreignAgent = randomUUID();
  const token = `metadata-${randomUUID()}`, foreignToken = `foreign-${randomUUID()}`, boardToken = `board-${randomUUID()}`, userId = randomUUID();
  const ownIssue = randomUUID(), foreignIssue = randomUUID(), hiddenIssue = randomUUID();
  const ownAttachment = randomUUID(), foreignLinkAttachment = randomUUID(), foreignAssetAttachment = randomUUID();
  const ownProduct = randomUUID(), foreignProduct = randomUUID();
  const ownFollow = randomUUID(), dirtyFollow = randomUUID();
  const nativeIdentity = nativeIdentityIngressFixture();
  const get = (path: string, credential = token, headers: Record<string, string> = {}) =>
    request(target)
      .get(`/api${path}`)
      .set("authorization", `Bearer ${credential}`)
      .set(headers);
  const observe = (name: string, value: unknown) => process.env.RUDDER_METADATA_OBSERVATIONS_PATH ? fs.appendFileSync(process.env.RUDDER_METADATA_OBSERVATIONS_PATH, JSON.stringify({ name, value }) + "\n") : undefined;
  const assetValue = (id: string, orgId: string) => ({ id, orgId, provider: "synthetic", objectKey: `kept/${id}`, contentType: "text/plain", byteSize: 17, sha256: "synthetic-sha" });

  beforeAll(async () => {
    // A caller may provide its freshly created local test database so repeated
    // author runs reuse one owned PostgreSQL cluster instead of initializing more.
    let url = process.env.RUDDER_METADATA_TEST_DATABASE_URL?.trim() ?? "";
    if (url) {
      const target = new URL(url);
      if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
        || !/^\/[a-zA-Z0-9_]+_test$/.test(target.pathname)) {
        throw new Error("Metadata tests require an explicitly managed local *_test database");
      }
    } else {
      directory = fs.realpathSync(fs.mkdtempSync("/tmp/rudder-metadata-catalog-read-postgres-"));
      const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
      const port = (socket.address() as net.AddressInfo).port; await new Promise<void>((resolve) => socket.close(() => resolve()));
      pg = (await createLocalPostgresInstance({ databaseDir: directory, user: "rudder", password: "rudder", port, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} })).instance;
      await pg.initialise(); fs.appendFileSync(`${directory}/postgresql.conf`, "\nunix_socket_directories = ''\nlisten_addresses = '127.0.0.1'\nshared_buffers = '16MB'\n"); await pg.start();
      url = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
      await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
    }
    await applyPendingMigrations(url); db = createDb(url);
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1)).replaceAll('"', '""');
    await db.execute(sql.raw(`ALTER DATABASE "${databaseName}" SET timezone TO '${process.env.RUDDER_METADATA_ORACLE_TIMEZONE === "Pacific/Honolulu" ? "Pacific/Honolulu" : "UTC"}'`)); await db.$client.end({ timeout: 5 }); db = createDb(url);
    await db.insert(organizations).values([{ id: org, name: "Release metadata", issuePrefix: "META", urlKey: "metadata" }, { id: other, name: "Foreign release", issuePrefix: "OTHER", urlKey: "other-metadata" }]);
    await db.insert(agents).values([{ id: agent, orgId: org, name: "Release reader", role: "general", status: "idle" }, { id: foreignAgent, orgId: other, name: "Foreign reader", role: "general", status: "idle" }]);
    await db.insert(agentApiKeys).values([{ orgId: org, agentId: agent, name: "Reader", keyHash: createHash("sha256").update(token).digest("hex") }, { orgId: other, agentId: foreignAgent, name: "Foreign", keyHash: createHash("sha256").update(foreignToken).digest("hex") }]);
    await db.insert(authUsers).values({ id: userId, name: "Metadata reader", email: "metadata@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(organizationMemberships).values({ orgId: org, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    await db.insert(boardApiKeys).values({ userId, name: "Metadata", keyHash: createHash("sha256").update(boardToken).digest("hex") });
    await db.insert(issues).values([{ id: ownIssue, orgId: org, title: "Publish release proof", identifier: "META-1", issueNumber: 1 }, { id: foreignIssue, orgId: other, title: "Foreign release proof" }, { id: hiddenIssue, orgId: org, title: "Hidden proof", hiddenAt: new Date() }]);
    const a = randomUUID(), b = randomUUID(), c = randomUUID();
    await db.insert(assets).values([assetValue(a, org), assetValue(b, org), assetValue(c, other)]);
    await db.insert(issueAttachments).values([
      { id: ownAttachment, orgId: org, issueId: ownIssue, assetId: a, createdAt: new Date("2026-01-01") },
      { id: foreignLinkAttachment, orgId: other, issueId: ownIssue, assetId: b, createdAt: new Date("2026-01-02") },
      { id: foreignAssetAttachment, orgId: org, issueId: ownIssue, assetId: c, createdAt: new Date("2026-01-03") },
    ]);
    await db.insert(issueWorkProducts).values([
      { id: ownProduct, orgId: org, issueId: ownIssue, type: "document", provider: "synthetic", title: "Own proof", status: "active", metadata: { keep: "full" }, updatedAt: new Date("2026-01-01") },
      { id: foreignProduct, orgId: other, issueId: ownIssue, type: "document", provider: "synthetic", title: "Foreign proof", status: "active", updatedAt: new Date("2026-01-02") },
    ]);
    await db.insert(issueFollows).values([
      { id: ownFollow, orgId: org, issueId: ownIssue, userId, createdAt: new Date("2026-01-01") },
      { id: dirtyFollow, orgId: org, issueId: foreignIssue, userId, createdAt: new Date("2026-01-02") },
      { orgId: org, issueId: hiddenIssue, userId }, { orgId: other, issueId: ownIssue, userId },
      { orgId: org, issueId: ownIssue, userId: "other-synthetic-user" },
    ]);
    await db.insert(organizationResources).values([{ orgId: org, name: "Release evidence", kind: "file", locator: "synthetic://proof", metadata: { password: "unredacted fixture", nested: [1, null] } }, { orgId: other, name: "Foreign resource", kind: "file", locator: "synthetic://foreign" }]);
    function app(oracle: boolean, selected = bridge) {
      const app = express(); if (!oracle && mode === "required") app.use(nativeIdentity.middleware()); app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
      app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
      app.use((req, _res, next) => { if (req.header("x-oracle-missing-user") === "1" && req.actor.type === "board") delete req.actor.userId; next(); });
      if (oracle) app.use("/api", legacyRoutes(db));
      else { app.use("/api", issueRoutes(db, {} as StorageService, selected)); app.use("/api/orgs", organizationRoutes(db, undefined, undefined, selected, { nativeResourceRoutes: mode === "required" })); }
      app.use(errorHandler); return app;
    }
    oracleServer = app(true).listen(0, "127.0.0.1"); await once(oracleServer, "listening");
    if (mode === "node") { target = oracleServer; return; }
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const binaryTarget = path.resolve(repoRoot, process.env.CARGO_TARGET_DIR ?? "native/target");
    const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
    const explicit = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const candidates = explicit ? [path.resolve(repoRoot, explicit)] : [path.join(binaryTarget, "debug", binaryName), path.join(binaryTarget, "release", binaryName)];
    const binary = candidates.find((file) => { try { fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } }) ?? candidates[0]!;
    fs.accessSync(binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    const listenPort = await freePort();
    bridge = createRustFoundationBridge({ databaseUrl: url, binaryPath: binary, mode: "off", projectGoalSetMode: "off", organizationBrandingMode: "off", requestTimeoutMs: 10000,
      ...(mode === "required" ? { publicIngress: { identityAuth: nativeIdentity.identityAuth, listenAddr: "127.0.0.1:0", nodeUpstream: `http://127.0.0.1:${listenPort}`, authorizationKey: "metadata-ingress-synthetic-key-32-bytes" } } : {}) });
    const original = bridge.issueMetadataRead!.bind(bridge);
    vi.spyOn(bridge, "issueMetadataRead").mockImplementation(async (actor, orgId, input) => { if (input.issueId) await afterIdentity(input.issueId); return original(actor, orgId, input); });
    server = app(false).listen(listenPort, "127.0.0.1"); await once(server, "listening"); await bridge.start(); target = server;
    if (mode === "required") { await bridge.waitForPublicIngressReady!(); target = bridge.publicIngressBaseUrl!; }
  });
  afterAll(async () => { for (const endpoint of [server, oracleServer]) if (endpoint) { endpoint.closeAllConnections(); await new Promise<void>((resolve) => endpoint.close(() => resolve())); } await bridge?.close(); await db?.$client.end({ timeout: 5 }); if (pg) await pg.stop(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
  async function pair(url: string, credential = token, headers: Record<string,string> = {}) {
    const expected = await request(oracleServer).get(`/api${url}`).set("authorization", `Bearer ${credential}`).set(headers);
    const actual = await request(target).get(`/api${url}`).set("authorization", `Bearer ${credential}`).set(headers);
    expect(actual.status).toBe(expected.status); expect(actual.body).toEqual(expected.body); return actual;
  }

  it("excludes foreign attachment links and assets while retaining same-org metadata", async () => {
    const result = await pair(`/issues/${ownIssue}/attachments`); observe("dirty attachments", result.body);
    expect(result.status).toBe(200); expect(result.body.map((x: { id: string }) => x.id)).toEqual([ownAttachment]);
    expect(result.body[0].contentPath).toBe(`/api/attachments/${ownAttachment}/content`);
  });
  it("excludes foreign work-product rows while retaining same-org aliases", async () => {
    const result = await pair(`/issues/${ownIssue}/work-products`); observe("dirty work products", result.body);
    expect(result.status).toBe(200); expect(result.body.map((x: { id: string }) => x.id)).toEqual([ownProduct]);
    expect(result.body[0].runWorkspaceId).toBeNull(); expect(result.body[0].executionWorkspaceId).toBeNull();
  });
  it("excludes foreign followed issues with hidden and user controls", async () => {
    const result = await pair(`/orgs/${org}/issues/follows`, boardToken); observe("dirty follows", result.body);
    expect(result.status).toBe(200); expect(result.body.map((x: { id: string }) => x.id)).toEqual([ownFollow]);
    expect(result.body[0].issue.title).toBe("Publish release proof");
  });
  it("pins Board Agent anonymous and actual missing-user context for all five routes", async () => {
    const routes = [`/issues/${ownIssue}/attachments`, `/issues/${ownIssue}/work-products`, `/orgs/${org}/issues/follows`, `/orgs/${org}/resources`, `/orgs/${org}/intelligence-profiles`];
    for (const [index, path] of routes.entries()) {
      const board = await pair(path, boardToken), agentResult = await pair(path), foreign = await pair(path, foreignToken), anon = await request(target).get(`/api${path}`);
      const missing = mode === "required"
        ? await get(path, boardToken, { "x-oracle-missing-user": "1" })
        : await pair(path, boardToken, { "x-oracle-missing-user": "1" });
      observe(`actors ${path}`, { board: [board.status, board.body], agent: [agentResult.status, agentResult.body], foreign: foreign.status, anonymous: anon.status, missingUser: [missing.status, missing.body] });
      expect([board.status, agentResult.status, foreign.status, anon.status, missing.status]).toEqual([
        200,
        index === 2 || index === 4 ? 403 : 200,
        403,
        401,
        mode === "required" ? 200 : index === 2 ? 403 : 200,
      ]);
      if (mode === "required") expect(missing.body).toEqual(board.body);
      else if (index === 2) expect(missing.body).toEqual({ error: "Board user context required" });
      for (const query of ["?limit=1&limit=2", "?status=%00&status=broken", "?userId=foreign", "?order=asc&order=desc"]) {
        const result = await pair(`${path}${query}`, boardToken); expect(result.status).toBe(200); expect(result.body).toEqual(board.body);
      }
    }
    await db.update(organizationMemberships).set({ status: "inactive" }).where(and(eq(organizationMemberships.orgId, org), eq(organizationMemberships.principalId, userId)));
    try { for (const path of routes) expect((await pair(path, boardToken)).status).toBe(403); }
    finally { await db.update(organizationMemberships).set({ status: "active" }).where(eq(organizationMemberships.principalId, userId)); }
  });
  it("pins identity references and post-identity move/delete behavior", async () => {
    for (const suffix of ["attachments", "work-products"]) {
      // Legacy Node lets the malformed UUID cast bubble up as a 500. The
      // native public route rejects it before SQL with the stable 404 contract.
      const references = [
        [randomUUID(), 404, 404],
        ["not-a-uuid", 500, 404],
        ["agt_abcd", 422, 422],
        ["META-1", 200, 200],
        [`iss_${ownIssue.replace(/-/g, "").slice(0, 8)}`, 200, 200],
      ] as const;
      for (const [id, legacyStatus, nativeStatus] of references) {
        const url = `/issues/${id}/${suffix}`;
        if (mode === "required" && id === "not-a-uuid") {
          const result = await get(url);
          observe(`identity ${id}/${suffix}`, { status: result.status, body: result.body, reason: "native route rejects malformed IDs before SQL casting" });
          expect(result.status).toBe(nativeStatus);
        } else {
          const result = await pair(url);
          observe(`identity ${id}/${suffix}`, { status: result.status, body: result.body });
          expect(result.status).toBe(mode === "required" ? nativeStatus : legacyStatus);
        }
      }
      if (mode !== "off") {
        // Required public ingress bypasses the private Node bridge, so verify
        // the native route against the rows' current organization/deletion state.
        const moved = randomUUID();
        await db.insert(issues).values({ id: moved, orgId: org, title: "Moved after identity" });
        expect((await pair(`/issues/${moved}/${suffix}`)).status).toBe(200);
        await db.update(issues).set({ orgId: other }).where(eq(issues.id, moved));
        const movedRead = await get(`/issues/${moved}/${suffix}`);
        observe(`after real move ${suffix}`, { status: movedRead.status, body: movedRead.body });
        expect(movedRead.status).toBe(403);
        expect((await pair(`/issues/${moved}/${suffix}`)).status).toBe(403);

        const deleted = randomUUID();
        await db.insert(issues).values({ id: deleted, orgId: org, title: "Deleted after identity" });
        expect((await pair(`/issues/${deleted}/${suffix}`)).status).toBe(200);
        await db.delete(issues).where(eq(issues.id, deleted));
        const gone = await get(`/issues/${deleted}/${suffix}`);
        observe(`after real delete ${suffix}`, { status: gone.status, body: gone.body });
        expect(gone.status).toBe(404);
        expect((await pair(`/issues/${deleted}/${suffix}`)).status).toBe(404);
      } else {
        // Off mode still exercises the existing Node identity-to-read boundary.
        const moved = randomUUID();
        await db.insert(issues).values({ id: moved, orgId: org, title: "Moved after identity" });
        interception.afterIdentity = async (id) => {
          if (id === moved) await db.update(issues).set({ orgId: other }).where(eq(issues.id, id));
        };
        const old = await get(`/issues/${moved}/${suffix}`);
        observe(`after identity move ${suffix}`, { status: old.status, body: old.body });
        expect(old.status).toBe(404);
        expect((await pair(`/issues/${moved}/${suffix}`)).status).toBe(403);
        const deleted = randomUUID();
        await db.insert(issues).values({ id: deleted, orgId: org, title: "Deleted after identity" });
        interception.afterIdentity = async (id) => {
          if (id === deleted) await db.delete(issues).where(eq(issues.id, id));
        };
        const gone = await get(`/issues/${deleted}/${suffix}`);
        observe(`after identity delete ${suffix}`, { status: gone.status, body: gone.body });
        expect(gone.status).toBe(404);
        expect((await pair(`/issues/${deleted}/${suffix}`)).status).toBe(404);
      }
    }
  });
  it("pins profile null canonical legacy ordering and read-only model normalization", async () => {
    const path = `/orgs/${org}/intelligence-profiles`;
    expect((await pair(path, boardToken)).body).toEqual([null]);
    const light = randomUUID(), reasoning = randomUUID(), canonical = randomUUID();
    await db.insert(organizationIntelligenceProfiles).values([
      { id: light, orgId: org, purpose: "lightweight", agentRuntimeType: "codex_local", agentRuntimeConfig: { model: "gpt-5.4-mini", reasoningEffort: " high ", preserve: { password: "not redacted" } }, status: "configured", updatedAt: new Date("2026-01-01") },
      { id: reasoning, orgId: org, purpose: "reasoning", agentRuntimeType: "other", agentRuntimeConfig: { model: "chosen" }, status: "disabled", updatedAt: new Date("2026-02-01") },
    ]);
    const before = await db.select().from(organizationIntelligenceProfiles).where(eq(organizationIntelligenceProfiles.orgId, org));
    const legacy = await pair(path, boardToken); observe("legacy profile", legacy.body);
    expect(legacy.body[0]).toMatchObject({ id: light, purpose: "default", status: "disabled", lastVerifiedAt: null, agentRuntimeConfig: { model: "gpt-6-luna", modelReasoningEffort: "high", preserve: { password: "not redacted" } } });
    expect(legacy.body[0].agentRuntimeConfig).not.toHaveProperty("reasoningEffort");
    expect(await db.select().from(organizationIntelligenceProfiles).where(eq(organizationIntelligenceProfiles.orgId, org))).toEqual(before);
    await db.insert(organizationIntelligenceProfiles).values({ id: canonical, orgId: org, purpose: "default", agentRuntimeType: "other", agentRuntimeConfig: { model: "chosen" }, status: "invalid" });
    expect((await pair(path, boardToken)).body[0].id).toBe(canonical);
    for (const raw of ['null', 'false', '[]', '"literal"', JSON.stringify('{"model":"gpt-5.5","reasoningEffort":" low ","$serde_json::private::RawValue":"keep"}'), '{"model":"custom","huge":9007199254740993}']) {
      await db.execute(sql`UPDATE organization_intelligence_profiles SET agent_runtime_type='codex_local',agent_runtime_config=${raw}::jsonb WHERE id=${canonical}::uuid`);
      const result = await pair(path, boardToken); observe("profile raw config", { raw, status: result.status, body: result.body }); expect(result.status).toBe(200);
    }
  });
  it("pins timestamp wire values while retaining raw SQL list ordering", async () => {
    const stamps = ["0032-01-01 00:00:00Z", "0001-01-01 00:00:00Z", "infinity", "-infinity", "275760-09-13 00:00:00.000001Z", "275760-09-13 00:00:00.001Z", "1969-12-31 23:59:59.999999Z"];
    for (const stamp of stamps) {
      await db.execute(sql`UPDATE issue_attachments SET created_at=${stamp}::timestamptz,updated_at=${stamp}::timestamptz WHERE id=${ownAttachment}::uuid`);
      await db.execute(sql`UPDATE issue_work_products SET created_at=${stamp}::timestamptz,updated_at=${stamp}::timestamptz WHERE id=${ownProduct}::uuid`);
      await db.execute(sql`UPDATE organization_resources SET created_at=${stamp}::timestamptz,updated_at=${stamp}::timestamptz WHERE org_id=${org}::uuid`);
      for (const [path,id] of [[`/issues/${ownIssue}/attachments`,ownAttachment],[`/issues/${ownIssue}/work-products`,ownProduct],[`/orgs/${org}/resources`,null]] as const) {
        const result = await pair(path); expect(result.status).toBe(200); const row = id ? result.body.find((v: {id:string})=>v.id===id) : result.body[0];
        observe("date projection", { stamp, path, createdAt: row.createdAt, updatedAt: row.updatedAt, ids: result.body.map((v:{id:string})=>v.id) });
      }
    }
  });
  it("pins profile parsed-date ranking including invalid-as-zero and reasoning ties", async () => {
    await db.delete(organizationIntelligenceProfiles).where(and(eq(organizationIntelligenceProfiles.orgId, org), eq(organizationIntelligenceProfiles.purpose, "default")));
    const cases = [
      ["2026-01-01 00:00:00Z", "0032-01-01 00:00:00Z", "reasoning"],
      ["infinity", "-infinity", "reasoning"],
      ["1969-12-31 23:59:59.999999Z", "infinity", "reasoning"],
      ["infinity", "1969-12-31 23:59:59.999999Z", "lightweight"],
    ];
    for (const [light, reasoning, winner] of cases) {
      await db.execute(sql`UPDATE organization_intelligence_profiles SET status='configured',agent_runtime_type='other',agent_runtime_config=jsonb_build_object('source',purpose),updated_at=CASE WHEN purpose='lightweight' THEN ${light}::timestamptz ELSE ${reasoning}::timestamptz END WHERE org_id=${org}::uuid`);
      const result = await pair(`/orgs/${org}/intelligence-profiles`, boardToken);
      observe("profile parsed rank", { light, reasoning, winner, status: result.status, body: result.body });
      expect(result.status).toBe(200); expect(result.body[0].agentRuntimeConfig.source).toBe(light === "2026-01-01 00:00:00Z" && process.env.RUDDER_METADATA_ORACLE_TIMEZONE === "Pacific/Honolulu" ? "lightweight" : winner);
    }
  });
  it("pins unredacted JSONB metadata reparsing numbers sentinels and deep payloads", async () => {
    const deep = '{"nested":'.repeat(600) + '{"password":"preserve","big":9007199254740993}' + '}'.repeat(600);
    for (const raw of ['null', 'false', '[]', '"literal"', '{"$serde_json::private::Number":"123","$serde_json::private::RawValue":"keep","big":9007199254740993,"overflow":1e400}', JSON.stringify('{"surrogate":"\\ud800","__proto__":{"keep":true}}'), deep, JSON.stringify(deep)]) {
      await db.execute(sql`UPDATE issue_work_products SET metadata=${raw}::jsonb WHERE id=${ownProduct}::uuid`);
      await db.execute(sql`UPDATE organization_resources SET metadata=${raw}::jsonb WHERE org_id=${org}::uuid`);
      for (const [path, id] of [[`/issues/${ownIssue}/work-products`, ownProduct], [`/orgs/${org}/resources`, null]] as const) {
        const result = await pair(path), row = id ? result.body.find((v: {id:string}) => v.id === id) : result.body[0];
        observe("opaque JSON metadata", { raw, path, status: result.status, metadata: row?.metadata }); expect(result.status).toBe(200);
      }
    }
  });
  it("preserves canonical scalar configs and legacy object spread without generic coercion", async () => {
    const deep = '{"nested":'.repeat(600) + '{"large":9007199254740993}' + '}'.repeat(600);
    for (const purpose of ["default", "reasoning"] as const) for (const runtime of ["other", "codex_local"] as const) {
      await db.delete(organizationIntelligenceProfiles).where(eq(organizationIntelligenceProfiles.orgId, org));
      const id = randomUUID(); await db.insert(organizationIntelligenceProfiles).values({ id, orgId: org, purpose, agentRuntimeType: runtime });
      for (const raw of ['null','false','1e400','[1,{"keep":true}]','"literal"', JSON.stringify('"\\ud800"'), JSON.stringify('{"model":"custom","__proto__":{"keep":true},"$serde_json::private::RawValue":"keep"}'), '{"model":"gpt-5.5","modelReasoningEffort":"\\ufeffhigh\\ufeff"}', '{"model":"gpt-5.5","modelReasoningEffort":"\\u0085"}', deep, JSON.stringify(deep)]) {
        await db.execute(sql`UPDATE organization_intelligence_profiles SET agent_runtime_config=${raw}::jsonb WHERE id=${id}::uuid`);
        const before = await db.execute(sql`SELECT agent_runtime_config::text AS value FROM organization_intelligence_profiles WHERE id=${id}::uuid`);
        const response = await pair(`/orgs/${org}/intelligence-profiles`, boardToken); expect(response.status).toBe(200);
        if (runtime === "other" && raw === 'false') expect(response.body[0].agentRuntimeConfig).toEqual(purpose === "default" ? false : {});
        if (runtime === "other" && raw === '1e400') expect(response.body[0].agentRuntimeConfig).toEqual(purpose === "default" ? null : {});
        expect(await db.execute(sql`SELECT agent_runtime_config::text AS value FROM organization_intelligence_profiles WHERE id=${id}::uuid`)).toEqual(before);
      }
    }
  });
  it("preserves SQL tie ordering and both nonnull workspace aliases", async () => {
    const project = randomUUID(), workspace = randomUUID();
    await db.execute(sql`INSERT INTO projects(id,org_id,name) VALUES (${project}::uuid,${org}::uuid,'Release fixture')`);
    await db.execute(sql`INSERT INTO execution_workspaces(id,org_id,project_id,mode,strategy_type,name) VALUES (${workspace}::uuid,${org}::uuid,${project}::uuid,'synthetic','synthetic','Proof workspace')`);
    for (let index = 0; index < 2; index++) {
      const asset = randomUUID(), issue = randomUUID();
      await db.insert(assets).values(assetValue(asset, org));
      await db.insert(issueAttachments).values({ orgId: org, issueId: ownIssue, assetId: asset, createdAt: new Date("2026-03-01") });
      await db.insert(issueWorkProducts).values({ orgId: org, issueId: ownIssue, projectId: project, executionWorkspaceId: workspace, type: "document", provider: "synthetic", title: `Tie ${index}`, status: "active", isPrimary: true, updatedAt: new Date("2026-03-01") });
      await db.insert(issues).values({ id: issue, orgId: org, title: `Follow tie ${index}` });
      await db.insert(issueFollows).values({ orgId: org, issueId: issue, userId, createdAt: new Date("2026-03-01") });
    }
    await pair(`/issues/${ownIssue}/attachments`);
    const products = await pair(`/issues/${ownIssue}/work-products`);
    for (const product of products.body.filter((row: {isPrimary:boolean}) => row.isPrimary)) {
      expect(product.runWorkspaceId).toBe(workspace); expect(product.executionWorkspaceId).toBe(workspace);
    }
    await pair(`/orgs/${org}/issues/follows`, boardToken);
  });
  it.runIf(mode !== "node")("preserves signed Board context and rejects private non-Board profile/follow reads", async () => {
    const board = { type: "board", source: "local_implicit", isInstanceAdmin: true } as const;
    const agentActor = { type: "agent", source: "agent_key", agentId: agent, orgId: org } as const;
    const missing = await bridge!.issueMetadataRead!(board, org, { operation: "follows", boardUserContext: false });
    expect(missing.status).toBe(403); expect(JSON.parse(missing.body.toString())).toEqual({ error: "Board user context required" });
    expect((await bridge!.issueMetadataRead!(agentActor, org, { operation: "follows", boardUserContext: true })).status).toBe(403);
    expect((await bridge!.organizationCatalogRead!(agentActor, org, { operation: "intelligence-profiles" })).status).toBe(403);
    expect((await bridge!.organizationCatalogRead!(board, org, { operation: "intelligence-profiles" })).status).toBe(200);
    expect((await bridge!.issueMetadataRead!(board, org, { operation: "attachments", issueId: ownIssue, boardUserContext: true })).status).toBe(422);
  });
  it("returns complete large payloads and leaves catalog/domain data unchanged", async () => {
    await db.update(organizationResources).set({ metadata: { full: "x".repeat(300000) } }).where(eq(organizationResources.orgId, org));
    const snapshot = async () => { const values: unknown[] = []; for (const table of ["issues","issue_attachments","assets","issue_work_products","issue_follows","organization_resources","organization_intelligence_profiles","instance_settings","activity_log"]) values.push(await db.execute(sql.raw(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text value FROM ${table} t`))); return values; };
    const before = await snapshot();
    expect((await pair(`/orgs/${org}/resources`)).text.length).toBeGreaterThan(300000);
    for (const url of [`/issues/${ownIssue}/attachments`,`/issues/${ownIssue}/work-products`,`/orgs/${org}/issues/follows`,`/orgs/${org}/intelligence-profiles`]) await pair(url, boardToken);
    expect(await snapshot()).toEqual(before);
  });
  it.runIf(mode !== "node")("preserves native catalog reads when the private bridge is unavailable", async () => {
    const port = await freePort();
    const unavailable = {
      issueMetadataRead: (actor, orgId, input) => requestIssueMetadataRead(`http://127.0.0.1:${port}`, "synthetic-unavailable-key", 1000, actor, orgId, input),
      organizationCatalogRead: (actor, orgId, input) => requestOrganizationCatalogRead(`http://127.0.0.1:${port}`, "synthetic-unavailable-key", 1000, actor, orgId, input),
    } as RustFoundationBridge;
    const upstreamPort = (server.address() as net.AddressInfo).port;
    for (const selected of [undefined, unavailable]) {
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const app = express(); if (mode === "required") app.use(nativeIdentity.middleware()); app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
      app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
      app.use("/api", issueRoutes(db, {} as StorageService, selected)); app.use("/api/orgs", organizationRoutes(db, undefined, undefined, selected, { nativeResourceRoutes: mode === "required" })); app.use(errorHandler);
      server = app.listen(upstreamPort, "127.0.0.1"); await once(server, "listening");
      const outageTarget = mode === "required" ? target : server;
      for (const url of [`/issues/${ownIssue}/attachments`,`/issues/${ownIssue}/work-products`,`/orgs/${org}/issues/follows`]) {
        const actual = await request(outageTarget).get(`/api${url}`).set("authorization", `Bearer ${boardToken}`);
        expect(actual.status).toBe(mode === "required" ? 200 : 503);
        if (mode === "required") {
          const oracle = await request(oracleServer).get(`/api${url}`).set("authorization", `Bearer ${boardToken}`);
          expect(actual.body).toEqual(oracle.body);
        }
      }
      for (const url of [`/orgs/${org}/resources`,`/orgs/${org}/intelligence-profiles`])
        expect((await request(outageTarget).get(`/api${url}`).set("authorization", `Bearer ${boardToken}`)).status).toBe(mode === "required" ? 200 : 503);
    }
  });
});
