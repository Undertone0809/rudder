import type { ChatConversation, ChatMessage } from "@rudderhq/shared";

export function latestSideChatAnchor(messages: ChatMessage[]) {
  return [...messages].reverse().find((message) => (
    message.role === "assistant"
    && message.kind === "message"
    && message.status === "completed"
    && !message.supersededAt
  )) ?? null;
}

export function sideChatConversationMessages(messages: ChatMessage[]) {
  const boundary = messages.findIndex((message) => (
    message.kind === "system_event"
    && message.structuredPayload?.eventType === "side_chat_started"
  ));
  return boundary >= 0 ? messages.slice(boundary + 1) : messages;
}

export function sideChatIsReadOnly(
  conversation: ChatConversation | null | undefined,
  now = new Date(),
) {
  if (conversation?.conversationKind !== "side_chat" || conversation.sideChatState === "kept") return false;
  if (conversation.sideChatState === "completed" || conversation.sideChatState === "expired") return true;
  if (conversation.sideChatState !== "active" || !conversation.sideChatExpiresAt) return false;
  return new Date(conversation.sideChatExpiresAt).getTime() <= now.getTime();
}
