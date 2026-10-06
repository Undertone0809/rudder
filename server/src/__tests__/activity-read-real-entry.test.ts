import {
  activityLog, agentApiKeys, agents, applyPendingMigrations, authUsers, boardApiKeys,
  chatContextLinks, chatConversations, createDb, ensurePostgresDatabase, heartbeatRuns,
  issues, organizationMemberships, organizations,
} from "@rudderhq/db";
import { shortRefFor } from "@rudderhq/shared";
import { eq, sql } from "drizzle-orm";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

// Required entry: node scripts/test-activity-read-real-entry.mjs, after building
// the exact candidate and setting RUDDER_SERVER_FOUNDATION_PATH. Server imports
// remain dynamic so the isolation guard runs before config/logger side effects.
const qaRoot = process.env.RUDDER_ACTIVITY_READ_QA_ROOT;
if (qaRoot && (process.env.RUDDER_HOME !== qaRoot || process.env.DATABASE_URL
  || process.env.RUDDER_LOCAL_ENV !== "e2e"
  || process.env.RUDDER_CONFIG !== path.join(qaRoot, "config.json")
  || process.env.RUDDER_LOG_DIR !== path.join(qaRoot, "logs")
  || process.env.RUN_LOG_BASE_PATH !== path.join(qaRoot, "run-logs"))) {
  throw new Error("Use scripts/test-activity-read-real-entry.mjs to establish isolation before server imports");
}

function wire<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
async function port() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
async function close(server?: Server) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

