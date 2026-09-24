import { badRequest, notFound } from "../../errors.js";
import {
  MAX_CONVERSATION_SOURCE_SCAN,
  MAX_PAGE_LIMIT,
} from "./transcript-reader.contracts.js";
import type {
  ReadDatabase,
  ReadConversationTranscript,
  ReadRunTranscript,
  ReadTranscriptItem,
  TranscriptItem,
  TranscriptPage,
  TranscriptReader,
  TranscriptReaderOptions,
  TranscriptStreamEvent,
} from "./transcript-reader.contracts.js";
import { transcriptReaderError } from "./transcript-reader.normalize.js";
import { itemMatchesRef, pageFromRunSource } from "./transcript-reader.pages.js";
import { readConversationItems } from "./transcript-reader.conversation.js";
import { readRunItems } from "./transcript-reader.sources.js";

export function createDatabaseTranscriptReader(database: ReadDatabase, options: TranscriptReaderOptions = {}): TranscriptReader {
  async function readRun(input: ReadRunTranscript): Promise<TranscriptPage> {
    const source = await readRunItems(database, options, input);
    return pageFromRunSource(source, { ...input, id: input.runId });
  }

  async function readConversation(input: ReadConversationTranscript): Promise<TranscriptPage> {
    return await readConversationItems(database, options, input);
  }

  async function readItem(input: ReadTranscriptItem): Promise<TranscriptItem> {
    if (input.runId) {
      const source = await readRunItems(database, options, { ...input, runId: input.runId }, input.itemId);
      const item = source.items.find((candidate) => itemMatchesRef(candidate, input.itemId));
      if (!item) throw notFound("Transcript item not found");
      return item;
    }
    if (input.conversationId) {
      let cursor: string | null = input.cursor ?? null;
      for (let pageCount = 0; pageCount < MAX_CONVERSATION_SOURCE_SCAN; pageCount += 1) {
        const page = await readConversationItems(database, options, {
          ...input,
          conversationId: input.conversationId,
          cursor,
          limit: MAX_PAGE_LIMIT,
        });
        const item = page.items.find((candidate) => itemMatchesRef(candidate, input.itemId));
        if (item) return item;
        if (!page.nextCursor) break;
        if (page.nextCursor === cursor) throw transcriptReaderError("cursor_invalid", "Transcript cursor did not advance");
        cursor = page.nextCursor;
      }
      throw notFound("Transcript item not found");
    }
    throw badRequest("Transcript item requires a runId or conversationId");
  }

  async function* stream(input: ReadRunTranscript | ReadConversationTranscript): AsyncIterable<TranscriptStreamEvent> {
    const page = "runId" in input ? await readRun(input) : await readConversation(input);
    yield { type: "snapshot", page };
    for (const item of page.items) yield { type: "item", item };
    yield { type: "complete", nextCursor: page.nextCursor };
  }

  return { readRun, readConversation, readItem, stream };
}
