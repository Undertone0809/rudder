import type { NativeSegmentRecord, RuntimeBindingRecord } from "./native-session.js";
import type { RuntimeProviderBindingRef, RuntimeProviderForkResult } from "./provider-capabilities.js";

export const NATIVE_FORK_INTENT_KEY = "__rudderNativeForkIntent";
export const NATIVE_FORK_INTENT_VERSION = 1 as const;

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

export type NativeForkIntentStoredSource = Omit<NativeForkIntentSource, "selectorJson"> & {
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

export type AbortReservedNativeForkIntentRunFenceInput = {
  reference: NativeForkIntentReference;
  runFence: NativeForkIntentRunFence;
  reason: string;
};

export type AbortReservedNativeForkIntentRunFenceOutcome = {
  reference: NativeForkIntentReference;
  intent: NativeForkIntentRecord;
  disposition: "aborted" | "already_unknown";
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

export type JsonRecord = Record<string, unknown>;

export function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NativeForkIntentError("invalid_input", `${label} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeRunFence(value: NativeForkIntentRunFence | null | undefined): NativeForkIntentRunFence | undefined {
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

export function sameRunSpan(left: NativeForkIntentRunFence, right: NativeForkIntentRunFence) {
  return left.runId === right.runId && left.spanId === right.spanId;
}

export function sameRunFence(left: NativeForkIntentRunFence, right: NativeForkIntentRunFence) {
  return sameRunSpan(left, right)
    && left.ownerToken === right.ownerToken
    && left.attemptEpoch === right.attemptEpoch;
}

export function normalizeNoChildProof(value: unknown): NativeForkIntentNoChildProof {
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

export function normalizeStoredFence(value: unknown): NativeForkIntentRunFence | null {
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

export function normalizeStoredFenceTransfer(value: unknown): NativeForkIntentRunFenceTransfer | null {
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

export function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return value ? { ...value } : {};
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export function normalizeSelectorJson(value: unknown): Record<string, unknown> {
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

export function selectorRuntimeType(value: Record<string, unknown>): string | null {
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

export function selectorSessionId(value: Record<string, unknown>): string | null {
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

export function cloneChild(child: NativeForkIntentChild): NativeForkIntentChild {
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

export function intentFromProviderState(value: unknown): NativeForkIntentRecord | null {
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

export function withIntent(state: Record<string, unknown> | null | undefined, intent: NativeForkIntentRecord) {
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

export function normalizeSource(input: NativeForkIntentSource): NativeForkIntentSource {
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

export function normalizeIdempotencyKey(value: string): string {
  const key = requiredString(value, "fork idempotency key");
  if (key.length > 512) throw new NativeForkIntentError("invalid_input", "Fork idempotency key is too long");
  return key;
}
