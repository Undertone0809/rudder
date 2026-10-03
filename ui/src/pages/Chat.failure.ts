import type { ChatMessage } from "@rudderhq/shared";

export function canRetryFailedChatMessage(message: Pick<ChatMessage, "id" | "orgId" | "conversationId" | "role" | "kind" | "status" | "chatTurnId" | "turnVariant" | "structuredPayload" | "runId">) {
  const failure = recoverableFailureFromMessage(message);
  if (failure?.code === "native_fork_acceptance_unknown") return false;
  const payload = message.structuredPayload;
  const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === "object" && !Array.isArray(value)
  );
  const rawFailure = isRecord(payload)
    ? payload.recoverableFailure
    : null;
  const failureRecord = isRecord(rawFailure) ? rawFailure : null;
  const dispatchEvidence = failureRecord && isRecord(failureRecord.dispatchEvidence)
    ? failureRecord.dispatchEvidence
    : null;
  const hasVerifiedPreGenerationEvidence = Boolean(failureRecord && dispatchEvidence
    && failureRecord.recoverable === true
    && failureRecord.retryable === true
    && failureRecord.code === "chat_input_persisted_reply_not_started"
    && failureRecord.phase === "pre_generation"
    && failureRecord.action === "retry"
    && failureRecord.runId === null
    && message.runId == null
    && dispatchEvidence.kind === "chat_pre_generation_not_started_v1"
    && dispatchEvidence.originalDispatch === "not_started"
    && dispatchEvidence.orgId === message.orgId
    && dispatchEvidence.conversationId === message.conversationId
    && typeof dispatchEvidence.userMessageId === "string"
    && dispatchEvidence.userMessageId.length > 0
    && typeof dispatchEvidence.userId === "string"
    && dispatchEvidence.userId.length > 0
    && dispatchEvidence.chatTurnId === message.chatTurnId
    && dispatchEvidence.turnVariant === message.turnVariant);
  return failure?.retryable !== false
    && message.role === "assistant"
    && message.kind === "message"
    && message.status === "failed"
    && Boolean(message.chatTurnId)
    && (Boolean(message.runId) || Boolean(failure?.runId) || hasVerifiedPreGenerationEvidence);
}

export function recoverableFailureFromMessage(
  message: Pick<ChatMessage, "structuredPayload" | "runId">,
) {
  const payload = message.structuredPayload;
  const failure = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload.recoverableFailure
    : null;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
  const candidate = failure as Record<string, unknown>;
  const code = typeof candidate.code === "string" && candidate.code.trim()
    ? candidate.code.trim()
    : "chat_runtime_exception";
  const runId = typeof candidate.runId === "string" && candidate.runId.trim()
    ? candidate.runId.trim()
    : message.runId ?? null;
  const detailMessage = code === "native_fork_acceptance_unknown"
    ? runId
      ? "This Side Chat fork has an unknown outcome. Inspect and reconcile the Run before sending more input. Do not retry this fork."
      : "This Side Chat fork has an unknown outcome. Do not retry this fork. Ask an operator to reconcile the fork status before sending more input."
    : typeof candidate.message === "string" && candidate.message.trim()
      ? candidate.message.trim()
      : "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.";
  const retryable = typeof candidate.retryable === "boolean"
    ? candidate.retryable
    : typeof candidate.recoverable === "boolean"
      ? candidate.recoverable
      : true;
  const phase = typeof candidate.phase === "string" && candidate.phase.trim()
    ? candidate.phase.trim()
    : null;
  const action = code === "native_fork_acceptance_unknown"
    ? runId ? "inspect_run" : null
    : typeof candidate.action === "string" && candidate.action.trim()
      ? candidate.action.trim()
      : null;
  return { code, message: detailMessage, runId, retryable, phase, action,
    partialBodyUserVisible: candidate.partialBodyUserVisible === true };
}
