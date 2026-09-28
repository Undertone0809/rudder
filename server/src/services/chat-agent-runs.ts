import type { AgentRuntimeNetworkSuspension, TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import { chatMessages, goals, heartbeatRuns, runRuntimeSpans } from "@rudderhq/db";
import { toHeartbeatRun, type ChatConversation, type HeartbeatRun } from "@rudderhq/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AgentRuntimeInvocationMeta } from "../agent-runtimes/index.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { logger } from "../middleware/logger.js";
import { redactSensitiveText } from "../redaction.js";
import { getStorageService, type ContentAddressedStorageService } from "../storage/index.js";
import { retainNativeChatRunResultJson } from "./chat-run-result-retention.js";
import { summarizeHeartbeatRunResultJson } from "./heartbeat-run-summary.js";
import { publishLiveEvent } from "./live-events.js";
import { appendHeartbeatRunEvent } from "./run-events.js";
import {
  MAX_RUN_INSTRUCTION_SNAPSHOT_BYTES,
  storeRunInstructionSnapshot,
} from "./run-instruction-snapshots.js";
import { getRunLogStore } from "./run-log-store.js";
import {
  buildHeartbeatAdapterInvokePayload,
  networkWaitBackoffMs,
  sanitizeAgentInstructionStackForPersistence,
} from "./runtime-kernel/heartbeat.core.js";
import { registerLiveChatRunExecution } from "./runtime-kernel/heartbeat.js";
import {
  reconcileHeartbeatRunEvidence,
  RUN_EXECUTION_LEASE_RENEW_INTERVAL_MS,
} from "./runtime-kernel/heartbeat.terminal.js";
import { createHistoricalTranscriptReader } from "./runtime-kernel/historical-transcript-reader.js";
import {
  attachRuntimeSpanSupplement,
  type NativeSegmentRecord,
  type RuntimeBindingRecord,
} from "./runtime-kernel/native-session.js";
import {
  cleanSealedNativeTranscriptMirrors,
  markNativeTranscriptRetentionIncomplete,
  proveSealedNativeRunTranscript,
} from "./runtime-kernel/native-transcript-retention.js";
import { getTranscriptObjectStore, type TranscriptObjectHandle, type TranscriptObjectStore } from "./runtime-kernel/transcript-object-store.js";
import type { TranscriptReader } from "./runtime-kernel/transcript-reader.js";
import {
  createHeartbeatUnifiedAgentRunAdapter,
  type UnifiedAcceptanceReconciliationInput,
  type UnifiedAcceptanceUnknownInput,
  type UnifiedAgentRunAdapter,
  type UnifiedAttemptTerminalStatus,
  type UnifiedSpanSealInput,
} from "./runtime-kernel/unified-agent-run.integration.js";
import type {
  UnifiedAttemptFinishInput,
  UnifiedAttemptWaitingInput,
  UnifiedNativeExecutionInput,
  UnifiedOwnerFence,
  UnifiedRunTerminalInput,
  UnifiedSessionIntentInput,
  UnifiedSubmissionOutcome,
} from "./runtime-kernel/unified-agent-run.js";

const MAX_EVENT_TEXT_CHARS = 2_000;
const NATIVE_CHAT_TRANSCRIPT_RETENTION = {
  mode: "native",
  persistRawTranscript: false,
  reason: "native_transcript_capability",
} as const;
const ownedChatRuns = new Map<string, {
  fence: UnifiedOwnerFence;
  renewalTimer: ReturnType<typeof setInterval> | null;
  liveExecution: { controller: AbortController; release: () => void } | null;
}>();
const staleChatRunFences = new Set<string>();

type ChatRunFenceCarrier = Pick<typeof heartbeatRuns.$inferSelect, "id" | "orgId" | "agentId"> & {
  runtimeSpanId?: string | null;
  runtimeSpanOwnerToken?: string | null;
  runtimeSpanAttemptEpoch?: number | null;
  runtimeAttemptRef?: { id: string; attemptIndex: number } | null;
};

export type ChatRunTranscriptDeliveryInput = {
  source: "native" | "legacy";
  runId?: string;
  spanId: string | null;
};

function sameOwnerIdentity(left: UnifiedOwnerFence, right: UnifiedOwnerFence) {
  return left.ownerToken === right.ownerToken
    && left.attemptEpoch === right.attemptEpoch;
}

function sameAttemptRef(
  left: { id: string; attemptIndex: number } | null | undefined,
  right: { id: string; attemptIndex: number } | null | undefined,
) {
  return Boolean(left && right && left.id === right.id && left.attemptIndex === right.attemptIndex);
}

function cloneFence(fence: UnifiedOwnerFence): UnifiedOwnerFence {
  return { ...fence, leaseExpiresAt: new Date(fence.leaseExpiresAt) };
}

function fenceIdentityFromRun(run: ChatRunFenceCarrier) {
  const id = run.runtimeSpanId?.trim() || null;
  const ownerToken = run.runtimeSpanOwnerToken?.trim() || null;
  const attemptEpoch = run.runtimeSpanAttemptEpoch;
  if (!id || !ownerToken || !Number.isInteger(attemptEpoch) || (attemptEpoch as number) <= 0) return null;
  return { id, ownerToken, attemptEpoch: attemptEpoch as number };
}

function stopRenewingChatRun(runId: string, ownerToken: string) {
  const owned = ownedChatRuns.get(runId);
  if (!owned || owned.fence.ownerToken !== ownerToken || !owned.renewalTimer) return;
  clearInterval(owned.renewalTimer);
  owned.renewalTimer = null;
}

function stopOwningChatRun(runId: string, ownerToken?: string | null, abortExecution = true) {
  const owned = ownedChatRuns.get(runId);
  if (!owned || (ownerToken && owned.fence.ownerToken !== ownerToken)) return;
  if (owned.renewalTimer) clearInterval(owned.renewalTimer);
  if (abortExecution) owned.liveExecution?.controller.abort();
  ownedChatRuns.delete(runId);
}

type RuntimeSkillSummary = Array<{
  key: string;
  runtimeName?: string | null;
  name?: string | null;
  description?: string | null;
}>;

function boundedText(value: string | null | undefined, max = MAX_EVENT_TEXT_CHARS) {
  if (!value) return null;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function runtimeSkillsFromInvocationPayload(payload: Record<string, unknown>) {
  const desiredSkills = Array.isArray(payload.desiredSkills) ? payload.desiredSkills : [];
  return desiredSkills.flatMap((value) => {
    const skill = asRecord(value);
    const key = nonEmptyText(skill?.key);
    if (!key) return [];
    return [{
      key,
      runtimeName: nonEmptyText(skill?.runtimeName) ?? key,
      name: nonEmptyText(skill?.name),
      description: nonEmptyText(skill?.description),
    }];
  });
}

function compactNativeAdapterInvokePayload(payload: Record<string, unknown>) {
  return buildHeartbeatAdapterInvokePayload({
    meta: payload as unknown as AgentRuntimeInvocationMeta,
    runtimeSkills: runtimeSkillsFromInvocationPayload(payload),
    transcriptRetention: NATIVE_CHAT_TRANSCRIPT_RETENTION,
  });
}

function transcriptEventPayload(entry: TranscriptEntry): Record<string, unknown> {
  return entry as unknown as Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function normalizeSourceSpanInput(input: {
  sourceRunId?: string | null;
  sourceSpanId?: string | null;
  sourceSelectorJson?: Record<string, unknown> | null;
}) {
  const sourceRunId = input.sourceRunId?.trim() || null;
  const sourceSpanId = input.sourceSpanId?.trim() || null;
  const sourceSelectorJson = input.sourceSelectorJson
    ? { ...input.sourceSelectorJson }
    : null;
  if (!sourceRunId && !sourceSpanId && !sourceSelectorJson) return null;
  if (!sourceRunId || !sourceSpanId || !sourceSelectorJson) {
    throw new Error("Chat source span metadata requires sourceRunId, sourceSpanId, and sourceSelectorJson");
  }
  if (typeof sourceSelectorJson.kind !== "string" || sourceSelectorJson.kind.trim().length === 0) {
    throw new Error("Chat source span selectorJson.kind is required");
  }
  if (sourceSelectorJson.kind === "pending" || sourceSelectorJson.kind === "unresolved") {
    throw new Error("Chat source span selectorJson must identify a completed native boundary");
  }
  return { sourceRunId, sourceSpanId, sourceSelectorJson };
}

function serializeRun(row: typeof heartbeatRuns.$inferSelect): HeartbeatRun {
  return toHeartbeatRun({
    ...row,
    invocationSource: row.invocationSource as HeartbeatRun["invocationSource"],
    triggerDetail: row.triggerDetail as HeartbeatRun["triggerDetail"],
    status: row.status as HeartbeatRun["status"],
    contextSnapshot: row.contextSnapshot as HeartbeatRun["contextSnapshot"],
  });
}

export function chatAgentRunService(db: Db, options: {
  transcriptObjectStore?: TranscriptObjectStore;
  transcriptReaderFactory?: (database: Pick<Db, "select">) => TranscriptReader;
  instructionSnapshotStorage?: ContentAddressedStorageService;
  leaseRenewIntervalMs?: number;
} = {}) {
  const unifiedRunAdapter: UnifiedAgentRunAdapter = createHeartbeatUnifiedAgentRunAdapter(db);
  const transcriptObjectStore = options.transcriptObjectStore ?? getTranscriptObjectStore();
  const transcriptSupplements = new Map<string, Promise<TranscriptObjectHandle>>();

  async function appendNativeSupplement(run: ChatRunFenceCarrier, entry: TranscriptEntry) {
    const identity = fenceIdentityFromRun(run);
    if (!identity) throw new Error("Native transcript requires an immutable span owner");
    // A recovery fences the same span with a new owner/epoch. Keep the object
    // lineage keyed by span, not by the transient owner identity.
    const key = `${run.id}:${identity.id}`;
    let pending = transcriptSupplements.get(key);
    if (!pending) {
      pending = (async () => {
        const current = await immutableFenceForRun(run);
        if (!current) throw new Error("Native transcript span owner is stale");
        const span = await db
          .select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
          .from(runRuntimeSpans)
          .where(and(
            eq(runRuntimeSpans.orgId, run.orgId),
            eq(runRuntimeSpans.runId, run.id),
            eq(runRuntimeSpans.id, identity.id),
            eq(runRuntimeSpans.ownerToken, identity.ownerToken),
            eq(runRuntimeSpans.attemptEpoch, identity.attemptEpoch),
            eq(runRuntimeSpans.state, "open"),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!span) throw new Error("Native transcript span owner is stale");
        const existingObjectRef = span.supplementalObjectRef?.trim() || null;
        if (existingObjectRef) {
          // The ref is authoritative once attached. Resume that object under
          // the current fenced owner; never replace it with a new ref.
          return transcriptObjectStore.resume({
            objectRef: existingObjectRef,
            orgId: run.orgId,
            runId: run.id,
            spanId: identity.id,
            ownerToken: identity.ownerToken,
          });
        }
        const handle = await transcriptObjectStore.begin({
          orgId: run.orgId, runId: run.id, spanId: identity.id, ownerToken: identity.ownerToken,
        });
        // Re-read after allocation so a recovery/service instance that won the
        // attach race is reused rather than overwritten.
        const attachedRef = await db
          .select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
          .from(runRuntimeSpans)
          .where(and(
            eq(runRuntimeSpans.orgId, run.orgId),
            eq(runRuntimeSpans.runId, run.id),
            eq(runRuntimeSpans.id, identity.id),
            eq(runRuntimeSpans.ownerToken, identity.ownerToken),
            eq(runRuntimeSpans.attemptEpoch, identity.attemptEpoch),
            eq(runRuntimeSpans.state, "open"),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (attachedRef?.supplementalObjectRef?.trim()) {
          return transcriptObjectStore.resume({
            objectRef: attachedRef.supplementalObjectRef,
            orgId: run.orgId,
            runId: run.id,
            spanId: identity.id,
            ownerToken: identity.ownerToken,
          });
        }
        const attached = await attachRuntimeSpanSupplement(db, {
          orgId: run.orgId, runId: run.id, spanId: identity.id,
          ownerToken: identity.ownerToken, attemptEpoch: identity.attemptEpoch,
          objectRef: handle.objectRef,
        });
        if (!attached) throw new Error("Native transcript supplement lost its span owner");
        if (attached.supplementalObjectRef && attached.supplementalObjectRef !== handle.objectRef) {
          return transcriptObjectStore.resume({
            objectRef: attached.supplementalObjectRef,
            orgId: run.orgId, runId: run.id, spanId: identity.id, ownerToken: identity.ownerToken,
          });
        }
        return handle;
      })().catch((error) => {
        transcriptSupplements.delete(key);
        throw error;
      });
      transcriptSupplements.set(key, pending);
    }
    const handle = await pending;
    if (!await immutableFenceForRun(run)) throw new Error("Native transcript span owner is stale");
    await transcriptObjectStore.append(handle, entry);
  }

  async function sealNativeSupplements(runId: string) {
    for (const [key, pending] of transcriptSupplements) {
      if (!key.startsWith(`${runId}:`)) continue;
      try {
        const handle = await pending;
        await transcriptObjectStore.finalize(handle, { completeness: "partial" });
        if (transcriptSupplements.get(key) === pending) transcriptSupplements.delete(key);
      } catch {
        // The object remains open and therefore readable as partial. A failed
        // supplement seal must never prevent the runtime's terminal outcome or
        // evidence from being persisted.
      }
    }
  }

  function trackOwnedRun(runId: string, fence: UnifiedOwnerFence) {
    if (ownedChatRuns.get(runId)?.liveExecution) {
      ownedChatRuns.get(runId)?.liveExecution?.controller.abort();
      throw new Error(`Chat Run ${runId} cannot replace a live execution owner`);
    }
    stopOwningChatRun(runId);
    staleChatRunFences.delete(runId);
    const owned: NonNullable<ReturnType<typeof ownedChatRuns.get>> = {
      fence: { ...fence, leaseExpiresAt: new Date(fence.leaseExpiresAt) },
      renewalTimer: null,
      liveExecution: null,
    };
    owned.renewalTimer = setInterval(() => {
      const current = ownedChatRuns.get(runId);
      if (!current || current !== owned) return;
      void Promise.resolve(unifiedRunAdapter.renewOwner(runId, current.fence)).then((renewed) => {
        if (!renewed.ok) {
          stopRenewingChatRun(runId, current.fence.ownerToken);
          noteStaleFence(runId);
          return;
        }
        const latest = ownedChatRuns.get(runId);
        if (latest === owned) latest.fence = renewed.value;
      }).catch(() => {
        stopRenewingChatRun(runId, current.fence.ownerToken);
        noteStaleFence(runId);
      });
    }, options.leaseRenewIntervalMs ?? RUN_EXECUTION_LEASE_RENEW_INTERVAL_MS);
    owned.renewalTimer.unref?.();
    ownedChatRuns.set(runId, owned);
  }

  function noteStaleFence(runId: string) {
    staleChatRunFences.add(runId);
    ownedChatRuns.get(runId)?.liveExecution?.controller.abort();
  }

  function beginOwnedRunExecution(run: ChatRunFenceCarrier) {
    const owned = ownedChatRuns.get(run.id);
    const identity = fenceIdentityFromRun(run);
    if (!owned || !identity || identity.ownerToken !== owned.fence.ownerToken
      || identity.attemptEpoch !== owned.fence.attemptEpoch || owned.liveExecution) {
      throw new Error(`Chat Run ${run.id} has no available live execution owner`);
    }
    const controller = new AbortController();
    const releaseRegistration = registerLiveChatRunExecution(run.id, owned.fence.ownerToken, controller);
    const liveExecution = { controller, release: releaseRegistration };
    owned.liveExecution = liveExecution;
    if (staleChatRunFences.has(run.id)) controller.abort();
    let released = false;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        liveExecution.release();
        if (owned.liveExecution === liveExecution) owned.liveExecution = null;
      },
    };
  }

  function trackedFenceForRun(runId: string): UnifiedOwnerFence | null {
    const owned = ownedChatRuns.get(runId);
    return owned ? cloneFence(owned.fence) : null;
  }

  function noteFenceResult(runId: string, result: { ok: true } | { ok: false; reason: string }) {
    if (!result.ok && (result.reason === "stale_owner" || result.reason === "lease_expired")) {
      noteStaleFence(runId);
    }
  }

  async function immutableFenceForRun(
    run: ChatRunFenceCarrier,
    options: { requireAttempt?: boolean } = {},
  ): Promise<{ entry: Awaited<ReturnType<UnifiedAgentRunAdapter["get"]>>; fence: UnifiedOwnerFence } | null> {
    const entry = await unifiedRunAdapter.get(run.id);
    const identity = fenceIdentityFromRun(run);
    if (!entry || !identity) return null;
    const presentedFence: UnifiedOwnerFence = {
      ...identity,
      leaseExpiresAt: entry.ownerFence.leaseExpiresAt,
    };
    if (!sameOwnerIdentity(presentedFence, entry.ownerFence)) {
      noteStaleFence(run.id);
      return null;
    }
    if (presentedFence.id !== entry.span.id) return null;
    const owned = ownedChatRuns.get(run.id);
    if (owned && !sameOwnerIdentity(presentedFence, owned.fence)) {
      noteStaleFence(run.id);
      return null;
    }
    if (options.requireAttempt !== false && !sameAttemptRef(run.runtimeAttemptRef, entry.attempt.ref)) {
      return null;
    }
    return {
      entry,
      fence: {
        ...presentedFence,
        leaseExpiresAt: new Date(owned?.fence.leaseExpiresAt ?? entry.ownerFence.leaseExpiresAt),
      },
    };
  }

  async function appendEvent(
    run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "orgId" | "agentId">,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      message?: string;
      payload?: Record<string, unknown>;
    },
    options: { allowUnowned?: boolean } = {},
  ) {
    const owned = ownedChatRuns.get(run.id);
    if (owned && !options.allowUnowned) {
      const renewed = await unifiedRunAdapter.renewOwner(run.id, owned.fence);
      if (!renewed.ok) {
        noteFenceResult(run.id, renewed);
        throw new Error("Chat run owner lease was lost before appending an event");
      }
      const latest = ownedChatRuns.get(run.id);
      if (latest === owned) latest.fence = renewed.value;
    }
    const message = boundedText(event.message, 500);
    const inserted = await appendHeartbeatRunEvent(db, {
      orgId: run.orgId,
      runId: run.id,
      agentId: run.agentId,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      message,
      payload: event.payload,
    });

    publishLiveEvent({
      orgId: run.orgId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq: inserted.seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        message,
        payload: event.payload ?? null,
      },
    });
  }

  function transcriptReaderFor(database: Pick<Db, "select">) {
    return options.transcriptReaderFactory?.(database)
      ?? createHistoricalTranscriptReader(database, { includeObjects: false });
  }

  async function finalNativeTranscriptProof(
    runId: string,
    delivery: ChatRunTranscriptDeliveryInput | undefined,
    fence: UnifiedOwnerFence | null,
    status: "succeeded" | "failed" | "cancelled" | "timed_out",
    attemptId: string | null,
  ) {
    const spanId = delivery?.spanId?.trim() || fence?.id || null;
    if (delivery?.runId && delivery.runId !== runId) {
      return { ok: false as const, reason: "transcript_delivery_run_mismatch" };
    }
    if (!fence || !spanId || fence.id !== spanId) {
      return { ok: false as const, reason: "transcript_delivery_span_mismatch" };
    }
    if (status !== "succeeded") return { ok: false as const, reason: "transcript_run_not_successful" };
    if (!attemptId) return { ok: false as const, reason: "native_attempt_identity_missing" };
    const [run] = await db.select({ orgId: heartbeatRuns.orgId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1);
    if (!run) return { ok: false as const, reason: "transcript_run_missing" };
    return proveSealedNativeRunTranscript({
      db,
      reader: transcriptReaderFor(db),
      orgId: run.orgId,
      runId,
      expectedOwner: { spanId, ownerToken: fence.ownerToken, attemptEpoch: fence.attemptEpoch, attemptId },
    });
  }

  async function createRun(input: {
    conversation: Pick<ChatConversation, "id" | "orgId" | "primaryIssueId" | "planMode">;
    agentId: string;
    triggerDetail: "chat_assistant_reply" | "chat_assistant_reply_stream";
    userMessageId?: string | null;
    chatTurnId?: string | null;
    turnVariant?: number | null;
    linkedIssueIds: string[];
    linkedProjectId: string | null;
    linkedGoalId?: string | null;
    runContext?: Record<string, unknown> | null;
    sourceMetadata?: Record<string, unknown> | null;
    runtimeBinding?: RuntimeBindingRecord | null;
    runtimeSegment?: NativeSegmentRecord | null;
    nativeSessionId?: string | null;
    nativeSessionParams?: Record<string, unknown> | null;
    inputCorrelationRef?: string | null;
    runtimeModel?: string | null;
    runtimeResumeSource?: "fresh" | "same_session" | "pristine_replay";
    scene?: "chat" | "side_chat";
    idempotencyKey?: string | null;
    sessionIntent?: UnifiedSessionIntentInput;
    sourceRunId?: string | null;
    sourceSpanId?: string | null;
    sourceSelectorJson?: Record<string, unknown> | null;
  }) {
    const linkedGoalId = input.linkedGoalId ?? null;
    if (linkedGoalId) {
      const [goal] = await db
        .select({ id: goals.id })
        .from(goals)
        .where(and(eq(goals.id, linkedGoalId), eq(goals.orgId, input.conversation.orgId)))
        .limit(1);
      if (!goal) {
        throw new Error("Chat conversation Goal must belong to the same organization");
      }
    }
    const now = new Date();
    const scene = input.scene ?? "chat";
    const sourceSpan = normalizeSourceSpanInput(input);
    if (sourceSpan) {
      const sourceRun = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.id, sourceSpan.sourceRunId),
          eq(heartbeatRuns.orgId, input.conversation.orgId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!sourceRun || sourceRun.status !== "succeeded") {
        throw new Error("Chat source run is missing or is not a completed run in the target organization");
      }
      const persistedSpan = await db
        .select({ state: runRuntimeSpans.state, completeness: runRuntimeSpans.completeness, selectorJson: runRuntimeSpans.selectorJson })
        .from(runRuntimeSpans)
        .where(and(
          eq(runRuntimeSpans.id, sourceSpan.sourceSpanId),
          eq(runRuntimeSpans.orgId, input.conversation.orgId),
          eq(runRuntimeSpans.runId, sourceSpan.sourceRunId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!persistedSpan || persistedSpan.state !== "sealed" || persistedSpan.completeness !== "complete") {
        throw new Error("Chat source span is not a complete sealed boundary");
      }
      if (stableJson(persistedSpan.selectorJson) !== stableJson(sourceSpan.sourceSelectorJson)) {
        throw new Error("Chat source span selectorJson does not match the persisted native span selector");
      }
    }
    const idempotencyKey = input.idempotencyKey?.trim()
      || input.inputCorrelationRef?.trim()
      || input.userMessageId?.trim()
      || input.chatTurnId?.trim()
      || `chat:${input.conversation.id}:${randomUUID()}`;
    const sessionIntent: UnifiedSessionIntentInput = input.sessionIntent ?? (
      input.nativeSessionId || input.nativeSessionParams
        ? {
          kind: "resume",
          reuseScope: "explicit",
          sourceRunId: null,
          sessionId: input.nativeSessionId ?? null,
          sessionParams: input.nativeSessionParams ?? null,
        }
        : { kind: "fresh" }
    );
    const issueId = input.conversation.primaryIssueId ?? input.linkedIssueIds[0] ?? null;
    const linkedIssueIds = [...new Set([issueId, ...input.linkedIssueIds].filter((value): value is string => Boolean(value)))];
    const contextSnapshot = {
      scene,
      targetType: "chat_conversation",
      targetId: input.conversation.id,
      conversationId: input.conversation.id,
      messageId: input.userMessageId ?? null,
      userMessageId: input.userMessageId ?? null,
      chatTurnId: input.chatTurnId ?? null,
      turnVariant: input.turnVariant ?? 0,
      issueId,
      linkedIssueIds,
      projectId: input.linkedProjectId,
      planMode: input.conversation.planMode,
      stream: input.triggerDetail === "chat_assistant_reply_stream",
      controlIntent: "new",
      ...(input.runtimeBinding ? { runtimeBindingId: input.runtimeBinding.id } : {}),
      ...(input.runtimeSegment ? { runtimeSegmentId: input.runtimeSegment.id } : {}),
      ...(input.inputCorrelationRef ? { inputCorrelationRef: input.inputCorrelationRef } : {}),
      ...(input.sourceMetadata ?? {}),
      ...(input.runContext ?? {}),
      ...(sourceSpan
        ? {
          sourceRunId: sourceSpan.sourceRunId,
          sourceSpanId: sourceSpan.sourceSpanId,
          sourceSelectorJson: sourceSpan.sourceSelectorJson,
        }
        : {}),
      // The explicit column is authoritative; keep the compatibility snapshot
      // aligned even when runtime context contains a stale Goal value.
      goalId: linkedGoalId,
    };
    if (!input.runtimeBinding) {
      throw new Error("Chat runs require a durable runtime binding before admission");
    }
    let admitted;
    try {
      admitted = await unifiedRunAdapter.admit({
        orgId: input.conversation.orgId,
        agentId: input.agentId,
        scene,
        target: { type: "chat_conversation", id: input.conversation.id },
        idempotencyKey,
        runtimeType: input.runtimeBinding.runtimeType,
        runtimeBindingId: input.runtimeBinding.id,
        runtimeSegmentId: input.runtimeSegment?.id ?? null,
        model: input.runtimeModel ?? null,
        sessionIntent,
        contextSnapshot,
        attempt: {
          attemptIndex: 0,
          fallbackIndex: null,
          isFallback: false,
          resumeSource: input.runtimeResumeSource ?? (input.nativeSessionId ? "same_session" : "fresh"),
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("active heartbeat run")) {
        throw new Error("A chat assistant run is already active for this conversation");
      }
      throw error;
    }
    if (!admitted.created) {
      throw new Error(`A Chat run is already admitted for idempotency key ${idempotencyKey}`);
    }
    const admittedRow = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, admitted.entry.runId),
        eq(heartbeatRuns.orgId, input.conversation.orgId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!admittedRow) throw new Error(`Unified Chat Run ${admitted.entry.runId} disappeared after admission`);
    const [run] = await db
      .update(heartbeatRuns)
      .set({
        triggerDetail: input.triggerDetail,
        goalId: linkedGoalId,
        sessionIdBefore: input.nativeSessionId ?? admittedRow.sessionIdBefore,
        sessionParamsBeforeJson: input.nativeSessionParams ?? admittedRow.sessionParamsBeforeJson,
        contextSnapshot: {
          ...((admittedRow.contextSnapshot ?? {}) as Record<string, unknown>),
          ...contextSnapshot,
        },
        updatedAt: now,
      })
      .where(and(
        eq(heartbeatRuns.id, admitted.entry.runId),
        eq(heartbeatRuns.orgId, input.conversation.orgId),
      ))
      .returning();
    if (!run) throw new Error(`Unified Chat Run ${admitted.entry.runId} could not be enriched`);
    trackOwnedRun(run.id, admitted.entry.ownerFence);

    publishLiveEvent({
      orgId: run.orgId,
      type: "heartbeat.run.status",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        status: run.status,
      },
    });
    await appendEvent(run, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "chat run started",
      payload: { scene, conversationId: input.conversation.id },
    });
    return {
      ...serializeRun(run),
      runtimeSpanId: admitted.entry.span.id,
      runtimeSpanOwnerToken: admitted.entry.ownerFence.ownerToken,
      runtimeSpanAttemptEpoch: admitted.entry.ownerFence.attemptEpoch,
      runtimeAttemptRef: admitted.entry.attempt.ref,
      unifiedAdmission: true,
    };
  }

  /**
   * Reattach the in-process lease to a Chat run claimed by the durable
   * heartbeat recovery coordinator. The coordinator already fenced the row;
   * this method only restores the renewal timer without creating a duplicate
   * active Chat run.
   */
  async function adoptRecoveredRun(
    runId: string,
    ownerToken: string,
  ) {
    const entry = await unifiedRunAdapter.get(runId);
    if (
      !entry
      || entry.status !== "running"
      || !["chat", "side_chat"].includes(entry.scene)
      || entry.ownerFence.ownerToken !== ownerToken
    ) return null;
    const renewed = await unifiedRunAdapter.renewOwner(runId, entry.ownerFence);
    if (!renewed.ok) return null;
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.status, "running"),
        eq(heartbeatRuns.invocationSource, "chat"),
        eq(heartbeatRuns.executionOwnerToken, ownerToken),
      ))
      .then((rows) => rows[0] ?? null);
    if (!run) return null;

    trackOwnedRun(runId, renewed.value);
    const existingSpan = await db
      .select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
      .from(runRuntimeSpans)
      .where(and(
        eq(runRuntimeSpans.orgId, run.orgId),
        eq(runRuntimeSpans.runId, runId),
        eq(runRuntimeSpans.id, entry.span.id),
        eq(runRuntimeSpans.ownerToken, renewed.value.ownerToken),
        eq(runRuntimeSpans.attemptEpoch, renewed.value.attemptEpoch),
        eq(runRuntimeSpans.state, "open"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const existingObjectRef = existingSpan?.supplementalObjectRef?.trim() || null;
    if (existingObjectRef) {
      const key = `${runId}:${entry.span.id}`;
      let pending = transcriptSupplements.get(key);
      if (!pending) {
        pending = transcriptObjectStore.resume({
          objectRef: existingObjectRef,
          orgId: run.orgId,
          runId,
          spanId: entry.span.id,
          ownerToken: renewed.value.ownerToken,
        }).catch((error) => {
          if (transcriptSupplements.get(key) === pending) transcriptSupplements.delete(key);
          throw error;
        });
        transcriptSupplements.set(key, pending);
      }
      // Recovery remains viable if a non-authoritative supplement is missing;
      // append will retry the same ref and will never allocate a replacement.
      await pending.catch(() => undefined);
    }
    return {
      ...serializeRun(run),
      // Kept internal to the server-owned recovery path; public run serializers
      // intentionally do not expose session parameters.
      sessionParamsBeforeJson: run.sessionParamsBeforeJson ?? null,
      runtimeSpanId: entry.span.id,
      runtimeSpanOwnerToken: renewed.value.ownerToken,
      runtimeSpanAttemptEpoch: renewed.value.attemptEpoch,
      runtimeAttemptRef: entry.attempt.ref,
      unifiedAdmission: true,
    };
  }

  function releaseOwnedRun(runId: string, ownerToken?: string | null) {
    stopOwningChatRun(runId, ownerToken);
  }

  async function appendAdapterInvoke(
    run: ChatRunFenceCarrier,
    meta: AgentRuntimeInvocationMeta,
    runtimeSkills: RuntimeSkillSummary,
  ) {
    // Persist the full audit row before execution can suspend or lose its process.
    // Successful native finalization rewrites this same event after source proof.
    const payload = buildHeartbeatAdapterInvokePayload({
      meta,
      runtimeSkills: runtimeSkills.map((entry) => ({
        key: entry.key,
        runtimeName: entry.runtimeName ?? entry.key,
        name: entry.name ?? null,
        description: entry.description ?? null,
      })),
    });
    const invocationSpanId = run.runtimeSpanId?.trim() || null;
    const invocationAttemptId = run.runtimeAttemptRef?.id?.trim() || null;
    payload.invocationSpanId = invocationSpanId;
    payload.invocationAttemptId = invocationAttemptId;

    const instructionStack = sanitizeAgentInstructionStackForPersistence(meta);
    const instructionBytes = typeof instructionStack === "string"
      ? Buffer.byteLength(instructionStack, "utf8")
      : 0;
    if (!instructionStack || instructionBytes === 0) {
      payload.invocationInstructionSnapshot = { status: "unavailable", reason: "instructions_not_reported" };
    } else if (!invocationAttemptId || !invocationSpanId) {
      payload.invocationInstructionSnapshot = { status: "unavailable", reason: "run_linkage_unavailable" };
    } else if (instructionBytes > MAX_RUN_INSTRUCTION_SNAPSHOT_BYTES) {
      payload.invocationInstructionSnapshot = { status: "unavailable", reason: "size_limit" };
    } else {
      try {
        const stored = await storeRunInstructionSnapshot({
          storage: options.instructionSnapshotStorage ?? getStorageService(),
          orgId: run.orgId,
          text: redactCurrentUserText(redactSensitiveText(instructionStack)),
        });
        payload.invocationInstructionSnapshot = { status: "available", ...stored };
      } catch {
        payload.invocationInstructionSnapshot = { status: "unavailable", reason: "storage_unavailable" };
        logger.warn(
          { orgId: run.orgId, agentId: run.agentId, runId: run.id },
          "could not persist Chat invocation instruction snapshot",
        );
      }
    }

    await appendEvent(run, {
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "adapter invocation",
      payload,
    });
  }

  async function appendTranscriptEntry(
    run: ChatRunFenceCarrier,
    entry: TranscriptEntry,
    options: { persistRaw?: boolean; persistSupplement?: boolean; spanId?: string | null } = {},
  ) {
    if (options.persistRaw === false) {
      // Keep one object supplement only until the profile-bound native range
      // capability has been proven. A capable provider is the sole durable
      // transcript source.
      if (options.persistSupplement !== false) await appendNativeSupplement(run, entry);
      // Native providers remain the durable transcript source. This event is a
      // live projection only; the payload is intentionally not written to the
      // heartbeat event ledger and is therefore not a second raw transcript.
      publishLiveEvent({
        orgId: run.orgId,
        type: "heartbeat.run.event",
        payload: {
          runId: run.id,
          agentId: run.agentId,
          seq: null,
          eventType: "transcript.entry",
          stream: entry.kind === "stderr" ? "stderr" : entry.kind === "stdout" ? "stdout" : "system",
          level: entry.kind === "stderr" ? "warn" : "info",
          message: "native transcript projection",
          payload: {
            source: "native",
            spanId: options.spanId ?? null,
            entry,
          },
        },
      });
      return;
    }
    const spanId = options.spanId?.trim() || run.runtimeSpanId?.trim() || null;
    const attemptId = run.runtimeAttemptRef?.id?.trim() || null;
    await appendEvent(run, {
      eventType: "transcript.entry",
      stream: entry.kind === "stderr" ? "stderr" : entry.kind === "stdout" ? "stdout" : "system",
      level: entry.kind === "stderr" ? "warn" : "info",
      message: "chat transcript entry",
      payload: {
        ...transcriptEventPayload(entry),
        ...(spanId ? { spanId } : {}),
        ...(attemptId ? { attemptId } : {}),
      },
    });
  }

  async function markLegacyTranscriptSource(run: ChatRunFenceCarrier) {
    const identity = fenceIdentityFromRun(run);
    if (!identity || staleChatRunFences.has(run.id)) return false;
    const [updated] = await db.update(heartbeatRuns)
      .set({
        contextSnapshot: sql`jsonb_set(coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb), '{transcriptSource}', '"legacy"'::jsonb)`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.orgId, run.orgId),
        eq(heartbeatRuns.executionOwnerToken, identity.ownerToken),
        eq(heartbeatRuns.status, "running"),
        sql`exists (select 1 from ${runRuntimeSpans} where ${runRuntimeSpans.id} = ${identity.id} and ${runRuntimeSpans.ownerToken} = ${identity.ownerToken} and ${runRuntimeSpans.attemptEpoch} = ${identity.attemptEpoch})`,
      ))
      .returning({ id: heartbeatRuns.id });
    return Boolean(updated);
  }

  async function recordNativeExecutionResult(
    runId: string,
    result: UnifiedNativeExecutionInput["result"],
    input: {
      orgId: string;
      ownerToken: string;
      spanId?: string | null;
      attemptId?: string | null;
      attemptEpoch?: number;
      error?: boolean;
      suspended?: boolean;
      visibilityCutoffRef?: string | null;
    },
  ) {
    const entry = await unifiedRunAdapter.get(runId);
    const spanId = input.spanId?.trim() || null;
    const attemptId = input.attemptId?.trim() || entry?.attempt.ref.id || null;
    if (
      !entry
      || entry.orgId !== input.orgId
      || !spanId
      || !attemptId
      || attemptId !== entry.attempt.ref.id
      || !input.ownerToken?.trim()
      || !Number.isInteger(input.attemptEpoch)
      || (input.attemptEpoch as number) <= 0
    ) return null;
    const fence: UnifiedOwnerFence = {
      id: spanId,
      ownerToken: input.ownerToken.trim(),
      attemptEpoch: input.attemptEpoch as number,
      leaseExpiresAt: entry.ownerFence.leaseExpiresAt,
    };
    if (!sameOwnerIdentity(fence, entry.ownerFence) || fence.id !== entry.span.id) {
      if (!sameOwnerIdentity(fence, entry.ownerFence)) noteStaleFence(runId);
      return null;
    }
    const recorded = await unifiedRunAdapter.recordExecutionResult(runId, {
      ...fence,
    }, {
      spanId,
      attemptId,
      result,
      error: input.error,
      suspended: input.suspended,
      visibilityCutoffRef: input.visibilityCutoffRef,
    });
    noteFenceResult(runId, recorded);
    return recorded.ok ? recorded.value : null;
  }

  async function beginRuntimeAttempt(
    run: ChatRunFenceCarrier,
    input: {
      attemptIndex: number;
      fallbackIndex: number | null;
      runtimeType: string;
      model: string | null;
      isFallback: boolean;
      resumeSource: "fresh" | "same_session" | "pristine_replay";
    },
  ) {
    const current = await immutableFenceForRun(run);
    if (!current) throw new Error(`Unified Chat Run ${run.id} has no current immutable owner/attempt fence`);
    const begun = await unifiedRunAdapter.beginAttempt(run.id, current.fence, input);
    noteFenceResult(run.id, begun);
    if (!begun.ok) throw new Error(`Unified Chat Run ${run.id} attempt admission rejected: ${begun.reason}`);
    const latest = await unifiedRunAdapter.get(run.id);
    if (latest) {
      if (!sameOwnerIdentity(current.fence, latest.ownerFence)) {
        noteStaleFence(run.id);
        throw new Error(`Unified Chat Run ${run.id} attempt admission lost its owner fence`);
      }
      run.runtimeSpanId = latest.span.id;
      run.runtimeAttemptRef = latest.attempt.ref;
      const owned = ownedChatRuns.get(run.id);
      if (owned && sameOwnerIdentity(owned.fence, latest.ownerFence)) {
        owned.fence = {
          ...owned.fence,
          id: latest.span.id,
        };
      }
    }
    return begun.value.ref;
  }

  async function markRuntimeAttemptWaiting(
    run: ChatRunFenceCarrier,
    input: UnifiedAttemptWaitingInput,
  ) {
    const current = await immutableFenceForRun(run);
    if (!current) throw new Error(`Unified Chat Run ${run.id} has no current immutable owner/attempt fence`);
    if (input.submissionPhase === "indeterminate") {
      const unknown = await unifiedRunAdapter.markAcceptanceUnknown(run.id, current.fence, {
        phase: input.submissionPhase,
        providerThreadId: input.providerThreadId,
        providerTurnId: input.providerTurnId,
        reason: input.error,
      });
      noteFenceResult(run.id, unknown);
      if (!unknown.ok) throw new Error(`Unified Chat Run ${run.id} submission admission rejected: ${unknown.reason}`);
    }
    const waiting = await unifiedRunAdapter.markAttemptWaiting(run.id, current.fence, input);
    noteFenceResult(run.id, waiting);
    if (!waiting.ok) throw new Error(`Unified Chat Run ${run.id} attempt wait rejected: ${waiting.reason}`);
    return waiting.value;
  }

  async function finishRuntimeAttempt(
    run: ChatRunFenceCarrier,
    input: UnifiedAttemptFinishInput & { status: UnifiedAttemptTerminalStatus },
  ) {
    const current = await immutableFenceForRun(run);
    if (!current) throw new Error(`Unified Chat Run ${run.id} has no current immutable owner/attempt fence`);
    const { status, ...metadata } = input;
    if (input.submissionPhase === "pre_submission") {
      const rejected = await unifiedRunAdapter.reconcileAcceptance(run.id, current.fence, {
        state: "rejected",
        providerThreadId: input.providerThreadId,
        providerTurnId: input.providerTurnId,
        reason: input.error ?? "runtime finished before provider submission",
      });
      noteFenceResult(run.id, rejected);
      if (!rejected.ok) throw new Error(`Unified Chat Run ${run.id} submission admission rejected: ${rejected.reason}`);
    } else if (input.submissionPhase === "accepted") {
      const accepted = await unifiedRunAdapter.acceptSubmission(run.id, current.fence, {
        providerThreadId: input.providerThreadId,
        providerTurnId: input.providerTurnId,
      });
      noteFenceResult(run.id, accepted);
      if (!accepted.ok) throw new Error(`Unified Chat Run ${run.id} submission admission rejected: ${accepted.reason}`);
    } else if (input.submissionPhase === "indeterminate") {
      const unknown = await unifiedRunAdapter.markAcceptanceUnknown(run.id, current.fence, {
        phase: input.submissionPhase,
        providerThreadId: input.providerThreadId,
        providerTurnId: input.providerTurnId,
        reason: input.error,
      });
      noteFenceResult(run.id, unknown);
      if (!unknown.ok) throw new Error(`Unified Chat Run ${run.id} submission admission rejected: ${unknown.reason}`);
    }
    const finished = await unifiedRunAdapter.finishAttempt(run.id, current.fence, status, metadata);
    noteFenceResult(run.id, finished);
    if (!finished.ok) throw new Error(`Unified Chat Run ${run.id} attempt finish rejected: ${finished.reason}`);
    return finished.value;
  }

  async function acceptSubmission(
    run: ChatRunFenceCarrier,
    input: UnifiedSubmissionOutcome = {},
  ) {
    const current = await immutableFenceForRun(run);
    if (!current) return null;
    const accepted = await unifiedRunAdapter.acceptSubmission(run.id, current.fence, input);
    noteFenceResult(run.id, accepted);
    return accepted.ok ? accepted.value : null;
  }

  async function markAcceptanceUnknown(
    run: ChatRunFenceCarrier,
    input: UnifiedAcceptanceUnknownInput = {},
  ) {
    const current = await immutableFenceForRun(run);
    if (!current) return null;
    const unknown = await unifiedRunAdapter.markAcceptanceUnknown(run.id, current.fence, input);
    noteFenceResult(run.id, unknown);
    return unknown.ok ? unknown.value : null;
  }

  async function reconcileAcceptance(
    run: ChatRunFenceCarrier,
    input: UnifiedAcceptanceReconciliationInput,
  ) {
    const current = await immutableFenceForRun(run);
    if (!current) return null;
    const reconciled = await unifiedRunAdapter.reconcileAcceptance(run.id, current.fence, input);
    noteFenceResult(run.id, reconciled);
    return reconciled.ok ? reconciled.value : null;
  }

  async function sealSpan(
    run: ChatRunFenceCarrier,
    input: UnifiedSpanSealInput,
  ) {
    const current = await immutableFenceForRun(run);
    if (!current) return null;
    const sealed = await unifiedRunAdapter.sealSpan(run.id, current.fence, input);
    noteFenceResult(run.id, sealed);
    return sealed.ok ? sealed.value : null;
  }

  /**
   * Record a durable, non-terminal provider transport interruption. The run
   * remains owned by the recovery coordinator; this event is deliberately
   * informational so it never enters failed-run or terminal-effect paths.
   */
  async function markWaitingForNetwork(
    run: ChatRunFenceCarrier,
    suspension: AgentRuntimeNetworkSuspension,
    ownerToken: string,
  ) {
    const currentFence = await immutableFenceForRun(run);
    if (!currentFence || currentFence.fence.ownerToken !== ownerToken) {
      noteStaleFence(run.id);
      throw new Error(`Unified Chat Run ${run.id} has no current immutable owner/attempt fence`);
    }
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${run.id}))`);
      const current = await tx
        .select({
          networkWaitAttemptCount: heartbeatRuns.networkWaitAttemptCount,
          executionLeaseExpiresAt: heartbeatRuns.executionLeaseExpiresAt,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.orgId, run.orgId),
          eq(heartbeatRuns.status, "running"),
          eq(heartbeatRuns.executionOwnerToken, ownerToken),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!current || (current.executionLeaseExpiresAt && current.executionLeaseExpiresAt.getTime() <= now.getTime())) {
        return null;
      }
      const activeSpan = await tx
        .select({ id: runRuntimeSpans.id })
        .from(runRuntimeSpans)
        .where(and(
          eq(runRuntimeSpans.id, currentFence.fence.id),
          eq(runRuntimeSpans.orgId, run.orgId),
          eq(runRuntimeSpans.runId, run.id),
          eq(runRuntimeSpans.ownerToken, currentFence.fence.ownerToken),
          eq(runRuntimeSpans.attemptEpoch, currentFence.fence.attemptEpoch),
          eq(runRuntimeSpans.state, "open"),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!activeSpan) return null;
      const attempt = current.networkWaitAttemptCount + 1;
      const backoff = networkWaitBackoffMs(attempt);
      const nextRetryAt = new Date(now.getTime() + backoff);
      const [updated] = await tx
        .update(heartbeatRuns)
        .set({
          runningSubstate: "waiting_for_network",
          networkWaitStartedAt: now,
          networkWaitNextRetryAt: nextRetryAt,
          networkWaitAttemptCount: attempt,
          recoveryCheckpoint: { ...suspension, observedAt: now.toISOString() },
          sessionIdBefore: suspension.sessionId ?? null,
          sessionParamsBeforeJson: suspension.sessionParams ?? null,
          sessionReuseScope: suspension.sessionId || suspension.sessionParams ? "explicit" : "none",
          processExitedAt: now,
          processPid: null,
          processStartedAt: null,
          executionOwnerToken: null,
          executionLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.orgId, run.orgId),
          eq(heartbeatRuns.status, "running"),
          eq(heartbeatRuns.executionOwnerToken, ownerToken),
        ))
        .returning({ id: heartbeatRuns.id });
      return updated ? { attempt, nextRetryAt } : null;
    });
    if (!result) throw new Error("Chat run owner lease was lost before network wait was recorded");
    await appendEvent(run, {
      eventType: "network.waiting",
      stream: "system",
      level: "info",
      message: "chat run waiting for network",
      payload: {
        kind: suspension.kind,
        code: suspension.code,
        transport: suspension.transport,
        provider: suspension.provider ?? null,
        model: suspension.model ?? null,
        submissionPhase: suspension.submissionPhase,
        continuation: suspension.continuation,
        progress: suspension.progress,
        attempt: result.attempt,
        nextRetryAt: result.nextRetryAt.toISOString(),
      },
    }, { allowUnowned: true });
  }

  async function linkAssistantMessage(runId: string, conversationId: string, messageId: string) {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) return null;

    const [message] = await db
      .update(chatMessages)
      .set({ runId, updatedAt: new Date() })
      .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.id, messageId)))
      .returning();
    if (!message) return null;

    const contextSnapshot = {
      ...((run.contextSnapshot ?? {}) as Record<string, unknown>),
      assistantMessageId: messageId,
      messageId,
    };
    const [updated] = await db
      .update(heartbeatRuns)
      .set({ contextSnapshot, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning();
    const nextRun = updated ?? run;

    await appendEvent(nextRun, {
      eventType: "chat.message_linked",
      stream: "system",
      level: "info",
      message: "assistant message linked",
      payload: {
        conversationId,
        assistantMessageId: messageId,
      },
    });
    return message ?? null;
  }

  async function finalizeRun(
    runId: string,
    input: UnifiedRunTerminalInput & {
      status: "succeeded" | "failed" | "cancelled" | "timed_out";
      transcriptDelivery?: ChatRunTranscriptDeliveryInput;
    },
  ) {
    const fence = staleChatRunFences.has(runId) ? null : trackedFenceForRun(runId);
    const [runIdentity] = await db.select({ orgId: heartbeatRuns.orgId })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
    const [spanIdentity] = fence
      ? await db.select({ attemptId: runRuntimeSpans.attemptId }).from(runRuntimeSpans).where(and(
        eq(runRuntimeSpans.orgId, runIdentity?.orgId ?? ""),
        eq(runRuntimeSpans.runId, runId),
        eq(runRuntimeSpans.id, fence.id),
        eq(runRuntimeSpans.ownerToken, fence.ownerToken),
        eq(runRuntimeSpans.attemptEpoch, fence.attemptEpoch),
      )).limit(1)
      : [];
    const currentAttemptId = spanIdentity?.attemptId ?? null;
    const resultJson = input.resultJson ?? null;
    const evidence = {
      resultJson,
      resultSummaryJson: summarizeHeartbeatRunResultJson(resultJson),
      usageJson: input.usageJson ?? null,
    };
    const reconciliationEvidence = {
      resultJson: input.resultJson ?? null,
      resultSummaryJson: summarizeHeartbeatRunResultJson(input.resultJson),
      usageJson: input.usageJson ?? null,
    };
    const { transcriptDelivery: _transcriptDelivery, ...terminalInput } = input;
    const terminal = fence
      ? await unifiedRunAdapter.finishRun(runId, fence, input.status, {
          ...terminalInput,
          ...evidence,
          terminalEffectsPending: input.terminalEffectsPending ?? false,
          processExitedAt: input.processExitedAt !== undefined ? input.processExitedAt : new Date(),
        })
      : { ok: false as const, reason: "run_not_found" as const };
    noteFenceResult(runId, terminal);
    if (!terminal.ok) {
      stopOwningChatRun(runId, fence?.ownerToken);
      await reconcileHeartbeatRunEvidence(db, runId, reconciliationEvidence);
      return db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ? serializeRun(rows[0]) : null);
    }
    // Seal only after this owner successfully commits the runtime terminal
    // transition. A stale recovery caller must not seal the current owner's
    // open supplement before its own terminal write is rejected.
    await sealNativeSupplements(runId);
    if (fence) {
      const expectedOwner = {
        spanId: fence.id,
        ownerToken: fence.ownerToken,
        attemptEpoch: fence.attemptEpoch,
        attemptId: currentAttemptId ?? "",
      };
      const delivery = input.transcriptDelivery ?? {
        source: "legacy" as const,
        runId,
        spanId: fence.id,
      };
      let proofResult: Awaited<ReturnType<typeof finalNativeTranscriptProof>>;
      try {
        proofResult = await finalNativeTranscriptProof(
          runId,
          delivery,
          fence,
          input.status,
          currentAttemptId,
        );
      } catch (error) {
        proofResult = {
          ok: false,
          reason: error instanceof Error ? error.message : "native_range_read_failed",
        };
      }
      if (proofResult.ok) {
        const cleanup = await cleanSealedNativeTranscriptMirrors({
          db,
          proof: proofResult.proof,
          runLogStore: getRunLogStore(),
          transcriptObjectStore,
          readerFactory: transcriptReaderFor,
          retainResultJson: retainNativeChatRunResultJson,
          compactAdapterInvokePayload: compactNativeAdapterInvokePayload,
        });
        if (!cleanup.cleaned) {
          await markNativeTranscriptRetentionIncomplete({
            db,
            orgId: runIdentity?.orgId ?? "",
            runId,
            expectedOwner,
            status: "cleanup_failed",
            reason: cleanup.reason,
            recovery: cleanup.recovery,
          }).catch(() => undefined);
        }
      } else {
        await markNativeTranscriptRetentionIncomplete({
          db,
          orgId: runIdentity?.orgId ?? "",
          runId,
          reason: proofResult.reason,
        }).catch(() => undefined);
      }
    }
    stopOwningChatRun(runId, fence?.ownerToken, false);
    const updated = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;
    staleChatRunFences.delete(runId);

    publishLiveEvent({
      orgId: updated.orgId,
      type: "heartbeat.run.status",
      payload: {
        runId: updated.id,
        agentId: updated.agentId,
        status: updated.status,
      },
    });
    await appendEvent(updated, {
      eventType: "lifecycle",
      stream: "system",
      level: input.status === "succeeded" ? "info" : input.status === "cancelled" ? "warn" : "error",
      message: `chat run ${input.status}`,
      payload: {
        status: input.status,
        errorCode: input.errorCode ?? null,
      },
    });
    return serializeRun(updated);
  }

  async function finalizeStaleRuns(input: {
    conversationId?: string | null;
    olderThanMs?: number;
    error?: string;
    errorCode?: string;
    now?: Date;
    recoveryCutoff?: Date;
  } = {}) {
    const olderThanMs = input.olderThanMs ?? 30 * 60_000;
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - olderThanMs);
    const recoveryCutoff = input.recoveryCutoff ?? now;
    const conditions = [
      sql`${heartbeatRuns.chatConversationId} is not null`,
      inArray(heartbeatRuns.status, ["queued", "running"]),
      sql`${heartbeatRuns.updatedAt} < ${cutoff.toISOString()}::timestamptz`,
      sql`${heartbeatRuns.createdAt} < ${recoveryCutoff.toISOString()}::timestamptz`,
    ];
    if (input.conversationId) {
      conditions.push(eq(heartbeatRuns.chatConversationId, input.conversationId));
    }
    const staleRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.updatedAt));
    let finalized = 0;
    for (const run of staleRuns) {
      const claim = await unifiedRunAdapter.claimOwner(run.id);
      noteFenceResult(run.id, claim);
      if (!claim.ok) continue;
      const terminal = await unifiedRunAdapter.finishRun(run.id, claim.value, "timed_out", {
        error: input.error ?? "Chat run execution lease expired",
        errorCode: input.errorCode ?? "chat_run_stale",
        terminalEffectsPending: false,
        processExitedAt: null,
      });
      noteFenceResult(run.id, terminal);
      if (terminal.ok) {
        finalized += 1;
        stopOwningChatRun(run.id, claim.value.ownerToken);
        await sealNativeSupplements(run.id);
        await markNativeTranscriptRetentionIncomplete({
          db,
          orgId: run.orgId,
          runId: run.id,
          reason: "chat_run_stale_terminal_without_reader_proof",
        }).catch(() => undefined);
      }
    }
    return finalized;
  }

  return {
    beginOwnedRunExecution,
    appendAdapterInvoke,
    appendEvent,
    appendTranscriptEntry,
    markLegacyTranscriptSource,
    beginRuntimeAttempt,
    markRuntimeAttemptWaiting,
    finishRuntimeAttempt,
    acceptSubmission,
    markAcceptanceUnknown,
    reconcileAcceptance,
    sealSpan,
    recordNativeExecutionResult,
    createRun,
    adoptRecoveredRun,
    releaseOwnedRun,
    finalizeRun,
    finalizeStaleRuns,
    linkAssistantMessage,
    markWaitingForNetwork,
  };
}
