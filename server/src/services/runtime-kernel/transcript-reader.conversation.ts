import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { chatConversations, chatMessages, heartbeatRuns } from "@rudderhq/db";
import type { ChatStreamTranscriptEntry } from "@rudderhq/shared";
import { and, eq, sql } from "drizzle-orm";
import { notFound } from "../../errors.js";
import {
  loadChatTranscripts,
  type ChatTranscriptMessageSource,
} from "../chat-transcript-persistence.js";
import type {
  ConversationReadPage,
  ConversationSourceAnchor,
  ConversationSourceCursor,
  ConversationSourceRow,
  ConversationSourceState,
  CursorPayload,
  ReadConversationTranscript,
  ReadDatabase,
  ReadRunTranscript,
  TranscriptAvailability,
  TranscriptCompleteness,
  TranscriptItem,
  TranscriptPrincipal,
  TranscriptRange,
  TranscriptReaderOptions,
  TranscriptSource,
} from "./transcript-reader.contracts.js";
import {
  MAX_CONVERSATION_SOURCE_SCAN,
  MAX_PAGE_LIMIT,
} from "./transcript-reader.contracts.js";
import {
  compatibilityValueKey,
  mergeAvailability,
  mergeCompleteness,
  mergeSource,
  normalizeItems,
  selectedPrincipalScope,
  stableHash,
  TranscriptReaderError,
  transcriptReaderError,
} from "./transcript-reader.normalize.js";
import {
  decodeCursor,
  encodeCursor,
  normalizeLimit,
  numericRangeEndReached,
  pageFromRunSource,
  pageItemsForRange,
} from "./transcript-reader.pages.js";
import {
  authorize,
  conversationDateKey,
  readRunItems,
  selectBindingByConversation,
  selectConversation,
  selectConversationMessage,
  selectConversationSourceWindow,
  selectRun,
} from "./transcript-reader.sources.js";

type ConversationCursorAnchor = ConversationSourceAnchor & {
  updatedAt: string | null;
};

function sourceUpdatedAt(value: Date | string | null | undefined): string | null {
  return value == null ? null : conversationDateKey(value);
}

function splitConversationRange(range: TranscriptRange | null | undefined): {
  nestedRange: TranscriptRange | null;
  numericRange: TranscriptRange | null;
} {
  if (!range) return { nestedRange: null, numericRange: null };
  if (range.itemId) return { nestedRange: range, numericRange: null };
  const nestedRange = { ...range };
  const numericRange: TranscriptRange = {};
  for (const key of ["start", "end", "fromExclusive", "throughInclusive", "after", "before"] as const) {
    const bound = range[key];
    if (typeof bound !== "number") continue;
    Object.assign(numericRange, { [key]: bound });
    delete nestedRange[key];
  }
  if (range.fromExclusive !== null && range.fromExclusive !== undefined) {
    delete numericRange.after;
    delete nestedRange.after;
  }
  return {
    nestedRange: Object.keys(nestedRange).length > 0 ? nestedRange : null,
    numericRange: Object.keys(numericRange).length > 0 ? numericRange : null,
  };
}

function timestampForItem(item: TranscriptItem): number {
  const parsed = Date.parse(item.ts);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function sortConversationItems(items: TranscriptItem[]): TranscriptItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => timestampForItem(left.item) - timestampForItem(right.item)
      || left.item.id.localeCompare(right.item.id)
      || left.index - right.index)
    .map(({ item }, sequence) => ({ ...item, sequence }));
}

function messageEntries(
  message: {
    id: string;
    role: string;
    kind: string;
    body: string;
    createdAt: Date;
    runId: string | null;
  },
  transcript: readonly ChatStreamTranscriptEntry[] | undefined,
): TranscriptItem[] {
  const timestamp = message.createdAt.toISOString();
  const entries = transcript && transcript.length > 0
    ? transcript.map((entry) => ({ ...entry, ts: typeof entry.ts === "string" ? entry.ts : timestamp }))
    : message.body.trim()
      ? [{
        kind: message.role === "user" ? "user" : message.role === "system" ? "system" : "assistant",
        ts: timestamp,
        text: message.body,
      } as TranscriptEntry]
      : [];
  return normalizeItems(entries, { runId: message.runId, spanId: null, origin: "legacy" }).map((item, index) => ({
    ...item,
    id: item.id === `${message.runId ?? "transcript"}:${index}` ? `message:${message.id}:${index}` : item.id,
    sourceEntryId: `message:${message.id}:${index}`,
  }));
}

