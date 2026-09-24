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
import { and, eq, inArray } from "drizzle-orm";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chatAgentRunService } from "./chat-agent-runs.js";
import { ChatAssistantStreamError } from "./chat-assistant.contracts.js";
import {
  classifyClaudeDeferredForkRecovery,
  ClaudeDeferredForkRecoveryIdentityError,
} from "./claude-deferred-fork-admission.js";
import { canRestartPristineClaudeFork, recoverClaudeDeferredForkRun } from "./chat-assistant.claude-fork-recovery.js";
import { ensureRuntimeBinding, existingNativeSession } from "./runtime-kernel/native-session.js";
import {
  createHeartbeatUnifiedAgentRunAdapter,
} from "./runtime-kernel/unified-agent-run.integration.js";
import {
  persistNativeForkChild,
  reserveNativeForkIntent,
  type NativeForkIntentRunFence,
} from "./runtime-kernel/native-fork-intent.js";
import type { SideChatForkSource } from "./side-chat-runtime-admission.js";

const verifySourceHead = vi.hoisted(() => vi.fn());

vi.mock("@rudderhq/agent-runtime-claude-local/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rudderhq/agent-runtime-claude-local/server")>();
  return { ...actual, verifyClaudeSessionAssistantHead: verifySourceHead };
});

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

type ChatRuns = ReturnType<typeof chatAgentRunService>;
type CreatedChatRun = Awaited<ReturnType<ChatRuns["createRun"]>>;

const providerIdentity = {
  hostId: "local",
  profileId: "default",
  workspaceBindingId: null,
  capabilityRevision: "claude-test-capability-1",
};

