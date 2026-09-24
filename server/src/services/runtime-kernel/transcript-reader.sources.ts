import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import {
  chatConversations,
  chatMessages,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { buildTranscript, getTranscriptParser, parseNdjsonLog } from "@rudderhq/run-intelligence-core";
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { forbidden, notFound } from "../../errors.js";
import {
  getRunLogStore,
  type RunLogHandle,
  type RunLogReadResult,
  type RunLogStore,
} from "../run-log-store.js";
import { isExplicitLegacyTranscriptSource, isNativeTranscriptSource } from "./transcript-source.js";
import {
  DEFAULT_LEGACY_READ_BYTES,
  MAX_CONVERSATION_SOURCE_SCAN,
  MAX_LEGACY_READ_BYTES,
  MAX_PAGE_LIMIT,
} from "./transcript-reader.contracts.js";
import type {
  ConversationMessageRecord,
  ConversationSourceAnchor,
  ConversationSourceCursor,
  ConversationSourceKind,
  ConversationSourceRow,
  HeartbeatRunRecord,
  NativeSegmentRecord,
  NativeTranscriptReadInput,
  NativeTranscriptReadResult,
  NativeTranscriptRawItem,
  ReadDatabase,
  ReadRunTranscript,
  ResolvedSource,
  RunRuntimeSpanRecord,
  RuntimeBindingRecord,
  TranscriptAvailability,
  TranscriptCompleteness,
  TranscriptItem,
  TranscriptPrincipal,
  TranscriptRange,
  TranscriptReaderOptions,
  TranscriptSource,
  LegacyTranscriptReaderHook,
  LegacyTranscriptReadResult,
} from "./transcript-reader.contracts.js";
import {
  asRecord,
  assertSpanRuntimeConsistency,
  isoDate,
  isUnavailable,
  mergeAvailability,
  mergeCompleteness,
  mergeSource,
  mergeSupplementItems,
  nonEmptyString,
  normalizeItems,
  normalizeNativeResult,
  principalScopeRefs,
  runtimeTypeFromRun,
  selectedPrincipalScope,
  selectorFromSpan,
  stableHash,
  stringAt,
  transcriptEntry,
  transcriptReaderError,
} from "./transcript-reader.normalize.js";
import {
  applyVisibilityCutoff,
  decodeCursor,
  normalizeLimit,
  numericRangeEndReached,
  pageItemsForRange,
} from "./transcript-reader.pages.js";

function rawItemsFromResult(result: NativeTranscriptReadResult): readonly NativeTranscriptRawItem[] {
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.entries)) return result.entries;
  return result.item ? [result.item] : [];
}

function providerRangeForRead(range: TranscriptRange | null | undefined): TranscriptRange | null | undefined {
  if (!range) return range;
  let providerRange = range;
  for (const key of ["start", "end", "fromExclusive", "after", "throughInclusive", "before"] as const) {
    if (typeof providerRange[key] === "number") providerRange = { ...providerRange, [key]: undefined };
  }
  return Object.values(providerRange).some((value) => value !== undefined && value !== null)
    ? providerRange
    : null;
}

function defaultRevision(run: HeartbeatRunRecord, prefix: string): string {
  return stableHash({
    prefix,
    id: run.id,
    logSha256: run.logSha256,
    logBytes: run.logBytes,
    updatedAt: run.updatedAt,
  });
}

function transcriptCandidates(payload: unknown): TranscriptEntry[] {
  const record = asRecord(payload);
  if (!record) return [];
  const candidates = [record.__chatTranscript, record.transcript, record.entries, record.items];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const entries = candidate.map(transcriptEntry).filter((entry): entry is TranscriptEntry => Boolean(entry));
    if (entries.length > 0) return entries;
  }
  return [];
}

function entriesFromLegacyEvents(events: readonly Record<string, unknown>[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const event of events) {
    // Durable transcript events are the legacy compatibility source. Live-only
    // projections use seq=null and must never become historical transcript.
    if (event.eventType !== "transcript.entry" || event.seq === null) continue;
    const sourceEntryId = typeof event.id === "string" || typeof event.id === "number"
      ? String(event.id)
      : null;
    const payload = asRecord(event.payload);
    const candidates = [payload?.entry, payload?.transcriptEntry, payload?.transcript, event.payload];
    let found = false;
    for (const candidate of candidates) {
      const entry = transcriptEntry(candidate);
      if (entry) {
        entries.push(sourceEntryId && !entry.sourceEntryId ? { ...entry, sourceEntryId } : entry);
        found = true;
        break;
      }
    }
    if (found) continue;
    const message = nonEmptyString(event.message);
    if (!message) continue;
    const stream = event.stream === "stderr" ? "stderr" : event.stream === "system" ? "system" : "stdout";
    entries.push({
      kind: stream,
      ts: isoDate(event.createdAt),
      text: message,
      ...(sourceEntryId ? { sourceEntryId } : {}),
    });
  }
  return entries;
}

