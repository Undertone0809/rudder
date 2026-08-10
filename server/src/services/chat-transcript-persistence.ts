import type { Db } from "@rudderhq/db";
import {
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
  chatMessageTranscriptEntries,
} from "@rudderhq/db";
import type { ChatStreamTranscriptEntry, ChatTranscriptSummary } from "@rudderhq/shared";
import { withChatTranscriptGenerationProvenance } from "@rudderhq/shared/chat-transcript-provenance";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  chatTranscriptFromPayload,
  chatTranscriptSummaryFromEntries,
} from "./chats.helpers.js";
import { sanitizePostgresJsonValue } from "./postgres-json.js";

type ReadDatabase = Pick<Db, "select">;
type WriteDatabase = Pick<Db, "delete" | "insert" | "select">;

export type ChatTranscriptMessageSource = {
  id: string;
  orgId: string;
  conversationId: string;
  role: string;
  structuredPayload: Record<string, unknown> | null;
};

export type ChatGenerationTranscriptResult = {
  generationIdByMessageId: Map<string, string>;
  generationTerminalReasonByMessageId: Map<string, string | null>;
  transcriptByMessageId: Map<string, ChatStreamTranscriptEntry[]>;
};

export type ChatGenerationSelectionCandidate = {
  generationId: string;
  generationCreatedAt: Date;
  eventRecordedAt: Date;
  generationSeq: number;
};

export function compareChatGenerationSelection(
  left: ChatGenerationSelectionCandidate,
  right: ChatGenerationSelectionCandidate,
) {
  const createdAt = left.generationCreatedAt.getTime() - right.generationCreatedAt.getTime();
  if (createdAt !== 0) return createdAt;
  const recordedAt = left.eventRecordedAt.getTime() - right.eventRecordedAt.getTime();
  if (recordedAt !== 0) return recordedAt;
  if (left.generationSeq !== right.generationSeq) return left.generationSeq - right.generationSeq;
  return left.generationId.localeCompare(right.generationId);
}

function transcriptEntryFromPayload(payload: unknown): ChatStreamTranscriptEntry | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as ChatStreamTranscriptEntry
    : null;
}

