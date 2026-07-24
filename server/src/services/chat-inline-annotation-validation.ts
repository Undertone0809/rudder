import type { Db } from "@rudderhq/db";
import {
  chatAttachments,
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
} from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  isInternalChatTranscriptLifecycleEntry,
  type ChatInlineAnnotation,
  type ChatStreamTranscriptEntry,
  type ChatStreamTranscriptTextEntry,
} from "@rudderhq/shared";
import { withChatTranscriptGenerationProvenance } from "@rudderhq/shared/chat-transcript-provenance";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { createHash } from "node:crypto";
import { unprocessable } from "../errors.js";
import type { ChatGenerationProtocolTransaction } from "./chat-generation-protocol.helpers.js";
import { renderedMarkdownSelectionText } from "./chat-inline-annotation-rendering.js";
import { renderedMarkdownSelectionTextWithResolvedLabels } from "./chat-inline-annotation-resolved-labels.js";
import { chatTranscriptFromPayload } from "./chats.helpers.js";

const STABLE_ANNOTATION_MESSAGE_STATUSES = new Set(["completed", "stopped", "failed"]);
const STABLE_ANNOTATION_GENERATION_STATUSES = new Set(["completed", "stopped", "failed"]);
const MAX_PROCESS_ANNOTATION_EVENT_SPAN = 1_000;
const INTERNAL_RESULT_MARKER_PATTERN =
  /RUDDER_RESULT_(?:BEGIN|END)|__RUDDER_RESULT_[a-f0-9-]+__/i;

export type ValidationQuery = Pick<ChatGenerationProtocolTransaction, "select">;

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

async function assertSelectedTextExactlyMatchesRange(
  query: ValidationQuery,
  orgId: string,
  annotation: ChatInlineAnnotation,
  source: string,
) {
  const resolvedLabelProjection =
    await renderedMarkdownSelectionTextWithResolvedLabels(query, {
      orgId,
      source,
      start: annotation.start,
      end: annotation.end,
    });
  const visibleResolvedSelections = resolvedLabelProjection.selections.filter(
    (selection) => /[^\p{White_Space}\u200b\ufeff]/u.test(selection),
  );
  if (visibleResolvedSelections.includes(annotation.selectedText)) return;
  if (resolvedLabelProjection.overlapsResolvableDynamicLabel) {
    throw unprocessable(
      "Annotation selected text does not exactly match its rendered Markdown source range",
    );
  }
  const expectedSelectedText = renderedMarkdownSelectionText(
    source,
    annotation.start,
    annotation.end,
  );
  const rawRangeContainsVisibleText = expectedSelectedText !== null
    && /[^\p{White_Space}\u200b\ufeff]/u.test(expectedSelectedText);
  if (
    rawRangeContainsVisibleText
    && annotation.selectedText === expectedSelectedText
  ) return;
  if (!rawRangeContainsVisibleText && visibleResolvedSelections.length === 0) {
    throw unprocessable("Annotation source range must contain visible text");
  }
  throw unprocessable(
    "Annotation selected text does not exactly match its rendered Markdown source range",
  );
}

function trimTrailingWhitespace(value: string) {
  return value.replace(/\s+$/g, "");
}

function redactAssistantSuffixFromVisibleProjection(
  entries: ChatStreamTranscriptEntry[],
  hiddenAssistantMessageText: string,
) {
  let remaining = trimTrailingWhitespace(hiddenAssistantMessageText);
  if (!remaining) return entries;

  const nextEntries: ChatStreamTranscriptEntry[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "assistant" || !remaining) {
      nextEntries.push(entry);
      continue;
    }

    const entryText = trimTrailingWhitespace(entry.text);
    remaining = trimTrailingWhitespace(remaining);
    if (!entryText) {
      nextEntries.push(entry);
      continue;
    }
    if (remaining.endsWith(entryText)) {
      remaining = trimTrailingWhitespace(
        remaining.slice(0, remaining.length - entryText.length),
      );
      continue;
    }
    if (entryText.endsWith(remaining)) {
      const visibleText = trimTrailingWhitespace(
        entryText.slice(0, entryText.length - remaining.length),
      );
      remaining = "";
      if (visibleText) nextEntries.push({ ...entry, text: visibleText });
      continue;
    }
    nextEntries.push(entry);
  }

  return remaining ? entries : nextEntries.reverse();
}

