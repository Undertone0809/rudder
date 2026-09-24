import type { Db, RuntimeBindingTargetType } from "@rudderhq/db";
import {
  agents,
  heartbeatRunAttempts,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import {
  beginHeartbeatRunAttempt,
  type HeartbeatAttemptOwnerFence,
  type HeartbeatAttemptRef,
} from "./heartbeat-attempt-ledger.js";
import { claimExpiredHeartbeatRunExecution } from "./heartbeat.terminal.js";
import type { RuntimeBindingInput } from "./native-session.js";
import {
  bindRunRuntimeSpanAttempt,
  currentNativeSession,
  ensureRuntimeBinding,
  startRunRuntimeSpanInTransaction,
} from "./native-session.js";
import type { RuntimeDriverFactoryOptions } from "./runtime-driver.js";
import { getRuntimeDriver } from "./runtime-driver.js";
import type { UnifiedAgentRunAdapter } from "./unified-agent-run.contracts.js";
import { readSubmission } from "./unified-agent-run.persistence-support.js";

/** Bind the Driver to heartbeat's existing durable owners; it does not schedule work. */
export function createHeartbeatRuntimeDriver(
  input: {
    db: Db;
    unifiedRunAdapter: UnifiedAgentRunAdapter | null | undefined;
  },
  runtimeType: string,
  options: RuntimeDriverFactoryOptions = {},
) {
  const { db, unifiedRunAdapter } = input;
  return getRuntimeDriver(runtimeType, {
    ...options,
    sessionBindingOwner: {
      ensureBinding: (intent: RuntimeBindingInput) => ensureRuntimeBinding(db, intent),
      currentSession: (binding) => currentNativeSession(db, binding),
    },
    unifiedRunReader: unifiedRunAdapter
      ? { get: async (runId) => unifiedRunAdapter.get(runId) }
      : null,
    unifiedRunReconciler: unifiedRunAdapter
      ? {
          reconcileAcceptance: async (runId, fence, outcome) =>
            unifiedRunAdapter.reconcileAcceptance(runId, fence, outcome),
        }
      : null,
  });
}

class HeartbeatCommonRunBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeartbeatCommonRunBoundaryError";
  }
}

const UNIFIED_ADMISSION_CONTEXT_KEY = "unifiedAgentRun";

function nonEmptyAdmissionString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function admissionObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function admissionSessionIntent(input: {
  sessionReuseScope?: string | null;
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  sourceRunId?: string | null;
}) {
  const reuseScope = input.sessionReuseScope === "task" ? "task"
    : input.sessionReuseScope === "explicit" ? "explicit"
      : "none";
  const sourceRunId = nonEmptyAdmissionString(input.sourceRunId);
  const sessionId = nonEmptyAdmissionString(input.sessionId);
  const sessionParams = admissionObject(input.sessionParams);
  const isFresh = reuseScope === "none" && !sourceRunId && !sessionId && !sessionParams;
  return isFresh
    ? {
        kind: "fresh" as const,
        reuseScope: "none" as const,
        sourceRunId: null,
        sessionId: null,
        sessionParams: null,
      }
    : {
        kind: "resume" as const,
        reuseScope: reuseScope === "task" ? "task" as const : "explicit" as const,
        sourceRunId,
        sessionId,
        sessionParams,
      };
}

/**
 * Build the compatibility projection used by the common Agent Run boundary.
 * Queueing, issue locks, and budget checks remain owned by heartbeat; this
 * helper only makes every newly admitted row carry the same identity.
 */