const createdOrgIds = new Set<string>();
const ownedRuns: Array<{ runs: ChatRuns; runId: string; ownerToken: string }> = [];

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
  const externalUrl = process.env.RUDDER_CLAUDE_FORK_RECOVERY_TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await applyPendingMigrations(externalUrl);
    return { connectionString: externalUrl, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-claude-fork-recovery-"));
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

function fenceFromRun(run: CreatedChatRun): NativeForkIntentRunFence {
  if (!run.runtimeSpanId || !run.runtimeSpanOwnerToken || !run.runtimeSpanAttemptEpoch) {
    throw new Error("Chat fixture Run did not return its owned Span fence");
  }
  return {
    runId: run.id,
    spanId: run.runtimeSpanId,
    ownerToken: run.runtimeSpanOwnerToken,
    attemptEpoch: run.runtimeSpanAttemptEpoch,
  };
}

describe("Claude deferred fork recovery against durable Run rows", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    for (const owned of ownedRuns.splice(0)) {
      owned.runs.releaseOwnedRun(owned.runId, owned.ownerToken);
    }
    const orgIds = [...createdOrgIds];
    createdOrgIds.clear();
    if (orgIds.length === 0) return;
    await db.delete(heartbeatRunEvents).where(inArray(heartbeatRunEvents.orgId, orgIds));
    await db.delete(heartbeatRunAttempts).where(inArray(heartbeatRunAttempts.orgId, orgIds));
    await db.delete(runRuntimeSpans).where(inArray(runRuntimeSpans.orgId, orgIds));
    await db.delete(nativeSegments).where(inArray(nativeSegments.orgId, orgIds));
    await db.delete(runtimeBindings).where(inArray(runtimeBindings.orgId, orgIds));
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.orgId, orgIds));
    await db.delete(chatConversations).where(inArray(chatConversations.orgId, orgIds));
    await db.delete(agents).where(inArray(agents.orgId, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  async function seedCrashCut() {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const sourceConversationId = randomUUID();
    const conversationId = randomUUID();
    const sourceBindingId = randomUUID();
    const bindingId = randomUUID();
    const sourceSegmentId = randomUUID();
    const segmentId = randomUUID();
    const sourceRunId = randomUUID();
    const sourceSpanId = randomUUID();
    const createdAt = new Date(Date.now() - 120_000);
    const sealedAt = new Date(createdAt.getTime() + 1_000);
    const sourceBoundaryRef = "parent-assistant-1";
    const sourceSelector = {
      kind: "claude_chain",
      sessionId: "source-session",
      startExclusiveUuid: null,
      throughInclusiveUuid: sourceBoundaryRef,
    };
    const sourceSession = {
      sessionId: "source-session",
      sessionDisplayId: "source-session",
      sessionParams: {
        sessionId: "source-session",
        profileBindingId: sourceBindingId,
        profileOrgId: orgId,
        ...providerIdentity,
      },
    };
    const descriptor = {
      version: 1 as const,
      kind: "claude_fork_on_first_input" as const,
      sourceBindingId,
      sourceSession,
      sourceSelector: {
        kind: "claude_chain" as const,
        sessionId: "source-session",
        throughInclusiveUuid: sourceBoundaryRef,
      },
    };
    const sourceAdmission = {
      continuity: "native",
      sourceConversationId,
      sourceMessageId: randomUUID(),
      sourceRunId,
      sourceSpanId,
      sourceBoundaryRef,
      sourceSelectorJson: sourceSelector,
      deferredForkDescriptor: descriptor,
      providerCapability: { status: "supported", reason: "verified Claude assistant head" },
      downgradeReason: null,
      sessionIntent: {
        kind: "fork",
        sourceRunId,
        sourceBoundaryRef,
        sessionId: null,
        sessionParams: null,
      },
    };
    createdOrgIds.add(orgId);

    await db.insert(organizations).values({
      id: orgId,
      name: `Claude fork recovery ${orgId}`,
      urlKey: deriveOrganizationUrlKey(`claude-fork-recovery-${orgId}`),
      issuePrefix: `CFR${orgId.slice(0, 8).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Claude fork recovery agent",
      role: "engineer",
      agentRuntimeType: "claude_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values([
      { id: sourceConversationId, orgId, title: "Claude source" },
      { id: conversationId, orgId, title: "Claude side chat", conversationKind: "side_chat" },
    ]);
    await db.insert(runtimeBindings).values([
      {
        id: sourceBindingId,
        orgId,
        conversationId: sourceConversationId,
        principalScopeRef: "test:claude-principal",
        agentId,
        runtimeType: "claude_local",
        ...providerIdentity,
        instructionsRevision: "claude-instructions-1",
        continuity: "native",
        bindingEpoch: 0,
        status: "active",
      },
      {
        id: bindingId,
        orgId,
        conversationId,
        principalScopeRef: "test:claude-principal",
        agentId,
        runtimeType: "claude_local",
        ...providerIdentity,
        instructionsRevision: "claude-instructions-1",
        continuity: "native",
        parentBindingId: sourceBindingId,
        sourceBoundaryRef,
        bindingEpoch: 0,
        status: "active",
      },
    ]);
    await db.insert(nativeSegments).values([
      {
        id: sourceSegmentId,
        orgId,
        bindingId: sourceBindingId,
        runtimeType: "claude_local",
        segmentOrdinal: 0,
        nativeSessionId: sourceSession.sessionId,
        rootSessionId: sourceSession.sessionId,
        leafId: sourceBoundaryRef,
        sourceBoundaryRef,
        providerStateJson: sourceSession.sessionParams,
        state: "sealed",
        createdAt,
        sealedAt,
        updatedAt: sealedAt,
      },
      {
        id: segmentId,
        orgId,
        bindingId,
        runtimeType: "claude_local",
        segmentOrdinal: 0,
        providerStateJson: null,
        state: "pending",
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    await db.update(runtimeBindings).set({ currentSegmentId: sourceSegmentId })
      .where(and(eq(runtimeBindings.id, sourceBindingId), eq(runtimeBindings.orgId, orgId)));
    await db.update(runtimeBindings).set({ currentSegmentId: segmentId })
      .where(and(eq(runtimeBindings.id, bindingId), eq(runtimeBindings.orgId, orgId)));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      orgId,
      agentId,
      invocationSource: "chat",
      status: "succeeded",
      chatConversationId: sourceConversationId,
      sessionIdAfter: sourceSession.sessionId,
      contextSnapshot: { runtimeProviderProfile: { runtimeType: "claude_local" } },
      startedAt: createdAt,
      finishedAt: sealedAt,
    });
    await db.insert(runRuntimeSpans).values({
      id: sourceSpanId,
      orgId,
      runId: sourceRunId,
      bindingId: sourceBindingId,
      segmentId: sourceSegmentId,
      attemptRef: "claude-source-attempt",
      attemptEpoch: 1,
      ownerToken: "claude-source-owner",
      ordinal: 0,
      relation: "primary",
      nativeExecutionRef: sourceBoundaryRef,
      selectorJson: sourceSelector,
      state: "sealed",
      completeness: "complete",
      openedAt: createdAt,
      closedAt: sealedAt,
      updatedAt: sealedAt,
    });

    const [sourceBinding] = await db.select().from(runtimeBindings)
      .where(eq(runtimeBindings.id, sourceBindingId));
    const [targetBinding] = await db.select().from(runtimeBindings)
      .where(eq(runtimeBindings.id, bindingId));
    const [targetSegment] = await db.select().from(nativeSegments)
      .where(eq(nativeSegments.id, segmentId));
    if (!sourceBinding || !targetBinding || !targetSegment) {
      throw new Error("Claude fork crash-cut fixture identity rows were not created");
    }

    const runs = chatAgentRunService(db, { leaseRenewIntervalMs: 60_000 });
    const run = await runs.createRun({
      conversation: { id: conversationId, orgId, primaryIssueId: null, planMode: false },
      agentId,
      triggerDetail: "chat_assistant_reply",
      userMessageId: randomUUID(),
      linkedIssueIds: [],
      linkedProjectId: null,
      sourceMetadata: { sideChatRuntimeAdmission: sourceAdmission },
      runContext: { runtimeProviderProfile: { runtimeType: "claude_local" } },
      runtimeBinding: targetBinding,
      runtimeSegment: targetSegment,
      sourceRunId,
      sourceSpanId,
      sourceSelectorJson: sourceSelector,
      runtimeResumeSource: "fresh",
      scene: "side_chat",
      idempotencyKey: `side-chat-run:${conversationId}`,
      sessionIntent: {
        kind: "fork",
        sourceRunId,
        sourceBoundaryRef,
        sessionId: null,
        sessionParams: null,
      },
    });
    const originalFence = fenceFromRun(run);
    ownedRuns.push({ runs, runId: run.id, ownerToken: originalFence.ownerToken });

    const source: SideChatForkSource = {
      sourceConversationId,
      sourceMessageId: sourceAdmission.sourceMessageId,
      sourceRunId,
      sourceSpanId,
      sourceBoundaryRef,
      selectorJson: sourceSelector,
      session: sourceSession,
      sourceBinding: {
        id: sourceBinding.id,
        orgId,
        runtimeType: sourceBinding.runtimeType,
        principalScopeRef: sourceBinding.principalScopeRef,
        hostId: sourceBinding.hostId,
        profileId: sourceBinding.profileId,
        workspaceBindingId: sourceBinding.workspaceBindingId,
        capabilityRevision: sourceBinding.capabilityRevision,
      },
    };
    const bindingInput = {
      orgId,
      conversationId,
      agentId,
      runtimeType: "claude_local",
      principalScopeRef: "test:claude-principal",
      hostId: providerIdentity.hostId,
      profileId: providerIdentity.profileId,
      workspaceBindingId: providerIdentity.workspaceBindingId,
      instructionsRevision: "claude-instructions-1",
      capabilityRevision: providerIdentity.capabilityRevision,
      continuity: "native" as const,
      parentBindingId: sourceBindingId,
      sourceBoundaryRef,
    };
    const providerBinding = {
      orgId,
      hostId: providerIdentity.hostId,
      profileId: providerIdentity.profileId,
      workspaceBindingId: providerIdentity.workspaceBindingId,
      capabilityRevision: providerIdentity.capabilityRevision,
    };

    return {
      orgId,
      conversationId,
      agentId,
      sourceRunId,
      sourceSpanId,
      sourceBoundaryRef,
      sourceSelector,
      sourceSession,
      source,
      descriptor,
      bindingId,
      segmentId,
      targetBinding,
      targetSegment,
      bindingInput,
      providerBinding,
      runs,
      run,
      originalFence,
    };
  }

  async function recoverOwner(fixture: Awaited<ReturnType<typeof seedCrashCut>>) {
    fixture.runs.releaseOwnedRun(fixture.run.id, fixture.originalFence.ownerToken);
    await db.update(heartbeatRuns)
      .set({ executionLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, fixture.run.id));
    const ownerToken = `claude-recovered-${randomUUID()}`;
    const claim = await createHeartbeatUnifiedAgentRunAdapter(db).claimOwner(fixture.run.id, { ownerToken });
    if (!claim.ok) throw new Error(`Expected recovered Run owner claim, got ${claim.reason}`);
    const runs = chatAgentRunService(db, { leaseRenewIntervalMs: 60_000 });
    const run = await runs.adoptRecoveredRun(fixture.run.id, ownerToken);
    if (!run) throw new Error("Expected the recovered Claude Side Chat Run to be adopted");
    const runFence = fenceFromRun(run);
    ownedRuns.push({ runs, runId: run.id, ownerToken: runFence.ownerToken });
    return { runs, run, runFence };
  }

  function classify(
    fixture: Awaited<ReturnType<typeof seedCrashCut>>,
    runFence: NativeForkIntentRunFence,
  ) {
    return classifyClaudeDeferredForkRecovery({
      db,
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      runId: fixture.run.id,
      bindingId: fixture.bindingId,
      segmentId: fixture.segmentId,
      runFence,
    });
  }

  function recover(
    fixture: Awaited<ReturnType<typeof seedCrashCut>>,
    owner: Awaited<ReturnType<typeof recoverOwner>>,
    run: CreatedChatRun,
    runFence: NativeForkIntentRunFence,
    finalize: (state: Parameters<ChatRuns["finalizeRun"]>[1]) => Promise<unknown> =
      (state) => owner.runs.finalizeRun(run.id, state),
  ) {
    return recoverClaudeDeferredForkRun({
      db,
      orgId: fixture.orgId,
      conversationId: fixture.conversationId,
      run,
      bindingId: fixture.bindingId,
      segmentId: fixture.segmentId,
      runFence,
      allowProviderSubmission: false,
      source: null,
      sourceBindingMatchesTarget: false,
      bindingInput: fixture.bindingInput,
      providerBinding: fixture.providerBinding,
      config: {},
      finalize,
    });
  }

  it("classifies a descriptor-only crash cut read-only under the adopted owner, including concurrent recovery", async () => {
    verifySourceHead.mockClear();
    const fixture = await seedCrashCut();
    const owner = await recoverOwner(fixture);

    await expect(classify(fixture, fixture.originalFence))
      .rejects.toBeInstanceOf(ClaudeDeferredForkRecoveryIdentityError);
    const classifications = await Promise.all([
      classify(fixture, owner.runFence),
      classify(fixture, owner.runFence),
    ]);

    expect(classifications).toHaveLength(2);
    expect(classifications).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "descriptor_only",
        idempotencyKey: `side-chat:${fixture.conversationId}`,
      }),
    ]));
    expect(classifications.every((result) => result.status === "descriptor_only")).toBe(true);
    expect(verifySourceHead).not.toHaveBeenCalled();

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.run.id));
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, owner.runFence.spanId));
    const [segment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, fixture.segmentId));
    expect(run).toMatchObject({ status: "running", executionOwnerToken: owner.runFence.ownerToken });
    expect(span).toMatchObject({
      state: "open",
      ownerToken: owner.runFence.ownerToken,
      attemptEpoch: owner.runFence.attemptEpoch,
      nativeExecutionRef: null,
    });
    expect(segment).toMatchObject({ state: "pending", nativeSessionId: null, providerStateJson: null });
  });

  it("adjudicates an unsubmitted terminal fork and rotates only its pristine Binding for handoff", async () => {
    const fixture = await seedCrashCut();
    const owner = await recoverOwner(fixture);
    await expect(recover(fixture, owner, owner.run, owner.runFence)).rejects.toMatchObject({
      errorCode: "claude_fork_unsubmitted",
    });
    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.run.id));
    expect(failed).toMatchObject({ status: "failed", errorCode: "claude_fork_unsubmitted" });
    expect(await canRestartPristineClaudeFork({
      db, binding: fixture.targetBinding, runtimeType: "claude_local",
      orgId: fixture.orgId, conversationId: fixture.conversationId,
    })).toBe(true);
    await db.update(heartbeatRuns).set({ errorCode: "claude_fork_completion_unresolved" })
      .where(eq(heartbeatRuns.id, fixture.run.id));
    expect(await canRestartPristineClaudeFork({
      db, binding: fixture.targetBinding, runtimeType: "claude_local",
      orgId: fixture.orgId, conversationId: fixture.conversationId,
    })).toBe(false);
    await db.update(heartbeatRuns).set({ errorCode: "claude_fork_unsubmitted" })
      .where(eq(heartbeatRuns.id, fixture.run.id));
    const handoff = await ensureRuntimeBinding(db, {
      ...fixture.bindingInput, continuity: "context_handoff", rotateForPristineForkHandoff: true,
    });
    expect(handoff).toMatchObject({
      bindingEpoch: 1, continuity: "context_handoff", parentBindingId: fixture.bindingId,
    });
    expect(handoff.id).not.toBe(fixture.bindingId);
    const [oldBinding] = await db.select().from(runtimeBindings).where(eq(runtimeBindings.id, fixture.bindingId));
    expect(oldBinding?.status).toBe("superseded");
  });

  it("settles a persisted accepted child once recovered, rejects the stale owner, and reads back partial terminal evidence", async () => {
    verifySourceHead.mockClear();
    const fixture = await seedCrashCut();
    const reserved = await reserveNativeForkIntent(db, {
      idempotencyKey: `side-chat:${fixture.conversationId}`,
      source: {
        orgId: fixture.orgId,
        sourceConversationId: fixture.source.sourceConversationId,
        sourceRunId: fixture.sourceRunId,
        sourceSpanId: fixture.sourceSpanId,
        sourceBoundaryRef: fixture.sourceBoundaryRef,
        selectorJson: fixture.sourceSelector,
      },
      targetBinding: fixture.targetBinding,
      targetSegment: fixture.targetSegment,
      providerBinding: { ...fixture.providerBinding, id: fixture.bindingId },
      runFence: fixture.originalFence,
    });
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") throw new Error("Expected an owner-fenced Claude fork reservation");
    const child = {
      session: {
        sessionId: "child-session",
        sessionDisplayId: "child-session",
        sessionParams: {
          sessionId: "child-session",
          rootSessionId: fixture.sourceSession.sessionId,
          profileBindingId: fixture.bindingId,
          profileOrgId: fixture.orgId,
          ...providerIdentity,
        },
      },
      boundary: "child-assistant-1",
      sourceBoundary: fixture.sourceBoundaryRef,
      continuity: "native" as const,
    };
    await persistNativeForkChild(db, {
      reference: reserved.reference,
      runFence: fixture.originalFence,
      child,
    });
    const owner = await recoverOwner(fixture);
    const finalize = vi.fn((state: Parameters<ChatRuns["finalizeRun"]>[1]) =>
      owner.runs.finalizeRun(owner.run.id, state));

    await expect(recover(fixture, owner, fixture.run, fixture.originalFence, finalize))
      .rejects.toBeInstanceOf(ClaudeDeferredForkRecoveryIdentityError);
    expect(finalize).not.toHaveBeenCalled();
    const [afterStaleRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.run.id));
    const [afterStaleSpan] = await db.select().from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.id, owner.runFence.spanId));
    const [afterStaleSegment] = await db.select().from(nativeSegments)
      .where(eq(nativeSegments.id, fixture.segmentId));
    expect(afterStaleRun?.status).toBe("running");
    expect(afterStaleSpan).toMatchObject({
      state: "open",
      ownerToken: owner.runFence.ownerToken,
      attemptEpoch: owner.runFence.attemptEpoch,
      nativeExecutionRef: child.boundary,
    });
    expect(afterStaleSegment).toMatchObject({
      state: "open",
      nativeSessionId: child.session.sessionId,
      providerStateJson: { __rudderNativeForkIntent: { status: "accepted" } },
    });

    const outcomes = await Promise.allSettled([
      recover(fixture, owner, owner.run, owner.runFence, finalize),
      recover(fixture, owner, owner.run, owner.runFence, finalize),
    ]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(outcomes.some((outcome) => outcome.status === "rejected"
      && outcome.reason instanceof ChatAssistantStreamError
      && outcome.reason.errorCode === "claude_fork_completion_unresolved"), JSON.stringify(outcomes.map((outcome) =>
      outcome.status === "rejected"
        ? { name: outcome.reason?.name, message: outcome.reason?.message, errorCode: outcome.reason?.errorCode }
        : { status: outcome.status }))).toBe(true);
    expect(verifySourceHead).not.toHaveBeenCalled();

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.run.id));
    const [attempt] = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, fixture.run.id));
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, owner.runFence.spanId));
    const [segment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, fixture.segmentId));
    const session = await existingNativeSession(db, fixture.targetBinding);

    expect(run).toMatchObject({
      status: "failed",
      errorCode: "claude_fork_completion_unresolved",
      sessionIdAfter: "child-session",
      sessionParamsAfterJson: child.session.sessionParams,
      resultJson: {
        outcome: "failed",
        recoverable: false,
        nativeCompletion: "partial",
        providerSessionId: "child-session",
        providerTurnId: "child-assistant-1",
      },
    });
    expect(attempt).toMatchObject({
      status: "failed",
      submissionPhase: "accepted",
      checkpointJson: { unifiedSubmission: { state: "accepted", retry: "not_allowed" } },
      providerThreadId: "child-session",
      providerTurnId: "child-assistant-1",
      sessionDisplayId: "child-session",
      sessionParamsJson: child.session.sessionParams,
      errorCode: "claude_fork_completion_unresolved",
    });
    expect(span).toMatchObject({
      state: "sealed",
      completeness: "partial",
      nativeExecutionRef: "child-assistant-1",
      selectorJson: {
        kind: "claude_chain",
        sessionId: "child-session",
        startExclusiveUuid: fixture.sourceBoundaryRef,
        throughInclusiveUuid: "child-assistant-1",
        boundaryStatus: "unknown",
      },
    });
    expect(segment).toMatchObject({
      state: "open",
      nativeSessionId: "child-session",
      providerStateJson: {
        sessionId: "child-session",
        ["__rudderNativeForkIntent"]: { status: "accepted", child },
      },
    });
    expect(session).toMatchObject({
      sessionId: "child-session",
      sessionParams: expect.objectContaining({ profileBindingId: fixture.bindingId }),
    });
    expect(finalize.mock.calls.length).toBeGreaterThan(0);
  });
});
