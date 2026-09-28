import type { TranscriptEntry } from "@/agent-runtimes";
import {
  activeChatStreamTimelineInsertionIndex,
  type ActiveChatStreamTimelineState,
} from "@/lib/chat-stream-state";
import type { ChatMessage } from "@rudderhq/shared";

export type ChatTimelineRow =
  | { kind: "message"; message: ChatMessage; messageIndex: number }
  | { kind: "active_stream" };

function mergeTranscriptRevision(
  previous: Extract<TranscriptEntry, { kind: "assistant" }>,
  incoming: Extract<TranscriptEntry, { kind: "assistant" }>,
) {
  if (incoming.delta !== true) return incoming;
  return { ...incoming, text: previous.text + incoming.text };
}

export function chatFinalAnswerFromTranscript(entries: TranscriptEntry[]) {
  const finalEntries: Extract<TranscriptEntry, { kind: "assistant" }>[] = [];
  const sourcePositions = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== "assistant" || entry.phase !== "final_answer") continue;
    const sourceKey = entry.sourceEntryId ?? null;
    const existingPosition = sourceKey === null ? undefined : sourcePositions.get(sourceKey);
    if (existingPosition === undefined) {
      if (sourceKey !== null) sourcePositions.set(sourceKey, finalEntries.length);
      finalEntries.push(entry);
      continue;
    }
    const previous = finalEntries[existingPosition];
    if (previous) finalEntries[existingPosition] = mergeTranscriptRevision(previous, entry);
  }

  let text = "";
  let previous: (typeof finalEntries)[number] | null = null;
  for (const entry of finalEntries) {
    const continuesDelta = Boolean(
      previous
      && entry.delta
      && previous.delta
      && (previous.segmentId || entry.segmentId
        ? previous.segmentId === entry.segmentId
        : true),
    );
    if (
      text
      && !continuesDelta
      && !text.endsWith("\n")
      && !entry.text.startsWith("\n")
    ) {
      text += "\n";
    }
    text += entry.text;
    previous = entry;
  }

  return text.trim() ? text : null;
}

export function chatProcessTranscriptEntries(entries: TranscriptEntry[]) {
  return entries.filter((entry) => !(entry.kind === "assistant" && entry.phase === "final_answer"));
}

export function buildChatTimelineRows(
  messages: ChatMessage[],
  activeStream: (ActiveChatStreamTimelineState & { generationId?: string | null }) | null,
  showActiveStreamDraft: boolean,
) {
  const rows: ChatTimelineRow[] = messages.map((message, messageIndex) => ({
    kind: "message",
    message,
    messageIndex,
  }));
  if (!showActiveStreamDraft || !activeStream) return rows;
  const terminalMessageExists = Boolean(
    activeStream.generationId
    && messages.some((message) => (
      message.role === "assistant"
      && message.generationId === activeStream.generationId
      && message.status !== "streaming"
    )),
  );
  if (terminalMessageExists) return rows;
  rows.splice(activeChatStreamTimelineInsertionIndex(messages, activeStream), 0, {
    kind: "active_stream",
  });
  return rows;
}