describe.runIf(Boolean(qaRoot)).each([false, true])("Activity read public HTTP/Rust/PostgreSQL parity (Actix ingress %s)", (ingress) => {
  let db: ReturnType<typeof createDb> | undefined;
  let postgres: { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> } | undefined;
  let server: Server | undefined;
  let bridge: RustFoundationBridge | undefined;
  let target: string | Server;
  let connectionString = "";
  let nodeListenPort = 0;
  let dataDir = "";
  let expectedSnapshot: unknown;
  let expectedFiles: string[];
  let oracle: ReturnType<typeof import("../services/activity.js")["activityService"]>;
  let startApp: (selectedBridge?: RustFoundationBridge, listenPort?: number) => Promise<Server>;
  const orgId = randomUUID(), foreignOrgId = randomUUID(), emptyOrgId = randomUUID();
  const agentId = randomUUID(), foreignAgentId = randomUUID();
  const issueId = randomUUID(), contextIssueId = randomUUID(), hiddenIssueId = randomUUID(), foreignIssueId = randomUUID();
  const runId = randomUUID(), newRunId = randomUUID(), foreignRunId = randomUUID();
  const conversationId = randomUUID(), foreignConversationId = randomUUID();
  const agentToken = `activity-agent-${randomUUID()}`, boardToken = `activity-board-${randomUUID()}`;
  const userId = `activity-user-${randomUUID()}`;
  const early = new Date("2024-02-29T12:34:56.123+08:00");
  const events: string[] = [];

  function get(url: string, token = agentToken, selectedTarget = target) {
    return request(selectedTarget).get(url).set("authorization", `Bearer ${token}`);
  }
  function fileSnapshot() {
    // Logs and the database are allowed fixture infrastructure; workspaces and
    // storage must not be provisioned or changed by any read API.
    return ["workspaces", "storage"].flatMap((name) => {
      const directory = path.join(qaRoot!, name);
      return fs.existsSync(directory) ? fs.readdirSync(directory, { recursive: true }).map((item) => `${name}/${item}`) : [];
    }).sort();
  }
  async function snapshot() {
    const result: Record<string, unknown> = {};
    for (const table of ["activity_log", "heartbeat_runs", "issues", "chat_conversations", "chat_context_links", "organization_mutation_state", "organization_mutation_receipts", "organization_mutation_outbox"]) {
      result[table] = (await db!.execute(sql.raw(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb)::text AS value FROM ${table} t`)))[0]?.value;
    }
    return result;
  }
  async function readOnly() {
    expect(await snapshot()).toEqual(expectedSnapshot);
    expect(fileSnapshot()).toEqual(expectedFiles);
  }

  beforeAll(async () => {
    const [{ actorMiddleware }, { errorHandler }, { activityRoutes }, { activityService }, { createRustFoundationBridge }] = await Promise.all([
      import("../middleware/auth.js"), import("../middleware/error-handler.js"), import("../routes/activity.js"),
      import("../services/activity.js"), import("../services/rust-foundation-bridge.js"),
    ]);
    const databasePort = await port();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-activity-read-db-"));
    type EmbeddedPostgresCtor = new (options: {
      databaseDir: string; user: string; password: string; port: number; persistent: boolean;
      initdbFlags: string[]; onLog: () => void; onError: () => void;
    }) => NonNullable<typeof postgres>;
    const EmbeddedPostgres = (await import("embedded-postgres")).default as EmbeddedPostgresCtor;
    postgres = new EmbeddedPostgres({ databaseDir: dataDir, user: "rudder", password: "rudder", port: databasePort, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
    await postgres.initialise();
    await postgres.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${databasePort}/postgres`, "rudder");
    connectionString = `postgres://rudder:rudder@127.0.0.1:${databasePort}/rudder`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    await db.execute(sql`ALTER DATABASE rudder SET timezone TO 'Pacific/Honolulu'`);
    await db.$client.end({ timeout: 5 });
    db = createDb(connectionString);
    await db.insert(organizations).values([
      { id: orgId, name: "Activity parity", urlKey: "activity-parity", issuePrefix: "ACT" },
      { id: foreignOrgId, name: "Foreign activity", urlKey: "foreign-activity", issuePrefix: "FRA" },
      { id: emptyOrgId, name: "Empty activity", urlKey: "empty-activity", issuePrefix: "EMA" },
    ]);
    await db.insert(agents).values([{ id: agentId, orgId, name: "Reader", role: "general", status: "idle" }, { id: foreignAgentId, orgId: foreignOrgId, name: "Foreign", role: "general", status: "idle" }]);
    await db.insert(agentApiKeys).values({ orgId, agentId, name: "Fixture", keyHash: createHash("sha256").update(agentToken).digest("hex") });
    await db.insert(authUsers).values({ id: userId, name: "Fixture operator", email: `${userId}@example.test`, createdAt: early, updatedAt: early });
    await db.insert(organizationMemberships).values([orgId, emptyOrgId].map((orgId) => ({ orgId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" })));
    await db.insert(boardApiKeys).values({ userId, name: "Fixture", keyHash: createHash("sha256").update(boardToken).digest("hex") });
    await db.insert(issues).values([
      { id: issueId, orgId, title: "Legacy issue ☃", identifier: "ACT-1", issueNumber: 1 },
      { id: contextIssueId, orgId, title: "Context issue", identifier: "ACT-2", issueNumber: 2 },
      { id: hiddenIssueId, orgId, title: "HIDDEN", identifier: "ACT-3", issueNumber: 3, hiddenAt: early },
      { id: foreignIssueId, orgId: foreignOrgId, title: "FOREIGN_ISSUE_MUST_NOT_LEAK", identifier: "FRA-1", issueNumber: 1 },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: runId, orgId, agentId, status: "succeeded", createdAt: early, startedAt: early, finishedAt: early,
        contextSnapshot: { issueId: contextIssueId, resumeSessionParams: { secret: "PRIVATE_SESSION" }, passiveFollowup: { attempt: 2, maxAttempts: 5, secret: "PRIVATE_FOLLOWUP" } },
        usageJson: { provider: "usage-provider", model: "😀".repeat(251), billingType: "a".repeat(120) },
        resultJson: { body: "x".repeat(510), stdout: "y".repeat(33000), provider: "fallback", costUsd: 0.01 } },
      { id: newRunId, orgId, agentId, status: "running", createdAt: new Date("2026-10-06T01:00:00Z"), contextSnapshot: { issueId },
        usageJson: { provider: "usage-provider" }, resultSummaryJson: { provider: "summary-provider", summary: "current row" } },
      { id: foreignRunId, orgId: foreignOrgId, agentId: foreignAgentId, status: "running", contextSnapshot: { issueId } },
    ]);
    await db.insert(chatConversations).values([{ id: conversationId, orgId, title: "Related chat" }, { id: foreignConversationId, orgId: foreignOrgId, title: "FOREIGN_CHAT_MUST_NOT_LEAK" }]);
    await db.insert(chatContextLinks).values({ orgId, conversationId, entityType: "issue", entityId: issueId });
    const rows = Array.from({ length: 145 }, (_, i) => {
      const id = randomUUID(); events.push(id);
      return { id, orgId, actorType: i % 3 === 0 ? "agent" : "user", actorId: i % 3 === 0 ? agentId : userId,
        agentId: i % 5 === 0 ? agentId : null, action: "issue.updated", entityType: "issue", entityId: issueId,
        runId: i === 0 ? runId : null, createdAt: early, details: { status: i % 2 ? "done" : "todo", title: "Historical title", nested: { snake_key: [null, false, "1e400"] } } };
    });
    await db.insert(activityLog).values(rows);
    for (let i = 0; i < events.length; i++) {
      await db.execute(sql`UPDATE activity_log SET created_at = '2024-02-29T04:34:56.123000Z'::timestamptz + ${i} * interval '1 microsecond' WHERE id=${events[i]}::uuid`);
    }
    await db.insert(activityLog).values([
      ...["issue.read_marked", "issue.execution_released", "issue.document_updated"].map((action) => ({ orgId, actorId: userId, action, entityType: "issue", entityId: issueId, createdAt: early })),
      { orgId, actorId: userId, action: "issue.updated", entityType: "issue", entityId: issueId, details: { title: "Low signal" }, createdAt: early },
      { orgId, actorId: userId, action: "issue.updated", entityType: "project", entityId: "project", details: { title: "Post-limit hidden", runWorkspaceId: "internal" }, createdAt: early },
      { orgId, actorId: userId, action: "issue.created", entityType: "issue", entityId: hiddenIssueId, runId, createdAt: early },
      { orgId: foreignOrgId, actorId: userId, action: "issue.created", entityType: "issue", entityId: foreignIssueId, createdAt: early },
      ...["chat.created", "chat.context_linked", "chat.issue_converted"].map((action) => ({ orgId, actorId: userId, action, entityType: "chat", entityId: conversationId, details: { issueId, entityType: "issue", entityId: issueId, contextLinkCount: 1 }, createdAt: early })),
    ]);
    const deep = `${"[".repeat(600)}9007199254740993${"]".repeat(600)}`;
    const historicalJson = `{"status":"done","deep":${deep},"overflow":1e400,"underflow":1e-400,"decimal":1.0790143258645723e-180,"large":"${"a".repeat(4_200_000)}"}`;
    await db.execute(sql`UPDATE activity_log SET details=${historicalJson}::jsonb WHERE id=${events[0]}::uuid`);
    oracle = activityService(db);
    startApp = async (selectedBridge, listenPort = 0) => {
      const app = express();
      app.use(express.json());
      app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
      app.use(actorMiddleware(db!, { deploymentMode: "authenticated", authRequirement: "required" }));
      app.use("/api", activityRoutes(db!, selectedBridge));
      app.use(errorHandler);
      const server = app.listen(listenPort, "127.0.0.1");
      await once(server, "listening");
      return server;
    };
    nodeListenPort = ingress ? await port() : 0;
    bridge = createRustFoundationBridge({ databaseUrl: connectionString, binaryPath: process.env.RUDDER_SERVER_FOUNDATION_PATH,
      actorEnvelopeKey: "activity-read-test-actor-key", mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", requestTimeoutMs: 15_000,
      ...(ingress ? { publicIngress: { listenAddr: "127.0.0.1:0", nodeUpstream: `http://127.0.0.1:${nodeListenPort}`, authorizationKey: "activity-read-ingress-fixture-key-32-bytes-minimum" } } : {}),
    });
    server = await startApp(bridge, nodeListenPort);
    await bridge.start();
    if (ingress) await bridge.waitForPublicIngressReady!();
    target = ingress ? bridge.publicIngressBaseUrl! : server;
    expectedSnapshot = await snapshot(); expectedFiles = fileSnapshot();
  }, 90_000);

  afterAll(async () => {
    try { await close(server); await bridge?.close(); await db?.$client.end({ timeout: 5 }); await postgres?.stop(); }
    finally { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); }
  });

  it("matches the full legacy list and every filter, without generic receipt truncation", async () => {
    for (const filters of [{}, { agentId }, { userId }, { actorType: "user" as const }, { actorId: userId }, { entityType: "issue", entityId: issueId }]) {
      const result = await get(`/api/orgs/${orgId}/activity`).query(filters);
      expect(result.status, result.text.slice(0, 300)).toBe(200);
      expect(result.body).toEqual(wire(await oracle.list({ orgId, ...filters })));
    }
    expect((await get(`/api/orgs/${emptyOrgId}/activity`, boardToken)).body).toEqual([]);
    await readOnly();
  }, 45_000);

  it("preserves microsecond cursors and post-limit filtering across the complete dataset", async () => {
    let cursor: string | undefined;
    let count = 0;
    do {
      const result = await get(`/api/orgs/${orgId}/activity`).query({ limit: 17, ...(cursor ? { cursor } : {}) });
      const expected = wire(await oracle.listPage({ orgId, limit: 17, cursor }));
      expect(result.status).toBe(200); expect(result.body).toEqual(expected);
      count += result.body.items.length;
      cursor = result.body.nextCursor ?? undefined;
    } while (cursor);
    expect(count).toBe((await oracle.list({ orgId })).length);
    for (const query of [{ limit: 101 }, { cursor: "garbage" }, { cursor: Buffer.from(JSON.stringify({ id: issueId, createdAt: "2024-02-29T04:34:56.123Z" })).toString("base64url") }]) {
      expect((await get(`/api/orgs/${orgId}/activity`).query(query)).status).toBe(400);
    }
    await readOnly();
  }, 45_000);

  it("matches issue activity/runs and both run aliases with hidden issues and private context excluded", async () => {
    expect((await get(`/api/issues/ACT-1/activity`)).body).toEqual(wire(await oracle.forIssue(issueId)));
    const runs = await get(`/api/issues/${issueId}/runs`);
    expect(runs.status).toBe(200); expect(runs.body).toEqual(wire(await oracle.runsForIssue(orgId, issueId)));
    expect(JSON.stringify(runs.body)).not.toMatch(/PRIVATE_SESSION|PRIVATE_FOLLOWUP|resultFallbackJson/);
    for (const kind of ["agent-runs", "heartbeat-runs"]) {
      for (const ref of [runId, shortRefFor("run", runId), runId.replaceAll("-", "").slice(0, 12)]) {
        const result = await get(`/api/${kind}/${ref}/issues`);
        expect(result.status).toBe(200); expect(result.body).toEqual(wire(await oracle.issuesForRun(runId)));
        expect(result.body[0].issueId).toBe(contextIssueId);
        expect(JSON.stringify(result.body)).not.toContain("HIDDEN");
      }
    }
    await readOnly();
  }, 30_000);

  it("rejects missing/foreign actors and fabricated private envelopes", async () => {
    for (const url of [`/api/orgs/${orgId}/activity`, `/api/issues/${issueId}/activity`, `/api/issues/${issueId}/runs`, `/api/agent-runs/${runId}/issues`, `/api/heartbeat-runs/${runId}/issues`]) {
      expect((await request(target).get(url)).status).toBe(401);
      expect((await request(target).get(url).set("x-rudder-actor-envelope", '{"actor":{"type":"board"}}')).status).toBe(401);
    }
    for (const url of [`/api/orgs/${foreignOrgId}/activity`, `/api/issues/${foreignIssueId}/activity`, `/api/issues/${foreignIssueId}/runs`, `/api/agent-runs/${foreignRunId}/issues`]) {
      expect((await get(url)).status).toBe(403); expect((await get(url, boardToken)).status).toBe(403);
    }
    for (const kind of ["agent-runs", "heartbeat-runs"]) expect((await get(`/api/${kind}/${randomUUID()}/issues`)).status).toBe(404);
    expect((await request(target).post(`/internal/orgs/${orgId}/activity-reads`).send({ operation: "organization", filters: {} })).status).toBe(404);
    await readOnly();
  });

  it("filters malformed cross-org chat associations without repairing them", async () => {
    const id = randomUUID();
    await db!.insert(activityLog).values({ id, orgId, actorId: userId, action: "chat.issue_converted", entityType: "chat", entityId: foreignConversationId, details: { issueId } });
    const before = await snapshot();
    try {
      const result = await get(`/api/issues/${issueId}/activity`);
      expect(result.status).toBe(200);
      expect(result.body.some((event: { id: string }) => event.id === id)).toBe(false);
      expect(JSON.stringify(result.body)).not.toContain("FOREIGN_CHAT_MUST_NOT_LEAK");
      expect(await snapshot()).toEqual(before);
    } finally { await db!.delete(activityLog).where(eq(activityLog.id, id)); }
    await readOnly();
  });

  it("includes a newly created activity through the unchanged Node POST then Rust GET", async () => {
    const created = await request(target).post(`/api/orgs/${orgId}/activity`).set("authorization", `Bearer ${boardToken}`)
      .send({ actorId: userId, action: "fixture.created", entityType: "project", entityId: "current-row", details: { title: "New row" } });
    expect(created.status).toBe(201);
    try {
      const result = await get(`/api/orgs/${orgId}/activity`).query({ entityType: "project", entityId: "current-row" });
      expect(result.status).toBe(200); expect(result.body).toEqual([created.body]);
    } finally { await db!.delete(activityLog).where(eq(activityLog.id, created.body.id)); }
    await readOnly();
  });

  it("fails closed for all five GETs when the foundation cannot start", async () => {
    const { createRustFoundationBridge } = await import("../services/rust-foundation-bridge.js");
    const unavailable = createRustFoundationBridge({ databaseUrl: connectionString, binaryPath: path.join(qaRoot!, "missing-binary"), mode: "off" });
    if (ingress) { await close(server); server = undefined; }
    const broken = await startApp(unavailable, nodeListenPort);
    try {
      for (const url of [`/api/orgs/${orgId}/activity`, `/api/issues/${issueId}/activity`, `/api/issues/${issueId}/runs`, `/api/agent-runs/${runId}/issues`, `/api/heartbeat-runs/${runId}/issues`]) {
        const result = await get(url, agentToken, ingress ? target : broken);
        expect(result.status).toBe(503); expect(result.body.code).toBe("rust_foundation_activity_read_request_failed");
      }
      await readOnly();
    } finally {
      await close(broken); await unavailable.close();
      if (ingress) { server = await startApp(bridge, nodeListenPort); await bridge!.waitForPublicIngressReady!(); }
    }
  });

  if (!ingress) it("boots the normal API app and serves all five GETs with all pilots off", async () => {
    // The two ingress matrices above mount activityRoutes directly. This
    // separate observation exercises production bridge injection and startup.
    const pilotNames = ["RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS", "RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS"];
    const previousPilots = Object.fromEntries(pilotNames.map((name) => [name, process.env[name]]));
    for (const name of pilotNames) delete process.env[name];
    let handle: import("../app.js").RudderAppHandle | undefined;
    let bootstrapServer: Server | undefined;
    const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    async function databaseSnapshot() {
      const result: Record<string, string> = {};
      const tables = await db!.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
      for (const { tablename } of tables) {
        // Authentication updates key-use timestamps; domain reads must not
        // change any other data, including mutation ownership/outbox tables.
        const row = ["agent_api_keys", "board_api_keys"].includes(tablename) ? "to_jsonb(t) - 'last_used_at'" : "to_jsonb(t)";
        const rows = await db!.execute<{ value: string }>(sql.raw(`SELECT coalesce(jsonb_agg(${row} ORDER BY (${row})::text), '[]'::jsonb)::text AS value FROM "${tablename.replaceAll('"', '""')}" t`));
        result[tablename] = sha256(rows[0]!.value);
      }
      return result;
    }
    try {
      const { createRudderApp } = await import("../app.js");
      const { createStorageService } = await import("../storage/service.js");
      const { createLocalDiskStorageProvider } = await import("../storage/local-disk-provider.js");
      await close(server); server = undefined;
      await bridge!.close();
      const beforeStartup = await databaseSnapshot();
      const listenPort = await port();
      handle = await createRudderApp(db!, {
        uiMode: "none", serverPort: listenPort,
        storageService: createStorageService(createLocalDiskStorageProvider(path.join(qaRoot!, "storage"))),
        deploymentMode: "authenticated", deploymentExposure: "private", authRequirement: "required",
        localRuntimeTrust: "untrusted", allowedHostnames: ["127.0.0.1", "localhost"], bindHost: "127.0.0.1",
        authReady: true, companyDeletionEnabled: false, databaseUrl: connectionString,
        rustFoundationBinaryPath: process.env.RUDDER_SERVER_FOUNDATION_PATH, rustFoundationMode: "off",
        rustOrganizationBrandingMode: "off", rustProjectGoalSetMode: "off",
        instanceId: "activity-read-normal-bootstrap-test", localEnv: "e2e", mcpHostEnv: {},
        mcpDeploymentAllowlists: { httpOrigins: [], stdioCommands: [], stdioWorkingDirectories: [], stdioEnvironmentNames: [] },
      });
      bootstrapServer = handle.app.listen(listenPort, "127.0.0.1");
      await once(bootstrapServer, "listening");
      // Startup can synchronize plugin projections. Freeze that state before
      // proving the read boundary, and disclose any startup-only table changes.
      const afterStartup = await databaseSnapshot();
      const filesAfterStartup = fileSnapshot();
      const cases = [
        { url: `/api/orgs/${orgId}/activity`, foreign: `/api/orgs/${foreignOrgId}/activity`, expected: wire(await oracle.list({ orgId })) },
        { url: `/api/issues/${issueId}/activity`, foreign: `/api/issues/${foreignIssueId}/activity`, expected: wire(await oracle.forIssue(issueId)) },
        { url: `/api/issues/${issueId}/runs`, foreign: `/api/issues/${foreignIssueId}/runs`, expected: wire(await oracle.runsForIssue(orgId, issueId)) },
        { url: `/api/agent-runs/${runId}/issues`, foreign: `/api/agent-runs/${foreignRunId}/issues`, expected: wire(await oracle.issuesForRun(runId)) },
        { url: `/api/heartbeat-runs/${runId}/issues`, foreign: `/api/heartbeat-runs/${foreignRunId}/issues`, expected: wire(await oracle.issuesForRun(runId)) },
      ];
      const requests: Array<{ path: string; actor: string; status: number; sha256: string }> = [];
      for (const { url, foreign, expected } of cases) {
        for (const token of [agentToken, boardToken]) {
          const response = await get(url, token, bootstrapServer);
          expect(response.status, response.text.slice(0, 300)).toBe(200);
          expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(response.body).toEqual(expected);
          expect(response.text).not.toMatch(/FOREIGN_\w+_MUST_NOT_LEAK|PRIVATE_SESSION|PRIVATE_FOLLOWUP/);
          requests.push({ path: url, actor: token === agentToken ? "agent" : "board", status: response.status, sha256: sha256(response.text) });
          expect((await get(foreign, token, bootstrapServer)).status).toBe(403);
        }
        expect((await request(bootstrapServer).get(url)).status).toBe(401);
        expect((await request(bootstrapServer).get(url).set("x-rudder-actor-envelope", '{"actor":{"type":"board"}}')).status).toBe(401);
      }
      expect(await databaseSnapshot()).toEqual(afterStartup);
      expect(fileSnapshot()).toEqual(filesAfterStartup);
      console.info("ACTIVITY_NORMAL_BOOTSTRAP_RECEIPT", JSON.stringify({
        binaryPath: process.env.RUDDER_SERVER_FOUNDATION_PATH,
        binarySha256: sha256(fs.readFileSync(process.env.RUDDER_SERVER_FOUNDATION_PATH!)),
        entry: "createRudderApp -> createHttpApp -> registerApiRoutes -> activityRoutes",
        databaseKind: "disposable-migrated-embedded-postgres", allPilotModes: "off", readOnly: true,
        renderedUiObserved: false, electronObserved: false,
        startupChangedTables: Object.keys(afterStartup).filter((name) => afterStartup[name] !== beforeStartup[name]),
        domainFingerprint: sha256(JSON.stringify(afterStartup)), requests,
      }));
    } finally {
      try { await close(bootstrapServer); await handle?.close(); }
      finally {
        for (const [name, value] of Object.entries(previousPilots)) {
          if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
      }
    }
  }, 45_000);
});
