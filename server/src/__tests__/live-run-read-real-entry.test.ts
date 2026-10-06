import {
  agentApiKeys,
  agents,
  applyPendingMigrations,
  authUsers,
  boardApiKeys,
  createDb,
  ensurePostgresDatabase,
  goals,
  heartbeatRuns,
  issues,
  organizationIssuePrefixAliases,
  organizationMemberships,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, desc, eq, inArray, not, or, sql } from "drizzle-orm";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { registerAgentManagementRoutes } from "../routes/agents.management-routes.js";
import { assertCompanyAccess } from "../routes/authz.js";
import type { LiveRunReadInput } from "../services/live-run-read-bridge.js";
import {
  createRustFoundationBridge,
  type RustFoundationActor,
  type RustFoundationBridge,
} from "../services/rust-foundation-bridge.js";

// This suite exercises the real entry path, not a mocked bridge response.
// Missing prerequisites fail instead of silently skipping native acceptance.
// cargo build --locked --manifest-path native/Cargo.toml -p rudder-server-foundation --bin rudder-server-foundation
// pnpm exec vitest run --root server --config vitest.config.ts src/__tests__/live-run-read-real-entry.test.ts
// RUDDER_SERVER_FOUNDATION_PATH may select the exact built candidate binary.
// Only a freshly migrated embedded database and temporary home are used. No
// production server, configured DATABASE_URL, or durable Rudder instance is used.
type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags: string[];
  onLog: () => void;
  onError: () => void;
}) => EmbeddedPostgresInstance;
type WireRun = Record<string, unknown> & { id: string; createdAt: string };
type DispatchReceipt = {
  sequence: number;
  actorType: RustFoundationActor["type"];
  actorId: string | undefined;
  actorSource: RustFoundationActor["source"];
  orgId: string;
  input: LiveRunReadInput;
  outcome: "pending" | "response" | "error";
  status?: number;
  responseBytes?: number;
  responseSha256?: string;
};