export function buildHeartbeatRunAdmissionFields(input: {
  agent: { orgId: string; agentRuntimeType: string };
  scene?: "chat" | "side_chat" | "issue" | "review" | "automation" | "heartbeat" | "delegation" | null;
  targetType?: RuntimeBindingTargetType | null;
  source?: string | null;
  targetId?: string | null;
  requestId: string;
  idempotencyKey?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  sourceRunId?: string | null;
  sessionReuseScope?: string | null;
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  runtimeBindingId?: string | null;
  runtimeSegmentId?: string | null;
  ownerFence?: Partial<{
    ownerFenceId: string | null;
    lastOwnerToken: string | null;
    attemptEpoch: number | null;
    lastLeaseExpiresAt: string | null;
  }>;
}) {
  const source = nonEmptyAdmissionString(input.source) ?? "on_demand";
  const context = { ...(input.contextSnapshot ?? {}) };
  const payload = input.payload ?? null;
  const storedContextAdmission = admissionObject(context[UNIFIED_ADMISSION_CONTEXT_KEY]);
  const issueId = nonEmptyAdmissionString(context.issueId) ?? nonEmptyAdmissionString(payload?.issueId);
  const automationRunId = nonEmptyAdmissionString(context.automationRunId)
    ?? nonEmptyAdmissionString(payload?.automationRunId);
  const targetId = nonEmptyAdmissionString(input.targetId)
    ?? nonEmptyAdmissionString(storedContextAdmission?.targetId)
    ?? automationRunId
    ?? issueId
    ?? input.requestId;
  const derivedScene = source === "review"
    ? "review"
    : automationRunId
      ? "automation"
      : issueId
        ? "issue"
        : "heartbeat";
  const storedScene = storedContextAdmission?.scene;
  const contextScene = context.scene === "chat"
    || context.scene === "side_chat"
    || context.scene === "issue"
    || context.scene === "review"
    || context.scene === "automation"
    || context.scene === "heartbeat"
    || context.scene === "delegation"
    ? context.scene
    : context.rudderScene === "chat"
      || context.rudderScene === "side_chat"
      || context.rudderScene === "issue"
      || context.rudderScene === "review"
      || context.rudderScene === "automation"
      || context.rudderScene === "heartbeat"
      || context.rudderScene === "delegation"
        ? context.rudderScene
        : null;
  const scene = contextScene
    ?? input.scene
    ?? (storedScene === "chat" || storedScene === "side_chat" || storedScene === "issue"
      || storedScene === "review" || storedScene === "automation" || storedScene === "heartbeat"
      || storedScene === "delegation"
      ? storedScene
      : derivedScene);
  const targetType = input.targetType
    ?? (nonEmptyAdmissionString(storedContextAdmission?.targetType) as RuntimeBindingTargetType | null)
    ?? (scene === "review"
    ? "review"
    : scene === "automation"
      ? "automation_run"
      : scene === "issue"
        ? "issue"
        : scene === "chat" || scene === "side_chat"
          ? "chat_conversation"
          : "wakeup_request");
  const idempotencyKey = nonEmptyAdmissionString(input.idempotencyKey)
    ?? `heartbeat:${input.requestId}`;
  const sessionIntent = admissionSessionIntent({
    sessionReuseScope: input.sessionReuseScope,
    sessionId: input.sessionId,
    sessionParams: input.sessionParams,
    sourceRunId: input.sourceRunId,
  });
  const fingerprint = JSON.stringify({
    scene,
    target: { type: targetType, id: targetId },
    runtimeType: input.agent.agentRuntimeType,
    model: null,
    sessionIntent,
  });
  const unifiedAgentRun = {
    version: 1,
    scene,
    targetType,
    targetId,
    idempotencyKey,
    runtimeType: input.agent.agentRuntimeType,
    model: null,
    sessionIntent,
    runtimeBindingId: nonEmptyAdmissionString(input.runtimeBindingId),
    runtimeSegmentId: nonEmptyAdmissionString(input.runtimeSegmentId),
    fingerprint,
    ...input.ownerFence,
  };
  const nextContext = {
    ...context,
    scene,
    targetType,
    targetId,
    ...(nonEmptyAdmissionString(input.runtimeBindingId)
      ? { runtimeBindingId: input.runtimeBindingId }
      : {}),
    ...(nonEmptyAdmissionString(input.runtimeSegmentId)
      ? { runtimeSegmentId: input.runtimeSegmentId }
      : {}),
    [UNIFIED_ADMISSION_CONTEXT_KEY]: unifiedAgentRun,
  };
  return {
    scene,
    targetType,
    targetId,
    idempotencyKey,
    sessionIntentJson: sessionIntent,
    contextSnapshot: nextContext,
  };
}

