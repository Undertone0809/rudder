import type {
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  ModelAttemptSpec,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
import { hasConfirmedNativeWriterQuiescence } from "@rudderhq/agent-runtime-utils";
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
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chatAgentRunService } from "./chat-agent-runs.js";
import { createChatNativeAttemptCallbacks } from "./chat-assistant.native-attempt.js";
import {
  chatAttemptFailureFinishInput,
  createChatAssistantRuntimeDriverPorts,
} from "./chat-assistant.runtime-driver.js";
import { executeAdapterWithModelFallbacks } from "./runtime-kernel/model-fallback.js";
import { currentNativeSession, ensureRuntimeBinding } from "./runtime-kernel/native-session.js";
import type { RuntimeDriver, RuntimeDriverApprovalBridge } from "./runtime-kernel/runtime-driver.js";
import {
  createHeartbeatUnifiedAgentRunAdapter,
  createUnifiedAgentRunExecutionService,
} from "./runtime-kernel/unified-agent-run.integration.js";
import { sideChatService } from "./side-chats.js";

type ChatRunService = ReturnType<typeof chatAgentRunService>;
type ChatRun = Awaited<ReturnType<ChatRunService["createRun"]>>;

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags: string[];
  onLog: (message: unknown) => void;
  onError: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

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
  const externalUrl = process.env.RUDDER_CHAT_ASSISTANT_FALLBACK_TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await applyPendingMigrations(externalUrl);
    return { connectionString: externalUrl, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-fallback-"));
  const port = await getAvailablePort();
  const mod = await import("embedded-postgres");
  const EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
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
  const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("Chat native fallback Attempt persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  const createdOrgIds = new Set<string>();

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    const orgIds = [...createdOrgIds];
    createdOrgIds.clear();
    if (orgIds.length === 0) return;
    const activeWriterSpans = await db.select({ orgId: runRuntimeSpans.orgId })
      .from(runRuntimeSpans)
      .where(and(inArray(runRuntimeSpans.orgId, orgIds), isNull(runRuntimeSpans.writerLeaseReleasedAt)));
    const activeWriterOrgIds = new Set(activeWriterSpans.map((span) => span.orgId));
    const cleanupOrgIds = orgIds.filter((orgId) => !activeWriterOrgIds.has(orgId));
    if (cleanupOrgIds.length === 0) return;
    await db.delete(heartbeatRunEvents).where(inArray(heartbeatRunEvents.orgId, cleanupOrgIds));
    await db.delete(heartbeatRunAttempts).where(inArray(heartbeatRunAttempts.orgId, cleanupOrgIds));
    await db.delete(runRuntimeSpans).where(inArray(runRuntimeSpans.orgId, cleanupOrgIds));
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.orgId, cleanupOrgIds));
    await db.delete(nativeSegments).where(inArray(nativeSegments.orgId, cleanupOrgIds));
    await db.delete(runtimeBindings).where(inArray(runtimeBindings.orgId, cleanupOrgIds));
    await db.delete(chatConversations).where(inArray(chatConversations.orgId, cleanupOrgIds));
    await db.delete(agents).where(inArray(agents.orgId, cleanupOrgIds));
    await db.delete(organizations).where(inArray(organizations.id, cleanupOrgIds));
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  async function createRunFixture(label: string) {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const orgName = `${label} ${orgId}`;
    createdOrgIds.add(orgId);
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `C${orgId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: `${label} agent`,
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: `${label} chat`,
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const binding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const session = await currentNativeSession(db, binding);
    const runs = chatAgentRunService(db);
    const run = await runs.createRun({
      conversation: { id: conversationId, orgId, primaryIssueId: null, planMode: false },
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: binding,
      runtimeSegment: session.segment,
      nativeSessionId: session.sessionId,
      nativeSessionParams: session.sessionParams,
      inputCorrelationRef: randomUUID(),
      runtimeModel: "primary-model",
    });
    return { orgId, agentId, conversationId, run, runs };
  }

  function createAttemptPorts(input: {
    run: ChatRun;
    runs: ChatRunService;
    driver: RuntimeDriver;
    orgId: string;
    chatId: string;
  }) {
    const approvalBridge = {
      requestApproval: vi.fn(),
      waitForApproval: vi.fn(),
    } as unknown as RuntimeDriverApprovalBridge;
    const ports = createChatAssistantRuntimeDriverPorts(db).createAttemptPorts({
      primaryRuntimeType: "codex_local",
      providerBinding: {
        hostId: "local",
        profileId: "default",
        capabilityRevision: "chat-fallback-test",
      },
      cwd: process.cwd(),
      continuationTransport: {},
      approvalBridge,
      runId: input.run.id,
      orgId: input.orgId,
      chatId: input.chatId,
      initialDriver: input.driver,
      nativeDriverRequired: true,
      getAttemptId: () => input.run.runtimeAttemptRef?.id,
      finishAttempt: (failure, phase) => input.runs.finishRuntimeAttempt(
        input.run,
        chatAttemptFailureFinishInput(failure, phase, {
          sessionDisplayId: null,
          sessionParams: null,
        }),
      ),
    });
    return ports;
  }

  async function executeFallback(input: {
    run: ChatRun;
    driver: RuntimeDriver;
    onAttemptSubmissionStart: (attempt: ModelAttemptSpec) => Promise<void>;
    onAttemptStart: (attempt: ModelAttemptSpec) => Promise<void>;
    onAttemptResult: (
      attempt: ModelAttemptSpec,
      result: AgentRuntimeExecutionResult,
      submissionPhase: "pre_submission" | "accepted" | "indeterminate",
    ) => Promise<void>;
    onAttemptFailure: (attempt: ModelAttemptSpec, failure: AgentRuntimeExecutionResult | Error) => Promise<void>;
  }) {
    const adapter: ServerAgentRuntimeModule = {
      type: "codex_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "Chat bypassed the native Runtime Driver",
      })),
    };
    const context: AgentRuntimeExecutionContext = {
      runId: input.run.id,
      agent: {
        id: input.run.agentId,
        orgId: input.run.orgId,
        name: "Fallback test agent",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: `chat:${input.run.id}`,
      },
      config: {
        model: "primary-model",
        modelFallbacks: [{ agentRuntimeType: "codex_local", model: "fallback-model" }],
      },
      context: { chatPrompt: "Continue this Chat request" },
      onLog: vi.fn(async () => {}),
    };
    const result = await executeAdapterWithModelFallbacks(adapter, context, {
      submitInputThroughDriver: true,
      nativeDriverRequired: true,
      resolveDriver: () => input.driver,
      onAttemptStart: input.onAttemptStart,
      onAttemptSubmissionStart: input.onAttemptSubmissionStart,
      onAttemptResult: input.onAttemptResult,
      onAttemptFailure: input.onAttemptFailure,
    });
    expect(adapter.execute).not.toHaveBeenCalled();
    return result;
  }

  async function recordAttemptResult(
    run: ChatRun,
    runs: ChatRunService,
    orgId: string,
    attempt: ModelAttemptSpec,
    result: AgentRuntimeExecutionResult,
  ) {
    const attemptRef = run.runtimeAttemptRef;
    const spanId = run.runtimeSpanId?.trim();
    expect(attemptRef?.attemptIndex).toBe(attempt.index);
    expect(spanId).toBeTruthy();
    const recorded = await runs.recordNativeExecutionResult(run.id, result, {
      orgId,
      spanId,
      attemptId: attemptRef!.id,
      ownerToken: run.runtimeSpanOwnerToken!,
      attemptEpoch: run.runtimeSpanAttemptEpoch!,
    });
    if (!recorded) throw new Error("Native execution result was not recorded");
    expect(recorded).toMatchObject({ id: spanId, attemptRef: { id: attemptRef?.id } });
    return recorded;
  }

  it.each([true, false])("keeps Stop and native writer exit independent before Side Chat deletion (confirmed=%s)", async (confirmed) => {
    const { run, runs, orgId, conversationId } = await createRunFixture("Stopped Side Chat writer");
    await db.update(chatConversations).set({
      conversationKind: "side_chat", sideChatState: "completed", messengerVisible: false,
      createdByUserId: "operator",
    }).where(eq(chatConversations.id, conversationId));
    const attempt: ModelAttemptSpec = {
      index: 0, agentRuntimeType: "codex_local", model: "primary-model", config: null,
      isFallback: false, fallbackIndex: null, totalFallbacks: 0,
    };
    run.runtimeAttemptRef = await runs.beginRuntimeAttempt(run, {
      attemptIndex: 0, fallbackIndex: null, runtimeType: "codex_local", model: "primary-model",
      isFallback: false, resumeSource: "fresh",
    });
    const stop = new AbortController();
    const handlers = createChatNativeAttemptCallbacks({
      orgId, runtimeAgentType: "codex_local", nativeDriverRequired: true, signal: stop.signal,
      isExecutionInactive: () => stop.signal.aborted, isOwnerLost: () => false,
      ownerLostError: new Error("owner lost"), getAttempt: () => run.runtimeAttemptRef,
      getSpanFence: () => ({ spanId: run.runtimeSpanId ?? null,
        ownerToken: run.runtimeSpanOwnerToken!, attemptEpoch: run.runtimeSpanAttemptEpoch! }),
      markAcceptanceUnknown: (value) => runs.markAcceptanceUnknown(run, value),
      recordNativeExecutionResult: (result, fence) => runs.recordNativeExecutionResult(run.id, result, fence),
      onAttemptResult: async () => undefined,
    });
    await handlers.onAttemptSubmissionStart(attempt);
    stop.abort();
    await handlers.onAttemptResult(attempt, {
      exitCode: null, signal: "SIGTERM", timedOut: false,
      nativeWriterQuiescence: confirmed
        ? { status: "confirmed", source: "process_exit" }
        : { status: "unconfirmed", reason: "writer exit not observed" },
    }, "accepted");
    await runs.finalizeRun(run.id, { status: "cancelled", errorCode: "chat_stopped" });
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    expect(span?.writerLeaseReleasedAt).toEqual(confirmed ? expect.any(Date) : null);
    const deletion = sideChatService(db).destroy({ conversationId, userId: "operator" });
    if (confirmed) {
      await expect(deletion).resolves.toEqual({ id: conversationId });
      expect(await db.select().from(chatConversations).where(eq(chatConversations.id, conversationId))).toEqual([]);
    } else {
      await expect(deletion).rejects.toThrow();
      expect(await db.select().from(chatConversations).where(eq(chatConversations.id, conversationId))).toHaveLength(1);
    }
  });

  it("finishes a known pre-submission attempt in PostgreSQL before Chat starts fallback", async () => {
    const { run, runs, orgId, conversationId } = await createRunFixture("Chat safe fallback");
    const persistence = createHeartbeatUnifiedAgentRunAdapter(db);
    const execution = createUnifiedAgentRunExecutionService(persistence);
    let submissionCount = 0;
    const driver = {
      runtimeType: "codex_local",
      reconcileExecution: async (request: Parameters<RuntimeDriver["reconcileExecution"]>[0]) => ({
        status: "supported" as const,
        value: await execution.reconcileAcceptance(request.runId, request.fence, request.outcome),
      }),
      submitInput: async (): Promise<AgentRuntimeExecutionResult> => {
        submissionCount += 1;
        if (submissionCount === 1) {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "provider_unavailable",
            errorMessage: "Primary provider was not submitted",
            submissionPhase: "pre_submission",
            nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
          };
        }
        const persisted = await db.select({
          attemptIndex: heartbeatRunAttempts.attemptIndex,
          status: heartbeatRunAttempts.status,
          submissionPhase: heartbeatRunAttempts.submissionPhase,
        }).from(heartbeatRunAttempts)
          .where(eq(heartbeatRunAttempts.runId, run.id))
          .orderBy(asc(heartbeatRunAttempts.attemptIndex));
        expect(persisted).toEqual([
          expect.objectContaining({ attemptIndex: 0, status: "failed", submissionPhase: "pre_submission" }),
          expect.objectContaining({ attemptIndex: 1, status: "started" }),
        ]);
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "provider_unavailable",
          errorMessage: "Fallback provider was not submitted",
          submissionPhase: "pre_submission",
          nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
        };
      },
    } as unknown as RuntimeDriver;
    const ports = createAttemptPorts({ run, runs, driver, orgId, chatId: conversationId });

    const result = await executeFallback({
      run,
      driver,
      onAttemptSubmissionStart: async (attempt) => {
        expect(run.runtimeAttemptRef?.attemptIndex).toBe(attempt.index);
        expect(await runs.markAcceptanceUnknown(run, {
          phase: "indeterminate",
          reason: "test native provider dispatch",
        })).not.toBeNull();
      },
      onAttemptStart: async (attempt) => {
        await runs.beginRuntimeAttempt(run, {
          attemptIndex: attempt.index,
          fallbackIndex: attempt.fallbackIndex,
          runtimeType: attempt.agentRuntimeType ?? "codex_local",
          model: attempt.model,
          isFallback: attempt.isFallback,
          resumeSource: "fresh",
        });
      },
      onAttemptResult: async (attempt, attemptResult, submissionPhase) => {
        await recordAttemptResult(run, runs, orgId, attempt, attemptResult);
        await ports.onAttemptResult(attempt, attemptResult, submissionPhase);
      },
      onAttemptFailure: ports.onAttemptFailure,
    });

    expect(result).toMatchObject({
      errorMessage: "Fallback provider was not submitted",
      submissionPhase: "pre_submission",
    });
    expect(submissionCount).toBe(2);
    await runs.finishRuntimeAttempt(run, {
      status: "failed",
      submissionPhase: "pre_submission",
      error: result.errorMessage,
    });
    const persisted = await db.select({
      attemptIndex: heartbeatRunAttempts.attemptIndex,
      status: heartbeatRunAttempts.status,
      submissionPhase: heartbeatRunAttempts.submissionPhase,
    }).from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, run.id))
      .orderBy(asc(heartbeatRunAttempts.attemptIndex));
    expect(persisted).toEqual([
      expect.objectContaining({ attemptIndex: 0, status: "failed", submissionPhase: "pre_submission" }),
      expect.objectContaining({ attemptIndex: 1, status: "failed", submissionPhase: "pre_submission" }),
    ]);
    await runs.finalizeRun(run.id, { status: "failed", error: result.errorMessage });
  });

  it("keeps unknown native submission fenced from Chat fallback", async () => {
    const { run, runs, orgId, conversationId } = await createRunFixture("Chat unknown submission");
    const persistence = createHeartbeatUnifiedAgentRunAdapter(db);
    const execution = createUnifiedAgentRunExecutionService(persistence);
    const driver = {
      runtimeType: "codex_local",
      reconcileExecution: async (request: Parameters<RuntimeDriver["reconcileExecution"]>[0]) => ({
        status: "supported" as const,
        value: await execution.reconcileAcceptance(request.runId, request.fence, request.outcome),
      }),
      submitInput: vi.fn(async (): Promise<AgentRuntimeExecutionResult> => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "provider_unavailable",
        errorMessage: "Provider acceptance is unknown",
        submissionPhase: "indeterminate",
        nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
      })),
    } as unknown as RuntimeDriver;
    const ports = createAttemptPorts({ run, runs, driver, orgId, chatId: conversationId });
    const result = await executeFallback({
      run,
      driver,
      onAttemptSubmissionStart: async (attempt) => {
        expect(run.runtimeAttemptRef?.attemptIndex).toBe(attempt.index);
        expect(await runs.markAcceptanceUnknown(run, {
          phase: "indeterminate",
          reason: "test native provider dispatch",
        })).not.toBeNull();
      },
      onAttemptStart: async (attempt) => {
        await runs.beginRuntimeAttempt(run, {
          attemptIndex: attempt.index,
          fallbackIndex: attempt.fallbackIndex,
          runtimeType: attempt.agentRuntimeType ?? "codex_local",
          model: attempt.model,
          isFallback: attempt.isFallback,
          resumeSource: "fresh",
        });
      },
      onAttemptResult: async (attempt, attemptResult, submissionPhase) => {
        await recordAttemptResult(run, runs, orgId, attempt, attemptResult);
        await ports.onAttemptResult(attempt, attemptResult, submissionPhase);
      },
      onAttemptFailure: ports.onAttemptFailure,
    });

    expect(result.errorMessage).toBe("Provider acceptance is unknown");
    expect(driver.submitInput).toHaveBeenCalledTimes(1);
    await runs.finishRuntimeAttempt(run, {
      status: "failed",
      submissionPhase: "indeterminate",
      error: result.errorMessage,
    });
    const attempts = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, run.id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: "failed", submissionPhase: "indeterminate" });
    await expect(runs.beginRuntimeAttempt(run, {
      attemptIndex: 1,
      fallbackIndex: 1,
      runtimeType: "codex_local",
      model: "fallback-model",
      isFallback: true,
      resumeSource: "fresh",
    })).rejects.toThrow("cannot create a retry attempt before reconciling provider acceptance");
    await runs.finalizeRun(run.id, { status: "failed", error: "Provider acceptance is unknown" });
  });

  it("does not start another fallback when a provider throws after dispatch checkpoint", async () => {
    const { run, runs, orgId, conversationId } = await createRunFixture("Chat thrown provider dispatch");
    const driver = {
      runtimeType: "codex_local",
      submitInput: vi.fn(async (): Promise<AgentRuntimeExecutionResult> => {
        throw new Error("Provider transport failed after dispatch");
      }),
    } as unknown as RuntimeDriver;
    const ports = createAttemptPorts({ run, runs, driver, orgId, chatId: conversationId });
    const startedAttemptIndices: number[] = [];
    const onAttemptResult = vi.fn(ports.onAttemptResult);
    const onAttemptFailure = vi.fn(ports.onAttemptFailure);

    await expect(executeFallback({
      run,
      driver,
      onAttemptSubmissionStart: async (attempt) => {
        expect(run.runtimeAttemptRef?.attemptIndex).toBe(attempt.index);
        expect(await runs.markAcceptanceUnknown(run, {
          phase: "indeterminate",
          reason: "test native provider dispatch",
        })).not.toBeNull();
      },
      onAttemptStart: async (attempt) => {
        startedAttemptIndices.push(attempt.index);
        await runs.beginRuntimeAttempt(run, {
          attemptIndex: attempt.index,
          fallbackIndex: attempt.fallbackIndex,
          runtimeType: attempt.agentRuntimeType ?? "codex_local",
          model: attempt.model,
          isFallback: attempt.isFallback,
          resumeSource: "fresh",
        });
      },
      onAttemptResult,
      onAttemptFailure,
    })).rejects.toThrow("Provider transport failed after dispatch");

    expect(driver.submitInput).toHaveBeenCalledTimes(1);
    expect(startedAttemptIndices).toEqual([0]);
    expect(onAttemptResult).not.toHaveBeenCalled();
    expect(onAttemptFailure).not.toHaveBeenCalled();
    const attempts = await db.select({
      attemptIndex: heartbeatRunAttempts.attemptIndex,
      status: heartbeatRunAttempts.status,
      submissionPhase: heartbeatRunAttempts.submissionPhase,
    }).from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, run.id))
      .orderBy(asc(heartbeatRunAttempts.attemptIndex));
    expect(attempts).toEqual([
      expect.objectContaining({ attemptIndex: 0, status: "started", submissionPhase: "indeterminate" }),
    ]);

    await runs.finishRuntimeAttempt(run, {
      status: "failed",
      submissionPhase: "indeterminate",
      error: "Provider acceptance remains unknown",
    });
    await runs.finalizeRun(run.id, { status: "failed", error: "Provider acceptance remains unknown" });
  });

  it("records the exact native result and writer quiescence before starting fallback", async () => {
    const { run, runs, orgId, conversationId } = await createRunFixture("Chat fallback span result");
    const persistence = createHeartbeatUnifiedAgentRunAdapter(db);
    const execution = createUnifiedAgentRunExecutionService(persistence);
    let submissionCount = 0;
    let firstAttemptId: string | null = null;
    const driver = {
      runtimeType: "codex_local",
      reconcileExecution: async (request: Parameters<RuntimeDriver["reconcileExecution"]>[0]) => ({
        status: "supported" as const,
        value: await execution.reconcileAcceptance(request.runId, request.fence, request.outcome),
      }),
      submitInput: async (): Promise<AgentRuntimeExecutionResult> => {
        submissionCount += 1;
        if (submissionCount === 1) {
          firstAttemptId = run.runtimeAttemptRef?.id ?? null;
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "provider_unavailable",
            errorMessage: "Primary provider was not submitted",
            submissionPhase: "pre_submission",
            nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
          };
        }
        const spans = await db.select({
          attemptId: runRuntimeSpans.attemptId,
          state: runRuntimeSpans.state,
          writerLeaseReleasedAt: runRuntimeSpans.writerLeaseReleasedAt,
        }).from(runRuntimeSpans)
          .where(eq(runRuntimeSpans.runId, run.id))
          .orderBy(asc(runRuntimeSpans.ordinal));
        expect(firstAttemptId).toBeTruthy();
        expect(spans[0]).toMatchObject({
          attemptId: firstAttemptId,
          state: "sealed",
          writerLeaseReleasedAt: expect.any(Date),
        });
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "provider_unavailable",
          errorMessage: "Fallback provider was not submitted",
          submissionPhase: "pre_submission",
          nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
        };
      },
    } as unknown as RuntimeDriver;
    const ports = createAttemptPorts({ run, runs, driver, orgId, chatId: conversationId });
    const result = await executeFallback({
      run,
      driver,
      onAttemptSubmissionStart: async (attempt) => {
        expect(run.runtimeAttemptRef?.attemptIndex).toBe(attempt.index);
        expect(await runs.markAcceptanceUnknown(run, {
          phase: "indeterminate",
          reason: "test native provider dispatch",
        })).not.toBeNull();
      },
      onAttemptStart: async (attempt) => {
        await runs.beginRuntimeAttempt(run, {
          attemptIndex: attempt.index,
          fallbackIndex: attempt.fallbackIndex,
          runtimeType: attempt.agentRuntimeType ?? "codex_local",
          model: attempt.model,
          isFallback: attempt.isFallback,
          resumeSource: "fresh",
        });
      },
      onAttemptResult: async (attempt, attemptResult, submissionPhase) => {
        const recorded = await recordAttemptResult(run, runs, orgId, attempt, attemptResult);
        expect(hasConfirmedNativeWriterQuiescence(attemptResult)).toBe(true);
        if (!recorded) throw new Error("Native attempt result was not persisted before Chat fallback");
        expect(recorded.state).toBe("sealed");
        await ports.onAttemptResult(attempt, attemptResult, submissionPhase);
      },
      onAttemptFailure: ports.onAttemptFailure,
    });

    expect(result.errorMessage).toBe("Fallback provider was not submitted");
    expect(submissionCount).toBe(2);
    await runs.finishRuntimeAttempt(run, {
      status: "failed",
      submissionPhase: "pre_submission",
      error: result.errorMessage,
    });
    await runs.finalizeRun(run.id, { status: "failed", error: result.errorMessage });
  });
});
