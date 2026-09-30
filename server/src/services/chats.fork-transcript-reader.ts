import type { chatMessages, Db } from "@rudderhq/db";
import type { ChatStreamTranscriptEntry } from "@rudderhq/shared";
import { unprocessable } from "../errors.js";
import { chatTranscriptEntryFromReaderItem } from "./chat-transcript-reader-item.js";
import { loadNativeChatForkSource, nativeForkContentHash, nativeForkReaderContent, type NativeChatForkSource } from "./chats.native-fork-aliases.js";
import { createHistoricalTranscriptReader } from "./runtime-kernel/historical-transcript-reader.js";
import type { TranscriptAvailability, TranscriptSource } from "./runtime-kernel/transcript-reader.js";

type MessageRow = typeof chatMessages.$inferSelect;
const CHAT_TRANSCRIPT_READER_PAGE_LIMIT = 200;
const CHAT_TRANSCRIPT_READER_MAX_PAGES = 25;
const CHAT_TRANSCRIPT_READER_MAX_ITEMS = 5000;
const CHAT_TRANSCRIPT_READER_MAX_BYTES = 2 * 1024 * 1024;
export type RunTranscriptRead = {
  entries: ChatStreamTranscriptEntry[];
  source: TranscriptSource;
  availability: TranscriptAvailability;
  complete?: boolean;
  contentSha256?: string;
};