function eventSpanId(event: Record<string, unknown>): string | null {
  const payload = asRecord(event.payload);
  const nested = asRecord(payload?.entry ?? payload?.transcriptEntry ?? payload?.transcript);
  return stringAt(payload, ["spanId", "span_id"])
    ?? stringAt(nested, ["spanId", "span_id"]);
}

async function readAllLegacyLog(
  store: RunLogStore,
  handle: RunLogHandle,
  options: { maxReadBytes: number; signal?: AbortSignal },
): Promise<string> {
  let offset = 0;
  let content = "";
  for (let page = 0; page < 100_000; page += 1) {
    if (options.signal?.aborted) throw new Error("legacy transcript read cancelled");
    const result: RunLogReadResult = await store.read(handle, {
      offset,
      limitBytes: options.maxReadBytes,
      signal: options.signal,
    });
    content += result.content;
    if (result.eof) return content;
    const nextOffset = result.nextOffset ?? result.endOffset;
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset) throw new Error("Legacy transcript reader made no progress");
    offset = nextOffset;
  }
  throw new Error("Legacy transcript exceeds the readable page limit");
}

function legacyEntriesFromRun(run: HeartbeatRunRecord, rawLog: string, runtimeType: string, events: readonly Record<string, unknown>[]): TranscriptEntry[] {
  let rawLogFallback: TranscriptEntry[] = [];
  if (rawLog) {
    const chunks = parseNdjsonLog(rawLog);
    if (chunks.length > 0) {
      const entries = buildTranscript(chunks, getTranscriptParser(runtimeType));
      if (entries.length > 0) return entries;
    }
    rawLogFallback = [{ kind: "stdout", ts: isoDate(run.startedAt ?? run.createdAt), text: rawLog }];
  }
  const fromResult = transcriptCandidates(run.resultJson);
  if (fromResult.length > 0) return fromResult;
  const fromContext = transcriptCandidates(run.contextSnapshot);
  if (fromContext.length > 0) return fromContext;
  const fromEvents = entriesFromLegacyEvents(events);
  return fromEvents.length > 0 ? fromEvents : rawLogFallback;
}

export function createLegacyTranscriptReader(options: {
  logStore?: RunLogStore;
  maxReadBytes?: number;
} = {}): LegacyTranscriptReaderHook {
  const store = options.logStore ?? getRunLogStore();
  const maxReadBytes = Math.max(4, Math.min(MAX_LEGACY_READ_BYTES, Math.floor(options.maxReadBytes ?? DEFAULT_LEGACY_READ_BYTES)));
  return {
    async readRun(input) {
      if (input.run.logCompressed) {
        return {
          entries: [],
          revision: defaultRevision(input.run, "compressed"),
          availability: "incompatible",
          completeness: "unknown",
        };
      }
      let rawLog = "";
      if (input.run.logStore && input.run.logRef) {
        try {
          rawLog = await readAllLegacyLog(store, {
            store: input.run.logStore as RunLogHandle["store"],
            logRef: input.run.logRef,
          }, { maxReadBytes, signal: input.signal });
        } catch (error) {
          if ((error as { status?: unknown }).status === 404) {
            return {
              entries: [],
              revision: defaultRevision(input.run, "missing"),
              availability: "missing",
              completeness: "unknown",
            };
          }
          throw error;
        }
      }
      const entries = legacyEntriesFromRun(input.run, rawLog, input.runtimeType, input.events ?? []);
      return {
        entries,
        revision: defaultRevision(input.run, rawLog ? "log" : "payload"),
        availability: "available",
        completeness: entries.length > 0 ? "complete" : "terminal_only",
      };
    },
  };
}

