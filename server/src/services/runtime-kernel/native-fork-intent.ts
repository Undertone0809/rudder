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
  RuntimeProviderForkResult,
  RuntimeProviderSessionRef,
} from "./provider-capabilities.js";
import type { RuntimeDriver } from "./runtime-driver.js";
import { lockRuntimeRetentionScope } from "./runtime-retention.js";

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
  selectorJson: Record<string, unknown>;
};

type NativeForkIntentStoredSource = Omit<NativeForkIntentSource, "selectorJson"> & {
  selectorJson?: Record<string, unknown>;
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

export type NativeForkIntentRunFence = {
  runId: string;
  spanId: string;
  ownerToken: string;
  attemptEpoch: number;
};

export type NativeForkIntentNoChildProof = {
  version: 1;
  kind: "driver_not_dispatched";
  providerDispatched: false;
  writerQuiescence: { status: "confirmed"; source: "not_started" };
};

export type NativeForkIntentRunFenceTransfer = {
  version: 1;
  oldAttemptId: string;
  oldFence: NativeForkIntentRunFence;
  newFence: NativeForkIntentRunFence;
  noChildProof: NativeForkIntentNoChildProof;
};

export type NativeForkIntentRecord = {
  version: typeof NATIVE_FORK_INTENT_VERSION;
  intentId: string;
  idempotencyKey: string;
  status: NativeForkIntentStatus;
  source: NativeForkIntentStoredSource;
  target: NativeForkIntentTarget;
  runFence?: NativeForkIntentRunFence;
  runFenceTransfers?: NativeForkIntentRunFenceTransfer[];
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
  source: NativeForkIntentStoredSource;
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
  runFence?: NativeForkIntentRunFence | null;
};

export type TransferReservedNativeForkIntentRunFenceInput = {
  reference: NativeForkIntentReference;
  idempotencyKey: string;
  oldAttemptId: string;
  oldFence: NativeForkIntentRunFence;
  newFence: NativeForkIntentRunFence;
  noChildProof: NativeForkIntentNoChildProof;
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
      | "child_invalid"
      | "run_fence_stale",
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

function normalizeRunFence(value: NativeForkIntentRunFence | null | undefined): NativeForkIntentRunFence | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value.attemptEpoch) || value.attemptEpoch <= 0) {
    throw new NativeForkIntentError("invalid_input", "Run fence attemptEpoch must be a positive integer");
  }
  return {
    runId: requiredString(value.runId, "Run fence runId"),
    spanId: requiredString(value.spanId, "Run fence spanId"),
    ownerToken: requiredString(value.ownerToken, "Run fence ownerToken"),
    attemptEpoch: value.attemptEpoch,
  };
}

function sameRunSpan(left: NativeForkIntentRunFence, right: NativeForkIntentRunFence) {
  return left.runId === right.runId && left.spanId === right.spanId;
}

function sameRunFence(left: NativeForkIntentRunFence, right: NativeForkIntentRunFence) {
  return sameRunSpan(left, right)
    && left.ownerToken === right.ownerToken
    && left.attemptEpoch === right.attemptEpoch;
}

function normalizeNoChildProof(value: unknown): NativeForkIntentNoChildProof {
  const proof = record(value);
  const quiescence = record(proof?.writerQuiescence);
  if (
    proof?.version !== 1
    || proof.kind !== "driver_not_dispatched"
    || proof.providerDispatched !== false
    || quiescence?.status !== "confirmed"
    || quiescence.source !== "not_started"
  ) {
    throw new NativeForkIntentError(
      "run_fence_stale",
      "Native fork Run fence transfer requires confirmed driver-not-dispatched proof",
    );
  }
  return {
    version: 1,
    kind: "driver_not_dispatched",
    providerDispatched: false,
    writerQuiescence: { status: "confirmed", source: "not_started" },
  };
}

function normalizeStoredFence(value: unknown): NativeForkIntentRunFence | null {
  const candidate = record(value);
  if (
    !candidate
    || typeof candidate.runId !== "string"
    || typeof candidate.spanId !== "string"
    || typeof candidate.ownerToken !== "string"
    || !Number.isInteger(candidate.attemptEpoch)
    || (candidate.attemptEpoch as number) <= 0
  ) return null;
  return {
    runId: candidate.runId,
    spanId: candidate.spanId,
    ownerToken: candidate.ownerToken,
    attemptEpoch: candidate.attemptEpoch as number,
  };
}

