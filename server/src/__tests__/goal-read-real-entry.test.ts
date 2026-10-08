import {
  agentApiKeys, agents, applyPendingMigrations, approvals, assets, authUsers, automations, boardApiKeys, calendarEvents, costEvents,
  createDb, ensurePostgresDatabase,
  financeEvents,
  goalActivities, goalChangeProposals, goalFeedbackEntries,
  goalOwnerAssignments, goalPlans, goalResultProposals, goals,
  issues,
  organizationMemberships,
  organizations, projectGoals, projects,
} from "@rudderhq/db";
import { sql } from "drizzle-orm";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { goalRoutes } from "../routes/goals.js";
import { goalService, publicGoalActivity, publicGoalDetail, publicGoalView } from "../services/goals.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

// Requires the exact candidate's built binary, never a fake HTTP fixture.
// cargo build --locked --manifest-path native/Cargo.toml -p rudder-server-foundation --bin rudder-server-foundation
// RUDDER_SERVER_FOUNDATION_PATH=/path/to/candidate pnpm exec vitest run --root server --config vitest.config.ts src/__tests__/goal-read-real-entry.test.ts
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
async function port() {
  const server = net.createServer().listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); return address.port;
}

describe.each(["off", "required"] as const)("Goal reads through public HTTP, real Rust and PostgreSQL (ingress %s)", (ingress) => {
  let db: ReturnType<typeof createDb>;
  let database: { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
  let root = ""; let fixtureBinary = ""; let bridge: RustFoundationBridge; let server: Server; let target: Server | string;
  const orgId = randomUUID(); const foreignOrg = randomUUID(); const goalId = randomUUID(); const foreignGoal = randomUUID();
  const activeEmptyId = randomUUID(); const childId = randomUUID(); const agentId = randomUUID(); const foreignAgent = randomUUID(); const projectId = randomUUID();
  const assetId = randomUUID(); const foreignAsset = randomUUID(); const userId = `goal-user-${randomUUID()}`;
  const agentToken = `agent-${randomUUID()}`; const foreignToken = `foreign-${randomUUID()}`; const boardToken = `board-${randomUUID()}`;
  const instant = new Date("2026-10-08T02:03:04.567Z");
  const expected: Record<string, unknown> = {};
  let baseline: Record<string, unknown>;
  async function snapshot() {
    const result: Record<string, unknown> = {};
    for (const table of ["goals", "goal_activities", "goal_plans", "goal_owner_assignments", "goal_feedback_entries", "goal_change_proposals", "goal_result_proposals", "organization_mutation_state", "organization_mutation_receipts", "activity_log"]) {
      result[table] = (await db.execute(sql.raw(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS value FROM "${table}" t`)))[0]?.value;
    }
    return result;
  }
  function get(url: string, token = agentToken) { return request(target).get(url).set("authorization", `Bearer ${token}`); }
  beforeAll(async () => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const binaryTarget = path.resolve(repo, process.env.CARGO_TARGET_DIR ?? "native/target");
    const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
    const explicitBinary = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const candidates = explicitBinary ? [path.resolve(repo, explicitBinary)]
      : [path.join(binaryTarget, "debug", binaryName), path.join(binaryTarget, "release", binaryName)];
    const binary = candidates.find((candidate) => {
      try { fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
      catch { return false; }
    }) ?? candidates[0]!;
    fs.accessSync(binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-goal-read-entry-"));
    const dbPort = await port();
    const EmbeddedPostgres = (await import("embedded-postgres")).default;
    database = new EmbeddedPostgres({ databaseDir: root, user: "rudder", password: "rudder", port: dbPort, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-c", "unix_socket_directories=", "-c", "dynamic_shared_memory_type=mmap"], onLog: () => {}, onError: () => {} });
    await database.initialise(); await database.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${dbPort}/postgres`, "rudder");
    const url = `postgres://rudder:rudder@127.0.0.1:${dbPort}/rudder`;
    await applyPendingMigrations(url); db = createDb(url);
    await db.insert(organizations).values([{ id: orgId, name: "Goal read", urlKey: "goal-read", issuePrefix: "GR" }, { id: foreignOrg, name: "Other", urlKey: "goal-other", issuePrefix: "GO" }]);
    await db.insert(agents).values([{ id: agentId, orgId, name: "Owner", role: "engineer", status: "idle", adapterType: "process" }, { id: foreignAgent, orgId: foreignOrg, name: "Other", role: "engineer", status: "idle", adapterType: "process" }]);
    await db.insert(agentApiKeys).values([{ agentId, orgId, name: "test", keyHash: createHash("sha256").update(agentToken).digest("hex") }, { agentId: foreignAgent, orgId: foreignOrg, name: "test", keyHash: createHash("sha256").update(foreignToken).digest("hex") }]);
    await db.insert(authUsers).values({ id: userId, name: "Reader", email: `${userId}@example.test`, createdAt: instant, updatedAt: instant });
    await db.insert(organizationMemberships).values({ orgId, principalType: "user", principalId: userId, status: "active", membershipRole: "admin" });
    await db.insert(boardApiKeys).values({ userId, name: "Goal read", keyHash: createHash("sha256").update(boardToken).digest("hex") });
    await db.insert(goals).values([
      { id: goalId, orgId, title: "Ship Goal", description: "long ".repeat(30000), ownerAgentId: agentId, outcomeStatement: "Goal contract continuation uses artifact://private", criteria: [{ id: "ok", label: "Evaluator evidence requirements", hidden: true }, { id: "", label: "skip" }, null], evaluationResult: { outcome: "achieved", private: true }, planRevision: 2, createdAt: instant, updatedAt: instant },
      { id: foreignGoal, orgId: foreignOrg, title: "Foreign" },
      { id: childId, orgId, title: "Child", parentId: goalId, createdAt: new Date(instant.getTime() + 1000) },
    ]);
    await db.insert(goalOwnerAssignments).values({ orgId, goalId, agentId, assignmentRevision: 2, startsAt: instant });
    await db.insert(goalPlans).values([{ orgId, goalId, revision: 1, summary: "Old plan" }, { orgId, goalId, revision: 2, summary: "Contract revision plan" }]);
    await db.insert(projects).values({ id: projectId, orgId, name: "Linked", goalId });
    await db.insert(projectGoals).values({ orgId, projectId, goalId });
    const evidenceRefs = ["artifact://private", "run://run-1", "issue://ISS-1", "project://project-1", "approval://approval-1", "https://private.example/token", "library-file://file?p=notes%2Fa+b.md", "library-entry://entry-id?p=notes%2Fready.md"];
    const samples = ["Goal evaluated as achieved\u2028ignored", "Goal evaluated as achieved\rignored", "error: private trace", "Goal contract evaluator evidence requirements autonomy envelope human authorities continuation change proposal result proposal runtime evidence run evidence para-memory-files daily-note", "the `shared notes` skill Evidence shows that issue://secret) feedback 10000000-0000-4000-8000-000000000001", "Goal\u{feff}contract contracté goal\u{0085}contract"];
    await db.insert(goalActivities).values(Array.from({ length: 121 }, (_, i) => ({ id: `60000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, orgId, goalId, contractRevision: 1, submittedByAgentId: i % 3 ? agentId : null, activityKind: i < 2 ? "closeout" : "progress", summary: samples[i] ?? `Contract revision ${i}`, evidenceRefs, occurredAt: instant, createdAt: new Date(instant.getTime() + i * 1000) })));
    await db.insert(assets).values([{ id: assetId, orgId, provider: "local", objectKey: "own", contentType: "text/plain", byteSize: 1, sha256: "test" }, { id: foreignAsset, orgId: foreignOrg, provider: "local", objectKey: "other", contentType: "text/plain", byteSize: 1, sha256: "test" }]);
    await db.insert(goalFeedbackEntries).values({ orgId, goalId, actorType: "user", actorId: userId, body: "Literal contract feedback", attachments: [{ uri: `asset://${assetId}`, name: "own" }, { uri: `asset://${foreignAsset}`, name: "foreign" }], contentHash: "hash", idempotencyKey: "feedback", createdAt: instant });
    const approvalId = randomUUID();
    await db.insert(approvals).values({ id: approvalId, orgId, type: "goal_change", payload: {} });
    await db.insert(goalChangeProposals).values({ orgId, goalId, expectedContractRevision: 1, beforeContract: {} as never, afterContract: {} as never, rationale: "Change proposal ready", evidenceRefs, approvalId, idempotencyKey: "change", proposedByAgentId: agentId, createdAt: instant });
    await db.insert(goalResultProposals).values({ orgId, goalId, contractRevision: 1, candidate: { evidenceRefs } as never, candidateHash: "hash", preflight: { outcome: "achieved" } as never, riskSummary: "Evaluator complete", idempotencyKey: "result", proposedByAgentId: agentId, createdAt: instant });
    // Production-shaped dependencies cover every count, preview and delete gate.
    await db.insert(goals).values([
      { id: activeEmptyId, orgId, title: "Active empty", lifecycle: "active", createdAt: new Date(instant.getTime()+100000) },
      ...Array.from({length:7},(_,i)=>({orgId,parentId:goalId,title:`Child ${i}`,createdAt:new Date(instant.getTime()+(i+2)*1000)})),
    ]);
    await db.insert(projects).values(Array.from({length:6},(_,i)=>({orgId,goalId,name:`Legacy linked ${i}`,createdAt:new Date(instant.getTime()+i*1000)})));
    await db.insert(issues).values(Array.from({length:7},(_,i)=>({orgId,goalId,title:`Issue ${i}`,identifier:i%2 ? null : `GR-${i}`,createdAt:new Date(instant.getTime()+i*1000)})));
    await db.insert(automations).values(Array.from({length:7},(_,i)=>({orgId,goalId,title:`Automation ${i}`,assigneeAgentId:agentId,createdAt:new Date(instant.getTime()+i*1000)})));
    await db.insert(calendarEvents).values([
      ...Array.from({length:7},(_,i)=>({orgId,goalId,title:`Event ${i}`,eventKind:"meeting",eventStatus:"scheduled",ownerType:"user",startAt:instant,endAt:instant,createdAt:new Date(instant.getTime()+i*1000)})),
      {orgId,goalId,title:"Deleted",eventKind:"meeting",eventStatus:"scheduled",ownerType:"user",startAt:instant,endAt:instant,deletedAt:instant},
      {orgId:foreignOrg,goalId,title:"Foreign link",eventKind:"meeting",eventStatus:"scheduled",ownerType:"user",startAt:instant,endAt:instant},
    ]);
    await db.insert(costEvents).values(Array.from({length:2},()=>({orgId,goalId,agentId,provider:"synthetic",model:"synthetic",costCents:1,occurredAt:instant})));
    await db.insert(financeEvents).values(Array.from({length:3},()=>({orgId,goalId,eventKind:"expense",biller:"synthetic",amountCents:1,occurredAt:instant})));
    const deep = "[".repeat(700) + "1e400" + "]".repeat(700);
    await db.execute(sql`UPDATE goals SET autonomy_envelope=jsonb_build_object('private',${deep}::jsonb), result_payload=jsonb_build_object('private',${deep}::jsonb), evaluation_result=evaluation_result || jsonb_build_object('private',${deep}::jsonb), criteria=jsonb_set(criteria,'{0,private}',${deep}::jsonb), owner_agent_runtime_overrides=jsonb_build_object('adapterConfig',${deep}::jsonb) WHERE id=${goalId}::uuid`);
    await db.execute(sql`UPDATE goal_plans SET hypotheses=jsonb_build_array(${deep}::jsonb) WHERE goal_id=${goalId}::uuid`);
    await db.execute(sql`UPDATE goal_activities SET evidence_refs=evidence_refs || jsonb_build_array(${deep}::jsonb) WHERE goal_id=${goalId}::uuid`);
    await db.execute(sql`UPDATE goal_feedback_entries SET attachments=jsonb_set(attachments,'{0,private}',${deep}::jsonb) WHERE goal_id=${goalId}::uuid`);
    await db.execute(sql`UPDATE goal_change_proposals SET before_contract=jsonb_build_object('private',${deep}::jsonb),after_contract=jsonb_build_object('private',${deep}::jsonb),evidence_refs=evidence_refs || jsonb_build_array(${deep}::jsonb) WHERE goal_id=${goalId}::uuid`);
    await db.execute(sql`UPDATE goal_result_proposals SET candidate=candidate || jsonb_build_object('private',${deep}::jsonb),preflight=preflight || jsonb_build_object('private',${deep}::jsonb) WHERE goal_id=${goalId}::uuid`);
    const legacy = goalService(db);
    expected.list = wire((await legacy.list(orgId)).map(publicGoalView));
    expected.detail = wire(publicGoalDetail(await legacy.detail(goalId)));
    expected.activities = wire((await legacy.listActivities(goalId)).map((a) => publicGoalActivity(a)));
    expected.dependencies = wire(await legacy.dependencies((await legacy.getById(goalId))!));
    expect(expected.dependencies).toMatchObject({canDelete:false,counts:{childGoals:8,linkedProjects:7,linkedIssues:7,automations:7,calendarEvents:7,costEvents:2,financeEvents:3}});
    for (const preview of Object.values((expected.dependencies as {previews:Record<string,unknown[]>}).previews)) expect(preview).toHaveLength(5);
    expected.emptyDraft = wire(await legacy.dependencies((await legacy.getById(foreignGoal))!));
    expected.activeEmpty = wire(await legacy.dependencies((await legacy.getById(activeEmptyId))!));
    let cursor: string | null = null; const pages = [];
    do { const page = await legacy.history(goalId, { limit: 7, cursor }); pages.push(wire(page)); cursor = page.nextCursor; } while (cursor);
    expected.historyPages = pages;
    baseline = await snapshot();
    fixtureBinary = path.join(root, process.platform === "win32" ? "foundation-fixture.exe" : "foundation-fixture");
    fs.copyFileSync(binary, fixtureBinary, fs.constants.COPYFILE_FICLONE);
    const nodePort = ingress === "required" ? await port() : 0;
    bridge = createRustFoundationBridge({ databaseUrl: url, binaryPath: fixtureBinary, mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", requestTimeoutMs: 10_000, ...(ingress === "required" ? { publicIngress: { listenAddr: "127.0.0.1:0", nodeUpstream: `http://127.0.0.1:${nodePort}`, authorizationKey: "goal-read-synthetic-ingress-authorization-key" } } : {}) });
    const app = express(); app.use(express.json());
    app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
    app.use("/api", goalRoutes(db, bridge)); app.use(errorHandler);
    server = app.listen(nodePort, "127.0.0.1"); await once(server, "listening");
    await bridge.start(); target = server;
    if (ingress === "required") { await bridge.waitForPublicIngressReady!(); target = bridge.publicIngressBaseUrl!; }
  }, 60_000);
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
    await bridge?.close(); await db?.$client.end({ timeout: 5 }); await database?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, 30_000);
  it("matches retained Node public projections for all five migrated GETs, including bounded tied history", async () => {
    for (const token of [agentToken, boardToken]) {
      for (const [url, key] of [[`/api/orgs/${orgId}/goals`, "list"], [`/api/goals/${goalId}`, "detail"], [`/api/goals/${goalId}/activities`, "activities"], [`/api/goals/${goalId}/dependencies`, "dependencies"]]) {
        const response = await get(url!, token); expect(response.status, JSON.stringify(response.body)).toBe(200); expect(response.body).toEqual(expected[key!]);
      }
    }
    let cursor: string | null = null; const pages = [];
    do { const response = await get(`/api/goals/${goalId}/history?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`); expect(response.status, JSON.stringify(response.body)).toBe(200); pages.push(response.body); cursor = response.body.nextCursor; expect(pages.length).toBeLessThan(30); } while (cursor);
    expect(pages).toEqual(expected.historyPages);
    expect((await get(`/api/goals/${foreignGoal}/dependencies`,foreignToken)).body).toEqual(expected.emptyDraft);
    expect(expected.emptyDraft).toMatchObject({canDelete:true,blockers:[]});
    expect((await get(`/api/goals/${activeEmptyId}/dependencies`)).body).toEqual(expected.activeEmpty);
    expect(expected.activeEmpty).toMatchObject({canDelete:false,blockers:["goal_not_draft"]});
    expect(await snapshot()).toEqual(baseline);
  }, 30_000);
  it("keeps API-key and board organization fences, typed refs, 404 and bad-query status", async () => {
    for (const url of [`/api/orgs/${orgId}/goals`, `/api/goals/${goalId}`, `/api/goals/${goalId}/history`, `/api/goals/${goalId}/activities`, `/api/goals/${goalId}/dependencies`]) {
      expect((await get(url, foreignToken)).status).toBe(403); expect((await request(target).get(url)).status).toBe(401);
    }
    expect((await get(`/api/goals/${foreignGoal}`, boardToken)).status).toBe(403);
    expect((await get(`/api/goals/gol_${goalId.slice(0, 8)}`)).body).toEqual(expected.detail);
    expect((await get(`/api/goals/${randomUUID()}`)).status).toBe(404);
    for (const query of ["limit=0", "limit=101", "limit=NaN", "limit=1.5", "cursor=invalid"]) expect((await get(`/api/goals/${goalId}/history?${query}`)).status).toBe(400);
    expect(await snapshot()).toEqual(baseline);
  });
  it("fails closed on actual native outage while the authenticated Node service stays alive", async () => {
    await bridge.close();
    const unavailable = `${fixtureBinary}.unavailable`;
    fs.renameSync(fixtureBinary, unavailable);
    try {
      expect((await request(server).get("/api/health")).status).toBe(200);
      for (const url of [`/api/orgs/${orgId}/goals`, `/api/goals/${goalId}`, `/api/goals/${goalId}/activities`, `/api/goals/${goalId}/history`, `/api/goals/${goalId}/dependencies`]) {
        const response = await request(server).get(url).set("authorization", `Bearer ${agentToken}`);
        expect(response.status, JSON.stringify(response.body)).toBe(503);
        expect(response.body.error).toBe("Rust Goal reads are unavailable");
      }
      expect(await snapshot()).toEqual(baseline);
    } finally { fs.renameSync(unavailable, fixtureBinary); }
  });

});