export async function selectRun(db: ReadDatabase, orgId: string, runId: string): Promise<HeartbeatRunRecord | null> {
  const rows = await db
    .select()
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.orgId, orgId), eq(heartbeatRuns.id, runId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function selectConversation(db: ReadDatabase, orgId: string, conversationId: string) {
  const rows = await db
    .select()
    .from(chatConversations)
    .where(and(eq(chatConversations.orgId, orgId), eq(chatConversations.id, conversationId)))
    .limit(1);
  return rows[0] ?? null;
}

async function selectBindingById(db: ReadDatabase, orgId: string, bindingId: string): Promise<RuntimeBindingRecord | null> {
  const rows = await db
    .select()
    .from(runtimeBindings)
    .where(and(eq(runtimeBindings.orgId, orgId), eq(runtimeBindings.id, bindingId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function selectBindingByConversation(db: ReadDatabase, orgId: string, conversationId: string): Promise<RuntimeBindingRecord | null> {
  const rows = await db
    .select()
    .from(runtimeBindings)
    .where(and(eq(runtimeBindings.orgId, orgId), eq(runtimeBindings.conversationId, conversationId), eq(runtimeBindings.status, "active")))
    .orderBy(desc(runtimeBindings.bindingEpoch))
    .limit(1);
  return rows[0] ?? null;
}

async function selectSegment(db: ReadDatabase, orgId: string, segmentId: string): Promise<NativeSegmentRecord | null> {
  const rows = await db
    .select()
    .from(nativeSegments)
    .where(and(eq(nativeSegments.orgId, orgId), eq(nativeSegments.id, segmentId)))
    .limit(1);
  return rows[0] ?? null;
}

async function selectSpans(db: ReadDatabase, orgId: string, runId: string): Promise<RunRuntimeSpanRecord[]> {
  return await db
    .select()
    .from(runRuntimeSpans)
    .where(and(eq(runRuntimeSpans.orgId, orgId), eq(runRuntimeSpans.runId, runId)))
    .orderBy(asc(runRuntimeSpans.ordinal), asc(runRuntimeSpans.id));
}

async function selectLegacyEvents(db: ReadDatabase, orgId: string, runId: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .select()
    .from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.orgId, orgId), eq(heartbeatRunEvents.runId, runId)))
    .orderBy(asc(heartbeatRunEvents.seq), asc(heartbeatRunEvents.id));
  return rows as Record<string, unknown>[];
}

export function conversationDateKey(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = value ? new Date(value) : new Date(0);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function conversationSourceAnchor(
  kind: ConversationSourceKind,
  row: { id: string; createdAt: Date; updatedAt?: Date | null },
): ConversationSourceCursor {
  return {
    kind,
    id: row.id,
    createdAt: conversationDateKey(row.createdAt),
    updatedAt: row.updatedAt ? conversationDateKey(row.updatedAt) : null,
    ...(kind === "run" ? { runCursor: null } : { messageOffset: 0 }),
  };
}

async function selectConversationRuns(
  db: ReadDatabase,
  orgId: string,
  conversationId: string,
  after: ConversationSourceAnchor | null = null,
  limit = MAX_PAGE_LIMIT + 1,
): Promise<HeartbeatRunRecord[]> {
  // Cursor dates are JavaScript milliseconds; use that same ordering in SQL
  // when PostgreSQL stored a source with additional microsecond precision.
  const createdAtKey = sql<Date>`date_trunc('milliseconds', ${heartbeatRuns.createdAt})`;
  const afterCondition = after
    ? (() => {
      const timestamp = new Date(after.createdAt);
      if (Number.isNaN(timestamp.getTime())) throw transcriptReaderError("cursor_invalid", "Invalid conversation source cursor");
      const cursorKey = sql<Date>`${after.createdAt}::timestamptz`;
      return or(
        gt(createdAtKey, cursorKey),
        and(eq(createdAtKey, cursorKey), gt(heartbeatRuns.id, after.id)),
      );
    })()
    : undefined;
  return await db
    .select()
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.orgId, orgId),
      eq(heartbeatRuns.chatConversationId, conversationId),
      afterCondition,
    ))
    .orderBy(asc(createdAtKey), asc(heartbeatRuns.id))
    .limit(Math.min(MAX_PAGE_LIMIT + 1, Math.max(1, limit)));
}

async function selectConversationMessages(
  db: ReadDatabase,
  orgId: string,
  conversationId: string,
  after: ConversationSourceAnchor | null = null,
  limit = MAX_PAGE_LIMIT + 1,
): Promise<ConversationMessageRecord[]> {
  const createdAtKey = sql<Date>`date_trunc('milliseconds', ${chatMessages.createdAt})`;
  const afterCondition = after
    ? (() => {
      const timestamp = new Date(after.createdAt);
      if (Number.isNaN(timestamp.getTime())) throw transcriptReaderError("cursor_invalid", "Invalid conversation source cursor");
      const cursorKey = sql<Date>`${after.createdAt}::timestamptz`;
      return or(
        gt(createdAtKey, cursorKey),
        and(eq(createdAtKey, cursorKey), gt(chatMessages.id, after.id)),
      );
    })()
    : undefined;
  return await db
    .select({
      id: chatMessages.id,
      orgId: chatMessages.orgId,
      conversationId: chatMessages.conversationId,
      role: chatMessages.role,
      body: chatMessages.body,
      kind: chatMessages.kind,
      structuredPayload: chatMessages.structuredPayload,
      runId: chatMessages.runId,
      createdAt: chatMessages.createdAt,
      updatedAt: chatMessages.updatedAt,
    })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.orgId, orgId),
      eq(chatMessages.conversationId, conversationId),
      isNull(chatMessages.supersededAt),
      afterCondition,
    ))
    .orderBy(asc(createdAtKey), asc(chatMessages.id))
    .limit(Math.min(MAX_PAGE_LIMIT + 1, Math.max(1, limit)));
}

