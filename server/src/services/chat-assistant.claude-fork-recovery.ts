import type { AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import { heartbeatRuns, nativeSegments, runRuntimeSpans, type Db } from "@rudderhq/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { chatAgentRunService } from "./chat-agent-runs.js";
import { ChatAssistantStreamError } from "./chat-assistant.contracts.js";
import {
  admitClaudeDeferredFork,
  assertClaudeDeferredForkReplaySafety,
  classifyClaudeDeferredForkRecovery,
  type ClaudeDeferredForkAdmission,
} from "./claude-deferred-fork-admission.js";
import type { NativeForkIntentRunFence } from "./runtime-kernel/native-fork-intent.js";
import { readNativeForkIntent, type NativeForkIntentChild } from "./runtime-kernel/native-fork-intent.js";
import type { RuntimeBindingRecord } from "./runtime-kernel/native-session.js";

type ChatRuns = ReturnType<typeof chatAgentRunService>;
type OwnedRun = Parameters<ChatRuns["finishRuntimeAttempt"]>[0] & {
  runtimeSpanId?: string | null;
  runtimeSpanOwnerToken?: string | null;
  runtimeSpanAttemptEpoch?: number | null;
};

export async function canRestartPristineClaudeFork(input: {
  db: Db;
  binding: RuntimeBindingRecord | null;
  runtimeType: string;
  orgId: string;
  conversationId: string;
}): Promise<boolean> {
  const { binding } = input;
  if (input.runtimeType !== "claude_local" || !binding?.currentSegmentId
    || binding.status !== "active" || binding.continuity !== "native") return false;
  const segment = await input.db.select().from(nativeSegments).where(and(
    eq(nativeSegments.id, binding.currentSegmentId), eq(nativeSegments.orgId, input.orgId),
    eq(nativeSegments.bindingId, binding.id),
  )).limit(1).then((rows) => rows[0] ?? null);
  if (!segment || segment.state !== "pending" || segment.nativeSessionId
    || (segment.providerStateJson && Object.keys(segment.providerStateJson).length > 0)) return false;
  const prior = await input.db.select({
    status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, context: heartbeatRuns.contextSnapshot,
    nativeExecutionRef: runRuntimeSpans.nativeExecutionRef,
  }).from(runRuntimeSpans).innerJoin(heartbeatRuns, eq(runRuntimeSpans.runId, heartbeatRuns.id))
    .where(and(
      eq(runRuntimeSpans.orgId, input.orgId), eq(runRuntimeSpans.bindingId, binding.id),
      eq(runRuntimeSpans.segmentId, segment.id), eq(heartbeatRuns.orgId, input.orgId),
      eq(heartbeatRuns.chatConversationId, input.conversationId),
      sql`${heartbeatRuns.contextSnapshot}->'sideChatRuntimeAdmission' ? 'deferredForkDescriptor'`,
    )).orderBy(desc(runRuntimeSpans.openedAt)).limit(1).then((rows) => rows[0] ?? null);
  const context = prior?.context;
  return Boolean(prior?.status === "failed" && prior.errorCode === "claude_fork_unsubmitted"
    && !prior.nativeExecutionRef && context?.runtimeBindingId === binding.id
    && context.runtimeSegmentId === segment.id);
}

export async function recoverClaudeDeferredForkRun(input: {
  db: Db;
  orgId: string;
  conversationId: string;
  run: OwnedRun;
  bindingId: string;
  segmentId: string;
  runFence: NativeForkIntentRunFence | null;
  allowProviderSubmission: boolean;
  source: Parameters<typeof admitClaudeDeferredFork>[0]["source"] | null;
  sourceBindingMatchesTarget: boolean;
  bindingInput: Parameters<typeof admitClaudeDeferredFork>[0]["bindingInput"];
  providerBinding: Parameters<typeof admitClaudeDeferredFork>[0]["providerBinding"];
  config: Record<string, unknown>;
  finalize: (state: Parameters<ChatRuns["finalizeRun"]>[1]) => Promise<unknown>;
}): Promise<ClaudeDeferredForkAdmission> {
  if (!input.runFence) throw new Error("Claude fork recovery has no owned Run fence");
  const recovery = await classifyClaudeDeferredForkRecovery({
    db: input.db, orgId: input.orgId, conversationId: input.conversationId,
    runId: input.run.id, bindingId: input.bindingId, segmentId: input.segmentId, runFence: input.runFence,
  });
  if (recovery.runFence.ownerToken !== input.runFence.ownerToken
    || recovery.runFence.attemptEpoch !== input.runFence.attemptEpoch
    || recovery.runFence.spanId !== input.runFence.spanId) {
    throw new Error("Claude fork recovery lost the owned Run fence");
  }
  if (recovery.status === "accepted_child_open_span") {
    // Recovery deliberately marks interrupted submission as unknown. The
    // owner-fenced durable child is the evidence needed to reconcile it;
    // finalization alone must not bypass that state transition.
    const reconciled = await chatAgentRunService(input.db).reconcileAcceptance(
      input.run,
      {
        state: "accepted",
        providerThreadId: recovery.child.session.sessionId,
        providerTurnId: recovery.child.boundary,
      },
    );
    if (!reconciled) throw new Error("Claude fork acceptance reconciliation lost ownership");
    await settleAcceptedClaudeForkRecovery({
      run: input.run, child: recovery.child,
      sourceBoundaryRef: recovery.descriptor.sourceSelector.throughInclusiveUuid,
      finalize: input.finalize,
    });
    throw new ChatAssistantStreamError(
      "Claude fork input was accepted, but reply completion evidence was lost; same-message retry is blocked",
      "", [], { errorCode: "claude_fork_completion_unresolved", partialBodyUserVisible: false,
        retryable: false, action: "inspect_run" },
    );
  }
  if (recovery.status !== "descriptor_only") {
    throw new Error(`Claude Side Chat fork ${recovery.status}; provider reconciliation is required before retry`);
  }
  if (!input.allowProviderSubmission) {
    const reason = "Claude deferred fork ended before provider submission; send a new message to retry the branch.";
    await input.finalize({ status: "failed", error: reason, errorCode: "claude_fork_unsubmitted",
      resultJson: { outcome: "failed", recoverable: true, retryable: true,
        submissionPhase: "pre_submission", nativeCompletion: "unsubmitted" } });
    throw new ChatAssistantStreamError(reason, "", [], { errorCode: "claude_fork_unsubmitted",
      partialBodyUserVisible: false, retryable: true, action: "retry" });
  }
  if (!input.source || !input.sourceBindingMatchesTarget) {
    throw new Error("Claude deferred fork source profile changed during recovery");
  }
  const readmitted = await admitClaudeDeferredFork({
    db: input.db, source: input.source, sourceBindingMatchesTarget: input.sourceBindingMatchesTarget,
    bindingInput: input.bindingInput, providerBinding: input.providerBinding,
    config: input.config, conversationId: input.conversationId,
  });
  if (readmitted.admission.continuity !== "native" || !readmitted.reservation
    || readmitted.reservation.targetBinding.id !== input.bindingId
    || readmitted.reservation.targetSegment.id !== input.segmentId) {
    throw new Error("Claude deferred fork source head or target changed during recovery");
  }
  return { ...readmitted, adapterIntent: recovery.descriptor };
}

export async function assertAcceptedClaudeForkIsNewInput(input: {
  db: Db;
  orgId: string;
  conversationId: string;
  bindingId: string;
  userMessageId?: string | null;
  providerState: Record<string, unknown> | null;
}): Promise<void> {
  const intent = readNativeForkIntent(input.providerState);
  if (!intent) {
    const prior = await input.db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(runRuntimeSpans).innerJoin(heartbeatRuns, eq(runRuntimeSpans.runId, heartbeatRuns.id))
      .where(and(
        eq(runRuntimeSpans.orgId, input.orgId),
        eq(runRuntimeSpans.bindingId, input.bindingId),
        eq(heartbeatRuns.orgId, input.orgId),
        eq(heartbeatRuns.chatConversationId, input.conversationId),
        sql`${heartbeatRuns.contextSnapshot}->'sideChatRuntimeAdmission' ? 'deferredForkDescriptor'`,
      )).limit(1).then((rows) => rows[0] ?? null);
    const admission = prior?.contextSnapshot?.sideChatRuntimeAdmission as Record<string, unknown> | undefined;
    if (admission?.deferredForkDescriptor) {
      throw new Error("Claude Side Chat has an unresolved deferred fork; new input is blocked until reconciliation");
    }
    return;
  }
  if (intent.status !== "accepted" || !intent.runFence) return;
  const original = await input.db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, intent.runFence.runId),
      eq(heartbeatRuns.orgId, input.orgId),
      eq(heartbeatRuns.chatConversationId, input.conversationId),
    )).limit(1).then((rows) => rows[0] ?? null);
  const originalMessageId = original?.contextSnapshot?.userMessageId;
  if (!originalMessageId || !input.userMessageId || originalMessageId === input.userMessageId) {
    throw new Error("Claude Side Chat fork already accepted this input; same-message replay is blocked");
  }
}