function conversationRevision(
  conversation: { id: string; updatedAt?: Date | null },
  input: ReadConversationTranscript,
): string {
  const { numericRange } = splitConversationRange(input.range);
  return stableHash({
    conversationId: conversation.id,
    updatedAt: conversation.updatedAt ?? null,
    range: input.range ?? null,
    visibilityCutoffRef: input.visibilityCutoffRef ?? null,
    ...(numericRange ? { numericRangeVersion: 1 } : {}),
  });
}

async function conversationReadRevision(
  db: ReadDatabase,
  input: ReadConversationTranscript,
  baseRevision: string,
  after: ConversationCursorAnchor | null,
): Promise<string> {
  if (!after) return baseRevision;
  // Fingerprint the entire consumed source prefix in one query, independent of cursor depth.
  const [row] = await db.select({ sourceRevision: sql<string>`(
    select md5(coalesce(string_agg(
      md5(source.kind || ':' || source.id::text || ':' ||
        extract(epoch from source.created_at)::text || ':' ||
        extract(epoch from source.updated_at)::text),
      '' order by source.created_at, source.id, source.kind_order
    ), ''))
    from (
      select 'run'::text as kind, 0 as kind_order, ${heartbeatRuns.id} as id,
        ${heartbeatRuns.createdAt} as created_at, ${heartbeatRuns.updatedAt} as updated_at
      from ${heartbeatRuns}
      where ${heartbeatRuns.orgId} = ${input.orgId}::uuid
        and ${heartbeatRuns.chatConversationId} = ${input.conversationId}::uuid
      union all
      select 'message'::text as kind, 1 as kind_order, ${chatMessages.id} as id,
        ${chatMessages.createdAt} as created_at, ${chatMessages.updatedAt} as updated_at
      from ${chatMessages}
      where ${chatMessages.orgId} = ${input.orgId}::uuid
        and ${chatMessages.conversationId} = ${input.conversationId}::uuid
        and ${chatMessages.supersededAt} is null
    ) source
    where (date_trunc('milliseconds', source.created_at), source.id, source.kind_order)
      <= (${after.createdAt}::timestamptz, ${after.id}::uuid, ${after.kind === "run" ? 0 : 1}::int)
  )` })
    .from(chatConversations)
    .where(and(eq(chatConversations.orgId, input.orgId), eq(chatConversations.id, input.conversationId)))
    .limit(1);
  if (!row) throw transcriptReaderError("cursor_revision_mismatch", "Transcript source revision is no longer current");
  return stableHash({
    baseRevision,
    after: { kind: after.kind, id: after.id, createdAt: after.createdAt },
    sourceRevision: row.sourceRevision,
  });
}

