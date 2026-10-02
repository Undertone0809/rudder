import type { ChatMessage } from "@rudderhq/shared";

export const CHAT_PRE_GENERATION_FAILURE_CODE = "chat_input_persisted_reply_not_started";
export const CHAT_PRE_GENERATION_FAILURE_MESSAGE = "Your input was saved, but the reply did not start.";
export const CHAT_PRE_GENERATION_DISPATCH_EVIDENCE_KIND = "chat_pre_generation_not_started_v1";

type UserMessageIdentity = Pick<
  ChatMessage,
  "id" | "orgId" | "conversationId" | "chatTurnId" | "turnVariant"
>;

type FailedMessageEvidence = Pick<
  ChatMessage,
  "orgId" | "conversationId" | "role" | "kind" | "status" | "runId" | "chatTurnId" | "turnVariant" | "structuredPayload"
>;

export function chatPreGenerationFailurePayload(input: {
  userId: string;
  userMessage: UserMessageIdentity;
}) {
  return {
    recoverableFailure: {
      recoverable: true,
      retryable: true,
      code: CHAT_PRE_GENERATION_FAILURE_CODE,
      message: CHAT_PRE_GENERATION_FAILURE_MESSAGE,
      phase: "pre_generation",
      action: "retry",
      runId: null,
      dispatchEvidence: {
        kind: CHAT_PRE_GENERATION_DISPATCH_EVIDENCE_KIND,
        originalDispatch: "not_started",
        orgId: input.userMessage.orgId,
        conversationId: input.userMessage.conversationId,
        userId: input.userId,
        userMessageId: input.userMessage.id,
        chatTurnId: input.userMessage.chatTurnId,
        turnVariant: input.userMessage.turnVariant,
      },
    },
  };
}

export function hasChatPreGenerationNotStartedEvidence(
  failureMessage: FailedMessageEvidence,
  userMessage: UserMessageIdentity,
  expectedUserId?: string | null,
) {
  if (
    failureMessage.role !== "assistant"
    || failureMessage.kind !== "message"
    || failureMessage.status !== "failed"
    || failureMessage.runId != null
    || failureMessage.orgId !== userMessage.orgId
    || failureMessage.conversationId !== userMessage.conversationId
    || failureMessage.chatTurnId !== userMessage.chatTurnId
    || failureMessage.turnVariant !== userMessage.turnVariant
  ) return false;

  const payload = failureMessage.structuredPayload;
  const recoverableFailure = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload.recoverableFailure
    : null;
  if (!recoverableFailure || typeof recoverableFailure !== "object" || Array.isArray(recoverableFailure)) {
    return false;
  }
  const failure = recoverableFailure as Record<string, unknown>;
  const dispatchEvidence = failure.dispatchEvidence;
  if (!dispatchEvidence || typeof dispatchEvidence !== "object" || Array.isArray(dispatchEvidence)) {
    return false;
  }
  const evidence = dispatchEvidence as Record<string, unknown>;
  return failure.recoverable === true
    && failure.retryable === true
    && failure.code === CHAT_PRE_GENERATION_FAILURE_CODE
    && failure.phase === "pre_generation"
    && failure.action === "retry"
    && failure.runId === null
    && evidence.kind === CHAT_PRE_GENERATION_DISPATCH_EVIDENCE_KIND
    && evidence.originalDispatch === "not_started"
    && evidence.orgId === userMessage.orgId
    && evidence.conversationId === userMessage.conversationId
    && typeof evidence.userId === "string"
    && evidence.userId.length > 0
    && (expectedUserId == null || evidence.userId === expectedUserId)
    && evidence.userMessageId === userMessage.id
    && evidence.chatTurnId === userMessage.chatTurnId
    && evidence.turnVariant === userMessage.turnVariant;
}