export async function assertClaudeSideChatInputSafe(input: {
  db: Db;
  runtimeType: string;
  conversationKind: string | null | undefined;
  orgId: string;
  conversationId: string;
  bindingId: string;
  providerState: Record<string, unknown> | null;
  firstSend: boolean;
  forkConversation?: boolean;
  resumeRunId?: string | null;
  userMessageId?: string | null;
}): Promise<void> {
  if (input.runtimeType !== "claude_local" || input.resumeRunId
    || (input.conversationKind !== "side_chat" && !input.forkConversation && !input.firstSend && !input.providerState?.__rudderNativeForkIntent)) return;
  assertClaudeDeferredForkReplaySafety({
    providerState: input.providerState, firstSend: input.firstSend, recoveringRun: false,
  });
  if (!input.firstSend) await assertAcceptedClaudeForkIsNewInput(input);
}

export function claudeForkFenceForRun(runtimeType: string, run: OwnedRun): NativeForkIntentRunFence | null {
  return runtimeType === "claude_local" && run.runtimeSpanId && run.runtimeSpanOwnerToken
    && run.runtimeSpanAttemptEpoch != null
    ? { runId: run.id, spanId: run.runtimeSpanId, ownerToken: run.runtimeSpanOwnerToken,
      attemptEpoch: run.runtimeSpanAttemptEpoch }
    : null;
}