function assertConversationCursor(
  cursor: CursorPayload | null,
  input: ReadConversationTranscript,
): ConversationSourceCursor[] {
  if (!cursor) return [];
  if (cursor.scope !== "conversation"
    || cursor.orgId !== input.orgId
    || cursor.principalScopeRef !== selectedPrincipalScope(input.principal, input.orgId)
    || (cursor.principalType !== undefined && cursor.principalType !== (input.principal.type ?? undefined))
    || (cursor.principalId !== undefined && cursor.principalId !== (input.principal.id ?? undefined))
    || cursor.conversationId !== input.conversationId
    || (cursor.spanId ?? null) !== (input.spanId ?? null)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this scope");
  }
  if (cursor.range !== undefined && compatibilityValueKey(cursor.range) !== compatibilityValueKey(input.range ?? null)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this range");
  }
  if (cursor.visibilityCutoffRef !== undefined
    && (cursor.visibilityCutoffRef ?? null) !== (input.visibilityCutoffRef ?? null)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this visibility cutoff");
  }
  if (cursor.conversationSources === undefined || cursor.conversationMoreSources === undefined) {
    throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
  }
  const sources = cursor.conversationSources;
  if (!Array.isArray(sources) || sources.length > MAX_PAGE_LIMIT) {
    throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
  }
  for (const source of sources) {
    if ((source.kind !== "run" && source.kind !== "message")
      || typeof source.id !== "string"
      || typeof source.createdAt !== "string"
      || Number.isNaN(Date.parse(source.createdAt))) {
      throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
    }
    if (!Object.prototype.hasOwnProperty.call(source, "updatedAt")) {
      throw transcriptReaderError("cursor_revision_mismatch", "Transcript source revision is no longer current");
    }
    if (source.updatedAt !== null
      && (typeof source.updatedAt !== "string" || Number.isNaN(Date.parse(source.updatedAt)))) {
      throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
    }
    if (source.kind === "run" && source.runCursor !== undefined && source.runCursor !== null && typeof source.runCursor !== "string") {
      throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
    }
    if (source.kind === "message"
      && (!Number.isSafeInteger(source.messageOffset ?? 0) || (source.messageOffset ?? 0) < 0)) {
      throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
    }
    if (source.done !== undefined && typeof source.done !== "boolean") {
      throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
    }
  }
  if (cursor.conversationAfter) {
    const after = cursor.conversationAfter as ConversationSourceAnchor & { updatedAt?: unknown };
    if ((cursor.conversationAfter.kind !== "run" && cursor.conversationAfter.kind !== "message")
      || typeof cursor.conversationAfter.id !== "string"
      || typeof cursor.conversationAfter.createdAt !== "string"
      || Number.isNaN(Date.parse(cursor.conversationAfter.createdAt))) {
      throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
    }
    if (!Object.prototype.hasOwnProperty.call(after, "updatedAt")) {
      throw transcriptReaderError("cursor_revision_mismatch", "Transcript source revision is no longer current");
    }
    if (after.updatedAt !== null
      && (typeof after.updatedAt !== "string" || Number.isNaN(Date.parse(after.updatedAt)))) {
      throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
    }
  }
  if (cursor.conversationMoreSources !== undefined && typeof cursor.conversationMoreSources !== "boolean") {
    throw transcriptReaderError("cursor_invalid", "Invalid conversation transcript cursor");
  }
  return sources;
}

async function assertConversationAfterRevision(
  db: ReadDatabase,
  orgId: string,
  conversationId: string,
  after: ConversationCursorAnchor | null,
): Promise<void> {
  if (!after) return;
  if (after.kind === "run") {
    const run = await selectRun(db, orgId, after.id);
    if (!run || run.chatConversationId !== conversationId) {
      throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this conversation");
    }
    if (conversationDateKey(run.createdAt) !== after.createdAt || sourceUpdatedAt(run.updatedAt) !== after.updatedAt) {
      throw transcriptReaderError("cursor_revision_mismatch", "Transcript source revision is no longer current");
    }
    return;
  }
  const message = await selectConversationMessage(db, orgId, conversationId, after.id);
  if (!message) throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this conversation");
  if (conversationDateKey(message.createdAt) !== after.createdAt || sourceUpdatedAt(message.updatedAt) !== after.updatedAt) {
    throw transcriptReaderError("cursor_revision_mismatch", "Transcript source revision is no longer current");
  }
}

async function resolveConversationSourceRows(
  db: ReadDatabase,
  orgId: string,
  conversationId: string,
  descriptors: readonly ConversationSourceCursor[],
): Promise<ConversationSourceRow[]> {
  return await Promise.all(descriptors.map(async (descriptor): Promise<ConversationSourceRow> => {
    if (descriptor.kind === "run") {
      const run = await selectRun(db, orgId, descriptor.id);
      if (!run || run.chatConversationId !== conversationId) {
        throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this conversation");
      }
      if (conversationDateKey(run.createdAt) !== descriptor.createdAt
        || sourceUpdatedAt(run.updatedAt) !== descriptor.updatedAt) {
        throw transcriptReaderError("cursor_revision_mismatch", "Transcript source revision is no longer current");
      }
      return { descriptor, run };
    }
    const message = await selectConversationMessage(db, orgId, conversationId, descriptor.id);
    if (!message) throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this conversation");
    if (conversationDateKey(message.createdAt) !== descriptor.createdAt
      || sourceUpdatedAt(message.updatedAt) !== descriptor.updatedAt) {
      throw transcriptReaderError("cursor_revision_mismatch", "Transcript source revision is no longer current");
    }
    return { descriptor, message };
  }));
}

