import type { ChatConversation, ChatMessage } from "@rudderhq/shared";

export function latestSideChatAnchor(messages: ChatMessage[]) {
  return [...messages].reverse().find((message) => (
    message.role === "assistant"
    && message.kind === "message"
    && message.status !== "streaming"
    && message.status !== "interrupted"
  )) ?? null;
}

export function sideChatConversationMessages(messages: ChatMessage[]) {
  const boundary = messages.findIndex((message) => (
    message.kind === "system_event"
    && message.structuredPayload?.eventType === "side_chat_started"
  ));
  return boundary >= 0 ? messages.slice(boundary + 1) : messages;
}

export function sideChatIsReadOnly(conversation: ChatConversation | null | undefined) {
  return conversation?.conversationKind === "side_chat"
    && (conversation.sideChatState === "completed" || conversation.sideChatState === "expired");
}
