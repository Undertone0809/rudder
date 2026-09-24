import {
  agents,
  applyPendingMigrations,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  goals,
  heartbeatRunEvents,
  heartbeatRunAttempts,
  heartbeatRuns,
  nativeSegments,
  organizations,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chatAgentRunService } from "../services/chat-agent-runs.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { getRunSummary } from "../services/run-intelligence.ts";
import { currentNativeSession, ensureRuntimeBinding } from "../services/runtime-kernel/native-session.ts";
import { createHeartbeatUnifiedAgentRunAdapter } from "../services/runtime-kernel/unified-agent-run.integration.ts";

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
  const externalConnectionString = process.env.RUDDER_CHAT_AGENT_RUNS_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-agent-runs-"));
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

describe("chatAgentRunService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof chatAgentRunService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = chatAgentRunService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(chatMessages);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(chatConversations);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("creates one active run per conversation, finalizes stale runs, and links assistant messages", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const goalId = randomUUID();
    const foreignOrgId = randomUUID();
    const foreignGoalId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RDR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(organizations).values({
      id: foreignOrgId,
      name: "Other Rudder",
      urlKey: deriveOrganizationUrlKey("Other Rudder"),
      issuePrefix: "OTH",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values([
      { id: goalId, orgId, title: "Conversation Goal" },
      { id: foreignGoalId, orgId: foreignOrgId, title: "Foreign Goal" },
    ]);
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Chat Runner",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Run-backed chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);

    const conversation = {
      id: conversationId,
      orgId,
      primaryIssueId: null,
      planMode: false,
    };

    const firstRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      userMessageId: messageId,
      linkedIssueIds: [],
      linkedProjectId: null,
      linkedGoalId: goalId,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: messageId,
      runtimeModel: null,
    });

    expect(firstRun.status).toBe("running");
    expect(firstRun.invocationSource).toBe("chat");
    expect(firstRun.sessionReuseScope).toBe("none");
    expect(firstRun.contextSnapshot).toMatchObject({
      scene: "chat",
      targetType: "chat_conversation",
      targetId: conversationId,
      conversationId,
      messageId,
      userMessageId: messageId,
      goalId,
    });
    expect(firstRun.goalId).toBe(goalId);
    await expect(svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      linkedGoalId: foreignGoalId,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      inputCorrelationRef: randomUUID(),
    })).rejects.toThrow("same organization");
    const firstRunSummary = await getRunSummary(db, firstRun.id, { orgIds: [orgId] });
    expect(firstRunSummary?.sessionReuseScope).toBe("none");
    await expect(svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      inputCorrelationRef: randomUUID(),
    })).rejects.toThrow("already active");

    await expect(svc.finalizeStaleRuns({
      conversationId,
      olderThanMs: 0,
      error: "test stale chat run",
      errorCode: "test_chat_run_stale",
    })).resolves.toBe(0);

    const recoveryNow = new Date(Date.now() + 10 * 60_000);
    await db
      .update(heartbeatRuns)
      .set({ executionLeaseExpiresAt: new Date(recoveryNow.getTime() - 1) })
      .where(eq(heartbeatRuns.id, firstRun.id));
    const recoveryResults = await Promise.all([
      heartbeatService(db).reapOrphanedRuns({ now: recoveryNow, recoveryCutoff: recoveryNow }),
      heartbeatService(db).reapOrphanedRuns({ now: recoveryNow, recoveryCutoff: recoveryNow }),
    ]);
    expect(recoveryResults.reduce((total, result) => total + result.reaped, 0)).toBe(1);

    const [timedOutRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, firstRun.id));
    expect(timedOutRun?.status).toBe("failed");
    expect(timedOutRun?.errorCode).toBe("process_lost");

    await svc.finalizeRun(firstRun.id, {
      status: "succeeded",
      resultJson: { summary: "late chat completion" },
      usageJson: { inputTokens: 10, outputTokens: 2 },
    });
    const [lateFinalizedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, firstRun.id));
    expect(lateFinalizedRun).toMatchObject({
      status: "failed",
      errorCode: "process_lost",
      resultJson: { summary: "late chat completion" },
    });

    const secondRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      inputCorrelationRef: randomUUID(),
    });

    await expect(svc.linkAssistantMessage(secondRun.id, conversationId, randomUUID())).resolves.toBeNull();
    const eventsBeforeLink = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, secondRun.id));
    expect(eventsBeforeLink.some((event) => event.eventType === "chat.message_linked")).toBe(false);

    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Done.",
      replyingAgentId: agentId,
    });

    await svc.linkAssistantMessage(secondRun.id, conversationId, messageId);

    const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId));
    expect(message?.runId).toBe(secondRun.id);

    const [linkedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, secondRun.id));
    expect(linkedRun?.chatConversationId).toBe(conversationId);
    expect(linkedRun?.contextSnapshot).toMatchObject({ assistantMessageId: messageId, messageId });

    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, secondRun.id));
    expect(events.some((event) => event.eventType === "chat.message_linked")).toBe(true);

    const largeRawResult = "x".repeat(200_000);
    await svc.finalizeRun(secondRun.id, {
      status: "succeeded",
      resultJson: {
        summary: "s".repeat(800),
        costUsd: 0.42,
        raw: largeRawResult,
      },
    });
    const [finalizedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, secondRun.id));
    expect(finalizedRun?.resultJson).toMatchObject({ raw: largeRawResult });
    expect(finalizedRun?.resultSummaryJson).toEqual({
      summary: "s".repeat(500),
      costUsd: 0.42,
    });
  });

  it("stores automation run target metadata on chat-backed agent runs", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const automationRunId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RDR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Chat Runner",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Automation chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);

    const run = await svc.createRun({
      conversation: {
        id: conversationId,
        orgId,
        primaryIssueId: null,
        planMode: false,
      },
      agentId,
      triggerDetail: "chat_assistant_reply_stream",
      userMessageId,
      linkedIssueIds: [],
      linkedProjectId: null,
      runContext: {
        targetType: "automation_run",
        targetId: automationRunId,
        automationRunId,
      },
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: userMessageId,
    });

    expect(run.contextSnapshot).toMatchObject({
      scene: "chat",
      targetType: "automation_run",
      targetId: automationRunId,
      automationRunId,
      conversationId,
      messageId: userMessageId,
      userMessageId,
    });
  });

  it("binds each chat run to one fenced native span and rejects a late owner", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Native span org",
      urlKey: deriveOrganizationUrlKey("Native span org"),
      issuePrefix: "NSP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Native span agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Native span chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });

    const bindingResults = await Promise.all([
      ensureRuntimeBinding(db, {
        orgId,
        conversationId,
        principalScopeRef: "user:operator",
        agentId,
        runtimeType: "codex_local",
      }),
      ensureRuntimeBinding(db, {
        orgId,
        conversationId,
        principalScopeRef: "user:operator",
        agentId,
        runtimeType: "codex_local",
      }),
    ]);
    expect(bindingResults[0].id).toBe(bindingResults[1].id);
    const nativeSession = await currentNativeSession(db, bindingResults[0]);
    const conversation = { id: conversationId, orgId, primaryIssueId: null, planMode: false };

    const firstRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: bindingResults[0],
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: "message-1",
    });
    expect(firstRun.runtimeSpanId).toBeTruthy();

    const firstResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "codex-thread-1",
      sessionDisplayId: "codex-thread-1",
      sessionParams: { sessionId: "codex-thread-1", cwd: "/tmp/native-span" },
      resultJson: { turnId: "turn-1" },
    };
    await svc.recordNativeExecutionResult(firstRun.id, firstResult, {
      orgId,
      spanId: firstRun.runtimeSpanId,
      ownerToken: firstRun.runtimeSpanOwnerToken,
      attemptEpoch: firstRun.runtimeSpanAttemptEpoch,
    });
    const [sealedSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, firstRun.runtimeSpanId!));
    expect(sealedSpan).toMatchObject({ state: "sealed", completeness: "complete", nativeExecutionRef: "turn-1" });
    const [firstSegment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, sealedSpan!.segmentId));
    expect(firstSegment?.nativeSessionId).toBe("codex-thread-1");

    await svc.finalizeRun(firstRun.id, { status: "succeeded", resultJson: { summary: "first" } });
    const nextSession = await currentNativeSession(db, bindingResults[0]);
    const secondRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: bindingResults[0],
      runtimeSegment: nextSession.segment,
      nativeSessionId: nextSession.sessionId,
      nativeSessionParams: nextSession.sessionParams,
      inputCorrelationRef: "message-2",
    });
    await expect(svc.recordNativeExecutionResult(secondRun.id, firstResult, {
      orgId,
      spanId: secondRun.runtimeSpanId,
      ownerToken: firstRun.runtimeSpanOwnerToken,
      attemptEpoch: secondRun.runtimeSpanAttemptEpoch,
    })).resolves.toBeNull();
    const [stillOpen] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, secondRun.runtimeSpanId!));
    expect(stillOpen?.state).toBe("open");
    await svc.recordNativeExecutionResult(secondRun.id, {
      ...firstResult,
      resultJson: { turnId: "turn-2" },
    }, {
      orgId,
      spanId: secondRun.runtimeSpanId,
      ownerToken: secondRun.runtimeSpanOwnerToken,
      attemptEpoch: secondRun.runtimeSpanAttemptEpoch,
    });
    await svc.finalizeRun(secondRun.id, { status: "succeeded", resultJson: { summary: "second" } });
    const bindings = await db.select().from(runtimeBindings).where(eq(runtimeBindings.orgId, orgId));
    expect(bindings).toHaveLength(1);
  });

  it("fails closed for stale owners and stale attempt refs across every Chat Run write", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Owner fencing org",
      urlKey: deriveOrganizationUrlKey("Owner fencing org"),
      issuePrefix: "OFG",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Owner fencing agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Owner fencing chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);
    const run = await svc.createRun({
      conversation: { id: conversationId, orgId, primaryIssueId: null, planMode: false },
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: "owner-fencing-message",
    });
    const staleRun = {
      ...run,
      runtimeAttemptRef: run.runtimeAttemptRef ? { ...run.runtimeAttemptRef } : null,
    };
    const staleResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "stale-owner-thread",
      sessionDisplayId: "stale-owner-thread",
      sessionParams: { sessionId: "stale-owner-thread" },
      resultJson: { turnId: "stale-owner-turn" },
    };

    await db
      .update(heartbeatRuns)
      .set({ executionLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, run.id));
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const claimed = await adapter.claimOwner(run.id);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error(`expected recovery claim, got ${claimed.reason}`);

    await expect(svc.beginRuntimeAttempt(staleRun, {
      attemptIndex: 0,
      fallbackIndex: null,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
      resumeSource: "fresh",
    })).rejects.toThrow("immutable owner/attempt fence");
    await expect(svc.markRuntimeAttemptWaiting(staleRun, {
      submissionPhase: "indeterminate",
      providerThreadId: "stale-owner-thread",
      error: "late owner",
    })).rejects.toThrow("immutable owner/attempt fence");
    await expect(svc.finishRuntimeAttempt(staleRun, {
      status: "failed",
      submissionPhase: "accepted",
      providerTurnId: "stale-owner-turn",
    })).rejects.toThrow("immutable owner/attempt fence");
    await expect(svc.recordNativeExecutionResult(run.id, staleResult, {
      orgId,
      spanId: staleRun.runtimeSpanId,
      ownerToken: staleRun.runtimeSpanOwnerToken!,
      attemptEpoch: staleRun.runtimeSpanAttemptEpoch,
    })).resolves.toBeNull();
    await expect(svc.acceptSubmission(staleRun, { providerTurnId: "stale-owner-turn" })).resolves.toBeNull();
    await expect(svc.markAcceptanceUnknown(staleRun, { reason: "stale owner" })).resolves.toBeNull();
    await expect(svc.sealSpan(staleRun, { completeness: "complete" })).resolves.toBeNull();

    await svc.finalizeRun(run.id, { status: "succeeded", resultJson: { source: "stale-owner" } });
    const [stillRunning] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(stillRunning?.status).toBe("running");
    expect(stillRunning?.executionOwnerToken).toBe(claimed.value.ownerToken);

    const recoveredRun = await svc.adoptRecoveredRun(run.id, claimed.value.ownerToken);
    expect(recoveredRun).not.toBeNull();
    if (!recoveredRun) throw new Error("expected recovered Chat run");
    await svc.beginRuntimeAttempt(recoveredRun, {
      attemptIndex: 0,
      fallbackIndex: null,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
      resumeSource: "fresh",
    });
    await svc.finishRuntimeAttempt(recoveredRun, {
      status: "succeeded",
      submissionPhase: "accepted",
      providerTurnId: "first-attempt-turn",
    });
    const staleAttemptRun = {
      ...recoveredRun,
      runtimeAttemptRef: recoveredRun.runtimeAttemptRef ? { ...recoveredRun.runtimeAttemptRef } : null,
    };
    const secondAttemptRef = await svc.beginRuntimeAttempt(recoveredRun, {
      attemptIndex: 1,
      fallbackIndex: 1,
      runtimeType: "codex_local",
      model: "fallback-model",
      isFallback: true,
      resumeSource: "pristine_replay",
    });
    expect(secondAttemptRef.attemptIndex).toBe(1);
    await expect(svc.finishRuntimeAttempt(staleAttemptRun, {
      status: "failed",
      submissionPhase: "accepted",
      providerTurnId: "late-first-attempt-turn",
    })).rejects.toThrow("immutable owner/attempt fence");
    await expect(svc.acceptSubmission(staleAttemptRun, { providerTurnId: "late-first-attempt-turn" })).resolves.toBeNull();
    await expect(svc.sealSpan(staleAttemptRun, { completeness: "complete" })).resolves.toBeNull();

    const attempts = await db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, run.id));
    expect(attempts.find((attempt) => attempt.attemptIndex === 1)?.status).toBe("started");
    await svc.finishRuntimeAttempt(recoveredRun, {
      status: "succeeded",
      submissionPhase: "accepted",
      providerTurnId: "second-attempt-turn",
    });
    await expect(svc.sealSpan(recoveredRun, {
      completeness: "complete",
      visibilityCutoffRef: "second-attempt-turn",
    })).resolves.toMatchObject({ state: "sealed", completeness: "complete" });
    await svc.finalizeRun(run.id, { status: "succeeded", resultJson: { source: "current-owner" } });
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(finished?.status).toBe("succeeded");
  });
});
