import type { ChatMessage } from "@rudderhq/shared";

export function readStructuredPayloadString(
  payload: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function legacyChatForkSourceTitleFromBody(body: string, sourceConversationId: string) {
  const linkPattern = /\[([^\]]+)\]\(chat:\/\/([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(body)) !== null) {
    const title = match[1]?.trim();
    const linkedConversationId = match[2]?.split(/[?#]/)[0]?.trim();
    if (title && linkedConversationId === sourceConversationId) return title;
  }
  return null;
}

export function chatForkSystemMessageParts(message: ChatMessage) {
  const payload = message.structuredPayload;
  if (!payload || (payload.eventType !== "chat_fork" && payload.type !== "chat_fork")) return null;

  const sourceConversationId = readStructuredPayloadString(payload, "sourceConversationId");
  const sourceMessageId = readStructuredPayloadString(payload, "sourceMessageId");
  if (!sourceConversationId) return null;
  const sourceConversationTitle =
    readStructuredPayloadString(payload, "sourceConversationTitle")
    ?? legacyChatForkSourceTitleFromBody(message.body, sourceConversationId)
    ?? "source chat";

  return { sourceConversationId, sourceConversationTitle, sourceMessageId };
}

export function sideChatStartedSystemMessageParts(message: ChatMessage) {
  const payload = message.structuredPayload;
  if (!payload || payload.eventType !== "side_chat_started") return null;

  const sourceConversationId = readStructuredPayloadString(payload, "sourceConversationId");
  if (!sourceConversationId) return null;
  const sourceConversationTitle =
    readStructuredPayloadString(payload, "sourceConversationTitle")
    ?? legacyChatForkSourceTitleFromBody(message.body, sourceConversationId)
    ?? "source chat";

  return { sourceConversationId, sourceConversationTitle };
}
