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
import { and, asc, eq, lte } from "drizzle-orm";
import type { ChatGenerationProtocolTransaction } from "./chat-generation-protocol.helpers.js";
import { stripChatMetadataFromPayload } from "./chats.helpers.js";
import { normalizeLocalLibraryPathMarkdown } from "./library-path-markdown.js";

type GenerationRow = typeof chatGenerations.$inferSelect;

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
  const events = generationSeq <= 0
    ? []
    : await tx
      .select()
      .from(chatGenerationEvents)
      .where(and(
        eq(chatGenerationEvents.generationId, generationId),
        lte(chatGenerationEvents.generationSeq, generationSeq),
      ))
      .orderBy(asc(chatGenerationEvents.generationSeq));
  let body = "";
  const transcript: ChatStreamTranscriptEntry[] = [];
  let assistantMessageId: string | null = null;
  let runId: string | null = null;
  for (const event of events) {
    if (event.assistantMessageId) assistantMessageId = event.assistantMessageId;
    if (event.runId) runId = event.runId;
    if (event.eventKind === "assistant_delta" && typeof event.payload.delta === "string") {
      body += event.payload.delta;
    } else if (event.eventKind === "runtime_output" && typeof event.payload.body === "string") {
      body = event.payload.body;
    } else if (
      event.eventKind === "transcript"
      && event.payload.entry
      && typeof event.payload.entry === "object"
      && !Array.isArray(event.payload.entry)
    ) {
      transcript.push(withChatTranscriptGenerationProvenance(
        event.payload.entry as ChatStreamTranscriptEntry,
        {
          generationId: event.generationId,
          generationSeq: event.generationSeq,
        },
      ));
    }
  }
  return {
    body,
    transcript: coalesceChatTranscriptTextEntries(transcript),
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
