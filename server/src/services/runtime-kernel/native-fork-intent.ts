import type { Db } from "@rudderhq/db";
import {
  heartbeatRunAttempts,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { hasRetainedNativeForkSource } from "./native-fork-retained-source.js";
import type { NativeSegmentRecord, RuntimeBindingRecord } from "./native-session.js";
import type {
  NativeSpanSelector,
  RuntimeProviderBindingRef,
  RuntimeProviderSessionRef,
} from "./provider-capabilities.js";
import type { RuntimeDriver } from "./runtime-driver.js";
import { lockRuntimeRetentionScope } from "./runtime-retention.js";

import {
  cloneChild,
  cloneRecord,
  intentFromProviderState,
  NATIVE_FORK_INTENT_KEY,
  NATIVE_FORK_INTENT_VERSION,
  NativeForkAcceptanceUnknownError,
  NativeForkIntentError,
  normalizeIdempotencyKey,
  normalizeNoChildProof,
  normalizeRunFence,
  normalizeSource,
  optionalString,
  readNativeForkIntent,
  record,
  requiredString,
  sameRunFence,
  sameRunSpan,
  selectorRuntimeType,
  selectorSessionId,
  stableJson,
  withIntent,
  type AbortReservedNativeForkIntentRunFenceInput,
  type AbortReservedNativeForkIntentRunFenceOutcome,
  type JsonRecord,
  type NativeForkIntentChild,
  type NativeForkIntentInput,
  type NativeForkIntentOutcome,
  type NativeForkIntentRecord,
  type NativeForkIntentReference,
  type NativeForkIntentRunFence,
  type NativeForkIntentRunFenceTransfer,
  type NativeForkIntentSource,
  type NativeForkIntentStatus,
  type NativeForkIntentStoredSource,
  type NativeForkIntentSummary,
  type NativeForkIntentTarget,
  type NativeForkReconciliation,
  type TransferReservedNativeForkIntentRunFenceInput,
} from "./native-fork-intent.codec.js";
export {
  NativeForkAcceptanceUnknownError, NativeForkIntentError, preserveNativeForkIntentProviderState, readNativeForkIntent, type AbortReservedNativeForkIntentRunFenceInput,
  type AbortReservedNativeForkIntentRunFenceOutcome, type NativeForkIntentChild, type NativeForkIntentInput, type NativeForkIntentNoChildProof, type NativeForkIntentOutcome, type NativeForkIntentRecord,
  type NativeForkIntentReference, type NativeForkIntentRunFence, type NativeForkIntentRunFenceTransfer, type NativeForkIntentSource, type NativeForkIntentStatus, type NativeForkIntentSummary, type NativeForkIntentTarget, type NativeForkReconciliation, type TransferReservedNativeForkIntentRunFenceInput
} from "./native-fork-intent.codec.js";

function targetFromBinding(binding: RuntimeBindingRecord, segment: NativeSegmentRecord): NativeForkIntentTarget {
  return {
    bindingId: binding.id,
    segmentId: segment.id,
    orgId: binding.orgId,
    bindingEpoch: binding.bindingEpoch,
    runtimeType: requiredString(binding.runtimeType, "target runtime type"),
    hostId: requiredString(binding.hostId, "target host"),
    profileId: requiredString(binding.profileId, "target profile"),
    workspaceBindingId: binding.workspaceBindingId?.trim() || null,
    capabilityRevision: requiredString(binding.capabilityRevision, "target capability revision"),
  };
}

function referenceForIntent(intent: NativeForkIntentRecord): NativeForkIntentReference {
  return {
    intentId: intent.intentId,
    orgId: intent.target.orgId,
    bindingId: intent.target.bindingId,
    segmentId: intent.target.segmentId,
  };
}

function summarizeIntent(
  intent: NativeForkIntentRecord,
  input: { conversationId: string | null; segmentState: string; nativeSessionId: string | null },
): NativeForkIntentSummary {
  return {
    intentId: intent.intentId,
    idempotencyKey: intent.idempotencyKey,
    status: intent.status,
    source: { ...intent.source },
    target: { ...intent.target },
    reconciliation: intent.reconciliation,
    reason: intent.reason,
    reconciliationNote: intent.reconciliationNote,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    conversationId: input.conversationId,
    segmentState: input.segmentState,
    nativeSessionId: input.nativeSessionId,
  };
}

function sameString(left: string | null | undefined, right: string | null | undefined) {
  return (left?.trim() || null) === (right?.trim() || null);
}

function sameSource(left: NativeForkIntentStoredSource, right: NativeForkIntentSource) {
  return left.orgId === right.orgId
    && sameString(left.sourceConversationId, right.sourceConversationId)
    && left.sourceRunId === right.sourceRunId
    && left.sourceSpanId === right.sourceSpanId
    && left.sourceBoundaryRef === right.sourceBoundaryRef
    && (!left.selectorJson || stableJson(left.selectorJson) === stableJson(right.selectorJson));
}

function sameTarget(left: NativeForkIntentTarget, right: NativeForkIntentTarget) {
  return left.bindingId === right.bindingId
    && left.segmentId === right.segmentId
    && left.orgId === right.orgId
    && left.bindingEpoch === right.bindingEpoch
    && left.runtimeType === right.runtimeType
    && left.hostId === right.hostId
    && left.profileId === right.profileId
    && sameString(left.workspaceBindingId, right.workspaceBindingId)
    && left.capabilityRevision === right.capabilityRevision;
}

function assertProviderBindingMatches(binding: RuntimeBindingRecord, providerBinding: RuntimeProviderBindingRef | null | undefined) {
  if (!providerBinding) return;
  if (providerBinding.id && providerBinding.id !== binding.id) {
    throw new NativeForkIntentError("target_invalid", "Provider binding id does not match the target runtime binding");
  }
  if (providerBinding.orgId && providerBinding.orgId !== binding.orgId) {
    throw new NativeForkIntentError("target_invalid", "Provider binding organization does not match the target runtime binding");
  }
  if (providerBinding.hostId.trim() !== binding.hostId.trim() || providerBinding.profileId.trim() !== binding.profileId.trim()) {
    throw new NativeForkIntentError("target_invalid", "Provider binding host/profile does not match the target runtime binding");
  }
  if (providerBinding.workspaceBindingId !== undefined
    && !sameString(providerBinding.workspaceBindingId, binding.workspaceBindingId)) {
    throw new NativeForkIntentError("target_invalid", "Provider binding workspace does not match the target runtime binding");
  }
  if (providerBinding.capabilityRevision !== undefined
    && !sameString(providerBinding.capabilityRevision, binding.capabilityRevision)) {
    throw new NativeForkIntentError("target_invalid", "Provider binding capability revision does not match the target runtime binding");
  }
}

async function loadTarget(tx: Db, input: NativeForkIntentInput) {
  const binding = await tx
    .select()
    .from(runtimeBindings)
    .where(and(
      eq(runtimeBindings.id, input.targetBinding.id),
      eq(runtimeBindings.orgId, input.targetBinding.orgId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!binding || binding.status !== "active") {
    throw new NativeForkIntentError("target_invalid", "Target runtime binding is not active");
  }
  const segment = await tx
    .select()
    .from(nativeSegments)
    .where(and(
      eq(nativeSegments.id, input.targetSegment.id),
      eq(nativeSegments.orgId, binding.orgId),
      eq(nativeSegments.bindingId, binding.id),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!segment || !["pending", "open"].includes(segment.state)) {
    throw new NativeForkIntentError("target_invalid", "Target runtime segment is not reservable");
  }
  if (binding.currentSegmentId !== segment.id || segment.runtimeType !== binding.runtimeType) {
    throw new NativeForkIntentError("target_invalid", "Target runtime segment is not the active binding segment");
  }
  assertProviderBindingMatches(binding, input.providerBinding);
  return { binding, segment, target: targetFromBinding(binding, segment) };
}

async function lockIntentTarget(
  tx: Db,
  bindingId: string,
  segmentId: string,
  runFence?: NativeForkIntentRunFence,
) {
  if (runFence) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runFence.runId}))`);
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`native-fork-intent:${bindingId}:${segmentId}`}, 0))`);
}

