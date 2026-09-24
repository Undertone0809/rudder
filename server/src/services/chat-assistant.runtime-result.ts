import type { AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import { asRecord, asString } from "./chat-assistant.helpers.js";

export function chatProviderResultIds(result: AgentRuntimeExecutionResult) {
  const payload = asRecord(result.resultJson);
  return {
    providerThreadId: asString(
      result.providerThreadId
      ?? result.sessionDisplayId
      ?? result.sessionId
      ?? payload?.providerSessionId
      ?? payload?.sessionId
      ?? payload?.threadId,
    ) || null,
    providerTurnId: asString(
      result.providerTurnId
      ?? payload?.providerTurnId
      ?? payload?.turnId
      ?? payload?.executionId
      ?? payload?.messageId,
    ) || null,
  };
}
