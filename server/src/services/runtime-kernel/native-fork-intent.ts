import type { Db } from "@rudderhq/db";
import {
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { RuntimeProviderBindingRef, RuntimeProviderForkResult, RuntimeProviderSessionRef } from "./provider-capabilities.js";
import type { RuntimeDriver } from "./runtime-driver.js";
import type { NativeSegmentRecord, RuntimeBindingRecord } from "./native-session.js";

const NATIVE_FORK_INTENT_KEY = "__rudderNativeForkIntent";
const NATIVE_FORK_INTENT_VERSION = 1 as const;

export type NativeForkIntentStatus = "reserved" | "accepted" | "unknown" | "rejected";
export type NativeForkReconciliation =
  | "not_required"
  | "provider_lookup_required"
  | "provider_lookup_unavailable"
  | "resolved";

export type NativeForkIntentSource = {
  orgId: string;
  sourceConversationId?: string | null;
  sourceRunId: string;
  sourceSpanId: string;
  sourceBoundaryRef: string;
};

export type NativeForkIntentTarget = {
  bindingId: string;
  segmentId: string;
  orgId: string;
  bindingEpoch: number;
  runtimeType: string;
  hostId: string;
  profileId: string;
  workspaceBindingId: string | null;
  capabilityRevision: string;
};

export type NativeForkIntentChild = RuntimeProviderForkResult;

export type NativeForkIntentRecord = {
  version: typeof NATIVE_FORK_INTENT_VERSION;
  intentId: string;
  idempotencyKey: string;
  status: NativeForkIntentStatus;
  source: NativeForkIntentSource;
  target: NativeForkIntentTarget;
  child?: NativeForkIntentChild;
  reason: string | null;
  reconciliation: NativeForkReconciliation;
  reconciliationNote: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NativeForkIntentReference = {
  intentId: string;
  orgId: string;
  bindingId: string;
  segmentId: string;
};

export type NativeForkIntentSummary = {
  intentId: string;
  idempotencyKey: string;
  status: NativeForkIntentStatus;
  source: NativeForkIntentSource;
  target: NativeForkIntentTarget;
  reconciliation: NativeForkReconciliation;
  reason: string | null;
  reconciliationNote: string | null;
  createdAt: string;
  updatedAt: string;
  conversationId: string | null;
  segmentState: string;
  nativeSessionId: string | null;
};

export type NativeForkIntentInput = {
  idempotencyKey: string;
  source: NativeForkIntentSource;
  targetBinding: RuntimeBindingRecord;
  targetSegment: NativeSegmentRecord;
  providerBinding?: RuntimeProviderBindingRef | null;
};

export type NativeForkIntentOutcome =
  | { status: "reserved"; shouldFork: true; intent: NativeForkIntentRecord; reference: NativeForkIntentReference }
  | { status: "accepted"; shouldFork: false; intent: NativeForkIntentRecord; reference: NativeForkIntentReference; child: NativeForkIntentChild }
  | { status: "unknown"; shouldFork: false; retryAllowed: false; intent: NativeForkIntentRecord; reference: NativeForkIntentReference; reason: string }
  | { status: "rejected"; shouldFork: false; retryAllowed: false; intent: NativeForkIntentRecord; reference: NativeForkIntentReference; reason: string };

export class NativeForkIntentError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "source_invalid"
      | "target_invalid"
      | "intent_conflict"
      | "intent_unknown"
      | "provider_rejected"
      | "child_invalid",
    message: string,
  ) {
    super(message);
    this.name = "NativeForkIntentError";
  }
}

export class NativeForkAcceptanceUnknownError extends NativeForkIntentError {
  readonly retryAllowed = false as const;
  readonly reconciliationRequired = true as const;