export async function selectConversationMessage(
  db: ReadDatabase,
  orgId: string,
  conversationId: string,
  messageId: string,
): Promise<ConversationMessageRecord | null> {
  const rows = await db
    .select({
      id: chatMessages.id,
      orgId: chatMessages.orgId,
      conversationId: chatMessages.conversationId,
      role: chatMessages.role,
      body: chatMessages.body,
      kind: chatMessages.kind,
      structuredPayload: chatMessages.structuredPayload,
      runId: chatMessages.runId,
      createdAt: chatMessages.createdAt,
      updatedAt: chatMessages.updatedAt,
    })
    .from(chatMessages)
    .where(and(
      eq(chatMessages.orgId, orgId),
      eq(chatMessages.conversationId, conversationId),
      eq(chatMessages.id, messageId),
      isNull(chatMessages.supersededAt),
    ))
    .limit(1);
  return rows[0] ?? null;
}

function compareConversationSourceRows(left: ConversationSourceRow, right: ConversationSourceRow): number {
  const createdAt = Date.parse(left.descriptor.createdAt) - Date.parse(right.descriptor.createdAt);
  if (createdAt !== 0) return createdAt;
  const id = left.descriptor.id.localeCompare(right.descriptor.id);
  if (id !== 0) return id;
  return left.descriptor.kind === right.descriptor.kind
    ? 0
    : left.descriptor.kind === "run" ? -1 : 1;
}

export async function selectConversationSourceWindow(
  db: ReadDatabase,
  orgId: string,
  conversationId: string,
  after: ConversationSourceAnchor | null,
  limit: number,
): Promise<{ rows: ConversationSourceRow[]; hasMore: boolean }> {
  const sourceLimit = Math.min(MAX_PAGE_LIMIT, Math.max(1, limit));
  const [runs, messages] = await Promise.all([
    selectConversationRuns(db, orgId, conversationId, after, sourceLimit + 1),
    selectConversationMessages(db, orgId, conversationId, after, sourceLimit + 1),
  ]);
  const rows: ConversationSourceRow[] = [
    ...runs.map((run) => ({
      descriptor: conversationSourceAnchor("run", run),
      run,
    } satisfies ConversationSourceRow)),
    ...messages.map((message) => ({
      descriptor: conversationSourceAnchor("message", message),
      message,
    } satisfies ConversationSourceRow)),
  ].sort(compareConversationSourceRows);
  return {
    rows: rows.slice(0, sourceLimit),
    hasMore: rows.length > sourceLimit,
  };
}

export async function authorize(
  options: TranscriptReaderOptions,
  input: {
    orgId: string;
    principal: TranscriptPrincipal;
    target: "run" | "conversation" | "span";
    runId?: string;
    conversationId?: string | null;
    binding?: RuntimeBindingRecord | null;
    storedPrincipalScopeRef?: string | null;
  },
) {
  if (input.principal.authorized === false || (input.principal.orgId && input.principal.orgId !== input.orgId)) {
    throw forbidden("Transcript access denied");
  }
  if (options.authorizePrincipal && !(await options.authorizePrincipal(input))) {
    throw forbidden("Transcript access denied");
  }
  const scopes = principalScopeRefs(input.principal, input.orgId);
  const expected = input.binding?.principalScopeRef ?? input.storedPrincipalScopeRef;
  const isBoardOperator = input.principal.type === "board" && input.principal.authorized === true;
  if (expected && !isBoardOperator && !scopes.includes(expected)) throw forbidden("Transcript access denied");
}

function storedPrincipalScope(run: HeartbeatRunRecord): string | null {
  const context = asRecord(run.contextSnapshot);
  return stringAt(context, ["principalScopeRef", "principal_scope_ref", "authorizedPrincipal", "authorized_principal"]);
}

