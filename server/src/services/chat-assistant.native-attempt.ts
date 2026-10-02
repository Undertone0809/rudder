import {
  hasConfirmedNativeWriterQuiescence,
  isAgentRuntimeNetworkSuspension,
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
export type ChatNativeAttemptLifecycle = { providerDispatched: boolean; willFallback: boolean };

export function createChatNativeAttemptCallbacks(input: {
  orgId: string;
  runtimeAgentType: string;
  isNativeRuntime: (runtimeType: string) => boolean;
  signal: AbortSignal;
  isExecutionInactive: () => boolean;
  isOwnerLost: () => boolean;
  ownerLostError: Error;
  getAttempt: () => NativeAttemptRef | null | undefined;
  getSpanFence: () => Omit<NativeSpanFence, "orgId" | "attemptId" | "spanId" | "suspended"> & {
    spanId: string | null;
  };
  markAcceptanceUnknown: (value: { phase: "indeterminate"; reason: string }) => Promise<unknown>;
  /** Finalize provider-specific state while the terminal attempt span is still open. */
  beforeTerminalNativeResult?: (
    result: AgentRuntimeExecutionResult,
    fence: NativeSpanFence,
  ) => Promise<AgentRuntimeExecutionResult>;
  /** Provider-specific proof may refuse an otherwise eligible model fallback. */
  prepareNativeFallback?: (
    result: AgentRuntimeExecutionResult,
    fence: NativeSpanFence,
    lifecycle: ChatNativeAttemptLifecycle,
  ) => Promise<boolean>;
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
      lifecycle?: ChatNativeAttemptLifecycle,
    ) => {
      // Stop freezes visible output, but the current owner must still record
      // the returning provider's writer-exit proof before finalizing the Run.
      if (input.isOwnerLost()) throw input.ownerLostError;
      const identity = currentIdentity(attempt);
      if (!identity) {
        throw new Error("Chat provider result has no matching durable attempt and native span");
      }
      // Only the executor knows whether an eligible next attempt exists after
      // auth-scope filtering. Remaining model count is not retry authority.
      const willFallback = lifecycle?.willFallback === true && !input.signal.aborted;
      const fence: NativeSpanFence = {
        ...identity.span,
        orgId: input.orgId,
        spanId: identity.spanId,
        attemptId: identity.attemptRef.id,
        suspended: Boolean(
          isAgentRuntimeNetworkSuspension(result.networkSuspension)
          || isAgentRuntimeNetworkSuspension(result.suspension),
        ),
      };
      // A failed attempt that will fall back is not the terminal Fork outcome.
      // Finalize only the terminal attempt, before recording seals its span.
      const fallbackAllowed = !willFallback || !input.prepareNativeFallback
        || await input.prepareNativeFallback(result, fence, lifecycle!);
      const nativeResult = (!willFallback || !fallbackAllowed) && input.beforeTerminalNativeResult
        ? await input.beforeTerminalNativeResult(result, fence)
        : result;
      const recordedSpan = await input.recordNativeExecutionResult(nativeResult, fence);
      if (
        !recordedSpan
        || recordedSpan.id !== identity.spanId
        || recordedSpan.attemptRef?.id !== identity.attemptRef.id
      ) {
        throw new Error("Chat provider result could not be recorded against its native attempt span");
      }
      const attemptRuntimeType = attempt.agentRuntimeType ?? input.runtimeAgentType;
      if (
        willFallback
        && input.isNativeRuntime(attemptRuntimeType)
        && !hasConfirmedNativeWriterQuiescence(result)
      ) {
        throw new Error("Chat cannot start a fallback before the previous native writer is confirmed quiescent");
      }
      await input.onAttemptResult(attempt, result, phase);
      if (!fallbackAllowed) {
        throw new Error("Chat cannot retry a native fork without proof that no child was created");
      }
    },
  };
}
