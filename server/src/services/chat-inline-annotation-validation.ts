import type { Db } from "@rudderhq/db";
import {
  agents,
  chatAttachments,
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
  heartbeatRuns,
} from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  isInternalChatTranscriptLifecycleEntry,
  type ChatInlineAnnotation,
  type ChatStreamTranscriptEntry,
  type ChatStreamTranscriptTextEntry,
} from "@rudderhq/shared";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { createHash } from "node:crypto";
import { unprocessable } from "../errors.js";
import type { ChatGenerationProtocolTransaction } from "./chat-generation-protocol.helpers.js";
import { renderedMarkdownSelectionText } from "./chat-inline-annotation-rendering.js";
import { renderedMarkdownSelectionTextWithResolvedLabels } from "./chat-inline-annotation-resolved-labels.js";
import { chatTranscriptEntryFromReaderItem } from "./chat-transcript-reader-item.js";
import { chatTranscriptFromPayload } from "./chats.helpers.js";
import { organizationWorkspaceBrowserService } from "./organization-workspace-browser.js";
import { assertRunIntelligenceAccess } from "./run-intelligence-access.js";
import { createHistoricalTranscriptReader } from "./runtime-kernel/historical-transcript-reader.js";
import type { TranscriptItem } from "./runtime-kernel/transcript-reader.js";

const STABLE_ANNOTATION_MESSAGE_STATUSES = new Set(["completed", "stopped", "failed"]);
const STABLE_ANNOTATION_GENERATION_STATUSES = new Set(["completed", "stopped", "failed"]);
const STABLE_AGENT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const MAX_PROCESS_ANNOTATION_EVENT_SPAN = 1_000;
const MAX_AGENT_RUN_ANNOTATION_MEMBER_IDS = 100;
const MAX_AGENT_RUN_ANNOTATION_READER_ITEMS = 5_000;
const AGENT_RUN_ANNOTATION_READER_PAGE_LIMIT = 200;
const INTERNAL_RESULT_MARKER_PATTERN =
  /RUDDER_RESULT_(?:BEGIN|END)|__RUDDER_RESULT_[a-f0-9-]+__/i;

export type ValidationQuery = Pick<ChatGenerationProtocolTransaction, "select">;
type RangeBasedChatInlineAnnotation = Extract<
  ChatInlineAnnotation,
  { surface: "assistant_body" | "process_transcript" | "workspace_file" | "local_file" }
>;

