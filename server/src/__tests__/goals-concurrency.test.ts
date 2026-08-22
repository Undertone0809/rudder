import {
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  approvals,
  createDb,
  createLocalPostgresInstance,
  ensurePostgresDatabase,
  goalActivities,
  goalChangeProposals,
  goalFeedbackEntries,
  goals,
  heartbeatRuns,
  organizations,
  type LocalPostgresInstance,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goalService } from "../services/goals.js";
import { heartbeatService } from "../services/heartbeat.js";

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

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-goals-concurrency-"));
  const port = await getAvailablePort();
  const { instance } = await createLocalPostgresInstance({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();
  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

async function holdGoalRowLock(db: ReturnType<typeof createDb>, goalId: string) {
  let signalAcquired!: () => void;
  let signalRelease!: () => void;
  const acquired = new Promise<void>((resolve) => {
    signalAcquired = resolve;
  });
  const released = new Promise<void>((resolve) => {
    signalRelease = resolve;
  });
  const transaction = db.transaction(async (tx) => {
    await tx.select({ id: goals.id }).from(goals).where(eq(goals.id, goalId)).for("update");
    signalAcquired();
    await released;
  });
  await acquired;
  let didRelease = false;
  return {
    release: () => {
      if (didRelease) return;
      didRelease = true;
      signalRelease();
    },
    transaction,
  };
}

async function waitForDatabaseLockWaiters(db: ReturnType<typeof createDb>, minimum: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.$client.unsafe(
      `select count(*)::int as count
       from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'`,
    ) as Array<{ count: number }>;
    if ((rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} PostgreSQL lock waiters`);
}

describe("Goal closed-state concurrency", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: LocalPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it("serializes result acceptance ahead of a racing feedback mutation", async () => {
    const orgId = randomUUID();
    const ownerAgentId = randomUUID();
    const orgName = `Goal concurrency ${orgId.slice(0, 8)}`;
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `G${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      orgId,
      name: "Goal owner",
      role: "engineer",
      status: "idle",
      capabilities: "Plans and executes end-to-end software work with inspectable evidence.",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const service = goalService(db);
    const draft = await service.create(orgId, {
      title: "Ship the verified result",
      ownerAgentId,
    });
    const active = await service.activate(draft.id, {
      confirmed: true,
      ownerAgentId,
      outcomeStatement: "The verified result is available",
      objectiveMode: "target",
      criteria: [{ id: "result", label: "Result exists", evaluator: "artifact" }],
      autonomyEnvelope: {},
      humanAuthorities: {},
      evaluationPolicy: {},
      initialPlan: { summary: "Build and verify the result" },
      initialContinuation: { kind: "verification", summary: "Verify the next result" },
    }, ownerAgentId);
    const proposal = await service.createResultProposal(active.id, {
      evidenceRefs: ["artifact://verified-result"],
      criteria: [{ id: "result", status: "met" }],
      resultPayload: { artifact: "artifact://verified-result" },
      contractRevision: active.contractRevision,
      riskSummary: "No known remaining risk.",
      idempotencyKey: "result-before-close-race",
    }, ownerAgentId);

    const heldLock = await holdGoalRowLock(db, active.id);
    const acceptance = service.acceptResultProposal(proposal.id, {
      idempotencyKey: "accept-close-race",
    }, "acceptance-user");
    let feedback: ReturnType<typeof service.feedback> | null = null;
    let feedbackExpectation: Promise<void> | null = null;
    try {
      await waitForDatabaseLockWaiters(db, 1);
      feedback = service.feedback(active.id, {
        body: "Change direction after accepting the result.",
        attachments: [],
        feedbackKind: "ordinary",
        idempotencyKey: "feedback-after-close-race",
      }, "feedback-user");
      feedbackExpectation = expect(feedback).rejects.toMatchObject({ status: 409 });
      await waitForDatabaseLockWaiters(db, 2);
    } catch (error) {
      heldLock.release();
      await Promise.allSettled([
        heldLock.transaction,
        acceptance,
        ...(feedback ? [feedback] : []),
        ...(feedbackExpectation ? [feedbackExpectation] : []),
      ]);
      throw error;
    }

    heldLock.release();
    await heldLock.transaction;
    await expect(acceptance).resolves.toMatchObject({ lifecycle: "closed", status: "achieved" });
    await feedbackExpectation;

    const [persistedGoal] = await db.select().from(goals).where(eq(goals.id, active.id));
    const persistedFeedback = await db.select().from(goalFeedbackEntries)
      .where(eq(goalFeedbackEntries.goalId, active.id));
    const feedbackWakeups = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.source, "goal_feedback"));
    expect(persistedGoal).toMatchObject({ lifecycle: "closed", status: "achieved" });
    expect(persistedFeedback).toEqual([]);
    expect(feedbackWakeups).toEqual([]);
  }, 30_000);

  it("serializes a ready Result Proposal ahead of a linked queued Goal continuation claim", async () => {
    const orgId = randomUUID();
    const ownerAgentId = randomUUID();
    const orgName = `Goal continuation claim ${orgId.slice(0, 8)}`;
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      orgId,
      name: "Goal continuation owner",
      role: "engineer",
      status: "idle",
      capabilities: "Advances Goal continuations and records evidence.",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const service = goalService(db);
    const draft = await service.create(orgId, {
      title: "Stop a queued continuation at human acceptance",
      ownerAgentId,
    });
    const active = await service.activate(draft.id, {
      confirmed: true,
      ownerAgentId,
      outcomeStatement: "The accepted Goal result is ready for review",
      objectiveMode: "target",
      criteria: [{ id: "result", label: "Result exists", evaluator: "artifact" }],
      autonomyEnvelope: {},
      humanAuthorities: {},
      evaluationPolicy: {},
      initialPlan: { summary: "Build and verify the accepted result" },
      initialContinuation: { kind: "verification", summary: "Verify the next result" },
    }, ownerAgentId);

    const wakeupId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      orgId,
      agentId: ownerAgentId,
      source: "on_demand",
      triggerDetail: "system",
      reason: "goal_continuation",
      payload: {
        goalId: active.id,
        checkpointId: randomUUID(),
        planRevision: active.planRevision,
        continuation: { kind: "verification", summary: "Verify the queued continuation" },
      },
      status: "queued",
      requestedByActorType: "agent",
      requestedByActorId: ownerAgentId,
      idempotencyKey: `goal-continuation:${randomUUID()}`,
      requestedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      orgId,
      agentId: ownerAgentId,
      status: "queued",
      invocationSource: "on_demand",
      wakeupRequestId: wakeupId,
      // Legacy persisted Runs may carry the Goal ID but only the wake request has its reason.
      contextSnapshot: { goalId: active.id },
      startedAt: new Date(),
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupId));

    const heartbeat = heartbeatService(db);
    const heldLock = await holdGoalRowLock(db, active.id);
    const result = service.createResultProposal(active.id, {
      evidenceRefs: ["artifact://goal/accepted-result"],
      criteria: [{ id: "result", status: "met" }],
      resultPayload: { artifact: "artifact://goal/accepted-result" },
      contractRevision: active.contractRevision,
      riskSummary: "No known remaining risk.",
      idempotencyKey: `goal-result:${randomUUID()}`,
    }, ownerAgentId);
    let claim: Promise<unknown> | null = null;
    let claimExpectation: Promise<void> | null = null;
    try {
      await waitForDatabaseLockWaiters(db, 1);
      claim = heartbeat.startNextQueuedRunForAgent(ownerAgentId);
      claimExpectation = expect(claim).resolves.toBeDefined();
      await waitForDatabaseLockWaiters(db, 2);
    } catch (error) {
      heldLock.release();
      await Promise.allSettled([
        heldLock.transaction,
        result,
        ...(claim ? [claim] : []),
        ...(claimExpectation ? [claimExpectation] : []),
      ]);
      throw error;
    }

    heldLock.release();
    await heldLock.transaction;
    const [proposal] = await Promise.all([result, claimExpectation!]);
    expect(proposal).toMatchObject({ status: "ready" });
    expect(await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId)))
      .toMatchObject([{ status: "cancelled", errorCode: "goal.result_proposal_ready" }]);
    expect(await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupId)))
      .toMatchObject([{ status: "cancelled" }]);
  }, 30_000);

  it("admits idempotent Goal start and feedback intents into exactly one Run each", async () => {
    const orgId = randomUUID();
    const ownerAgentId = randomUUID();
    const orgName = `Goal admission ${orgId.slice(0, 8)}`;
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `W${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      orgId,
      name: "Goal admission owner",
      role: "engineer",
      status: "idle",
      capabilities: "Plans and executes end-to-end software work with inspectable evidence.",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const service = goalService(db);
    const heartbeat = heartbeatService(db);
    const preview = await service.previewStart(orgId, {
      title: "Ship a verified Goal admission result",
      context: "The Owner processes start and feedback exactly once with durable evidence.",
      ownerAgentId,
      targetTime: "2026-08-30T10:00:00.000Z",
    });
    expect(preview.valid).toBe(true);
    expect(preview.packet).not.toBeNull();
    const requestKey = randomUUID();
    const started = await service.start(orgId, {
      requestKey,
      packetHash: preview.packetHash!,
      packet: preview.packet!,
    }, { actorType: "user", actorId: "start-user" });

    const dispatchStart = () => heartbeat.wakeup(started.dispatch.ownerAgentId, {
      ...started.dispatch,
      existingWakeupRequestId: started.dispatch.wakeupRequestId,
      startImmediately: false,
    });
    const [startRunA, startRunB] = await Promise.all([dispatchStart(), dispatchStart()]);
    expect(startRunA?.id).toBe(startRunB?.id);

    const feedbackInput = {
      body: "Keep the acceptance evidence visible in the Goal Workspace.",
      attachments: [],
      feedbackKind: "ordinary" as const,
      idempotencyKey: randomUUID(),
    };
    const feedbackResults = await Promise.all(Array.from({ length: 6 }, () => (
      service.feedback(started.goal.id, feedbackInput, "feedback-user")
    )));
    expect(new Set(feedbackResults.map((result) => result.feedback.id)).size).toBe(1);
    expect(new Set(feedbackResults.map((result) => result.dispatch.wakeupRequestId)).size).toBe(1);
    const feedbackDispatch = feedbackResults[0]!.dispatch;
    const dispatchFeedback = () => heartbeat.wakeup(feedbackDispatch.ownerAgentId, {
      ...feedbackDispatch,
      existingWakeupRequestId: feedbackDispatch.wakeupRequestId,
      startImmediately: false,
    });
    const [feedbackRunA, feedbackRunB] = await Promise.all([dispatchFeedback(), dispatchFeedback()]);
    expect(feedbackRunA?.id).toBe(feedbackRunB?.id);
    expect(feedbackRunA?.id).not.toBe(startRunA?.id);

    const persistedFeedback = await db.select().from(goalFeedbackEntries)
      .where(eq(goalFeedbackEntries.goalId, started.goal.id));
    expect(persistedFeedback).toHaveLength(1);
    const wakeups = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, ownerAgentId));
    expect(wakeups).toHaveLength(2);
    expect(wakeups.every((wakeup) => wakeup.source === "on_demand" && wakeup.triggerDetail === "system")).toBe(true);
    expect(wakeups.every((wakeup) => Boolean(wakeup.runId))).toBe(true);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, ownerAgentId));
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.goalId === started.goal.id)).toBe(true);
    expect(new Set(runs.map((run) => run.wakeupRequestId))).toEqual(new Set(wakeups.map((wakeup) => wakeup.id)));

    const recoveryFeedback = await service.feedback(started.goal.id, {
      ...feedbackInput,
      body: "Recover this committed feedback intent after a simulated restart boundary.",
      idempotencyKey: randomUUID(),
    }, "feedback-user");
    expect(recoveryFeedback.feedback.routedWakeupRequestId).toBe(recoveryFeedback.dispatch.wakeupRequestId);
    expect((await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, recoveryFeedback.dispatch.wakeupRequestId)))).toHaveLength(0);
    const recovery = await heartbeat.resumePendingWakeupRequests({ startImmediately: false });
    expect(recovery.resumed).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, recoveryFeedback.dispatch.wakeupRequestId)))).toMatchObject([
      expect.objectContaining({ goalId: started.goal.id }),
    ]);
  }, 30_000);

  it("rejects a Goal wake that crosses the Agent organization boundary", async () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgA,
        name: `Goal scope A ${orgA.slice(0, 8)}`,
        urlKey: deriveOrganizationUrlKey(`Goal scope A ${orgA.slice(0, 8)}`),
        issuePrefix: `SA${orgA.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: orgB,
        name: `Goal scope B ${orgB.slice(0, 8)}`,
        urlKey: deriveOrganizationUrlKey(`Goal scope B ${orgB.slice(0, 8)}`),
        issuePrefix: `SB${orgB.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values([
      {
        id: agentA,
        orgId: orgA,
        name: "Scope agent A",
        role: "engineer",
        status: "idle",
        capabilities: "Tests Goal scope.",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentB,
        orgId: orgB,
        name: "Scope agent B",
        role: "engineer",
        status: "idle",
        capabilities: "Tests Goal scope.",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    const goal = await goalService(db).create(orgB, { title: "Goal owned by organization B", ownerAgentId: agentB });
    const heartbeat = heartbeatService(db);

    await expect(heartbeat.wakeup(agentA, {
      source: "on_demand",
      triggerDetail: "system",
      reason: "goal_feedback",
      payload: { goalId: goal.id },
      contextSnapshot: { goalId: goal.id },
      startImmediately: false,
    })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentA))).toEqual([]);
  });

  it("defers non-Focus Goal admission and recovers exactly once after Focus moves", async () => {
    const orgId = randomUUID();
    const ownerAgentId = randomUUID();
    const orgName = `Goal focus admission ${orgId.slice(0, 8)}`;
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `F${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      orgId,
      name: "Focus Goal owner",
      role: "engineer",
      status: "idle",
      capabilities: "Plans and executes end-to-end software work with inspectable evidence.",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const service = goalService(db);
    const heartbeat = heartbeatService(db);
    const start = async (title: string) => {
      const preview = await service.previewStart(orgId, {
        title,
        context: "The Owner delivers one inspectable software result.",
        ownerAgentId,
        targetTime: null,
      });
      expect(preview.valid).toBe(true);
      return service.start(orgId, {
        requestKey: randomUUID(),
        packetHash: preview.packetHash!,
        packet: preview.packet!,
      }, { actorType: "user", actorId: "focus-user" });
    };

    const first = await start("Ship the first Focus Goal result");
    await service.setFocus(first.goal.id, true);
    await heartbeat.wakeup(first.dispatch.ownerAgentId, {
      ...first.dispatch,
      existingWakeupRequestId: first.dispatch.wakeupRequestId,
      startImmediately: false,
    });

    const second = await start("Ship the second Goal result after Focus moves");
    const deferredRun = await heartbeat.wakeup(second.dispatch.ownerAgentId, {
      ...second.dispatch,
      existingWakeupRequestId: second.dispatch.wakeupRequestId,
      startImmediately: false,
    });
    expect(deferredRun).toBeNull();
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, second.dispatch.wakeupRequestId))
      .then((rows) => rows[0])).toMatchObject({
        status: "deferred_goal_focus",
        runId: null,
        error: "goal.focused_elsewhere",
      });
    expect(await service.workspace(second.goal.id)).toMatchObject({
      facet: "waiting_focus",
      attention: null,
    });

    await service.setFocus(second.goal.id, true);
    const recovered = await heartbeat.resumePendingWakeupRequests({ startImmediately: false });
    expect(recovered.resumed).toBeGreaterThanOrEqual(1);
    const recoveredRuns = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, second.dispatch.wakeupRequestId));
    expect(recoveredRuns).toHaveLength(1);
    const replay = await heartbeat.resumePendingWakeupRequests({ startImmediately: false });
    expect(replay.resumed).toBe(0);
    expect(await service.workspace(second.goal.id)).toMatchObject({ facet: "agent_advancing" });
    const focused = await db.select({ id: goals.id }).from(goals).where(and(
      eq(goals.orgId, orgId),
      eq(goals.focus, true),
    ));
    expect(focused).toEqual([{ id: second.goal.id }]);
  }, 30_000);

  it("projects direct Goal Runs and preserves Run attribution through progress and result evidence", async () => {
    const orgId = randomUUID();
    const ownerAgentId = randomUUID();
    const delegatedAgentId = randomUUID();
    const orgName = `Goal direct run ${orgId.slice(0, 8)}`;
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `D${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        orgId,
        name: "Direct Goal run owner",
        role: "engineer",
        status: "idle",
        capabilities: "Plans and executes end-to-end software work with inspectable evidence.",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: delegatedAgentId,
        orgId,
        name: "Different Goal run actor",
        role: "engineer",
        status: "idle",
        capabilities: "Executes delegated software checks.",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const service = goalService(db);
    const draft = await service.create(orgId, {
      title: "Ship the direct Goal Run result",
      ownerAgentId,
    });
    const active = await service.activate(draft.id, {
      confirmed: true,
      ownerAgentId,
      outcomeStatement: "The direct Goal Run result is available",
      objectiveMode: "target",
      criteria: [{ id: "result", label: "Result exists", evaluator: "artifact" }],
      autonomyEnvelope: {},
      humanAuthorities: {},
      evaluationPolicy: {},
      initialPlan: { summary: "Build and verify the direct result" },
      initialContinuation: { kind: "verification", summary: "Verify the direct result" },
    }, ownerAgentId);
    const otherGoal = await service.create(orgId, {
      title: "Keep another Goal isolated",
      ownerAgentId,
    });
    const [directRun, unlinkedRun, wrongActorRun] = await db.insert(heartbeatRuns).values([
      {
        orgId,
        agentId: ownerAgentId,
        goalId: active.id,
        status: "running",
        contextSnapshot: { goalId: active.id },
        resultSummaryJson: { summary: "Validating the direct Goal artifact." },
      },
      {
        orgId,
        agentId: ownerAgentId,
        status: "running",
        contextSnapshot: { goalId: otherGoal.id },
      },
      {
        orgId,
        agentId: delegatedAgentId,
        status: "running",
        contextSnapshot: { goalId: active.id },
      },
    ]).returning();

    expect(await service.workspace(active.id)).toMatchObject({
      agentAction: {
        summary: expect.stringContaining("Validating the direct Goal artifact."),
        sourceIds: [directRun!.id],
      },
    });
    await db.update(heartbeatRuns).set({
      status: "failed",
      resultJson: { error: "Process adapter missing command" },
      resultSummaryJson: null,
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, directRun!.id));
    expect(await service.workspace(active.id)).toMatchObject({
      facet: "needs_attention",
      agentAction: {
        summary: "The Agent could not complete its latest action.",
        status: "failed",
      },
      attention: {
        kind: "owner_blocked",
        reason: expect.stringContaining("could not complete its latest action"),
        sourceId: directRun!.id,
      },
    });
    await db.update(heartbeatRuns).set({
      status: "running",
      resultJson: null,
      resultSummaryJson: { summary: "Validating the direct Goal artifact." },
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, directRun!.id));
    await expect(service.createActivity(active.id, {
      summary: "This Run belongs to another Goal",
      activityKind: "progress",
      runRef: unlinkedRun!.id,
      evidenceRefs: ["artifact://goal-direct-run/unlinked"],
    }, ownerAgentId)).rejects.toMatchObject({ status: 422 });
    await expect(service.createActivity(active.id, {
      summary: "This Run belongs to another Agent",
      activityKind: "progress",
      runRef: wrongActorRun!.id,
      evidenceRefs: ["artifact://goal-direct-run/wrong-actor"],
    }, ownerAgentId)).rejects.toMatchObject({ status: 422 });

    const progress = await service.createActivity(active.id, {
      summary: "The direct Goal artifact passed its first check",
      activityKind: "progress",
      runRef: directRun!.id,
      evidenceRefs: ["artifact://goal-direct-run/progress"],
      idempotencyKey: "goal-direct-run-progress",
    }, ownerAgentId);
    expect(progress).toMatchObject({ runRef: directRun!.id });

    await db.update(heartbeatRuns).set({
      status: "succeeded",
      resultSummaryJson: { summary: "The direct Goal artifact passed its first check." },
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, directRun!.id));

    const [newerFailedRun] = await db.insert(heartbeatRuns).values({
      orgId,
      agentId: ownerAgentId,
      goalId: active.id,
      status: "failed",
      contextSnapshot: { goalId: active.id },
      resultJson: { error: "Process adapter missing command" },
      updatedAt: new Date(Date.now() + 1_000),
    }).returning();
    expect(await service.workspace(active.id)).toMatchObject({
      facet: "needs_attention",
      agentAction: {
        summary: "The Agent could not complete its latest action.",
        status: "failed",
      },
      attention: {
        kind: "owner_blocked",
        sourceId: newerFailedRun!.id,
      },
    });
    expect((await service.workspaceCards(orgId)).find((card) => card.id === active.id)).toMatchObject({
      facet: "needs_attention",
    });

    const resultInput = {
      evidenceRefs: ["artifact://goal-direct-run/result"],
      criteria: [{ id: "result", status: "met" }],
      resultPayload: { artifact: "artifact://goal-direct-run/result" },
      contractRevision: active.contractRevision,
      riskSummary: "No known remaining risk.",
      idempotencyKey: "goal-direct-run-result",
    };
    const proposal = await service.createResultProposal(active.id, resultInput, ownerAgentId, directRun!.id);
    expect(proposal.status).toBe("ready");
    await expect(service.createResultProposal(active.id, resultInput, delegatedAgentId, wrongActorRun!.id))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.createResultProposal(active.id, resultInput, ownerAgentId, unlinkedRun!.id))
      .rejects.toMatchObject({ status: 422 });

    const evidence = (await db.select().from(goalActivities).where(eq(goalActivities.goalId, active.id)))
      .find((activity) => activity.idempotencyKey === "goal-result-evidence:goal-direct-run-result");
    expect(evidence).toMatchObject({
      activityKind: "evidence",
      runRef: directRun!.id,
      evidenceRefs: ["artifact://goal-direct-run/result"],
    });
    expect(await service.workspace(active.id)).toMatchObject({
      currentProgress: {
        sourceActivityId: evidence!.id,
        evidence: [{ label: "Supporting work 1", href: null, external: false }],
      },
      attention: { kind: "result_proposal", sourceId: proposal.id },
    });
  }, 30_000);

  it("serializes concurrent Focus changes without deadlocking", async () => {
    const orgId = randomUUID();
    const ownerAgentId = randomUUID();
    const orgName = `Goal focus race ${orgId.slice(0, 8)}`;
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `R${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      orgId,
      name: "Concurrent Focus owner",
      role: "engineer",
      status: "idle",
      capabilities: "Plans and executes end-to-end software work with inspectable evidence.",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const service = goalService(db);
    const start = async (title: string) => {
      const preview = await service.previewStart(orgId, {
        title,
        context: "The Owner delivers one inspectable software result.",
        ownerAgentId,
        targetTime: null,
      });
      expect(preview.valid).toBe(true);
      return service.start(orgId, {
        requestKey: randomUUID(),
        packetHash: preview.packetHash!,
        packet: preview.packet!,
      }, { actorType: "user", actorId: "focus-race-user" });
    };
    const [first, second] = await Promise.all([
      start("Ship the first concurrent Focus result"),
      start("Ship the second concurrent Focus result"),
    ]);

    await Promise.all([
      service.setFocus(first.goal.id, true),
      service.setFocus(second.goal.id, true),
    ]);

    const focused = await db.select({ id: goals.id }).from(goals).where(and(
      eq(goals.orgId, orgId),
      eq(goals.focus, true),
    ));
    expect(focused).toHaveLength(1);
    expect([first.goal.id, second.goal.id]).toContain(focused[0]!.id);
  }, 30_000);

  it("rechecks Focus at claim and never moves a bound intent back to deferred", async () => {
    const orgId = randomUUID();
    const ownerAgentId = randomUUID();
    const orgName = `Goal claim admission ${orgId.slice(0, 8)}`;
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `C${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      orgId,
      name: "Claim-time Focus owner",
      role: "engineer",
      status: "idle",
      capabilities: "Plans and executes end-to-end software work with inspectable evidence.",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const service = goalService(db);
    const start = async (title: string) => {
      const preview = await service.previewStart(orgId, {
        title,
        context: "The Owner delivers one inspectable software result.",
        ownerAgentId,
        targetTime: null,
      });
      expect(preview.valid).toBe(true);
      return service.start(orgId, {
        requestKey: randomUUID(),
        packetHash: preview.packetHash!,
        packet: preview.packet!,
      }, { actorType: "user", actorId: "claim-focus-user" });
    };

    const first = await start("Keep this Goal focused before claim");
    const second = await start("Defer this Goal when Focus changes before claim");
    let targetWakeupRequestId: string | null = second.dispatch.wakeupRequestId;
    const heartbeat = heartbeatService(db, {
      beforeRunClaim: async (run) => {
        if (run.wakeupRequestId !== targetWakeupRequestId) return;
        targetWakeupRequestId = null;
        await service.setFocus(first.goal.id, true);
      },
    });

    await heartbeat.wakeup(second.dispatch.ownerAgentId, {
      ...second.dispatch,
      existingWakeupRequestId: second.dispatch.wakeupRequestId,
    });
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, second.dispatch.wakeupRequestId))
      .then((rows) => rows[0])).toMatchObject({
        status: "deferred_goal_focus",
        runId: null,
        error: "goal.focused_elsewhere",
      });
    expect(await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, second.dispatch.wakeupRequestId))).toHaveLength(0);

    await service.setFocus(second.goal.id, true);
    const boundRun = await heartbeat.wakeup(second.dispatch.ownerAgentId, {
      ...second.dispatch,
      existingWakeupRequestId: second.dispatch.wakeupRequestId,
      startImmediately: false,
    });
    expect(boundRun?.id).toBeTruthy();
    await service.setFocus(first.goal.id, true);
    expect(await heartbeat.wakeup(second.dispatch.ownerAgentId, {
      ...second.dispatch,
      existingWakeupRequestId: second.dispatch.wakeupRequestId,
      startImmediately: false,
    })).toBeNull();
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, second.dispatch.wakeupRequestId))
      .then((rows) => rows[0])).toMatchObject({
        status: "queued",
        runId: boundRun!.id,
      });
  }, 30_000);

  it("persists Goal change decisions as idempotent Owner continuation intents", async () => {
    const orgId = randomUUID();
    const ownerAgentId = randomUUID();
    const orgName = `Goal decision continuation ${orgId.slice(0, 8)}`;
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `D${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      orgId,
      name: "Decision Goal owner",
      role: "engineer",
      status: "idle",
      capabilities: "Plans and executes end-to-end software work with inspectable evidence.",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const service = goalService(db);
    const heartbeat = heartbeatService(db);
    const draft = await service.create(orgId, { title: "Ship a governed Goal result", ownerAgentId });
    const active = await service.activate(draft.id, {
      confirmed: true,
      ownerAgentId,
      outcomeStatement: "The governed Goal result is available",
      objectiveMode: "target",
      criteria: [{ id: "result", label: "Result exists", evaluator: "artifact" }],
      autonomyEnvelope: {},
      humanAuthorities: {},
      evaluationPolicy: {},
      initialPlan: { summary: "Build the governed result" },
      initialContinuation: { kind: "commitment", summary: "Continue after the human decision" },
    }, ownerAgentId);

    const decide = async (decision: "approve" | "reject", expectedContractRevision: number) => {
      const approvalId = randomUUID();
      await db.insert(approvals).values({
        id: approvalId,
        orgId,
        type: "goal_change",
        requestedByAgentId: ownerAgentId,
        status: "pending",
        payload: {},
      });
      const proposal = await service.createChangeProposal(active.id, {
        expectedContractRevision,
        afterContract: { outcomeStatement: `The governed Goal result reflects ${decision}` },
        rationale: `Human must ${decision} this Goal change.`,
        evidenceRefs: [`artifact://goal-decision/${decision}`],
        approvalId,
        idempotencyKey: `goal-change-${decision}`,
      }, ownerAgentId);
      return service.decideChangeProposal(proposal.id, {
        decision,
        note: `Human chose to ${decision} the proposed direction.`,
      }, "decision-user");
    };

    const approved = await decide("approve", active.contractRevision);
    expect(approved.dispatch.contextSnapshot).toMatchObject({
      goal: { contractRevision: 2, outcomeStatement: "The governed Goal result reflects approve" },
      goalDecision: {
        decision: "approve",
        status: "applied",
        note: "Human chose to approve the proposed direction.",
      },
    });
    const approvedReplay = await service.decideChangeProposal(approved.proposal.id, {
      decision: "approve",
      note: "A replay must not replace the original human decision note.",
    }, "decision-user");
    expect(approvedReplay.dispatch.contextSnapshot).toMatchObject({
      goalDecision: {
        decision: "approve",
        status: "applied",
        note: "Human chose to approve the proposed direction.",
      },
    });
    const approvedRun = await heartbeat.wakeup(approved.dispatch.ownerAgentId, {
      ...approved.dispatch,
      existingWakeupRequestId: approved.dispatch.wakeupRequestId,
      startImmediately: false,
    });
    expect(approvedRun?.id).toBeTruthy();

    const rejected = await decide("reject", 2);
    expect(rejected.dispatch.contextSnapshot).toMatchObject({
      goal: { contractRevision: 2, outcomeStatement: "The governed Goal result reflects approve" },
      goalDecision: {
        decision: "reject",
        status: "rejected",
        note: "Human chose to reject the proposed direction.",
      },
    });
    const rejectedRun = await heartbeat.wakeup(rejected.dispatch.ownerAgentId, {
      ...rejected.dispatch,
      existingWakeupRequestId: rejected.dispatch.wakeupRequestId,
      startImmediately: false,
    });
    expect(rejectedRun?.id).toBeTruthy();
    const rejectedReplay = await heartbeat.wakeup(rejected.dispatch.ownerAgentId, {
      ...rejected.dispatch,
      existingWakeupRequestId: rejected.dispatch.wakeupRequestId,
      startImmediately: false,
    });
    expect(rejectedReplay?.id).toBe(rejectedRun?.id);
    expect(await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, rejected.dispatch.wakeupRequestId))).toHaveLength(1);
  }, 30_000);

  it("binds displayed Goal approval content and terminalizes it when the Goal result is accepted", async () => {
    const orgId = randomUUID();
    const ownerAgentId = randomUUID();
    const approvalId = randomUUID();
    const orgName = `Goal approval ${orgId.slice(0, 8)}`;
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `A${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      orgId,
      name: "Goal owner",
      role: "engineer",
      status: "idle",
      capabilities: "Plans and executes end-to-end software work with inspectable evidence.",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(approvals).values({
      id: approvalId,
      orgId,
      type: "goal_change",
      requestedByAgentId: ownerAgentId,
      status: "pending",
      payload: {
        rationale: "A harmless-looking placeholder that must be replaced.",
        afterContract: { outcomeStatement: "Keep the Goal unchanged" },
      },
    });

    const service = goalService(db);
    const draft = await service.create(orgId, {
      title: "Ship the verified result",
      ownerAgentId,
    });
    const active = await service.activate(draft.id, {
      confirmed: true,
      ownerAgentId,
      outcomeStatement: "The verified result is available",
      objectiveMode: "target",
      criteria: [{ id: "result", label: "Result exists", evaluator: "artifact" }],
      autonomyEnvelope: {},
      humanAuthorities: {},
      evaluationPolicy: {},
      initialPlan: { summary: "Build and verify the result" },
      initialContinuation: { kind: "verification", summary: "Verify the next result" },
    }, ownerAgentId);
    const change = await service.createChangeProposal(active.id, {
      expectedContractRevision: active.contractRevision,
      afterContract: { outcomeStatement: "The verified result is available after restart" },
      rationale: "Restart evidence changes the committed outcome.",
      evidenceRefs: ["artifact://restart-proof"],
      approvalId,
      idempotencyKey: "bound-change",
    }, ownerAgentId);
    const [boundApproval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(boundApproval.payload).toMatchObject({
      goalId: active.id,
      proposalId: change.id,
      rationale: "Restart evidence changes the committed outcome.",
      afterContract: { outcomeStatement: "The verified result is available after restart" },
    });
    expect(JSON.stringify(boundApproval.payload)).not.toContain("harmless-looking placeholder");

    const result = await service.createResultProposal(active.id, {
      evidenceRefs: ["artifact://verified-result"],
      criteria: [{ id: "result", status: "met" }],
      resultPayload: { artifact: "artifact://verified-result" },
      contractRevision: active.contractRevision,
      riskSummary: "No known remaining risk.",
      idempotencyKey: "result-with-pending-change",
    }, ownerAgentId);
    await expect(service.acceptResultProposal(result.id, {
      idempotencyKey: "accept-with-pending-change",
    }, "acceptance-user")).resolves.toMatchObject({ lifecycle: "closed", status: "achieved" });

    const [closedChange] = await db.select().from(goalChangeProposals).where(eq(goalChangeProposals.id, change.id));
    const [closedApproval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(closedChange.status).toBe("superseded");
    expect(closedApproval).toMatchObject({
      status: "cancelled",
      decidedByUserId: "acceptance-user",
    });
    expect(closedApproval.decisionNote).toMatch(/Goal result was accepted/i);

    const workspace = await service.workspace(active.id);
    expect(workspace.currentProgress).toMatchObject({
      summary: "Goal achieved",
      evidence: [{ label: "Supporting work 1", href: null, external: false }],
    });
  }, 30_000);
});
