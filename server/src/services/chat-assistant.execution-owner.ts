import { redactRudderInlineVisualSources } from "@rudderhq/shared";
import {
  maybeEmitAssistantState,
  partialBodyFromRawAssistantText,
  safeTrim,
  type StreamChatAssistantReplyResult,
  type StreamChatAssistantReplyInput,
} from "./chat-assistant.helpers.js";

export type ChatAssistantStaleOutcome = {
  outcome: "stale";
  reason: "execution_owner_lost";
};

export function createChatAssistantExecutionOwner<TFinalState, TFinalized>(input: {
  ownerSignal: AbortSignal;
  stopSignal?: AbortSignal;
  finalize: (state: TFinalState) => Promise<TFinalized>;
  failureState: (error: unknown) => TFinalState;
}) {
  const isStopped = () => input.stopSignal?.aborted === true;
  const isOwnerLost = () => input.ownerSignal.aborted && !isStopped();
  const isInactive = () => isStopped() || isOwnerLost();
  const ownerLostError = new Error("Chat execution owner was lost");
  const staleOutcome: ChatAssistantStaleOutcome = {
    outcome: "stale",
    reason: "execution_owner_lost",
  };
  let finalized = false;

  const finalize = async (state: TFinalState) => {
    if (isOwnerLost()) throw ownerLostError;
    const result = await input.finalize(state);
    if (isOwnerLost()) throw ownerLostError;
    finalized = true;
    return result;
  };
  const finalizeUnhandledFailure = async (error: unknown) => {
    if (finalized || isOwnerLost()) return;
    await finalize(input.failureState(error));
  };
  const guard = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    if (isOwnerLost()) throw ownerLostError;
    try {
      const result = await operation();
      if (isOwnerLost()) throw ownerLostError;
      return result;
    } catch (error) {
      if (isStopped() || isOwnerLost() || error === ownerLostError) throw error;
      await finalizeUnhandledFailure(error);
      throw error;
    }
  };

  return {
    finalize,
    finalizeUnhandledFailure,
    guard,
    isFinalized: () => finalized,
    isInactive,
    isOwnerLost,
    isStopped,
    ownerLostError,
    staleOutcome,
  };
}

export function createChatAssistantStopFinalizer<TFinalState>(input: {
  finalAssistantText: () => string;
  hasNativeFinalMessage: () => boolean;
  resultSentinel: string;
  visibleText: () => string;
  isFinalized: () => boolean;
  finalize: (state: TFinalState) => Promise<unknown>;
  finalState: (partialBody: string) => TFinalState;
  onAssistantState?: StreamChatAssistantReplyInput["onAssistantState"];
  replyingAgentId: string | null;
}) {
  type StoppedReply = Extract<StreamChatAssistantReplyResult, { outcome: "stopped" }>;
  let stopCutoffPartialBody: string | null = null;
  let stoppedReplyPromise: Promise<StoppedReply> | null = null;
  const freezeStopCutoff = () => {
    if (stopCutoffPartialBody !== null) return;
    stopCutoffPartialBody = redactRudderInlineVisualSources(
      partialBodyFromRawAssistantText(
        input.hasNativeFinalMessage() ? input.finalAssistantText() : "",
        input.resultSentinel,
      ) || (safeTrim(input.visibleText()) ?? ""),
    );
  };
  const finalizeStoppedReply = (): Promise<StoppedReply> => {
    if (stoppedReplyPromise) return stoppedReplyPromise;
    freezeStopCutoff();
    const partialBody = stopCutoffPartialBody ?? "";
    stoppedReplyPromise = (async () => {
      await maybeEmitAssistantState(input.onAssistantState, "stopped");
      if (!input.isFinalized()) {
        await input.finalize(input.finalState(partialBody));
      }
      return {
        outcome: "stopped",
        partialBody,
        replyingAgentId: input.replyingAgentId,
      };
    })();
    return stoppedReplyPromise;
  };
  return { finalizeStoppedReply, freezeStopCutoff };
}
