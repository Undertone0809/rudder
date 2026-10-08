import {
  agentApiKeys, agents, applyPendingMigrations, approvals, assets, authUsers, automations, boardApiKeys, calendarEvents, costEvents,
  createDb, ensurePostgresDatabase,
  financeEvents,
  goalActivities, goalChangeProposals, goalFeedbackEntries,
  goalCheckpoints, goalOwnerAssignments, goalPlans, goalResultProposals, goals,
  agentWakeupRequests, heartbeatRuns,
  chatConversations,
  issues,
  organizationMemberships,
  organizations, projectGoals, projects,
} from "@rudderhq/db";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { goalRoutes } from "../routes/goals.js";
import { goalService, publicGoalActivity, publicGoalCheckpoint, publicGoalDetail, publicGoalView } from "../services/goals.js";
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
  const activeEmptyId = randomUUID(); const cardRunGoalId = randomUUID(); const cardProposalGoalId = randomUUID(); const childId = randomUUID(); const agentId = randomUUID(); const nonOwnerAgentId = randomUUID(); const foreignAgent = randomUUID(); const projectId = randomUUID();
  const runningRunId = randomUUID(); const failedRunId = randomUUID(); const wakeupId = randomUUID();
  const cardRunOldId = randomUUID(); const cardRunNewId = randomUUID(); const cardProposalOldId = randomUUID(); const cardProposalNewId = randomUUID();
  const sideChatId = randomUUID(); const privateRunId = randomUUID(); const privateFillerRunIds = Array.from({ length: 12 }, () => randomUUID()); const otherUserId = `goal-other-user-${randomUUID()}`;
  const assetId = randomUUID(); const foreignAsset = randomUUID(); const userId = `goal-user-${randomUUID()}`;
  const agentToken = `agent-${randomUUID()}`; const nonOwnerToken = `non-owner-${randomUUID()}`; const foreignToken = `foreign-${randomUUID()}`; const boardToken = `board-${randomUUID()}`; const otherBoardToken = `board-other-${randomUUID()}`;
  const instant = new Date("2026-10-08T02:03:04.567Z");
  const expected: Record<string, unknown> = {};
  let baseline: Record<string, unknown>;
  async function snapshot() {
    const result: Record<string, unknown> = {};
    for (const table of ["goals", "goal_activities", "goal_plans", "goal_owner_assignments", "goal_checkpoints", "agent_wakeup_requests", "heartbeat_runs", "chat_conversations", "goal_feedback_entries", "goal_change_proposals", "goal_result_proposals", "organization_mutation_state", "organization_mutation_receipts", "activity_log"]) {
      result[table] = (await db.execute(sql.raw(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS value FROM "${table}" t`)))[0]?.value;
    }
    return result;
  }
  function get(url: string, token = agentToken) { return request(target).get(url).set("authorization", `Bearer ${token}`); }
  function assignedExpected(filters: { lifecycle: "draft" | "active" | "closed" | "all"; focus: boolean | null; facet: string | null; limit: number }, cards = expected.workspaceCards, requestingAgentId = agentId) {
    const rows = (cards as Array<Record<string, unknown>>).filter((goal) =>
      goal.ownerAgentId === requestingAgentId
      && (filters.lifecycle === "all" || goal.lifecycle === filters.lifecycle)
      && (filters.focus === null || goal.focus === filters.focus)
      && (filters.facet === null || goal.facet === filters.facet));
    return wire({ goals: rows.slice(0, filters.limit), count: rows.length, filters });
  }
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
    await db.insert(agents).values([{ id: agentId, orgId, name: "Owner", role: "engineer", status: "idle", adapterType: "process" }, { id: nonOwnerAgentId, orgId, name: "Other agent", role: "engineer", status: "idle", adapterType: "process" }, { id: foreignAgent, orgId: foreignOrg, name: "Other", role: "engineer", status: "idle", adapterType: "process" }]);
    await db.insert(agentApiKeys).values([{ agentId, orgId, name: "test", keyHash: createHash("sha256").update(agentToken).digest("hex") }, { agentId: nonOwnerAgentId, orgId, name: "non-owner", keyHash: createHash("sha256").update(nonOwnerToken).digest("hex") }, { agentId: foreignAgent, orgId: foreignOrg, name: "test", keyHash: createHash("sha256").update(foreignToken).digest("hex") }]);
    await db.insert(authUsers).values([{ id: userId, name: "Reader", email: `${userId}@example.test`, createdAt: instant, updatedAt: instant }, { id: otherUserId, name: "Other reader", email: `${otherUserId}@example.test`, createdAt: instant, updatedAt: instant }]);
    await db.insert(organizationMemberships).values([{ orgId, principalType: "user", principalId: userId, status: "active", membershipRole: "admin" }, { orgId, principalType: "user", principalId: otherUserId, status: "active", membershipRole: "admin" }]);
    await db.insert(boardApiKeys).values([{ userId, name: "Goal read", keyHash: createHash("sha256").update(boardToken).digest("hex") }, { userId: otherUserId, name: "Other board", keyHash: createHash("sha256").update(otherBoardToken).digest("hex") }]);
    await db.insert(chatConversations).values({ id: sideChatId, orgId, conversationKind: "side_chat", messengerVisible: false, sideChatState: "active", title: "Private Side Chat", createdByUserId: userId, createdAt: instant, updatedAt: instant });
    await db.insert(goals).values([
      { id: goalId, orgId, title: "__RUDDER_OPAQUE_GOAL_JSON_0__", description: "long ".repeat(30000), lifecycle: "active", status: "active", ownerAgentId: agentId, focus: true, outcomeStatement: "Goal contract continuation uses artifact://private", criteria: [{ id: "ok", label: "Evaluator evidence requirements", hidden: true }, { id: "", label: "skip" }, null], evaluationResult: { outcome: "achieved", private: true }, planRevision: 2, continuationKind: "wait", continuationSummary: "Goal contract continuation includes __RUDDER_OPAQUE_GOAL_JSON_0__ and artifact://private", wakeCondition: "The reviewer responds", createdAt: instant, updatedAt: instant },
      { id: foreignGoal, orgId: foreignOrg, title: "Foreign" },
      { id: childId, orgId, title: "Child", parentId: goalId, createdAt: new Date(instant.getTime() + 1000) },
      { id: activeEmptyId, orgId, title: "Active empty", lifecycle: "active", status: "active", ownerAgentId: agentId, focus: false, continuationKind: "wait", continuationSummary: "Wait for external input", createdAt: new Date(instant.getTime()+100000) },
      { id: cardRunGoalId, orgId, title: "Card latest run", lifecycle: "active", status: "active", ownerAgentId: agentId, createdAt: new Date(instant.getTime()+200000) },
      { id: cardProposalGoalId, orgId, title: "Card proposal order", lifecycle: "active", status: "active", ownerAgentId: agentId, createdAt: new Date(instant.getTime()+300000) },
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
    await db.insert(heartbeatRuns).values([
      { id: cardRunOldId, orgId, agentId, goalId: cardRunGoalId, invocationSource: "on_demand", triggerDetail: "system", status: "failed", error: "older failure", createdAt: new Date(instant.getTime()+201000), updatedAt: new Date(instant.getTime()+202000) },
      { id: cardRunNewId, orgId, agentId, goalId: cardRunGoalId, invocationSource: "on_demand", triggerDetail: "system", status: "succeeded", resultSummaryJson: { summary: "Newer successful work" }, createdAt: new Date(instant.getTime()+203000), updatedAt: new Date(instant.getTime()+204000) },
    ]);
    await db.insert(goalActivities).values({ orgId, goalId: cardRunGoalId, runRef: cardRunOldId, contractRevision: 1, submittedByAgentId: agentId, activityKind: "progress", summary: "Evidence from older failed run", evidenceRefs: ["issue://CARD-1"], occurredAt: new Date(instant.getTime()+205000), createdAt: new Date(instant.getTime()+205000) });
    await db.insert(goalResultProposals).values([
      // Preserve the production partial unique index: one accepted proposal
      // can precede the sole ready proposal for a Goal.
      { id: cardProposalOldId, orgId, goalId: cardProposalGoalId, contractRevision: 1, candidate: {} as never, candidateHash: "old", preflight: { outcome: "achieved" } as never, riskSummary: "Older accepted result", status: "accepted", idempotencyKey: "card-old", proposedByAgentId: agentId, acceptedByActorType: "user", acceptedByActorId: userId, acceptanceIdempotencyKey: "card-old-accepted", acceptedAt: new Date(instant.getTime()+301500), createdAt: new Date(instant.getTime()+301000) },
      { id: cardProposalNewId, orgId, goalId: cardProposalGoalId, contractRevision: 1, candidate: {} as never, candidateHash: "new", preflight: { outcome: "not_achieved" } as never, riskSummary: "Newer ready result", status: "ready", idempotencyKey: "card-new", proposedByAgentId: agentId, createdAt: new Date(instant.getTime()+302000) },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: runningRunId, orgId, agentId, goalId, invocationSource: "on_demand", triggerDetail: "manual", status: "running", startedAt: new Date(instant.getTime() + 30_000), resultSummaryJson: { summary: "The Agent is preparing the release." }, contextSnapshot: { scene: "delegation", targetType: "manual", targetId: "manual-1", triggerKind: "manual", delegationTask: "private delegated task", sourceAgentId: foreignAgent, resumeSessionParams: { private: true }, retainedFact: "visible" }, createdAt: new Date(instant.getTime() + 30_000), updatedAt: new Date(instant.getTime() + 31_000) },
      { id: failedRunId, orgId, agentId, goalId, invocationSource: "on_demand", triggerDetail: "system", status: "failed", error: "private failure detail", resultSummaryJson: { summary: "error: private run trace" }, createdAt: new Date(instant.getTime() + 32_000), updatedAt: new Date(instant.getTime() + 33_000) },
      { id: privateRunId, orgId, agentId, goalId: activeEmptyId, chatConversationId: sideChatId, invocationSource: "chat", status: "running", startedAt: new Date(instant.getTime() + 40_000), resultJson: { summary: "Private Side Chat text", privateConversationId: sideChatId }, resultSummaryJson: { summary: "Private Side Chat summary" }, contextSnapshot: { scene: "side_chat", conversationId: sideChatId, targetType: "chat_conversation", targetId: sideChatId, secretSideChatLabel: "private" }, createdAt: new Date(instant.getTime() + 40_000), updatedAt: new Date(instant.getTime() + 41_000) },
      ...privateFillerRunIds.map((id, i) => ({ id, orgId, agentId, goalId, chatConversationId: sideChatId, invocationSource: "chat", status: "succeeded", resultJson: { summary: `Private Side Chat filler ${i}`, privateConversationId: sideChatId }, resultSummaryJson: { summary: `Private Side Chat filler ${i}` }, contextSnapshot: { scene: "side_chat", conversationId: sideChatId, targetType: "chat_conversation", targetId: sideChatId, secretSideChatLabel: `private-${i}` }, createdAt: new Date(instant.getTime() + 150_000 + i * 1_000), updatedAt: new Date(instant.getTime() + 151_000 + i * 1_000) })),
    ]);
    await db.insert(agentWakeupRequests).values({ id: wakeupId, orgId, agentId, source: "on_demand", reason: "goal_continuation", payload: { goalId, planRevision: 2, checkpointId: null, continuation: { kind: "wait", summary: "Wait for the reviewer" } }, status: "deferred_goal_blocked", error: "budget.blocked", requestedAt: new Date(instant.getTime() + 34_000), createdAt: new Date(instant.getTime() + 34_000) });
    await db.insert(goalCheckpoints).values({ orgId, goalId, runId: runningRunId, ownerAgentId: agentId, submittedByAgentId: agentId, inputHash: "checkpoint-hash", idempotencyKey: "checkpoint-1", summary: "Goal contract checkpoint summary", evidenceRefs: ["artifact://private", "issue://ISS-1"], planPayload: { summary: "Next plan" }, planRevisionBefore: 2, planRevisionAfter: 3, continuationKind: "wait", continuationSummary: "Wait for the reviewer", wakeCondition: "Reviewer replies", continuationWakeupRequestId: wakeupId, createdAt: new Date(instant.getTime() + 35_000) });
    // Production-shaped dependencies cover every count, preview and delete gate.
    await db.insert(goals).values([
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
    await db.execute(sql`UPDATE goal_change_proposals SET before_contract=jsonb_build_object('outcomeStatement','Goal contract before','criteria',jsonb_build_array(jsonb_build_object('label','Evaluator evidence requirements')),'actionDeadline','2026-10-09T00:00:00.000Z','evaluationDeadline','2026-10-10T00:00:00.000Z','autonomyEnvelope',jsonb_build_object('allowed',jsonb_build_array('','bounded_reversible_work'),'requiresHumanApproval',jsonb_build_array('','external_publication')),'humanAuthorities',jsonb_build_object('acceptance',true,'externalPublication',true,'consequentialChanges',true),'evaluationPolicy',jsonb_build_object('terminalEvidenceRequired',true,'humanAcceptanceRequired',true),'private',${deep}::jsonb),after_contract=jsonb_build_object('outcomeStatement','Goal contract after','criteria',jsonb_build_array(jsonb_build_object('label','Success evidence')),'actionDeadline','2026-10-11T00:00:00.000Z','autonomyEnvelope',jsonb_build_object('allowed',jsonb_build_array('bounded_reversible_work'),'requiresHumanApproval',jsonb_build_array('external_publication')),'humanAuthorities',jsonb_build_object('acceptance',true,'externalPublication',true,'consequentialChanges',true),'evaluationPolicy',jsonb_build_object('terminalEvidenceRequired',true,'humanAcceptanceRequired',true),'private',${deep}::jsonb),evidence_refs=evidence_refs || jsonb_build_array(${deep}::jsonb) WHERE goal_id=${goalId}::uuid`);
    await db.execute(sql`UPDATE goal_result_proposals SET candidate=candidate || jsonb_build_object('private',${deep}::jsonb),preflight=preflight || jsonb_build_object('private',${deep}::jsonb) WHERE goal_id=${goalId}::uuid`);
    await db.execute(sql`UPDATE goal_plans SET selected_paths=jsonb_build_array(${deep}::jsonb),rejected_paths=jsonb_build_array(${deep}::jsonb),sequencing=jsonb_build_array(${deep}::jsonb),budget_allocations=jsonb_build_object('nested',${deep}::jsonb),invalidation_conditions=jsonb_build_array(${deep}::jsonb) WHERE goal_id=${goalId}::uuid AND revision=2`);
    await db.execute(sql`UPDATE goal_checkpoints SET plan_payload=jsonb_build_object('nested',${deep}::jsonb) WHERE goal_id=${goalId}::uuid`);
    await db.execute(sql`UPDATE heartbeat_runs SET result_json=jsonb_build_object('nested',${deep}::jsonb),usage_json=jsonb_build_object('nested',${deep}::jsonb),context_snapshot=context_snapshot || jsonb_build_object('nested',${deep}::jsonb) WHERE id=${runningRunId}::uuid`);
    const legacy = goalService(db);
    expected.list = wire((await legacy.list(orgId)).map(publicGoalView));
    expected.detail = wire(publicGoalDetail(await legacy.detail(goalId)));
    expected.activities = wire((await legacy.listActivities(goalId)).map((a) => publicGoalActivity(a)));
    expected.workspaceCards = wire(await legacy.workspaceCards(orgId));
    expected.workspace = wire(await legacy.workspace(goalId));
    expected.cardRunWorkspace = wire(await legacy.workspace(cardRunGoalId));
    expected.cardProposalWorkspace = wire(await legacy.workspace(cardProposalGoalId));
    expected.assignedFocused = assignedExpected({ lifecycle: "all", focus: true, facet: "ready_for_acceptance", limit: 1 });
    const contextDetail = await legacy.detail(goalId);
    const contextWorkspace = await legacy.workspace(goalId);
    const contextPublicGoal = publicGoalView(contextDetail);
    const [latestCheckpoint, recentCheckpoints, pendingContinuationWake] = await Promise.all([
      legacy.latestCheckpoint(goalId), legacy.recentCheckpoints(goalId), legacy.pendingContinuationWake(goalId),
    ]);
    expected.agentContext = wire({
      goal: {
        id: contextPublicGoal.id, orgId: contextPublicGoal.orgId, title: contextPublicGoal.title,
        description: contextPublicGoal.description, lifecycle: contextPublicGoal.lifecycle,
        status: contextPublicGoal.status, ownerAgentId: contextPublicGoal.ownerAgentId,
        focus: contextPublicGoal.focus, closeReason: contextPublicGoal.closeReason,
        createdAt: contextPublicGoal.createdAt, updatedAt: contextPublicGoal.updatedAt,
      },
      contract: {
        revision: contextDetail.contractRevision, outcomeStatement: contextDetail.outcomeStatement,
        objectiveMode: contextDetail.objectiveMode, criteria: contextDetail.criteria,
        autonomyEnvelope: contextDetail.autonomyEnvelope, humanAuthorities: contextDetail.humanAuthorities,
        evaluationPolicy: contextDetail.evaluationPolicy, actionDeadline: contextDetail.actionDeadline,
        evaluationDeadline: contextDetail.evaluationDeadline,
      },
      plan: contextDetail.plan ? {
        revision: contextDetail.plan.revision, summary: contextDetail.plan.summary,
        hypotheses: contextDetail.plan.hypotheses, selectedPaths: contextDetail.plan.selectedPaths,
        rejectedPaths: contextDetail.plan.rejectedPaths, sequencing: contextDetail.plan.sequencing,
        budgetAllocations: contextDetail.plan.budgetAllocations,
        invalidationConditions: contextDetail.plan.invalidationConditions,
      } : null,
      continuation: contextDetail.continuationKind ? {
        kind: contextDetail.continuationKind, summary: contextDetail.continuationSummary ?? "",
        wakeCondition: contextDetail.wakeCondition,
      } : null,
      latestCheckpoint: latestCheckpoint ? publicGoalCheckpoint(latestCheckpoint) : null,
      recentCheckpoints: recentCheckpoints.map(publicGoalCheckpoint),
      pendingContinuationWake,
      state: {
        facet: contextWorkspace.facet, currentProgress: contextWorkspace.currentProgress,
        agentAction: contextWorkspace.agentAction, nextStep: contextWorkspace.nextStep,
        attention: contextWorkspace.attention,
      },
      pending: { changeProposals: contextWorkspace.changeProposals ?? [], resultProposals: contextWorkspace.resultProposals },
      recentHistory: contextWorkspace.timeline.slice(0, 20),
      allowedActions: { reportProgress: contextDetail.lifecycle === "active", proposeChange: contextDetail.lifecycle === "active", proposeResult: contextDetail.lifecycle === "active" },
    });
    expected.timelineOwner = wire(await legacy.timeline(goalId));
    let timelineCursor: string | null = null;
    const timelinePages = [];
    do {
      const page = await legacy.timeline(goalId, { limit: 7, cursor: timelineCursor });
      timelinePages.push(wire(page)); timelineCursor = page.nextCursor;
    } while (timelineCursor);
    expected.timelinePagesOwner = timelinePages;
    expected.activeWorkspaceOwner = wire(await legacy.workspace(activeEmptyId));
    expected.activeTimelineOwner = wire(await legacy.timeline(activeEmptyId));
    const privateRunIds = [privateRunId, ...privateFillerRunIds];
    await db.update(heartbeatRuns).set({ goalId: null }).where(inArray(heartbeatRuns.id, privateRunIds));
    expected.timelineHidden = wire(await legacy.timeline(goalId));
    let hiddenPrimaryCursor: string | null = null; const hiddenPrimaryPages = [];
    do {
      const page = await legacy.timeline(goalId, { limit: 7, cursor: hiddenPrimaryCursor });
      hiddenPrimaryPages.push(wire(page)); hiddenPrimaryCursor = page.nextCursor;
    } while (hiddenPrimaryCursor);
    expected.timelinePagesHidden = hiddenPrimaryPages;
    expected.workspaceCardsHidden = wire(await legacy.workspaceCards(orgId));
    expected.assigned = assignedExpected({ lifecycle: "active", focus: null, facet: null, limit: 20 }, expected.workspaceCardsHidden);
    expected.assignedNonOwner = assignedExpected({ lifecycle: "active", focus: null, facet: null, limit: 20 }, expected.workspaceCardsHidden, nonOwnerAgentId);
    expected.activeWorkspaceHidden = wire(await legacy.workspace(activeEmptyId));
    expected.activeTimelineHidden = wire(await legacy.timeline(activeEmptyId));
    let hiddenTimelineCursor: string | null = null; const hiddenTimelinePages = [];
    do {
      const page = await legacy.timeline(activeEmptyId, { limit: 7, cursor: hiddenTimelineCursor });
      hiddenTimelinePages.push(wire(page)); hiddenTimelineCursor = page.nextCursor;
    } while (hiddenTimelineCursor);
    expected.activeTimelinePagesHidden = hiddenTimelinePages;
    await db.update(heartbeatRuns).set({ goalId: activeEmptyId }).where(eq(heartbeatRuns.id, privateRunId));
    await db.update(heartbeatRuns).set({ goalId }).where(inArray(heartbeatRuns.id, privateFillerRunIds));
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
  it("matches retained Node projections for all ten Rust-owned Goal GETs, including workspace, context and merged timeline", async () => {
    for (const [token, sideChatOwner] of [[agentToken, false], [boardToken, true]] as const) {
      for (const [url, key] of [[`/api/orgs/${orgId}/goals`, "list"], [`/api/goals/${goalId}`, "detail"], [`/api/goals/${goalId}/activities`, "activities"], [`/api/goals/${goalId}/dependencies`, "dependencies"]]) {
        const response = await get(url!, token); expect(response.status, JSON.stringify(response.body)).toBe(200); expect(response.body).toEqual(expected[key!]);
      }
      const cards = await get(`/api/orgs/${orgId}/goals/workspace`, token);
      expect(cards.status, JSON.stringify(cards.body)).toBe(200); expect(cards.body).toEqual(sideChatOwner ? expected.workspaceCards : expected.workspaceCardsHidden);
      const cardRows = cards.body as Array<Record<string, unknown>>;
      const runParityCard = cardRows.find((card) => card.id === cardRunGoalId)!;
      const proposalParityCard = cardRows.find((card) => card.id === cardProposalGoalId)!;
      expect(runParityCard.facet).toBe("agent_advancing");
      expect(proposalParityCard.attentionReason).toBe("Review the proposed Goal result: Goal not achieved");
      const runParityWorkspace = await get(`/api/goals/${cardRunGoalId}/workspace`, token);
      expect(runParityWorkspace.status, JSON.stringify(runParityWorkspace.body)).toBe(200);
      expect(runParityWorkspace.body).toEqual(expected.cardRunWorkspace);
      expect(runParityWorkspace.body.facet).toBe("needs_attention");
      const proposalParityWorkspace = await get(`/api/goals/${cardProposalGoalId}/workspace`, token);
      expect(proposalParityWorkspace.status, JSON.stringify(proposalParityWorkspace.body)).toBe(200);
      expect(proposalParityWorkspace.body).toEqual(expected.cardProposalWorkspace);
      expect(proposalParityWorkspace.body.attention.sourceId).toBe(cardProposalNewId);
      const workspace = await get(`/api/goals/${goalId}/workspace`, token);
      expect(workspace.status, JSON.stringify(workspace.body)).toBe(200); expect(workspace.body).toEqual(expected.workspace);
      expect(workspace.body.goal.title).toBe("__RUDDER_OPAQUE_GOAL_JSON_0__");
      const timeline = await get(`/api/goals/${goalId}/timeline`, token);
      expect(timeline.status, JSON.stringify(timeline.body)).toBe(200);
      expect(timeline.body).toEqual(sideChatOwner ? expected.timelineOwner : expected.timelineHidden);
      if (!sideChatOwner) expect(JSON.stringify(timeline.body)).not.toContain(sideChatId);
      const privateWorkspace = await get(`/api/goals/${activeEmptyId}/workspace`, token);
      expect(privateWorkspace.status, JSON.stringify(privateWorkspace.body)).toBe(200);
      expect(privateWorkspace.body).toEqual(sideChatOwner ? expected.activeWorkspaceOwner : expected.activeWorkspaceHidden);
      const privateTimeline = await get(`/api/goals/${activeEmptyId}/timeline`, token);
      expect(privateTimeline.status, JSON.stringify(privateTimeline.body)).toBe(200);
      expect(privateTimeline.body).toEqual(sideChatOwner ? expected.activeTimelineOwner : expected.activeTimelineHidden);
      if (sideChatOwner) {
        expect(JSON.stringify(privateTimeline.body)).toContain(sideChatId);
        expect(JSON.stringify(privateTimeline.body)).toContain("Private Side Chat text");
        expect(privateTimeline.body.hasLiveRuns).toBe(true);
      } else {
        expect(JSON.stringify(privateTimeline.body)).not.toContain(sideChatId);
        expect(JSON.stringify(privateTimeline.body)).not.toContain("Private Side Chat");
        expect(privateTimeline.body.hasLiveRuns).toBe(false);
      }
    }
    const otherBoardCards = await get(`/api/orgs/${orgId}/goals/workspace`, otherBoardToken);
    expect(otherBoardCards.status, JSON.stringify(otherBoardCards.body)).toBe(200);
    expect(otherBoardCards.body).toEqual(expected.workspaceCardsHidden);
    const otherBoardTimeline = await get(`/api/goals/${activeEmptyId}/timeline`, otherBoardToken);
    expect(otherBoardTimeline.status, JSON.stringify(otherBoardTimeline.body)).toBe(200);
    expect(otherBoardTimeline.body).toEqual(expected.activeTimelineHidden);
    expect(JSON.stringify(otherBoardTimeline.body)).not.toContain(sideChatId);
    expect(JSON.stringify(otherBoardTimeline.body)).not.toContain("Private Side Chat");
    const otherBoardWorkspace = await get(`/api/goals/${activeEmptyId}/workspace`, otherBoardToken);
    expect(otherBoardWorkspace.status, JSON.stringify(otherBoardWorkspace.body)).toBe(200);
    expect(otherBoardWorkspace.body).toEqual(expected.activeWorkspaceHidden);
    const assigned = await get(`/api/orgs/${orgId}/goals/assigned`);
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200); expect(assigned.body).toEqual(expected.assigned);
    expect((await get(`/api/orgs/${orgId}/goals/assigned`, boardToken)).status).toBe(403);
    const focused = await get(`/api/orgs/${orgId}/goals/assigned?lifecycle=all&focus=true&facet=ready_for_acceptance&limit=1`);
    expect(focused.status, JSON.stringify(focused.body)).toBe(200); expect(focused.body).toEqual(expected.assignedFocused);
    const nonOwnerAssigned = await get(`/api/orgs/${orgId}/goals/assigned`, nonOwnerToken);
    expect(nonOwnerAssigned.status, JSON.stringify(nonOwnerAssigned.body)).toBe(200); expect(nonOwnerAssigned.body).toEqual(expected.assignedNonOwner);
    const context = await get(`/api/goals/${goalId}/agent-context`);
    expect(context.status, JSON.stringify(context.body)).toBe(200); expect(context.body).toEqual(expected.agentContext);
    expect(context.body.continuation.summary).toBe("Goal contract continuation includes __RUDDER_OPAQUE_GOAL_JSON_0__ and artifact://private");
    expect((await get(`/api/goals/${goalId}/agent-context`, nonOwnerToken)).status).toBe(403);
    let timelineCursor: string | null = null; const timelinePages = [];
    do {
      const response = await get(`/api/goals/${goalId}/timeline?limit=7${timelineCursor ? `&cursor=${encodeURIComponent(timelineCursor)}` : ""}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200); timelinePages.push(response.body);
      timelineCursor = response.body.nextCursor; expect(timelinePages.length).toBeLessThan(40);
    } while (timelineCursor);
    expect(timelinePages).toEqual(expected.timelinePagesHidden);
    expect(timelinePages.some((page: any) => page.items.some((item: any) => item.source === "agent-run"))).toBe(true);
    let ownerTimelineCursor: string | null = null; const ownerTimelinePages = [];
    do {
      const response = await get(`/api/goals/${goalId}/timeline?limit=7${ownerTimelineCursor ? `&cursor=${encodeURIComponent(ownerTimelineCursor)}` : ""}`, boardToken);
      expect(response.status, JSON.stringify(response.body)).toBe(200); ownerTimelinePages.push(response.body);
      ownerTimelineCursor = response.body.nextCursor; expect(ownerTimelinePages.length).toBeLessThan(40);
    } while (ownerTimelineCursor);
    expect(ownerTimelinePages).toEqual(expected.timelinePagesOwner);
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
    for (const url of [`/api/orgs/${orgId}/goals`, `/api/orgs/${orgId}/goals/workspace`, `/api/orgs/${orgId}/goals/assigned`, `/api/goals/${goalId}`, `/api/goals/${goalId}/workspace`, `/api/goals/${goalId}/agent-context`, `/api/goals/${goalId}/history`, `/api/goals/${goalId}/timeline`, `/api/goals/${goalId}/activities`, `/api/goals/${goalId}/dependencies`]) {
      expect((await get(url, foreignToken)).status).toBe(403); expect((await request(target).get(url)).status).toBe(401);
    }
    expect((await get(`/api/goals/${foreignGoal}`, boardToken)).status).toBe(403);
    expect((await get(`/api/goals/gol_${goalId.slice(0, 8)}`)).body).toEqual(expected.detail);
    expect((await get(`/api/goals/${randomUUID()}`)).status).toBe(404);
    expect((await get(`/api/orgs/${orgId}/goals/assigned?facet=bad`)).status).toBe(400);
    expect((await get(`/api/goals/${goalId}/timeline?limit=101`)).status).toBe(400);
    expect((await get(`/api/goals/${goalId}/timeline?cursor=invalid`)).status).toBe(400);
    expect((await get(`/api/goals/${goalId}/agent-context`, boardToken)).status).toBe(403);
    for (const query of ["limit=0", "limit=101", "limit=NaN", "limit=1.5", "cursor=invalid"]) expect((await get(`/api/goals/${goalId}/history?${query}`)).status).toBe(400);
    expect(await snapshot()).toEqual(baseline);
  });
  it("fails closed on actual native outage while the authenticated Node service stays alive", async () => {
    await bridge.close();
    const unavailable = `${fixtureBinary}.unavailable`;
    fs.renameSync(fixtureBinary, unavailable);
    try {
      expect((await request(server).get("/api/health")).status).toBe(200);
      for (const url of [`/api/orgs/${orgId}/goals`, `/api/orgs/${orgId}/goals/workspace`, `/api/orgs/${orgId}/goals/assigned`, `/api/goals/${goalId}`, `/api/goals/${goalId}/workspace`, `/api/goals/${goalId}/agent-context`, `/api/goals/${goalId}/activities`, `/api/goals/${goalId}/history`, `/api/goals/${goalId}/timeline`, `/api/goals/${goalId}/dependencies`]) {
        const response = await request(server).get(url).set("authorization", `Bearer ${agentToken}`);
        expect(response.status, JSON.stringify(response.body)).toBe(503);
        expect(response.body.error).toBe("Rust Goal reads are unavailable");
      }
      expect(await snapshot()).toEqual(baseline);
    } finally { fs.renameSync(unavailable, fixtureBinary); }
  });

});
