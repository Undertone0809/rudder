import {
  activeChatStreamTimelineInsertionIndex,
  type ActiveChatStreamTimelineState,
} from "@/lib/chat-stream-state";
import type { ChatMessage } from "@rudderhq/shared";

export type ChatTimelineRow =
  | { kind: "message"; message: ChatMessage; messageIndex: number }
  | { kind: "active_stream" };

export function buildChatTimelineRows(
  messages: ChatMessage[],
  activeStream: ActiveChatStreamTimelineState | null,
  showActiveStreamDraft: boolean,
) {
  const rows: ChatTimelineRow[] = messages.map((message, messageIndex) => ({
    kind: "message",
    message,
    messageIndex,
  }));
  if (!showActiveStreamDraft || !activeStream) return rows;
  rows.splice(activeChatStreamTimelineInsertionIndex(messages, activeStream), 0, {
    kind: "active_stream",
  });
  return rows;
}