async function resolveRunScope(db: ReadDatabase, options: TranscriptReaderOptions, input: ReadRunTranscript) {
  const run = await selectRun(db, input.orgId, input.runId);
  if (!run) throw notFound("Agent run not found");
  const allSpans = await selectSpans(db, input.orgId, input.runId);
  const spans = input.spanId === undefined || input.spanId === null
    ? allSpans
    : allSpans.filter((span) => span.id === input.spanId);
  if (input.spanId !== undefined && input.spanId !== null && spans.length === 0) {
    throw notFound("Transcript span not found");
  }
  const bindingById = new Map<string, RuntimeBindingRecord>();
  const segmentById = new Map<string, NativeSegmentRecord>();
  if (run.chatConversationId) {
    const binding = await selectBindingByConversation(db, input.orgId, run.chatConversationId);
    if (binding) bindingById.set(binding.id, binding);
  }
  for (const span of spans) {
    if (!bindingById.has(span.bindingId)) {
      const binding = await selectBindingById(db, input.orgId, span.bindingId);
      if (binding) bindingById.set(binding.id, binding);
    }
    if (!segmentById.has(span.segmentId)) {
      const segment = await selectSegment(db, input.orgId, span.segmentId);
      if (segment) segmentById.set(segment.id, segment);
    }
  }
  await authorize(options, {
    orgId: input.orgId,
    principal: input.principal,
    target: "run",
    runId: run.id,
    conversationId: run.chatConversationId,
    binding: run.chatConversationId ? [...bindingById.values()].find((binding) => binding.conversationId === run.chatConversationId) ?? null : null,
    storedPrincipalScopeRef: storedPrincipalScope(run),
  });
  for (const span of spans) {
    const binding = bindingById.get(span.bindingId) ?? null;
    const segment = segmentById.get(span.segmentId) ?? null;
    if (!binding || !segment || segment.bindingId !== span.bindingId || binding.conversationId !== run.chatConversationId) {
      throw forbidden("Transcript source is not authorized");
    }
    assertSpanRuntimeConsistency(binding, segment, selectorFromSpan(span));
    await authorize(options, {
      orgId: input.orgId,
      principal: input.principal,
      target: "span",
      runId: run.id,
      conversationId: run.chatConversationId,
      binding,
    });
  }
  return {
    run,
    spans,
    bindingById,
    segmentById,
    nativeSourceContract: isNativeTranscriptSource(run, { hasRuntimeSpan: allSpans.length > 0 }),
  };
}

async function readNativeSpan(
  options: TranscriptReaderOptions,
  input: NativeTranscriptReadInput,
  origin: "native" | "object",
): Promise<ResolvedSource> {
  const hook = origin === "object" ? options.objectReader : options.nativeReader;
  if (origin === "object" && input.span.supplementalRetentionExpiredAt) {
    const revision = stableHash({ spanId: input.span.id, expiredAt: input.span.supplementalRetentionExpiredAt });
    return {
      items: [],
      source: "native_plus_objects",
      revision,
      providerRevision: revision,
      availability: "expired",
      completeness: "unknown",
      providerCursor: input.cursor,
      providerNextCursor: null,
      spanId: input.span.id,
      legacyFallbackEligible: false,
    };
  }
  if (origin === "native" && (input.selector.kind === "pending" || input.selector.kind === "unresolved")) {
    const revision = stableHash({ spanId: input.span.id, selector: input.selector, updatedAt: input.span.updatedAt });
    return {
      items: [],
      source: "native",
      revision,
      providerRevision: revision,
      availability: "missing",
      completeness: "unknown",
      providerCursor: input.cursor,
      providerNextCursor: null,
      spanId: input.span.id,
      legacyFallbackEligible: false,
    };
  }
  if (!hook) {
    return {
      items: [],
      source: origin === "object" ? "native_plus_objects" : "native",
      revision: stableHash({ spanId: input.span.id, selector: input.selector, updatedAt: input.span.updatedAt }),
      providerRevision: stableHash({ spanId: input.span.id, selector: input.selector, updatedAt: input.span.updatedAt }),
      availability: "offline",
      completeness: input.span.completeness,
      providerCursor: input.cursor,
      providerNextCursor: null,
      spanId: input.span.id,
      legacyFallbackEligible: true,
    };
  }

  const canRead = Boolean(input.itemId && hook.readItem || hook.readRange || hook.read);
  if (!canRead) {
    return {
      items: [],
      source: origin === "object" ? "native_plus_objects" : "native",
      revision: stableHash({ spanId: input.span.id, selector: input.selector, updatedAt: input.span.updatedAt }),
      providerRevision: stableHash({ spanId: input.span.id, selector: input.selector, updatedAt: input.span.updatedAt }),
      availability: "offline",
      completeness: input.span.completeness,
      providerCursor: input.cursor,
      providerNextCursor: null,
      spanId: input.span.id,
      legacyFallbackEligible: true,
    };
  }

  if (input.signal?.aborted) throw new Error("transcript read cancelled");
  const hookInput = { ...input, limit: normalizeLimit(input.limit) };
  let raw: NativeTranscriptReadResult | readonly NativeTranscriptRawItem[] | NativeTranscriptRawItem | null;
  if (input.itemId && hook.readItem) raw = await hook.readItem(hookInput);
  else if (hook.readRange) raw = await hook.readRange(hookInput);
  else if (hook.read) raw = await hook.read(hookInput);
  else raw = [];
  const result = normalizeNativeResult(raw);
  const items = normalizeItems(rawItemsFromResult(result), {
    runId: input.run.id,
    spanId: input.span.id,
    origin,
  });
  const revision = nonEmptyString(result.revision)
    ?? stableHash({ spanId: input.span.id, selector: input.selector, updatedAt: input.span.updatedAt });
  const availability = result.availability ?? "available";
  const completeness = result.completeness ?? input.span.completeness;
  const nextCursor = nonEmptyString(result.nextCursor);
  if (nextCursor && nextCursor === input.cursor) throw new Error("Native transcript reader cursor made no progress");
  return {
    items,
    source: origin === "object" ? "native_plus_objects" : "native",
    revision,
    providerRevision: revision,
    availability,
    completeness,
    providerCursor: input.cursor,
    providerNextCursor: nextCursor,
    spanId: input.span.id,
    legacyFallbackEligible: items.length === 0 && isUnavailable(availability),
  };
}