/** A durable child proves input acceptance, but not that its reply was delivered. */
export async function settleAcceptedClaudeForkRecovery(input: {
  run: OwnedRun;
  child: NativeForkIntentChild;
  sourceBoundaryRef: string;
  finalize: (state: Parameters<ChatRuns["finalizeRun"]>[1]) => Promise<unknown>;
}): Promise<void> {
  const { run, child, sourceBoundaryRef } = input;
  const spanId = run.runtimeSpanId;
  const ownerToken = run.runtimeSpanOwnerToken;
  const attemptEpoch = run.runtimeSpanAttemptEpoch;
  if (!spanId || !ownerToken || !attemptEpoch || !child.session.sessionId || !child.boundary) {
    throw new Error("Claude fork child has insufficient durable boundary evidence; input replay is blocked");
  }
  const reason = "Claude fork input was accepted, but reply completion evidence was lost during recovery. Do not retry the same input.";
  const result: AgentRuntimeExecutionResult = {
    summary: "",
    resultJson: {
      providerTurnId: child.boundary,
      startExclusiveUuid: sourceBoundaryRef,
      transcriptBoundary: { status: "unknown" },
    },
    sessionId: child.session.sessionId,
    sessionDisplayId: child.session.sessionDisplayId,
    sessionParams: child.session.sessionParams,
    submissionPhase: "accepted",
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: reason,
  };
  await input.finalize({
    status: "failed",
    error: reason,
    errorCode: "claude_fork_completion_unresolved",
    terminalFields: {
      sessionIdAfter: child.session.sessionId,
      sessionParamsAfterJson: child.session.sessionParams,
    },
    nativeExecution: { spanId, result, error: true },
    attempt: {
      submissionPhase: "accepted",
      providerThreadId: child.session.sessionId,
      providerTurnId: child.boundary,
      sessionDisplayId: child.session.sessionDisplayId,
      sessionParamsJson: child.session.sessionParams,
      errorCode: "claude_fork_completion_unresolved",
      error: reason,
    },
    resultJson: {
      outcome: "failed",
      recoverable: false,
      retryable: false,
      fallbackEnvelope: true,
      submissionPhase: "accepted",
      nativeCompletion: "partial",
      providerSessionId: child.session.sessionId,
      providerTurnId: child.boundary,
    },
  });
}
