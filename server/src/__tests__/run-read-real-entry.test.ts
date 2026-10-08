import {
  agentApiKeys,
  agents,
  applyPendingMigrations,
  authUsers,
  boardApiKeys,
  chatConversations,
  createDb,
  ensurePostgresDatabase,
  executionWorkspaces,
  goals,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
  organizationIssuePrefixAliases,
  organizationMemberships,
  organizations,
  projects,
  workspaceOperations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey, toAgentRun, toAgentRuns, toHeartbeatRun } from "@rudderhq/shared";
import { eq, inArray, sql } from "drizzle-orm";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resolveRudderInstanceRoot } from "../home-paths.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { redactEventPayload } from "../redaction.js";
import { registerAgentManagementRoutes } from "../routes/agents.management-routes.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getRunLogStore } from "../services/run-log-store.js";
import { type RunReadInput, runReadRedaction } from "../services/run-read-bridge.js";
import {
  createRustFoundationBridge,
  type RustFoundationActor,
  type RustFoundationBridge,
} from "../services/rust-foundation-bridge.js";
import { getWorkspaceOperationLogStore } from "../services/workspace-operation-log-store.js";
import { workspaceOperationService } from "../services/workspace-operations.js";

// This suite exercises the real entry path, not a mocked bridge response.
// Missing prerequisites fail instead of silently skipping native acceptance.
// cargo build --locked --manifest-path native/Cargo.toml -p rudder-server-foundation --bin rudder-server-foundation
// pnpm exec vitest run --root server --config vitest.config.ts src/__tests__/run-read-real-entry.test.ts
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
  postgresFlags: string[];
  onLog: () => void;
  onError: () => void;
}) => EmbeddedPostgresInstance;
type DispatchReceipt = {
  sequence: number;
  actorType: RustFoundationActor["type"];
  actorId: string | undefined;
  actorSource: RustFoundationActor["source"];
  orgId: string;
  input: RunReadInput;
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

describe("Run reads through real public HTTP, Rust and PostgreSQL", () => {
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
  const numericContexts = ["1e-400", "-1e-400", "2e-324", "-2e-324", "0", "-0", "1", "-1", "5e-324", "-5e-324", "1e400", "-1e400"].map(raw => ({ id: randomUUID(), raw }));
  const duplicatePayloadTexts = [
    '{"__proto__":{},"__proto__":null,"safe":"native-user"}',
    '{"__proto__":null,"__proto__":{},"safe":"native-user"}',
    '{"nested":{"__proto__":{},"__proto__":null,"safe":"native-user"},"safe":"native-user"}',
    '{"nested":{"__proto__":null,"__proto__":{},"safe":"native-user"},"safe":"native-user"}',
    '{"__pro\\u0074o__":{},"__proto__":null,"safe":"native-user"}',
  ];
  const utf16PayloadTexts = [
    String.raw`{"pass\u0077ord\ud800":"TOP_SECRET","safe":"native-user\ud800"}`,
    String.raw`{"before":"\ud800native-user","low":"native-user\udc00","pair":"\ud83d\ude00native-user\ud800","unicode":"中文 ☃ 😀"}`,
    String.raw`{"nested":{"api\u004bey\ud800":"NESTED_SECRET","safe":"\ud800native-user\udc00"},"items":["native-user\ud800",{"pass\u0077ord\udc00":"ARRAY_SECRET","safe":"\udc00native-user"}]}`,
    String.raw`{"pass\u0077ord\uD800":"DISCARDED_SECRET","password\ud800":"TOP_SECRET","safe\uD800":"discarded","safe\ud800":"native-user\ud800"}`,
    String.raw`{"value":"\u0061.\u0062.\u0063","surrogate":"a.b.c\ud800"}`,
    String.raw`{"safe":"native-user\x"}`,
    String.raw`{"safe":"native-user\uZZZZ"}`,
    `{"safe":"${"😀".repeat(70_000)}native-user\\ud800","password\\ud800":"PADDED_SECRET","tail":"\\udc00native-user"}`,
  ];
  const scalarPayloads = ["null", "false", "0", "-0", "1e-400", "-1e-400", '""', "true", "1", "-1", "5e-324", "1e400", "-1e400", '"0"', '"native-user"', '"false"', '"null"', '"[]"', JSON.stringify('"0"'), JSON.stringify('{"password":"column-secret","user":"native-user"}'), "[]", '[false,0,"",{"password":"native-user"}]', '{"zero":0,"false":false,"empty":""}'].concat(utf16PayloadTexts.map(value => JSON.stringify(value)), duplicatePayloadTexts.map(value => JSON.stringify(value)));
  const recentIds = Array.from({ length: 26 }, () => randomUUID());
  const volumeIds = Array.from({ length: 1105 }, () => randomUUID());
  const foreignRunId = randomUUID();
  const boardUserId = `live-run-read-user-${randomUUID()}`;
  const agentToken = `live-run-read-agent-${randomUUID()}`;
  const boardToken = `live-run-read-board-${randomUUID()}`;
  const redaction = { enabled: true, userNames: ["native-user"], homeDirs: ["/home/native-user", "C:\\Users\\native-user"] };
  const fallbackAgent = randomUUID();
  const terminatedAgent = randomUUID();
  const olderFallbackIssue = randomUUID();
  const newerFallbackIssue = randomUUID();
  const pendingIssue = randomUUID();
  const finishedIssue = randomUUID();
  const olderFallbackRun = randomUUID();
  const newerFallbackRun = randomUUID();
  const terminatedRun = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  let legacy: ReturnType<typeof heartbeatService>;
  const early = new Date("2024-02-29T12:34:56.123+08:00");
  const later = new Date("2024-03-01T01:02:03.456-07:00");
  const terminals = ["succeeded", "failed", "cancelled", "timed_out"];
  // Preserve raw PostgreSQL JSONB numbers that JS fixture insertion would
  // already round/null. The old driver JSON.parse + Express JSON.stringify
  // contract rounds unsafe integers and serializes non-finite numbers as null.
  const deepJson = `${"[".repeat(192)}{"value":1e400}${"]".repeat(192)}`;
  const summaryJson = `{"text":"Verified release ☃","nested":{"nullable":null,"ok":true},"values":[1,"two"],"numbers":{"unsafeInteger":9007199254740993,"largeUnsigned":18446744073709551615,"overflow":1e400,"negativeOverflow":-1e400,"underflow":1e-400,"fraction":1.234567890123456789},"sentinel":{"$serde_json::private::Number":"123","$serde_json::private::RawValue":"[1]"},"deep":${deepJson}}`;
  const summary = wire(JSON.parse(summaryJson)) as Record<string, unknown>;
  // The only wrapper records completed calls and the actual response digest; it
  // always delegates to the real subprocess bridge, never returns fixture JSON.
  function instrument(selected: RustFoundationBridge): RustFoundationBridge {
    return {
      ...selected,
      async runRead(actor, organizationId, input) {
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
          const response = await selected.runRead!(actor, organizationId, input);
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
    registerAgentManagementRoutes({ router, db: db!, heartbeat: legacy, access: {}, workspaceOperations: workspaceOperationService(db!), rustFoundationBridge: selected,
      getRunReadEnvironment: () => runReadRedaction(redaction) });
    app.use("/api", router);
    app.use(errorHandler);
    const result = app.listen(0, "127.0.0.1");
    await once(result, "listening");
    return result;
  }

  function get(url: string, token = agentToken, target = server!) {
    return request(target).get(url).set("authorization", `Bearer ${token}`);
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
      initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-k", ""], onLog: () => {}, onError: () => {},
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
        contextSnapshot: [null, { issueId: null }, { issueId: 42 }, "a😀", { issueId: foreignIssueId }][index] as any,
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
        createdAt: new Date(early.getTime() + index * 60_000), stdoutExcerpt: `Batch ${index}`, contextSnapshot: { note: "x".repeat(300) },
      })),
    ]);
    await db.execute(sql`UPDATE heartbeat_runs SET result_summary_json = ${summaryJson}::jsonb WHERE id = ${runningId}::uuid`);
    await db.insert(heartbeatRuns).values(numericContexts.map(({ id }) => ({ id, orgId, agentId, status: "succeeded", createdAt: early, updatedAt: later })));
    // Raw SQL preserves PostgreSQL numeric precision until the legacy JS
    // reader or native read boundary decides Number truthiness.
    for (const { id, raw } of numericContexts) {
      await db.execute(sql`UPDATE heartbeat_runs SET context_snapshot = ${raw}::jsonb WHERE id = ${id}::uuid`);
    }
    for (const [index, raw] of scalarPayloads.entries()) {
      await db.execute(sql`INSERT INTO heartbeat_run_events (org_id,agent_id,run_id,seq,event_type,payload,created_at)
        VALUES (${orgId}::uuid,${agentId}::uuid,${queuedId}::uuid,${index + 1},'scalar.payload',${raw}::jsonb,${early.toISOString()}::timestamptz)`);
    }

    await db.insert(agents).values([
      {id:fallbackAgent,orgId,name:"Fallback agent",status:"idle",agentRuntimeType:"process"},
      {id:terminatedAgent,orgId,name:"Terminated agent",status:"terminated",agentRuntimeType:"process"},
    ]);
    await db.insert(issues).values([
      {id:olderFallbackIssue,orgId,title:"Latest candidate is another issue",status:"in_progress",assigneeAgentId:fallbackAgent},
      {id:newerFallbackIssue,orgId,title:"Latest candidate matches",status:"in_progress",assigneeAgentId:fallbackAgent},
      {id:pendingIssue,orgId,title:"Terminal effects remain",status:"in_progress",executionRunId:pendingIds[0]},
      {id:finishedIssue,orgId,title:"Terminal run is complete",status:"done",executionRunId:recentIds[0]},
    ]);
    await db.insert(heartbeatRuns).values([
      {id:olderFallbackRun,orgId,agentId:fallbackAgent,status:"running",contextSnapshot:{issueId:olderFallbackIssue},startedAt:early,createdAt:early},
      {id:newerFallbackRun,orgId,agentId:fallbackAgent,status:"running",contextSnapshot:{issueId:` \uFEFF${newerFallbackIssue}\uFEFF `},startedAt:later,createdAt:later},
      {id:terminatedRun,orgId,agentId:terminatedAgent,status:"succeeded",createdAt:new Date(later.getTime()+3600_000)},
    ]);
    await db.update(heartbeatRuns).set({resultSummaryJson:{summary:"a".repeat(499)+"😀",costUsd:"0x10",provider:"local"}}).where(eq(heartbeatRuns.id,queuedId));
    const deepStdout = `{"type":"result","result":"Deep provider result", "ignored":${"[".repeat(700)}0${"]".repeat(700)}}`;
    await db.update(heartbeatRuns).set({resultSummaryJson:{stdout:deepStdout}}).where(eq(heartbeatRuns.id,terminatedRun));
    await db.insert(projects).values({ id: projectId, orgId, name: "Read fixture" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, orgId, projectId, mode: "isolated", strategyType: "worktree", name: "Fixture" });
    await db.execute(sql`UPDATE heartbeat_runs SET context_snapshot = ${JSON.stringify({ issueId, executionWorkspaceId: ` \uFEFF${workspaceId.toUpperCase()}\uFEFF `, scene: "delegation", delegationTask: "PRIVATE_DELEGATION", sourceAgentId: "PRIVATE_SOURCE", targetAgentId: "PRIVATE_TARGET", taskKey: "PRIVATE_TASK", resumeSessionDisplayId: "PRIVATE_SESSION", resumeSessionParams: { private: true }, forceFreshSession: true, sessionResumeSuppressed: true, publicPath: "/home/native-user/repo", sourceRunId: "context-source", wakeupRequestId: "context-wake", nested: { name: "native-user", token: "plain-public-context-token" } })}::jsonb WHERE id=${runningId}::uuid`);
    const privateDeep = `${"[".repeat(700)}"PRIVATE_DEEP"${"]".repeat(700)}`;
    const publicDeep = `${"[".repeat(700)}{"number":9007199254740993,"name":"native-user","__proto__":{"hidden":"value"}}${"]".repeat(700)}`;
    await db.execute(sql`UPDATE heartbeat_runs SET session_params_before_json=${privateDeep}::jsonb, terminal_effects_json=${privateDeep}::jsonb,
      context_snapshot=context_snapshot || jsonb_build_object('resumeSessionParams',${privateDeep}::jsonb,'publicDeep',${publicDeep}::jsonb),
      result_json=${`{"public":${publicDeep},"result":"native-user"}`}::jsonb WHERE id=${runningId}::uuid`);
    await db.update(issues).set({ executionRunId: runningId, status: "in_progress", assigneeAgentId: agentId }).where(eq(issues.id,issueId));
    await db.insert(workspaceOperations).values([
      { id:randomUUID(),orgId,executionWorkspaceId:workspaceId,heartbeatRunId:runningId,phase:"setup",status:"succeeded",command:"echo native-user",cwd:"/home/native-user/repo",metadata:{name:"native-user"},startedAt:early,createdAt:early },
      { id:randomUUID(),orgId,executionWorkspaceId:workspaceId,heartbeatRunId:null,phase:"cleanup",status:"succeeded",startedAt:later,createdAt:later },
      { id:randomUUID(),orgId:foreignOrgId,heartbeatRunId:foreignRunId,phase:"setup",status:"succeeded",command:"FOREIGN_OPERATION" },
    ]);
    await db.insert(heartbeatRunEvents).values([
      {orgId,agentId,runId:runningId,seq:1,eventType:"adapter.invoke",createdAt:early,payload:{ usedSkills:[{key:"skill/a"},{key:"skill/b",runtimeName:"Friendly B"}],loadedSkills:[{key:"unused"}] }},
      {orgId,agentId,runId:runningId,seq:2,eventType:"adapter.skill_usage",createdAt:later,payload:{ usedSkills:[{key:"skill/a",name:"Friendly A"},{key:"skill/c"},{key:"skill/b",name:"Do not replace"}] }},
      {orgId,agentId,runId:runningId,seq:3,eventType:"issue.execution_released",payload:{hidden:"HIDDEN_EVENT"}},
      {orgId,agentId,runId:runningId,seq:4,eventType:"runtime.status",message:"native-user",payload:{apiKey:"PRIVATE_API_KEY",nested:{authorization:{type:"plain",value:"PRIVATE_TOKEN",extra:"PRIVATE_EXTRA"},cookie:{type:"secret_ref",secretId:"ref-1",path:"/home/native-user"},safe:"native-user",jwt:"abc.def.ghi"},array:[{password:"PRIVATE_PASSWORD"}],nativeKey:{type:"plain",value:"native-user",extra:"PLAIN_EXTRA"}}},
      ...Array.from({length:1007},(_,index)=>({orgId,agentId,runId:runningId,seq:index+5,eventType:"stdout",message:`event ${index}`,payload:{n:index},createdAt:later})),
    ]);
    await db.execute(sql`UPDATE heartbeat_run_events SET payload=payload || jsonb_build_object('deep',${publicDeep}::jsonb) WHERE run_id=${runningId}::uuid AND seq=4`);
    await db.insert(instanceSettings).values({singletonKey:"default",general:{censorUsernameInLogs:true},createdAt:early,updatedAt:later});
    legacy=heartbeatService(db);
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

  async function assertResponse(url: string, expected: unknown, token = agentToken, target = server!) {
    const before = receipts.length;
    const result = await get(url, token, target);
    expect(result.status, `${url}: ${result.text.slice(0, 1000)}`).toBe(200);
    expect(result.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(result.body).toEqual(wire(expected));
    if (target === server) {
      expect(receipts).toHaveLength(before + 1);
      expect(receipts[before]).toMatchObject({ outcome: "response", status: 200, responseSha256: sha256(result.text) });
    }
    return result;
  }

  it("moves both org lists and overview with complete legacy field, summary, provenance and skill parity", async () => {
    for (const [surface, transform] of [["heartbeat-runs", (runs: any[]) => runs], ["agent-runs", toAgentRuns]] as const) {
      for (const [query, agent, limit, filters] of [
        ["", undefined, 100, {}],
        ["?limit=2", undefined, 2, {}],
        ["?limit=-10", undefined, 1, {}],
        ["?limit=garbage", undefined, 100, {}],
        ["?limit=3suffix", undefined, 3, {}],
        [`?agentId=${agentId}`, agentId, 100, {}],
        [`?goalId=${otherGoalId}`, undefined, 100, {goalId:otherGoalId}],
        ["?goalId=bad&startDate=bad&endDate=bad", undefined, 100, {}],
        [`?startDate=${encodeURIComponent(early.toISOString())}&endDate=${encodeURIComponent(later.toISOString())}`, undefined, undefined, {startDate:early,endDate:later}],
      ] as const) {
        await assertResponse(`/api/orgs/${orgId}/${surface}${query}`,transform(await legacy.list(orgId,agent,limit,filters)));
      }
      await assertResponse(`/api/orgs/${emptyOrgId}/${surface}`,[],boardToken);
    }
    const overview = await legacy.overview(orgId);
    await assertResponse(`/api/orgs/${orgId}/agent-runs/overview`, {latestByAgent:toAgentRuns(overview.latestByAgent),recent:toAgentRuns(overview.recent)},boardToken);
    const withSkills=await get(`/api/orgs/${orgId}/agent-runs?agentId=${agentId}`);
    expect(withSkills.body.find((row:any)=>row.id===runningId).resultJson).toMatchObject({usedSkillKeys:["skill/a","skill/b","skill/c"],usedSkills:[{key:"skill/a",name:"Friendly A",runtimeName:"Friendly A"},{key:"skill/b",name:"Friendly B",runtimeName:"Friendly B"},{key:"skill/c",name:"c",runtimeName:"c"}]});
  }, 30_000);

  it("retains unbounded date windows, 1000 explicit cap, tied-ID ordering, and responses beyond 256 KiB", async () => {
    const all=await legacy.list(volumeOrgId,undefined,undefined,{startDate:early});
    expect(all).toHaveLength(1105);
    const response=await assertResponse(`/api/orgs/${volumeOrgId}/agent-runs?startDate=${encodeURIComponent(early.toISOString())}`,toAgentRuns(all),boardToken);
    expect(Buffer.byteLength(response.text)).toBeGreaterThan(256*1024);
    await assertResponse(`/api/orgs/${volumeOrgId}/agent-runs?limit=5000`,toAgentRuns(await legacy.list(volumeOrgId,undefined,1000)),boardToken);
  },30_000);

  it("preserves both detail aliases and scoped short references without exposing 700-level private JSON", async () => {
    const run=await legacy.getRun(runningId);
    for (const [surface,transform] of [["heartbeat-runs",toHeartbeatRun],["agent-runs",toAgentRun]] as const) {
      await assertResponse(`/api/${surface}/${contextRunIds[3]}`,redactCurrentUserValue(transform(await legacy.getRun(contextRunIds[3]!) as any),redaction));
      for (const ref of [runningId,`run_${runningId.replaceAll("-","").slice(0,8)}`,runningId.replaceAll("-","").slice(0,12)]) {
        const response=await assertResponse(`/api/${surface}/${ref}`,redactCurrentUserValue(transform(run as any),redaction));
        expect(response.text).not.toMatch(/PRIVATE_DEEP|PRIVATE_SESSION|PRIVATE_DELEGATION|PRIVATE_SOURCE|PRIVATE_TARGET|PRIVATE_TASK|executionOwnerToken|terminalEffectsJson|sessionParamsBeforeJson/);
      }
    }
  });

  it("keeps event pagination, hidden-event exclusion, and deep secret/current-user redaction in Rust", async () => {
    for (const surface of ["heartbeat-runs","agent-runs"]) {
      for (const [afterSeq,limit] of [[0,200],[3,2],[2,1000],[10000,10],[0,-1],[0,9999]]) {
        const expected=(await legacy.listEvents(runningId,afterSeq,limit)).map((event)=>redactCurrentUserValue({...event,payload:redactEventPayload(event.payload)},redaction));
        const response=await assertResponse(`/api/${surface}/${runningId}/events?afterSeq=${afterSeq}&limit=${limit}`,expected);
        expect(response.text).not.toMatch(/PRIVATE_API_KEY|PRIVATE_PASSWORD|PRIVATE_TOKEN|HIDDEN_EVENT|PLAIN_EXTRA|PRIVATE_EXTRA/);
      }
    }
  },30_000);

  it("preserves root scalar event payload truthiness on both aliases with censoring enabled and disabled", async () => {
    const [settings] = await db!.select().from(instanceSettings);
    try {
      for (const enabled of [true, false]) {
        await db!.update(instanceSettings).set({ general: { ...settings!.general, censorUsernameInLogs: enabled } }).where(eq(instanceSettings.id, settings!.id));
        const before = await databaseSnapshot();
        const expected = (await legacy.listEvents(queuedId, 0, 100)).map(event =>
          redactCurrentUserValue({ ...event, payload: redactEventPayload(event.payload) }, { ...redaction, enabled }));
        expect(expected).toHaveLength(scalarPayloads.length);
        expect(expected.slice(0, 7).map(event => event.payload)).toEqual(Array(7).fill(null));
        const duplicateResults = expected.slice(-duplicatePayloadTexts.length).map(event => wire(event.payload));
        const masked = enabled ? "n**********" : "native-user";
        expect(duplicateResults).toEqual([
          { safe: masked }, { safe: "native-user" },
          { nested: { safe: masked }, safe: masked },
          { nested: { safe: "native-user" }, safe: masked },
          { safe: masked },
        ]);

        for (const surface of ["heartbeat-runs", "agent-runs"]) {
          await assertResponse(`/api/${surface}/${queuedId}/events`, expected);
        }
        expect(await databaseSnapshot()).toEqual(before);
      }
    } finally {
      await db!.update(instanceSettings).set({ general: settings!.general }).where(eq(instanceSettings.id, settings!.id));
    }
  }, 30_000);

  it("preserves lossless UTF16 redaction on both event aliases and across response chunks", async () => {
    const [settings] = await db!.select().from(instanceSettings);
    const address = server!.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP listener");
    try {
      for (const enabled of [true, false]) {
        await db!.update(instanceSettings).set({ general: { ...settings!.general, censorUsernameInLogs: enabled } }).where(eq(instanceSettings.id, settings!.id));
        const before = await databaseSnapshot();
        const expected = wire((await legacy.listEvents(queuedId, 0, 100)).map(event =>
          redactCurrentUserValue({ ...event, payload: redactEventPayload(event.payload) }, { ...redaction, enabled })));
        for (const surface of ["heartbeat-runs", "agent-runs"]) {
          const receiptIndex = receipts.length;
          const response = await fetch(`http://127.0.0.1:${address.port}/api/${surface}/${queuedId}/events`, {
            headers: { authorization: `Bearer ${agentToken}` },
          });
          expect(response.status).toBe(200);
          const reader = response.body!.getReader();
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let text = "";
          let networkChunks = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            networkChunks += 1;
            // Also deliberately split complete UTF-8 characters and JSON
            // escapes while consuming the actual multi-chunk HTTP response.
            for (let offset = 0; offset < value.length; offset += 127) {
              text += decoder.decode(value.subarray(offset, offset + 127), { stream: true });
            }
          }
          text += decoder.decode();
          expect(networkChunks).toBeGreaterThan(1);
          expect(Buffer.byteLength(text)).toBeGreaterThan(256 * 1024);
          expect(JSON.parse(text)).toEqual(expected);
          expect(text).not.toMatch(/TOP_SECRET|NESTED_SECRET|ARRAY_SECRET|DISCARDED_SECRET|PADDED_SECRET/);
          const firstUtf16 = scalarPayloads.length - duplicatePayloadTexts.length - utf16PayloadTexts.length;
          const payload = JSON.parse(text)[firstUtf16].payload;
          expect(payload["password\ud800"]).toBe("***REDACTED***");
          expect(payload.safe).toBe(`${enabled ? "n**********" : "native-user"}\ud800`);
          expect(receipts).toHaveLength(receiptIndex + 1);
          expect(receipts[receiptIndex]).toMatchObject({ outcome: "response", status: 200, responseSha256: sha256(text) });
        }
        expect(await databaseSnapshot()).toEqual(before);
      }
    } finally {
      await db!.update(instanceSettings).set({ general: settings!.general }).where(eq(instanceSettings.id, settings!.id));
    }
  }, 30_000);

  it("projects raw JSONB underflow, zero, subnormal and overflow contexts like JS on both list and detail aliases", async () => {
    for (const [surface, transform, transformMany] of [
      ["heartbeat-runs", toHeartbeatRun, (runs: any[]) => runs],
      ["agent-runs", toAgentRun, toAgentRuns],
    ] as const) {
      const response = await assertResponse(`/api/orgs/${orgId}/${surface}?limit=1000`, transformMany(await legacy.list(orgId, undefined, 1000)));
      for (const { id, raw } of numericContexts) {
        const expectedContext = Number(raw) === 0 ? null : {};
        expect(response.body.find((run: any) => run.id === id).contextSnapshot).toEqual(expectedContext);
        const expected = redactCurrentUserValue(transform(await legacy.getRun(id) as any), redaction);
        expect(expected.contextSnapshot).toEqual(expectedContext);
        await assertResponse(`/api/${surface}/${id}`, expected);
      }
    }
  }, 30_000);

  it("keeps workspace-linked cleanup operations, sort order and both aliases", async () => {
    const expected=redactCurrentUserValue(await workspaceOperationService(db!).listForRun(runningId,workspaceId),redaction);
    expect(expected).toHaveLength(2);
    for (const surface of ["heartbeat-runs","agent-runs"]) {
      await assertResponse(`/api/${surface}/${runningId}/workspace-operations`,expected);
      await assertResponse(`/api/${surface}/${queuedId}/workspace-operations`,[]);
    }
  });

  it("selects active issue runs for UUID/current/old aliases and preserves null",async()=>{
    const run=await legacy.getRun(runningId);
    const expected={...redactCurrentUserValue(toHeartbeatRun(run as any),redaction),agentId,agentName:"Release verifier ☃",agentRuntimeType:"process"};
    for(const ref of [issueId,"RUN-1","old-1"]) await assertResponse(`/api/issues/${ref}/active-run`,expected);
    await assertResponse(`/api/issues/${emptyIssueId}/active-run`,null);
  });

  it("preserves pinned pending terminals and selects the newest fallback before checking its issue",async()=>{
    await assertResponse(`/api/issues/${olderFallbackIssue}/active-run`,null);
    await assertResponse(`/api/issues/${finishedIssue}/active-run`,null);
    for(const [issue,runId,name,id] of [[newerFallbackIssue,newerFallbackRun,"Fallback agent",fallbackAgent],[pendingIssue,pendingIds[0]!,"Release verifier ☃",agentId]] as const) {
      const run=await legacy.getRun(runId);
      await assertResponse(`/api/issues/${issue}/active-run`,{...redactCurrentUserValue(toHeartbeatRun(run as any),redaction),agentId:id,agentName:name,agentRuntimeType:"process"});
    }
    const overview=await get(`/api/orgs/${orgId}/agent-runs/overview`);
    expect(overview.body.latestByAgent.some((run:any)=>run.agentId===terminatedAgent)).toBe(false);
    expect(overview.body.recent.some((run:any)=>run.id===terminatedRun)).toBe(true);
  });

  it("preserves database errors for malformed UUIDs and fractional event paging",async()=>{
    const malformed="-".repeat(36);
    expect((await get(`/api/orgs/${orgId}/agent-runs?goalId=${malformed}`)).status).toBe(500);
    for(const [after,limit] of [[1.5,10],[0,1.5],[1e30,10]]) {
      await expect(legacy.listEvents(runningId,after,limit)).rejects.toThrow();
      const result=await get(`/api/agent-runs/${runningId}/events?afterSeq=${encodeURIComponent(String(after))}&limit=${limit}`);
      expect(result.status).toBe(500);
      expect(result.body).toEqual({error:"Internal server error"});
    }
  });

  it("rejects unauthenticated/cross-org/missing targets before signed native dispatch",async()=>{
    const before=receipts.length;
    const own=[`/api/orgs/${orgId}/heartbeat-runs`,`/api/orgs/${orgId}/agent-runs`,`/api/orgs/${orgId}/agent-runs/overview`,...['heartbeat-runs','agent-runs'].flatMap(surface=>['','/events','/workspace-operations'].map(suffix=>`/api/${surface}/${runningId}${suffix}`)),`/api/issues/${issueId}/active-run`];
    for(const url of own) expect((await request(server!).get(url)).status).toBe(401);
    const foreign=[`/api/orgs/${foreignOrgId}/heartbeat-runs`,`/api/orgs/${foreignOrgId}/agent-runs`,`/api/orgs/${foreignOrgId}/agent-runs/overview`,...['heartbeat-runs','agent-runs'].flatMap(surface=>['','/events','/workspace-operations'].map(suffix=>`/api/${surface}/${foreignRunId}${suffix}`)),`/api/issues/${foreignIssueId}/active-run`];
    for(const token of [agentToken,boardToken]) for(const url of foreign) expect((await get(url,token)).status).toBe(403);
    for(const surface of ['heartbeat-runs','agent-runs']) for(const suffix of ['','/events','/workspace-operations']) expect((await get(`/api/${surface}/${randomUUID()}${suffix}`)).status).toBe(404);
    expect(receipts).toHaveLength(before);
  },30_000);

  it("returns actual native startup failures as 503 while Node remains alive, with no domain fallback",async()=>{
    const bad=createRustFoundationBridge({databaseUrl:connectionString,binaryPath:path.join(home,"missing-foundation"),mode:"off",organizationBrandingMode:"off",projectGoalSetMode:"off",requestTimeoutMs:1000});
    const urls=[`/api/orgs/${orgId}/heartbeat-runs`,`/api/orgs/${orgId}/agent-runs`,`/api/orgs/${orgId}/agent-runs/overview`,...['heartbeat-runs','agent-runs'].flatMap(surface=>['','/events','/workspace-operations'].map(suffix=>`/api/${surface}/${runningId}${suffix}`)),`/api/issues/${issueId}/active-run`];
    for(const selected of [undefined,instrument(bad)]) {
      const failed=await startApp(selected);
      try {for(const url of urls){const response=await get(url,agentToken,failed);expect(response.status,response.text).toBe(503);expect(response.body).toEqual({error:"Rust run reads are unavailable"});}
        expect(failed.listening).toBe(true);
      } finally {await closeServer(failed);await bad.close();}
    }
    await assertResponse(`/api/orgs/${orgId}/heartbeat-runs`,await legacy.list(orgId,undefined,100));
  },30_000);

  it("keeps the public Node server alive across a real native shutdown and recovers without a fallback",async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"rudder-run-outage-"));
    const executable=path.join(root,path.basename(nativeBinary));
    fs.symlinkSync(nativeBinary,executable);
    const native=createRustFoundationBridge({databaseUrl:connectionString,binaryPath:executable,mode:"off",organizationBrandingMode:"off",projectGoalSetMode:"off",requestTimeoutMs:1000});
    const app=await startApp(instrument(native));
    const url=`/api/orgs/${orgId}/agent-runs?limit=2`;
    const expected=toAgentRuns(await legacy.list(orgId,undefined,2));
    try {
      await assertResponse(url,expected,agentToken,app);
      await native.close();
      fs.unlinkSync(executable);
      const failed=await get(url,agentToken,app);
      expect(failed.status).toBe(503);
      expect(failed.body).toEqual({error:"Rust run reads are unavailable"});
      expect(app.listening).toBe(true);
      expect((await request(app).get(url)).status).toBe(401);
      fs.symlinkSync(nativeBinary,executable);
      await assertResponse(url,expected,agentToken,app);
    } finally {await closeServer(app);await native.close();fs.rmSync(root,{recursive:true,force:true});}
  },20_000);

  it("prints exact native binary and authenticated dispatch evidence for all 10 migrated public routes",()=>{
    expect(new Set(receipts.filter(r=>r.status===200).map(r=>r.input.operation))).toEqual(new Set(["list","overview","detail","events","workspaceOperations","active"]));
    console.info("RUN_READ_NATIVE_DISPATCH_RECEIPT",JSON.stringify({binaryPath:nativeBinary,binarySha256:sha256(fs.readFileSync(nativeBinary)),databaseKind:"disposable-migrated-embedded-postgres",domainFingerprint:sha256(JSON.stringify(baselineDatabase)),readOnly:true,publicRoutes:10,receipts}));
  });
  it("reads missing or invalid redaction settings without creating or repairing any row",async()=>{
    const saved=await db!.select().from(instanceSettings);
    const run=await legacy.getRun(runningId);
    try {
      await db!.delete(instanceSettings);
      const noSettings=await databaseSnapshot();
      await assertResponse(`/api/agent-runs/${runningId}`,redactCurrentUserValue(toAgentRun(run as any),{enabled:false}));
      expect(await databaseSnapshot()).toEqual(noSettings);
      await db!.insert(instanceSettings).values(saved.map(row=>({...row,general:{censorUsernameInLogs:true,unknown:true}})));
      const invalidSettings=await databaseSnapshot();
      await assertResponse(`/api/agent-runs/${runningId}`,redactCurrentUserValue(toAgentRun(run as any),{enabled:false}));
      expect(await databaseSnapshot()).toEqual(invalidSettings);
    } finally {await db!.delete(instanceSettings);await db!.insert(instanceSettings).values(saved);}
  });

  it("serves all 10 reads through normal production API bootstrap with every pilot off",async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"rudder-run-bootstrap-"));
    const isolated:Record<string,string|undefined>={RUDDER_HOME:root,RUDDER_CONFIG:path.join(root,"config.json"),RUDDER_LOG_DIR:path.join(root,"logs"),RUN_LOG_BASE_PATH:path.join(root,"run-logs"),RUDDER_ORGANIZATION_WORKSPACE_HOME:path.join(root,"workspaces"),RUDDER_STORAGE_LOCAL_DISK_BASE_DIR:path.join(root,"storage"),RUDDER_RUST_ORGANIZATION_BRANDING_ORG_IDS:undefined,RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS:undefined};
    const previous=Object.fromEntries(Object.keys(isolated).map(key=>[key,process.env[key]]));
    for(const [key,value] of Object.entries(isolated)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    let handle:import("../app.js").RudderAppHandle|undefined;
    let app:Server|undefined;
    try {
      const {createRudderApp}=await import("../app.js");
      const {createStorageService}=await import("../storage/service.js");
      const {createLocalDiskStorageProvider}=await import("../storage/local-disk-provider.js");
      await bridge!.close();
      const port=await getAvailablePort();
      handle=await createRudderApp(db!,{uiMode:"none",serverPort:port,
        storageService:createStorageService(createLocalDiskStorageProvider(path.join(root,"storage"))),
        deploymentMode:"authenticated",deploymentExposure:"private",authRequirement:"required",localRuntimeTrust:"untrusted",
        allowedHostnames:["127.0.0.1","localhost"],bindHost:"127.0.0.1",authReady:true,companyDeletionEnabled:false,
        databaseUrl:connectionString,rustFoundationBinaryPath:nativeBinary,rustFoundationMode:"off",rustOrganizationBrandingMode:"off",rustProjectGoalSetMode:"off",
        instanceId:"run-normal-bootstrap-test",localEnv:"e2e",mcpHostEnv:{},mcpDeploymentAllowlists:{httpOrigins:[],stdioCommands:[],stdioWorkingDirectories:[],stdioEnvironmentNames:[]}});
      app=handle.app.listen(port,"127.0.0.1");await once(app,"listening");
      const before=await databaseSnapshot();
      const run=await legacy.getRun(runningId);
      const overview=await legacy.overview(orgId);
      const operations=await workspaceOperationService(db!).listForRun(runningId,workspaceId);
      const normalRedaction={enabled:true};
      const events=await legacy.listEvents(runningId,0,2);
      const cases:Array<[string,unknown]>=[
        [`/api/orgs/${orgId}/heartbeat-runs?limit=2`,await legacy.list(orgId,undefined,2)],
        [`/api/orgs/${orgId}/agent-runs?limit=2`,toAgentRuns(await legacy.list(orgId,undefined,2))],
        [`/api/orgs/${orgId}/agent-runs/overview`,{latestByAgent:toAgentRuns(overview.latestByAgent),recent:toAgentRuns(overview.recent)}],
        [`/api/issues/${issueId}/active-run`,{...redactCurrentUserValue(toHeartbeatRun(run as any),normalRedaction),agentId,agentName:"Release verifier ☃",agentRuntimeType:"process"}],
      ];
      for(const [surface,transform] of [["heartbeat-runs",toHeartbeatRun],["agent-runs",toAgentRun]] as const) {
        cases.push([`/api/${surface}/${runningId}`,redactCurrentUserValue(transform(run as any),normalRedaction)],
          [`/api/${surface}/${runningId}/events?limit=2`,events.map(event=>redactCurrentUserValue({...event,payload:redactEventPayload(event.payload)},normalRedaction))],
          [`/api/${surface}/${runningId}/workspace-operations`,redactCurrentUserValue(operations,normalRedaction)]);
      }
      expect(cases).toHaveLength(10);
      for(const token of [agentToken,boardToken])for(const [url,expected]of cases)await assertResponse(url,expected,token,app);
      expect(await databaseSnapshot()).toEqual(before);
      baselineDatabase=before;
      console.info("RUN_READ_NORMAL_BOOTSTRAP_RECEIPT",JSON.stringify({binaryPath:nativeBinary,binarySha256:sha256(fs.readFileSync(nativeBinary)),entry:"createRudderApp -> registerApiRoutes -> agentRoutes",allPilotModes:"off",readOnly:true,publicRoutes:cases.map(([url])=>url),actors:["agent_key","board_key"]}));
    } finally {
      await closeServer(app);await handle?.close();
      for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
      fs.rmSync(root,{recursive:true,force:true});
    }
  },45_000);

  it("isolates SideChat Run reads by signed human owner, including markers, aliases and orphaned runs", async () => {
    const otherUser = `run-privacy-other-${randomUUID()}`;
    const otherToken = `run-privacy-token-${randomUUID()}`;
    const ownerConversationIds = Array.from({ length: 5 }, () => randomUUID());
    const regularConversation = randomUUID();
    const foreignConversation = randomUUID();
    const otherConversation = randomUUID();
    const conversationIds = [...ownerConversationIds, regularConversation, foreignConversation, otherConversation];
    // A private and a public run deliberately share the same typed short prefix.
    const privateId = "fa121234-abcd-4000-8000-000000000001";
    const publicId = "fa121234-abcd-4000-8000-000000000002";
    const ownedIds = [privateId, ...Array.from({ length: 4 }, () => randomUUID())];
    const orphanId = randomUUID();
    const contradictoryId = randomUUID();
    const foreignLinkedId = randomUUID();
    const otherId = randomUUID();
    const privacyAgentId = randomUUID();
    const privateOperationId = randomUUID();
    const unboundOperationId = randomUUID();
    const ids = [...ownedIds, publicId, orphanId, contradictoryId, foreignLinkedId, otherId];
    const originalIssue = (await db!.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    const logBase = path.join(resolveRudderInstanceRoot(), "data", "workspace-operation-logs");
    const runLogBase = path.join(resolveRudderInstanceRoot(), "data", "run-logs");
    const createdLogPaths: string[] = [];
    try {
      await db!.insert(authUsers).values({ id: otherUser, name: "Other private reader", email: `${otherUser}@example.test`, createdAt: early, updatedAt: later });
      await db!.insert(organizationMemberships).values({ orgId, principalType: "user", principalId: otherUser, status: "active", membershipRole: "member" });
      await db!.insert(boardApiKeys).values({ userId: otherUser, name: "Other private reader", keyHash: sha256(otherToken) });
      await db!.insert(agents).values({ id: privacyAgentId, orgId, name: "Private run fixture", role: "general", status: "idle" });
      await db!.insert(chatConversations).values([
        ...ownerConversationIds.map(id => ({ id, orgId, conversationKind: "side_chat", createdByUserId: boardUserId })),
        { id: regularConversation, orgId, conversationKind: "chat", createdByUserId: boardUserId },
        { id: foreignConversation, orgId: foreignOrgId, conversationKind: "side_chat", createdByUserId: boardUserId },
        { id: otherConversation, orgId, conversationKind: "side_chat", createdByUserId: otherUser },
      ]);
      const now = new Date("2030-01-01T00:00:00.000Z");
      const base = { orgId, agentId: privacyAgentId, status: "running", createdAt: now, startedAt: now, contextSnapshot: { issueId } };
      const columnMarker = {
        scene: "side_chat", targetType: "chat_conversation", targetId: ownerConversationIds[0],
        idempotencyKey: `private-marker-${randomUUID()}`, sessionReuseScope: "none",
        sessionIntentJson: { kind: "fresh", reuseScope: "none", sourceRunId: null, sessionId: null, sessionParams: null },
      };
      await db!.insert(heartbeatRuns).values([
        { ...base, ...columnMarker, id: ownedIds[0], chatConversationId: ownerConversationIds[0], contextSnapshot: { issueId, executionWorkspaceId: workspaceId }, stdoutExcerpt: "PRIVATE_OWNER_PAYLOAD" },
        { ...base, id: ownedIds[1], chatConversationId: ownerConversationIds[1], contextSnapshot: { issueId, scene: "side_chat" } },
        { ...base, id: ownedIds[2], chatConversationId: ownerConversationIds[2], contextSnapshot: { issueId, rudderScene: "side_chat" } },
        { ...base, id: ownedIds[3], chatConversationId: ownerConversationIds[3], contextSnapshot: { issueId, unifiedAgentRun: { scene: "side_chat" } } },
        { ...base, id: ownedIds[4], chatConversationId: ownerConversationIds[4], contextSnapshot: { issueId, scene: "chat" } },
        { ...base, id: orphanId, contextSnapshot: { issueId, scene: "side_chat" } },
        { ...base, id: contradictoryId, chatConversationId: regularConversation, contextSnapshot: { issueId, scene: "side_chat" } },
        { ...base, id: foreignLinkedId, chatConversationId: foreignConversation },
        { ...base, id: otherId, chatConversationId: otherConversation },
        { ...base, id: publicId, createdAt: new Date(now.getTime() - 1000), contextSnapshot: { issueId, public: true } },
      ]);
      await db!.insert(heartbeatRunEvents).values({ orgId, agentId: privacyAgentId, runId: privateId, seq: 1, eventType: "adapter.output", payload: { text: "PRIVATE_EVENT_PAYLOAD" } });
      await db!.insert(workspaceOperations).values([
        { id: privateOperationId, orgId, heartbeatRunId: privateId, phase: "test", status: "succeeded", stdoutExcerpt: "PRIVATE_OPERATION_PAYLOAD" },
        { id: unboundOperationId, orgId, executionWorkspaceId: workspaceId, phase: "cleanup", status: "succeeded", stdoutExcerpt: "PRIVATE_UNBOUND_CLEANUP" },
      ]);
      const runLogStore = getRunLogStore();
      const runLogHandle = await runLogStore.begin({ orgId, agentId: privacyAgentId, runId: privateId });
      const runLogPath = path.join(runLogBase, runLogHandle.logRef);
      createdLogPaths.push(runLogPath);
      await runLogStore.append(runLogHandle, { stream: "stdout", chunk: "PRIVATE_RUN_FILE_SENTINEL", ts: now.toISOString() });
      await db!.update(heartbeatRuns).set({ logStore: runLogHandle.store, logRef: runLogHandle.logRef, logBytes: fs.statSync(runLogPath).size }).where(eq(heartbeatRuns.id, privateId));
      for (const surface of ["heartbeat-runs", "agent-runs"]) {
        const ownerLog = await get(`/api/${surface}/${privateId}/log`, boardToken);
        expect(ownerLog.status, ownerLog.text).toBe(200);
        expect(ownerLog.body.content).toContain("PRIVATE_RUN_FILE_SENTINEL");
        for (const token of [otherToken, agentToken]) {
          const hiddenLog = await get(`/api/${surface}/${privateId}/log`, token);
          expect(hiddenLog.status, hiddenLog.text).toBe(404);
          expect(hiddenLog.text).not.toContain("PRIVATE_RUN_FILE_SENTINEL");
        }
      }
      const logStore = getWorkspaceOperationLogStore();
      for (const [operationId, sentinel] of [[privateOperationId, "PRIVATE_BOUND_FILE_SENTINEL"], [unboundOperationId, "PRIVATE_UNBOUND_FILE_SENTINEL"]] as const) {
        const handle = await logStore.begin({ orgId, operationId });
        createdLogPaths.push(path.join(logBase, handle.logRef));
        await logStore.append(handle, { stream: "stdout", chunk: sentinel, ts: now.toISOString() });
        const summary = await logStore.finalize(handle);
        await db!.update(workspaceOperations).set({ logStore: handle.store, logRef: handle.logRef, logBytes: summary.bytes, logSha256: summary.sha256 }).where(eq(workspaceOperations.id, operationId));
        const ownerLog = await get(`/api/workspace-operations/${operationId}/log`, boardToken);
        expect(ownerLog.status, ownerLog.text).toBe(200);
        expect(ownerLog.body.content).toContain(sentinel);
      }
      await db!.execute(sql`UPDATE issues SET execution_run_id=${privateId}::uuid WHERE id=${issueId}::uuid`);

      for (const [token, own, hidden] of [
        [boardToken, ownedIds, [orphanId, contradictoryId, foreignLinkedId, otherId]],
        [otherToken, [otherId], [...ownedIds, orphanId, contradictoryId, foreignLinkedId]],
        [agentToken, [], [...ownedIds, orphanId, contradictoryId, foreignLinkedId, otherId]],
      ] as const) {
        for (const suffix of ["heartbeat-runs?limit=1000", "agent-runs?limit=1000", "live-runs?minCount=20"]) {
          const result = await get(`/api/orgs/${orgId}/${suffix}&sideChatOwnerId=${boardUserId}`, token);
          expect(result.status, result.text).toBe(200);
          const returned = result.body.map((run: { id: string }) => run.id);
          expect(returned).toContain(publicId);
          for (const id of own) expect(returned).toContain(id);
          for (const id of hidden) expect(returned).not.toContain(id);
        }
        const issueLive = await get(`/api/issues/${issueId}/live-runs`, token);
        expect(issueLive.status, issueLive.text).toBe(200);
        for (const id of hidden) expect(issueLive.body.map((run: { id: string }) => run.id)).not.toContain(id);
        const overview = await get(`/api/orgs/${orgId}/agent-runs/overview`, token);
        expect(overview.status, overview.text).toBe(200);
        for (const id of hidden) expect(overview.text).not.toContain(id);
        const active = await get(`/api/issues/${issueId}/active-run`, token);
        expect(active.status, active.text).toBe(200);
        if (token === boardToken) expect(active.body.id).toBe(privateId);
        else expect(active.body).toBeNull();
      }
      for (const surface of ["heartbeat-runs", "agent-runs"]) {
        for (const suffix of ["", "/events", "/workspace-operations"]) {
          expect((await get(`/api/${surface}/${privateId}${suffix}`, boardToken)).status).toBe(200);
          for (const token of [otherToken, agentToken]) {
            const hidden = await get(`/api/${surface}/${privateId}${suffix}`, token);
            expect(hidden.status, hidden.text).toBe(404);
            expect(hidden.text).not.toContain("PRIVATE_");
          }
        }
        expect((await get(`/api/${surface}/${privateId}/log`, otherToken)).status).toBe(404);
      }
      for (const token of [otherToken, agentToken]) {
        for (const operationId of [privateOperationId, unboundOperationId]) {
          const hidden = await get(`/api/workspace-operations/${operationId}/log`, token);
          expect(hidden.status, hidden.text).toBe(404);
          expect(hidden.text).not.toContain("PRIVATE_");
        }
        const shared = await get(`/api/agent-runs/${runningId}/workspace-operations`, token);
        expect(shared.status, shared.text).toBe(200);
        expect(shared.text).not.toContain("PRIVATE_UNBOUND_CLEANUP");
      }
      const ownerActor = { type: "board" as const, source: "local_implicit" as const, userId: boardUserId };
      const agentActor = { type: "agent" as const, source: "agent_key" as const, agentId, orgId };
      expect((await bridge!.runRead!(ownerActor, orgId, { operation: "visibility", runId: privateId })).status).toBe(204);
      expect((await bridge!.runRead!(agentActor, orgId, { operation: "visibility", runId: privateId })).status).toBe(404);
      expect((await bridge!.runRead!(ownerActor, orgId, { operation: "workspaceOperationAccess", operationId: privateOperationId })).status).toBe(204);
      expect((await bridge!.runRead!(agentActor, orgId, { operation: "workspaceOperationAccess", operationId: unboundOperationId })).status).toBe(404);

      // Private latest activity must not suppress an older visible fallback.
      await db!.execute(sql`UPDATE issues SET execution_run_id=NULL, status='in_progress', assignee_agent_id=${privacyAgentId}::uuid WHERE id=${issueId}::uuid`);
      await db!.execute(sql`UPDATE heartbeat_runs SET status='succeeded' WHERE id=${otherId}::uuid`);
      await db!.execute(sql`UPDATE heartbeat_runs SET started_at=${new Date(now.getTime() + 10_000).toISOString()}::timestamptz WHERE id=${privateId}::uuid`);
      await db!.execute(sql`UPDATE heartbeat_runs SET started_at=${new Date(now.getTime() - 1000).toISOString()}::timestamptz WHERE id=${publicId}::uuid`);
      expect((await get(`/api/issues/${issueId}/active-run`, boardToken)).body.id).toBe(privateId);
      for (const token of [otherToken, agentToken]) {
        const selected = await get(`/api/issues/${issueId}/active-run`, token);
        expect(selected.status, selected.text).toBe(200);
        expect(selected.body.id).toBe(publicId);
      }

      // Prefix ambiguity sees only admitted identities, never a hidden match.
      const short = await get("/api/agent-runs/run_fa121234abcd", otherToken);
      expect(short.status, short.text).toBe(200);
      expect(short.body.id).toBe(publicId);
      for (const operation of ["detail", "events", "workspaceOperations"] as const) {
        const input = operation === "detail"
          ? { operation, surface: "agent" as const, runId: privateId, redaction: runReadRedaction(redaction) }
          : operation === "events"
            ? { operation, runId: privateId, afterSeq: 0, limit: 100, redaction: runReadRedaction(redaction) }
            : { operation, runId: privateId, redaction: runReadRedaction(redaction) };
        // A valid signed agent request bypasses Node reference admission here;
        // the Rust data authority must independently return the private 404.
        const direct = await bridge!.runRead!({ type: "agent", agentId, orgId, source: "agent_key" }, orgId, input);
        expect(direct.status).toBe(404);
      }
      // Deleting a private conversation clears its FK, but the retained marker
      // must continue hiding that run even from the former human owner.
      await db!.delete(chatConversations).where(inArray(chatConversations.id, [ownerConversationIds[0]!, ownerConversationIds[4]!]));
      for (const deletedId of [privateId, ownedIds[4]!]) {
        for (const token of [boardToken, otherToken, agentToken]) {
          expect((await get(`/api/agent-runs/${deletedId}`, token)).status).toBe(404);
          const live = await get(`/api/orgs/${orgId}/live-runs`, token);
          expect(live.status, live.text).toBe(200);
          expect(live.body.map((run: { id: string }) => run.id)).not.toContain(deletedId);
        }
      }
    } finally {
      await db!.execute(sql`UPDATE issues SET execution_run_id=${originalIssue.executionRunId}::uuid, status=${originalIssue.status}, assignee_agent_id=${originalIssue.assigneeAgentId}::uuid WHERE id=${issueId}::uuid`);
      await db!.delete(workspaceOperations).where(inArray(workspaceOperations.id, [privateOperationId, unboundOperationId]));
      await db!.delete(heartbeatRunEvents).where(inArray(heartbeatRunEvents.runId, ids));
      await db!.delete(heartbeatRuns).where(inArray(heartbeatRuns.id, ids));
      await db!.delete(chatConversations).where(inArray(chatConversations.id, conversationIds));
      await db!.delete(boardApiKeys).where(eq(boardApiKeys.userId, otherUser));
      await db!.delete(organizationMemberships).where(eq(organizationMemberships.principalId, otherUser));
      await db!.delete(authUsers).where(eq(authUsers.id, otherUser));
      await db!.delete(agents).where(eq(agents.id, privacyAgentId));
      for (const logPath of createdLogPaths) fs.rmSync(logPath, { force: true });
      // Remove only empty directories created by this disposable log fixture.
      for (const initial of [path.join(logBase, orgId), logBase, path.join(runLogBase, orgId, privacyAgentId), path.join(runLogBase, orgId), runLogBase]) {
        let directory = initial;
        while (directory.startsWith(`${home}${path.sep}`)
          && baselineFilesystem[path.relative(home, directory)] === undefined
          && fs.existsSync(directory) && fs.readdirSync(directory).length === 0) {
          fs.rmdirSync(directory);
          directory = path.dirname(directory);
        }
      }
    }
  }, 45_000);

});
