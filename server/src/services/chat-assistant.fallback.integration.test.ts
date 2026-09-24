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
import { asc, eq, inArray } from "drizzle-orm";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  ModelAttemptSpec,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
import { chatAgentRunService } from "./chat-agent-runs.js";
import {
  chatAttemptFailureFinishInput,
  createChatAssistantRuntimeDriverPorts,
} from "./chat-assistant.runtime-driver.js";
import { executeAdapterWithModelFallbacks } from "./runtime-kernel/model-fallback.js";
import type { RuntimeDriver, RuntimeDriverApprovalBridge } from "./runtime-kernel/runtime-driver.js";
import { currentNativeSession, ensureRuntimeBinding } from "./runtime-kernel/native-session.js";
import {
  createHeartbeatUnifiedAgentRunAdapter,
  createUnifiedAgentRunExecutionService,
} from "./runtime-kernel/unified-agent-run.integration.js";

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
    await db.delete(heartbeatRunEvents).where(inArray(heartbeatRunEvents.orgId, orgIds));
    await db.delete(heartbeatRunAttempts).where(inArray(heartbeatRunAttempts.orgId, orgIds));
    await db.delete(runRuntimeSpans).where(inArray(runRuntimeSpans.orgId, orgIds));
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.orgId, orgIds));
    await db.delete(nativeSegments).where(inArray(nativeSegments.orgId, orgIds));
    await db.delete(runtimeBindings).where(inArray(runtimeBindings.orgId, orgIds));
    await db.delete(chatConversations).where(inArray(chatConversations.orgId, orgIds));
    await db.delete(agents).where(inArray(agents.orgId, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
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
      issuePrefix: "CHAT",
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
      onAttemptResult: input.onAttemptResult,
      onAttemptFailure: input.onAttemptFailure,
    });
    expect(adapter.execute).not.toHaveBeenCalled();
    return result;
  }

  it("finishes a known pre-submission attempt in PostgreSQL before Chat starts fallback", async () => {
    const { run, runs } = await createRunFixture("Chat safe fallback");
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
        };
      },
    } as unknown as RuntimeDriver;
    const ports = createAttemptPorts({ run, runs, driver });

    const result = await executeFallback({
      run,
      driver,
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
      onAttemptResult: ports.onAttemptResult,
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
    const { run, runs } = await createRunFixture("Chat unknown submission");
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
      })),
    } as unknown as RuntimeDriver;
    const ports = createAttemptPorts({ run, runs, driver });
    const result = await executeFallback({
      run,
      driver,
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
      onAttemptResult: ports.onAttemptResult,
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
});