async function assertCurrentRunFence(
  tx: Db,
  fence: NativeForkIntentRunFence,
  target: { orgId: string; bindingId: string; segmentId: string },
) {
  const run = await tx
    .select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      chatConversationId: heartbeatRuns.chatConversationId,
      status: heartbeatRuns.status,
      executionOwnerToken: heartbeatRuns.executionOwnerToken,
      executionLeaseExpiresAt: heartbeatRuns.executionLeaseExpiresAt,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, fence.runId),
      eq(heartbeatRuns.orgId, target.orgId),
      eq(heartbeatRuns.status, "running"),
      eq(heartbeatRuns.executionOwnerToken, fence.ownerToken),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run || (run.executionLeaseExpiresAt && run.executionLeaseExpiresAt.getTime() <= Date.now())) {
    throw new NativeForkIntentError("run_fence_stale", "Native fork target Run owner fence is stale");
  }
  const binding = await tx
    .select({ agentId: runtimeBindings.agentId, conversationId: runtimeBindings.conversationId })
    .from(runtimeBindings)
    .where(and(
      eq(runtimeBindings.id, target.bindingId),
      eq(runtimeBindings.orgId, target.orgId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!binding || binding.agentId !== run.agentId || binding.conversationId !== run.chatConversationId) {
    throw new NativeForkIntentError("run_fence_stale", "Native fork target Run does not own the target runtime binding");
  }
  const span = await tx
    .select()
    .from(runRuntimeSpans)
    .where(and(
      eq(runRuntimeSpans.id, fence.spanId),
      eq(runRuntimeSpans.orgId, target.orgId),
      eq(runRuntimeSpans.runId, fence.runId),
      eq(runRuntimeSpans.bindingId, target.bindingId),
      eq(runRuntimeSpans.segmentId, target.segmentId),
      eq(runRuntimeSpans.ownerToken, fence.ownerToken),
      eq(runRuntimeSpans.attemptEpoch, fence.attemptEpoch),
      eq(runRuntimeSpans.state, "open"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!span) {
    throw new NativeForkIntentError("run_fence_stale", "Native fork target Run span owner fence is stale");
  }
  return span;
}

function assertIntentRunFence(
  intent: NativeForkIntentRecord,
  supplied: NativeForkIntentRunFence | undefined,
  options: { allowOwnerRotation?: boolean } = {},
) {
  if (!intent.runFence && !supplied) return undefined;
  if (!supplied) {
    throw new NativeForkIntentError("run_fence_stale", "Run-linked native fork intent requires its current Run fence");
  }
  if (intent.runFence && !sameRunSpan(intent.runFence, supplied)) {
    throw new NativeForkIntentError("run_fence_stale", "Native fork intent is linked to a different Run span");
  }
  if (intent.runFence && !sameRunFence(intent.runFence, supplied) && !options.allowOwnerRotation) {
    throw new NativeForkIntentError("run_fence_stale", "Native fork intent was reserved by a different Run owner");
  }
  return supplied;
}

async function assertSource(tx: Db, source: NativeForkIntentSource, targetRuntimeType: string, targetConversationId: string | null) {
  const sourceRun = await tx
    .select({ id: heartbeatRuns.id, orgId: heartbeatRuns.orgId, status: heartbeatRuns.status, chatConversationId: heartbeatRuns.chatConversationId })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, source.sourceRunId), eq(heartbeatRuns.orgId, source.orgId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!sourceRun || sourceRun.status !== "succeeded") {
    throw new NativeForkIntentError("source_invalid", "Source run is missing or is not a completed run in the target organization");
  }
  const sourceSpan = await tx
    .select()
    .from(runRuntimeSpans)
    .where(and(
      eq(runRuntimeSpans.id, source.sourceSpanId),
      eq(runRuntimeSpans.orgId, source.orgId),
      eq(runRuntimeSpans.runId, source.sourceRunId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!sourceSpan || sourceSpan.state !== "sealed" || sourceSpan.completeness !== "complete") {
    throw new NativeForkIntentError("source_invalid", "Source native span is not a complete sealed boundary");
  }
  if (source.sourceConversationId && sourceRun.chatConversationId !== source.sourceConversationId
    && (sourceRun.chatConversationId !== null
      || !await hasRetainedNativeForkSource(tx, source, targetConversationId, sourceSpan))) {
    throw new NativeForkIntentError("source_invalid", "Source conversation does not own the source run or an exact retained alias");
  }
  const persistedSelector = record(sourceSpan.selectorJson);
  if (!persistedSelector || stableJson(persistedSelector) !== stableJson(source.selectorJson)) {
    throw new NativeForkIntentError("source_invalid", "Source selector does not match the persisted native span selector");
  }
  const sourceSegment = await tx
    .select({ runtimeType: nativeSegments.runtimeType, nativeSessionId: nativeSegments.nativeSessionId, leafId: nativeSegments.leafId, sourceBoundaryRef: nativeSegments.sourceBoundaryRef })
    .from(nativeSegments)
    .where(and(
      eq(nativeSegments.id, sourceSpan.segmentId),
      eq(nativeSegments.orgId, source.orgId),
      eq(nativeSegments.bindingId, sourceSpan.bindingId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!sourceSegment || sourceSegment.runtimeType !== targetRuntimeType || !sourceSegment.nativeSessionId) {
    throw new NativeForkIntentError("source_invalid", "Source native session does not match the target runtime");
  }
  const selectorRuntime = selectorRuntimeType(source.selectorJson);
  if (selectorRuntime && selectorRuntime !== targetRuntimeType) {
    throw new NativeForkIntentError("source_invalid", "Source selector runtime does not match the target runtime");
  }
  const selectorSession = selectorSessionId(source.selectorJson);
  if (selectorSession && selectorSession !== sourceSegment.nativeSessionId) {
    throw new NativeForkIntentError("source_invalid", "Source selector session does not match the persisted native session");
  }
  const spanBoundary = sourceSpan.nativeExecutionRef?.trim() || null;
  const boundaryMatches = (spanBoundary
    ? [spanBoundary]
    : [sourceSegment.leafId, sourceSegment.sourceBoundaryRef])
    .some((candidate) => candidate?.trim() === source.sourceBoundaryRef);
  if (!boundaryMatches) {
    throw new NativeForkIntentError("source_invalid", "Source boundary is not the persisted source span boundary");
  }
}

function intentResult(intent: NativeForkIntentRecord): NativeForkIntentOutcome {
  const reference = referenceForIntent(intent);
  if (intent.status === "accepted" && intent.child) {
    return { status: "accepted", shouldFork: false, intent, reference, child: cloneChild(intent.child) };
  }
  if (intent.status === "unknown") {
    return {
      status: "unknown",
      shouldFork: false,
      retryAllowed: false,
      intent,
      reference,
      reason: intent.reason || "Native fork acceptance is unknown; provider reconciliation is required before retry.",
    };
  }
  if (intent.status === "rejected") {
    return {
      status: "rejected",
      shouldFork: false,
      retryAllowed: false,
      intent,
      reference,
      reason: intent.reason || "Provider rejected the native fork.",
    };
  }
  return { status: "reserved", shouldFork: true, intent, reference };
}

function assertSameIntent(existing: NativeForkIntentRecord, input: NativeForkIntentInput, target: NativeForkIntentTarget) {
  const source = normalizeSource(input.source);
  const key = normalizeIdempotencyKey(input.idempotencyKey);
  if (existing.idempotencyKey !== key || !sameSource(existing.source, source) || !sameTarget(existing.target, target)) {
    throw new NativeForkIntentError("intent_conflict", "The target segment already has a different native fork intent");
  }
}

export async function reserveNativeForkIntent(
  db: Db,
  input: NativeForkIntentInput,
): Promise<NativeForkIntentOutcome> {
  const source = normalizeSource(input.source);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const runFence = normalizeRunFence(input.runFence);
  const normalizedInput = { ...input, runFence };
  if (source.orgId !== input.targetBinding.orgId) {
    throw new NativeForkIntentError("source_invalid", "Source and target organizations must match");
  }
  return db.transaction(async (tx) => {
    const database = tx as unknown as Db;
    // Keep the same lock order as Fork/delete/Keep/GC before binding/Run locks.
    await lockRuntimeRetentionScope(database, source.orgId);
    await lockIntentTarget(database, input.targetBinding.id, input.targetSegment.id, runFence);
    const { binding, segment, target } = await loadTarget(database, normalizedInput);
    if (runFence) {
      await assertCurrentRunFence(database, runFence, {
        orgId: binding.orgId,
        bindingId: binding.id,
        segmentId: segment.id,
      });
    }
    await assertSource(tx as unknown as Db, source, target.runtimeType, binding.conversationId);
    let existing = intentFromProviderState(segment.providerStateJson);
    if (existing) {
      assertSameIntent(existing, { ...normalizedInput, source, idempotencyKey }, target);
      assertIntentRunFence(existing, runFence, { allowOwnerRotation: true });
      if (existing.status === "reserved") {
        const now = new Date().toISOString();
        const unknown: NativeForkIntentRecord = {
          ...existing,
          status: "unknown",
          ...(runFence ? { runFence } : {}),
          reason: "A previous native fork reservation had no durable child after recovery; no automatic retry is allowed.",
          reconciliation: "provider_lookup_required",
          reconciliationNote: "Use provider-native lookup or operator reconciliation before retrying admission.",
          updatedAt: now,
        };
        await tx.update(nativeSegments).set({
          providerStateJson: withIntent(segment.providerStateJson, unknown),
          updatedAt: new Date(),
        }).where(and(
          eq(nativeSegments.id, segment.id),
          eq(nativeSegments.orgId, binding.orgId),
          eq(nativeSegments.bindingId, binding.id),
        ));
        return intentResult(unknown);
      }
      if (existing.status === "accepted" && existing.child && runFence) {
        existing = await bindAcceptedIntentToRunSpan(
          database,
          { intentId: existing.intentId, orgId: binding.orgId, bindingId: binding.id, segmentId: segment.id },
          segment,
          existing,
          runFence,
        );
      }
      return intentResult(existing);
    }
    if (segment.nativeSessionId || record(segment.providerStateJson)?.sessionId) {
      throw new NativeForkIntentError("target_invalid", "Target segment already has provider state without a durable fork intent");
    }
    const now = new Date().toISOString();
    const intent: NativeForkIntentRecord = {
      version: NATIVE_FORK_INTENT_VERSION,
      intentId: randomUUID(),
      idempotencyKey,
      status: "reserved",
      source,
      target,
      ...(runFence ? { runFence } : {}),
      reason: null,
      reconciliation: "not_required",
      reconciliationNote: null,
      createdAt: now,
      updatedAt: now,
    };
    const [updated] = await tx.update(nativeSegments).set({
      sourceBoundaryRef: source.sourceBoundaryRef,
      providerStateJson: withIntent(segment.providerStateJson, intent),
      updatedAt: new Date(),
    }).where(and(
      eq(nativeSegments.id, segment.id),
      eq(nativeSegments.orgId, binding.orgId),
      eq(nativeSegments.bindingId, binding.id),
      eq(nativeSegments.state, segment.state),
    )).returning({ id: nativeSegments.id });
    if (!updated) throw new NativeForkIntentError("target_invalid", "Native fork reservation lost the target segment CAS");
    return intentResult(intent);
  });
}

async function loadIntentReference(tx: Db, reference: NativeForkIntentReference) {
  const segment = await tx
    .select()
    .from(nativeSegments)
    .where(and(
      eq(nativeSegments.id, reference.segmentId),
      eq(nativeSegments.orgId, reference.orgId),
      eq(nativeSegments.bindingId, reference.bindingId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!segment) throw new NativeForkIntentError("intent_conflict", "Native fork intent target segment no longer exists");
  const intent = intentFromProviderState(segment.providerStateJson);
  if (!intent || intent.intentId !== reference.intentId || !sameTarget(intent.target, {
    bindingId: reference.bindingId,
    segmentId: reference.segmentId,
    orgId: reference.orgId,
    bindingEpoch: intent.target.bindingEpoch,
    runtimeType: intent.target.runtimeType,
    hostId: intent.target.hostId,
    profileId: intent.target.profileId,
    workspaceBindingId: intent.target.workspaceBindingId,
    capabilityRevision: intent.target.capabilityRevision,
  })) {
    throw new NativeForkIntentError("intent_conflict", "Native fork intent reference does not match durable target state");
  }
  return { segment, intent };
}

/**
 * Move only a still-reserved fork intent from a proven non-dispatched attempt
 * to the next current span. The intent identity and source/target stay fixed;
 * the run lock, retained-runtime lock, and JSONB CAS make the proof/fence move
 * atomic with respect to attempt changes and other fork admission work.
 */
export async function transferReservedNativeForkIntentRunFence(
  db: Db,
  input: TransferReservedNativeForkIntentRunFenceInput,
): Promise<{ reference: NativeForkIntentReference; intent: NativeForkIntentRecord; runFence: NativeForkIntentRunFence }> {
  const reference: NativeForkIntentReference = {
    intentId: requiredString(input.reference.intentId, "native fork intentId"),
    orgId: requiredString(input.reference.orgId, "native fork organization"),
    bindingId: requiredString(input.reference.bindingId, "native fork binding"),
    segmentId: requiredString(input.reference.segmentId, "native fork segment"),
  };
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const oldAttemptId = requiredString(input.oldAttemptId, "old native fork attemptId");
  const oldFence = normalizeRunFence(input.oldFence)!;
  const newFence = normalizeRunFence(input.newFence)!;
  const noChildProof = normalizeNoChildProof(input.noChildProof);
  if (
    oldFence.runId !== newFence.runId
    || oldFence.ownerToken !== newFence.ownerToken
    || oldFence.attemptEpoch !== newFence.attemptEpoch
    || oldFence.spanId === newFence.spanId
  ) {
    throw new NativeForkIntentError("run_fence_stale", "Native fork Run fence transfer must retain the same Run owner and move to a different span");
  }

  return db.transaction(async (tx) => {
    const database = tx as unknown as Db;
    await lockRuntimeRetentionScope(database, reference.orgId);
    await lockIntentTarget(database, reference.bindingId, reference.segmentId, newFence);
    const { segment, intent } = await loadIntentReference(database, reference);
    if (
      intent.status !== "reserved"
      || intent.child
      || intent.idempotencyKey !== idempotencyKey
      || !intent.runFence
      || !sameRunFence(intent.runFence, oldFence)
    ) {
      throw new NativeForkIntentError("run_fence_stale", "Native fork intent is no longer the same reserved, childless Run admission");
    }
    if (
      segment.nativeSessionId !== null
      || optionalString(record(segment.providerStateJson)?.sessionId) !== null
    ) {
      throw new NativeForkIntentError("run_fence_stale", "Native fork target already has provider session identity");
    }

    const newSpan = await assertCurrentRunFence(database, newFence, {
      orgId: reference.orgId,
      bindingId: reference.bindingId,
      segmentId: reference.segmentId,
    });
    const [latestSpan] = await database.select().from(runRuntimeSpans).where(and(
      eq(runRuntimeSpans.orgId, reference.orgId),
      eq(runRuntimeSpans.runId, newFence.runId),
    )).orderBy(desc(runRuntimeSpans.ordinal)).limit(1);
    if (
      latestSpan?.id !== newFence.spanId
      || latestSpan.state !== "open"
      || latestSpan.attemptId !== newSpan.attemptId
      || latestSpan.nativeExecutionRef !== null
    ) {
      throw new NativeForkIntentError("run_fence_stale", "Native fork transfer target is not the latest open childless Run span");
    }

    const [oldSpan] = await database.select().from(runRuntimeSpans).where(and(
      eq(runRuntimeSpans.id, oldFence.spanId),
      eq(runRuntimeSpans.orgId, reference.orgId),
      eq(runRuntimeSpans.runId, oldFence.runId),
      eq(runRuntimeSpans.bindingId, reference.bindingId),
      eq(runRuntimeSpans.segmentId, reference.segmentId),
      eq(runRuntimeSpans.ownerToken, oldFence.ownerToken),
      eq(runRuntimeSpans.attemptEpoch, oldFence.attemptEpoch),
    )).limit(1);
    if (
      !oldSpan
      || oldSpan.attemptId !== oldAttemptId
      || oldSpan.state !== "sealed"
      || !oldSpan.writerLeaseReleasedAt
      || oldSpan.nativeExecutionRef !== null
    ) {
      throw new NativeForkIntentError("run_fence_stale", "Native fork transfer source span lacks sealed, released, childless writer evidence");
    }

    const attempts = await database.select().from(heartbeatRunAttempts).where(and(
      eq(heartbeatRunAttempts.orgId, reference.orgId),
      eq(heartbeatRunAttempts.runId, oldFence.runId),
    )).orderBy(desc(heartbeatRunAttempts.attemptIndex));
    const currentAttempt = attempts[0];
    const oldAttempt = attempts.find((attempt) => attempt.id === oldAttemptId);
    const previousAttempt = currentAttempt
      ? attempts.find((attempt) => attempt.attemptIndex < currentAttempt.attemptIndex)
      : undefined;
    const currentCheckpoint = record(currentAttempt?.checkpointJson);
    const currentSubmission = record(currentCheckpoint?.unifiedSubmission);
    const oldCheckpoint = record(oldAttempt?.checkpointJson);
    const oldSubmission = record(oldCheckpoint?.unifiedSubmission);
    const noProviderIds = (attempt: typeof heartbeatRunAttempts.$inferSelect | undefined, submission: JsonRecord | null) => (
      Boolean(attempt)
      && (attempt!.providerThreadId === null || attempt!.providerThreadId === undefined)
      && (attempt!.providerTurnId === null || attempt!.providerTurnId === undefined)
      && (attempt!.sessionDisplayId === null || attempt!.sessionDisplayId === undefined)
      && (submission?.providerThreadId === null || submission?.providerThreadId === undefined)
      && (submission?.providerTurnId === null || submission?.providerTurnId === undefined)
    );
    if (
      !currentAttempt
      || currentAttempt.id !== newSpan.attemptId
      || currentAttempt.status !== "started"
      || currentAttempt.ownerToken !== newFence.ownerToken
      || currentAttempt.attemptEpoch !== newFence.attemptEpoch
      || currentAttempt.runtimeType !== intent.target.runtimeType
      || !currentSubmission
      || currentSubmission.state !== "pending"
      || currentSubmission.phase !== "pre_submission"
      || currentSubmission.retry !== "allowed"
      || !noProviderIds(currentAttempt, currentSubmission)
      || !oldAttempt
      || previousAttempt?.id !== oldAttempt.id
      || oldAttempt.status !== "failed"
      || !oldAttempt.finishedAt
      || oldAttempt.ownerToken !== oldFence.ownerToken
      || oldAttempt.attemptEpoch !== oldFence.attemptEpoch
      || oldAttempt.runtimeType !== intent.target.runtimeType
      || !oldSubmission
      || typeof oldSubmission.key !== "string"
      || oldSubmission.state !== "rejected"
      || oldSubmission.phase !== "pre_submission"
      || oldSubmission.retry !== "allowed"
      || !noProviderIds(oldAttempt, oldSubmission)
    ) {
      throw new NativeForkIntentError("run_fence_stale", "Native fork transfer requires the authoritative failed attempt's durable pre-submission rejection and no-child evidence");
    }

    const transfer: NativeForkIntentRunFenceTransfer = {
      version: 1,
      oldAttemptId,
      oldFence,
      newFence,
      noChildProof,
    };
    const updatedIntent: NativeForkIntentRecord = {
      ...intent,
      runFence: newFence,
      runFenceTransfers: [...(intent.runFenceTransfers ?? []), transfer],
      updatedAt: new Date().toISOString(),
    };
    const [updated] = await tx.update(nativeSegments).set({
      providerStateJson: withIntent(segment.providerStateJson, updatedIntent),
      updatedAt: new Date(),
    }).where(and(
      eq(nativeSegments.id, reference.segmentId),
      eq(nativeSegments.orgId, reference.orgId),
      eq(nativeSegments.bindingId, reference.bindingId),
      eq(nativeSegments.state, segment.state),
      segment.providerStateJson === null
        ? isNull(nativeSegments.providerStateJson)
        : eq(nativeSegments.providerStateJson, segment.providerStateJson),
    )).returning({ id: nativeSegments.id });
    if (!updated) {
      throw new NativeForkIntentError("intent_conflict", "Native fork Run fence transfer lost its durable intent CAS");
    }
    return { reference, intent: updatedIntent, runFence: newFence };
  });
}

/**
 * Fail closed when a deferred-fork handoff cannot be completed before Run
 * finalization. An exact current open span or a sealed/released bound span is
 * sufficient; a same-owner open successor is allowed after failed transfer.
 * This records reconciliation-required state only and never rotates a fence.
 */
export async function abortReservedNativeForkIntentRunFence(
  db: Db,
  input: AbortReservedNativeForkIntentRunFenceInput,
): Promise<AbortReservedNativeForkIntentRunFenceOutcome> {
  const reference: NativeForkIntentReference = {
    intentId: requiredString(input.reference.intentId, "native fork intentId"),
    orgId: requiredString(input.reference.orgId, "native fork organization"),
    bindingId: requiredString(input.reference.bindingId, "native fork binding"),
    segmentId: requiredString(input.reference.segmentId, "native fork segment"),
  };
  const runFence = normalizeRunFence(input.runFence)!;
  const reason = requiredString(input.reason, "native fork abort reason").slice(0, 2_000);

  return db.transaction(async (tx) => {
    const database = tx as unknown as Db;
    await lockRuntimeRetentionScope(database, reference.orgId);
    await lockIntentTarget(database, reference.bindingId, reference.segmentId, runFence);
    const { segment, intent } = await loadIntentReference(database, reference);
    if (!intent.runFence || !sameRunFence(intent.runFence, runFence)) {
      throw new NativeForkIntentError("run_fence_stale", "Native fork abort does not hold the intent's exact Run fence");
    }

    const now = new Date();
    const [run] = await database.select({
      id: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      chatConversationId: heartbeatRuns.chatConversationId,
      status: heartbeatRuns.status,
      executionOwnerToken: heartbeatRuns.executionOwnerToken,
      executionLeaseExpiresAt: heartbeatRuns.executionLeaseExpiresAt,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, runFence.runId),
      eq(heartbeatRuns.orgId, reference.orgId),
      eq(heartbeatRuns.status, "running"),
      eq(heartbeatRuns.executionOwnerToken, runFence.ownerToken),
    )).limit(1);
    if (!run || !run.executionLeaseExpiresAt || run.executionLeaseExpiresAt.getTime() <= now.getTime()) {
      throw new NativeForkIntentError("run_fence_stale", "Native fork abort requires the same live Run owner");
    }

    const [binding] = await database.select({
      agentId: runtimeBindings.agentId,
      conversationId: runtimeBindings.conversationId,
      currentSegmentId: runtimeBindings.currentSegmentId,
      status: runtimeBindings.status,
    }).from(runtimeBindings).where(and(
      eq(runtimeBindings.id, reference.bindingId),
      eq(runtimeBindings.orgId, reference.orgId),
    )).limit(1);
    if (
      !binding
      || binding.status !== "active"
      || binding.currentSegmentId !== reference.segmentId
      || binding.agentId !== run.agentId
      || binding.conversationId !== run.chatConversationId
    ) {
      throw new NativeForkIntentError("run_fence_stale", "Native fork abort Run no longer owns the target binding");
    }

    const [boundSpan] = await database.select().from(runRuntimeSpans).where(and(
      eq(runRuntimeSpans.id, runFence.spanId),
      eq(runRuntimeSpans.orgId, reference.orgId),
      eq(runRuntimeSpans.runId, runFence.runId),
      eq(runRuntimeSpans.bindingId, reference.bindingId),
      eq(runRuntimeSpans.segmentId, reference.segmentId),
      eq(runRuntimeSpans.ownerToken, runFence.ownerToken),
      eq(runRuntimeSpans.attemptEpoch, runFence.attemptEpoch),
    )).limit(1);
    if (!boundSpan || boundSpan.nativeExecutionRef !== null) {
      throw new NativeForkIntentError("run_fence_stale", "Native fork abort requires its exact childless intent span");
    }
    const [latestSpan] = await database.select().from(runRuntimeSpans).where(and(
      eq(runRuntimeSpans.orgId, reference.orgId),
      eq(runRuntimeSpans.runId, runFence.runId),
    )).orderBy(desc(runRuntimeSpans.ordinal)).limit(1);
    if (boundSpan.state === "open") {
      if (boundSpan.writerLeaseReleasedAt || latestSpan?.id !== boundSpan.id) {
        throw new NativeForkIntentError("run_fence_stale", "Open-span native fork abort requires the exact current writer fence");
      }
    } else if (boundSpan.state === "sealed") {
      if (!boundSpan.writerLeaseReleasedAt) {
        throw new NativeForkIntentError("run_fence_stale", "Sealed-span native fork abort requires its released writer lease");
      }
      if (
        !latestSpan
        || latestSpan.ordinal < boundSpan.ordinal
        || (latestSpan.id !== boundSpan.id && (
          latestSpan.state !== "open"
          || latestSpan.bindingId !== reference.bindingId
          || latestSpan.segmentId !== reference.segmentId
          || latestSpan.ownerToken !== runFence.ownerToken
          || latestSpan.attemptEpoch !== runFence.attemptEpoch
          || latestSpan.nativeExecutionRef !== null
        ))
      ) {
        throw new NativeForkIntentError("run_fence_stale", "A newer native fork abort span must remain open under the same Run owner");
      }
    } else {
      throw new NativeForkIntentError("run_fence_stale", "Unresolved native fork intent spans cannot be aborted");
    }

    if (intent.child || segment.nativeSessionId !== null || optionalString(record(segment.providerStateJson)?.sessionId) !== null) {
      throw new NativeForkIntentError("intent_conflict", "Native fork abort cannot change an intent with provider child identity");
    }
    if (intent.status === "unknown" && intent.reconciliation !== "resolved") {
      return { reference, intent, disposition: "already_unknown" };
    }
    if (intent.status !== "reserved") {
      throw new NativeForkIntentError("intent_conflict", "Only a still-reserved native fork intent can be aborted");
    }

    const updatedIntent: NativeForkIntentRecord = {
      ...intent,
      status: "unknown",
      reason,
      reconciliation: "provider_lookup_required",
      reconciliationNote: "Deferred native fork fence handoff was aborted; reconcile provider state before any retry.",
      updatedAt: now.toISOString(),
    };
    const [updated] = await tx.update(nativeSegments).set({
      providerStateJson: withIntent(segment.providerStateJson, updatedIntent),
      updatedAt: now,
    }).where(and(
      eq(nativeSegments.id, reference.segmentId),
      eq(nativeSegments.orgId, reference.orgId),
      eq(nativeSegments.bindingId, reference.bindingId),
      eq(nativeSegments.state, segment.state),
      segment.providerStateJson === null
        ? isNull(nativeSegments.providerStateJson)
        : eq(nativeSegments.providerStateJson, segment.providerStateJson),
    )).returning({ id: nativeSegments.id });
    if (!updated) {
      throw new NativeForkIntentError("intent_conflict", "Native fork abort lost its durable intent CAS");
    }
    return { reference, intent: updatedIntent, disposition: "aborted" };
  });
}

function normalizeChild(child: NativeForkIntentChild, sourceBoundaryRef: string): NativeForkIntentChild {
  const sessionId = requiredString(child.session?.sessionId, "fork child session");
  const boundary = requiredString(child.boundary, "fork child boundary");
  if (child.continuity !== "native") throw new NativeForkIntentError("child_invalid", "Fork child continuity must be native");
  const returnedSourceBoundary = optionalString(child.sourceBoundary);
  if (returnedSourceBoundary && returnedSourceBoundary !== sourceBoundaryRef) {
    throw new NativeForkIntentError("child_invalid", "Fork child source boundary does not match the reserved source boundary");
  }
  const sessionParams = record(child.session.sessionParams);
  if (!sessionParams) throw new NativeForkIntentError("child_invalid", "Fork child session parameters must be an object");
  return {
    ...cloneChild(child),
    session: {
      sessionId,
      sessionDisplayId: optionalString(child.session.sessionDisplayId) || sessionId,
      sessionParams: { ...sessionParams, sessionId },
    },
    boundary,
    sourceBoundary: sourceBoundaryRef,
    continuity: "native",
  };
}

async function bindAcceptedIntentToRunSpan(
  tx: Db,
  reference: NativeForkIntentReference,
  segment: NativeSegmentRecord,
  intent: NativeForkIntentRecord,
  runFence: NativeForkIntentRunFence,
): Promise<NativeForkIntentRecord> {
  if (!intent.child) throw new NativeForkIntentError("intent_conflict", "An accepted native fork intent has no persisted child");
  const child = normalizeChild(intent.child, intent.source.sourceBoundaryRef);
  const [updatedSpan] = await tx.update(runRuntimeSpans).set({
    nativeExecutionRef: child.boundary,
    updatedAt: new Date(),
  }).where(and(
    eq(runRuntimeSpans.id, runFence.spanId),
    eq(runRuntimeSpans.orgId, reference.orgId),
    eq(runRuntimeSpans.runId, runFence.runId),
    eq(runRuntimeSpans.bindingId, reference.bindingId),
    eq(runRuntimeSpans.segmentId, reference.segmentId),
    eq(runRuntimeSpans.ownerToken, runFence.ownerToken),
    eq(runRuntimeSpans.attemptEpoch, runFence.attemptEpoch),
    eq(runRuntimeSpans.state, "open"),
    sql`(${runRuntimeSpans.nativeExecutionRef} is null or ${runRuntimeSpans.nativeExecutionRef} = ${child.boundary})`,
  )).returning({ id: runRuntimeSpans.id });
  if (!updatedSpan) {
    throw new NativeForkIntentError("run_fence_stale", "Native fork child could not be bound to its active Run span");
  }
  if (!intent.runFence || !sameRunFence(intent.runFence, runFence)) {
    const rebound: NativeForkIntentRecord = {
      ...intent,
      runFence,
      updatedAt: new Date().toISOString(),
    };
    const [updatedSegment] = await tx.update(nativeSegments).set({
      providerStateJson: withIntent(segment.providerStateJson, rebound),
      updatedAt: new Date(),
    }).where(and(
      eq(nativeSegments.id, segment.id),
      eq(nativeSegments.orgId, reference.orgId),
      eq(nativeSegments.bindingId, reference.bindingId),
      eq(nativeSegments.state, segment.state),
    )).returning({ id: nativeSegments.id });
    if (!updatedSegment) {
      throw new NativeForkIntentError("intent_conflict", "Rebinding native fork intent lost the target segment CAS");
    }
    return rebound;
  }
  return intent;
}

async function persistChild(
  db: Db,
  reference: NativeForkIntentReference,
  child: NativeForkIntentChild,
  reconciliation: NativeForkReconciliation,
  reconciliationNote: string | null,
  inputRunFence?: NativeForkIntentRunFence | null,
  allowOwnerRotation = false,
): Promise<NativeForkIntentOutcome> {
  const runFence = normalizeRunFence(inputRunFence);
  return db.transaction(async (tx) => {
    const database = tx as unknown as Db;
    await lockIntentTarget(database, reference.bindingId, reference.segmentId, runFence);
    const { segment, intent } = await loadIntentReference(database, reference);
    const effectiveFence = assertIntentRunFence(intent, runFence, {
      allowOwnerRotation: allowOwnerRotation && (intent.status === "unknown" || intent.status === "accepted"),
    });
    if (effectiveFence) {
      await assertCurrentRunFence(database, effectiveFence, {
        orgId: reference.orgId,
        bindingId: reference.bindingId,
        segmentId: reference.segmentId,
      });
    }
    if (intent.status === "accepted" && intent.child) {
      const normalized = normalizeChild(child, intent.source.sourceBoundaryRef);
      if (stableJson(normalized) !== stableJson(intent.child)) {
        throw new NativeForkIntentError("intent_conflict", "A different child is already persisted for this native fork intent");
      }
      return intentResult(effectiveFence
        ? await bindAcceptedIntentToRunSpan(tx as unknown as Db, reference, segment, intent, effectiveFence)
        : intent);
    }
    if (intent.status === "rejected") {
      throw new NativeForkIntentError("intent_conflict", "A rejected native fork intent cannot accept a child");
    }
    const normalized = normalizeChild(child, intent.source.sourceBoundaryRef);
    if (segment.nativeSessionId && segment.nativeSessionId !== normalized.session.sessionId) {
      throw new NativeForkIntentError("intent_conflict", "Target segment already contains a different provider child");
    }
    if (intent.status === "unknown" && !allowOwnerRotation) {
      throw new NativeForkIntentError("intent_unknown", "Unknown native fork intent requires explicit provider reconciliation");
    }
    const now = new Date().toISOString();
    const accepted: NativeForkIntentRecord = {
      ...intent,
      status: "accepted",
      ...(effectiveFence ? { runFence: effectiveFence } : {}),
      child: normalized,
      reason: null,
      reconciliation,
      reconciliationNote,
      updatedAt: now,
    };
    const params = normalized.session.sessionParams;
    const rootSessionId = optionalString(params.rootSessionId)
      || optionalString(params.root_session_id)
      || normalized.session.sessionId;
    const [updated] = await tx.update(nativeSegments).set({
      nativeSessionId: normalized.session.sessionId,
      rootSessionId,
      providerStateJson: {
        ...cloneRecord(segment.providerStateJson),
        ...params,
        sessionId: normalized.session.sessionId,
        [NATIVE_FORK_INTENT_KEY]: accepted,
      },
      sourceBoundaryRef: intent.source.sourceBoundaryRef,
      state: "open",
      updatedAt: new Date(),
    }).where(and(
      eq(nativeSegments.id, segment.id),
      eq(nativeSegments.orgId, reference.orgId),
      eq(nativeSegments.bindingId, reference.bindingId),
      eq(nativeSegments.state, segment.state),
    )).returning({ id: nativeSegments.id });
    if (!updated) throw new NativeForkIntentError("intent_conflict", "Persisting the native fork child lost the target segment CAS");
    if (effectiveFence) {
      const [updatedSpan] = await tx.update(runRuntimeSpans).set({
        nativeExecutionRef: normalized.boundary,
        updatedAt: new Date(),
      }).where(and(
        eq(runRuntimeSpans.id, effectiveFence.spanId),
        eq(runRuntimeSpans.orgId, reference.orgId),
        eq(runRuntimeSpans.runId, effectiveFence.runId),
        eq(runRuntimeSpans.bindingId, reference.bindingId),
        eq(runRuntimeSpans.segmentId, reference.segmentId),
        eq(runRuntimeSpans.ownerToken, effectiveFence.ownerToken),
        eq(runRuntimeSpans.attemptEpoch, effectiveFence.attemptEpoch),
        eq(runRuntimeSpans.state, "open"),
        sql`(${runRuntimeSpans.nativeExecutionRef} is null or ${runRuntimeSpans.nativeExecutionRef} = ${normalized.boundary})`,
      )).returning({ id: runRuntimeSpans.id });
      if (!updatedSpan) {
        throw new NativeForkIntentError("run_fence_stale", "Persisting native fork child lost the target Run span fence");
      }
    }
    return intentResult(accepted);
  });
}

export async function persistNativeForkChild(
  db: Db,
  input: { reference: NativeForkIntentReference; child: NativeForkIntentChild; runFence?: NativeForkIntentRunFence | null },
): Promise<NativeForkIntentOutcome> {
  return persistChild(db, input.reference, input.child, "not_required", null, input.runFence);
}

export async function reconcileNativeForkIntent(
  db: Db,
  input: { reference: NativeForkIntentReference; child: NativeForkIntentChild; note?: string | null; runFence?: NativeForkIntentRunFence | null },
): Promise<NativeForkIntentOutcome> {
  return persistChild(
    db,
    input.reference,
    input.child,
    "resolved",
    input.note?.trim() || "Provider child reconciled before admission.",
    input.runFence,
    true,
  );
}

export async function listNativeForkIntents(
  db: Db,
  input: { orgId: string; status?: NativeForkIntentStatus; limit?: number } ,
): Promise<NativeForkIntentSummary[]> {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  const rows = await db
    .select({ segment: nativeSegments, binding: runtimeBindings })
    .from(nativeSegments)
    .innerJoin(runtimeBindings, and(
      eq(runtimeBindings.id, nativeSegments.bindingId),
      eq(runtimeBindings.orgId, nativeSegments.orgId),
    ))
    .where(and(
      eq(nativeSegments.orgId, input.orgId),
      sql`${nativeSegments.providerStateJson} ? ${NATIVE_FORK_INTENT_KEY}`,
    ))
    .orderBy(desc(nativeSegments.updatedAt), desc(nativeSegments.id))
    .limit(limit);

  const results: NativeForkIntentSummary[] = [];
  for (const row of rows) {
    let intent: NativeForkIntentRecord | null;
    try {
      intent = readNativeForkIntent(row.segment.providerStateJson);
    } catch {
      continue;
    }
    if (!intent || (input.status && intent.status !== input.status)) continue;
    results.push(summarizeIntent(intent, {
      conversationId: row.binding.conversationId,
      segmentState: row.segment.state,
      nativeSessionId: row.segment.nativeSessionId,
    }));
  }
  return results;
}

export async function reconcileNativeForkIntentById(
  db: Db,
  input: {
    orgId: string;
    intentId: string;
    child: NativeForkIntentChild;
    note?: string | null;
    runFence?: NativeForkIntentRunFence | null;
  },
): Promise<{ outcome: NativeForkIntentOutcome; summary: NativeForkIntentSummary }> {
  const row = await db
    .select({ segment: nativeSegments, binding: runtimeBindings })
    .from(nativeSegments)
    .innerJoin(runtimeBindings, and(
      eq(runtimeBindings.id, nativeSegments.bindingId),
      eq(runtimeBindings.orgId, nativeSegments.orgId),
    ))
    .where(and(
      eq(nativeSegments.orgId, input.orgId),
      sql`${nativeSegments.providerStateJson} -> ${NATIVE_FORK_INTENT_KEY} ->> 'intentId' = ${input.intentId}`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw new NativeForkIntentError("intent_conflict", "Native fork intent was not found in this organization");

  const intent = readNativeForkIntent(row.segment.providerStateJson);
  if (!intent) throw new NativeForkIntentError("intent_conflict", "Native fork intent was not found in the target segment");
  if (intent.status === "rejected") throw new NativeForkIntentError("intent_conflict", "A rejected native fork intent cannot be reconciled");
  const outcome = intent.status === "accepted" && intent.child && !intent.runFence && !input.runFence
    ? intentResult(intent)
    : await reconcileNativeForkIntent(db, {
      reference: referenceForIntent(intent),
      child: input.child,
      note: input.note,
      runFence: input.runFence,
    });
  const refreshed = await db
    .select({ segment: nativeSegments, binding: runtimeBindings })
    .from(nativeSegments)
    .innerJoin(runtimeBindings, and(
      eq(runtimeBindings.id, nativeSegments.bindingId),
      eq(runtimeBindings.orgId, nativeSegments.orgId),
    ))
    .where(and(eq(nativeSegments.orgId, input.orgId), eq(nativeSegments.id, row.segment.id)))
    .limit(1)
    .then((rows) => rows[0] ?? row);
  return {
    outcome,
    summary: summarizeIntent(outcome.intent, {
      conversationId: refreshed.binding.conversationId,
      segmentState: refreshed.segment.state,
      nativeSessionId: refreshed.segment.nativeSessionId,
    }),
  };
}

async function updateIntentStatus(
  db: Db,
  input: {
    reference: NativeForkIntentReference;
    runFence?: NativeForkIntentRunFence | null;
    status: "unknown" | "rejected";
    reason: string;
    reconciliation: NativeForkReconciliation;
    reconciliationNote: string | null;
  },
): Promise<NativeForkIntentOutcome> {
  const reason = requiredString(input.reason, "fork intent reason");
  const runFence = normalizeRunFence(input.runFence);
  return db.transaction(async (tx) => {
    const database = tx as unknown as Db;
    await lockIntentTarget(database, input.reference.bindingId, input.reference.segmentId, runFence);
    const { segment, intent } = await loadIntentReference(database, input.reference);
    const effectiveFence = assertIntentRunFence(intent, runFence, {
      allowOwnerRotation: input.status === "unknown",
    });
    if (effectiveFence) {
      await assertCurrentRunFence(database, effectiveFence, {
        orgId: input.reference.orgId,
        bindingId: input.reference.bindingId,
        segmentId: input.reference.segmentId,
      });
    }
    if (intent.status === "accepted") return intentResult(intent);
    if (intent.status === input.status) return intentResult(intent);
    if (intent.status !== "reserved") {
      throw new NativeForkIntentError("intent_conflict", "Native fork intent has already reached a terminal state");
    }
    const updatedIntent: NativeForkIntentRecord = {
      ...intent,
      status: input.status,
      ...(effectiveFence ? { runFence: effectiveFence } : {}),
      reason,
      reconciliation: input.reconciliation,
      reconciliationNote: input.reconciliationNote,
      updatedAt: new Date().toISOString(),
    };
    const [updated] = await tx.update(nativeSegments).set({
      providerStateJson: withIntent(segment.providerStateJson, updatedIntent),
      updatedAt: new Date(),
    }).where(and(
      eq(nativeSegments.id, segment.id),
      eq(nativeSegments.orgId, input.reference.orgId),
      eq(nativeSegments.bindingId, input.reference.bindingId),
      eq(nativeSegments.state, segment.state),
    )).returning({ id: nativeSegments.id });
    if (!updated) throw new NativeForkIntentError("intent_conflict", "Updating native fork intent lost the target segment CAS");
    return intentResult(updatedIntent);
  });
}

export async function markNativeForkIntentUnknown(
  db: Db,
  input: { reference: NativeForkIntentReference; reason: string; runFence?: NativeForkIntentRunFence | null; reconciliation?: "provider_lookup_required" | "provider_lookup_unavailable"; note?: string | null },
): Promise<NativeForkIntentOutcome> {
  return updateIntentStatus(db, {
    reference: input.reference,
    runFence: input.runFence,
    status: "unknown",
    reason: input.reason,
    reconciliation: input.reconciliation ?? "provider_lookup_required",
    reconciliationNote: input.note?.trim() || "Do not retry the provider fork until its acceptance is reconciled.",
  });
}

export async function markNativeForkIntentRejected(
  db: Db,
  input: { reference: NativeForkIntentReference; reason: string; runFence?: NativeForkIntentRunFence | null },
): Promise<NativeForkIntentOutcome> {
  return updateIntentStatus(db, {
    reference: input.reference,
    runFence: input.runFence,
    status: "rejected",
    reason: input.reason,
    reconciliation: "not_required",
    reconciliationNote: null,
  });
}

/**
 * Reserve and execute one provider fork. A provider exception is treated as
 * accepted-unknown: the durable intent blocks retry until a provider lookup or
 * operator reconciliation supplies the child. The caller must persist the
 * returned accepted child before admitting a Run.
 */
export async function executeNativeForkIntent(input: {
  db: Db;
  intent: NativeForkIntentInput;
  driver: Pick<RuntimeDriver, "fork">;
  sourceSession: RuntimeProviderSessionRef;
  boundary: string;
  providerBinding: RuntimeProviderBindingRef;
  signal?: AbortSignal;
}): Promise<NativeForkIntentOutcome> {
  const runFence = normalizeRunFence(input.intent.runFence);
  const reservation = await reserveNativeForkIntent(input.db, { ...input.intent, runFence });
  if (reservation.status !== "reserved") return reservation;
  const effectiveFence = reservation.intent.runFence ?? runFence;
  let operation: Awaited<ReturnType<RuntimeDriver["fork"]>>;
  try {
    operation = await input.driver.fork({
      session: input.sourceSession,
      boundary: requiredString(input.boundary, "source boundary"),
      selector: input.intent.source.selectorJson as NativeSpanSelector,
      binding: input.providerBinding,
      signal: input.signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markNativeForkIntentUnknown(input.db, {
      reference: reservation.reference,
      reason: `Provider fork acceptance is unknown: ${reason}`,
      runFence: effectiveFence,
    });
    throw new NativeForkAcceptanceUnknownError(
      reservation.reference,
      "Provider fork acceptance is unknown; the durable intent is blocked pending reconciliation.",
    );
  }
  if (operation.status !== "supported") {
    const reason = operation.reason || `Provider fork returned ${operation.status}`;
    if (operation.status === "unknown") {
      await markNativeForkIntentUnknown(input.db, {
        reference: reservation.reference,
        reason,
        runFence: effectiveFence,
      });
      throw new NativeForkAcceptanceUnknownError(reservation.reference, "Provider fork acceptance is unknown; automatic retry is disabled.");
    }
    await markNativeForkIntentRejected(input.db, { reference: reservation.reference, reason, runFence: effectiveFence });
    throw new NativeForkIntentError("provider_rejected", `Provider-native fork ${operation.status}: ${reason}`);
  }
  try {
    return await persistNativeForkChild(input.db, {
      reference: reservation.reference,
      child: operation.value,
      runFence: effectiveFence,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markNativeForkIntentUnknown(input.db, {
      reference: reservation.reference,
      reason: `Provider returned a child but durable child persistence failed: ${reason}`,
      runFence: effectiveFence,
    }).catch(() => undefined);
    throw new NativeForkAcceptanceUnknownError(
      reservation.reference,
      "Provider returned a fork child but durable persistence failed; automatic retry is disabled.",
    );
  }
}

export function nativeForkIntentKey() {
  return NATIVE_FORK_INTENT_KEY;
}
