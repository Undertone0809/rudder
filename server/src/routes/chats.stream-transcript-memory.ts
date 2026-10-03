import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { ChatStreamTranscriptEntry } from "@rudderhq/shared";
import { coalesceChatTranscriptTextEntries } from "@rudderhq/shared/chat-transcript-provenance";
import { CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS } from "../services/chat-generation-provenance.js";

const MAX_CHAT_STREAM_TRANSCRIPT_MEMORY_ENTRIES = CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.entries;
const MAX_CHAT_STREAM_TRANSCRIPT_MEMORY_BYTES = CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes;

function chatStreamTranscriptEntryBytes(entry: TranscriptEntry) {
  try {
    return Buffer.byteLength(JSON.stringify(entry), "utf8");
  } catch {
    return MAX_CHAT_STREAM_TRANSCRIPT_MEMORY_BYTES;
  }
}

function boundChatStreamTranscriptMemory(transcript: TranscriptEntry[]) {
  while (transcript.length > MAX_CHAT_STREAM_TRANSCRIPT_MEMORY_ENTRIES) transcript.shift();
  let bytes = 0;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    bytes += chatStreamTranscriptEntryBytes(transcript[index]!);
    if (bytes <= MAX_CHAT_STREAM_TRANSCRIPT_MEMORY_BYTES) continue;
    transcript.splice(0, index + 1);
    break;
  }
}

export function boundedChatStreamTranscriptWindow(transcript: readonly TranscriptEntry[]) {
  const retained: TranscriptEntry[] = [];
  let bytes = 0;
  for (
    let index = transcript.length - 1;
    index >= 0 && retained.length < MAX_CHAT_STREAM_TRANSCRIPT_MEMORY_ENTRIES;
    index -= 1
  ) {
    const entry = transcript[index]!;
    const entryBytes = chatStreamTranscriptEntryBytes(entry);
    if (bytes + entryBytes > MAX_CHAT_STREAM_TRANSCRIPT_MEMORY_BYTES) break;
    retained.push(entry);
    bytes += entryBytes;
  }
  return retained.reverse();
}

export function appendChatStreamTranscriptMemory(transcript: TranscriptEntry[], entry: TranscriptEntry) {
  const previous = transcript.at(-1);
  if (previous) {
    const coalesced = coalesceChatTranscriptTextEntries([
      previous as ChatStreamTranscriptEntry,
      entry as ChatStreamTranscriptEntry,
    ]);
    if (
      coalesced.length === 1
      && chatStreamTranscriptEntryBytes(coalesced[0] as TranscriptEntry) <= MAX_CHAT_STREAM_TRANSCRIPT_MEMORY_BYTES
    ) {
      transcript[transcript.length - 1] = coalesced[0] as TranscriptEntry;
    } else {
      transcript.push(entry);
    }
  } else {
    transcript.push(entry);
  }
  boundChatStreamTranscriptMemory(transcript);
}
