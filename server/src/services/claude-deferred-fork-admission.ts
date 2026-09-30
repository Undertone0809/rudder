import {
  verifyClaudeSessionAssistantHead,
  type ClaudeDeferredForkIntent,
  type ClaudeLocalProfileTransport,
} from "@rudderhq/agent-runtime-claude-local/server";
import type { AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { and, eq } from "drizzle-orm";
import { loadSideChatForkSource } from "./chat-assistant.side-chat-source.js";
import {
  markNativeForkIntentRejected,
  markNativeForkIntentUnknown,
  persistNativeForkChild,
  readNativeForkIntent,
  reserveNativeForkIntent,
  type NativeForkIntentRecord,
  type NativeForkIntentReference,
  type NativeForkIntentRunFence
} from "./runtime-kernel/native-fork-intent.js";
import {
  currentNativeSession,
  ensureRuntimeBinding
} from "./runtime-kernel/native-session.js";
import type { RuntimeProviderBindingRef } from "./runtime-kernel/provider-capabilities.js";
import type { SideChatForkSource, SideChatRuntimeAdmission } from "./side-chat-runtime-admission.js";

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

export class ClaudeDeferredForkRecoveryIdentityError extends Error {
  readonly code = "identity_mismatch" as const;

  constructor(message: string) {
    super(message);
    this.name = "ClaudeDeferredForkRecoveryIdentityError";
  }
}

function requireRecoveryIdentity(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ClaudeDeferredForkRecoveryIdentityError(message);
}

function parseDeferredForkDescriptor(value: unknown): ClaudeDeferredForkIntent {
  const descriptor = recordValue(value);
  const sourceSession = recordValue(descriptor?.sourceSession);
  const sourceSessionParams = recordValue(sourceSession?.sessionParams);
  const sourceSelector = recordValue(descriptor?.sourceSelector);
  const optionalSelectorString = (key: "boundaryStatus" | "ancestryRevision") => {
    const item = sourceSelector?.[key];
    return item === undefined || item === null || typeof item === "string";
  };
  requireRecoveryIdentity(
    descriptor?.version === 1
      && descriptor.kind === "claude_fork_on_first_input"
      && Boolean(stringValue(descriptor.sourceBindingId))
      && Boolean(stringValue(sourceSession?.sessionId))
      && Boolean(stringValue(sourceSession?.sessionDisplayId))
      && Boolean(sourceSessionParams)
      && sourceSelector?.kind === "claude_chain"
      && Boolean(stringValue(sourceSelector.sessionId))
      && Boolean(stringValue(sourceSelector.throughInclusiveUuid))
      && optionalSelectorString("boundaryStatus")
      && optionalSelectorString("ancestryRevision"),
    "Recovered Run has an invalid Claude deferred fork descriptor",
  );
  return descriptor as unknown as ClaudeDeferredForkIntent;
}

export type ClaudeDeferredForkRecoveryClassification =
  | {
    status: "descriptor_only";
    descriptor: ClaudeDeferredForkIntent;
    runFence: NativeForkIntentRunFence;
    idempotencyKey: string;
  }
  | {
    status: "accepted_child_open_span";
    descriptor: ClaudeDeferredForkIntent;
    intent: NativeForkIntentRecord;
    reference: NativeForkIntentReference;
    child: NonNullable<NativeForkIntentRecord["child"]>;
    runFence: NativeForkIntentRunFence;
    idempotencyKey: string;
    replayAllowed: false;
  }
  | {
    status: "reserved" | "unknown" | "rejected";
    descriptor: ClaudeDeferredForkIntent;
    intent: NativeForkIntentRecord;
    reference: NativeForkIntentReference;
    runFence: NativeForkIntentRunFence;
    idempotencyKey: string;
  };

export type ClaudeDeferredForkAdmission = {
  admission: SideChatRuntimeAdmission;
  adapterIntent: ClaudeDeferredForkIntent | null;
  reference: NativeForkIntentReference | null;
  reservation: Parameters<typeof reserveNativeForkIntent>[1] | null;
};

function handoff(source: SideChatForkSource, reason: string): ClaudeDeferredForkAdmission {
  return {
    admission: {
      continuity: "context_handoff",
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.sourceMessageId,
      sourceRunId: source.sourceRunId,
      sourceBoundaryRef: source.sourceBoundaryRef,
      sourceSpanId: source.sourceSpanId,
      providerCapability: { status: "unsupported", reason },
      downgradeReason: reason,
      session: null,
      sessionIntent: { kind: "fresh" },
    },
    adapterIntent: null,
    reference: null,
    reservation: null,
  };
}

export async function admitClaudeDeferredFork(input: {
  db: Db;
  source: SideChatForkSource;
  sourceBindingMatchesTarget: boolean;
  bindingInput: Parameters<typeof ensureRuntimeBinding>[1];
  providerBinding: RuntimeProviderBindingRef;
  config: Record<string, unknown>;
  conversationId: string;
}): Promise<ClaudeDeferredForkAdmission> {
  const { source, config } = input;
  const selector = source.selectorJson?.kind === "claude_chain" ? source.selectorJson : null;
  const sourceAssistantUuid = stringValue(selector?.throughInclusiveUuid);
  const sourceBindingId = stringValue(source.sourceBinding?.id);
  const boundaryStatus = selector && "boundaryStatus" in selector ? stringValue(selector.boundaryStatus) : null;
  if (!input.sourceBindingMatchesTarget || !source.sourceConversationId || !source.sourceMessageId
    || !source.sourceRunId || !source.sourceSpanId || !source.session || !source.sourceBinding || !sourceBindingId
    || !sourceAssistantUuid || source.sourceBoundaryRef !== sourceAssistantUuid
    || selector?.sessionId !== source.session.sessionId
    || boundaryStatus === "missing" || boundaryStatus === "unresolved") {
    return handoff(source, "claude_exact_source_boundary_unavailable");
  }
  const cwd = stringValue(config.cwd);
  const configDir = stringValue(config.claudeConfigDir);
  const providerVersion = stringValue(config.providerVersion ?? config.claudeProviderVersion);
  if (!cwd || !configDir || providerVersion !== "2.1.216") {
    return handoff(source, "claude_fork_profile_not_verified");
  }
  const profile: ClaudeLocalProfileTransport = {
    binding: source.sourceBinding,
    command: stringValue(config.command) ?? "claude",
    cwd,
    configDir,
    providerVersion,
  };
  const head = await verifyClaudeSessionAssistantHead({
    profile,
    binding: source.sourceBinding,
    session: source.session,
    sourceAssistantUuid,
  });
  if (head.status !== "matched") {
    return handoff(source, head.status === "mismatch"
      ? "claude_selected_reply_is_not_provider_head"
      : "claude_source_head_cannot_be_verified");
  }

  const targetBinding = await ensureRuntimeBinding(input.db, {
    ...input.bindingInput,
    continuity: "native",
    sourceBoundaryRef: sourceAssistantUuid,
  });
  const targetSession = await currentNativeSession(input.db, targetBinding);
  const reservation: Parameters<typeof reserveNativeForkIntent>[1] = {
    idempotencyKey: `side-chat:${input.conversationId}`,
    source: {
      orgId: input.bindingInput.orgId,
      sourceConversationId: source.sourceConversationId,
      sourceRunId: source.sourceRunId,
      sourceSpanId: source.sourceSpanId,
      sourceBoundaryRef: sourceAssistantUuid,
      selectorJson: selector as Record<string, unknown>,
    },
    targetBinding,
    targetSegment: targetSession.segment,
    providerBinding: { ...input.providerBinding, id: targetBinding.id },
  };
  return {
    admission: {
      continuity: "native",
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.sourceMessageId,
      sourceRunId: source.sourceRunId,
      sourceBoundaryRef: sourceAssistantUuid,
      sourceSpanId: source.sourceSpanId,
      providerCapability: { status: "supported", reason: "Claude first-input fork at a verified assistant head" },
      downgradeReason: null,
      session: null,
      sessionIntent: {
        kind: "fork",
        sourceRunId: source.sourceRunId,
        sourceBoundaryRef: sourceAssistantUuid,
        sessionId: null,
        sessionParams: null,
      },
    },
    adapterIntent: {
      version: 1,
      kind: "claude_fork_on_first_input",
      sourceBindingId,
      sourceSession: source.session,
      sourceSelector: {
        kind: "claude_chain",
        sessionId: source.session.sessionId,
        throughInclusiveUuid: sourceAssistantUuid,
        ...(boundaryStatus ? { boundaryStatus } : {}),
        ...(head.revision ? { ancestryRevision: head.revision } : {}),
      },
    },
    reference: null,
    reservation,
  };
}

export async function reserveClaudeDeferredFork(
  db: Db,
  reservation: NonNullable<ClaudeDeferredForkAdmission["reservation"]>,
  runFence: NativeForkIntentRunFence,
): Promise<NativeForkIntentReference> {
  const outcome = await reserveNativeForkIntent(db, { ...reservation, runFence });
  if (outcome.status !== "reserved") {
    throw new Error(`Claude deferred fork ${outcome.status}; reconciliation is required before retry`);
  }
  return outcome.reference;
}

export function assertClaudeDeferredForkReplaySafety(input: {
  providerState: Record<string, unknown> | null;
  firstSend: boolean;
  recoveringRun: boolean;
}): void {
  const intent = readNativeForkIntent(input.providerState);
  if (intent && !input.firstSend && (intent.status !== "accepted" || input.recoveringRun)) {
    throw new Error(`Claude Side Chat fork ${intent.status}; reconciliation is required before another input`);
  }
  if (!intent && input.recoveringRun) {
    throw new Error("Claude Side Chat fork has no durable result; recovery must reconcile before input replay");
  }
}

/**
 * Classifies a recovered deferred Claude fork from durable rows only.
 *
 * Recovery must first prove the exact source and target lineage captured by
 * the Run. An accepted child is terminal evidence for this Run, not permission
 * to send its user input again; this function therefore only returns data.
 */
export async function classifyClaudeDeferredForkRecovery(input: {
  db: Db;
  orgId: string;
  conversationId: string;
  runId: string;
  bindingId: string;
  segmentId: string;
  runFence: NativeForkIntentRunFence;
}): Promise<ClaudeDeferredForkRecoveryClassification> {
  const run = await input.db
    .select({
      id: heartbeatRuns.id,
      orgId: heartbeatRuns.orgId,
      agentId: heartbeatRuns.agentId,
      chatConversationId: heartbeatRuns.chatConversationId,
      status: heartbeatRuns.status,
      scene: heartbeatRuns.scene,
      targetType: heartbeatRuns.targetType,
      targetId: heartbeatRuns.targetId,
      executionOwnerToken: heartbeatRuns.executionOwnerToken,
      executionLeaseExpiresAt: heartbeatRuns.executionLeaseExpiresAt,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.orgId, input.orgId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  requireRecoveryIdentity(run, "Recovered Claude Side Chat Run was not found in this organization");
  requireRecoveryIdentity(
    run.chatConversationId === input.conversationId
      && (run.scene === "side_chat" || run.scene === "chat")
      && run.targetType === "chat_conversation"
      && run.targetId === input.conversationId
      && run.status === "running"
      && Boolean(stringValue(run.executionOwnerToken))
      && (!run.executionLeaseExpiresAt || run.executionLeaseExpiresAt.getTime() > Date.now()),
    "Recovered Run does not own an active Side Chat execution",
  );

  const binding = await input.db
    .select()
    .from(runtimeBindings)
    .where(and(
      eq(runtimeBindings.id, input.bindingId),
      eq(runtimeBindings.orgId, input.orgId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  requireRecoveryIdentity(
    binding
      && binding.conversationId === input.conversationId
      && binding.currentSegmentId === input.segmentId
      && binding.status === "active"
      && binding.continuity === "native"
      && binding.runtimeType === "claude_local",
    "Recovered Run binding is not the current Claude Side Chat binding",
  );

  const segment = await input.db
    .select()
    .from(nativeSegments)
    .where(and(
      eq(nativeSegments.id, input.segmentId),
      eq(nativeSegments.orgId, input.orgId),
      eq(nativeSegments.bindingId, input.bindingId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  requireRecoveryIdentity(
    segment
      && segment.runtimeType === "claude_local"
      && (segment.state === "pending" || segment.state === "open"),
    "Recovered Run segment is not a current Claude runtime segment",
  );

  const openSpans = await input.db
    .select({
      id: runRuntimeSpans.id,
      runId: runRuntimeSpans.runId,
      orgId: runRuntimeSpans.orgId,
      bindingId: runRuntimeSpans.bindingId,
      segmentId: runRuntimeSpans.segmentId,
      ownerToken: runRuntimeSpans.ownerToken,
      attemptEpoch: runRuntimeSpans.attemptEpoch,
      relation: runRuntimeSpans.relation,
      nativeExecutionRef: runRuntimeSpans.nativeExecutionRef,
      state: runRuntimeSpans.state,
    })
    .from(runRuntimeSpans)
    .where(and(
      eq(runRuntimeSpans.orgId, input.orgId),
      eq(runRuntimeSpans.runId, input.runId),
      eq(runRuntimeSpans.bindingId, input.bindingId),
      eq(runRuntimeSpans.segmentId, input.segmentId),
      eq(runRuntimeSpans.relation, "primary"),
      eq(runRuntimeSpans.state, "open"),
    ))
    .limit(2);
  requireRecoveryIdentity(openSpans.length === 1, "Recovered Run has no unique open primary Span for its current segment");
  const span = openSpans[0]!;
  requireRecoveryIdentity(
    span.runId === run.id
      && span.orgId === run.orgId
      && span.bindingId === binding.id
      && span.segmentId === segment.id
      && span.state === "open"
      && span.ownerToken === run.executionOwnerToken
      && span.attemptEpoch > 0,
    "Recovered Run Span owner or target identity does not match",
  );
  const runFence: NativeForkIntentRunFence = {
    runId: run.id,
    spanId: span.id,
    ownerToken: span.ownerToken,
    attemptEpoch: span.attemptEpoch,
  };
  requireRecoveryIdentity(
    input.runFence.runId === runFence.runId
      && input.runFence.spanId === runFence.spanId
      && input.runFence.ownerToken === runFence.ownerToken
      && input.runFence.attemptEpoch === runFence.attemptEpoch,
    "Recovered Run owner fence does not match the current Run and Span",
  );

  const context = recordValue(run.contextSnapshot);
  const sideChatAdmission = recordValue(context?.sideChatRuntimeAdmission);
  const descriptor = parseDeferredForkDescriptor(sideChatAdmission?.deferredForkDescriptor);
  const sourceConversationId = stringValue(sideChatAdmission?.sourceConversationId);
  const sourceRunId = stringValue(sideChatAdmission?.sourceRunId);
  const sourceSpanId = stringValue(sideChatAdmission?.sourceSpanId);
  const sourceBoundaryRef = stringValue(sideChatAdmission?.sourceBoundaryRef);
  const sourceSelector = recordValue(sideChatAdmission?.sourceSelectorJson);
  const snapshotSelector = recordValue(context?.sourceSelectorJson);
  requireRecoveryIdentity(
    (context?.scene === "side_chat" || context?.scene === "chat")
      && context.targetType === "chat_conversation"
      && context.targetId === input.conversationId
      && context.conversationId === input.conversationId
      && context.runtimeBindingId === binding.id
      && context.runtimeSegmentId === segment.id
      && sideChatAdmission?.continuity === "native"
      && Boolean(sourceConversationId)
      && Boolean(sourceRunId)
      && Boolean(sourceSpanId)
      && sourceBoundaryRef === descriptor.sourceSelector.throughInclusiveUuid
      && sourceSelector !== null
      && snapshotSelector !== null
      && stableJson(sourceSelector) === stableJson(snapshotSelector)
      && context.sourceRunId === sourceRunId
      && context.sourceSpanId === sourceSpanId,
    "Recovered Run deferred fork descriptor does not match its source metadata",
  );

  const sourceRun = await input.db
    .select({
      id: heartbeatRuns.id,
      orgId: heartbeatRuns.orgId,
      agentId: heartbeatRuns.agentId,
      chatConversationId: heartbeatRuns.chatConversationId,
      status: heartbeatRuns.status,
      sessionIdAfter: heartbeatRuns.sessionIdAfter,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, sourceRunId!),
      eq(heartbeatRuns.orgId, input.orgId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const retainedSource = sourceRun?.chatConversationId === null
    ? await loadSideChatForkSource(input.db, { id: input.conversationId, orgId: input.orgId,
      forkedFromConversationId: null, forkedFromMessageId: null }) : null;
  requireRecoveryIdentity(
    sourceRun
      && sourceRun.status === "succeeded"
      && (sourceRun.chatConversationId === sourceConversationId
        || (retainedSource?.sourceRunId === sourceRun.id && retainedSource.sourceConversationId === sourceConversationId
          && retainedSource.sourceSpanId === sourceSpanId)),
    "Deferred fork source Run no longer matches the persisted source conversation",
  );

  const sourceSpan = await input.db
    .select({
      id: runRuntimeSpans.id,
      orgId: runRuntimeSpans.orgId,
      runId: runRuntimeSpans.runId,
      bindingId: runRuntimeSpans.bindingId,
      segmentId: runRuntimeSpans.segmentId,
      nativeExecutionRef: runRuntimeSpans.nativeExecutionRef,
      selectorJson: runRuntimeSpans.selectorJson,
      state: runRuntimeSpans.state,
      completeness: runRuntimeSpans.completeness,
    })
    .from(runRuntimeSpans)
    .where(and(
      eq(runRuntimeSpans.id, sourceSpanId!),
      eq(runRuntimeSpans.orgId, input.orgId),
      eq(runRuntimeSpans.runId, sourceRun.id),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  requireRecoveryIdentity(
    sourceSpan
      && sourceSpan.state === "sealed"
      && sourceSpan.completeness === "complete"
      && sourceSpan.bindingId === descriptor.sourceBindingId
      && stableJson(sourceSpan.selectorJson) === stableJson(sourceSelector),
    "Deferred fork source Span or selector no longer matches the persisted Run descriptor",
  );

  const sourceSegment = await input.db
    .select({
      id: nativeSegments.id,
      orgId: nativeSegments.orgId,
      bindingId: nativeSegments.bindingId,
      runtimeType: nativeSegments.runtimeType,
      nativeSessionId: nativeSegments.nativeSessionId,
      leafId: nativeSegments.leafId,
      sourceBoundaryRef: nativeSegments.sourceBoundaryRef,
    })
    .from(nativeSegments)
    .where(and(
      eq(nativeSegments.id, sourceSpan.segmentId),
      eq(nativeSegments.orgId, input.orgId),
      eq(nativeSegments.bindingId, sourceSpan.bindingId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  requireRecoveryIdentity(
    sourceSegment
      && sourceSegment.runtimeType === "claude_local"
      && sourceSegment.nativeSessionId === descriptor.sourceSession.sessionId,
    "Deferred fork source session no longer matches its persisted source Segment",
  );

  const sourceBinding = await input.db
    .select({
      id: runtimeBindings.id,
      orgId: runtimeBindings.orgId,
      conversationId: runtimeBindings.conversationId,
      agentId: runtimeBindings.agentId,
      runtimeType: runtimeBindings.runtimeType,
    })
    .from(runtimeBindings)
    .where(and(
      eq(runtimeBindings.id, sourceSpan.bindingId),
      eq(runtimeBindings.orgId, input.orgId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const sourceProviderProfile = recordValue(recordValue(sourceRun.contextSnapshot)?.runtimeProviderProfile);
  const descriptorSelector = descriptor.sourceSelector as unknown as Record<string, unknown>;
  const persistedSelector = recordValue(sourceSpan.selectorJson);
  const sourceBoundary = stringValue(sourceSpan.nativeExecutionRef)
    ?? stringValue(sourceSegment.leafId)
    ?? stringValue(sourceSegment.sourceBoundaryRef);
  requireRecoveryIdentity(
    sourceBinding
      && (sourceBinding.conversationId === sourceConversationId
        || retainedSource?.sourceBinding?.id === sourceBinding.id)
      && sourceBinding.agentId === sourceRun.agentId
      && sourceBinding.runtimeType === "claude_local"
      && sourceProviderProfile?.runtimeType === "claude_local"
      && sourceBoundary === sourceBoundaryRef
      && descriptor.sourceSession.sessionId === sourceSegment.nativeSessionId
      && descriptor.sourceSession.sessionDisplayId === sourceSegment.nativeSessionId
      && (!sourceRun.sessionIdAfter || sourceRun.sessionIdAfter === sourceSegment.nativeSessionId)
      && sourceSelector?.kind === "claude_chain"
      && sourceSelector.sessionId === sourceSegment.nativeSessionId
      && descriptorSelector.kind === sourceSelector.kind
      && descriptorSelector.sessionId === sourceSelector.sessionId
      && descriptorSelector.throughInclusiveUuid === sourceBoundary
      && (descriptorSelector.boundaryStatus === undefined
        || descriptorSelector.boundaryStatus === sourceSelector.boundaryStatus)
      && (descriptorSelector.ancestryRevision === undefined
        || descriptorSelector.ancestryRevision === sourceSelector.ancestryRevision),
    "Deferred fork source Binding, session, or assistant boundary identity does not match",
  );

  let intent: NativeForkIntentRecord | null;
  try {
    intent = readNativeForkIntent(segment.providerStateJson);
  } catch (error) {
    throw new ClaudeDeferredForkRecoveryIdentityError(
      error instanceof Error ? error.message : "Target Segment contains an invalid native fork intent",
    );
  }
  const idempotencyKey = `side-chat:${input.conversationId}`;
  if (!intent) {
    const providerState = recordValue(segment.providerStateJson);
    requireRecoveryIdentity(
      segment.state === "pending"
        && segment.nativeSessionId == null
        && (segment.providerStateJson === null
          || (providerState !== null && Object.keys(providerState).length === 0))
        && !span.nativeExecutionRef,
      "Descriptor-only recovery requires a pristine pending Segment with no native child evidence",
    );
    return { status: "descriptor_only", descriptor, runFence, idempotencyKey };
  }

  requireRecoveryIdentity(
    intent.idempotencyKey === idempotencyKey
      && intent.target.orgId === input.orgId
      && intent.target.bindingId === binding.id
      && intent.target.segmentId === segment.id
      && intent.target.bindingEpoch === binding.bindingEpoch
      && intent.target.runtimeType === binding.runtimeType
      && intent.target.hostId === binding.hostId
      && intent.target.profileId === binding.profileId
      && intent.target.workspaceBindingId === binding.workspaceBindingId
      && intent.target.capabilityRevision === binding.capabilityRevision
      && intent.source.orgId === input.orgId
      && intent.source.sourceConversationId === sourceConversationId
      && intent.source.sourceRunId === sourceRunId
      && intent.source.sourceSpanId === sourceSpanId
      && intent.source.sourceBoundaryRef === sourceBoundaryRef
      && intent.source.selectorJson !== undefined
      && stableJson(intent.source.selectorJson) === stableJson(sourceSelector),
    "Native fork intent source or target identity does not match the recovered Run descriptor",
  );
  requireRecoveryIdentity(
    intent.runFence?.runId === run.id
      && intent.runFence.spanId === span.id
      && intent.runFence.attemptEpoch <= span.attemptEpoch,
    "Native fork intent is linked to a different Run or Span",
  );
  const reference: NativeForkIntentReference = {
    intentId: intent.intentId,
    orgId: input.orgId,
    bindingId: binding.id,
    segmentId: segment.id,
  };
  if (intent.status === "accepted") {
    const child = intent.child;
    requireRecoveryIdentity(
      child
        && child.continuity === "native"
        && Boolean(stringValue(child.session?.sessionId))
        && Boolean(stringValue(child.boundary))
        && child.sourceBoundary === sourceBoundaryRef
        && segment.state === "open"
        && segment.nativeSessionId === child.session.sessionId
        && span.nativeExecutionRef === child.boundary,
      "Accepted Claude fork child is not atomically bound to its open Run Span and Segment",
    );
    return {
      status: "accepted_child_open_span",
      descriptor,
      intent,
      reference,
      child,
      runFence,
      idempotencyKey,
      replayAllowed: false,
    };
  }

  requireRecoveryIdentity(!intent.child && !span.nativeExecutionRef, "Unaccepted Claude fork intent conflicts with persisted child evidence");
  return {
    status: intent.status,
    descriptor,
    intent,
    reference,
    runFence,
    idempotencyKey,
  };
}

export async function recordClaudeDeferredForkOutcome(input: {
  db: Db;
  reference: NativeForkIntentReference;
  runFence: NativeForkIntentRunFence;
  intent: ClaudeDeferredForkIntent;
  result: AgentRuntimeExecutionResult;
  providerTurnId: string | null;
}): Promise<AgentRuntimeExecutionResult> {
  const { db, reference, runFence, intent, result, providerTurnId } = input;
  if (result.errorCode === "claude_fork_boundary_rejected" && result.submissionPhase === "pre_submission") {
    await markNativeForkIntentRejected(db, {
      reference,
      runFence,
      reason: result.errorMessage ?? "Claude rejected the selected assistant head before submission",
    });
    return result;
  }
  if (result.submissionPhase === "accepted" && result.exitCode === 0 && !result.errorMessage
    && result.sessionId && result.sessionId !== intent.sourceSession.sessionId && providerTurnId
    && result.sessionParams) {
    try {
      await persistNativeForkChild(db, {
        reference,
        runFence,
        child: {
          session: {
            sessionId: result.sessionId,
            sessionDisplayId: result.sessionDisplayId ?? result.sessionId,
            sessionParams: { ...result.sessionParams, profileBindingId: reference.bindingId },
          },
          boundary: providerTurnId,
          sourceBoundary: intent.sourceSelector.throughInclusiveUuid,
          continuity: "native",
        },
      });
    } catch (error) {
      await markNativeForkIntentUnknown(db, {
        reference,
        runFence,
        reason: `Claude returned a child, but durable fork acceptance failed: ${error instanceof Error ? error.message : String(error)}`,
      }).catch(() => undefined);
      throw error;
    }
    return { ...result, sessionParams: { ...result.sessionParams, profileBindingId: reference.bindingId } };
  }
  await markNativeForkIntentUnknown(db, {
    reference,
    runFence,
    reason: result.errorMessage ?? "Claude first-input fork acceptance or child boundary is unknown",
  });
  // A reported child without terminal acceptance is evidence for reconciliation,
  // not authority to bind the target segment automatically.
  return { ...result, sessionId: null, sessionParams: null, sessionDisplayId: null };
}