async function readNativeSources(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: {
    orgId: string;
    principal: TranscriptPrincipal;
    run: HeartbeatRunRecord;
    spans: RunRuntimeSpanRecord[];
    bindings: Map<string, RuntimeBindingRecord>;
    segments: Map<string, NativeSegmentRecord>;
    range?: TranscriptRange | null;
    visibilityCutoffRef?: string | null;
    activeSpanId?: string | null;
    providerCursor?: string | null;
    providerOffset?: number;
    allowLegacyFallback?: boolean;
    limit?: number;
    itemId?: string | null;
    signal?: AbortSignal;
  },
): Promise<ResolvedSource> {
  const sources: ResolvedSource[] = [];
  const activeSpanIndex = input.activeSpanId
    ? input.spans.findIndex((candidate) => candidate.id === input.activeSpanId)
    : 0;
  if (activeSpanIndex < 0) throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor span is not part of this run");
  const pageLimit = normalizeLimit(input.limit);
  const spans = input.spans.slice(activeSpanIndex);
  let sourceOffset = input.providerOffset ?? 0;
  for (const [spanOffset, span] of spans.entries()) {
    const collectedCount = sources.reduce((count, source) => count + source.items.length, 0);
    if (collectedCount >= pageLimit) break;
    const providerCursor = spanOffset === 0 ? input.providerCursor ?? null : null;
    const providerOffset = sourceOffset;
    const binding = input.bindings.get(span.bindingId) ?? null;
    const segment = input.segments.get(span.segmentId) ?? null;
    const hookInput: NativeTranscriptReadInput = {
      readonly: true,
      scope: "run",
      orgId: input.orgId,
      principal: input.principal,
      run: input.run,
      binding,
      segment,
      span,
      selector: selectorFromSpan(span),
      cursor: providerCursor,
      limit: pageLimit - collectedCount,
      itemId: input.itemId ?? null,
      range: providerRangeForRead(input.range),
      visibilityCutoffRef: input.visibilityCutoffRef ?? span.visibilityCutoffRef,
      signal: input.signal,
    };
    const objectRef = nonEmptyString(span.supplementalObjectRef);
    const cursorObjectSource = binding?.runtimeType === "cursor" && Boolean(objectRef);
    const expiredSupplement = Boolean(objectRef && span.supplementalRetentionExpiredAt);
    const itemsForSpan = (candidate: ResolvedSource) => candidate.items.filter((item) =>
      item.runId === input.run.id && item.spanId === span.id,
    );
    const explicitLegacySource = isExplicitLegacyTranscriptSource(input.run, {
      bindingContinuity: binding?.continuity,
    });
    let result = explicitLegacySource
      ? await readLegacySource(db, options, {
        orgId: input.orgId,
        run: input.run,
        binding,
        spanId: span.id,
        signal: input.signal,
      })
      : cursorObjectSource
      ? await readNativeSpan(options, hookInput, "object")
      : expiredSupplement
      ? await readNativeSpan(options, hookInput, "object")
      : options.nativeReader
      ? await readNativeSpan(options, hookInput, "native")
      : objectRef && options.objectReader
        ? await readNativeSpan(options, hookInput, "object")
        : await readNativeSpan(options, hookInput, "native");
    if (!explicitLegacySource && !cursorObjectSource && !expiredSupplement && objectRef
      && options.objectReader
      && (isUnavailable(result.availability) || result.completeness !== "complete")) {
      // A partial native range is not authoritative for the missing tail. Read
      // the bounded supplement and merge by stable source identity instead of
      // replacing the native page or silently dropping the supplement.
      const objectResult = await readNativeSpan(options, { ...hookInput, cursor: null }, "object");
      const nativeItems = itemsForSpan(result);
      const objectItems = itemsForSpan(objectResult);
      const availability = objectItems.length > 0 || objectResult.availability === "available"
        ? objectResult.availability
        : result.availability;
      result = {
        ...result,
        items: mergeSupplementItems(nativeItems, objectItems),
        source: "native_plus_objects",
        revision: stableHash([result.revision, objectResult.revision]),
        availability,
        completeness: mergeCompleteness([result.completeness, objectResult.completeness]),
        legacyFallbackEligible: nativeItems.length === 0
          && objectItems.length === 0
          && isUnavailable(availability),
      };
    }
    let spanItems = itemsForSpan(result);
    // A native binding is an explicit source contract. Old duplicated logs
    // cannot silently replace an offline or pruned provider history.
    const nativeSourceContract = isNativeTranscriptSource(input.run, {
      bindingContinuity: binding?.continuity,
    });
    const allowLegacyFallback = input.allowLegacyFallback !== false && !nativeSourceContract;
    if (!explicitLegacySource && allowLegacyFallback && spanItems.length === 0 && isUnavailable(result.availability)) {
      const legacy = await readLegacySource(db, options, {
        orgId: input.orgId,
        run: input.run,
        binding,
        spanId: span.id,
        signal: input.signal,
      });
      if (legacy.items.length > 0) {
        result = legacy;
        spanItems = itemsForSpan(result);
      } else if (legacy.availability !== "available") {
        result = {
          ...result,
          source: mergeSource([result.source, legacy.source]),
          revision: stableHash([result.revision, legacy.revision]),
          availability: mergeAvailability([result.availability, legacy.availability]),
          completeness: mergeCompleteness([result.completeness, legacy.completeness]),
        };
      }
    }
    const visibilityCutoffRef = input.visibilityCutoffRef ?? span.visibilityCutoffRef;
    const rangeVisibleItems = applyVisibilityCutoff(spanItems, visibilityCutoffRef);
    const source = {
      ...result,
      // Keep each span's visibility boundary, but index numeric ranges over
      // all visible Run items before range selection.
      items: pageItemsForRange(spanItems, {
        range: input.range,
        visibilityCutoffRef,
        sourceOffset: providerOffset,
      }),
      providerOffset,
      providerNextOffset: providerOffset + rangeVisibleItems.length,
      legacyFallbackEligible: allowLegacyFallback && spanItems.length === 0 && isUnavailable(result.availability),
      providerRevision: result.providerRevision ?? result.revision,
    } satisfies ResolvedSource;
    sources.push(source);
    sourceOffset = source.providerNextOffset;

    // A provider continuation owns the remainder of this page. Do not read
    // another span until that continuation has been consumed.
    if (numericRangeEndReached(input.range ?? null, sourceOffset)) break;
    // A resumed cursor is bound to this span's provider revision. Move to the
    // next span with an explicit transition cursor after this source is read.
    if (input.activeSpanId) break;
    if (source.providerNextCursor || source.items.length >= pageLimit - collectedCount) break;
    if (!allowLegacyFallback
      && source.items.length === 0
      && isUnavailable(source.availability)) break;
  }
  const items = sources.flatMap((source) => source.items);
  const source = mergeSource(sources.map((entry) => entry.source));
  const activeSource = sources.at(-1);
  const activeSpanIndexForCursor = activeSource
    ? activeSpanIndex + sources.length - 1
    : activeSpanIndex;
  return {
    items,
    source,
    revision: stableHash(sources.map((entry) => entry.revision)),
    providerSource: activeSource?.source ?? null,
    providerRevision: activeSource?.providerRevision ?? null,
    availability: mergeAvailability(sources.map((entry) => entry.availability)),
    completeness: mergeCompleteness(sources.map((entry) => entry.completeness)),
    providerCursor: activeSource?.providerCursor ?? null,
    providerNextCursor: activeSource?.providerNextCursor ?? null,
    providerOffset: activeSource?.providerOffset ?? 0,
    providerNextOffset: activeSource?.providerNextOffset ?? activeSource?.providerOffset ?? 0,
    spanId: activeSource?.spanId ?? null,
    nextSpanId: input.spans[activeSpanIndexForCursor + 1]?.id ?? null,
    legacyFallbackEligible: sources.length > 0
      && items.length === 0
      && sources.some((entry) => entry.legacyFallbackEligible === true),
  };
}