export function hashChatAnnotationSource(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertSourceAnchor(
  annotation: RangeBasedChatInlineAnnotation,
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
  annotation: RangeBasedChatInlineAnnotation,
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
    if (annotation.surface === "agent_run_transcript") {
      return expected.surface === "agent_run_transcript"
        && annotation.id === expected.id
        && annotation.selectedText === expected.selectedText
        && (annotation.comment ?? null) === (expected.comment ?? null)
        && annotation.sourceHash === expected.sourceHash
        && annotation.sourceRunId === expected.sourceRunId
        && annotation.sourceAgentId === expected.sourceAgentId
        && annotation.anchorKind === expected.anchorKind
        && String(annotation.sourceEntryId) === String(expected.sourceEntryId)
        && annotation.sourceMemberIds.length === expected.sourceMemberIds.length
        && annotation.sourceMemberIds.every(
          (memberId, memberIndex) => String(memberId) === String(expected.sourceMemberIds[memberIndex]),
        )
        && annotation.attachmentIds.length === expected.attachmentIds.length
        && annotation.attachmentIds.every(
          (attachmentId, attachmentIndex) => attachmentId === expected.attachmentIds[attachmentIndex],
        );
    }
    if (expected.surface === "agent_run_transcript") return false;
    if (
      annotation.id !== expected.id
      || annotation.surface !== expected.surface
      || annotation.selectedText !== expected.selectedText
      || (annotation.comment ?? null) !== (expected.comment ?? null)
      || annotation.sourceConversationId !== expected.sourceConversationId
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
      return expected.surface === "assistant_body"
        && annotation.sourceMessageId === expected.sourceMessageId;
    }
    if (annotation.surface === "process_transcript") {
      return expected.surface === "process_transcript"
        && annotation.sourceMessageId === expected.sourceMessageId
        && annotation.transcriptKind === expected.transcriptKind
        && annotation.generationId === expected.generationId
        && annotation.generationSeqStart === expected.generationSeqStart
        && annotation.generationSeqEnd === expected.generationSeqEnd;
    }
    return expected.surface === annotation.surface
      && annotation.sourceFilePath === expected.sourceFilePath
      && annotation.sourceRenderMode === expected.sourceRenderMode
      && (
        annotation.surface !== "workspace_file"
        || (
          expected.surface === "workspace_file"
          && annotation.sourceLibraryEntryId === expected.sourceLibraryEntryId
        )
      );
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
    annotation: Extract<ChatInlineAnnotation, { surface: "assistant_body" | "process_transcript" }>;
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

async function validateWorkspaceFileAnnotation(
  query: ValidationQuery,
  input: {
    orgId: string;
    annotation: Extract<ChatInlineAnnotation, { surface: "workspace_file" }>;
  },
) {
  const firstPathSegment = input.annotation.sourceFilePath
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)[0]
    ?.toLowerCase();
  if (firstPathSegment === "agents" || firstPathSegment === "skills") {
    throw unprocessable("Protected workspace files cannot be used as Chat annotations");
  }
  const detail = await organizationWorkspaceBrowserService(query as unknown as Db)
    .readFile(input.orgId, input.annotation.sourceFilePath);
  if (
    detail.previewKind !== "text"
    || detail.content === null
    || detail.truncated
    || (
      input.annotation.sourceLibraryEntryId
      && detail.libraryEntryId !== input.annotation.sourceLibraryEntryId
    )
  ) {
    throw unprocessable("Workspace file annotation source must be an eligible visible text file");
  }
  return detail.content;
}

function validateLocalFileSnapshot(
  annotation: Extract<ChatInlineAnnotation, { surface: "local_file" }>,
) {
  if (
    !annotation.sourceFilePath.startsWith("/")
    && !/^[A-Za-z]:[\\/]/u.test(annotation.sourceFilePath)
  ) {
    throw unprocessable("Local file annotation source must use an absolute canonical path");
  }
  if (
    annotation.sourceRenderMode === "text"
    && annotation.end - annotation.start !== annotation.selectedText.length
  ) {
    throw unprocessable("Local text file annotation range must match the selected snapshot");
  }
}

function validateFileAnnotationConversation(
  targetConversation: typeof chatConversations.$inferSelect,
  targetConversationId: string,
  sourceConversationId: string,
) {
  const sameConversation = sourceConversationId === targetConversationId;
  const sideChatParent = targetConversation.conversationKind === "side_chat"
    && targetConversation.forkedFromConversationId === sourceConversationId;
  if (!sameConversation && !sideChatParent) {
    throw unprocessable(
      "File annotation source must match the target conversation or its Side Chat parent",
    );
  }
}

type AgentRunTranscriptAnnotation = Extract<ChatInlineAnnotation, { surface: "agent_run_transcript" }>;

function runTranscriptItemPayload(item: TranscriptItem) {
  if (item.payload && typeof item.payload === "object" && !Array.isArray(item.payload)) {
    return item.payload as Record<string, unknown>;
  }
  if (item.entry && typeof item.entry === "object" && !Array.isArray(item.entry)) {
    return item.entry as Record<string, unknown>;
  }
  return null;
}

function runTranscriptItemText(item: TranscriptItem) {
  if (item.kind.startsWith("cursor:acp:")) {
    const entry = chatTranscriptEntryFromReaderItem(item);
    return entry && "text" in entry ? entry.text : null;
  }
  if (typeof item.text === "string") return item.text;
  const payload = runTranscriptItemPayload(item);
  if (!payload) return null;
  if (typeof payload.text === "string") return payload.text;
  const nestedEntry = payload.entry;
  if (
    nestedEntry
    && typeof nestedEntry === "object"
    && !Array.isArray(nestedEntry)
    && typeof (nestedEntry as Record<string, unknown>).text === "string"
  ) {
    return (nestedEntry as Record<string, unknown>).text as string;
  }
  return null;
}

function runTranscriptItemIds(item: TranscriptItem) {
  const payload = runTranscriptItemPayload(item);
  const ids = [item.id, item.sourceEntryId].filter((value): value is string => Boolean(value));
  for (const key of ["id", "entryId", "sourceEntryId", "memberId"]) {
    const value = payload?.[key];
    if (typeof value === "string" || typeof value === "number") ids.push(String(value));
  }
  const timestamp = typeof payload?.ts === "string" ? payload.ts : item.ts;
  const name = typeof payload?.name === "string"
    ? payload.name
    : typeof payload?.toolName === "string"
      ? payload.toolName
      : item.kind;
  const toolUseId = payload?.toolUseId;
  if (typeof toolUseId === "string") ids.push(`tool:${toolUseId}:${timestamp}`);
  const messageId = payload?.messageId ?? payload?.segmentId ?? payload?.entryId;
  if (typeof messageId === "string" || typeof messageId === "number") {
    ids.push(`message:${String(messageId)}:${timestamp}`);
    ids.push(`thinking:${String(messageId)}:${timestamp}:${timestamp}`);
  }
  ids.push(`message:block:${timestamp}:${timestamp}`);
  ids.push(`activity:${typeof payload?.activityId === "string" ? payload.activityId : name}:${timestamp}`);
  ids.push(`todo_list:${typeof payload?.todoListId === "string" ? payload.todoListId : timestamp}`);
  ids.push(`command_group:${typeof toolUseId === "string" ? toolUseId : name}:${timestamp}`);
  ids.push(`memory_update:${timestamp}`);
  ids.push(`event:${timestamp}`);
  ids.push(`stdout:${timestamp}`);
  ids.push(`stderr:${timestamp}`);
  return ids;
}

function runTranscriptItemIsDelta(item: TranscriptItem) {
  if (item.kind.startsWith("cursor:acp:")) {
    const entry = chatTranscriptEntryFromReaderItem(item);
    return Boolean(entry && "delta" in entry && entry.delta === true);
  }
  const payload = runTranscriptItemPayload(item);
  return Boolean(payload?.delta === true
    || (
      payload?.entry
      && typeof payload.entry === "object"
      && !Array.isArray(payload.entry)
      && (payload.entry as Record<string, unknown>).delta === true
    ));
}

function joinRunTranscriptItemText(items: readonly TranscriptItem[]) {
  let source = "";
  let previousWasDelta = false;
  for (const item of items) {
    const text = runTranscriptItemText(item);
    if (!text) continue;
    source += source.length === 0 || (previousWasDelta && runTranscriptItemIsDelta(item))
      ? text
      : `\n${text}`;
    previousWasDelta = runTranscriptItemIsDelta(item);
  }
  return source;
}

function isNiceTranscriptItem(item: TranscriptItem) {
  if (item.visibility !== "visible") return false;
  // Content hashes and replay-window ordinals cannot identify a Cursor update
  // occurrence once session/load returns a different retained subset.
  if (item.kind.startsWith("cursor:acp:") && item.origin !== "object") return false;
  const payload = runTranscriptItemPayload(item);
  if (payload) {
    const entry = payload.entry && typeof payload.entry === "object" && !Array.isArray(payload.entry)
      ? payload.entry as Record<string, unknown>
      : payload;
    if (isExplicitlyHiddenTranscriptEvidence(payload, entry)) return false;
  }
  if (payload?.internal === true || payload?.hidden === true || payload?.private === true) return false;
  if (payload?.visibility === "internal" || payload?.visibility === "hidden") return false;
  const nestedEntry = payload?.entry;
  const lifecycleCandidate = payload?.kind === "system" && typeof payload.text === "string"
    ? { kind: payload.kind, text: payload.text }
    : nestedEntry
      && typeof nestedEntry === "object"
      && !Array.isArray(nestedEntry)
      && (nestedEntry as Record<string, unknown>).kind === "system"
      && typeof (nestedEntry as Record<string, unknown>).text === "string"
      ? {
        kind: (nestedEntry as Record<string, unknown>).kind as string,
        text: (nestedEntry as Record<string, unknown>).text as string,
      }
      : null;
  if (lifecycleCandidate && isInternalChatTranscriptLifecycleEntry(lifecycleCandidate)) return false;
  const eventType = typeof payload?.eventType === "string" ? payload.eventType : item.kind;
  return !/(?:lifecycle|invocation|diagnostic|session)/iu.test(eventType);
}

function isGenerationTextEntry(
  entry: ChatStreamTranscriptEntry | null,
): entry is ChatStreamTranscriptTextEntry & {
  generationId: string;
  generationSeqStart: number;
  generationSeqEnd: number;
} {
  return Boolean(entry
    && (entry.kind === "assistant" || entry.kind === "thinking")
    && typeof entry.generationId === "string"
    && typeof entry.generationSeqStart === "number"
    && typeof entry.generationSeqEnd === "number");
}

async function readConversationMessageItems(
  query: ValidationQuery,
  input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    runId: string | null;
    generationId: string;
    annotationKind: string;
    startSeq: number;
    endSeq: number;
  },
) {
  const reader = createHistoricalTranscriptReader(query as unknown as Pick<Db, "select">);
  const items: TranscriptItem[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await reader.readConversation({
      orgId: input.orgId,
      conversationId: input.conversationId,
      principal: { type: "board", orgId: input.orgId, authorized: true },
      cursor,
      limit: AGENT_RUN_ANNOTATION_READER_PAGE_LIMIT,
    });
    for (const item of page.items) {
      const messageMatch = [item.id, item.sourceEntryId]
        .filter((value): value is string => Boolean(value))
        .some((value) => new RegExp(`^message:${input.messageId}:\\d+(?::\\d+)?$`, "u").test(value));
      const entry = chatTranscriptEntryFromReaderItem(item);
      const matchesGeneration = isGenerationTextEntry(entry)
        && entry.kind === input.annotationKind
        && entry.generationId === input.generationId
        && entry.generationSeqStart >= input.startSeq
        && entry.generationSeqEnd <= input.endSeq;
      if (messageMatch || (input.runId && item.runId === input.runId && matchesGeneration)) items.push(item);
    }
    if (!page.nextCursor) break;
    if (page.nextCursor === cursor) throw unprocessable("Transcript reader cursor did not advance");
    cursor = page.nextCursor;
  }
  return items;
}

