import { conflict } from "../errors.js";
import type { AppendEventFields } from "./chat-generation-protocol.helpers.js";

export type AppendVisibleEventAndProjectInput = Omit<
  AppendEventFields,
  "attemptEpoch" | "assistantMessageId"
> & {
  conversationId: string;
  expectedAttemptEpoch: number;
  expectedOwnerToken?: string | null;
  bodyHash: string;
  messageId?: string | null;
  body: string;
  replyingAgentId?: string | null;
  chatTurnId: string;
  turnVariant: number;
  transcriptSource?: "native" | "legacy";
};

export function createVisibleEventPayload(
  input: Pick<AppendVisibleEventAndProjectInput, "eventKind" | "payload" | "transcriptSource">,
  bodyHash: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = input.eventKind === "transcript" && input.transcriptSource === "native"
    ? {
      source: "native",
      ...(typeof input.payload?.runId === "string" ? { runId: input.payload.runId } : {}),
      ...(typeof input.payload?.spanId === "string" ? { spanId: input.payload.spanId } : {}),
    }
    : { ...(input.payload ?? {}) };
  if (typeof payload.bodyHash === "string" && payload.bodyHash.toLowerCase() !== bodyHash) {
    throw conflict("Chat generation event body hash disagrees with its payload");
  }
  payload.bodyHash = bodyHash;
  return payload;
}