function compareConversationCandidates(
  left: ConversationSourceState,
  right: ConversationSourceState,
): number {
  const leftItem = left.candidate!;
  const rightItem = right.candidate!;
  return timestampForItem(leftItem) - timestampForItem(rightItem)
    || leftItem.id.localeCompare(rightItem.id)
    || left.descriptor.id.localeCompare(right.descriptor.id);
}

async function readConversationRunCandidate(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: ReadConversationTranscript,
  descriptor: ConversationSourceCursor,
  nestedRange: TranscriptRange | null,
): Promise<{
  item: TranscriptItem | null;
  nextCursor: string | null;
  source: TranscriptSource;
  availability: TranscriptAvailability;
  completeness: TranscriptCompleteness;
}> {
  const runInput: ReadRunTranscript = {
    orgId: input.orgId,
    runId: descriptor.id,
    principal: input.principal,
    spanId: input.spanId,
    cursor: descriptor.runCursor ?? null,
    limit: 1,
    range: nestedRange,
    visibilityCutoffRef: input.visibilityCutoffRef ?? null,
    signal: input.signal,
  };
  const source = await readRunItems(db, options, runInput);
  const page = pageFromRunSource(source, {
    ...runInput,
    id: descriptor.id,
    cursor: descriptor.runCursor ?? null,
    limit: 1,
  });
  return {
    item: page.items[0] ?? null,
    nextCursor: page.nextCursor,
    source: page.source,
    availability: page.availability,
    completeness: page.completeness,
  };
}

async function primeConversationSource(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: ReadConversationTranscript,
  state: ConversationSourceState,
  nestedRange: TranscriptRange | null,
): Promise<void> {
  if (state.candidate || state.exhausted) return;
  if (state.descriptor.kind === "run") {
    for (let attempt = 0; attempt < MAX_PAGE_LIMIT; attempt += 1) {
      const result = await readConversationRunCandidate(db, options, input, state.descriptor, nestedRange);
      state.source = result.source;
      state.availability = result.availability;
      state.completeness = result.completeness;
      if (result.item) {
        state.candidate = result.item;
        state.candidateNextCursor = result.nextCursor;
        return;
      }
      if (!result.nextCursor) {
        state.exhausted = true;
        return;
      }
      state.descriptor.runCursor = result.nextCursor;
    }
    throw transcriptReaderError("cursor_invalid", "Native transcript reader did not yield a bounded page");
  }

  if (!state.messageItems) {
    const message = state.row.message!;
    const source: ChatTranscriptMessageSource = {
      id: message.id,
      orgId: message.orgId,
      conversationId: message.conversationId,
      role: message.role,
      structuredPayload: message.structuredPayload,
    };
    // The persistence helper selects the complete transcript for one message;
    // the Conversation source window bounds message count, but not this
    // provider's entry-level read until it exposes an entry cursor.
    const transcripts = await loadChatTranscripts(db, [source]);
    state.messageItems = messageEntries(message, transcripts.get(message.id));
    state.source = "legacy";
    state.availability = "available";
    state.completeness = state.messageItems.length > 0 ? "complete" : "terminal_only";
  }
  let offset = state.descriptor.messageOffset ?? 0;
  while (offset < state.messageItems.length) {
    const candidate = state.messageItems[offset]!;
    offset += 1;
    state.descriptor.messageOffset = offset - 1;
    state.candidate = candidate;
    state.candidateNextCursor = null;
    return;
  }
  state.descriptor.messageOffset = offset;
  state.exhausted = true;
}