function transcriptEntriesBeforeAssistantTextIndex(
  entries: ChatStreamTranscriptEntry[],
  endIndex: number,
) {
  const visible: ChatStreamTranscriptEntry[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (entry.kind !== "assistant") {
      visible.push(entry);
      continue;
    }
    const entryEnd = offset + entry.text.length;
    if (entryEnd <= endIndex) {
      visible.push(entry);
    } else if (offset < endIndex) {
      const text = trimTrailingWhitespace(entry.text.slice(0, endIndex - offset));
      if (text) visible.push({ ...entry, text });
      break;
    } else {
      break;
    }
    offset = entryEnd;
  }
  return visible;
}

function stripInternalResultProtocolFromVisibleProjection(
  entries: ChatStreamTranscriptEntry[],
) {
  const filtered: ChatStreamTranscriptEntry[] = [];
  let assistantGroup: ChatStreamTranscriptEntry[] = [];

  const flushAssistantGroup = () => {
    if (assistantGroup.length === 0) return;
    const markerIndex = assistantGroup
      .filter((entry): entry is ChatStreamTranscriptTextEntry => entry.kind === "assistant")
      .map((entry) => entry.text)
      .join("")
      .search(INTERNAL_RESULT_MARKER_PATTERN);
    filtered.push(...(
      markerIndex < 0
        ? assistantGroup
        : transcriptEntriesBeforeAssistantTextIndex(assistantGroup, markerIndex)
    ));
    assistantGroup = [];
  };

  for (const entry of entries) {
    if (entry.kind === "assistant") {
      assistantGroup.push(entry);
      continue;
    }
    if (
      assistantGroup.length > 0
      && entry.kind === "system"
      && isInternalChatTranscriptLifecycleEntry(entry)
    ) {
      assistantGroup.push(entry);
      continue;
    }
    flushAssistantGroup();
    filtered.push(entry);
  }
  flushAssistantGroup();
  return filtered;
}

function visibleChatTranscriptProjection(
  entries: ChatStreamTranscriptEntry[],
  hiddenAssistantMessageText: string,
) {
  return stripInternalResultProtocolFromVisibleProjection(
    redactAssistantSuffixFromVisibleProjection(entries, hiddenAssistantMessageText),
  );
}

function annotationSnapshotsAreSemanticallyIdentical(
  incoming: readonly ChatInlineAnnotation[],
  persisted: readonly ChatInlineAnnotation[],
) {
  if (incoming.length !== persisted.length) return false;
  return incoming.every((annotation, index) => {
    const expected = persisted[index];
    if (!expected) return false;
    if (
      annotation.id !== expected.id
      || annotation.surface !== expected.surface
      || annotation.selectedText !== expected.selectedText
      || (annotation.comment ?? null) !== (expected.comment ?? null)
      || annotation.sourceConversationId !== expected.sourceConversationId
      || annotation.sourceMessageId !== expected.sourceMessageId
      || annotation.sourceHash !== expected.sourceHash
      || annotation.start !== expected.start
      || annotation.end !== expected.end
      || annotation.prefix !== expected.prefix
      || annotation.suffix !== expected.suffix
      || annotation.attachmentIds.length !== expected.attachmentIds.length
      || annotation.attachmentIds.some(
        (attachmentId, attachmentIndex) =>
          attachmentId !== expected.attachmentIds[attachmentIndex],
      )
    ) {
      return false;
    }
    if (annotation.surface === "assistant_body") {
      return expected.surface === "assistant_body";
    }
    return expected.surface === "process_transcript"
      && annotation.transcriptKind === expected.transcriptKind
      && annotation.generationId === expected.generationId
      && annotation.generationSeqStart === expected.generationSeqStart
      && annotation.generationSeqEnd === expected.generationSeqEnd;
  });
}

async function validateHistoricalAnnotationSnapshot(
  query: ValidationQuery,
  input: {
    orgId: string;
    conversationId: string;
    editUserMessageId?: string | null;
    annotations: readonly ChatInlineAnnotation[];
    attachmentFileIndexesByAnnotationId?: ReadonlyMap<string, readonly number[]>;
  },
) {
  if (!input.editUserMessageId) return null;
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
  const targetAnnotations = chatInlineAnnotationsFromStructuredPayload(target.structuredPayload);
  if (!annotationSnapshotsAreSemanticallyIdentical(input.annotations, targetAnnotations)) {
    throw unprocessable("Sent annotation snapshots are immutable across historical edits and retries");
  }
  const addsAnnotationFiles = [...(input.attachmentFileIndexesByAnnotationId?.values() ?? [])]
    .some((indexes) => indexes.length > 0);
  if (addsAnnotationFiles) {
    throw unprocessable("Sent annotation snapshots are immutable and cannot accept new annotation files");
  }
  return target;
}