function normalizeStoredFenceTransfer(value: unknown): NativeForkIntentRunFenceTransfer | null {
  const transfer = record(value);
  const oldFence = normalizeStoredFence(transfer?.oldFence);
  const newFence = normalizeStoredFence(transfer?.newFence);
  const proof = record(transfer?.noChildProof);
  if (
    transfer?.version !== 1
    || typeof transfer.oldAttemptId !== "string"
    || !oldFence
    || !newFence
    || proof?.version !== 1
    || proof.kind !== "driver_not_dispatched"
    || proof.providerDispatched !== false
    || record(proof.writerQuiescence)?.status !== "confirmed"
    || record(proof.writerQuiescence)?.source !== "not_started"
  ) return null;
  return {
    version: 1,
    oldAttemptId: transfer.oldAttemptId,
    oldFence,
    newFence,
    noChildProof: normalizeNoChildProof(proof),
  };
}

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return value ? { ...value } : {};
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function normalizeSelectorJson(value: unknown): Record<string, unknown> {
  const selector = record(value);
  if (!selector) {
    throw new NativeForkIntentError("invalid_input", "source selectorJson must be an object");
  }
  const kind = requiredString(selector.kind, "source selector kind");
  if (kind === "pending" || kind === "unresolved") {
    throw new NativeForkIntentError("invalid_input", "source selectorJson must identify a completed native boundary");
  }
  return { ...selector, kind };
}

function selectorRuntimeType(value: Record<string, unknown>): string | null {
  const declared = optionalString(value.runtimeType);
  if (declared) return declared;
  switch (value.kind) {
    case "codex_turn": return "codex_local";
    case "claude_chain": return "claude_local";
    case "hermes_execution": return "hermes_gateway";
    case "opencode_input": return "opencode_local";
    case "pi_branch_range": return "pi_local";
    case "cursor_execution": return "cursor";
    default: return null;
  }
}

function selectorSessionId(value: Record<string, unknown>): string | null {
  switch (value.kind) {
    case "codex_turn":
      return optionalString(value.threadId);
    case "claude_chain":
    case "opencode_input":
    case "cursor_execution":
      return optionalString(value.sessionId);
    case "hermes_execution":
      return optionalString(value.sessionRef);
    case "pi_branch_range":
      return optionalString(value.sessionResourceRef);
    default:
      return null;
  }
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
  const sourceSelector = source.selectorJson === undefined || source.selectorJson === null
    ? null
    : record(source.selectorJson);
  if (
    typeof source.orgId !== "string"
    || typeof source.sourceRunId !== "string"
    || typeof source.sourceSpanId !== "string"
    || typeof source.sourceBoundaryRef !== "string"
    || (source.selectorJson !== undefined && source.selectorJson !== null
      && (!sourceSelector || typeof sourceSelector.kind !== "string" || sourceSelector.kind.trim().length === 0))
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
  let runFence: NativeForkIntentRunFence | undefined;
  if (parsed.runFence !== undefined && parsed.runFence !== null) {
    const rawFence = record(parsed.runFence);
    if (
      !rawFence
      || typeof rawFence.runId !== "string"
      || typeof rawFence.spanId !== "string"
      || typeof rawFence.ownerToken !== "string"
      || !Number.isInteger(rawFence.attemptEpoch)
      || (rawFence.attemptEpoch as number) <= 0
    ) {
      throw new NativeForkIntentError("intent_conflict", "The target segment contains an invalid native fork Run fence");
    }
    runFence = {
      runId: rawFence.runId,
      spanId: rawFence.spanId,
      ownerToken: rawFence.ownerToken,
      attemptEpoch: rawFence.attemptEpoch as number,
    };
  }
  let runFenceTransfers: NativeForkIntentRunFenceTransfer[] | undefined;
  if (parsed.runFenceTransfers !== undefined) {
    if (!Array.isArray(parsed.runFenceTransfers)) {
      throw new NativeForkIntentError("intent_conflict", "The target segment contains invalid native fork Run fence transfer history");
    }
    const transfers = parsed.runFenceTransfers.map(normalizeStoredFenceTransfer);
    if (transfers.some((transfer) => transfer === null)) {
      throw new NativeForkIntentError("intent_conflict", "The target segment contains invalid native fork Run fence transfer proof");
    }
    runFenceTransfers = transfers.filter((transfer): transfer is NativeForkIntentRunFenceTransfer => transfer !== null);
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
      ...(sourceSelector ? { selectorJson: { ...sourceSelector } } : {}),
    },
    ...(runFence ? { runFence } : {}),
    ...(runFenceTransfers === undefined ? {} : { runFenceTransfers }),
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
    selectorJson: normalizeSelectorJson(input.selectorJson),
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
