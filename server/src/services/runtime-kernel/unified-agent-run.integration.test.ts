import {
  agents,
  applyPendingMigrations,
  chatConversations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunAttempts,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  organizations,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { heartbeatService } from "../heartbeat.js";
import { createHeartbeatAdmissionHandlers } from "./heartbeat.admission.js";
import { checkProcessLossRetrySubmission } from "./heartbeat.reapers.js";
import { transitionHeartbeatRunToTerminal } from "./heartbeat.terminal.js";
import { currentNativeSession, ensureRuntimeBinding } from "./native-session.js";
import type { UnifiedAgentRunPersistenceAdapter } from "./unified-agent-run.integration.js";
import {
  createHeartbeatUnifiedAgentRunAdapter,
  createInMemoryUnifiedAgentRunAdapter,
  createUnifiedAgentRunExecutionService,
  createUnifiedAgentRunService,
} from "./unified-agent-run.integration.js";
import { createUnifiedAgentRunLedger } from "./unified-agent-run.js";

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
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
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
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function startTempDatabase() {
  const externalConnectionString = process.env.RUDDER_UNIFIED_AGENT_RUN_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-unified-agent-run-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
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

function clock() {
  let now = new Date("2026-09-22T00:00:00.000Z");
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

function admission(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-1",
    agentId: "agent-1",
    scene: "chat" as const,
    target: { type: "chat_conversation" as const, id: "conversation-1" },
    idempotencyKey: "turn-1",
    runtimeType: "codex_local",
    sessionIntent: { kind: "resume" as const, reuseScope: "explicit" as const, sessionId: "thread-1" },
    ...overrides,
  };
}

async function seedNativeChatIdentity(
  db: ReturnType<typeof createDb>,
  input: {
    agentRuntimeType?: string;
    bindingRuntimeType?: string;
    segmentRuntimeType?: string;
  } = {},
) {
  const orgId = randomUUID();
  const agentId = randomUUID();
  const conversationId = randomUUID();
  const bindingId = randomUUID();
  const segmentId = randomUUID();
  const bindingRuntimeType = input.bindingRuntimeType ?? "codex_local";
  const segmentRuntimeType = input.segmentRuntimeType ?? bindingRuntimeType;
  await db.insert(organizations).values({
    id: orgId,
    name: `Runtime Identity Org ${orgId}`,
    urlKey: deriveOrganizationUrlKey(`Runtime Identity ${orgId}`),
    issuePrefix: "RID",
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    orgId,
    name: "Runtime Identity Agent",
    role: "engineer",
    agentRuntimeType: input.agentRuntimeType ?? "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: {},
  });
  await db.insert(chatConversations).values({
    id: conversationId,
    orgId,
    title: "Runtime Identity Conversation",
    issueCreationMode: "manual_approval",
    planMode: false,
  });
  await db.insert(runtimeBindings).values({
    id: bindingId,
    orgId,
    conversationId,
    principalScopeRef: "test:principal",
    agentId,
    runtimeType: bindingRuntimeType,
    profileId: "default",
    continuity: "native",
  });
  await db.insert(nativeSegments).values({
    id: segmentId,
    orgId,
    bindingId,
    runtimeType: segmentRuntimeType,
    segmentOrdinal: 0,
    state: "open",
  });
  await db.update(runtimeBindings)
    .set({ currentSegmentId: segmentId })
    .where(and(eq(runtimeBindings.id, bindingId), eq(runtimeBindings.orgId, orgId)));
  return { orgId, agentId, conversationId, bindingId, segmentId };
}

describe("unified agent run persistence boundary", () => {
  it("delegates async admission and owner fencing without adding scheduler methods", async () => {
    const time = clock();
    const ledger = createUnifiedAgentRunLedger({ now: time.now, defaultLeaseMs: 100 });
    const memoryAdapter = createInMemoryUnifiedAgentRunAdapter(ledger);
    const calls: string[] = [];
    const persistedShapedAdapter: UnifiedAgentRunPersistenceAdapter = {
      admit: async (input) => {
        calls.push("admit");
        return memoryAdapter.admit(input);
      },
      get: (runId) => memoryAdapter.get(runId),
      claimOwner: async (runId, input) => {
        calls.push("claimOwner");
        return memoryAdapter.claimOwner(runId, input);
      },
      renewOwner: async (runId, fence) => {
        calls.push("renewOwner");
        return memoryAdapter.renewOwner(runId, fence);
      },
    };
    const service = createUnifiedAgentRunService(persistedShapedAdapter);
    const execution = createUnifiedAgentRunExecutionService(memoryAdapter);

    const first = await service.admit(admission());
    const duplicate = await service.admit(admission());
    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({ created: false, entry: { runId: first.entry.runId } });

    const renewed = await service.renewOwner(first.entry.runId, first.entry.ownerFence);
    expect(renewed).toMatchObject({ ok: true, value: { ownerToken: first.entry.ownerFence.ownerToken } });

    time.advance(101);
    const claimed = await service.claimOwner(first.entry.runId, { ownerToken: "recovery-owner" });
    expect(claimed).toMatchObject({
      ok: true,
      value: { ownerToken: "recovery-owner", attemptEpoch: 2 },
    });
    if (!claimed.ok) throw new Error("expected expired owner lease to be claimable");

    expect(await execution.finishRun(first.entry.runId, first.entry.ownerFence, "succeeded"))
      .toEqual({ ok: false, reason: "stale_owner" });
    expect(await execution.finishRun(first.entry.runId, claimed.value, "succeeded"))
      .toMatchObject({ ok: true, value: { status: "succeeded" } });

    expect(calls).toEqual(["admit", "admit", "renewOwner", "claimOwner"]);
    expect("schedule" in persistedShapedAdapter).toBe(false);
    expect("poll" in persistedShapedAdapter).toBe(false);
    expect("execute" in persistedShapedAdapter).toBe(false);
  });

  it("turns synchronous contract failures into service promise rejections", async () => {
    const service = createUnifiedAgentRunService(
      createInMemoryUnifiedAgentRunAdapter(createUnifiedAgentRunLedger()),
    );

    await expect(service.admit(admission({ orgId: "" }))).rejects.toThrow("orgId must be a non-empty string");
  });
});

describe("heartbeat-backed unified agent run adapter", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(runRuntimeSpans);
    await db.delete(nativeSegments);
    await db.delete(runtimeBindings);
    await db.delete(heartbeatRunAttempts);
    await db.delete(heartbeatRuns);
    await db.delete(chatConversations);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function admitOrphanedNativeRun(state: "acceptance_unknown" | "accepted" | "pending") {
    const seeded = await seedNativeChatIdentity(db);
    const targetId = randomUUID();
    const binding = await ensureRuntimeBinding(db, {
      orgId: seeded.orgId, agentId: seeded.agentId, runtimeType: "codex_local",
      target: { type: "wakeup_request", id: targetId }, continuity: "native",
    });
    const session = await currentNativeSession(db, binding);
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const admitted = await adapter.admit({
      orgId: seeded.orgId, agentId: seeded.agentId, scene: "heartbeat",
      target: { type: "wakeup_request", id: targetId },
      idempotencyKey: `orphan-${targetId}`, runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" }, runtimeBindingId: binding.id,
      runtimeSegmentId: session.segment.id,
    });
    const provider = { providerThreadId: "provider-thread", providerTurnId: "provider-turn" };
    if (state === "accepted") {
      await adapter.acceptSubmission(admitted.entry.runId, admitted.entry.ownerFence, provider);
    } else if (state === "acceptance_unknown") {
      await adapter.markAcceptanceUnknown(admitted.entry.runId, admitted.entry.ownerFence, provider);
    }
    return { runId: admitted.entry.runId, agentId: seeded.agentId };
  }

  it.each(["acceptance_unknown", "accepted", "pending"] as const)(
    "never creates a process-loss retry for a %s native submission after parallel orphan claims",
    async (state) => {
      const { runId, agentId } = await admitOrphanedNativeRun(state);
      const now = new Date();
      await db.update(heartbeatRuns).set({
        processPid: 999_999_999,
        executionLeaseExpiresAt: new Date(now.getTime() - 1),
      }).where(eq(heartbeatRuns.id, runId));

      const results = await Promise.all([
        heartbeatService(db).reapOrphanedRuns({ now, recoveryCutoff: now }),
        heartbeatService(db).reapOrphanedRuns({ now, recoveryCutoff: now }),
      ]);
      expect(results.reduce((count, result) => count + result.reaped, 0)).toBe(1);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: runId, status: "failed", errorCode: "process_lost_acceptance_unresolved" });
      expect(runs[0]?.terminalEffectsJson).toBeNull();
      const [attempt] = await db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, runId));
      expect((attempt!.checkpointJson as Record<string, any>).unifiedSubmission).toMatchObject({
        state: state === "pending" ? "acceptance_unknown" : state,
        providerThreadId: state === "pending" ? null : "provider-thread",
        providerTurnId: state === "pending" ? null : "provider-turn",
      });
    },
  );

  it.each(["acceptance_unknown", "accepted"] as const)(
    "drops a persisted process-loss retry intent for %s native submission after restart",
    async (state) => {
      const { runId, agentId } = await admitOrphanedNativeRun(state);
      await transitionHeartbeatRunToTerminal(db, {
        runId, status: "failed", patch: { finishedAt: new Date(), errorCode: "process_lost" },
        processExitedAt: new Date(), terminalEffectsIntent: { version: 1, processLossRetry: true },
      });
      const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(before?.terminalEffectsJson).toMatchObject({ processLossRetry: true });

      const results = await Promise.all([
        heartbeatService(db).reapOrphanedRuns(),
        heartbeatService(db).reapOrphanedRuns(),
      ]);
      expect(results.reduce((count, result) => count + result.reaped, 0)).toBe(1);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: runId, status: "failed", terminalEffectsPending: false });
    },
  );

  it("does not infer a stopped provider writer from a lost PID after restart", async () => {
    const { runId, agentId } = await admitOrphanedNativeRun("acceptance_unknown");
    const now = new Date();
    await db.update(heartbeatRuns).set({ executionLeaseExpiresAt: new Date(now.getTime() - 1) })
      .where(eq(heartbeatRuns.id, runId));
    const result = await heartbeatService(db).reapOrphanedRuns({ now, recoveryCutoff: now });
    expect(result.reaped).toBe(0);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "running", processPid: null });
  });

  it("does not retry a native submission after a recorded exit with no remaining PID", async () => {
    const { runId, agentId } = await admitOrphanedNativeRun("accepted");
    const now = new Date();
    await db.update(heartbeatRuns).set({
      processPid: null, processExitedAt: now,
      executionLeaseExpiresAt: new Date(now.getTime() - 1),
    }).where(eq(heartbeatRuns.id, runId));
    const result = await heartbeatService(db).reapOrphanedRuns({ now, recoveryCutoff: now });
    expect(result.reaped).toBe(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: runId, status: "failed", processPid: null });
  });

  it("still blocks retry from durable submission evidence with a legacy-shaped Run readback", async () => {
    const { runId } = await admitOrphanedNativeRun("acceptance_unknown");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run?.scene).toBe("heartbeat");
    await expect(checkProcessLossRetrySubmission(db, {
      ...run!, scene: null, idempotencyKey: null, contextSnapshot: {},
    })).resolves.toMatchObject({
      allowed: false, reason: "submission_acceptance_unknown",
    });
  });

  it.each(["acceptance_unknown", "pending", "accepted"] as const)(
    "fails closed across claim and boundary rebuild for %s provider submission",
    async (state) => {
      const seeded = await seedNativeChatIdentity(db);
      const targetId = randomUUID();
      const binding = await ensureRuntimeBinding(db, {
        orgId: seeded.orgId,
        agentId: seeded.agentId,
        runtimeType: "codex_local",
        target: { type: "wakeup_request", id: targetId },
        continuity: "native",
      });
      const session = await currentNativeSession(db, binding);
      const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
      const admitted = await adapter.admit({
        orgId: seeded.orgId,
        agentId: seeded.agentId,
        scene: "heartbeat",
        target: { type: "wakeup_request", id: targetId },
        idempotencyKey: `recovery-${state}-${targetId}`,
        runtimeType: "codex_local",
        sessionIntent: { kind: "fresh" },
        runtimeBindingId: binding.id,
        runtimeSegmentId: session.segment.id,
      });
      const runId = admitted.entry.runId;
      const handlers = createHeartbeatAdmissionHandlers({
        db,
        getRun: async (id) => db.select().from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, id)).then((rows) => rows[0] ?? null),
        unifiedRunAdapter: adapter,
      });
      const provider = { providerThreadId: "provider-thread", providerTurnId: "provider-turn" };
      if (state === "acceptance_unknown") {
        await expect(adapter.markAcceptanceUnknown(runId, admitted.entry.ownerFence, {
          ...provider, reason: "connection dropped after submission",
        })).resolves.toMatchObject({ ok: true });
      } else if (state === "accepted") {
        await expect(adapter.acceptSubmission(runId, admitted.entry.ownerFence, provider))
          .resolves.toMatchObject({ ok: true });
      }
      const [before] = await db.select().from(heartbeatRunAttempts)
        .where(eq(heartbeatRunAttempts.runId, runId));
      if (state === "pending") {
        const [freshRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        await expect(handlers.ensureCommonRunExecutionBoundary(
          db, freshRun!, admitted.entry.ownerFence.ownerToken, admitted.entry.ownerFence.attemptEpoch,
        )).resolves.toMatchObject({ attemptRef: { id: before!.id } });
      }
      const recoveryNow = new Date();
      await db.update(heartbeatRuns)
        .set({ executionLeaseExpiresAt: new Date(recoveryNow.getTime() - 1) })
        .where(eq(heartbeatRuns.id, runId));
      const [expiredRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const recoveryClaim = await handlers.claimRunForRecovery(expiredRun!, {
        now: recoveryNow, recoveryCutoff: recoveryNow,
      });
      expect(recoveryClaim).not.toBeNull();
      const claimed = await adapter.get(runId);
      if (!claimed || !recoveryClaim) throw new Error("expected expired lease claim");
      const [claimedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await expect(handlers.ensureCommonRunExecutionBoundary(
        db, claimedRun!, recoveryClaim.ownerToken, claimed.ownerFence.attemptEpoch,
      )).rejects.toThrow("provider submission must be reconciled");
      await expect(handlers.ensureCommonRunExecutionBoundary(db, claimedRun!, admitted.entry.ownerFence.ownerToken, 1))
        .rejects.toThrow("execution owner or lease is stale");
      const [after] = await db.select().from(heartbeatRunAttempts)
        .where(eq(heartbeatRunAttempts.runId, runId));
      const afterSubmission = (after!.checkpointJson as Record<string, any>).unifiedSubmission;
      expect(after).toMatchObject({ id: before!.id, attemptIndex: 0, ownerToken: recoveryClaim.ownerToken });
      expect(afterSubmission).toMatchObject({
        key: (before!.checkpointJson as Record<string, any>).unifiedSubmission.key,
        state: state === "accepted" ? "accepted" : "acceptance_unknown",
        retry: state === "accepted" ? "not_allowed" : "blocked_until_reconciled",
        providerThreadId: state === "pending" ? null : provider.providerThreadId,
        providerTurnId: state === "pending" ? null : provider.providerTurnId,
      });
      expect(after!.submissionPhase).toBe(state === "accepted" ? "accepted" : "indeterminate");
      await expect(adapter.acceptSubmission(runId, admitted.entry.ownerFence, provider))
        .resolves.toEqual({ ok: false, reason: "stale_owner" });
      await expect(adapter.beginAttempt(runId, claimed.ownerFence, {
        attemptIndex: 1, runtimeType: "codex_local", resumeSource: "same_session",
      })).rejects.toMatchObject({ code: state === "accepted" ? "attempt_conflict" : "acceptance_unknown_requires_reconciliation" });
    },
  );

  it("keeps a confirmed rejection intact when rebuilding a recovered boundary", async () => {
    const seeded = await seedNativeChatIdentity(db);
    const targetId = randomUUID();
    const binding = await ensureRuntimeBinding(db, {
      orgId: seeded.orgId, agentId: seeded.agentId, runtimeType: "codex_local",
      target: { type: "wakeup_request", id: targetId }, continuity: "native",
    });
    const session = await currentNativeSession(db, binding);
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const admitted = await adapter.admit({
      orgId: seeded.orgId, agentId: seeded.agentId, scene: "heartbeat",
      target: { type: "wakeup_request", id: targetId },
      idempotencyKey: `reconciled-${targetId}`, runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" }, runtimeBindingId: binding.id,
      runtimeSegmentId: session.segment.id,
    });
    const runId = admitted.entry.runId;
    await adapter.markAcceptanceUnknown(runId, admitted.entry.ownerFence, {
      providerThreadId: "provider-thread", providerTurnId: "provider-turn",
    });
    const recoveryNow = new Date();
    await db.update(heartbeatRuns).set({ executionLeaseExpiresAt: new Date(recoveryNow.getTime() - 1) })
      .where(eq(heartbeatRuns.id, runId));
    const claimed = await adapter.claimOwner(runId, { observedAt: recoveryNow, recoveryCutoff: recoveryNow });
    if (!claimed.ok) throw new Error("expected expired lease claim");
    await adapter.reconcileAcceptance(runId, claimed.value, { state: "rejected", reason: "provider proved rejection" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const handlers = createHeartbeatAdmissionHandlers({ db, getRun: async () => run, unifiedRunAdapter: adapter });
    await expect(handlers.ensureCommonRunExecutionBoundary(db, run!, claimed.value.ownerToken, claimed.value.attemptEpoch))
      .resolves.toMatchObject({ attemptRef: { attemptIndex: 0 } });
    const [attempt] = await db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, runId));
    expect((attempt!.checkpointJson as Record<string, any>).unifiedSubmission).toMatchObject({
      state: "rejected", retry: "allowed", providerThreadId: "provider-thread", providerTurnId: "provider-turn",
    });
    expect(attempt!.submissionPhase).toBe("indeterminate");
  });

  it("records a confirmed first submission without requiring a false unknown transition", async () => {
    const seeded = await seedNativeChatIdentity(db);
    const targetId = randomUUID();
    const binding = await ensureRuntimeBinding(db, {
      orgId: seeded.orgId, agentId: seeded.agentId, runtimeType: "codex_local",
      target: { type: "wakeup_request", id: targetId }, continuity: "native",
    });
    const session = await currentNativeSession(db, binding);
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const admitted = await adapter.admit({
      orgId: seeded.orgId, agentId: seeded.agentId, scene: "heartbeat",
      target: { type: "wakeup_request", id: targetId },
      idempotencyKey: `confirmed-${targetId}`, runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" }, runtimeBindingId: binding.id,
      runtimeSegmentId: session.segment.id,
    });
    const runId = admitted.entry.runId;
    const accepted = {
      state: "accepted" as const,
      providerThreadId: "provider-thread",
      providerTurnId: "provider-turn",
    };
    await expect(adapter.reconcileAcceptance(runId, admitted.entry.ownerFence, accepted))
      .resolves.toMatchObject({ ok: true, value: { state: "accepted", retry: "not_allowed" } });
    await expect(adapter.reconcileAcceptance(runId, admitted.entry.ownerFence, accepted))
      .resolves.toMatchObject({ ok: true, value: { state: "accepted" } });
    await expect(adapter.reconcileAcceptance(runId, admitted.entry.ownerFence, { state: "rejected" }))
      .rejects.toMatchObject({ code: "attempt_conflict" });
    const [attempt] = await db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, runId));
    expect(attempt).toMatchObject({ submissionPhase: "accepted" });
    expect((attempt!.checkpointJson as Record<string, any>).unifiedSubmission).toMatchObject(accepted);
  });

  it("persists admission, attempt/submission, recovery fencing, native span, and terminal state", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const bindingId = randomUUID();
    const segmentId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Unified Run Org",
      urlKey: deriveOrganizationUrlKey(`Unified Run ${orgId}`),
      issuePrefix: "UAR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Unified Run Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Unified Run Conversation",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(runtimeBindings).values({
      id: bindingId,
      orgId,
      conversationId,
      principalScopeRef: "test:principal",
      agentId,
      runtimeType: "codex_local",
      profileId: "default",
      continuity: "native",
    });
    await db.insert(nativeSegments).values({
      id: segmentId,
      orgId,
      bindingId,
      runtimeType: "codex_local",
      segmentOrdinal: 0,
      state: "open",
    });
    await db.update(runtimeBindings)
      .set({ currentSegmentId: segmentId })
      .where(and(eq(runtimeBindings.id, bindingId), eq(runtimeBindings.orgId, orgId)));

    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const service = createUnifiedAgentRunService(adapter);
    const execution = createUnifiedAgentRunExecutionService(adapter);
    const input = {
      orgId,
      agentId,
      scene: "chat" as const,
      target: { type: "chat_conversation" as const, id: conversationId },
      idempotencyKey: "chat-turn-1",
      runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" as const },
      contextSnapshot: { admissionRecoveryMarker: { sourceBoundaryRef: "sealed-boundary" } },
    };
    const first = await service.admit(input);
    const duplicate = await service.admit(input);
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.entry.runId).toBe(first.entry.runId);
    await expect(service.admit({ ...input, agentId: randomUUID() }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(service.admit({ ...input, runtimeBindingId: randomUUID() }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(service.admit({ ...input, runtimeSegmentId: randomUUID() }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(service.admit({
      ...input,
      idempotencyKey: "chat-turn-2",
    })).rejects.toMatchObject({
      name: "UnifiedAgentRunPersistenceContractError",
      code: "contract",
    });
    await expect(service.admit({
      ...input,
      target: { type: "chat_conversation", id: randomUUID() },
    })).rejects.toMatchObject({ code: "idempotency_conflict" });

    const [storedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.entry.runId));
    const legacyAdmission = {
      ...(storedRun!.contextSnapshot as Record<string, any>).unifiedAgentRun,
      fingerprint: JSON.stringify({
        scene: input.scene, target: input.target, runtimeType: input.runtimeType,
        model: null, sessionIntent: first.entry.sessionIntent,
      }),
    };
    delete legacyAdmission.fingerprintVersion;
    delete legacyAdmission.agentId;
    delete legacyAdmission.runtimeBindingId;
    delete legacyAdmission.runtimeSegmentId;
    await db.update(heartbeatRuns).set({ contextSnapshot: {
      ...storedRun!.contextSnapshot, unifiedAgentRun: legacyAdmission,
    } }).where(eq(heartbeatRuns.id, first.entry.runId));
    await expect(service.admit({ ...input, runtimeBindingId: bindingId, runtimeSegmentId: segmentId }))
      .resolves.toMatchObject({ created: false, entry: { runId: first.entry.runId } });
    await expect(service.admit({ ...input, runtimeSegmentId: randomUUID() }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(service.admit({ ...input, agentId: randomUUID() }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    await db.update(heartbeatRuns).set({ contextSnapshot: storedRun!.contextSnapshot })
      .where(eq(heartbeatRuns.id, first.entry.runId));
    expect(storedRun?.contextSnapshot).toMatchObject({
      admissionRecoveryMarker: { sourceBoundaryRef: "sealed-boundary" },
      scene: "chat",
      targetType: "chat_conversation",
      targetId: conversationId,
      unifiedAgentRun: {
        idempotencyKey: "chat-turn-1",
        fingerprint: expect.any(String),
      },
    });
    expect(storedRun).toMatchObject({
      scene: "chat",
      targetType: "chat_conversation",
      targetId: conversationId,
      idempotencyKey: "chat-turn-1",
      sessionIntentJson: {
        kind: "fresh",
        reuseScope: "none",
        sourceRunId: null,
        sessionId: null,
        sessionParams: null,
      },
    });
    const [storedAttempt] = await db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, first.entry.runId));
    const [storedSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, first.entry.runId));
    expect(storedAttempt?.checkpointJson).toMatchObject({ unifiedSubmission: { state: "pending", key: "chat-turn-1" } });
    expect(storedSpan).toMatchObject({ attemptId: storedAttempt?.id, state: "open", ownerToken: first.entry.ownerFence.ownerToken });

    const renewed = await service.renewOwner(first.entry.runId, first.entry.ownerFence);
    expect(renewed).toMatchObject({ ok: true, value: { ownerToken: first.entry.ownerFence.ownerToken, attemptEpoch: 1 } });
    await expect(execution.acceptSubmission(first.entry.runId, first.entry.ownerFence, {
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
    })).resolves.toMatchObject({ ok: true, value: { state: "accepted", retry: "not_allowed" } });
    await expect(execution.finishAttempt(first.entry.runId, first.entry.ownerFence, "failed"))
      .resolves.toMatchObject({ ok: true, value: { status: "failed" } });

    await db.update(heartbeatRuns)
      .set({ executionLeaseExpiresAt: new Date(Date.now() - 1) })
      .where(eq(heartbeatRuns.id, first.entry.runId));
    const claimed = await service.claimOwner(first.entry.runId, { ownerToken: "recovered-owner" });
    expect(claimed).toMatchObject({ ok: true, value: { ownerToken: "recovered-owner", attemptEpoch: 2 } });
    if (!claimed.ok) throw new Error("expected expired durable lease to be claimable");
    const [recoveredRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.entry.runId));
    const [recoveredAttempt] = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, first.entry.runId));
    const [recoveredSpan] = await db.select().from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.runId, first.entry.runId));
    expect(recoveredRun?.executionOwnerToken).toBe("recovered-owner");
    expect(recoveredAttempt).toMatchObject({ ownerToken: "recovered-owner", attemptEpoch: 2 });
    expect(recoveredSpan).toMatchObject({ ownerToken: "recovered-owner", attemptEpoch: 2 });
    expect(await execution.finishRun(first.entry.runId, first.entry.ownerFence, "succeeded"))
      .toEqual({ ok: false, reason: "stale_owner" });

    const retry = await execution.beginAttempt(first.entry.runId, claimed.value, {
      attemptIndex: 1,
      runtimeType: "codex_local",
      model: null,
      resumeSource: "same_session",
    });
    expect(retry).toMatchObject({ ok: true, value: { ref: { attemptIndex: 1 }, submission: { key: "chat-turn-1:attempt:1" } } });
    await expect(execution.markAcceptanceUnknown(first.entry.runId, claimed.value, {
      phase: "indeterminate",
      reason: "connection closed after provider submission",
    })).resolves.toMatchObject({ ok: true, value: { state: "acceptance_unknown", retry: "blocked_until_reconciled" } });
    await expect(execution.reconcileAcceptance(first.entry.runId, claimed.value, {
      state: "rejected",
      reason: "provider did not accept the turn",
    })).resolves.toMatchObject({ ok: true, value: { state: "rejected", retry: "allowed" } });
    await expect(execution.finishAttempt(first.entry.runId, claimed.value, "failed"))
      .resolves.toMatchObject({ ok: true, value: { status: "failed" } });
    await expect(execution.sealSpan(first.entry.runId, claimed.value, {
      completeness: "partial",
      sourceRevision: "native-revision-2",
      visibilityCutoffRef: "cutoff-1",
    })).resolves.toMatchObject({ ok: true, value: { state: "unresolved", completeness: "partial" } });
    await expect(execution.finishRun(first.entry.runId, claimed.value, "failed"))
      .resolves.toMatchObject({ ok: true, value: { status: "failed", span: { state: "unresolved" } } });

    const [finalSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, first.entry.runId));
    const [finalRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.entry.runId));
    expect(finalSpan).toMatchObject({ state: "unresolved", completeness: "partial", ownerToken: "recovered-owner" });
    expect(finalRun).toMatchObject({ status: "failed", executionOwnerToken: null, executionLeaseExpiresAt: null });
    await expect(service.get(first.entry.runId)).resolves.toMatchObject({
      status: "failed",
      ownerFence: { ownerToken: "recovered-owner", attemptEpoch: 2 },
    });
  });

  it("keeps a provider result recoverable until the Run terminal CAS commits", async () => {
    const seeded = await seedNativeChatIdentity(db);
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const service = createUnifiedAgentRunService(adapter);
    const execution = createUnifiedAgentRunExecutionService(adapter);
    const admitted = await service.admit({
      orgId: seeded.orgId,
      agentId: seeded.agentId,
      scene: "chat",
      target: { type: "chat_conversation", id: seeded.conversationId },
      idempotencyKey: "native-result-terminal-window",
      runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" },
    });
    const providerResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "thread-1",
      sessionDisplayId: "thread-1",
      sessionParams: { threadId: "thread-1" },
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
      resultJson: { providerExecutionRef: "turn-1" },
    };

    await expect(execution.acceptSubmission(admitted.entry.runId, admitted.entry.ownerFence, {
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
    })).resolves.toMatchObject({ ok: true, value: { state: "accepted" } });
    const [beforeRecoveryRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.entry.runId));
    const [beforeRecoveryAttempt] = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, admitted.entry.runId));
    const [beforeRecoverySpan] = await db.select().from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.runId, admitted.entry.runId));
    expect(beforeRecoveryRun?.status).toBe("running");
    expect(beforeRecoveryAttempt).toMatchObject({ status: "started", submissionPhase: "accepted" });
    expect(beforeRecoverySpan).toMatchObject({ state: "open", attemptId: beforeRecoveryAttempt?.id });

    const recoveryNow = new Date();
    await db.update(heartbeatRuns)
      .set({ executionLeaseExpiresAt: new Date(recoveryNow.getTime() - 1) })
      .where(eq(heartbeatRuns.id, admitted.entry.runId));
    const claimed = await service.claimOwner(admitted.entry.runId, {
      observedAt: recoveryNow,
      recoveryCutoff: recoveryNow,
      ownerToken: "recovered-result-owner",
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error("expected the open provider-result span to be recoverable");
    await expect(execution.finishRun(admitted.entry.runId, admitted.entry.ownerFence, "succeeded"))
      .resolves.toEqual({ ok: false, reason: "stale_owner" });

    await expect(execution.finishRun(admitted.entry.runId, claimed.value, "failed", {
      nativeExecution: { spanId: admitted.entry.span.id, result: providerResult, error: true },
      attempt: { submissionPhase: "accepted", providerThreadId: "thread-1", providerTurnId: "turn-1" },
      expectedStatuses: ["succeeded"],
    })).resolves.toEqual({ ok: false, reason: "stale_owner" });
    const [rolledBackRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.entry.runId));
    const [rolledBackAttempt] = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, admitted.entry.runId));
    const [rolledBackSpan] = await db.select().from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.runId, admitted.entry.runId));
    expect(rolledBackRun?.status).toBe("running");
    expect(rolledBackAttempt?.status).toBe("started");
    expect(rolledBackSpan?.state).toBe("open");

    await expect(execution.finishRun(admitted.entry.runId, claimed.value, "succeeded", {
      nativeExecution: {
        spanId: admitted.entry.span.id,
        result: providerResult,
        error: false,
      },
      attempt: {
        submissionPhase: "accepted",
        providerThreadId: "thread-1",
        providerTurnId: "turn-1",
      },
    })).resolves.toMatchObject({ ok: true, value: { status: "succeeded", span: { state: "sealed" } } });

    const [finishedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.entry.runId));
    const [finishedAttempt] = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, admitted.entry.runId));
    const [finishedSpan] = await db.select().from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.runId, admitted.entry.runId));
    expect(finishedRun?.status).toBe("succeeded");
    expect(finishedAttempt).toMatchObject({ status: "succeeded", ownerToken: "recovered-result-owner" });
    expect(finishedSpan).toMatchObject({ state: "sealed", ownerToken: "recovered-result-owner" });
  });

  it("preserves terminal CAS watermarks, attempt atomicity, and pending effects", async () => {
    const seeded = await seedNativeChatIdentity(db);
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const service = createUnifiedAgentRunService(adapter);
    const execution = createUnifiedAgentRunExecutionService(adapter);
    const admitted = await service.admit({
      orgId: seeded.orgId,
      agentId: seeded.agentId,
      scene: "chat",
      target: { type: "chat_conversation", id: seeded.conversationId },
      idempotencyKey: "terminal-cas-watermark",
      runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" },
    });

    const [beforeTerminal] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.entry.runId));
    const [exactWatermark] = await db
      .select({ updatedAtExact: sql<string>`to_char(${heartbeatRuns.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, admitted.entry.runId));
    const [eventCount] = await db.select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, admitted.entry.runId));
    expect(eventCount?.count).toBe(0);

    await expect(execution.finishRun(admitted.entry.runId, admitted.entry.ownerFence, "failed", {
      expectedStatuses: ["queued"],
      attempt: { error: "must not be written" },
    })).resolves.toMatchObject({ ok: false, reason: "stale_owner" });
    await expect(execution.finishRun(admitted.entry.runId, admitted.entry.ownerFence, "failed", {
      expectedStatuses: ["running"],
      activityWatermark: { updatedAt: beforeTerminal!.updatedAt, eventCount: 1 },
      attempt: { error: "must not be written" },
    })).resolves.toMatchObject({ ok: false, reason: "stale_owner" });
    const staleMicrosecondWatermark = exactWatermark!.updatedAtExact.replace(/(\.\d{5})(\dZ)$/, (_match, fraction: string, lastDigitAndZone: string) => {
      const nextDigit = (Number(lastDigitAndZone[0]) + 1) % 10;
      return `${fraction}${nextDigit}Z`;
    });
    await expect(execution.finishRun(admitted.entry.runId, admitted.entry.ownerFence, "failed", {
      expectedStatuses: ["running"],
      activityWatermark: {
        updatedAt: beforeTerminal!.updatedAt,
        updatedAtExact: staleMicrosecondWatermark,
        eventCount: 0,
      },
      attempt: { error: "stale microsecond watermark" },
      nativeExecution: {
        spanId: admitted.entry.span.id,
        result: { exitCode: 0, signal: null, timedOut: false },
        error: true,
      },
    })).resolves.toMatchObject({ ok: false, reason: "stale_owner" });

    const [unchangedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.entry.runId));
    const [unchangedAttempt] = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, admitted.entry.runId));
    const [unchangedSpan] = await db.select().from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.runId, admitted.entry.runId));
    expect(unchangedRun?.status).toBe("running");
    expect(unchangedAttempt?.status).toBe("started");
    expect(unchangedSpan).toMatchObject({ state: "open", selectorJson: { kind: "pending" } });

    await expect(execution.finishRun(admitted.entry.runId, admitted.entry.ownerFence, "failed", {
      expectedStatuses: ["running"],
      activityWatermark: {
        updatedAt: unchangedRun!.updatedAt,
        updatedAtExact: exactWatermark!.updatedAtExact,
        eventCount: 0,
      },
      terminalEffectsIntent: { version: 1, processLossRetry: true },
      processExitedAt: new Date(),
      attempt: { errorCode: "process_lost", error: "process lost" },
      nativeExecution: {
        spanId: admitted.entry.span.id,
        result: { exitCode: 1, signal: null, timedOut: false },
        error: true,
      },
    })).resolves.toMatchObject({ ok: true, value: { status: "failed" } });

    const [finishedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.entry.runId));
    const [finishedAttempt] = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, admitted.entry.runId));
    const [finishedSpan] = await db.select().from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.runId, admitted.entry.runId));
    expect(finishedRun).toMatchObject({
      status: "failed",
      terminalEffectsPending: true,
      terminalEffectsJson: { version: 2, processLossRetry: true },
    });
    expect(finishedAttempt).toMatchObject({ status: "failed", errorCode: "process_lost", error: "process lost" });
    expect(finishedSpan).toMatchObject({ state: "sealed", completeness: "unknown" });
  });

  it("rejects a fence when the current Attempt disagrees with its Run and native Span", async () => {
    const seeded = await seedNativeChatIdentity(db);
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const service = createUnifiedAgentRunService(adapter);
    const execution = createUnifiedAgentRunExecutionService(adapter);
    const admitted = await service.admit({
      orgId: seeded.orgId,
      agentId: seeded.agentId,
      scene: "chat",
      target: { type: "chat_conversation", id: seeded.conversationId },
      idempotencyKey: "inconsistent-attempt-owner-fence",
      runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" },
    });
    await db.update(heartbeatRunAttempts)
      .set({ ownerToken: "stale-attempt-owner", attemptEpoch: 1 })
      .where(eq(heartbeatRunAttempts.runId, admitted.entry.runId));

    await expect(execution.finishAttempt(admitted.entry.runId, admitted.entry.ownerFence, "failed"))
      .resolves.toEqual({ ok: false, reason: "stale_owner" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, admitted.entry.runId));
    const [attempt] = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, admitted.entry.runId));
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, admitted.entry.runId));
    expect(run?.status).toBe("running");
    expect(attempt).toMatchObject({ status: "started", ownerToken: "stale-attempt-owner", attemptEpoch: 1 });
    expect(span).toMatchObject({ state: "open", ownerToken: admitted.entry.ownerFence.ownerToken, attemptEpoch: 1 });
  });

  it("persists a fork child before submission and keeps it after a pre-turn failure", async () => {
    const seeded = await seedNativeChatIdentity(db);
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, orgId: seeded.orgId, agentId: seeded.agentId,
      invocationSource: "chat", status: "succeeded",
    });
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const service = createUnifiedAgentRunService(adapter);
    const execution = createUnifiedAgentRunExecutionService(adapter);
    const first = await service.admit({
      orgId: seeded.orgId, agentId: seeded.agentId, scene: "side_chat",
      target: { type: "chat_conversation", id: seeded.conversationId },
      idempotencyKey: "fork-first-send", runtimeType: "codex_local",
      sessionIntent: { kind: "fork", sourceRunId, sourceBoundaryRef: "parent-turn",
        sessionId: "child-thread", sessionParams: { sessionId: "child-thread", rootSessionId: "child-root", capabilityRevision: "cap-1" } },
    });
    const [beforeSubmit] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, seeded.segmentId));
    expect(beforeSubmit).toMatchObject({ nativeSessionId: "child-thread", rootSessionId: "child-root",
      sourceBoundaryRef: "parent-turn", providerStateJson: { sessionId: "child-thread", capabilityRevision: "cap-1" } });
    await execution.finishAttempt(first.entry.runId, first.entry.ownerFence, "failed");
    await execution.finishRun(first.entry.runId, first.entry.ownerFence, "failed");
    const [afterFailure] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, seeded.segmentId));
    expect(afterFailure?.nativeSessionId).toBe("child-thread");
    expect(afterFailure?.providerStateJson).toEqual(beforeSubmit?.providerStateJson);
  });

  it("normalizes missing provider references from OpenCode-style results without weakening the contract", async () => {
    const seeded = await seedNativeChatIdentity(db, {
      agentRuntimeType: "opencode_local",
      bindingRuntimeType: "opencode_local",
      segmentRuntimeType: "opencode_local",
    });
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const service = createUnifiedAgentRunService(adapter);
    const execution = createUnifiedAgentRunExecutionService(adapter);
    const admitted = await service.admit({
      orgId: seeded.orgId,
      agentId: seeded.agentId,
      scene: "chat",
      target: { type: "chat_conversation", id: seeded.conversationId },
      idempotencyKey: "opencode-missing-turn",
      runtimeType: "opencode_local",
      sessionIntent: { kind: "fresh" },
    });

    await expect(execution.acceptSubmission(admitted.entry.runId, admitted.entry.ownerFence, {
      providerThreadId: 42 as unknown as string,
      providerTurnId: "",
    })).rejects.toThrow("provider reference must be a non-empty string");

    await expect(execution.acceptSubmission(admitted.entry.runId, admitted.entry.ownerFence, {
      providerThreadId: " opencode-session ",
      providerTurnId: "",
    })).resolves.toMatchObject({
      ok: true,
      value: {
        state: "accepted",
        providerThreadId: "opencode-session",
        providerTurnId: null,
      },
    });

    await expect(execution.finishAttempt(admitted.entry.runId, admitted.entry.ownerFence, "succeeded", {
      providerThreadId: " ",
      providerTurnId: "",
    })).resolves.toMatchObject({
      ok: true,
      value: {
        status: "succeeded",
        submission: {
          providerThreadId: "opencode-session",
          providerTurnId: null,
        },
      },
    });

    const [storedAttempt] = await db
      .select()
      .from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, admitted.entry.runId));
    expect(storedAttempt).toMatchObject({
      providerThreadId: "opencode-session",
      providerTurnId: null,
      checkpointJson: {
        unifiedSubmission: {
          providerThreadId: "opencode-session",
          providerTurnId: null,
        },
      },
    });
  });

  it("fails closed when a chat target has no durable native binding/segment", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Unsupported Unified Run Org",
      urlKey: deriveOrganizationUrlKey(`Unsupported Unified Run ${orgId}`),
      issuePrefix: "UAR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "No Native Binding Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "No Native Binding Conversation",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const service = createUnifiedAgentRunService(createHeartbeatUnifiedAgentRunAdapter(db));
    await expect(service.admit({
      orgId,
      agentId,
      scene: "chat",
      target: { type: "chat_conversation", id: conversationId },
      idempotencyKey: "missing-native-span",
      runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" },
    })).rejects.toMatchObject({
      name: "UnifiedAgentRunPersistenceContractError",
      code: "unsupported",
    });
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.orgId, orgId))).resolves.toHaveLength(0);
  });

  it("creates a precise native span for a non-Chat target binding", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const bindingId = randomUUID();
    const segmentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Non Chat Binding Org",
      urlKey: deriveOrganizationUrlKey(`Non Chat Binding ${orgId}`),
      issuePrefix: "NCR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Issue Runtime Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(runtimeBindings).values({
      id: bindingId,
      orgId,
      conversationId: null,
      targetType: "issue",
      targetId: issueId,
      principalScopeRef: "test:issue-principal",
      agentId,
      runtimeType: "codex_local",
      profileId: "default",
      continuity: "native",
    });
    await db.insert(nativeSegments).values({
      id: segmentId,
      orgId,
      bindingId,
      runtimeType: "codex_local",
      segmentOrdinal: 0,
      state: "open",
    });
    await db.update(runtimeBindings)
      .set({ currentSegmentId: segmentId })
      .where(and(eq(runtimeBindings.id, bindingId), eq(runtimeBindings.orgId, orgId)));

    const service = createUnifiedAgentRunService(createHeartbeatUnifiedAgentRunAdapter(db));
    const admitted = await service.admit({
      orgId,
      agentId,
      scene: "issue",
      target: { type: "issue", id: issueId },
      runtimeBindingId: bindingId,
      runtimeSegmentId: segmentId,
      idempotencyKey: "issue-run-1",
      runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" },
    });

    await expect(db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, admitted.entry.runId)))
      .resolves.toMatchObject([expect.objectContaining({ bindingId, segmentId, inputCorrelationRef: "issue-run-1" })]);
    await expect(service.get(admitted.entry.runId)).resolves.toMatchObject({
      scene: "issue",
      target: { type: "issue", id: issueId },
      span: { id: expect.any(String), state: "open" },
    });

    const delegated = await service.admit({
      orgId,
      agentId,
      scene: "delegation",
      target: { type: "issue", id: issueId },
      runtimeBindingId: bindingId,
      runtimeSegmentId: segmentId,
      idempotencyKey: "delegated-issue-run-1",
      runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" },
    });
    await expect(service.get(delegated.entry.runId)).resolves.toMatchObject({
      scene: "delegation",
      target: { type: "issue", id: issueId },
    });
    await expect(db.select({ source: heartbeatRuns.invocationSource, scene: heartbeatRuns.scene })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, delegated.entry.runId)))
      .resolves.toEqual([{ source: "delegation", scene: "delegation" }]);
  });

  it("freezes an old binding epoch when the authorized runtime identity changes", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Binding Epoch Org",
      urlKey: deriveOrganizationUrlKey(`Binding Epoch ${orgId}`),
      issuePrefix: "UBE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Binding Epoch Agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Binding Epoch Conversation",
      issueCreationMode: "manual_approval",
      planMode: false,
    });

    const first = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:first",
      agentId,
      runtimeType: "codex_local",
      profileId: "profile-a",
      capabilityRevision: "cap-a",
    });
    const second = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:first",
      agentId,
      runtimeType: "codex_local",
      profileId: "profile-b",
      capabilityRevision: "cap-b",
    });

    expect(second.id).not.toBe(first.id);
    expect(second.bindingEpoch).toBe(first.bindingEpoch + 1);
    expect(second.status).toBe("active");
    await expect(db.select({ id: runtimeBindings.id, status: runtimeBindings.status, bindingEpoch: runtimeBindings.bindingEpoch })
      .from(runtimeBindings)
      .where(eq(runtimeBindings.conversationId, conversationId)))
      .resolves.toEqual(expect.arrayContaining([
        { id: first.id, status: "superseded", bindingEpoch: first.bindingEpoch },
        { id: second.id, status: "active", bindingEpoch: second.bindingEpoch },
      ]));
  });

  it("fails closed before admission when binding and segment runtimes are mixed", async () => {
    const seeded = await seedNativeChatIdentity(db, { segmentRuntimeType: "pi_local" });
    const service = createUnifiedAgentRunService(createHeartbeatUnifiedAgentRunAdapter(db));

    await expect(service.admit({
      orgId: seeded.orgId,
      agentId: seeded.agentId,
      scene: "chat",
      target: { type: "chat_conversation", id: seeded.conversationId },
      idempotencyKey: "mixed-admission",
      runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" },
    })).rejects.toMatchObject({
      name: "UnifiedAgentRunPersistenceContractError",
      code: "contract",
    });

    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.orgId, seeded.orgId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.orgId, seeded.orgId))).resolves.toHaveLength(0);
    await expect(db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.orgId, seeded.orgId))).resolves.toHaveLength(0);
  });

  it("rejects a mixed-runtime retry before creating the next attempt", async () => {
    const seeded = await seedNativeChatIdentity(db);
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const service = createUnifiedAgentRunService(adapter);
    const execution = createUnifiedAgentRunExecutionService(adapter);
    const first = await service.admit({
      orgId: seeded.orgId,
      agentId: seeded.agentId,
      scene: "chat",
      target: { type: "chat_conversation", id: seeded.conversationId },
      idempotencyKey: "mixed-retry",
      runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" },
    });
    await expect(execution.finishAttempt(first.entry.runId, first.entry.ownerFence, "failed"))
      .resolves.toMatchObject({ ok: true, value: { status: "failed" } });

    await expect(execution.beginAttempt(first.entry.runId, first.entry.ownerFence, {
      attemptIndex: 1,
      runtimeType: "pi_local",
      model: null,
      resumeSource: "same_session",
    })).rejects.toMatchObject({ code: "attempt_conflict" });
    await expect(db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, first.entry.runId)))
      .resolves.toHaveLength(1);
  });

  it("rejects mixed runtime span reads and updates before touching the span", async () => {
    const seeded = await seedNativeChatIdentity(db);
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const service = createUnifiedAgentRunService(adapter);
    const execution = createUnifiedAgentRunExecutionService(adapter);
    const first = await service.admit({
      orgId: seeded.orgId,
      agentId: seeded.agentId,
      scene: "chat",
      target: { type: "chat_conversation", id: seeded.conversationId },
      idempotencyKey: "mixed-span-read",
      runtimeType: "codex_local",
      sessionIntent: { kind: "fresh" },
    });
    const [spanBefore] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, first.entry.runId));
    await db.update(nativeSegments)
      .set({ runtimeType: "pi_local" })
      .where(and(eq(nativeSegments.id, seeded.segmentId), eq(nativeSegments.orgId, seeded.orgId)));

    await expect(service.get(first.entry.runId)).rejects.toMatchObject({
      name: "UnifiedAgentRunPersistenceContractError",
      code: "contract",
    });
    await expect(execution.recordExecutionResult(first.entry.runId, first.entry.ownerFence, {
      spanId: spanBefore?.id,
      result: { exitCode: 0, signal: null, timedOut: false },
    })).rejects.toMatchObject({
      name: "UnifiedAgentRunPersistenceContractError",
      code: "contract",
    });
    const [spanAfter] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, first.entry.runId));
    expect(spanAfter).toMatchObject({ id: spanBefore?.id, state: "open", selectorJson: { kind: "pending", runtimeType: "codex_local" } });
  });
});