export async function listChatGenerationTranscripts(
  database: ReadDatabase,
  messages: readonly ChatTranscriptMessageSource[],
): Promise<ChatGenerationTranscriptResult> {
  const assistantMessageIds = messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.id);
  const empty: ChatGenerationTranscriptResult = {
    generationIdByMessageId: new Map(),
    generationTerminalReasonByMessageId: new Map(),
    transcriptByMessageId: new Map(),
  };
  if (assistantMessageIds.length === 0) return empty;

  const messageById = new Map(messages.map((message) => [message.id, message]));
  const generationMessageRows = await database
    .select({
      assistantMessageId: chatGenerationEvents.assistantMessageId,
      generationId: chatGenerationEvents.generationId,
      generationCreatedAt: chatGenerations.createdAt,
      eventRecordedAt: chatGenerationEvents.recordedAt,
      generationSeq: chatGenerationEvents.generationSeq,
    })
    .from(chatGenerationEvents)
    .innerJoin(chatGenerations, eq(chatGenerations.id, chatGenerationEvents.generationId))
    .where(and(
      inArray(chatGenerationEvents.assistantMessageId, assistantMessageIds),
      inArray(chatGenerationEvents.orgId, [...new Set(messages.map((message) => message.orgId))]),
    ))
    .orderBy(
      desc(chatGenerations.createdAt),
      desc(chatGenerationEvents.recordedAt),
      desc(chatGenerationEvents.generationSeq),
      desc(chatGenerationEvents.generationId),
    );

  const generationIds = [...new Set(generationMessageRows.map((row) => row.generationId))];
  const generationsById = generationIds.length === 0
    ? new Map<string, { orgId: string; conversationId: string; terminalReason: string | null; acceptedThroughSeq: number | null }>()
    : new Map((await database
      .select({
        id: chatGenerations.id,
        orgId: chatGenerations.orgId,
        conversationId: chatGenerations.conversationId,
        terminalReason: chatGenerations.terminalReason,
        acceptedThroughSeq: chatGenerations.acceptedThroughSeq,
      })
      .from(chatGenerations)
      .where(inArray(chatGenerations.id, generationIds)))
      .map((generation) => [generation.id, generation]));

  const generationIdByMessageId = new Map<string, string>();
  const generationTerminalReasonByMessageId = new Map<string, string | null>();
  const selectionByMessageId = new Map<string, ChatGenerationSelectionCandidate>();
  for (const row of generationMessageRows) {
    if (!row.assistantMessageId) continue;
    const message = messageById.get(row.assistantMessageId);
    const generation = generationsById.get(row.generationId);
    if (!message || !generation) continue;
    if (generation.orgId !== message.orgId || generation.conversationId !== message.conversationId) continue;
    const candidate = {
      generationId: row.generationId,
      generationCreatedAt: row.generationCreatedAt,
      eventRecordedAt: row.eventRecordedAt,
      generationSeq: row.generationSeq,
    } satisfies ChatGenerationSelectionCandidate;
    const current = selectionByMessageId.get(row.assistantMessageId);
    if (current && compareChatGenerationSelection(candidate, current) <= 0) continue;
    selectionByMessageId.set(row.assistantMessageId, candidate);
    generationIdByMessageId.set(row.assistantMessageId, row.generationId);
    generationTerminalReasonByMessageId.set(row.assistantMessageId, generation.terminalReason);
  }

  const generationPairs = [...generationIdByMessageId].map(([messageId, generationId]) => ({ messageId, generationId }));
  if (generationPairs.length === 0) {
    return { generationIdByMessageId, generationTerminalReasonByMessageId, transcriptByMessageId: new Map() };
  }

  const selectedGenerationCondition = or(...generationPairs.map(({ messageId, generationId }) => and(
    eq(chatGenerationEvents.assistantMessageId, messageId),
    eq(chatGenerationEvents.generationId, generationId),
  )));
  const transcriptRows = await database
    .select({
      assistantMessageId: chatGenerationEvents.assistantMessageId,
      generationId: chatGenerationEvents.generationId,
      generationSeq: chatGenerationEvents.generationSeq,
      payload: chatGenerationEvents.payload,
    })
    .from(chatGenerationEvents)
    .innerJoin(chatGenerations, eq(chatGenerations.id, chatGenerationEvents.generationId))
    .where(and(
      selectedGenerationCondition,
      eq(chatGenerationEvents.eventKind, "transcript"),
      or(
        isNull(chatGenerations.acceptedThroughSeq),
        lte(chatGenerationEvents.generationSeq, chatGenerations.acceptedThroughSeq),
      ),
    ))
    .orderBy(asc(chatGenerationEvents.generationId), asc(chatGenerationEvents.generationSeq));

  const transcriptByMessageId = new Map<string, ChatStreamTranscriptEntry[]>();
  for (const row of transcriptRows) {
    if (!row.assistantMessageId) continue;
    const entry = transcriptEntryFromPayload(row.payload.entry);
    if (!entry) continue;
    const provenancedEntry = withChatTranscriptGenerationProvenance(entry, {
      generationId: row.generationId,
      generationSeq: row.generationSeq,
    });
    const transcript = transcriptByMessageId.get(row.assistantMessageId);
    if (transcript) transcript.push(provenancedEntry);
    else transcriptByMessageId.set(row.assistantMessageId, [provenancedEntry]);
  }

  return {
    generationIdByMessageId,
    generationTerminalReasonByMessageId,
    transcriptByMessageId,
  };
}

export async function listDetachedChatTranscripts(
  database: ReadDatabase,
  messages: readonly Pick<ChatTranscriptMessageSource, "id" | "orgId">[],
) {
  if (messages.length === 0) return new Map<string, ChatStreamTranscriptEntry[]>();
  const rows = await database
    .select({
      messageId: chatMessageTranscriptEntries.messageId,
      entrySeq: chatMessageTranscriptEntries.entrySeq,
      payload: chatMessageTranscriptEntries.payload,
    })
    .from(chatMessageTranscriptEntries)
    .innerJoin(chatMessages, and(
      eq(chatMessageTranscriptEntries.messageId, chatMessages.id),
      eq(chatMessageTranscriptEntries.orgId, chatMessages.orgId),
    ))
    .where(and(
      inArray(chatMessageTranscriptEntries.messageId, messages.map((message) => message.id)),
      or(...messages.map((message) => and(
        eq(chatMessageTranscriptEntries.messageId, message.id),
        eq(chatMessageTranscriptEntries.orgId, message.orgId),
      ))),
    ))
    .orderBy(asc(chatMessageTranscriptEntries.messageId), asc(chatMessageTranscriptEntries.entrySeq));
  const byMessageId = new Map<string, ChatStreamTranscriptEntry[]>();
  for (const row of rows) {
    const entry = transcriptEntryFromPayload(row.payload);
    if (!entry) continue;
    const transcript = byMessageId.get(row.messageId);
    if (transcript) transcript.push(entry);
    else byMessageId.set(row.messageId, [entry]);
  }
  return byMessageId;
}

