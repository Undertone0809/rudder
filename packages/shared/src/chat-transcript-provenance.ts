import type {
  ChatStreamTranscriptEntry,
  ChatStreamTranscriptTextEntry,
} from "./types/chat.js";

export function withChatTranscriptGenerationProvenance<T extends ChatStreamTranscriptEntry>(
  entry: T,
  provenance: { generationId: string; generationSeq: number },
): T {
  if (entry.kind !== "assistant" && entry.kind !== "thinking") return entry;
  return {
    ...entry,
    generationId: provenance.generationId,
    generationSeqStart: provenance.generationSeq,
    generationSeqEnd: provenance.generationSeq,
  };
}

function hasStableTranscriptProvenance(
  entry: ChatStreamTranscriptTextEntry,
): entry is ChatStreamTranscriptTextEntry & {
  generationId: string;
  generationSeqStart: number;
  generationSeqEnd: number;
} {
  return typeof entry.generationId === "string"
    && Number.isInteger(entry.generationSeqStart)
    && Number.isInteger(entry.generationSeqEnd);
}

export function coalesceChatTranscriptTextEntries(
  entries: readonly ChatStreamTranscriptEntry[],
): ChatStreamTranscriptEntry[] {
  const coalesced: ChatStreamTranscriptEntry[] = [];
  for (const entry of entries) {
    const previous = coalesced.at(-1);
    if (
      (entry.kind === "assistant" || entry.kind === "thinking")
      && entry.delta === true
      && (previous?.kind === "assistant" || previous?.kind === "thinking")
      && previous.kind === entry.kind
      && previous.delta === true
      && hasStableTranscriptProvenance(previous)
      && hasStableTranscriptProvenance(entry)
      && previous.generationId === entry.generationId
      && previous.generationSeqEnd + 1 === entry.generationSeqStart
    ) {
      coalesced[coalesced.length - 1] = {
        ...previous,
        ts: entry.ts,
        text: previous.text + entry.text,
        generationSeqEnd: entry.generationSeqEnd,
      };
      continue;
    }
    coalesced.push(entry);
  }
  return coalesced;
}