function conversationCursorFor(input: {
  orgId: string;
  principal: TranscriptPrincipal;
  conversationId: string;
  spanId?: string | null;
  cursor: CursorPayload | null;
  revision: string;
  after: ConversationCursorAnchor | null;
  sources: readonly ConversationSourceCursor[];
  moreSources: boolean;
  source: TranscriptSource;
  position: number;
}): string {
  return encodeCursor({
    version: 1,
    scope: "conversation",
    orgId: input.orgId,
    principalScopeRef: selectedPrincipalScope(input.principal, input.orgId),
    principalType: input.principal.type ?? undefined,
    principalId: input.principal.id ?? undefined,
    conversationId: input.conversationId,
    spanId: input.spanId ?? null,
    source: input.source,
    range: input.cursor?.range ?? null,
    visibilityCutoffRef: input.cursor?.visibilityCutoffRef ?? null,
    conversationAfter: input.after,
    conversationSources: [...input.sources],
    conversationMoreSources: input.moreSources,
    revision: input.revision,
    position: input.position,
  });
}

export async function readConversationItems(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: ReadConversationTranscript,
): Promise<ConversationReadPage> {
  try {
    return await readConversationItemsOnce(db, options, input);
  } catch (error) {
    // Fresh hydration creates nested Run cursors while merging sources. If a
    // source changes before this page is returned, discard the entire page;
    // never combine its prefix with a new revision or replay a public Send.
    // External continuation cursors must still fail closed. One fresh read
    // bounds the refresh; sustained source drift remains an explicit error.
    if (input.cursor || input.signal?.aborted || !(error instanceof TranscriptReaderError)
      || error.code !== "cursor_revision_mismatch") throw error;
    return await readConversationItemsOnce(db, options, input);
  }
}

