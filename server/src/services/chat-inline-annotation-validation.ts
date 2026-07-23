import type { Db } from "@rudderhq/db";
import {
  chatAttachments,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
} from "@rudderhq/db";
import { withChatTranscriptGenerationProvenance } from "@rudderhq/shared/chat-transcript-provenance";
import {
  type ChatInlineAnnotation,
  type ChatStreamTranscriptTextEntry,
} from "@rudderhq/shared";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { createHash } from "node:crypto";
import { unprocessable } from "../errors.js";
import type { ChatGenerationProtocolTransaction } from "./chat-generation-protocol.helpers.js";
import { chatTranscriptFromPayload } from "./chats.helpers.js";

const STABLE_ANNOTATION_MESSAGE_STATUSES = new Set(["completed", "stopped", "failed"]);
const STABLE_ANNOTATION_GENERATION_STATUSES = new Set(["completed", "stopped", "failed"]);
const MAX_PROCESS_ANNOTATION_EVENT_SPAN = 1_000;

type ValidationQuery = Pick<ChatGenerationProtocolTransaction, "select">;

export function hashChatAnnotationSource(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSourceAnchor(
  annotation: ChatInlineAnnotation,
  source: string,
) {
  if (annotation.sourceHash !== hashChatAnnotationSource(source)) {
    throw unprocessable("Annotation source hash does not match persisted source");
  }
  if (
    annotation.start < 0
    || annotation.end <= annotation.start
    || annotation.end > source.length
  ) {
    throw unprocessable("Annotation source range is outside persisted source bounds");
  }
  const actualPrefix = source.slice(
    Math.max(0, annotation.start - annotation.prefix.length),
    annotation.start,
  );
  if (actualPrefix !== annotation.prefix) {
    throw unprocessable("Annotation prefix no longer matches persisted source");
  }
  const actualSuffix = source.slice(
    annotation.end,
    annotation.end + annotation.suffix.length,
  );
  if (actualSuffix !== annotation.suffix) {
    throw unprocessable("Annotation suffix no longer matches persisted source");
  }
}

function processAnnotationSource(entries: ChatStreamTranscriptTextEntry[]) {
  let source = "";
  let previous: ChatStreamTranscriptTextEntry | null = null;
  for (const entry of entries) {
    if (!previous) {
      source = entry.text;
    } else {
      const continuesDelta = previous.delta === true && entry.delta === true;
      source += continuesDelta || source.endsWith("\n") || entry.text.startsWith("\n")
        ? entry.text
        : `\n${entry.text}`;
    }
    previous = entry;
  }
  return source;
}

function isExplicitlyHiddenTranscriptEvidence(
  eventPayload: Record<string, unknown>,
  entry: Record<string, unknown>,
) {
  const visibility = typeof eventPayload.visibility === "string"
    ? eventPayload.visibility.toLowerCase()
    : typeof entry.visibility === "string"
      ? entry.visibility.toLowerCase()
      : "";
  return eventPayload.internal === true
    || eventPayload.hidden === true
    || eventPayload.visible === false
    || entry.internal === true
    || entry.hidden === true
    || entry.visible === false
    || visibility === "internal"
    || visibility === "hidden"
    || visibility === "private";
}

function rawSelectionContainsMarkdownSyntax(value: string) {
  return /(?:`|\[[^\]]*\]\([^)]*\)|[*_~]|^#{1,6}\s|^\s*(?:[-+>]|\d+\.)\s)/m.test(value);
}

function assertPlainProcessSelectionMatchesRange(
  annotation: Extract<ChatInlineAnnotation, { surface: "process_transcript" }>,
  source: string,
) {
  const rawSelection = source.slice(annotation.start, annotation.end);
  if (
    !rawSelectionContainsMarkdownSyntax(rawSelection)
    && annotation.selectedText !== rawSelection
  ) {
    throw unprocessable("Process annotation selected text does not match its declared source range");
  }
}

async function validateExistingAttachmentOwnership(
  query: ValidationQuery,
  input: {
    orgId: string;
    conversationId: string;
    editUserMessageId?: string | null;
    annotations: readonly ChatInlineAnnotation[];
  },
) {
  const attachmentIds = input.annotations.flatMap((annotation) => annotation.attachmentIds);
  if (attachmentIds.length === 0) return;
  if (!input.editUserMessageId) {
    throw unprocessable("Existing annotation attachments require an edited user message");
  }
  const target = await query
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.id, input.editUserMessageId))
    .limit(1)
    .for("share")
    .then((rows) => rows[0] ?? null);
  if (
    !target
    || target.orgId !== input.orgId
    || target.conversationId !== input.conversationId
    || target.role !== "user"
    || target.kind !== "message"
    || target.supersededAt
  ) {
    throw unprocessable("Edited annotation message must be a visible user message in this conversation");
  }
  const ownedIds = await query
    .select({ id: chatAttachments.id })
    .from(chatAttachments)
    .where(and(
      eq(chatAttachments.orgId, input.orgId),
      eq(chatAttachments.conversationId, input.conversationId),
      eq(chatAttachments.messageId, target.id),
      inArray(chatAttachments.id, attachmentIds),
    ))
    .for("share");
  if (ownedIds.length !== attachmentIds.length) {
    throw unprocessable("Annotation attachments must belong to the edited user message");
  }
}

async function validateSourceMessage(
  query: ValidationQuery,
  input: {
    orgId: string;
    conversationId: string;
    annotation: ChatInlineAnnotation;
  },
) {
  if (input.annotation.sourceConversationId !== input.conversationId) {
    throw unprocessable("Annotation source conversation must match the target conversation");
  }
  const source = await query
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.id, input.annotation.sourceMessageId))
    .limit(1)
    .for("share")
    .then((rows) => rows[0] ?? null);
  if (
    !source
    || source.orgId !== input.orgId
    || source.conversationId !== input.annotation.sourceConversationId
  ) {
    throw unprocessable("Annotation source message must belong to the conversation and organization");
  }
  if (source.role !== "assistant" || source.kind !== "message") {
    throw unprocessable("Annotation source must be an assistant response");
  }
  if (!STABLE_ANNOTATION_MESSAGE_STATUSES.has(source.status)) {
    throw unprocessable("Annotation source must have a stable completed, stopped, or failed status");
  }
  if (source.supersededAt) {
    throw unprocessable("Annotation source must remain visible in the active conversation branch");
  }
  return source;
}

async function validateProcessAnnotation(
  query: ValidationQuery,
  input: {
    orgId: string;
    conversationId: string;
    annotation: Extract<ChatInlineAnnotation, { surface: "process_transcript" }>;
    sourceMessage: typeof chatMessages.$inferSelect;
  },
) {
  const generation = await query
    .select()
    .from(chatGenerations)
    .where(eq(chatGenerations.id, input.annotation.generationId))
    .limit(1)
    .for("share")
    .then((rows) => rows[0] ?? null);
  if (
    !generation
    || generation.orgId !== input.orgId
    || generation.conversationId !== input.conversationId
  ) {
    throw unprocessable("Annotation generation must belong to the source conversation and organization");
  }
  if (!STABLE_ANNOTATION_GENERATION_STATUSES.has(generation.status)) {
    throw unprocessable("Process annotation generation must be terminal");
  }
  const eventSpan = input.annotation.generationSeqEnd - input.annotation.generationSeqStart + 1;
  if (eventSpan <= 0 || eventSpan > MAX_PROCESS_ANNOTATION_EVENT_SPAN) {
    throw unprocessable("Process annotation evidence range is invalid or too large");
  }
  const events = await query
    .select()
    .from(chatGenerationEvents)
    .where(and(
      eq(chatGenerationEvents.orgId, input.orgId),
      eq(chatGenerationEvents.generationId, generation.id),
      gte(chatGenerationEvents.generationSeq, input.annotation.generationSeqStart),
      lte(chatGenerationEvents.generationSeq, input.annotation.generationSeqEnd),
    ))
    .orderBy(asc(chatGenerationEvents.generationSeq))
    .for("share");
  if (
    events.length !== eventSpan
    || events[0]?.generationSeq !== input.annotation.generationSeqStart
    || events.at(-1)?.generationSeq !== input.annotation.generationSeqEnd
  ) {
    throw unprocessable("Process annotation evidence is missing from the declared generation range");
  }
  const textEntries: ChatStreamTranscriptTextEntry[] = [];
  for (const event of events) {
    const rawEntry = event.payload.entry;
    if (
      event.eventKind !== "transcript"
      || event.assistantMessageId !== input.sourceMessage.id
      || !rawEntry
      || typeof rawEntry !== "object"
      || Array.isArray(rawEntry)
    ) {
      throw unprocessable("Process annotation range must contain only visible transcript evidence");
    }
    const entry = rawEntry as Record<string, unknown>;
    if (
      isExplicitlyHiddenTranscriptEvidence(event.payload, entry)
      || entry.kind !== input.annotation.transcriptKind
      || (entry.kind !== "assistant" && entry.kind !== "thinking")
      || typeof entry.text !== "string"
      || entry.text.trim().length === 0
    ) {
      throw unprocessable("Process annotation range must contain only visible assistant or thinking prose");
    }
    textEntries.push(withChatTranscriptGenerationProvenance(
      {
        kind: entry.kind,
        ts: typeof entry.ts === "string" ? entry.ts : event.recordedAt.toISOString(),
        text: entry.text,
        ...(entry.delta === true ? { delta: true } : {}),
      },
      { generationId: generation.id, generationSeq: event.generationSeq },
    ));
  }
  const source = processAnnotationSource(textEntries);
  const projectedEntry = chatTranscriptFromPayload(input.sourceMessage.structuredPayload)
    .find((entry) =>
      entry.kind === input.annotation.transcriptKind
      && entry.generationId === generation.id
      && entry.generationSeqStart === input.annotation.generationSeqStart
      && entry.generationSeqEnd === input.annotation.generationSeqEnd
      && entry.text === source
    );
  if (!projectedEntry) {
    throw unprocessable("Process annotation evidence is not present in the visible message projection");
  }
  assertPlainProcessSelectionMatchesRange(input.annotation, source);
  return source;
}

export async function validateCanonicalChatInlineAnnotations(
  query: ValidationQuery,
  input: {
    orgId: string;
    conversationId: string;
    annotations: readonly ChatInlineAnnotation[];
    uploadedFileCount: number;
    attachmentFileIndexesByAnnotationId?: ReadonlyMap<string, readonly number[]>;
    editUserMessageId?: string | null;
  },
) {
  for (const annotation of input.annotations) {
    const indexes = input.attachmentFileIndexesByAnnotationId?.get(annotation.id) ?? [];
    for (const fileIndex of indexes) {
      if (fileIndex < 0 || fileIndex >= input.uploadedFileCount) {
        throw unprocessable("Annotation file index does not match an uploaded file");
      }
    }
  }
  await validateExistingAttachmentOwnership(query, input);
  for (const annotation of input.annotations) {
    const source = await validateSourceMessage(query, {
      orgId: input.orgId,
      conversationId: input.conversationId,
      annotation,
    });
    const anchorSource = annotation.surface === "assistant_body"
      ? source.body
      : await validateProcessAnnotation(query, {
        orgId: input.orgId,
        conversationId: input.conversationId,
        annotation,
        sourceMessage: source,
      });
    assertSourceAnchor(annotation, anchorSource);
  }
}

export function asChatInlineAnnotationValidationQuery(
  db: Db,
): ValidationQuery {
  return db;
}
