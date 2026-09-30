import type { Db } from "@rudderhq/db";
import {
  agents,
  applyPendingMigrations,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunAttempts,
  heartbeatRuns,
  nativeSegments,
  organizations,
  runRuntimeSpans,
  runtimeBindings,
  runtimeSourceAliases,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chatAgentRunService } from "../chat-agent-runs.js";
import { nativeForkContentHash } from "../chats.native-fork-aliases.js";
import {
  executeNativeForkIntent,
  markNativeForkIntentRejected,
  markNativeForkIntentUnknown,
  NativeForkAcceptanceUnknownError,
  nativeForkIntentKey,
  persistNativeForkChild,
  preserveNativeForkIntentProviderState,
  readNativeForkIntent,
  reconcileNativeForkIntent,
  reconcileNativeForkIntentById,
  reserveNativeForkIntent,
  type NativeForkIntentInput,
  type NativeForkIntentRunFence,
} from "./native-fork-intent.js";
import { releaseTerminalRunRuntimeSpanWriters } from "./native-session.js";
import type { RuntimeProviderForkResult, RuntimeProviderSessionRef } from "./provider-capabilities.js";
import { createHeartbeatUnifiedAgentRunAdapter } from "./unified-agent-run.integration.js";

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
  const externalUrl = process.env.RUDDER_NATIVE_FORK_INTENT_TEST_DATABASE_URL?.trim();
  if (externalUrl) {
    await applyPendingMigrations(externalUrl);
    return { connectionString: externalUrl, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-native-fork-intent-"));
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

const runtimeType = "codex_local";
const providerIdentity = {
  hostId: "local",
  profileId: "profile-1",
  workspaceBindingId: "workspace-1",
  capabilityRevision: "capability-1",
};

type ForkFixture = {
  orgId: string;
  agentId: string;
  sourceConversationId: string;
  targetConversationId: string;
  sourceRunId: string;
  sourceSegmentId: string;
  sourceBindingId: string;
  targetBindingId: string;
  sourceSession: RuntimeProviderSessionRef;
  sourceBoundaryRef: string;
  sourceSelector: Record<string, unknown>;
  input: NativeForkIntentInput;
};

const createdOrgIds = new Set<string>();

function injectRunSpanUpdateFailure(database: Db): Db {
  function failOnReturning(query: object): object {
    return new Proxy(query, {
      get(target, property) {
        if (property === "returning") {
          return () => { throw new Error("injected native fork span write failure"); };
        }
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const next = Reflect.apply(value, target, args) as unknown;
          return next && typeof next === "object" ? failOnReturning(next) : next;
        };
      },
    });
  }

  return {
    transaction: (callback: (tx: unknown) => Promise<unknown>) => database.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const wrappedTx = new Proxy(tx, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (property === "update" && typeof value === "function") {
            return (...args: unknown[]) => {
              const query = Reflect.apply(value, target, args) as unknown;
              if (args[0] !== runRuntimeSpans || !query || typeof query !== "object") return query;
              return failOnReturning(query);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return callback(wrappedTx);
    }),
  } as unknown as Db;
}

describe("durable native fork intent", () => {
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
    const orgIds = [...createdOrgIds];
    createdOrgIds.clear();
    if (orgIds.length === 0) return;
    const where = inArray(organizations.id, orgIds);
    const spans = await db.select().from(runRuntimeSpans).where(inArray(runRuntimeSpans.orgId, orgIds));
    for (const span of spans) {
      if (span.writerLeaseReleasedAt) continue;
      const [run] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, span.runId),
        eq(heartbeatRuns.orgId, span.orgId),
      ));
      const [latestAttempt] = await db.select().from(heartbeatRunAttempts).where(and(
        eq(heartbeatRunAttempts.orgId, span.orgId),
        eq(heartbeatRunAttempts.runId, span.runId),
      )).orderBy(desc(heartbeatRunAttempts.attemptIndex)).limit(1);
      if (!run || run.processPid !== null || !latestAttempt || span.attemptId !== latestAttempt.id) {
        throw new Error(`Cannot clean test writer without exact unstarted-attempt proof for span ${span.id}`);
      }

      // This suite admits fork targets but never starts their execution process.
      const exitedAt = new Date();
      await db.update(heartbeatRuns).set({
        status: "failed",
        finishedAt: exitedAt,
        processExitedAt: exitedAt,
        executionLeaseExpiresAt: null,
        terminalEffectsPending: false,
      }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.orgId, run.orgId)));
      const releasedSpanIds = await releaseTerminalRunRuntimeSpanWriters(db, {
        orgId: span.orgId,
        runId: span.runId,
        spanId: span.id,
        proof: {
          exitCode: null,
          signal: "process-exit-confirmed",
          timedOut: false,
          nativeWriterQuiescence: { status: "confirmed", source: "process_exit" },
        },
      });
      if (!releasedSpanIds.includes(span.id)) {
        throw new Error(`Test writer release did not acknowledge exact span ${span.id}`);
      }
    }
    await db.delete(runtimeSourceAliases).where(inArray(runtimeSourceAliases.orgId, orgIds));
    await db.delete(runRuntimeSpans).where(inArray(runRuntimeSpans.orgId, orgIds));
    await db.delete(nativeSegments).where(inArray(nativeSegments.orgId, orgIds));
    await db.delete(runtimeBindings).where(inArray(runtimeBindings.orgId, orgIds));
    await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.orgId, orgIds));
    await db.delete(chatConversations).where(inArray(chatConversations.orgId, orgIds));
    await db.delete(agents).where(inArray(agents.orgId, orgIds));
    await db.delete(organizations).where(where);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function fixture(options: { spanBoundary?: string | null } = {}): Promise<ForkFixture> {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const sourceConversationId = randomUUID();
    const targetConversationId = randomUUID();
    const sourceBindingId = randomUUID();
    const targetBindingId = randomUUID();
    const sourceSegmentId = randomUUID();
    const targetSegmentId = randomUUID();
    const sourceRunId = randomUUID();
    const sourceSpanId = randomUUID();
    const createdAt = new Date("2026-09-23T00:00:00.000Z");
    const sealedAt = new Date("2026-09-23T00:01:00.000Z");
    const sourceBoundaryRef = options.spanBoundary ?? "source-execution";
    const sourceSelector = {
      kind: "codex_turn",
      threadId: "source-session",
      turnId: sourceBoundaryRef,
      inputCorrelationRef: "source-attempt",
    } satisfies Record<string, unknown>;
    createdOrgIds.add(orgId);

    await db.insert(organizations).values({
      id: orgId,
      name: `Native fork intent ${orgId}`,
      urlKey: deriveOrganizationUrlKey(`native-fork-intent-${orgId}`),
      issuePrefix: `NFI${orgId.slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Native fork intent agent",
      role: "engineer",
      agentRuntimeType: runtimeType,
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values([
      { id: sourceConversationId, orgId, title: "Source" },
      { id: targetConversationId, orgId, title: "Target" },
    ]);
    await db.insert(runtimeBindings).values([
      {
        id: sourceBindingId,
        orgId,
        conversationId: sourceConversationId,
        principalScopeRef: "principal-1",
        agentId,
        runtimeType,
        ...providerIdentity,
        instructionsRevision: "instructions-1",
        continuity: "native",
        bindingEpoch: 0,
        status: "active",
      },
      {
        id: targetBindingId,
        orgId,
        conversationId: targetConversationId,
        principalScopeRef: "principal-1",
        agentId,
        runtimeType,
        ...providerIdentity,
        instructionsRevision: "instructions-1",
        continuity: "native",
        parentBindingId: sourceBindingId,
        bindingEpoch: 0,
        status: "active",
      },
    ]);
    await db.insert(nativeSegments).values([
      {
        id: sourceSegmentId,
        orgId,
        bindingId: sourceBindingId,
        runtimeType,
        segmentOrdinal: 0,
        nativeSessionId: "source-session",
        rootSessionId: "source-session",
        leafId: "source-head",
        sourceBoundaryRef: "source-legacy-boundary",
        state: "sealed",
        createdAt,
        sealedAt,
        updatedAt: sealedAt,
        providerStateJson: {
          sessionId: "source-session",
          profileBindingId: sourceBindingId,
          profileOrgId: orgId,
          hostId: providerIdentity.hostId,
          profileId: providerIdentity.profileId,
          workspaceBindingId: providerIdentity.workspaceBindingId,
          capabilityRevision: providerIdentity.capabilityRevision,
        },
      },
      {
        id: targetSegmentId,
        orgId,
        bindingId: targetBindingId,
        runtimeType,
        segmentOrdinal: 0,
        state: "pending",
        providerStateJson: null,
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    await db.update(runtimeBindings).set({ currentSegmentId: sourceSegmentId }).where(and(
      eq(runtimeBindings.id, sourceBindingId),
      eq(runtimeBindings.orgId, orgId),
    ));
    await db.update(runtimeBindings).set({ currentSegmentId: targetSegmentId }).where(and(
      eq(runtimeBindings.id, targetBindingId),
      eq(runtimeBindings.orgId, orgId),
    ));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      orgId,
      agentId,
      invocationSource: "chat",
      status: "succeeded",
      chatConversationId: sourceConversationId,
      sessionReuseScope: "explicit",
      startedAt: createdAt,
      finishedAt: sealedAt,
    });
    await db.insert(runRuntimeSpans).values({
      id: sourceSpanId,
      orgId,
      runId: sourceRunId,
      bindingId: sourceBindingId,
      segmentId: sourceSegmentId,
      attemptRef: "source-attempt",
      attemptEpoch: 1,
      ownerToken: "source-owner",
      ordinal: 0,
      relation: "primary",
      nativeExecutionRef: options.spanBoundary === undefined ? sourceBoundaryRef : options.spanBoundary,
      selectorJson: sourceSelector,
      state: "sealed",
      completeness: "complete",
      openedAt: createdAt,
      closedAt: sealedAt,
      writerLeaseReleasedAt: sealedAt,
      updatedAt: sealedAt,
    });

    const [targetBinding] = await db.select().from(runtimeBindings).where(eq(runtimeBindings.id, targetBindingId));
    const [targetSegment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, targetSegmentId));
    if (!targetBinding || !targetSegment) throw new Error("fork fixture target rows were not created");
    const targetProviderBinding = {
      id: targetBinding.id,
      orgId,
      ...providerIdentity,
    };
    const sourceSession: RuntimeProviderSessionRef = {
      sessionId: "source-session",
      sessionDisplayId: "source-session",
      sessionParams: {
        sessionId: "source-session",
        profileBindingId: sourceBindingId,
        profileOrgId: orgId,
        hostId: providerIdentity.hostId,
        profileId: providerIdentity.profileId,
        workspaceBindingId: providerIdentity.workspaceBindingId,
        capabilityRevision: providerIdentity.capabilityRevision,
      },
    };
    return {
      orgId,
      agentId,
      sourceConversationId,
      targetConversationId,
      sourceRunId,
      sourceSegmentId,
      sourceBindingId,
      targetBindingId,
      sourceSession,
      sourceBoundaryRef,
      sourceSelector,
      input: {
        idempotencyKey: `side-chat:${targetConversationId}`,
        source: {
          orgId,
          sourceConversationId,
          sourceRunId,
          sourceSpanId,
          sourceBoundaryRef,
          selectorJson: sourceSelector,
        },
        targetBinding,
        targetSegment,
        providerBinding: targetProviderBinding,
      },
    };
  }

  function child(fixtureValue: ForkFixture): RuntimeProviderForkResult {
    return {
      session: {
        sessionId: "child-session",
        sessionDisplayId: "child-session",
        sessionParams: {
          sessionId: "child-session",
          rootSessionId: "source-session",
          profileBindingId: fixtureValue.targetBindingId,
          profileOrgId: fixtureValue.orgId,
          hostId: providerIdentity.hostId,
          profileId: providerIdentity.profileId,
          workspaceBindingId: providerIdentity.workspaceBindingId,
          capabilityRevision: providerIdentity.capabilityRevision,
        },
      },
      boundary: "child-boundary",
      sourceBoundary: fixtureValue.sourceBoundaryRef,
      continuity: "native",
    };
  }

  async function admitTargetRun(fixtureValue: ForkFixture) {
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const admitted = await adapter.admit({
      orgId: fixtureValue.orgId,
      agentId: fixtureValue.agentId,
      scene: "chat",
      target: { type: "chat_conversation", id: fixtureValue.targetConversationId },
      idempotencyKey: `native-fork-target-run:${randomUUID()}`,
      runtimeType,
      runtimeBindingId: fixtureValue.input.targetBinding.id,
      runtimeSegmentId: fixtureValue.input.targetSegment.id,
      sessionIntent: { kind: "fresh" },
      attempt: { attemptIndex: 0, fallbackIndex: null, isFallback: false, resumeSource: "fresh" },
    });
    if (!admitted.created) throw new Error("expected target Run admission to create a Run");
    const runFence: NativeForkIntentRunFence = {
      runId: admitted.entry.runId,
      spanId: admitted.entry.span.id,
      ownerToken: admitted.entry.ownerFence.ownerToken,
      attemptEpoch: admitted.entry.ownerFence.attemptEpoch,
    };
    return { adapter, admitted, runFence };
  }

  function driverFor(result: RuntimeProviderForkResult | Error | "unsupported" | "unknown") {
    const fork = vi.fn(async () => {
      if (result instanceof Error) throw result;
      if (result === "unsupported") {
        return {
          status: "unsupported" as const,
          capability: "fork" as const,
          reason: "Provider does not support native fork",
        };
      }
      if (result === "unknown") {
        return {
          status: "unknown" as const,
          capability: "fork" as const,
          reason: "Provider fork acceptance is unknown",
        };
      }
      return { status: "supported" as const, value: result };
    });
    return { driver: { fork } as never, fork };
  }

  async function execute(
    fixtureValue: ForkFixture,
    result = child(fixtureValue),
    runFence?: NativeForkIntentRunFence,
  ) {
    const provider = driverFor(result);
    const outcome = await executeNativeForkIntent({
      db,
      intent: { ...fixtureValue.input, ...(runFence ? { runFence } : {}) },
      driver: provider.driver,
      sourceSession: fixtureValue.sourceSession,
      boundary: fixtureValue.sourceBoundaryRef,
      providerBinding: fixtureValue.input.providerBinding!,
    });
    return { outcome, fork: provider.fork };
  }

  async function retainDeletedSource(value: ForkFixture) {
    const messageId = randomUUID();
    await db.insert(chatMessages).values({ id: messageId, orgId: value.orgId,
      conversationId: value.targetConversationId, role: "assistant", body: "Copied source reply" });
    const [alias] = await db.insert(runtimeSourceAliases).values({ orgId: value.orgId,
      conversationId: value.targetConversationId, runId: value.sourceRunId,
      bindingId: value.sourceBindingId, segmentId: value.sourceSegmentId,
      sourceKind: "chat_fork_native_span", sourceRef: `native-span:${value.input.source.sourceSpanId}:message:${messageId}`,
      principalScopeRef: `org:${value.orgId}`, contentSha256: nativeForkContentHash([]),
      sourceRangeJson: { targetCopiedMessageId: messageId, sourceMessageId: randomUUID(),
        sourceConversationId: value.sourceConversationId, sourceRunId: value.sourceRunId,
        sourceSpanId: value.input.source.sourceSpanId, selectorJson: value.sourceSelector,
        selectorSha256: nativeForkContentHash(value.sourceSelector), forkBoundary: true },
    }).returning();
    await db.update(runtimeBindings).set({ status: "closed", targetType: "manual", conversationId: null,
      targetId: `retained-native-source:${value.sourceConversationId}:${value.sourceBindingId}`,
    }).where(eq(runtimeBindings.id, value.sourceBindingId));
    await db.delete(chatConversations).where(eq(chatConversations.id, value.sourceConversationId));
    return alias;
  }

  it("admits the exact target-owned retained alias after deleting the source before first send", async () => {
    const value = await fixture();
    await retainDeletedSource(value);
    expect(await reserveNativeForkIntent(db, value.input)).toMatchObject({ status: "reserved", shouldFork: true });
  });

  it.each(["missing", "principal", "selector", "released", "target"] as const)(
    "rejects a deleted source with %s alias proof without reserving an intent", async (fault) => {
      const value = await fixture();
      const alias = await retainDeletedSource(value);
      if (fault === "missing") await db.delete(runtimeSourceAliases).where(eq(runtimeSourceAliases.id, alias.id));
      else await db.update(runtimeSourceAliases).set(fault === "principal" ? { principalScopeRef: "org:spoof" }
        : fault === "selector" ? { sourceRangeJson: { ...alias.sourceRangeJson, selectorSha256: "wrong" } }
          : fault === "released" ? { releasedAt: new Date() }
            : { conversationId: null }).where(eq(runtimeSourceAliases.id, alias.id));
      await expect(reserveNativeForkIntent(db, value.input)).rejects.toMatchObject({ code: "source_invalid" });
      const [segment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, value.input.targetSegment.id));
      expect(readNativeForkIntent(segment.providerStateJson)).toBeNull();
    },
  );

  it("reserves once, persists the child before admission, and reuses it without a second provider fork", async () => {
    const fixtureValue = await fixture();
    const first = await execute(fixtureValue);
    expect(first.outcome).toMatchObject({ status: "accepted", shouldFork: false });
    expect(first.fork).toHaveBeenCalledTimes(1);
    expect(first.fork).toHaveBeenCalledWith(expect.objectContaining({
      boundary: fixtureValue.sourceBoundaryRef,
      selector: fixtureValue.sourceSelector,
    }));

    const second = await execute(fixtureValue);
    expect(second.outcome).toMatchObject({ status: "accepted", child: {
      session: { sessionId: "child-session" },
    } });
    expect(second.fork).not.toHaveBeenCalled();

    const [segment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, fixtureValue.input.targetSegment.id));
    expect(segment).toMatchObject({
      nativeSessionId: "child-session",
      rootSessionId: "source-session",
      state: "open",
      sourceBoundaryRef: fixtureValue.sourceBoundaryRef,
    });
    expect(segment?.providerStateJson).toMatchObject({
      sessionId: "child-session",
      profileBindingId: fixtureValue.targetBindingId,
      [nativeForkIntentKey()]: { status: "accepted" },
    });
  });

  it("atomically binds the accepted child to the fenced span and allows result CAS to finish that span", async () => {
    const fixtureValue = await fixture();
    const { admitted, runFence } = await admitTargetRun(fixtureValue);
    const first = await execute(fixtureValue, child(fixtureValue), runFence);
    expect(first.outcome).toMatchObject({ status: "accepted" });

    const [acceptedSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, runFence.spanId));
    expect(acceptedSpan).toMatchObject({
      id: runFence.spanId,
      runId: runFence.runId,
      bindingId: fixtureValue.targetBindingId,
      segmentId: fixtureValue.input.targetSegment.id,
      ownerToken: runFence.ownerToken,
      attemptEpoch: runFence.attemptEpoch,
      state: "open",
      nativeExecutionRef: "child-boundary",
    });

    const service = chatAgentRunService(db);
    const recorded = await service.recordNativeExecutionResult(admitted.entry.runId, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "child-session",
      sessionDisplayId: "child-session",
      sessionParams: child(fixtureValue).session.sessionParams,
      resultJson: { turnId: "child-run-turn" },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    }, {
      orgId: fixtureValue.orgId,
      spanId: runFence.spanId,
      ownerToken: runFence.ownerToken,
      attemptEpoch: runFence.attemptEpoch,
    });

    expect(recorded).toMatchObject({
      id: runFence.spanId,
      state: "sealed",
      completeness: "complete",
    });
    const [finishedSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, runFence.spanId));
    expect(finishedSpan?.nativeExecutionRef).toBe("child-run-turn");
    const [segment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, fixtureValue.input.targetSegment.id));
    expect(segment?.providerStateJson).toMatchObject({
      sessionId: "child-session",
      [nativeForkIntentKey()]: { status: "accepted", runFence },
    });
  });

  it("serializes duplicate reservations and fails closed after a reservation-only crash", async () => {
    const fixtureValue = await fixture();
    const reservations = await Promise.all([
      reserveNativeForkIntent(db, fixtureValue.input),
      reserveNativeForkIntent(db, fixtureValue.input),
    ]);
    expect(reservations.map((value) => value.status).sort()).toEqual(["reserved", "unknown"]);
    expect(reservations.filter((value) => value.status === "reserved")).toHaveLength(1);

    const retry = await execute(fixtureValue);
    expect(retry.outcome).toMatchObject({ status: "unknown", retryAllowed: false });
    expect(retry.fork).not.toHaveBeenCalled();
  });

  it("blocks stale owners after recovery and reconciles a crashed reservation under the new owner", async () => {
    const fixtureValue = await fixture();
    const { adapter, admitted, runFence: staleFence } = await admitTargetRun(fixtureValue);
    const reserved = await reserveNativeForkIntent(db, { ...fixtureValue.input, runFence: staleFence });
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") throw new Error("expected a Run-fenced reservation");

    await db.update(heartbeatRuns)
      .set({ executionLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, staleFence.runId));
    const claimed = await adapter.claimOwner(staleFence.runId, { ownerToken: `recovered-${randomUUID()}` });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error(`expected owner recovery, got ${claimed.reason}`);
    const currentFence: NativeForkIntentRunFence = {
      runId: staleFence.runId,
      spanId: claimed.value.id,
      ownerToken: claimed.value.ownerToken,
      attemptEpoch: claimed.value.attemptEpoch,
    };

    await expect(markNativeForkIntentUnknown(db, {
      reference: reserved.reference,
      reason: "late stale owner update",
      runFence: staleFence,
    })).rejects.toMatchObject({ code: "run_fence_stale" });
    await expect(markNativeForkIntentRejected(db, {
      reference: reserved.reference,
      reason: "late stale rejection",
      runFence: staleFence,
    })).rejects.toMatchObject({ code: "run_fence_stale" });
    await expect(persistNativeForkChild(db, {
      reference: reserved.reference,
      child: child(fixtureValue),
      runFence: staleFence,
    })).rejects.toMatchObject({ code: "run_fence_stale" });

    const [unchanged] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, fixtureValue.input.targetSegment.id));
    expect(readNativeForkIntent(unchanged?.providerStateJson)).toMatchObject({ status: "reserved", runFence: staleFence });
    expect(unchanged).toMatchObject({ state: "pending", nativeSessionId: null });

    const retry = await execute(fixtureValue, child(fixtureValue), currentFence);
    expect(retry.outcome).toMatchObject({ status: "unknown", retryAllowed: false, intent: { runFence: currentFence } });
    expect(retry.fork).not.toHaveBeenCalled();
    await expect(reconcileNativeForkIntentById(db, {
      orgId: fixtureValue.orgId,
      intentId: reserved.intent.intentId,
      child: child(fixtureValue),
    })).rejects.toMatchObject({ code: "run_fence_stale" });

    const reconciled = await reconcileNativeForkIntentById(db, {
      orgId: fixtureValue.orgId,
      intentId: reserved.intent.intentId,
      child: child(fixtureValue),
      runFence: currentFence,
    });
    expect(reconciled.outcome).toMatchObject({ status: "accepted", intent: { runFence: currentFence } });
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, currentFence.spanId));
    expect(span?.nativeExecutionRef).toBe("child-boundary");
  });

  it("allows only explicit provider reconciliation to finish an unknown intent", async () => {
    const fixtureValue = await fixture();
    const reserved = await reserveNativeForkIntent(db, fixtureValue.input);
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") throw new Error("expected a reservation");

    await expect(markNativeForkIntentUnknown(db, {
      reference: reserved.reference,
      reason: "provider accepted but process lost the response",
    })).resolves.toMatchObject({ status: "unknown", retryAllowed: false });

    const reconciled = await reconcileNativeForkIntent(db, {
      reference: reserved.reference,
      child: child(fixtureValue),
      note: "operator/provider lookup returned child-session",
    });
    expect(reconciled).toMatchObject({ status: "accepted", intent: {
      reconciliation: "resolved",
    } });

    const retry = await execute(fixtureValue);
    expect(retry.outcome.status).toBe("accepted");
    expect(retry.fork).not.toHaveBeenCalled();
  });

  it("turns provider exceptions into an unknown intent and never retries automatically", async () => {
    const fixtureValue = await fixture();
    const { runFence } = await admitTargetRun(fixtureValue);
    const provider = driverFor(new Error("provider response lost after fork acceptance"));
    await expect(executeNativeForkIntent({
      db,
      intent: { ...fixtureValue.input, runFence },
      driver: provider.driver,
      sourceSession: fixtureValue.sourceSession,
      boundary: fixtureValue.sourceBoundaryRef,
      providerBinding: fixtureValue.input.providerBinding!,
    })).rejects.toBeInstanceOf(NativeForkAcceptanceUnknownError);
    expect(provider.fork).toHaveBeenCalledTimes(1);

    const retry = await execute(fixtureValue, child(fixtureValue), runFence);
    expect(retry.outcome.status).toBe("unknown");
    expect(retry.fork).not.toHaveBeenCalled();
    const [segment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, fixtureValue.input.targetSegment.id));
    expect(segment?.providerStateJson).toMatchObject({
      [nativeForkIntentKey()]: { status: "unknown", runFence, reconciliation: "provider_lookup_required" },
    });
  });

  it("rolls back child persistence when the exact span write fails, then records only unknown", async () => {
    const fixtureValue = await fixture();
    const { runFence } = await admitTargetRun(fixtureValue);
    const provider = driverFor(child(fixtureValue));
    await expect(executeNativeForkIntent({
      db: injectRunSpanUpdateFailure(db),
      intent: { ...fixtureValue.input, runFence },
      driver: provider.driver,
      sourceSession: fixtureValue.sourceSession,
      boundary: fixtureValue.sourceBoundaryRef,
      providerBinding: fixtureValue.input.providerBinding!,
    })).rejects.toBeInstanceOf(NativeForkAcceptanceUnknownError);
    expect(provider.fork).toHaveBeenCalledTimes(1);

    const [segment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, fixtureValue.input.targetSegment.id));
    expect(segment).toMatchObject({ state: "pending", nativeSessionId: null });
    expect(readNativeForkIntent(segment?.providerStateJson)).toMatchObject({
      status: "unknown",
      runFence,
      child: undefined,
      reconciliation: "provider_lookup_required",
    });
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, runFence.spanId));
    expect(span).toMatchObject({ state: "open", ownerToken: runFence.ownerToken, nativeExecutionRef: null });
  });

  it("rejects a source boundary that only matches the mutable segment head", async () => {
    const fixtureValue = await fixture();
    await expect(reserveNativeForkIntent(db, {
      ...fixtureValue.input,
      source: { ...fixtureValue.input.source, sourceBoundaryRef: "source-head" },
    })).rejects.toMatchObject({ code: "source_invalid" });
  });

  it("uses the exact sealed span among multiple spans from the same Run", async () => {
    const fixtureValue = await fixture();
    const secondSpanId = randomUUID();
    const secondBoundaryRef = "source-execution-2";
    const secondSelector = {
      kind: "codex_turn",
      threadId: "source-session",
      turnId: secondBoundaryRef,
      inputCorrelationRef: "source-attempt-2",
    };
    const secondTimestamp = new Date("2026-09-23T00:02:00.000Z");
    await db.insert(runRuntimeSpans).values({
      id: secondSpanId,
      orgId: fixtureValue.orgId,
      runId: fixtureValue.sourceRunId,
      bindingId: fixtureValue.sourceBindingId,
      segmentId: fixtureValue.sourceSegmentId,
      attemptRef: "source-attempt-2",
      attemptEpoch: 2,
      ownerToken: "source-owner-2",
      ordinal: 1,
      relation: "continuation",
      nativeExecutionRef: secondBoundaryRef,
      selectorJson: secondSelector,
      state: "sealed",
      completeness: "complete",
      openedAt: secondTimestamp,
      closedAt: secondTimestamp,
      writerLeaseReleasedAt: secondTimestamp,
      updatedAt: secondTimestamp,
    });

    const second = await execute({
      ...fixtureValue,
      input: {
        ...fixtureValue.input,
        idempotencyKey: `side-chat:${randomUUID()}`,
        source: {
          ...fixtureValue.input.source,
          sourceSpanId: secondSpanId,
          sourceBoundaryRef: secondBoundaryRef,
          selectorJson: secondSelector,
        },
      },
      sourceBoundaryRef: secondBoundaryRef,
      sourceSelector: secondSelector,
    });
    expect(second.outcome).toMatchObject({ status: "accepted" });
    expect(second.fork).toHaveBeenCalledWith(expect.objectContaining({
      boundary: secondBoundaryRef,
      selector: secondSelector,
    }));
  });

  it("rejects a source span paired with a different completed Run", async () => {
    const fixtureValue = await fixture();
    const otherRunId = randomUUID();
    const startedAt = new Date("2026-09-23T00:03:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      orgId: fixtureValue.orgId,
      agentId: fixtureValue.agentId,
      invocationSource: "chat",
      status: "succeeded",
      chatConversationId: fixtureValue.sourceConversationId,
      sessionReuseScope: "explicit",
      startedAt,
      finishedAt: startedAt,
    });

    await expect(reserveNativeForkIntent(db, {
      ...fixtureValue.input,
      idempotencyKey: `side-chat:${randomUUID()}`,
      source: {
        ...fixtureValue.input.source,
        sourceRunId: otherRunId,
      },
    })).rejects.toMatchObject({ code: "source_invalid" });
  });

  it("fails closed for provider unsupported and unknown fork outcomes", async () => {
    const unsupportedFixture = await fixture();
    const { runFence: unsupportedFence } = await admitTargetRun(unsupportedFixture);
    const unsupported = driverFor("unsupported");
    await expect(executeNativeForkIntent({
      db,
      intent: { ...unsupportedFixture.input, runFence: unsupportedFence },
      driver: unsupported.driver,
      sourceSession: unsupportedFixture.sourceSession,
      boundary: unsupportedFixture.sourceBoundaryRef,
      providerBinding: unsupportedFixture.input.providerBinding!,
    })).rejects.toMatchObject({ code: "provider_rejected" });
    expect(unsupported.fork).toHaveBeenCalledWith(expect.objectContaining({
      selector: unsupportedFixture.sourceSelector,
    }));
    const [rejectedSegment] = await db.select().from(nativeSegments)
      .where(eq(nativeSegments.id, unsupportedFixture.input.targetSegment.id));
    expect(readNativeForkIntent(rejectedSegment?.providerStateJson)).toMatchObject({
      status: "rejected",
      runFence: unsupportedFence,
    });

    const unknownFixture = await fixture();
    const { runFence: unknownFence } = await admitTargetRun(unknownFixture);
    const unknown = driverFor("unknown");
    await expect(executeNativeForkIntent({
      db,
      intent: { ...unknownFixture.input, runFence: unknownFence },
      driver: unknown.driver,
      sourceSession: unknownFixture.sourceSession,
      boundary: unknownFixture.sourceBoundaryRef,
      providerBinding: unknownFixture.input.providerBinding!,
    })).rejects.toBeInstanceOf(NativeForkAcceptanceUnknownError);
    expect(unknown.fork).toHaveBeenCalledWith(expect.objectContaining({
      selector: unknownFixture.sourceSelector,
    }));
    const retry = await execute(unknownFixture, child(unknownFixture), unknownFence);
    expect(retry.outcome.status).toBe("unknown");
    expect(retry.fork).not.toHaveBeenCalled();
  });

  it("uses segment fallback boundaries only when the span has no execution reference", async () => {
    const fixtureValue = await fixture({ spanBoundary: null });
    const input = {
      ...fixtureValue.input,
      source: { ...fixtureValue.input.source, sourceBoundaryRef: "source-head" },
    };
    await expect(reserveNativeForkIntent(db, input)).resolves.toMatchObject({ status: "reserved" });
  });

  it("rejects target profile drift and cross-organization source input before any fork", async () => {
    const fixtureValue = await fixture();
    await expect(reserveNativeForkIntent(db, {
      ...fixtureValue.input,
      providerBinding: {
        ...fixtureValue.input.providerBinding!,
        profileId: "different-profile",
      },
    })).rejects.toMatchObject({ code: "target_invalid" });
    await expect(reserveNativeForkIntent(db, {
      ...fixtureValue.input,
      source: { ...fixtureValue.input.source, orgId: randomUUID() },
    })).rejects.toMatchObject({ code: "source_invalid" });
  });

  it("preserves only the host-owned intent when a finish snapshot replaces provider state", () => {
    const intent = { intentId: "intent-1", status: "accepted" };
    expect(preserveNativeForkIntentProviderState(
      { [nativeForkIntentKey()]: intent, staleProviderField: "discard" },
      { sessionId: "child-session", profileBindingId: "target-binding" },
    )).toEqual({
      sessionId: "child-session",
      profileBindingId: "target-binding",
      [nativeForkIntentKey()]: intent,
    });
    expect(preserveNativeForkIntentProviderState(
      { [nativeForkIntentKey()]: intent },
      null,
    )).toEqual({ [nativeForkIntentKey()]: intent });
    expect(preserveNativeForkIntentProviderState({ stale: true }, { sessionId: "session" }))
      .toEqual({ sessionId: "session" });
  });

  it("continues reading and reusing historical v1 intents without selector or Run fence fields", async () => {
    const fixtureValue = await fixture();
    const reserved = await reserveNativeForkIntent(db, fixtureValue.input);
    if (reserved.status !== "reserved") throw new Error("expected a reservation");
    await persistNativeForkChild(db, { reference: reserved.reference, child: child(fixtureValue) });

    const [segment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, fixtureValue.input.targetSegment.id));
    const state = segment?.providerStateJson as Record<string, unknown>;
    const stored = state[nativeForkIntentKey()] as Record<string, unknown>;
    const legacySource = { ...(stored.source as Record<string, unknown>) };
    delete legacySource.selectorJson;
    const legacyIntent: Record<string, unknown> = { ...stored, source: legacySource };
    delete legacyIntent.runFence;
    await db.update(nativeSegments).set({
      providerStateJson: { ...state, [nativeForkIntentKey()]: legacyIntent },
    }).where(eq(nativeSegments.id, fixtureValue.input.targetSegment.id));

    const parsedLegacyIntent = readNativeForkIntent({ ...state, [nativeForkIntentKey()]: legacyIntent });
    expect(parsedLegacyIntent).toMatchObject({
      status: "accepted",
      source: {
        sourceRunId: fixtureValue.input.source.sourceRunId,
        sourceSpanId: fixtureValue.input.source.sourceSpanId,
      },
    });
    expect(parsedLegacyIntent?.runFence).toBeUndefined();
    const replay = await execute(fixtureValue);
    expect(replay.outcome).toMatchObject({ status: "accepted", child: { session: { sessionId: "child-session" } } });
    expect(replay.fork).not.toHaveBeenCalled();
  });

  it("does not replace a previously persisted child with a different child", async () => {
    const fixtureValue = await fixture();
    const reserved = await reserveNativeForkIntent(db, fixtureValue.input);
    if (reserved.status !== "reserved") throw new Error("expected a reservation");
    await persistNativeForkChild(db, { reference: reserved.reference, child: child(fixtureValue) });
    await expect(persistNativeForkChild(db, {
      reference: reserved.reference,
      child: {
        ...child(fixtureValue),
        session: {
          ...child(fixtureValue).session,
          sessionId: "different-child",
          sessionDisplayId: "different-child",
          sessionParams: { sessionId: "different-child" },
        },
      },
    })).rejects.toMatchObject({ code: "intent_conflict" });
  });
});