async function readLegacySource(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: {
    orgId: string;
    run: HeartbeatRunRecord;
    binding: RuntimeBindingRecord | null;
    spanId?: string | null;
    signal?: AbortSignal;
  },
): Promise<ResolvedSource> {
  const legacyReader = options.legacyReader ?? createLegacyTranscriptReader({
    logStore: options.logStore,
    maxReadBytes: options.maxLegacyReadBytes,
  });
  let events: Record<string, unknown>[] = [];
  if (transcriptCandidates(input.run.resultJson).length === 0
    && transcriptCandidates(input.run.contextSnapshot).length === 0) {
    // A finalized log can be empty or unparsable while durable transcript
    // events still contain the only readable history.
    events = await selectLegacyEvents(db, input.orgId, input.run.id);
  }
  if (input.spanId) {
    events = events.filter((event) => {
      const spanId = eventSpanId(event);
      return spanId === null || spanId === input.spanId;
    });
  }
  const raw = await legacyReader.readRun({
    readonly: true,
    run: input.run,
    runtimeType: runtimeTypeFromRun(input.run, input.binding),
    spanId: input.spanId ?? null,
    events,
    signal: input.signal,
  });
  const result: LegacyTranscriptReadResult = Array.isArray(raw)
    ? { entries: raw }
    : raw as LegacyTranscriptReadResult;
  return {
    items: normalizeItems(result.entries, { runId: input.run.id, spanId: input.spanId ?? null, origin: "legacy" }),
    source: "legacy",
    revision: nonEmptyString(result.revision) ?? defaultRevision(input.run, "legacy"),
    providerRevision: nonEmptyString(result.revision) ?? defaultRevision(input.run, "legacy"),
    availability: result.availability ?? "available",
    completeness: result.completeness ?? (result.entries.length > 0 ? "complete" : "terminal_only"),
    providerCursor: null,
    providerNextCursor: null,
    spanId: input.spanId ?? null,
  };
}