async function readConversationItemsOnce(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: ReadConversationTranscript,
): Promise<ConversationReadPage> {
  const conversation = await selectConversation(db, input.orgId, input.conversationId);
  if (!conversation) throw notFound("Conversation not found");
  const binding = await selectBindingByConversation(db, input.orgId, input.conversationId);
  await authorize(options, {
    orgId: input.orgId,
    principal: input.principal,
    target: "conversation",
    conversationId: conversation.id,
    binding,
  });

  const baseRevision = conversationRevision(conversation, input);
  const cursor = decodeCursor(input.cursor);
  const cursorSources = assertConversationCursor(cursor, input);
  let after = cursor?.conversationAfter
    ? cursor.conversationAfter as ConversationCursorAnchor
    : null;
  await assertConversationAfterRevision(db, input.orgId, input.conversationId, after);
  if (cursor && cursor.revision !== await conversationReadRevision(db, input, baseRevision, after)) {
    throw transcriptReaderError("cursor_revision_mismatch", "Transcript cursor revision is no longer current");
  }
  const limit = normalizeLimit(input.limit);
  const { nestedRange, numericRange } = splitConversationRange(input.range);
  let position = cursor?.position ?? 0;
  let moreSources = cursor?.conversationMoreSources ?? false;
  let rows = cursorSources.length > 0
    ? await resolveConversationSourceRows(db, input.orgId, input.conversationId, cursorSources)
    : [];
  const sourceValues: TranscriptSource[] = [];
  const availabilityValues: TranscriptAvailability[] = [];
  const completenessValues: TranscriptCompleteness[] = [];
  const items: TranscriptItem[] = [];
  let scannedSources = 0;
  let scannedCandidates = 0;

  while (items.length < limit && scannedSources < MAX_CONVERSATION_SOURCE_SCAN
    && scannedCandidates < MAX_CONVERSATION_SOURCE_SCAN && !numericRangeEndReached(numericRange, position)) {
    if (rows.length === 0) {
      if (!moreSources && (cursorSources.length > 0 || cursor?.conversationMoreSources === false)) break;
      const window = await selectConversationSourceWindow(
        db,
        input.orgId,
        input.conversationId,
        after,
        limit,
      );
      rows = window.rows;
      moreSources = window.hasMore;
      if (rows.length === 0) break;
    }

    scannedSources += rows.length;
    const states: ConversationSourceState[] = rows.map((row) => ({
      descriptor: { ...row.descriptor },
      row,
      candidate: null,
      candidateNextCursor: null,
      source: row.descriptor.kind === "run" ? "native" : "legacy",
      availability: "available",
      completeness: "unknown",
      exhausted: row.descriptor.done === true,
    }));
    for (const state of states.filter((candidate) => candidate.descriptor.kind === "run")) {
      await primeConversationSource(db, options, input, state, nestedRange);
    }
    for (const state of states.filter((candidate) => candidate.descriptor.kind === "message")) {
      await primeConversationSource(db, options, input, state, nestedRange);
    }
    for (const state of states) {
      if (state.descriptor.kind === "run" || state.candidate) {
        sourceValues.push(state.source);
        availabilityValues.push(state.availability);
        completenessValues.push(state.completeness);
      }
    }

    while (items.length < limit && scannedCandidates < MAX_CONVERSATION_SOURCE_SCAN
      && !numericRangeEndReached(numericRange, position)) {
      const available = states.filter((state) => !state.exhausted && state.candidate);
      if (available.length === 0) break;
      const state = [...available].sort(compareConversationCandidates)[0]!;
      const candidate = state.candidate!;
      state.candidate = null;
      scannedCandidates += 1;
      if (candidate.visibility !== "hidden") {
        if (pageItemsForRange([candidate], { range: numericRange, sourceOffset: position }).length > 0) {
          items.push(candidate);
        }
        position += 1;
      }
      if (state.descriptor.kind === "run") {
        if (state.candidateNextCursor) state.descriptor.runCursor = state.candidateNextCursor;
        else state.exhausted = true;
      } else {
        state.descriptor.messageOffset = (state.descriptor.messageOffset ?? 0) + 1;
      }
      if (state.exhausted) state.descriptor.done = true;
      state.candidateNextCursor = null;
      if (!state.exhausted && items.length < limit && scannedCandidates < MAX_CONVERSATION_SOURCE_SCAN
        && !numericRangeEndReached(numericRange, position)) {
        await primeConversationSource(db, options, input, state, nestedRange);
      }
    }

    for (const state of states) {
      if (state.exhausted) state.descriptor.done = true;
    }
    let contiguousAfter = after;
    let firstPendingIndex = 0;
    for (const [index, state] of states.entries()) {
      if (!state.exhausted) break;
      contiguousAfter = {
        kind: state.descriptor.kind,
        id: state.descriptor.id,
        createdAt: state.descriptor.createdAt,
        updatedAt: state.descriptor.updatedAt ?? null,
      };
      firstPendingIndex = index + 1;
    }
    after = contiguousAfter;

    const pendingRows = states.slice(firstPendingIndex);
    rows = pendingRows.map((state) => ({
      ...state.row,
      descriptor: { ...state.descriptor },
    }));
    if (items.length >= limit || rows.length > 0 || scannedCandidates >= MAX_CONVERSATION_SOURCE_SCAN
      || numericRangeEndReached(numericRange, position)) break;
  }

  const pendingSources = rows.map((row) => row.descriptor);
  const pageItems = sortConversationItems(pageItemsForRange(items, { ...input, range: nestedRange }));
  const source = mergeSource(sourceValues);
  const revision = await conversationReadRevision(db, input, baseRevision, after);
  const nextCursor = !numericRangeEndReached(numericRange, position) && (pendingSources.length > 0 || moreSources)
    ? conversationCursorFor({
      orgId: input.orgId,
      principal: input.principal,
      conversationId: input.conversationId,
      spanId: input.spanId,
      cursor: cursor ?? {
        version: 1,
        scope: "conversation",
        orgId: input.orgId,
        principalScopeRef: selectedPrincipalScope(input.principal, input.orgId),
        conversationId: input.conversationId,
        range: input.range ?? null,
        visibilityCutoffRef: input.visibilityCutoffRef ?? null,
        revision,
        position: 0,
      },
      revision,
      after,
      sources: pendingSources,
      moreSources,
      source,
      position,
    })
    : null;
  return {
    items: pageItems,
    nextCursor,
    source,
    revision,
    availability: mergeAvailability(availabilityValues),
    completeness: mergeCompleteness(completenessValues),
  };
}