export async function validateAgentRunTranscriptAnnotation(
  query: ValidationQuery,
  input: {
    orgId: string;
    requesterUserId?: string | null;
    annotation: AgentRunTranscriptAnnotation;
  },
) {
  if (input.annotation.sourceMemberIds.length > MAX_AGENT_RUN_ANNOTATION_MEMBER_IDS) {
    throw unprocessable("Agent Run annotation transcript evidence is too large");
  }
  const run = await query
    .select()
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, input.annotation.sourceRunId),
      eq(heartbeatRuns.orgId, input.orgId),
    ))
    .limit(1)
    .for("share")
    .then((rows) => rows[0] ?? null);
  if (!run) {
    throw unprocessable("Agent Run annotation source run must belong to the declared Agent and organization");
  }
  await assertRunIntelligenceAccess(query as unknown as Db, run, {
    orgIds: [input.orgId],
    sideChatOwnerId: input.requesterUserId ?? null,
  });
  if (run.agentId !== input.annotation.sourceAgentId) {
    throw unprocessable("Agent Run annotation source run must belong to the declared Agent and organization");
  }
  if (!STABLE_AGENT_RUN_STATUSES.has(run.status)) {
    throw unprocessable("Agent Run annotation source must be a terminal run");
  }
  const sourceAgent = await query
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.id, input.annotation.sourceAgentId),
      eq(agents.orgId, input.orgId),
    ))
    .limit(1)
    .for("share")
    .then((rows) => rows[0] ?? null);
  if (!sourceAgent) {
    throw unprocessable("Agent Run annotation source Agent must belong to the organization");
  }

  const reader = createHistoricalTranscriptReader(query as unknown as Pick<Db, "select">);
  const items: TranscriptItem[] = [];
  let cursor: string | null = null;
  let reachedEnd = false;
  for (let pageCount = 0; pageCount < MAX_AGENT_RUN_ANNOTATION_READER_ITEMS / AGENT_RUN_ANNOTATION_READER_PAGE_LIMIT; pageCount += 1) {
    const page = await reader.readRun({
      orgId: input.orgId,
      runId: input.annotation.sourceRunId,
      principal: { type: "board", orgId: input.orgId, authorized: true },
      cursor,
      limit: AGENT_RUN_ANNOTATION_READER_PAGE_LIMIT,
    });
    items.push(...page.items);
    if (!page.nextCursor) {
      reachedEnd = true;
      break;
    }
    if (page.nextCursor === cursor) throw unprocessable("Agent Run annotation transcript cursor did not advance");
    cursor = page.nextCursor;
  }
  if (!reachedEnd) {
    throw unprocessable("Agent Run annotation transcript evidence is too large");
  }
  const requestedMemberIds = input.annotation.sourceMemberIds.map((memberId) => String(memberId));
  const requestedEvidenceIds = new Set([...requestedMemberIds, String(input.annotation.sourceEntryId)]);
  const itemByRequestedId = new Map<string, TranscriptItem>();
  const ambiguousIds = new Set<string>();
  for (const item of items) {
    for (const eventId of runTranscriptItemIds(item)) {
      if (!requestedEvidenceIds.has(eventId)) continue;
      if (ambiguousIds.has(eventId)) continue;
      const existing = itemByRequestedId.get(eventId);
      if (existing && existing.id !== item.id) {
        itemByRequestedId.delete(eventId);
        ambiguousIds.add(eventId);
      } else {
        itemByRequestedId.set(eventId, item);
      }
    }
  }
  const memberItems = requestedMemberIds.map((memberId) => itemByRequestedId.get(memberId));
  if (memberItems.some((item) => !item)) {
    throw unprocessable("Agent Run annotation transcript members are missing from the source run");
  }
  const resolvedMemberItems = memberItems as TranscriptItem[];
  if (resolvedMemberItems.some((item) => !isNiceTranscriptItem(item))) {
    throw unprocessable("Agent Run annotation source must be visible Nice Transcript evidence");
  }
  const sourceEntryId = String(input.annotation.sourceEntryId);
  const sourceEntry = itemByRequestedId.get(sourceEntryId);
  if (!sourceEntry) {
    throw unprocessable("Agent Run annotation source entry must be visible Nice Transcript evidence");
  }
  if (!isNiceTranscriptItem(sourceEntry)) {
    throw unprocessable("Agent Run annotation source entry must be visible Nice Transcript evidence");
  }
  if (input.annotation.anchorKind === "text") {
    if (resolvedMemberItems.some((item) => {
      const entry = chatTranscriptEntryFromReaderItem(item);
      return entry?.kind !== "assistant" && entry?.kind !== "thinking";
    })) {
      throw unprocessable("Text Agent Run annotations must reference transcript entries");
    }
    const source = joinRunTranscriptItemText(resolvedMemberItems);
    if (!source || !source.includes(input.annotation.selectedText)) {
      throw unprocessable("Agent Run annotation selected text does not match transcript evidence");
    }
    if (
      input.annotation.sourceHash !== hashChatAnnotationSource(source)
      && input.annotation.sourceHash !== hashChatAnnotationSource(input.annotation.selectedText)
    ) {
      throw unprocessable("Agent Run annotation source hash does not match transcript evidence");
    }
    return;
  }

  const transitionSnapshot = JSON.stringify({
    sourceEntryId,
    sourceMemberIds: requestedMemberIds,
    members: resolvedMemberItems.map((item) => ({
      id: item.id,
      seq: item.ordinal,
      eventType: item.kind,
      text: runTranscriptItemText(item),
    })),
  });
  if (
    input.annotation.sourceHash !== hashChatAnnotationSource(transitionSnapshot)
    && input.annotation.sourceHash !== hashChatAnnotationSource(joinRunTranscriptItemText(resolvedMemberItems))
    && input.annotation.sourceHash !== hashChatAnnotationSource(input.annotation.selectedText)
  ) {
    throw unprocessable("Agent Run annotation source hash does not match transition evidence");
  }
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
    .select({
      generationSeq: chatGenerationEvents.generationSeq,
      eventKind: chatGenerationEvents.eventKind,
      assistantMessageId: chatGenerationEvents.assistantMessageId,
    })
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
  if (events.some((event) =>
    event.eventKind !== "transcript" || event.assistantMessageId !== input.sourceMessage.id,
  )) {
    throw unprocessable("Process annotation range must contain only visible transcript evidence");
  }
  const readerItems = await readConversationMessageItems(query, {
    orgId: input.orgId,
    conversationId: input.conversationId,
    messageId: input.sourceMessage.id,
    runId: input.sourceMessage.runId,
    generationId: generation.id,
    annotationKind: input.annotation.transcriptKind,
    startSeq: input.annotation.generationSeqStart,
    endSeq: input.annotation.generationSeqEnd,
  });
  const itemByGenerationSeq = new Map<number, { item: TranscriptItem; entry: ChatStreamTranscriptTextEntry }>();
  for (const item of readerItems) {
    const entry = chatTranscriptEntryFromReaderItem(item);
    if (!isGenerationTextEntry(entry) || entry.generationId !== generation.id) continue;
    if (entry.generationSeqStart !== entry.generationSeqEnd) continue;
    itemByGenerationSeq.set(entry.generationSeqStart, { item, entry });
  }
  const textEntries: ChatStreamTranscriptTextEntry[] = [];
  for (const event of events) {
    const readerItem = itemByGenerationSeq.get(event.generationSeq);
    const entry = readerItem?.entry;
    if (
      !readerItem
      || !isNiceTranscriptItem(readerItem.item)
      || !entry
      || entry.kind !== input.annotation.transcriptKind
      || entry.text.trim().length === 0
    ) {
      throw unprocessable("Process annotation range must contain only visible assistant or thinking prose");
    }
    textEntries.push(entry);
  }
  const source = processAnnotationSource(textEntries);
  // The Reader proves the source event range. The persisted message projection
  // remains the user-visible boundary used to reject hidden or unprojected text.
  const projectedEntries = chatTranscriptFromPayload(input.sourceMessage.structuredPayload);
  const projectedEntry = projectedEntries
    .filter(isGenerationTextEntry)
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
  annotation: RangeBasedChatInlineAnnotation,
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
    requesterUserId?: string | null;
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
    if (annotation.surface === "agent_run_transcript") {
      await validateAgentRunTranscriptAnnotation(query, {
        orgId: input.orgId,
        requesterUserId: input.requesterUserId,
        annotation,
      });
      continue;
    }
    if (annotation.surface === "local_file") {
      validateFileAnnotationConversation(
        targetConversation,
        input.conversationId,
        annotation.sourceConversationId,
      );
      validateLocalFileSnapshot(annotation);
      continue;
    }
    if (annotation.surface === "workspace_file") {
      validateFileAnnotationConversation(
        targetConversation,
        input.conversationId,
        annotation.sourceConversationId,
      );
      const anchorSource = await validateWorkspaceFileAnnotation(query, {
        orgId: input.orgId,
        annotation,
      });
      assertSourceAnchor(annotation, anchorSource);
      if (annotation.sourceRenderMode === "markdown") {
        await assertSelectedTextExactlyMatchesRange(
          query,
          input.orgId,
          annotation,
          anchorSource,
        );
      } else if (anchorSource.slice(annotation.start, annotation.end) !== annotation.selectedText) {
        throw unprocessable("Workspace text file annotation does not match the selected source range");
      }
      continue;
    }
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
