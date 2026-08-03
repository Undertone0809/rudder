import type { Db } from "@rudderhq/db";
import {
  agents,
  chatAttachments,
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
  heartbeatRunEvents,
  heartbeatRuns,
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
import { organizationWorkspaceBrowserService } from "./organization-workspace-browser.js";

const STABLE_ANNOTATION_MESSAGE_STATUSES = new Set(["completed", "stopped", "failed"]);
const STABLE_ANNOTATION_GENERATION_STATUSES = new Set(["completed", "stopped", "failed"]);
const STABLE_AGENT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const MAX_PROCESS_ANNOTATION_EVENT_SPAN = 1_000;
const MAX_AGENT_RUN_ANNOTATION_MEMBER_IDS = 100;
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

function runTranscriptEventPayload(event: typeof heartbeatRunEvents.$inferSelect) {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return null;
  return event.payload as Record<string, unknown>;
}

function runTranscriptEventText(event: typeof heartbeatRunEvents.$inferSelect) {
  const payload = runTranscriptEventPayload(event);
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
  return typeof event.message === "string" ? event.message : null;
}

function runTranscriptEventIds(event: typeof heartbeatRunEvents.$inferSelect) {
  const payload = runTranscriptEventPayload(event);
  const ids = [String(event.id)];
  for (const key of ["id", "entryId", "sourceEntryId", "memberId"]) {
    const value = payload?.[key];
    if (typeof value === "string" || typeof value === "number") ids.push(String(value));
  }
  const timestamp = typeof payload?.ts === "string"
    ? payload.ts
    : event.createdAt.toISOString();
  const name = typeof payload?.name === "string"
    ? payload.name
    : typeof payload?.toolName === "string"
      ? payload.toolName
      : event.eventType;
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

function runTranscriptEventIsDelta(event: typeof heartbeatRunEvents.$inferSelect) {
  const payload = runTranscriptEventPayload(event);
  return Boolean(payload?.delta === true
    || (
      payload?.entry
      && typeof payload.entry === "object"
      && !Array.isArray(payload.entry)
      && (payload.entry as Record<string, unknown>).delta === true
    ));
}

function joinRunTranscriptEventText(events: readonly (typeof heartbeatRunEvents.$inferSelect)[]) {
  let source = "";
  let previousWasDelta = false;
  for (const event of events) {
    const text = runTranscriptEventText(event);
    if (!text) continue;
    source += source.length === 0 || (previousWasDelta && runTranscriptEventIsDelta(event))
      ? text
      : `\n${text}`;
    previousWasDelta = runTranscriptEventIsDelta(event);
  }
  return source;
}

function isNiceTranscriptEvent(event: typeof heartbeatRunEvents.$inferSelect) {
  const payload = runTranscriptEventPayload(event);
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
  return !/(?:lifecycle|invocation|diagnostic|session)/iu.test(event.eventType);
}

async function validateAgentRunTranscriptAnnotation(
  query: ValidationQuery,
  input: {
    orgId: string;
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
  if (!run || run.agentId !== input.annotation.sourceAgentId) {
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

  const events = await query
    .select()
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.orgId, input.orgId),
      eq(heartbeatRunEvents.runId, input.annotation.sourceRunId),
      eq(heartbeatRunEvents.agentId, input.annotation.sourceAgentId),
    ))
    .orderBy(asc(heartbeatRunEvents.seq), asc(heartbeatRunEvents.id))
    .limit(5_000)
    .for("share");
  const requestedMemberIds = input.annotation.sourceMemberIds.map((memberId) => String(memberId));
  const requestedEvidenceIds = new Set([...requestedMemberIds, String(input.annotation.sourceEntryId)]);
  const eventByRequestedId = new Map<string, typeof heartbeatRunEvents.$inferSelect>();
  const ambiguousIds = new Set<string>();
  for (const event of events) {
    for (const eventId of runTranscriptEventIds(event)) {
      if (!requestedEvidenceIds.has(eventId)) continue;
      if (ambiguousIds.has(eventId)) continue;
      const existing = eventByRequestedId.get(eventId);
      if (existing && existing.id !== event.id) {
        eventByRequestedId.delete(eventId);
        ambiguousIds.add(eventId);
      } else {
        eventByRequestedId.set(eventId, event);
      }
    }
  }
  const memberEvents = requestedMemberIds.map((memberId) => eventByRequestedId.get(memberId));
  if (memberEvents.some((event) => !event)) {
    throw unprocessable("Agent Run annotation transcript members are missing from the source run");
  }
  const resolvedMemberEvents = memberEvents as Array<typeof heartbeatRunEvents.$inferSelect>;
  if (resolvedMemberEvents.some((event) => !isNiceTranscriptEvent(event))) {
    throw unprocessable("Agent Run annotation source must be visible Nice Transcript evidence");
  }
  const sourceEntryId = String(input.annotation.sourceEntryId);
  const sourceEntry = eventByRequestedId.get(sourceEntryId);
  if (!sourceEntry) {
    throw unprocessable("Agent Run annotation source entry is missing from the source run");
  }
  if (!isNiceTranscriptEvent(sourceEntry)) {
    throw unprocessable("Agent Run annotation source entry must be visible Nice Transcript evidence");
  }
  if (input.annotation.anchorKind === "text") {
    if (resolvedMemberEvents.some((event) => event.eventType !== "transcript.entry")) {
      throw unprocessable("Text Agent Run annotations must reference transcript entries");
    }
    const source = joinRunTranscriptEventText(resolvedMemberEvents);
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
    members: resolvedMemberEvents.map((event) => ({
      id: String(event.id),
      seq: event.seq,
      eventType: event.eventType,
      text: runTranscriptEventText(event),
    })),
  });
  if (
    input.annotation.sourceHash !== hashChatAnnotationSource(transitionSnapshot)
    && input.annotation.sourceHash !== hashChatAnnotationSource(joinRunTranscriptEventText(resolvedMemberEvents))
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