function emptyNativeRunSource(input: {
  run: HeartbeatRunRecord;
  spanId?: string | null;
}): ResolvedSource {
  const revision = defaultRevision(input.run, "native-missing");
  return {
    items: [],
    source: "native",
    revision,
    providerRevision: revision,
    availability: "missing",
    completeness: "unknown",
    providerCursor: null,
    providerNextCursor: null,
    spanId: input.spanId ?? null,
    legacyFallbackEligible: false,
  };
}

export async function readRunItems(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: ReadRunTranscript,
  itemId?: string | null,
): Promise<ResolvedSource> {
  const resolved = await resolveRunScope(db, options, input);
  const cursor = decodeCursor(input.cursor);
  const windowRevision = stableHash({
    runId: resolved.run.id,
    spanId: input.spanId ?? null,
    spans: resolved.spans.map((span) => ({
      id: span.id,
      ordinal: span.ordinal,
      updatedAt: span.updatedAt,
      selector: span.selectorJson,
      cutoff: span.visibilityCutoffRef,
      supplementalObjectRef: span.supplementalObjectRef,
    })),
    range: input.range ?? null,
    visibilityCutoffRef: input.visibilityCutoffRef ?? null,
  });
  const binding = resolved.run.chatConversationId
    ? [...resolved.bindingById.values()].find((candidate) => candidate.conversationId === resolved.run.chatConversationId) ?? null
    : null;
  const source = resolved.spans.length > 0
    ? await readNativeSources(db, options, {
      orgId: input.orgId,
      principal: input.principal,
      run: resolved.run,
      spans: resolved.spans,
      bindings: resolved.bindingById,
      segments: resolved.segmentById,
      range: input.range,
      visibilityCutoffRef: input.visibilityCutoffRef,
      activeSpanId: cursor?.activeSpanId ?? input.spanId ?? null,
      providerCursor: cursor?.providerPageCursor ?? cursor?.providerCursor ?? null,
      providerOffset: cursor?.providerOffset ?? 0,
      allowLegacyFallback: !cursor || cursor.providerRevision === null,
      limit: input.limit,
      itemId,
      signal: input.signal,
    })
    : resolved.nativeSourceContract
      ? emptyNativeRunSource({ run: resolved.run, spanId: input.spanId ?? null })
      : await readLegacySource(db, options, {
        orgId: input.orgId,
        run: resolved.run,
        binding,
        spanId: input.spanId ?? null,
        signal: input.signal,
      });
  if (resolved.spans.length > 0) {
    const currentIndex = resolved.spans.findIndex((span) => span.id === source.spanId);
    return {
      ...source,
      nextSpanId: currentIndex >= 0 ? resolved.spans[currentIndex + 1]?.id ?? null : null,
      windowRevision,
    };
  }
  return {
    ...source,
    windowRevision,
    items: pageItemsForRange(source.items, {
      range: input.range,
      visibilityCutoffRef: input.visibilityCutoffRef ?? null,
    }),
  };
}
