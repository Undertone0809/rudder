import {
  hasConfirmedNativeWriterQuiescence,
  isAgentRuntimeNetworkSuspension,
  isSuccessfulRuntimeResult,
  type AgentRuntimeExecutionResult,
  type AgentRuntimeNetworkSubmissionPhase,
  type ModelAttemptSpec,
} from "@rudderhq/agent-runtime-utils";
import type { chatAgentRunService } from "./chat-agent-runs.js";

type ChatRunService = ReturnType<typeof chatAgentRunService>;
type NativeSpanFence = Parameters<ChatRunService["recordNativeExecutionResult"]>[2];
type NativeSpanResult = Pick<
  NonNullable<Awaited<ReturnType<ChatRunService["recordNativeExecutionResult"]>>>,
  "id" | "attemptRef"
> | null;
type NativeAttemptRef = { id: string; attemptIndex: number };

export function createChatNativeAttemptCallbacks(input: {
  orgId: string;
  runtimeAgentType: string;
  nativeDriverRequired: boolean;
  signal: AbortSignal;
  isExecutionInactive: () => boolean;
  ownerLostError: Error;
  getAttempt: () => NativeAttemptRef | null | undefined;
  getSpanFence: () => Omit<NativeSpanFence, "orgId" | "attemptId" | "spanId" | "suspended"> & {
    spanId: string | null;
  };
  markAcceptanceUnknown: (value: { phase: "indeterminate"; reason: string }) => Promise<unknown>;
  recordNativeExecutionResult: (
    result: AgentRuntimeExecutionResult,
    fence: NativeSpanFence,
  ) => Promise<NativeSpanResult>;
  onAttemptResult: (
    attempt: ModelAttemptSpec,
    result: AgentRuntimeExecutionResult,
    phase: AgentRuntimeNetworkSubmissionPhase,
  ) => Promise<void>;
}) {
  const currentIdentity = (attempt: ModelAttemptSpec) => {
    const attemptRef = input.getAttempt();
    const span = input.getSpanFence();
    const spanId = span.spanId?.trim();
    if (!attemptRef?.id.trim() || attemptRef.attemptIndex !== attempt.index || !spanId) return null;
    return { attemptRef, span, spanId };
  };

  return {
    onAttemptSubmissionStart: async (attempt: ModelAttemptSpec) => {
      if (input.isExecutionInactive()) throw input.ownerLostError;
      const identity = currentIdentity(attempt);
      if (!identity) {
        throw new Error("Chat provider dispatch has no matching durable attempt and native span");
      }
      const checkpoint = await input.markAcceptanceUnknown({
        phase: "indeterminate",
        reason: [
          "native provider dispatch starting",
          `attemptId=${identity.attemptRef.id}`,
          `spanId=${identity.spanId}`,
          `runtimeType=${attempt.agentRuntimeType ?? input.runtimeAgentType}`,
          `model=${attempt.model}`,
        ].join("; "),
      });
      if (!checkpoint || input.isExecutionInactive()) throw input.ownerLostError;
    },
    onAttemptResult: async (
      attempt: ModelAttemptSpec,
      result: AgentRuntimeExecutionResult,
      phase: AgentRuntimeNetworkSubmissionPhase,
    ) => {
      if (input.isExecutionInactive()) throw input.ownerLostError;
      const identity = currentIdentity(attempt);
      if (!identity) {
        throw new Error("Chat provider result has no matching durable attempt and native span");
      }
      const recordedSpan = await input.recordNativeExecutionResult(result, {
        ...identity.span,
        orgId: input.orgId,
        spanId: identity.spanId,
        attemptId: identity.attemptRef.id,
        suspended: Boolean(
          isAgentRuntimeNetworkSuspension(result.networkSuspension)
          || isAgentRuntimeNetworkSuspension(result.suspension),
        ),
      });
      if (
        !recordedSpan
        || recordedSpan.id !== identity.spanId
        || recordedSpan.attemptRef?.id !== identity.attemptRef.id
      ) {
        throw new Error("Chat provider result could not be recorded against its native attempt span");
      }
      const willFallback = input.nativeDriverRequired
        && attempt.index < attempt.totalFallbacks
        && phase === "pre_submission"
        && !isSuccessfulRuntimeResult(result)
        && result.errorCode !== "runtime_driver_required"
        && result.errorCode !== "runtime_session_resume_rejected"
        && !isAgentRuntimeNetworkSuspension(result.networkSuspension)
        && !isAgentRuntimeNetworkSuspension(result.suspension)
        && !input.signal.aborted;
      if (willFallback && !hasConfirmedNativeWriterQuiescence(result)) {
        throw new Error("Chat cannot start a fallback before the previous native writer is confirmed quiescent");
      }
      await input.onAttemptResult(attempt, result, phase);
    },
  };
}
