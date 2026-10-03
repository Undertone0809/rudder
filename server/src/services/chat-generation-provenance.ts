import {
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
} from "@rudderhq/db";
import type { ChatStreamTranscriptEntry } from "@rudderhq/shared";
import {
  coalesceChatTranscriptTextEntries,
  withChatTranscriptGenerationProvenance,
} from "@rudderhq/shared/chat-transcript-provenance";
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { ChatGenerationProtocolTransaction } from "./chat-generation-protocol.helpers.js";
import { stripChatMetadataFromPayload } from "./chats.helpers.js";
import { normalizeLocalLibraryPathMarkdown } from "./library-path-markdown.js";

type GenerationRow = typeof chatGenerations.$inferSelect;

export const CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS = {
  entries: 128,
  bytes: 128 * 1024,
} as const;

const GENERATION_EVENT_PAGE_SIZE = 128;
const TRANSCRIPT_PROVENANCE_HEADROOM_BYTES = 256;

function transcriptEntryLimit(kind: string | null) {
  return kind === "assistant" || kind === "thinking"
    ? CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes - TRANSCRIPT_PROVENANCE_HEADROOM_BYTES
    : CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes;
}

function transcriptEntryBytes(entry: ChatStreamTranscriptEntry) {
  try {
    return Buffer.byteLength(JSON.stringify(entry), "utf8");
  } catch {
    return CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes;
  }
}

function appendBoundedTranscriptEntry(
  transcript: ChatStreamTranscriptEntry[],
  entry: ChatStreamTranscriptEntry,
) {
  const previous = transcript.at(-1);
  if (
    (previous?.kind === "assistant" || previous?.kind === "thinking")
    && (entry.kind === "assistant" || entry.kind === "thinking")
    && typeof previous.text === "string"
    && typeof entry.text === "string"
  ) {
    const coalescedEmpty = coalesceChatTranscriptTextEntries([
      { ...previous, text: "" },
      { ...entry, text: "" },
    ]);
    if (coalescedEmpty.length === 1) {
      const mergedBytes = transcriptEntryBytes(coalescedEmpty[0]!)
        + Buffer.byteLength(JSON.stringify(previous.text), "utf8")
        + Buffer.byteLength(JSON.stringify(entry.text), "utf8") - 4;
      if (mergedBytes <= CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes) {
        transcript[transcript.length - 1] = {
          ...coalescedEmpty[0]!,
          text: previous.text + entry.text,
        } as ChatStreamTranscriptEntry;
      } else {
        transcript.push(entry);
      }
    } else {
      transcript.push(entry);
    }
  } else {
    transcript.push(entry);
  }

  while (transcript.length > CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.entries) transcript.shift();
  let bytes = 0;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    bytes += transcriptEntryBytes(transcript[index]!);
    if (bytes <= CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes) continue;
    transcript.splice(0, index + 1);
    break;
  }
}

export type VisibleGenerationProjection = {
  body: string;
  transcript: ChatStreamTranscriptEntry[];
  assistantMessageId: string | null;
  runId: string | null;
};