export function createChatForkTranscriptReader(db: Db, readConversationMessageTranscripts: (
  database: Pick<Db, "select">, messages: readonly MessageRow[],
) => Promise<Map<string, ChatStreamTranscriptEntry[]>>) {
  const transcriptReader = createHistoricalTranscriptReader(db);
  async function readRunTranscriptThroughReader(
    run: Pick<MessageRow, "orgId" | "runId">,
  ): Promise<RunTranscriptRead> {
    if (!run.runId) {
      return { entries: [], source: "legacy", availability: "missing" };
    }
    const entries: ChatStreamTranscriptEntry[] = [];
    const sourceContent: unknown[] = [];
    let sourceBytes = 2;
    let cursor: string | null = null;
    let bytes = 2;
    let source: TranscriptSource = "legacy";
    let availability: TranscriptAvailability = "missing";
    for (let pageCount = 0; pageCount < CHAT_TRANSCRIPT_READER_MAX_PAGES; pageCount += 1) {
      const page = await transcriptReader.readRun({
        orgId: run.orgId,
        runId: run.runId,
        principal: { type: "board", orgId: run.orgId, authorized: true },
        cursor,
        limit: CHAT_TRANSCRIPT_READER_PAGE_LIMIT,
      });
      source = page.source;
      availability = page.availability;
      for (const item of page.items) {
        const content = nativeForkReaderContent(item);
        sourceBytes += Buffer.byteLength(JSON.stringify(content), "utf8") + 1;
        if (sourceContent.length >= CHAT_TRANSCRIPT_READER_MAX_ITEMS || sourceBytes > CHAT_TRANSCRIPT_READER_MAX_BYTES) {
          return { entries, source, availability, complete: false };
        }
        sourceContent.push(content);
        const entry = chatTranscriptEntryFromReaderItem(item);
        if (!entry) continue;
        const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
        if (
          entries.length >= CHAT_TRANSCRIPT_READER_MAX_ITEMS
          || (entries.length > 0 && bytes + entryBytes > CHAT_TRANSCRIPT_READER_MAX_BYTES)
        ) {
          return { entries, source, availability, complete: false };
        }
        if (entries.length === 0 && bytes + entryBytes > CHAT_TRANSCRIPT_READER_MAX_BYTES) {
          return { entries, source, availability, complete: false };
        }
        entries.push(entry);
        bytes += entryBytes + (entries.length > 1 ? 1 : 0);
      }
      if (!page.nextCursor) return { entries, source, availability, complete: true, contentSha256: nativeForkContentHash(sourceContent) };
      if (page.nextCursor === cursor) throw new Error("Transcript reader cursor made no progress");
      cursor = page.nextCursor;
    }
    return { entries, source, availability, complete: false };
  }

  async function loadForkTranscripts(
    database: Pick<Db, "select">,
    messages: readonly MessageRow[],
  ) {
    const byMessageId = new Map<string, readonly ChatStreamTranscriptEntry[]>();
    const nativeSourceByMessageId = new Map<string, NativeChatForkSource>();
    for (const message of messages.filter((row) => row.role === "assistant")) {
      const source = await loadNativeChatForkSource(database, message);
      if (source) nativeSourceByMessageId.set(message.id, source);
    }
    const runReads = new Map<string, RunTranscriptRead>();
    const runIds = [...new Set(messages.map((message) => nativeSourceByMessageId.get(message.id)?.runId ?? message.runId).filter((runId): runId is string => Boolean(runId)))];
    await Promise.all(runIds.map(async (runId) => {
      runReads.set(runId, await readRunTranscriptThroughReader({
        orgId: messages.find((message) => (nativeSourceByMessageId.get(message.id)?.runId ?? message.runId) === runId)?.orgId ?? "",
        runId,
      }));
    }));

    const legacyFallbackMessages: MessageRow[] = [];
    for (const message of messages) {
      const nativeSource = nativeSourceByMessageId.get(message.id);
      if (nativeSource) {
        const read = runReads.get(nativeSource.runId);
        if (!read || !read.complete || !["native", "native_plus_objects"].includes(read.source) || read.availability !== "available") {
          throw unprocessable("Native Fork source transcript is unavailable; retry after recovering its native data");
        }
        const contentSha256 = read.contentSha256!;
        if (nativeSource.contentSha256 && nativeSource.contentSha256 !== contentSha256) throw unprocessable("Native Fork alias content changed");
        nativeSourceByMessageId.set(message.id, { ...nativeSource, contentSha256 });
        byMessageId.set(message.id, []);
        continue;
      }
      if (!message.runId) {
        legacyFallbackMessages.push(message);
        continue;
      }
      const runRead = runReads.get(message.runId);
      if (!runRead || runRead.source === "legacy" && runRead.entries.length === 0) {
        if (runRead?.source !== "native" && runRead?.source !== "native_plus_objects") {
          legacyFallbackMessages.push(message);
        } else {
          // A native Run owns its transcript even when the provider currently
          // has no readable items; suppress the copy helper's payload fallback.
          byMessageId.set(message.id, []);
        }
        continue;
      }
      byMessageId.set(message.id, runRead.entries);
    }

    const legacyTranscripts = await readConversationMessageTranscripts(database, legacyFallbackMessages);
    for (const message of legacyFallbackMessages) {
      const transcript = legacyTranscripts.get(message.id);
      if (transcript) byMessageId.set(message.id, transcript);
    }
    return { transcriptBySourceMessageId: byMessageId, nativeSourceByMessageId };
  }

  async function readCopiedNativeTranscript(row: Pick<MessageRow, "id" | "orgId" | "conversationId" | "runId" | "role">, options: { includeTranscript?: boolean } = {}) {
    if (row.runId || row.role !== "assistant") return null;
    const source = await loadNativeChatForkSource(db, row);
    if (!source) return null;
    // Listing needs only native ownership to suppress legacy payload fallback.
    // Reading and verifying the sealed range belongs to transcript expansion.
    if (options.includeTranscript === false) {
      return { entries: [], source: "native" as const, availability: "available" as const };
    }
    const read = await readRunTranscriptThroughReader({ orgId: row.orgId, runId: source.runId });
    if (read.availability === "available" && (!read.complete || source.contentSha256 !== read.contentSha256)) {
      throw unprocessable("Native Fork alias content no longer matches its sealed source range");
    }
    return ["native", "native_plus_objects"].includes(read.source)
      ? read : { entries: [], source: "native" as const, availability: "missing" as const };
  }

  return { readRunTranscriptThroughReader, loadForkTranscripts, readCopiedNativeTranscript };
}