export function createHeartbeatAdmissionHandlers(context: {
  db: Db;
  getRun: (runId: string) => Promise<any>;
  unifiedRunAdapter: any;
}) {
  const { db, getRun, unifiedRunAdapter } = context;
  function readCommonRunAdmission(run: typeof heartbeatRuns.$inferSelect) {
    const context = admissionObject(run.contextSnapshot);
    const stored = admissionObject(context?.[UNIFIED_ADMISSION_CONTEXT_KEY]);
    if (
      !nonEmptyAdmissionString(run.scene)
      || !nonEmptyAdmissionString(run.targetType)
      || !nonEmptyAdmissionString(run.targetId)
      || !nonEmptyAdmissionString(run.idempotencyKey)
      || !admissionObject(run.sessionIntentJson)
      || !stored
      || stored.version !== 1
    ) {
      return null;
    }
    return {
      scene: run.scene,
      targetType: run.targetType,
      targetId: run.targetId,
      idempotencyKey: run.idempotencyKey,
      runtimeType: nonEmptyAdmissionString(stored.runtimeType) ?? "",
      sessionIntent: admissionObject(run.sessionIntentJson) as Record<string, unknown>,
      stored,
    };
  }

  async function resolveHeartbeatNativeResources(
    database: Db,
    input: {
      run: typeof heartbeatRuns.$inferSelect;
      runtimeType: string;
    },
  ) {
    const admission = readCommonRunAdmission(input.run);
    if (!admission) return null;
    const context = admissionObject(input.run.contextSnapshot) ?? {};
    const intent = admission.sessionIntent;
    const sourceRunId = nonEmptyAdmissionString(input.run.sourceRunId)
      ?? nonEmptyAdmissionString(intent.sourceRunId)
      ?? nonEmptyAdmissionString(context.sourceRunId);
    const sourceSpan = sourceRunId
      ? await database
          .select()
          .from(runRuntimeSpans)
          .where(and(
            eq(runRuntimeSpans.orgId, input.run.orgId),
            eq(runRuntimeSpans.runId, sourceRunId),
          ))
          .orderBy(desc(runRuntimeSpans.ordinal))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    const bindingId = nonEmptyAdmissionString(context.nativeBindingId)
      ?? nonEmptyAdmissionString(context.runtimeBindingId)
      ?? sourceSpan?.bindingId
      ?? null;
    const segmentId = nonEmptyAdmissionString(context.nativeSegmentId)
      ?? nonEmptyAdmissionString(context.runtimeSegmentId)
      ?? sourceSpan?.segmentId
      ?? null;
    if (!bindingId || !segmentId) return null;

    const binding = await database
      .select()
      .from(runtimeBindings)
      .where(and(
        eq(runtimeBindings.id, bindingId),
        eq(runtimeBindings.orgId, input.run.orgId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const segment = await database
      .select()
      .from(nativeSegments)
      .where(and(
        eq(nativeSegments.id, segmentId),
        eq(nativeSegments.orgId, input.run.orgId),
        eq(nativeSegments.bindingId, bindingId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!binding || !segment) return null;
    if (
      binding.agentId !== input.run.agentId
      || binding.runtimeType !== input.runtimeType
      || binding.targetType !== input.run.targetType
      || binding.targetId !== input.run.targetId
      || segment.orgId !== input.run.orgId
      || segment.bindingId !== binding.id
      || segment.runtimeType !== input.runtimeType
      || segment.state === "sealed"
      || segment.state === "superseded"
    ) {
      throw new HeartbeatCommonRunBoundaryError(
        `native binding/segment identity is not safe for heartbeat run ${input.run.id}`,
      );
    }
    // A non-Chat row may only reuse a binding/segment that is already present
    // in a real source run or was explicitly supplied by a trusted server
    // context. No provider session or span is invented here.
    if (!sourceSpan && !nonEmptyAdmissionString(context.nativeBindingId) && !nonEmptyAdmissionString(context.runtimeBindingId)) {
      return null;
    }
    return {
      binding,
      segment,
      inputCorrelationRef: admission.idempotencyKey,
    };
  }

  /**
   * Materialize the native identity before a non-Chat heartbeat row is
   * inserted. The existing heartbeat scheduler still owns queueing and issue
   * locking; this only supplies the common Run admission anchor.
   */
  async function ensureHeartbeatRunAdmission(database: any, input: {
    agent: typeof agents.$inferSelect;
    scene?: "chat" | "side_chat" | "issue" | "review" | "automation" | "heartbeat" | "delegation" | null;
    targetType?: RuntimeBindingTargetType | null;
    source?: string | null;
    requestId: string;
    targetId?: string | null;
    idempotencyKey?: string | null;
    contextSnapshot?: Record<string, unknown> | null;
    payload?: Record<string, unknown> | null;
    sourceRunId?: string | null;
    sessionReuseScope?: string | null;
    sessionId?: string | null;
    sessionParams?: Record<string, unknown> | null;
  }) {
    const initial = buildHeartbeatRunAdmissionFields(input);
    if (initial.scene === "chat" || initial.scene === "side_chat") return initial;

    const targetType = initial.targetType as RuntimeBindingTargetType;
    const bindingIntent: RuntimeBindingInput = {
      orgId: input.agent.orgId,
      agentId: input.agent.id,
      runtimeType: input.agent.agentRuntimeType,
      target: { type: targetType, id: initial.targetId },
      conversationId: null,
      continuity: input.sourceRunId ? "context_handoff" : "native",
      sourceBoundaryRef: input.sourceRunId ?? null,
    };
    const driver = createHeartbeatRuntimeDriver({ db: database, unifiedRunAdapter }, input.agent.agentRuntimeType);
    if (driver) {
      const ensured = await driver.ensureSession(bindingIntent);
      if (ensured.status !== "supported") {
        throw new HeartbeatCommonRunBoundaryError(
          `heartbeat admission Runtime Driver could not ensure its binding/segment: ${ensured.status} (${ensured.reason})`,
        );
      }
      return buildHeartbeatRunAdmissionFields({
        ...input,
        runtimeBindingId: ensured.value.binding.id,
        runtimeSegmentId: ensured.value.segmentId,
      });
    }

    const binding = await ensureRuntimeBinding(database, bindingIntent);
    const nativeSession = await currentNativeSession(database, binding);
    return buildHeartbeatRunAdmissionFields({
      ...input,
      runtimeBindingId: binding.id,
      runtimeSegmentId: nativeSession.segment.id,
    });
  }

  async function currentCommonRunFence(runId: string): Promise<HeartbeatAttemptOwnerFence | null> {
    const run = await getRun(runId);
    if (!run || !readCommonRunAdmission(run)) return null;
    const attempt = await db
      .select({
        ownerToken: heartbeatRunAttempts.ownerToken,
        attemptEpoch: heartbeatRunAttempts.attemptEpoch,
      })
      .from(heartbeatRunAttempts)
      .where(and(
        eq(heartbeatRunAttempts.orgId, run.orgId),
        eq(heartbeatRunAttempts.runId, run.id),
      ))
      .orderBy(desc(heartbeatRunAttempts.attemptIndex))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!attempt?.ownerToken || !attempt.attemptEpoch) return null;
    return { ownerToken: attempt.ownerToken, attemptEpoch: attempt.attemptEpoch };
  }

  async function ensureCommonRunExecutionBoundary(
    database: Db,
    run: typeof heartbeatRuns.$inferSelect,
    ownerToken: string,
    attemptEpoch = 1,
    options: {
      attemptIndex?: number;
      fallbackIndex?: number | null;
      runtimeType?: string | null;
      model?: string | null;
      isFallback?: boolean;
      resumeSource?: "fresh" | "same_session" | "pristine_replay";
    } = {},
  ): Promise<{ attemptRef: HeartbeatAttemptRef; spanId: string; ownerToken: string; attemptEpoch: number } | null> {
    if (!readCommonRunAdmission(run) || run.scene === "chat" || run.scene === "side_chat") return null;
    return database.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${run.id}))`);
      const current = await tx.select().from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.orgId, run.orgId)))
        .then((rows) => rows[0] ?? null);
      if (
        !current || current.status !== "running" || current.executionOwnerToken !== ownerToken
        || !current.executionLeaseExpiresAt || current.executionLeaseExpiresAt <= new Date()
      ) {
        throw new HeartbeatCommonRunBoundaryError(`heartbeat run ${run.id} execution owner or lease is stale`);
      }
      return materializeCommonRunExecutionBoundary(tx, current, ownerToken, attemptEpoch, options);
    });
  }

  async function materializeCommonRunExecutionBoundary(
    database: Db,
    run: typeof heartbeatRuns.$inferSelect,
    ownerToken: string,
    attemptEpoch: number,
    options: {
      attemptIndex?: number;
      fallbackIndex?: number | null;
      runtimeType?: string | null;
      model?: string | null;
      isFallback?: boolean;
      resumeSource?: "fresh" | "same_session" | "pristine_replay";
    },
  ): Promise<{ attemptRef: HeartbeatAttemptRef; spanId: string; ownerToken: string; attemptEpoch: number } | null> {
    const admission = readCommonRunAdmission(run);
    if (!admission || admission.scene === "chat" || admission.scene === "side_chat") return null;
    if (!ownerToken) throw new HeartbeatCommonRunBoundaryError(`heartbeat run ${run.id} has no execution owner token`);

    const existingAttempt = await database
      .select()
      .from(heartbeatRunAttempts)
      .where(and(
        eq(heartbeatRunAttempts.orgId, run.orgId),
        eq(heartbeatRunAttempts.runId, run.id),
      ))
      .orderBy(desc(heartbeatRunAttempts.attemptIndex))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const attemptIndex = options.attemptIndex ?? existingAttempt?.attemptIndex ?? 0;
    if (attemptEpoch > 1 && (!existingAttempt || attemptIndex !== existingAttempt.attemptIndex)) {
      throw new HeartbeatCommonRunBoundaryError(`heartbeat run ${run.id} recovered attempt requires explicit submission reconciliation`);
    }
    const savedSubmission = existingAttempt && attemptIndex === existingAttempt.attemptIndex
      && admissionObject(existingAttempt.checkpointJson)?.unifiedSubmission
      ? readSubmission(existingAttempt)
      : null;
    if (existingAttempt && attemptIndex === existingAttempt.attemptIndex && attemptEpoch > 1 && !savedSubmission) {
      throw new HeartbeatCommonRunBoundaryError(`heartbeat run ${run.id} recovered attempt has no durable submission state`);
    }
    if (savedSubmission && (
      savedSubmission.state === "acceptance_unknown" || savedSubmission.state === "accepted"
      || savedSubmission.retry !== "allowed" || (attemptEpoch > 1 && savedSubmission.state !== "rejected")
    )) {
      throw new HeartbeatCommonRunBoundaryError(`heartbeat run ${run.id} provider submission must be reconciled before execution`);
    }
    const attemptRef = await beginHeartbeatRunAttempt(database, {
      orgId: run.orgId,
      runId: run.id,
      agentId: run.agentId,
      attemptIndex,
      fallbackIndex: options.fallbackIndex ?? (attemptIndex === existingAttempt?.attemptIndex ? existingAttempt?.fallbackIndex : null) ?? null,
      runtimeType: options.runtimeType ?? admission.runtimeType,
      model: options.model ?? (attemptIndex === existingAttempt?.attemptIndex ? existingAttempt?.model : null) ?? null,
      isFallback: options.isFallback ?? (attemptIndex === existingAttempt?.attemptIndex ? existingAttempt?.isFallback : false) ?? false,
      resumeSource: options.resumeSource ?? (attemptIndex === existingAttempt?.attemptIndex ? existingAttempt?.resumeSource : "fresh") ?? "fresh",
      ownerToken,
      attemptEpoch,
    });
    if (!attemptRef) {
      throw new HeartbeatCommonRunBoundaryError(
        `heartbeat run ${run.id} attempt ${attemptIndex} owner fence is stale`,
      );
    }
    const attempt = await database
      .select()
      .from(heartbeatRunAttempts)
      .where(and(
        eq(heartbeatRunAttempts.id, attemptRef.id),
        eq(heartbeatRunAttempts.orgId, run.orgId),
        eq(heartbeatRunAttempts.runId, run.id),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!attempt) throw new HeartbeatCommonRunBoundaryError(`heartbeat run ${run.id} attempt readback failed`);

    let span = await database
      .select()
      .from(runRuntimeSpans)
      .where(and(
        eq(runRuntimeSpans.orgId, run.orgId),
        eq(runRuntimeSpans.runId, run.id),
        eq(runRuntimeSpans.state, "open"),
      ))
      .orderBy(desc(runRuntimeSpans.ordinal))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (span) {
      if (span.ownerToken !== ownerToken || span.attemptEpoch !== attemptEpoch) {
        throw new HeartbeatCommonRunBoundaryError(`heartbeat run ${run.id} native span owner fence is stale`);
      }
      if (span.attemptId !== attempt.id) {
        const rebound = await bindRunRuntimeSpanAttempt(database, {
          orgId: run.orgId,
          runId: run.id,
          spanId: span.id,
          ownerToken,
          runtimeType: admission.runtimeType,
          attemptEpoch,
          attemptId: attempt.id,
        });
        if (!rebound) throw new HeartbeatCommonRunBoundaryError(`heartbeat run ${run.id} native span attempt bind failed`);
        span = rebound;
      }
    } else {
      const native = await resolveHeartbeatNativeResources(database, {
        run,
      runtimeType: admission.runtimeType,
      });
      if (!native) {
        throw new HeartbeatCommonRunBoundaryError(
          `no durable native binding/segment is available for ${admission.scene}/${admission.targetType}; heartbeat admission is fail-closed`,
        );
      }
      span = await startRunRuntimeSpanInTransaction(database, {
        orgId: run.orgId,
        runId: run.id,
        binding: native.binding,
        segment: native.segment,
          runtimeType: options.runtimeType ?? admission.runtimeType,
        attemptRef: `${admission.idempotencyKey}:attempt:${attempt.attemptIndex}`,
        attemptId: attempt.id,
        attemptEpoch,
        ownerToken,
        inputCorrelationRef: native.inputCorrelationRef,
      });
    }

    const existingCheckpoint = admissionObject(attempt.checkpointJson) ?? {};
    const submissionKey = `${admission.idempotencyKey}:attempt:${attempt.attemptIndex}`;
    if (!savedSubmission) {
      const [initialized] = await database
        .update(heartbeatRunAttempts)
        .set({
          checkpointJson: {
            ...existingCheckpoint,
            unifiedSubmission: {
              key: submissionKey,
              state: "pending",
              phase: "pre_submission",
              retry: "allowed",
              providerThreadId: null,
              providerTurnId: null,
              reason: null,
            },
          },
          submissionPhase: "pre_submission",
        })
        .where(and(
          eq(heartbeatRunAttempts.id, attempt.id),
          eq(heartbeatRunAttempts.orgId, run.orgId),
          eq(heartbeatRunAttempts.runId, run.id),
          eq(heartbeatRunAttempts.ownerToken, ownerToken),
          eq(heartbeatRunAttempts.attemptEpoch, attemptEpoch),
        ))
        .returning({ id: heartbeatRunAttempts.id });
      if (!initialized) throw new HeartbeatCommonRunBoundaryError(`heartbeat run ${run.id} submission initialization lost its owner fence`);
    }

    const nextContext = {
      ...(admissionObject(run.contextSnapshot) ?? {}),
      [UNIFIED_ADMISSION_CONTEXT_KEY]: {
        ...admission.stored,
        ownerFenceId: span.id,
        lastOwnerToken: ownerToken,
        attemptEpoch,
        lastLeaseExpiresAt: run.executionLeaseExpiresAt?.toISOString() ?? null,
      },
    };
    const [updatedRun] = await database
      .update(heartbeatRuns)
      .set({ contextSnapshot: nextContext, updatedAt: new Date() })
      .where(and(
        eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.orgId, run.orgId),
        eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.executionOwnerToken, ownerToken),
        gt(heartbeatRuns.executionLeaseExpiresAt, new Date()),
      ))
      .returning({ id: heartbeatRuns.id });
    if (!updatedRun) throw new HeartbeatCommonRunBoundaryError(`heartbeat run ${run.id} lost its execution lease during boundary rebuild`);
    return {
      attemptRef: {
        id: attempt.id,
        attemptIndex: attempt.attemptIndex,
        ownerToken,
        attemptEpoch,
      },
      spanId: span.id,
      ownerToken,
      attemptEpoch,
    };
  }

  async function claimRunForRecovery(
    run: typeof heartbeatRuns.$inferSelect,
    options: { now: Date; recoveryCutoff?: Date },
  ) {
    if (!readCommonRunAdmission(run)) {
      return claimExpiredHeartbeatRunExecution(db, run.id, options);
    }
    const claimed = await unifiedRunAdapter.claimOwner(run.id, {
      observedAt: options.now,
      recoveryCutoff: options.recoveryCutoff,
    });
    if (!claimed.ok) return null;
    const refreshed = await getRun(run.id);
    if (!refreshed) {
      throw new HeartbeatCommonRunBoundaryError(`heartbeat run ${run.id} disappeared after atomic recovery claim`);
    }
    return {
      run: refreshed,
      ownerToken: claimed.value.ownerToken,
      attemptEpoch: claimed.value.attemptEpoch,
    };
  }

  return {
    readCommonRunAdmission,
    resolveHeartbeatNativeResources,
    ensureHeartbeatRunAdmission,
    currentCommonRunFence,
    ensureCommonRunExecutionBoundary,
    claimRunForRecovery,
  };
}