async function validateExistingAttachmentOwnership(
  query: ValidationQuery,
  input: {
    orgId: string;
    conversationId: string;
    annotations: readonly ChatInlineAnnotation[];
  },
  target: typeof chatMessages.$inferSelect | null,
) {
  const attachmentIds = input.annotations.flatMap((annotation) => annotation.attachmentIds);
  if (attachmentIds.length === 0) return;
  if (!target) {
    throw unprocessable("Existing annotation attachments require an edited user message");
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
    targetConversation: typeof chatConversations.$inferSelect;
    annotation: ChatInlineAnnotation;
  },
) {
  const sameConversation = input.annotation.sourceConversationId === input.conversationId;
  const exactSideChatParentAnchor = input.targetConversation.conversationKind === "side_chat"
    && input.targetConversation.forkedFromConversationId
      === input.annotation.sourceConversationId
    && input.targetConversation.forkedFromMessageId === input.annotation.sourceMessageId;
  if (!sameConversation && !exactSideChatParentAnchor) {
    throw unprocessable(
      "Annotation source must match the target conversation or its exact Side Chat parent anchor",
    );
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
  if (
    exactSideChatParentAnchor
      ? source.status !== "completed"
      : !STABLE_ANNOTATION_MESSAGE_STATUSES.has(source.status)
  ) {
    if (exactSideChatParentAnchor) {
      throw unprocessable("Side Chat annotation source must be its completed parent assistant anchor");
    }
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
  const projectedEntries = chatTranscriptFromPayload(input.sourceMessage.structuredPayload);
  const projectedEntry = projectedEntries
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
  const visibleEntry = visibleChatTranscriptProjection(
    projectedEntries,
    input.sourceMessage.body,
  ).find((entry): entry is ChatStreamTranscriptTextEntry =>
    (entry.kind === "assistant" || entry.kind === "thinking")
    && entry.kind === input.annotation.transcriptKind
    && entry.generationId === generation.id
    && entry.generationSeqStart === input.annotation.generationSeqStart
    && entry.generationSeqEnd === input.annotation.generationSeqEnd
  );
  if (
    !visibleEntry
    || annotationRangeFallsOutsideVisibleProjection(input.annotation, visibleEntry.text)
  ) {
    throw unprocessable("Process annotation evidence is not present in the visible message projection");
  }
  return visibleEntry.text;
}

function annotationRangeFallsOutsideVisibleProjection(
  annotation: ChatInlineAnnotation,
  source: string,
) {
  return annotation.start < 0
    || annotation.end <= annotation.start
    || annotation.end > source.length;
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
  const targetConversation = await query
    .select()
    .from(chatConversations)
    .where(and(
      eq(chatConversations.id, input.conversationId),
      eq(chatConversations.orgId, input.orgId),
    ))
    .limit(1)
    .for("share")
    .then((rows) => rows[0] ?? null);
  if (!targetConversation) {
    throw unprocessable("Annotation target conversation must belong to the organization");
  }
  for (const annotation of input.annotations) {
    const indexes = input.attachmentFileIndexesByAnnotationId?.get(annotation.id) ?? [];
    for (const fileIndex of indexes) {
      if (fileIndex < 0 || fileIndex >= input.uploadedFileCount) {
        throw unprocessable("Annotation file index does not match an uploaded file");
      }
    }
  }
  const editTarget = await validateHistoricalAnnotationSnapshot(query, input);
  await validateExistingAttachmentOwnership(query, input, editTarget);
  if (editTarget) return;
  for (const annotation of input.annotations) {
    const source = await validateSourceMessage(query, {
      orgId: input.orgId,
      conversationId: input.conversationId,
      targetConversation,
      annotation,
    });
    const anchorSource = annotation.surface === "assistant_body"
      ? source.body
      : await validateProcessAnnotation(query, {
        orgId: input.orgId,
        conversationId: annotation.sourceConversationId,
        annotation,
        sourceMessage: source,
    });
    assertSourceAnchor(annotation, anchorSource);
    await assertSelectedTextExactlyMatchesRange(
      query,
      input.orgId,
      annotation,
      anchorSource,
    );
  }
}

export function asChatInlineAnnotationValidationQuery(
  db: Db,
): ValidationQuery {
  return db;
}