  constructor(
    readonly reference: NativeForkIntentReference,
    message: string,
  ) {
    super("intent_unknown", message);
    this.name = "NativeForkAcceptanceUnknownError";
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NativeForkIntentError("invalid_input", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return value ? { ...value } : {};
}

function cloneChild(child: NativeForkIntentChild): NativeForkIntentChild {
  return {
    ...child,
    session: {
      ...child.session,
      sessionParams: { ...child.session.sessionParams },
    },
    sourceBoundary: child.sourceBoundary ?? null,
    identityMap: child.identityMap ? { ...child.identityMap } : undefined,
  };
}

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

function sameSource(left: NativeForkIntentSource, right: NativeForkIntentSource) {
  return left.orgId === right.orgId
    && sameString(left.sourceConversationId, right.sourceConversationId)
    && left.sourceRunId === right.sourceRunId
    && left.sourceSpanId === right.sourceSpanId
    && left.sourceBoundaryRef === right.sourceBoundaryRef;
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

function intentFromProviderState(value: unknown): NativeForkIntentRecord | null {
  const state = record(value);
  const raw = state?.[NATIVE_FORK_INTENT_KEY];
  if (raw === undefined || raw === null) return null;
  const parsed = record(raw);
  if (
    !parsed
    || parsed.version !== NATIVE_FORK_INTENT_VERSION
    || typeof parsed.intentId !== "string"
    || typeof parsed.idempotencyKey !== "string"
    || !["reserved", "accepted", "unknown", "rejected"].includes(parsed.status as string)
    || !record(parsed.source)
    || !record(parsed.target)
    || typeof parsed.reason !== "string" && parsed.reason !== null
    || !["not_required", "provider_lookup_required", "provider_lookup_unavailable", "resolved"].includes(parsed.reconciliation as string)
    || typeof parsed.reconciliationNote !== "string" && parsed.reconciliationNote !== null
    || typeof parsed.createdAt !== "string"
    || typeof parsed.updatedAt !== "string"
  ) {
    throw new NativeForkIntentError("intent_conflict", "The target segment contains an invalid native fork intent");
  }
  const source = parsed.source as JsonRecord;
  const target = parsed.target as JsonRecord;
  if (
    typeof source.orgId !== "string"
    || typeof source.sourceRunId !== "string"
    || typeof source.sourceSpanId !== "string"
    || typeof source.sourceBoundaryRef !== "string"
    || typeof target.bindingId !== "string"
    || typeof target.segmentId !== "string"
    || typeof target.orgId !== "string"
    || typeof target.bindingEpoch !== "number"
    || typeof target.runtimeType !== "string"
    || typeof target.hostId !== "string"
    || typeof target.profileId !== "string"
    || (target.workspaceBindingId !== null && typeof target.workspaceBindingId !== "string")
    || typeof target.capabilityRevision !== "string"
  ) {
    throw new NativeForkIntentError("intent_conflict", "The target segment contains an invalid native fork identity");
  }
  const child = parsed.child === undefined || parsed.child === null ? undefined : parsed.child as NativeForkIntentChild;
  if (parsed.status === "accepted" && !child) {
    throw new NativeForkIntentError("intent_conflict", "An accepted native fork intent has no persisted child");
  }
  return {
    version: NATIVE_FORK_INTENT_VERSION,
    intentId: parsed.intentId,
    idempotencyKey: parsed.idempotencyKey,
    status: parsed.status as NativeForkIntentStatus,
    source: {
      orgId: source.orgId,
      sourceConversationId: optionalString(source.sourceConversationId),
      sourceRunId: source.sourceRunId,
      sourceSpanId: source.sourceSpanId,
      sourceBoundaryRef: source.sourceBoundaryRef,
    },
    target: {
      bindingId: target.bindingId,
      segmentId: target.segmentId,
      orgId: target.orgId,
      bindingEpoch: target.bindingEpoch,
      runtimeType: target.runtimeType,
      hostId: target.hostId,
      profileId: target.profileId,
      workspaceBindingId: optionalString(target.workspaceBindingId),
      capabilityRevision: target.capabilityRevision,
    },
    child,
    reason: parsed.reason as string | null,
    reconciliation: parsed.reconciliation as NativeForkReconciliation,
    reconciliationNote: parsed.reconciliationNote as string | null,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
}

/**
 * Read the host-owned fork intent without exposing the provider snapshot as a
 * lookup key. Callers use the returned identity to authorize an explicit
 * reconciliation against the same organization, binding, and segment.
 */
export function readNativeForkIntent(
  providerState: Record<string, unknown> | null | undefined,
): NativeForkIntentRecord | null {
  return intentFromProviderState(providerState);
}

function withIntent(state: Record<string, unknown> | null | undefined, intent: NativeForkIntentRecord) {
  return {
    ...cloneRecord(state),
    [NATIVE_FORK_INTENT_KEY]: intent,
  } satisfies Record<string, unknown>;
}

/**
 * Native fork intent is host-owned lineage metadata. Runtime execution may
 * return a fresh provider session snapshot, but replacing the segment state
 * must not erase the durable intent before admission/reconciliation finishes.
 * Preserve only this reserved key; the provider snapshot remains authoritative
 * for all other fields.
 */
export function preserveNativeForkIntentProviderState(
  previous: Record<string, unknown> | null | undefined,
  next: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const intent = record(previous)?.[NATIVE_FORK_INTENT_KEY];
  if (intent === undefined) return next ? { ...next } : null;
  return {
    ...cloneRecord(next),
    [NATIVE_FORK_INTENT_KEY]: intent,
  };
}

function normalizeSource(input: NativeForkIntentSource): NativeForkIntentSource {
  const orgId = requiredString(input.orgId, "source organization");
  const sourceConversationId = optionalString(input.sourceConversationId);
  return {
    orgId,
    sourceConversationId,
    sourceRunId: requiredString(input.sourceRunId, "source run"),
    sourceSpanId: requiredString(input.sourceSpanId, "source span"),
    sourceBoundaryRef: requiredString(input.sourceBoundaryRef, "source boundary"),
  };
}

function normalizeIdempotencyKey(value: string): string {
  const key = requiredString(value, "fork idempotency key");
  if (key.length > 512) throw new NativeForkIntentError("invalid_input", "Fork idempotency key is too long");
  return key;
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

async function assertSource(tx: Db, source: NativeForkIntentSource, targetRuntimeType: string) {
  const sourceRun = await tx
    .select({ id: heartbeatRuns.id, orgId: heartbeatRuns.orgId, status: heartbeatRuns.status, chatConversationId: heartbeatRuns.chatConversationId })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, source.sourceRunId), eq(heartbeatRuns.orgId, source.orgId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!sourceRun || sourceRun.status !== "succeeded") {
    throw new NativeForkIntentError("source_invalid", "Source run is missing or is not a completed run in the target organization");
  }
  if (source.sourceConversationId && sourceRun.chatConversationId !== source.sourceConversationId) {
    throw new NativeForkIntentError("source_invalid", "Source conversation does not own the source run");
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
  if (source.orgId !== input.targetBinding.orgId) {
    throw new NativeForkIntentError("source_invalid", "Source and target organizations must match");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`native-fork-intent:${input.targetBinding.id}:${input.targetSegment.id}`}, 0))`);
    const { binding, segment, target } = await loadTarget(tx as unknown as Db, input);
    await assertSource(tx as unknown as Db, source, target.runtimeType);
    const existing = intentFromProviderState(segment.providerStateJson);
    if (existing) {
      assertSameIntent(existing, { ...input, source, idempotencyKey }, target);
      if (existing.status === "reserved") {
        const now = new Date().toISOString();
        const unknown: NativeForkIntentRecord = {
          ...existing,
          status: "unknown",
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

async function persistChild(
  db: Db,
  reference: NativeForkIntentReference,
  child: NativeForkIntentChild,
  reconciliation: NativeForkReconciliation,
  reconciliationNote: string | null,
): Promise<NativeForkIntentOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`native-fork-intent:${reference.bindingId}:${reference.segmentId}`}, 0))`);
    const { segment, intent } = await loadIntentReference(tx as unknown as Db, reference);
    if (intent.status === "accepted" && intent.child) {
      const normalized = normalizeChild(child, intent.source.sourceBoundaryRef);
      if (JSON.stringify(normalized) !== JSON.stringify(intent.child)) {
        throw new NativeForkIntentError("intent_conflict", "A different child is already persisted for this native fork intent");
      }
      return intentResult(intent);
    }
    if (intent.status === "rejected") {
      throw new NativeForkIntentError("intent_conflict", "A rejected native fork intent cannot accept a child");
    }
    const normalized = normalizeChild(child, intent.source.sourceBoundaryRef);
    if (segment.nativeSessionId && segment.nativeSessionId !== normalized.session.sessionId) {
      throw new NativeForkIntentError("intent_conflict", "Target segment already contains a different provider child");
    }
    const now = new Date().toISOString();
    const accepted: NativeForkIntentRecord = {
      ...intent,
      status: "accepted",
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
    return intentResult(accepted);
  });
}

export async function persistNativeForkChild(
  db: Db,
  input: { reference: NativeForkIntentReference; child: NativeForkIntentChild },
): Promise<NativeForkIntentOutcome> {
  return persistChild(db, input.reference, input.child, "not_required", null);
}

export async function reconcileNativeForkIntent(
  db: Db,
  input: { reference: NativeForkIntentReference; child: NativeForkIntentChild; note?: string | null },
): Promise<NativeForkIntentOutcome> {
  return persistChild(db, input.reference, input.child, "resolved", input.note?.trim() || "Provider child reconciled before admission.");
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
  const outcome = intent.status === "accepted" && intent.child
    ? intentResult(intent)
    : await reconcileNativeForkIntent(db, {
      reference: referenceForIntent(intent),
      child: input.child,
      note: input.note,
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
    status: "unknown" | "rejected";
    reason: string;
    reconciliation: NativeForkReconciliation;
    reconciliationNote: string | null;
  },
): Promise<NativeForkIntentOutcome> {
  const reason = requiredString(input.reason, "fork intent reason");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`native-fork-intent:${input.reference.bindingId}:${input.reference.segmentId}`}, 0))`);
    const { segment, intent } = await loadIntentReference(tx as unknown as Db, input.reference);
    if (intent.status === "accepted") return intentResult(intent);
    if (intent.status === input.status) return intentResult(intent);
    if (intent.status !== "reserved") {
      throw new NativeForkIntentError("intent_conflict", "Native fork intent has already reached a terminal state");
    }
    const updatedIntent: NativeForkIntentRecord = {
      ...intent,
      status: input.status,
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
  input: { reference: NativeForkIntentReference; reason: string; reconciliation?: "provider_lookup_required" | "provider_lookup_unavailable"; note?: string | null },
): Promise<NativeForkIntentOutcome> {
  return updateIntentStatus(db, {
    reference: input.reference,
    status: "unknown",
    reason: input.reason,
    reconciliation: input.reconciliation ?? "provider_lookup_required",
    reconciliationNote: input.note?.trim() || "Do not retry the provider fork until its acceptance is reconciled.",
  });
}

export async function markNativeForkIntentRejected(
  db: Db,
  input: { reference: NativeForkIntentReference; reason: string },
): Promise<NativeForkIntentOutcome> {
  return updateIntentStatus(db, {
    reference: input.reference,
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
  const reservation = await reserveNativeForkIntent(input.db, input.intent);
  if (reservation.status !== "reserved") return reservation;
  let operation: Awaited<ReturnType<RuntimeDriver["fork"]>>;
  try {
    operation = await input.driver.fork({
      session: input.sourceSession,
      boundary: requiredString(input.boundary, "source boundary"),
      binding: input.providerBinding,
      signal: input.signal,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markNativeForkIntentUnknown(input.db, {
      reference: reservation.reference,
      reason: `Provider fork acceptance is unknown: ${reason}`,
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
      });
      throw new NativeForkAcceptanceUnknownError(reservation.reference, "Provider fork acceptance is unknown; automatic retry is disabled.");
    }
    await markNativeForkIntentRejected(input.db, { reference: reservation.reference, reason });
    throw new NativeForkIntentError("provider_rejected", `Provider-native fork ${operation.status}: ${reason}`);
  }
  try {
    return await persistNativeForkChild(input.db, {
      reference: reservation.reference,
      child: operation.value,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markNativeForkIntentUnknown(input.db, {
      reference: reservation.reference,
      reason: `Provider returned a child but durable child persistence failed: ${reason}`,
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