export async function visibleGenerationProjectionThrough(
  tx: ChatGenerationProtocolTransaction,
  generationId: string,
  generationSeq: number,
): Promise<VisibleGenerationProjection> {
  let body = "";
  const transcript: ChatStreamTranscriptEntry[] = [];
  let assistantMessageId: string | null = null;
  let runId: string | null = null;
  let afterSeq = 0;
  let transcriptBatchSeqs: number[] = [];
  let transcriptBatchBytes = 0;
  const flushTranscriptBatch = async () => {
    if (transcriptBatchSeqs.length === 0) return;
    const entries = await tx
      .select({
        generationSeq: chatGenerationEvents.generationSeq,
        entry: sql<ChatStreamTranscriptEntry | null>`
          case when ${chatGenerationEvents.eventKind} = 'transcript'
            and jsonb_typeof(${chatGenerationEvents.payload}->'entry') = 'object'
            and octet_length((${chatGenerationEvents.payload}->'entry')::text)
              <= case when (${chatGenerationEvents.payload}->'entry'->>'kind') in ('assistant', 'thinking')
                then ${CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes - TRANSCRIPT_PROVENANCE_HEADROOM_BYTES}::integer
                else ${CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes}::integer end
          then ${chatGenerationEvents.payload}->'entry' else null end
        `,
      })
      .from(chatGenerationEvents)
      .where(and(
        eq(chatGenerationEvents.generationId, generationId),
        inArray(chatGenerationEvents.generationSeq, transcriptBatchSeqs),
      ))
      .orderBy(asc(chatGenerationEvents.generationSeq));
    for (const { generationSeq: entrySeq, entry } of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      appendBoundedTranscriptEntry(
        transcript,
        withChatTranscriptGenerationProvenance(entry, { generationId, generationSeq: entrySeq }),
      );
    }
    transcriptBatchSeqs = [];
    transcriptBatchBytes = 0;
  };

  while (afterSeq < generationSeq) {
    const events = await tx
      .select({
        generationSeq: chatGenerationEvents.generationSeq,
        assistantMessageId: chatGenerationEvents.assistantMessageId,
        runId: chatGenerationEvents.runId,
        eventKind: chatGenerationEvents.eventKind,
        bodyPart: sql<string | null>`
          case when ${chatGenerationEvents.eventKind} = 'assistant_delta'
            and jsonb_typeof(${chatGenerationEvents.payload}->'delta') = 'string'
            then ${chatGenerationEvents.payload}->>'delta'
          when ${chatGenerationEvents.eventKind} = 'runtime_output'
            and jsonb_typeof(${chatGenerationEvents.payload}->'body') = 'string'
            then ${chatGenerationEvents.payload}->>'body'
          else null end
        `,
        transcriptEntryBytes: sql<number | null>`
          case when ${chatGenerationEvents.eventKind} = 'transcript'
            and jsonb_typeof(${chatGenerationEvents.payload}->'entry') = 'object'
            then octet_length((${chatGenerationEvents.payload}->'entry')::text)
          else null end
        `,
        transcriptEntryKind: sql<string | null>`
          case when ${chatGenerationEvents.eventKind} = 'transcript'
            and jsonb_typeof(${chatGenerationEvents.payload}->'entry') = 'object'
            then ${chatGenerationEvents.payload}->'entry'->>'kind'
          else null end
        `,
      })
      .from(chatGenerationEvents)
      .where(and(
        eq(chatGenerationEvents.generationId, generationId),
        gt(chatGenerationEvents.generationSeq, afterSeq),
        lte(chatGenerationEvents.generationSeq, generationSeq),
      ))
      .orderBy(asc(chatGenerationEvents.generationSeq))
      .limit(GENERATION_EVENT_PAGE_SIZE);
    if (events.length === 0) break;

    for (const event of events) {
      if (event.assistantMessageId) assistantMessageId = event.assistantMessageId;
      if (event.runId) runId = event.runId;
      if (event.eventKind === "assistant_delta" && event.bodyPart !== null) {
        body += event.bodyPart;
      } else if (event.eventKind === "runtime_output" && event.bodyPart !== null) {
        body = event.bodyPart;
      }

      const entryBytes = event.transcriptEntryBytes;
      if (entryBytes === null) continue;
      if (entryBytes > transcriptEntryLimit(event.transcriptEntryKind)) {
        await flushTranscriptBatch();
        transcript.length = 0;
        continue;
      }
      if (transcriptBatchBytes + entryBytes > CHAT_GENERATION_TRANSCRIPT_MEMORY_LIMITS.bytes) {
        await flushTranscriptBatch();
      }
      transcriptBatchSeqs.push(event.generationSeq);
      transcriptBatchBytes += entryBytes;
    }
    await flushTranscriptBatch();
    afterSeq = events.at(-1)!.generationSeq;
  }
  return {
    body,
    transcript,
    assistantMessageId,
    runId,
  };
}

export async function freezeAssistantMessageProjection(
  tx: ChatGenerationProtocolTransaction,
  generation: GenerationRow,
  acceptedThroughSeq: number,
) {
  const projection = await visibleGenerationProjectionThrough(
    tx,
    generation.id,
    acceptedThroughSeq,
  );
  if (!projection.assistantMessageId) return projection;
  const existing = await tx
    .select()
    .from(chatMessages)
    .where(and(
      eq(chatMessages.id, projection.assistantMessageId),
      eq(chatMessages.orgId, generation.orgId),
      eq(chatMessages.conversationId, generation.conversationId),
      eq(chatMessages.role, "assistant"),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!existing) return projection;
  const durableBody = await normalizeLocalLibraryPathMarkdown(
    projection.body,
    generation.orgId,
  );
  await tx
    .update(chatMessages)
    .set({
      status: "stopped",
      body: durableBody,
      structuredPayload: projection.transcript.length > 0
        ? stripChatMetadataFromPayload(existing.structuredPayload)
        : existing.structuredPayload,
      ...(projection.runId ? { runId: projection.runId } : {}),
      updatedAt: new Date(),
    })
    .where(eq(chatMessages.id, existing.id));
  return projection;
}

export async function failOrphanedControlLostMessage(
  tx: ChatGenerationProtocolTransaction,
  generation: GenerationRow,
  now: Date,
) {
  const projected = await tx.select({ messageId: chatGenerationEvents.assistantMessageId })
    .from(chatGenerationEvents)
    .where(and(
      eq(chatGenerationEvents.generationId, generation.id),
      isNotNull(chatGenerationEvents.assistantMessageId),
    ))
    .orderBy(desc(chatGenerationEvents.generationSeq))
    .limit(1).then((rows) => rows[0] ?? null);
  if (!projected?.messageId) return;
  await tx.update(chatMessages).set({
    status: "failed",
    body: sql<string>`case when btrim(${chatMessages.body}) = ''
      then 'Chat generation lost its runtime owner before a reply was finalized.'
      else ${chatMessages.body} end`,
    updatedAt: now,
  }).where(and(
    eq(chatMessages.id, projected.messageId),
    eq(chatMessages.orgId, generation.orgId),
    eq(chatMessages.conversationId, generation.conversationId),
    eq(chatMessages.role, "assistant"),
    eq(chatMessages.status, "streaming"),
  ));
}