function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function filesystemSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(directory: string) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        result[relative] = "directory";
        visit(absolute);
      } else if (stat.isSymbolicLink()) {
        result[relative] = `symlink:${fs.readlinkSync(absolute)}`;
      } else {
        result[relative] = sha256(fs.readFileSync(absolute));
      }
    }
  }
  visit(root);
  return result;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function closeServer(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

describe("Live-run reads through real public HTTP, Rust and PostgreSQL", () => {
  let db: ReturnType<typeof createDb> | undefined;
  let database: EmbeddedPostgresInstance | undefined;
  let bridge: RustFoundationBridge | undefined;
  let server: Server | undefined;
  let dataDir = "";
  let home = "";
  let connectionString = "";
  let nativeBinary = "";
  let baselineDatabase: Record<string, { count: number; sha256: string }> | undefined;
  let baselineFilesystem: Record<string, string>;
  const receipts: DispatchReceipt[] = [];
  const originalHome = process.env.RUDDER_HOME;
  const originalInstance = process.env.RUDDER_INSTANCE_ID;
  const originalWorkspaceHome = process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const emptyOrgId = randomUUID();
  const volumeOrgId = randomUUID();
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const volumeAgentId = randomUUID();
  const goalId = randomUUID();
  const otherGoalId = randomUUID();
  const foreignGoalId = randomUUID();
  const issueId = randomUUID();
  const emptyIssueId = randomUUID();
  const foreignIssueId = randomUUID();
  const queuedId = randomUUID();
  const runningId = randomUUID();
  const pendingIds = Array.from({ length: 4 }, () => randomUUID());
  const contextRunIds = Array.from({ length: 5 }, () => randomUUID());
  const recentIds = Array.from({ length: 26 }, () => randomUUID());
  const volumeIds = Array.from({ length: 32 }, () => randomUUID());
  const foreignRunId = randomUUID();
  const boardUserId = `live-run-read-user-${randomUUID()}`;
  const agentToken = `live-run-read-agent-${randomUUID()}`;
  const boardToken = `live-run-read-board-${randomUUID()}`;
  const early = new Date("2024-02-29T12:34:56.123+08:00");
  const later = new Date("2024-03-01T01:02:03.456-07:00");
  const terminals = ["succeeded", "failed", "cancelled", "timed_out"];
  // Preserve raw PostgreSQL JSONB numbers that JS fixture insertion would
  // already round/null. The old driver JSON.parse + Express JSON.stringify
  // contract rounds unsafe integers and serializes non-finite numbers as null.
  const deepJson = `${"[".repeat(192)}{"value":1e400}${"]".repeat(192)}`;
  const summaryJson = `{"text":"Verified release ☃","nested":{"nullable":null,"ok":true},"values":[1,"two"],"numbers":{"unsafeInteger":9007199254740993,"largeUnsigned":18446744073709551615,"overflow":1e400,"negativeOverflow":-1e400,"underflow":1e-400,"fraction":1.234567890123456789},"sentinel":{"$serde_json::private::Number":"123","$serde_json::private::RawValue":"[1]"},"deep":${deepJson}}`;
  const summary = wire(JSON.parse(summaryJson)) as Record<string, unknown>;
  const orgFields = [
    "id", "status", "executionPhase", "invocationSource", "triggerDetail", "startedAt", "finishedAt",
    "createdAt", "stdoutExcerpt", "resultJson", "agentId", "agentName", "agentRuntimeType", "goalId", "issueId",
  ].sort();
  const issueFields = orgFields.filter((field) => field !== "goalId" && field !== "issueId");

  // The only wrapper records completed calls and the actual response digest; it
  // always delegates to the real subprocess bridge, never returns fixture JSON.
  function instrument(selected: RustFoundationBridge): RustFoundationBridge {
    return {
      ...selected,
      async liveRunRead(actor, organizationId, input) {
        const receipt: DispatchReceipt = {
          sequence: receipts.length + 1,
          actorType: actor.type,
          actorId: actor.type === "agent" ? actor.agentId : actor.userId,
          actorSource: actor.source,
          orgId: organizationId,
          input: { ...input },
          outcome: "pending",
        };
        receipts.push(receipt);
        try {
          const response = await selected.liveRunRead!(actor, organizationId, input);
          Object.assign(receipt, {
            outcome: "response", status: response.status,
            responseBytes: response.body.byteLength, responseSha256: sha256(response.body),
          });
          return response;
        } catch (error) {
          receipt.outcome = "error";
          throw error;
        }
      },
    };
  }

  async function startApp(selected?: RustFoundationBridge) {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db!, { deploymentMode: "authenticated", authRequirement: "required" }));
    const router = express.Router();
    // Unrelated mutation/orchestration handlers remain uninvoked. Keeping the
    // actual route registrar retains real issueService UUID/alias lookup and
    // actual organization authorization without booting a heartbeat worker.
    registerAgentManagementRoutes({ router, db: db!, heartbeat: {}, access: {}, rustFoundationBridge: selected });
    app.use("/api", router);
    app.use(errorHandler);
    const result = app.listen(0, "127.0.0.1");
    await once(result, "listening");
    return result;
  }

  function get(url: string, token = agentToken, target = server!) {
    return request(target).get(url).set("authorization", `Bearer ${token}`);
  }

  // Frozen legacy Drizzle query, deliberately independent of the native SQL.
  // Preserve wire field presence, nulls, summary mapping and both sort phases.
  async function legacyRuns(organizationId: string, input: LiveRunReadInput): Promise<WireRun[]> {
    const columns = {
      id: heartbeatRuns.id, status: heartbeatRuns.status, executionPhase: heartbeatRuns.runningSubstate,
      invocationSource: heartbeatRuns.invocationSource, triggerDetail: heartbeatRuns.triggerDetail,
      startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt, createdAt: heartbeatRuns.createdAt,
      stdoutExcerpt: heartbeatRuns.stdoutExcerpt, resultJson: heartbeatRuns.resultSummaryJson,
      agentId: heartbeatRuns.agentId, agentName: agents.name, agentRuntimeType: agents.agentRuntimeType,
      goalId: heartbeatRuns.goalId,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
    };
    const scope = [
      eq(heartbeatRuns.orgId, organizationId),
      ...(input.goalId ? [eq(heartbeatRuns.goalId, input.goalId)] : []),
      ...(input.issueId ? [sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`] : []),
    ];
    const live = await db!.select(columns).from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(and(...scope, or(inArray(heartbeatRuns.status, ["queued", "running"]), eq(heartbeatRuns.terminalEffectsPending, true))))
      .orderBy(desc(heartbeatRuns.createdAt));
    const rows = [...live];
    if (!input.issueId && input.minCount > live.length) {
      const ids = live.map((row) => row.id);
      rows.push(...await db!.select(columns).from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(and(...scope, not(inArray(heartbeatRuns.status, ["queued", "running"])),
          eq(heartbeatRuns.terminalEffectsPending, false), ...(ids.length ? [not(inArray(heartbeatRuns.id, ids))] : [])))
        .orderBy(desc(heartbeatRuns.createdAt)).limit(input.minCount - live.length));
    }
    return wire(rows.map((row) => {
      if (!input.issueId) return row;
      const { goalId: _goalId, issueId: _issueId, ...issueRow } = row;
      return issueRow;
    })) as unknown as WireRun[];
  }

  async function databaseSnapshot() {
    // Snapshot every public table, including runtime, receipts, outbox, audit,
    // issue enrichment and authorization. Only legitimate auth-key last-use
    // timestamps are excluded; insertion/deletion and all other fields count.
    const tables = await db!.execute<{ tablename: string }>(sql`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `);
    const snapshot: Record<string, { count: number; sha256: string }> = {};
    for (const { tablename } of tables) {
      const identifier = `"${tablename.replaceAll('"', '""')}"`;
      const row = ["agent_api_keys", "board_api_keys"].includes(tablename)
        ? "to_jsonb(snapshot) - 'last_used_at'" : "to_jsonb(snapshot)";
      const result = await db!.execute<{ count: number; contents: string }>(sql.raw(
        `SELECT count(*)::int AS count, coalesce(jsonb_agg(${row} ORDER BY (${row})::text), '[]'::jsonb)::text AS contents FROM ${identifier} AS snapshot`,
      ));
      snapshot[tablename] = { count: result[0]!.count, sha256: sha256(result[0]!.contents) };
    }
    return snapshot;
  }

  function expectReceipt(index: number, token: string, organizationId: string, input: LiveRunReadInput, responseText: string) {
    expect(receipts[index]).toEqual({
      sequence: index + 1,
      actorType: token === agentToken ? "agent" : "board",
      actorId: token === agentToken ? agentId : boardUserId,
      actorSource: token === agentToken ? "agent_key" : "board_key",
      orgId: organizationId, input, outcome: "response", status: 200,
      responseBytes: Buffer.byteLength(responseText), responseSha256: sha256(responseText),
    });
  }

  async function expectParity(url: string, input: LiveRunReadInput, token = agentToken, organizationId = orgId) {
    const index = receipts.length;
    const expected = await legacyRuns(organizationId, input);
    const response = await get(url, token);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.body).toEqual(expected);
    expect(receipts).toHaveLength(index + 1);
    expectReceipt(index, token, organizationId, input, response.text);
    for (const row of response.body as WireRun[]) {
      expect(Object.keys(row).sort()).toEqual(input.issueId ? issueFields : orgFields);
    }
    return response.body as WireRun[];
  }

  beforeAll(async () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
    const targetRoot = path.resolve(repoRoot, process.env.CARGO_TARGET_DIR ?? "native/target");
    const explicitBinary = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const candidates = explicitBinary ? [path.resolve(repoRoot, explicitBinary)]
      : [path.join(targetRoot, "debug", binaryName), path.join(targetRoot, "release", binaryName)];
    nativeBinary = candidates.find((candidate) => {
      try {
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch { return false; }
    }) ?? candidates[0]!;
    if (!fs.existsSync(nativeBinary)) {
      throw new Error(`Real live-run integration requires a built foundation binary at ${nativeBinary}. Build rudder-server-foundation or set RUDDER_SERVER_FOUNDATION_PATH.`);
    }
    fs.accessSync(nativeBinary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-live-run-read-home-"));
    process.env.RUDDER_HOME = home;
    process.env.RUDDER_INSTANCE_ID = "live-run-read-test";
    delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-live-run-read-postgres-"));
    const port = await getAvailablePort();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as EmbeddedPostgresCtor;
    database = new EmbeddedPostgres({
      databaseDir: dataDir, user: "rudder", password: "rudder", port, persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {},
    });
    await database.initialise();
    await database.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
    connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    await db.execute(sql`ALTER DATABASE rudder SET timezone TO 'Pacific/Honolulu'`);
    await db.$client.end({ timeout: 5 });
    db = createDb(connectionString);
    expect((await db.execute(sql`SELECT current_setting('TimeZone') AS timezone`))[0]?.timezone).toBe("Pacific/Honolulu");
    await db.insert(organizations).values([
      { id: orgId, name: "Release verification", urlKey: deriveOrganizationUrlKey("Release verification"), issuePrefix: "RUN" },
      { id: foreignOrgId, name: "Foreign verification", urlKey: deriveOrganizationUrlKey("Foreign verification"), issuePrefix: "FRN" },
      { id: emptyOrgId, name: "Empty verification", urlKey: deriveOrganizationUrlKey("Empty verification"), issuePrefix: "EMP" },
      { id: volumeOrgId, name: "Volume verification", urlKey: deriveOrganizationUrlKey("Volume verification"), issuePrefix: "VOL" },
    ]);
    await db.insert(organizationIssuePrefixAliases).values({ orgId, prefix: "OLD" });
    await db.insert(agents).values([
      { id: agentId, orgId, name: "Release verifier ☃", role: "general", status: "idle", agentRuntimeType: "process" },
      { id: foreignAgentId, orgId: foreignOrgId, name: "FOREIGN_AGENT_MUST_NOT_LEAK", status: "idle" },
      { id: volumeAgentId, orgId: volumeOrgId, name: "Batch verifier", status: "idle" },
    ]);
    await db.insert(agentApiKeys).values({ orgId, agentId, name: "Fixture reader", keyHash: sha256(agentToken) });
    await db.insert(authUsers).values({ id: boardUserId, name: "Fixture operator", email: "live-read@example.test", createdAt: early, updatedAt: later });
    await db.insert(organizationMemberships).values([orgId, emptyOrgId, volumeOrgId].map((id) => ({
      orgId: id, principalType: "user", principalId: boardUserId, status: "active", membershipRole: "member",
    })));
    await db.insert(boardApiKeys).values({ userId: boardUserId, name: "Fixture reader", keyHash: sha256(boardToken) });
    await db.insert(goals).values([
      { id: goalId, orgId, title: "Verify release" }, { id: otherGoalId, orgId, title: "Prepare documentation" },
      { id: foreignGoalId, orgId: foreignOrgId, title: "FOREIGN_GOAL_MUST_NOT_LEAK" },
    ]);
    await db.insert(issues).values([
      { id: issueId, orgId, goalId, title: "Verify native reads", issueNumber: 1, identifier: "RUN-1" },
      { id: emptyIssueId, orgId, title: "No execution yet", issueNumber: 2, identifier: "RUN-2" },
      { id: foreignIssueId, orgId: foreignOrgId, title: "Foreign work", issueNumber: 1, identifier: "FRN-1" },
    ]);
    const base = { orgId, agentId, goalId, contextSnapshot: { issueId }, updatedAt: later };
    await db.insert(heartbeatRuns).values([
      { ...base, id: queuedId, status: "queued", createdAt: early, resultJson: { fullResult: "FULL_RESULT_MUST_NOT_LEAK" } },
      // Exercise current common-run identity alongside the legacy nullable row.
      { ...base, id: runningId, scene: "issue", targetType: "issue", targetId: issueId,
        idempotencyKey: "live-read-current-run", sessionReuseScope: "none",
        sessionIntentJson: { kind: "fresh", reuseScope: "none", sourceRunId: null, sessionId: null, sessionParams: null },
        status: "running", runningSubstate: "waiting_for_network", createdAt: later,
        startedAt: early, stdoutExcerpt: "Checking release\n✓", invocationSource: "automation", triggerDetail: "release_check",
        resultSummaryJson: summary, resultJson: { fullResult: "FULL_RESULT_MUST_NOT_LEAK", unrelated: "private transcript" } },
      ...pendingIds.map((id, index) => ({
        ...base, id, status: terminals[index]!, terminalEffectsPending: true,
        createdAt: new Date(early.getTime() + (index + 1) * 60_000), startedAt: early, finishedAt: later,
        resultSummaryJson: index === 0 ? {} : { terminal: terminals[index], nullable: null },
      })),
      ...contextRunIds.map((id, index) => ({
        ...base, id, status: index % 2 ? "running" : "queued", goalId: index < 3 ? otherGoalId : null,
        contextSnapshot: [null, { issueId: null }, { issueId: 42 }, {}, { issueId: foreignIssueId }][index],
        createdAt: new Date(early.getTime() + (index + 10) * 60_000),
      })),
      // Newer completed rows make a global re-sort visibly wrong: they must
      // follow all live rows, descending within their own filler section.
      ...recentIds.map((id, index) => ({
        ...base, id, status: terminals[index % terminals.length]!, terminalEffectsPending: false,
        createdAt: new Date(later.getTime() + (index + 1) * 60_000), startedAt: early, finishedAt: later,
        stdoutExcerpt: `Finished verification ${index}`, resultSummaryJson: { check: index },
      })),
      // A foreign run deliberately names our issue in compatibility JSON;
      // issue filtering must still enforce the run's organization.
      { id: foreignRunId, orgId: foreignOrgId, agentId: foreignAgentId, goalId: foreignGoalId,
        status: "running", contextSnapshot: { issueId }, createdAt: later, stdoutExcerpt: "FOREIGN_RUN_MUST_NOT_LEAK" },
      ...volumeIds.map((id, index) => ({
        id, orgId: volumeOrgId, agentId: volumeAgentId, status: index % 2 ? "running" : "queued",
        createdAt: new Date(early.getTime() + index * 60_000), stdoutExcerpt: `Batch ${index}: ${"x".repeat(10_000)}`,
      })),
    ]);
    await db.execute(sql`UPDATE heartbeat_runs SET result_summary_json = ${summaryJson}::jsonb WHERE id = ${runningId}::uuid`);
    // All switches off still require native reads, and first HTTP requests
    // below exercise concurrent lazy startup rather than pre-starting a worker.
    bridge = createRustFoundationBridge({
      databaseUrl: connectionString, binaryPath: nativeBinary,
      mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", requestTimeoutMs: 10_000,
    });
    server = await startApp(instrument(bridge));
    baselineDatabase = await databaseSnapshot();
    baselineFilesystem = filesystemSnapshot(home);
  }, 90_000);

  afterEach(async () => {
    if (!baselineDatabase) return;
    expect(await databaseSnapshot()).toEqual(baselineDatabase);
    expect(filesystemSnapshot(home)).toEqual(baselineFilesystem);
    expect(receipts.every((receipt) => receipt.outcome !== "pending")).toBe(true);
  }, 30_000);

  afterAll(async () => {
    try {
      await closeServer(server);
      await bridge?.close();
      await db?.$client.end({ timeout: 5 });
      await database?.stop();
    } finally {
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
      if (home) fs.rmSync(home, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.RUDDER_HOME;
      else process.env.RUDDER_HOME = originalHome;
      if (originalInstance === undefined) delete process.env.RUDDER_INSTANCE_ID;
      else process.env.RUDDER_INSTANCE_ID = originalInstance;
      if (originalWorkspaceHome === undefined) delete process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME;
      else process.env.RUDDER_ORGANIZATION_WORKSPACE_HOME = originalWorkspaceHome;
    }
  }, 20_000);

  it("handles concurrent authenticated reads through the same lazily started native process", async () => {
    const input = { issueId: null, goalId: null, minCount: 0 };
    const expected = await legacyRuns(orgId, input);
    const before = receipts.length;
    const tokens = Array.from({ length: 12 }, (_, index) => index % 2 ? boardToken : agentToken);
    const responses = await Promise.all(tokens.map((token) => get(`/api/orgs/${orgId}/live-runs`, token)));
    expect(receipts).toHaveLength(before + tokens.length);
    for (const response of responses) {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(response.body).toEqual(expected);
    }
    const completed = receipts.slice(before);
    expect(completed.filter((receipt) => receipt.actorType === "board")).toHaveLength(6);
    expect(completed.filter((receipt) => receipt.actorType === "agent")).toHaveLength(6);
    for (const receipt of completed) {
      expectReceipt(receipt.sequence - 1, receipt.actorType === "agent" ? agentToken : boardToken, orgId, input, responses[0]!.text);
    }
  }, 30_000);

  it("preserves every legacy field, UTC milliseconds, nulls and summary-only results", async () => {
    const rows = await expectParity(`/api/orgs/${orgId}/live-runs`, { issueId: null, goalId: null, minCount: 0 });
    expect(rows).toHaveLength(11);
    expect(rows.find((row) => row.id === queuedId)).toMatchObject({
      executionPhase: null, invocationSource: "on_demand", triggerDetail: null,
      startedAt: null, finishedAt: null, createdAt: "2024-02-29T04:34:56.123Z", stdoutExcerpt: null, resultJson: null,
      agentId, agentName: "Release verifier ☃", agentRuntimeType: "process", goalId, issueId,
    });
    expect(rows.find((row) => row.id === runningId)).toMatchObject({
      executionPhase: "waiting_for_network", startedAt: "2024-02-29T04:34:56.123Z", finishedAt: null,
      createdAt: "2024-03-01T08:02:03.456Z", resultJson: summary,
    });
    expect((rows.find((row) => row.id === runningId)?.resultJson as Record<string, unknown>).numbers).toEqual({
      unsafeInteger: 9007199254740992, largeUnsigned: 18446744073709552000,
      overflow: null, negativeOverflow: null, underflow: 0, fraction: 1.2345678901234567,
    });
    for (const [index, id] of pendingIds.entries()) {
      expect(rows.find((row) => row.id === id)).toMatchObject({ status: terminals[index], finishedAt: "2024-03-01T08:02:03.456Z" });
    }
    expect(rows.find((row) => row.id === pendingIds[0])?.resultJson).toEqual({});
    for (const index of [0, 1, 3]) expect(rows.find((row) => row.id === contextRunIds[index])?.issueId).toBeNull();
    expect(rows.find((row) => row.id === contextRunIds[2])?.issueId).toBe("42");
    expect(rows.find((row) => row.id === contextRunIds[3])?.goalId).toBeNull();
    expect(rows.map((row) => row.id)).not.toContain(foreignRunId);
    for (const id of recentIds) expect(rows.map((row) => row.id)).not.toContain(id);
    expect(JSON.stringify(rows)).not.toMatch(/FULL_RESULT_MUST_NOT_LEAK|FOREIGN_.*MUST_NOT_LEAK/);
  });

  it("treats minCount as a filler minimum, keeps live-first order, and never duplicates or caps live rows", async () => {
    const live = await legacyRuns(orgId, { issueId: null, goalId: null, minCount: 0 });
    for (const [query, minimum] of [["3", 3], ["14", 14], ["999", 20], ["-2", 0], ["garbage", 0], ["12suffix", 12]] as const) {
      const rows = await expectParity(`/api/orgs/${orgId}/live-runs?minCount=${query}`, { issueId: null, goalId: null, minCount: minimum });
      expect(rows.slice(0, live.length)).toEqual(live);
      expect(rows).toHaveLength(Math.max(live.length, minimum));
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      const fillerCount = Math.max(0, minimum - live.length);
      expect(rows.slice(live.length).map((row) => row.id)).toEqual([...recentIds].reverse().slice(0, fillerCount));
      if (fillerCount) expect(rows[live.length]!.createdAt > rows[0]!.createdAt).toBe(true);
    }
    const volume = await expectParity(`/api/orgs/${volumeOrgId}/live-runs?minCount=20`,
      { issueId: null, goalId: null, minCount: 20 }, boardToken, volumeOrgId);
    expect(volume).toHaveLength(volumeIds.length);
    expect(volume.map((row) => row.id)).toEqual([...volumeIds].reverse());
    expect(Buffer.byteLength(JSON.stringify(volume))).toBeGreaterThan(256 * 1024);
  }, 30_000);

  it("applies goal filters to live rows and fillers while ignoring malformed goal filters", async () => {
    for (const id of [goalId, otherGoalId, foreignGoalId, randomUUID()]) {
      const rows = await expectParity(`/api/orgs/${orgId}/live-runs?goalId=${id}&minCount=20`,
        { issueId: null, goalId: id, minCount: 20 });
      expect(rows.every((row) => row.goalId === id)).toBe(true);
      if (id === otherGoalId) expect(rows).toHaveLength(3);
      if (id === foreignGoalId) expect(rows).toEqual([]);
    }
    await expectParity(`/api/orgs/${orgId}/live-runs?goalId=${goalId.toUpperCase()}&minCount=20`,
      { issueId: null, goalId: goalId.toUpperCase(), minCount: 20 });
    await expectParity(`/api/orgs/${orgId}/live-runs?goalId=not-a-uuid&minCount=14`,
      { issueId: null, goalId: null, minCount: 14 });
  }, 20_000);

  it("resolves real issue UUID/current-prefix/old-prefix aliases and preserves the smaller issue projection", async () => {
    for (const reference of [issueId, "RUN-1", "run-1", "OLD-1", "old-1"]) {
      for (const token of [agentToken, boardToken]) {
        const rows = await expectParity(`/api/issues/${reference}/live-runs?goalId=${otherGoalId}&minCount=20`,
          { issueId, goalId: null, minCount: 0 }, token);
        expect(rows).toHaveLength(6);
        expect(new Set(rows.map((row) => row.id))).toEqual(new Set([queuedId, runningId, ...pendingIds]));
        expect(JSON.stringify(rows)).not.toContain("MUST_NOT_LEAK");
      }
    }
    expect(await expectParity(`/api/issues/${emptyIssueId}/live-runs`, { issueId: emptyIssueId, goalId: null, minCount: 0 })).toEqual([]);
    expect(await expectParity(`/api/orgs/${emptyOrgId}/live-runs?minCount=20`,
      { issueId: null, goalId: null, minCount: 20 }, boardToken, emptyOrgId)).toEqual([]);
  }, 20_000);

  it("preserves legacy HTTP errors for malformed goal IDs accepted by the existing permissive parser", async () => {
    const malformed = "-".repeat(36);
    expect(/^[0-9a-f-]{36}$/i.test(malformed)).toBe(true);
    const input = { issueId: null, goalId: malformed, minCount: 20 };
    // Keep the legacy DB failure and real HTTP error serialization observable,
    // rather than baking the expected error response into the native oracle.
    const legacyApp = express();
    legacyApp.use(actorMiddleware(db!, { deploymentMode: "authenticated", authRequirement: "required" }));
    legacyApp.get("/api/orgs/:orgId/live-runs", async (req, res) => {
      assertCompanyAccess(req, req.params.orgId as string);
      res.json(await legacyRuns(req.params.orgId as string, input));
    });
    legacyApp.use(errorHandler);
    const legacyServer = legacyApp.listen(0, "127.0.0.1");
    await once(legacyServer, "listening");
    try {
      const url = `/api/orgs/${orgId}/live-runs?goalId=${malformed}&minCount=20`;
      const legacy = await get(url, agentToken, legacyServer);
      const before = receipts.length;
      const native = await get(url);
      expect(legacy.status).toBe(500);
      expect(legacy.body).toEqual({ error: "Internal server error" });
      expect(native.status).toBe(legacy.status);
      expect(native.body).toEqual(legacy.body);
      expect(receipts).toHaveLength(before + 1);
      expect(receipts[before]).toMatchObject({ orgId, input, outcome: "response", status: 500, responseSha256: sha256(native.text) });
    } finally {
      await closeServer(legacyServer);
    }
  }, 20_000);

  it("rejects missing, unauthenticated and cross-organization requests before native dispatch", async () => {
    const before = receipts.length;
    for (const token of [agentToken, boardToken]) {
      for (const reference of [randomUUID(), "RUN-9999", "old-9999"]) {
        const missing = await get(`/api/issues/${reference}/live-runs`, token);
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ error: "Issue not found" });
      }
      for (const url of [`/api/orgs/${foreignOrgId}/live-runs`, `/api/issues/${foreignIssueId}/live-runs`, "/api/issues/frn-1/live-runs"]) {
        const denied = await get(url, token);
        expect(denied.status).toBe(403);
        expect(denied.body).toEqual({ error: token === agentToken
          ? "Agent key cannot access another organization" : "User does not have access to this organization" });
      }
    }
    for (const url of [`/api/orgs/${orgId}/live-runs`, `/api/issues/${issueId}/live-runs`]) {
      for (const token of [null, "invalid-fixture-token"]) {
        const pending = request(server!).get(url);
        if (token) pending.set("authorization", `Bearer ${token}`);
        const denied = await pending;
        expect(denied.status).toBe(401);
        expect(denied.body).toEqual({ error: "Unauthorized" });
      }
    }
    expect(receipts).toHaveLength(before);
  }, 20_000);

  it("retains the migrated agent FK instead of manufacturing impossible orphan fixtures", async () => {
    // A missing-agent run is impossible in the production schema. Native SQL
    // unit coverage asserts the INNER JOIN; this real-schema test proves that
    // orphan fixture creation is rejected rather than disabling constraints.
    const constraints = await db!.execute(sql`
      SELECT convalidated FROM pg_constraint
      WHERE conrelid = 'heartbeat_runs'::regclass AND confrelid = 'agents'::regclass
        AND contype = 'f' AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (agent_id)%'
    `);
    expect(constraints.length).toBeGreaterThan(0);
    expect(constraints.every((row) => row.convalidated === true)).toBe(true);
    const result = await db!.insert(heartbeatRuns).values({ orgId, agentId: randomUUID(), status: "queued" })
      .then(() => "unexpected insert", (error: { code?: string; cause?: { code?: string } }) => error.cause?.code ?? error.code);
    expect(result).toBe("23503");
  });

  it("fails closed for an absent or broken bridge without returning the available Node oracle", async () => {
    const unavailable = createRustFoundationBridge({
      databaseUrl: connectionString, binaryPath: path.join(home, "foundation-does-not-exist"),
      mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", requestTimeoutMs: 1_000,
    });
    const urls = [`/api/orgs/${orgId}/live-runs`, `/api/issues/${issueId}/live-runs`];
    for (const selected of [undefined, instrument(unavailable)]) {
      const failedServer = await startApp(selected);
      const before = receipts.length;
      try {
        for (const url of urls) {
          const failed = await get(url, agentToken, failedServer);
          expect(failed.status).toBe(503);
          expect(failed.body).toEqual({ error: "Rust live-run reads are unavailable" });
        }
        expect(receipts.slice(before).map((receipt) => receipt.outcome)).toEqual(selected ? ["error", "error"] : []);
      } finally {
        await closeServer(failedServer);
        await unavailable.close();
      }
    }
    // A failed instance must not poison a separate healthy bridge.
    await expectParity(urls[0]!, { issueId: null, goalId: null, minCount: 0 });
  }, 20_000);

  it("emits a reproducible native-dispatch receipt for the exact executable and read-only fixture", () => {
    expect(receipts.some((receipt) => receipt.input.issueId === issueId && receipt.status === 200)).toBe(true);
    expect(receipts.some((receipt) => receipt.orgId === volumeOrgId && receipt.status === 200)).toBe(true);
    expect(receipts.filter((receipt) => receipt.outcome === "error")).toHaveLength(2);
    expect(receipts.every((receipt) => receipt.outcome !== "pending")).toBe(true);
    console.info("LIVE_RUN_NATIVE_DISPATCH_RECEIPT", JSON.stringify({
      binaryPath: nativeBinary, binarySha256: sha256(fs.readFileSync(nativeBinary)),
      databaseKind: "disposable-migrated-embedded-postgres", domainFingerprint: sha256(JSON.stringify(baselineDatabase)),
      authenticatedEntry: "registerAgentManagementRoutes + actorMiddleware",
      receipts,
    }));
  });

  it("boots the normal API app and serves the existing polling contracts with all pilots off", async () => {
    // The primary parity matrix above mounts the route registrar directly. This
    // separate observation closes the production-injection gap without mocking
    // createRudderApp, registerApiRoutes, agentRoutes, or the native bridge.
    const bootstrapHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-live-run-bootstrap-"));
    const isolatedEnvironment: Record<string, string | undefined> = {
      RUDDER_HOME: bootstrapHome,
      RUDDER_CONFIG: path.join(bootstrapHome, "config.json"),
      RUDDER_LOG_DIR: path.join(bootstrapHome, "logs"),
      RUN_LOG_BASE_PATH: path.join(bootstrapHome, "run-logs"),
      RUDDER_ORGANIZATION_WORKSPACE_HOME: path.join(bootstrapHome, "workspaces"),
      RUDDER_STORAGE_LOCAL_DISK_BASE_DIR: path.join(bootstrapHome, "storage"),
      RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS: undefined,
      RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS: undefined,
    };
    const previousEnvironment = Object.fromEntries(
      Object.keys(isolatedEnvironment).map((name) => [name, process.env[name]]),
    );
    for (const [name, value] of Object.entries(isolatedEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    let handle: import("../app.js").RudderAppHandle | undefined;
    let bootstrapServer: Server | undefined;
    try {
      const { createRudderApp } = await import("../app.js");
      const { createStorageService } = await import("../storage/service.js");
      const { createLocalDiskStorageProvider } = await import("../storage/local-disk-provider.js");
      const beforeStartup = await databaseSnapshot();
      // Close the mounted-route native process so this path must acquire and
      // use its own foundation lifecycle, rather than reuse the earlier bridge.
      await bridge!.close();
      const port = await getAvailablePort();
      handle = await createRudderApp(db!, {
        uiMode: "none", serverPort: port,
        storageService: createStorageService(createLocalDiskStorageProvider(path.join(bootstrapHome, "storage"))),
        deploymentMode: "authenticated", deploymentExposure: "private", authRequirement: "required",
        localRuntimeTrust: "untrusted", allowedHostnames: ["127.0.0.1", "localhost"], bindHost: "127.0.0.1",
        authReady: true, companyDeletionEnabled: false, databaseUrl: connectionString,
        rustFoundationBinaryPath: nativeBinary, rustFoundationMode: "off",
        rustOrganizationBrandingMode: "off", rustProjectGoalSetMode: "off",
        instanceId: "live-run-normal-bootstrap-test", localEnv: "e2e", mcpHostEnv: {},
        mcpDeploymentAllowlists: { httpOrigins: [], stdioCommands: [], stdioWorkingDirectories: [], stdioEnvironmentNames: [] },
      });
      bootstrapServer = handle.app.listen(port, "127.0.0.1");
      await once(bootstrapServer, "listening");
      const afterStartup = await databaseSnapshot();
      const requests: Array<{ path: string; actor: string; status: number; sha256: string; observedAt: string }> = [];
      for (const token of [agentToken, boardToken]) {
        for (const [url, input] of [
          [`/api/orgs/${orgId}/live-runs?minCount=4`, { issueId: null, goalId: null, minCount: 4 }],
          [`/api/issues/${issueId}/live-runs`, { issueId, goalId: null, minCount: 0 }],
          ["/api/issues/run-1/live-runs", { issueId, goalId: null, minCount: 0 }],
          ["/api/issues/old-1/live-runs", { issueId, goalId: null, minCount: 0 }],
        ] as const) {
          const response = await get(url, token, bootstrapServer);
          expect(response.status, response.text).toBe(200);
          expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(response.body).toEqual(await legacyRuns(orgId, input));
          requests.push({ path: url, actor: token === agentToken ? "agent" : "board", status: response.status, sha256: sha256(response.text), observedAt: new Date().toISOString() });
        }
        for (const url of [`/api/orgs/${foreignOrgId}/live-runs`, `/api/issues/${foreignIssueId}/live-runs`]) {
          const response = await get(url, token, bootstrapServer);
          expect(response.status, response.text).toBe(403);
        }
      }
      for (const url of [`/api/orgs/${orgId}/live-runs`, `/api/issues/${issueId}/live-runs`]) {
        expect((await request(bootstrapServer).get(url)).status).toBe(401);
      }
      // Exercise the unchanged LiveRunWidget (3s) and Issues list (5s) request
      // cadence. These are real API polling contracts, not rendered UI proof.
      // ActiveAgentsPanel's minCount=4 shape is covered above; it has no timer.
      const pollingStartedAt = Date.now();
      const poll = async (url: string, token: string, input: LiveRunReadInput, offsets: number[]) => {
        for (const offset of offsets) {
          await delay(Math.max(0, pollingStartedAt + offset - Date.now()));
          const response = await get(url, token, bootstrapServer!);
          expect(response.status, response.text).toBe(200);
          expect(response.body).toEqual(await legacyRuns(orgId, input));
          requests.push({ path: url, actor: token === agentToken ? "agent" : "board", status: response.status,
            sha256: sha256(response.text), observedAt: new Date().toISOString() });
        }
      };
      await Promise.all([
        poll(`/api/issues/${issueId}/live-runs`, agentToken, { issueId, goalId: null, minCount: 0 }, [0, 3_000, 6_000]),
        poll(`/api/orgs/${orgId}/live-runs`, boardToken, { issueId: null, goalId: null, minCount: 0 }, [0, 5_000, 10_000]),
      ]);
      expect(await databaseSnapshot()).toEqual(afterStartup);
      console.info("LIVE_RUN_NORMAL_BOOTSTRAP_RECEIPT", JSON.stringify({
        binaryPath: nativeBinary, binarySha256: sha256(fs.readFileSync(nativeBinary)),
        entry: "createRudderApp -> createHttpApp -> registerApiRoutes -> agentRoutes",
        databaseKind: "disposable-migrated-embedded-postgres", allPilotModes: "off",
        readOnly: true, renderedUiObserved: false, electronObserved: false,
        startupChangedTables: Object.keys(afterStartup).filter((name) => JSON.stringify(afterStartup[name]) !== JSON.stringify(beforeStartup[name])),
        domainFingerprint: sha256(JSON.stringify(afterStartup)), requests,
      }));
      // Normal startup may synchronize plugin projections. Keep that separate
      // from the proven read-only boundary and the preceding mounted matrix.
      baselineDatabase = afterStartup;
    } finally {
      await closeServer(bootstrapServer);
      await handle?.close();
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(bootstrapHome, { recursive: true, force: true });
    }
  }, 45_000);

});