export async function loadChatTranscripts(
  database: ReadDatabase,
  messages: readonly ChatTranscriptMessageSource[],
) {
  const [generation, detached] = await Promise.all([
    listChatGenerationTranscripts(database, messages),
    listDetachedChatTranscripts(database, messages),
  ]);
  const byMessageId = new Map<string, ChatStreamTranscriptEntry[]>();
  for (const message of messages) {
    const transcript = selectChatTranscript({
      ledger: generation.transcriptByMessageId.get(message.id),
      detached: detached.get(message.id),
      legacyPayload: message.structuredPayload,
    });
    if (transcript.length > 0) byMessageId.set(message.id, transcript);
  }
  return byMessageId;
}

export async function listDetachedChatTranscriptSummaries(
  database: ReadDatabase,
  messages: readonly Pick<ChatTranscriptMessageSource, "id" | "orgId">[],
) {
  if (messages.length === 0) return new Map<string, ChatTranscriptSummary>();
  const rows = await database
    .select({
      messageId: chatMessageTranscriptEntries.messageId,
      entryCount: sql<number>`count(*)::int`,
      startedAt: sql<string | null>`min(${chatMessageTranscriptEntries.payload}->>'ts')`,
      endedAt: sql<string | null>`max(${chatMessageTranscriptEntries.payload}->>'ts')`,
    })
    .from(chatMessageTranscriptEntries)
    .innerJoin(chatMessages, and(
      eq(chatMessageTranscriptEntries.messageId, chatMessages.id),
      eq(chatMessageTranscriptEntries.orgId, chatMessages.orgId),
    ))
    .where(and(
      inArray(chatMessageTranscriptEntries.messageId, messages.map((message) => message.id)),
      or(...messages.map((message) => and(
        eq(chatMessageTranscriptEntries.messageId, message.id),
        eq(chatMessageTranscriptEntries.orgId, message.orgId),
      ))),
    ))
    .groupBy(chatMessageTranscriptEntries.messageId);
  return new Map(rows.map((row) => [row.messageId, {
    entryCount: Number(row.entryCount),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  }]));
}

export async function replaceDetachedChatTranscript(
  database: WriteDatabase,
  input: {
    orgId: string;
    messageId: string;
    entries: readonly ChatStreamTranscriptEntry[];
  },
) {
  const message = await database
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.id, input.messageId),
      eq(chatMessages.orgId, input.orgId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!message) throw new Error("Cannot persist transcript for a message outside the organization");
  await database
    .delete(chatMessageTranscriptEntries)
    .where(and(
      eq(chatMessageTranscriptEntries.orgId, input.orgId),
      eq(chatMessageTranscriptEntries.messageId, input.messageId),
    ));
  if (input.entries.length === 0) return;
  await database
    .insert(chatMessageTranscriptEntries)
    .values(input.entries.map((entry, entrySeq) => ({
      orgId: input.orgId,
      messageId: input.messageId,
      entrySeq,
      payload: sanitizePostgresJsonValue(entry) as Record<string, unknown>,
    })))
    .onConflictDoNothing();
}

export async function clearDetachedChatTranscript(
  database: WriteDatabase,
  input: { orgId: string; messageId: string },
) {
  const message = await database
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.id, input.messageId),
      eq(chatMessages.orgId, input.orgId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!message) throw new Error("Cannot clear transcript for a message outside the organization");
  await database
    .delete(chatMessageTranscriptEntries)
    .where(and(
      eq(chatMessageTranscriptEntries.orgId, input.orgId),
      eq(chatMessageTranscriptEntries.messageId, input.messageId),
    ));
}

export function selectChatTranscript(
  input: {
    ledger: readonly ChatStreamTranscriptEntry[] | undefined;
    detached: readonly ChatStreamTranscriptEntry[] | undefined;
    legacyPayload: Record<string, unknown> | null | undefined;
  },
) {
  if (input.ledger && input.ledger.length > 0) return [...input.ledger];
  if (input.detached && input.detached.length > 0) return [...input.detached];
  return chatTranscriptFromPayload(input.legacyPayload);
}

export function transcriptSummaryFromSources(
  input: {
    ledger: readonly ChatStreamTranscriptEntry[] | undefined;
    detached: readonly ChatStreamTranscriptEntry[] | undefined;
    legacyPayload: Record<string, unknown> | null | undefined;
    detachedSummary?: ChatTranscriptSummary | null;
  },
) {
  if (input.ledger && input.ledger.length > 0) return chatTranscriptSummaryFromEntries([...input.ledger]);
  if (input.detached && input.detached.length > 0) return chatTranscriptSummaryFromEntries([...input.detached]);
  if (input.detachedSummary) return input.detachedSummary;
  return chatTranscriptSummaryFromEntries(chatTranscriptFromPayload(input.legacyPayload));
}
