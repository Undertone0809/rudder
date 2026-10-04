import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import {
  chatConversations,
  chatMessages,
  heartbeatRuns,
  nativeSegments,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { and, asc, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { forbidden, notFound } from "../../errors.js";
import {
  getRunLogStore,
  type RunLogHandle,
  type RunLogStore,
} from "../run-log-store.js";
import type {
  ConversationMessageRecord,
  ConversationSourceAnchor,
  ConversationSourceCursor,
  ConversationSourceKind,
  ConversationSourceRow,
  HeartbeatRunRecord,
  LegacyTranscriptEventPage,
  LegacyTranscriptReadResult,
  LegacyTranscriptReaderHook,
  NativeSegmentRecord,
  NativeTranscriptRawItem,
  NativeTranscriptReadInput,
  NativeTranscriptReadResult,
  ReadDatabase,
  ReadRunTranscript,
  ResolvedSource,
  RunRuntimeSpanRecord,
  RuntimeBindingRecord,
  TranscriptPrincipal,
  TranscriptRange,
  TranscriptReadLimit,
  TranscriptReaderOptions,
  TranscriptSource
} from "./transcript-reader.contracts.js";
import {
  DEFAULT_LEGACY_ITEM_BYTES,
  DEFAULT_LEGACY_READ_BYTES,
  DEFAULT_LEGACY_TOTAL_ITEMS,
  DEFAULT_LEGACY_TOTAL_READ_BYTES,
  DEFAULT_NATIVE_ITEM_BYTES,
  DEFAULT_NATIVE_READ_BYTES,
  MAX_LEGACY_ITEM_BYTES,
  MAX_LEGACY_READ_BYTES,
  MAX_LEGACY_TOTAL_ITEMS,
  MAX_LEGACY_TOTAL_READ_BYTES,
  MAX_NATIVE_ITEM_BYTES,
  MAX_NATIVE_READ_BYTES,
  MAX_PAGE_LIMIT
} from "./transcript-reader.contracts.js";
import { decodeLegacyCursor, encodeLegacyCursor, type LegacyReadCursor } from "./transcript-reader.legacy-cursor.js";
import {
  entriesFromLegacyEvents,
  eventSpanId,
  readLegacyEventPage,
  readNativeBoundLegacySpan,
} from "./transcript-reader.legacy-events.js";
import { readLegacyLogPage, type LegacyLogPage } from "./transcript-reader.legacy-log.js";
import { boundedSourceBudget, mergeRangeHandling, nativeItemsByteLength, providerRangeForRead, rangeForProviderPage, rawItemsFromResult, verifiedRangeHandling } from "./transcript-reader.native-budget.js";
import {
  asRecord,
  assertSpanRuntimeConsistency,
  isUnavailable,
  mergeAvailability,
  mergeCompleteness,
  mergeSource,
  nonEmptyString,
  normalizeItems,
  normalizeNativeResult,
  principalScopeRefs,
  runtimeTypeFromRun,
  selectorFromSpan,
  stableHash,
  stringAt,
  transcriptEntry,
  transcriptReaderError
} from "./transcript-reader.normalize.js";
import {
  applyRange,
  applyVisibilityCutoff,
  assertRunCursorWindow,
  decodeCursor,
  normalizeLimit,
  numericRangeEndReached,
  pageItemsForRange,
  runRangeWithItemIds,
  selectRunItemsForItemIdRange,
  spanRangeWithoutItemIds,
  type RunItemIdRangeState,
} from "./transcript-reader.pages.js";
import { compareResolvedCodexTimelineShadow } from "./transcript-reader.shadow.js";
import { isExplicitLegacyTranscriptSource, isNativeTranscriptSource } from "./transcript-source.js";

type RunResolvedSource = ResolvedSource & {
  runItemIdRangeState?: RunItemIdRangeState;
  runItemIdRangeEnded?: boolean;
};


function defaultRevision(run: HeartbeatRunRecord, prefix: string): string {
  return stableHash({
    prefix,
    id: run.id,
    logSha256: run.logSha256,
    logBytes: run.logBytes,
    updatedAt: run.updatedAt,
  });
}

interface LegacyOutputEntry {
  entry: TranscriptEntry;
  offset: number;
}

function throwIfReadAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error("Legacy transcript read cancelled");
  if (error.name === "Error") error.name = "AbortError";
  throw error;
}

function transcriptCandidateArrays(payload: unknown): unknown[][] {
  const record = asRecord(payload);
  if (!record) return [];
  return [record.__chatTranscript, record.transcript, record.entries, record.items]
    .filter((candidate): candidate is unknown[] => Array.isArray(candidate) && candidate.length > 0);
}

function hasTranscriptCandidates(payload: unknown): boolean {
  return transcriptCandidateArrays(payload).length > 0;
}

function initialLegacyCursor(run: HeartbeatRunRecord): string {
  const phase: LegacyReadCursor["phase"] = run.logStore && run.logRef
    ? "log"
    : hasTranscriptCandidates(run.resultJson)
      ? "result"
      : hasTranscriptCandidates(run.contextSnapshot)
        ? "context"
        : "events";
  return encodeLegacyCursor({
    version: 1,
    phase,
    offset: 0,
    skipEntries: 0,
    totalBytes: 0,
    totalItems: 0,
    missingLog: false,
    totalEntries: 0,
  });
}

function transcriptResult(
  entries: readonly TranscriptEntry[],
  input: {
    revision: string;
    itemOffset?: number;
    nextCursor?: string | null;
    limitReached?: TranscriptReadLimit | null;
    truncated?: boolean;
  },
): LegacyTranscriptReadResult {
  return {
    entries,
    itemOffset: input.itemOffset ?? 0,
    nextCursor: input.nextCursor ?? null,
    revision: input.revision,
    availability: "available",
    completeness: input.limitReached || input.nextCursor || input.truncated
      ? "partial"
      : entries.length > 0 ? "complete" : "terminal_only",
    ...(input.limitReached ? { limitReached: input.limitReached } : {}),
    ...(input.truncated ? { truncated: true } : {}),
  };
}

export function createLegacyTranscriptReader(options: {
  logStore?: RunLogStore;
  maxReadBytes?: number;
  maxTotalBytes?: number;
  maxTotalItems?: number;
  maxItemBytes?: number;
} = {}): LegacyTranscriptReaderHook {
  const store = options.logStore ?? getRunLogStore();
  const maxReadBytes = Math.max(4, Math.min(MAX_LEGACY_READ_BYTES, Math.floor(options.maxReadBytes ?? DEFAULT_LEGACY_READ_BYTES)));
  const maxTotalBytes = Math.max(4, Math.min(MAX_LEGACY_TOTAL_READ_BYTES, Math.floor(options.maxTotalBytes ?? DEFAULT_LEGACY_TOTAL_READ_BYTES)));
  const maxTotalItems = Math.max(1, Math.min(MAX_LEGACY_TOTAL_ITEMS, Math.floor(options.maxTotalItems ?? DEFAULT_LEGACY_TOTAL_ITEMS)));
  const maxItemBytes = Math.max(4, Math.min(MAX_LEGACY_ITEM_BYTES, Math.floor(options.maxItemBytes ?? DEFAULT_LEGACY_ITEM_BYTES)));

  return {
    async readRun(input) {
      throwIfReadAborted(input.signal);
      if (input.run.logCompressed) {
        return {
          entries: [],
          revision: defaultRevision(input.run, "compressed"),
          availability: "incompatible",
          completeness: "unknown",
        };
      }

      const revision = defaultRevision(input.run, "legacy");
      const state = decodeLegacyCursor(input.cursor) ?? {
        version: 1 as const,
        phase: input.run.logStore && input.run.logRef ? "log" as const
          : hasTranscriptCandidates(input.run.resultJson) ? "result" as const
            : hasTranscriptCandidates(input.run.contextSnapshot) ? "context" as const
              : "events" as const,
        offset: 0,
        skipEntries: 0,
        totalBytes: 0,
        totalItems: 0,
        missingLog: false,
        totalEntries: 0,
      };
      state.missingLog ??= false;
      state.totalEntries ??= 0;
      if (input.diagnosticProjection) {
        state.totalBytes = 0;
        state.totalItems = 0;
      }
      const limit = normalizeLimit(input.limit);

      if (state.totalBytes >= maxTotalBytes) {
        return transcriptResult([], {
          revision,
          limitReached: { reason: "total_bytes", maximum: maxTotalBytes },
        });
      }

      let missingLog = state.missingLog;
      if (state.phase === "log" && input.run.logStore && input.run.logRef) {
        let page: LegacyLogPage | null = null;
        try {
          page = await readLegacyLogPage(store, {
            store: input.run.logStore as RunLogHandle["store"],
            logRef: input.run.logRef,
          }, {
            run: input.run,
            runtimeType: input.runtimeType,
            offset: state.offset,
            skipEntries: state.skipEntries,
            totalBytes: state.totalBytes,
            totalItems: state.totalItems,
            pageBytes: Math.min(maxReadBytes, maxTotalBytes - state.totalBytes),
            totalBytesLimit: maxTotalBytes,
            totalItemsLimit: maxTotalItems,
            itemBytesLimit: maxItemBytes,
            limit,
            signal: input.signal,
          });
        } catch (error) {
          if ((error as { status?: unknown }).status === 404) {
            // A missing object log is one unavailable legacy source, not proof
            // that this Run has no transcript. Continue through this Run's
            // retained result/context/events when no log entries were read.
            // Once paging has started, don't restart another source at offset
            // zero and risk duplicating or misordering an already-read page.
            if (state.offset > 0 || state.skipEntries > 0 || state.totalBytes > 0 || state.totalItems > 0) {
              return {
                entries: [],
                revision: defaultRevision(input.run, "missing"),
                availability: "missing",
                completeness: "unknown",
              };
            }
            missingLog = true;
            state.missingLog = true;
            state.phase = hasTranscriptCandidates(input.run.resultJson) ? "result"
              : hasTranscriptCandidates(input.run.contextSnapshot) ? "context"
                : "events";
            state.offset = 0;
            state.skipEntries = 0;
          }
          else throw error;
        }
        if (page) {
          const totalBytes = state.totalBytes + page.readBytes;
          const totalItems = state.totalItems + page.entries.length;
          if (page.next || page.limitReached) {
            return transcriptResult(page.entries, {
              revision,
              itemOffset: state.totalItems,
              nextCursor: page.next && !page.limitReached ? encodeLegacyCursor({
                ...state,
                offset: page.offset,
                skipEntries: page.skipEntries,
                totalBytes,
                totalItems,
                totalEntries: state.totalEntries + page.entries.length,
              }) : null,
              limitReached: page.limitReached,
            });
          }
          if (page.entries.length > 0) return transcriptResult(page.entries, { revision, itemOffset: state.totalItems });
          if (state.totalItems > 0 && page.eof) {
            return {
              ...transcriptResult([], { revision, itemOffset: state.totalItems }),
              completeness: "complete",
            };
          }
          state.totalBytes = totalBytes;
          state.totalItems = totalItems;
          state.phase = hasTranscriptCandidates(input.run.resultJson) ? "result"
            : hasTranscriptCandidates(input.run.contextSnapshot) ? "context"
              : "events";
          state.offset = 0;
          state.skipEntries = 0;
        }
      }

  let pageBytesUsed = state.totalBytes;
      let pageItemsUsed = state.totalItems;
      const remainingPageBytes = () => Math.min(maxReadBytes, maxTotalBytes - pageBytesUsed);
      const remainingPageItems = () => Math.min(limit, maxTotalItems - pageItemsUsed);

      for (const phase of ["result", "context"] as const) {
        if (state.phase !== phase) continue;
        const arrays = transcriptCandidateArrays(phase === "result" ? input.run.resultJson : input.run.contextSnapshot);
        const candidate = arrays[0];
        if (!candidate) {
          state.phase = phase === "result" && hasTranscriptCandidates(input.run.contextSnapshot) ? "context" : "events";
          state.offset = 0;
          continue;
        }
        const entries: TranscriptEntry[] = [];
        let index = state.offset;
        let bytesRead = 0;
        let itemsRead = 0;
        let limitReached: TranscriptReadLimit | null = null;
        while (index < candidate.length && itemsRead < remainingPageItems()) {
          throwIfReadAborted(input.signal);
          const raw = candidate[index];
          const encoded = JSON.stringify(raw) ?? "null";
          const byteLength = Buffer.byteLength(encoded, "utf8");
          if (byteLength > maxItemBytes) {
            limitReached = { reason: "item_bytes", maximum: maxItemBytes };
            break;
          }
          if (byteLength > remainingPageBytes() - bytesRead) {
            limitReached = {
              reason: pageBytesUsed + bytesRead >= maxTotalBytes ? "total_bytes" : "page_bytes",
              maximum: pageBytesUsed + bytesRead >= maxTotalBytes ? maxTotalBytes : maxReadBytes,
            };
            break;
          }
          const entry = transcriptEntry(raw);
          index += 1;
          itemsRead += 1;
          bytesRead += byteLength;
          if (entry) entries.push(entry);
        }
        const totalEntries = state.totalEntries + entries.length;
        pageBytesUsed += bytesRead;
        pageItemsUsed += itemsRead;
        const hasMore = index < candidate.length;
        if (hasMore && pageItemsUsed >= maxTotalItems && !limitReached) {
          return transcriptResult(entries, {
            revision,
            itemOffset: state.totalItems,
            limitReached: { reason: "total_items", maximum: maxTotalItems },
          });
        }
        if (hasMore && !limitReached && entries.length < remainingPageItems()) {
          return transcriptResult(entries, {
            revision,
            itemOffset: state.totalItems,
            nextCursor: encodeLegacyCursor({ ...state, offset: index, skipEntries: 0, totalBytes: pageBytesUsed, totalItems: pageItemsUsed, totalEntries }),
          });
        }
        if (limitReached) {
          return transcriptResult(entries, { revision, itemOffset: state.totalItems, limitReached });
        }
        if (entries.length > 0 || hasMore) {
          return transcriptResult(entries, {
            revision,
            itemOffset: state.totalItems,
            nextCursor: hasMore
              ? encodeLegacyCursor({ ...state, offset: index, skipEntries: 0, totalBytes: pageBytesUsed, totalItems: pageItemsUsed, totalEntries })
              : null,
          });
        }
        state.phase = phase === "result" && hasTranscriptCandidates(input.run.contextSnapshot) ? "context" : "events";
        state.offset = 0;
      }

      if (state.phase === "events") {
        const eventLimit = remainingPageItems();
        const eventBytes = remainingPageBytes();
        if (eventLimit <= 0) {
          return transcriptResult([], { revision, limitReached: { reason: "total_items", maximum: maxTotalItems } });
        }
        if (eventBytes <= 0) {
          return transcriptResult([], { revision, limitReached: { reason: "total_bytes", maximum: maxTotalBytes } });
        }
        let eventPage: LegacyTranscriptEventPage;
        if (input.readEvents) {
          eventPage = await input.readEvents({
            cursor: state.eventCursor,
            limit: eventLimit,
            maxBytes: eventBytes,
            maxItemBytes,
            diagnosticProjection: input.diagnosticProjection,
            signal: input.signal,
          });
        } else {
          const allEvents = input.events ?? [];
          const pageEvents: Record<string, unknown>[] = [];
          let pageEventBytes = 0;
          let directLimit: TranscriptReadLimit | null = null;
          for (const event of allEvents.slice(state.offset, state.offset + eventLimit)) {
            const byteLength = Buffer.byteLength(JSON.stringify(event) ?? "null", "utf8");
            if (byteLength > maxItemBytes) {
              if (pageEvents.length === 0) directLimit = { reason: "item_bytes", maximum: maxItemBytes };
              break;
            }
            if (byteLength > eventBytes - pageEventBytes) {
              if (pageEvents.length === 0) {
                directLimit = {
                  reason: eventBytes < maxReadBytes ? "total_bytes" : "page_bytes",
                  maximum: eventBytes < maxReadBytes ? maxTotalBytes : maxReadBytes,
                };
              }
              break;
            }
            pageEvents.push(event);
            pageEventBytes += byteLength;
          }
          eventPage = {
            events: pageEvents,
            nextCursor: state.offset + pageEvents.length < allEvents.length ? String(state.offset + pageEvents.length) : null,
            revision,
            readBytes: pageEventBytes,
            limitReached: directLimit,
          };
        }
        throwIfReadAborted(input.signal);
        const filteredEvents = input.spanId
          ? eventPage.events.filter((event) => eventSpanId(event) === null || eventSpanId(event) === input.spanId)
          : eventPage.events;
        const entries = entriesFromLegacyEvents(filteredEvents);
        const nextTotalBytes = pageBytesUsed + eventPage.readBytes;
        const nextTotalItems = pageItemsUsed + eventPage.events.length;
        const totalLimit = nextTotalBytes >= maxTotalBytes && eventPage.nextCursor
          ? { reason: "total_bytes" as const, maximum: maxTotalBytes }
          : nextTotalItems >= maxTotalItems && eventPage.nextCursor
            ? { reason: "total_items" as const, maximum: maxTotalItems }
            : null;
        const eventBudgetLimit = eventPage.limitReached?.reason === "page_bytes"
          && eventBytes < maxReadBytes
          ? { reason: "total_bytes" as const, maximum: maxTotalBytes }
          : eventPage.limitReached;
        const itemBudgetLimit = state.totalItems >= maxTotalItems && eventPage.events.length > 0
          ? { reason: "total_items" as const, maximum: maxTotalItems }
          : null;
        const limitReached = eventBudgetLimit ?? itemBudgetLimit ?? totalLimit;
        const hasMore = Boolean(eventPage.nextCursor) && !limitReached;
        const totalEntries = state.totalEntries + entries.length;
        if (missingLog && totalEntries === 0 && !hasMore && !limitReached && !eventPage.truncated) {
          return {
            entries: [],
            revision: defaultRevision(input.run, "missing"),
            availability: "missing",
            completeness: "unknown",
          };
        }
        return transcriptResult(entries, {
          revision: eventPage.revision,
          itemOffset: state.totalItems,
          nextCursor: hasMore ? encodeLegacyCursor({
            ...state,
            phase: "events",
            offset: input.readEvents ? 0 : Number(eventPage.nextCursor),
            eventCursor: input.readEvents ? eventPage.nextCursor : null,
            skipEntries: 0,
            totalBytes: nextTotalBytes,
            totalItems: nextTotalItems,
            totalEntries,
          }) : null,
          limitReached,
          truncated: eventPage.truncated,
        });
      }

      return transcriptResult([], { revision });
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
  sequenceOffset = 0,
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
      availability: input.span.state === "open" && input.run.status === "running" ? "pending" : "missing",
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
  const maxBytes = boundedSourceBudget(input.maxBytes, DEFAULT_NATIVE_READ_BYTES, MAX_NATIVE_READ_BYTES);
  const maxItemBytes = Math.min(
    maxBytes,
    boundedSourceBudget(input.maxItemBytes, DEFAULT_NATIVE_ITEM_BYTES, MAX_NATIVE_ITEM_BYTES),
  );
  // OpenCode export is a snapshot transport without provider continuation.
  // Read one bounded snapshot up front, then use Reader position cursors for
  // small consumer pages. Retrying a one-item export would spend the byte
  // budget twice on the large instruction-bearing user item.
  const snapshot = origin === "native" && input.binding?.runtimeType === "opencode_local" && !input.itemId;
  const hookInput = { ...input, limit: snapshot ? MAX_PAGE_LIMIT : normalizeLimit(input.limit), maxBytes, maxItemBytes };
  let raw: NativeTranscriptReadResult | readonly NativeTranscriptRawItem[] | NativeTranscriptRawItem | null;
  if (input.itemId && hook.readItem) raw = await hook.readItem(hookInput);
  else if (hook.readRange) raw = await hook.readRange(hookInput);
  else if (hook.read) raw = await hook.read(hookInput);
  else raw = [];
  const result = normalizeNativeResult(raw);
  const rawItems = rawItemsFromResult(result);
  const readBytes = nativeItemsByteLength(rawItems, maxBytes, maxItemBytes);
  const items = normalizeItems(rawItems, {
    runId: input.run.id,
    spanId: input.span.id,
    origin,
    sequenceOffset,
  });
  const revision = nonEmptyString(result.revision)
    ?? stableHash({ spanId: input.span.id, selector: input.selector, updatedAt: input.span.updatedAt });
  const availability = result.availability ?? "available";
  const completeness = result.completeness ?? input.span.completeness;
  const nextCursor = nonEmptyString(result.nextCursor);
  if (nextCursor && nextCursor === input.cursor) throw new Error("Native transcript reader cursor made no progress");
  await compareResolvedCodexTimelineShadow({ options, input, origin, items, revision,
    availability, completeness, nextCursor, result, rawItemCount: rawItems.length });
  return {
    items,
    source: origin === "object" ? "native_plus_objects" : "native",
    revision,
    providerRevision: revision,
    providerPageLimit: hookInput.limit,
    availability,
    completeness,
    limitReached: result.limitReached ?? null,
    ...(result.truncated ? { truncated: true } : {}),
    rangeHandled: verifiedRangeHandling(hookInput.range, result.rangeHandled),
    visibilityCutoffHandled: hookInput.visibilityCutoffRef
      && result.visibilityCutoffHandled === hookInput.visibilityCutoffRef
      ? result.visibilityCutoffHandled : undefined,
    readBytes,
    providerCursor: input.cursor,
    providerNextCursor: nextCursor,
    spanId: input.span.id,
    legacyFallbackEligible: items.length === 0 && isUnavailable(availability),
  };
}

// Bound cursor metadata independently of the source page budget. Once identity
// tracking fills, native paging can continue, but we cannot safely add copies
// from a supplement: return an honest partial result instead.
const MAX_SUPPLEMENT_IDENTITIES = 512;
const MAX_SUPPLEMENT_CURSOR_BYTES = 128 * 1024;
const SUPPLEMENT_CURSOR_PREFIX = "rudder-supplement-v1:";
type SupplementCursor = {
  phase: "native" | "object";
  nativeCursor: string | null;
  nativeRevision: string;
  nativeLimit: number;
  objectCursor: string | null;
  objectRevision: string | null;
  scope: string;
  seen: string[];
  identitiesLimited: boolean;
};

async function readNativeWithSupplement(
  options: TranscriptReaderOptions,
  input: NativeTranscriptReadInput,
  sequenceOffset = 0,
): Promise<ResolvedSource> {
  const scope = stableHash({ orgId: input.orgId, runId: input.run.id, spanId: input.span.id,
    selector: input.selector, objectRef: input.span.supplementalObjectRef,
    range: input.range, cutoff: input.visibilityCutoffRef });
  let state: SupplementCursor | null = null;
  if (input.cursor) {
    try {
      if (!input.cursor.startsWith(SUPPLEMENT_CURSOR_PREFIX)
        || Buffer.byteLength(input.cursor) > MAX_SUPPLEMENT_CURSOR_BYTES) throw new Error("invalid cursor");
      state = JSON.parse(Buffer.from(input.cursor.slice(SUPPLEMENT_CURSOR_PREFIX.length), "base64url").toString("utf8"));
      if (!state || state.scope !== scope || !["native", "object"].includes(state.phase)
        || typeof state.nativeRevision !== "string" || typeof state.identitiesLimited !== "boolean"
        || !Number.isSafeInteger(state.nativeLimit) || state.nativeLimit < 1 || state.nativeLimit > MAX_PAGE_LIMIT
        || (state.phase === "object" && (!state.objectCursor || !state.objectRevision))
        || ![state.nativeCursor, state.objectCursor, state.objectRevision].every(value => value === null || typeof value === "string")
        || !Array.isArray(state.seen) || state.seen.length > MAX_SUPPLEMENT_IDENTITIES
        || !state.seen.every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))) throw new Error("invalid cursor");
    } catch {
      throw transcriptReaderError("cursor_invalid", "Invalid native supplement cursor");
    }
  }
  const nativeLimit = state?.phase === "object" ? state.nativeLimit : normalizeLimit(input.limit);
  const native = await readNativeSpan(
    options,
    { ...input, limit: nativeLimit, cursor: state?.nativeCursor ?? null },
    "native",
    sequenceOffset,
  );
  if (state && state.nativeRevision !== native.revision) {
    throw transcriptReaderError("cursor_revision_mismatch", "Transcript native revision is no longer current");
  }
  const forSpan = (source: ResolvedSource) => source.items.filter(item => item.runId === input.run.id && item.spanId === input.span.id);
  const nativeItems = forSpan(native);
  const seen = new Set(state?.seen ?? []);
  let identitiesLimited = state?.identitiesLimited ?? false;
  const keys = (item: ResolvedSource["items"][number]) => [stableHash(["id", item.kind, item.id]),
    ...(item.sourceEntryId ? [stableHash(["source", item.kind, item.sourceEntryId])] : [])];
  const remember = (item: ResolvedSource["items"][number]) => {
    for (const key of keys(item)) {
      if (seen.has(key)) continue;
      if (seen.size >= MAX_SUPPLEMENT_IDENTITIES) { identitiesLimited = true; break; }
      seen.add(key);
    }
  };
  nativeItems.forEach(remember);
  const base: ResolvedSource = { ...native, providerSource: "native", providerCursor: input.cursor,
    items: state?.phase === "object" ? [] : nativeItems };
  const limited = (source: ResolvedSource, reason: TranscriptReadLimit["reason"], maximum: number): ResolvedSource => ({
    ...source, completeness: "partial", providerNextCursor: null, limitReached: { reason, maximum },
  });
  const continuation = (source: ResolvedSource, next: SupplementCursor): ResolvedSource => {
    const cursor = SUPPLEMENT_CURSOR_PREFIX + Buffer.from(JSON.stringify(next)).toString("base64url");
    return Buffer.byteLength(cursor) > MAX_SUPPLEMENT_CURSOR_BYTES
      ? limited(source, "total_bytes", MAX_SUPPLEMENT_CURSOR_BYTES)
      : { ...source, providerNextCursor: cursor };
  };
  const nextState = (overrides: Partial<SupplementCursor>): SupplementCursor => ({
    phase: "native", nativeCursor: state?.nativeCursor ?? null, nativeRevision: native.revision, nativeLimit,
    objectCursor: null, objectRevision: null, scope, seen: [...seen], identitiesLimited, ...overrides,
  });
  // partial + nextCursor means pagination, not missing native history. Do not
  // restart the supplement on each native page (or change cursor source identity).
  if (native.providerNextCursor) {
    if (state?.phase === "object") throw transcriptReaderError("cursor_revision_mismatch", "Transcript native tail changed");
    return continuation(base, nextState({ nativeCursor: native.providerNextCursor }));
  }
  if (native.completeness === "complete" && !isUnavailable(native.availability)) {
    if (state?.phase === "object") throw transcriptReaderError("cursor_revision_mismatch", "Transcript native completeness changed");
    return base;
  }
  if (identitiesLimited) return limited(base, "total_items", MAX_SUPPLEMENT_IDENTITIES);
  const objectBytes = (input.maxBytes ?? DEFAULT_NATIVE_READ_BYTES) - (native.readBytes ?? 0);
  if (objectBytes < 4) return limited(base, "page_bytes", input.maxBytes ?? DEFAULT_NATIVE_READ_BYTES);
  const object = await readNativeSpan(options, { ...input, cursor: state?.objectCursor ?? null,
    maxBytes: objectBytes, maxItemBytes: Math.min(input.maxItemBytes ?? DEFAULT_NATIVE_ITEM_BYTES, objectBytes) }, "object",
  sequenceOffset + (state?.phase === "object" ? 0 : nativeItems.length));
  if (state?.objectRevision && state.objectRevision !== object.revision) {
    throw transcriptReaderError("cursor_revision_mismatch", "Transcript supplement revision is no longer current");
  }
  const objectItems = forSpan(object).filter(item => {
    const [identity, sourceIdentity] = keys(item);
    if (seen.has(identity!) || (item.id === item.sourceEntryId && sourceIdentity && seen.has(sourceIdentity))) return false;
    if (identitiesLimited) return false;
    remember(item);
    return true;
  });
  const result: ResolvedSource = {
    ...base,
    // The stream has a stable native-then-supplement phase order. Do not sort
    // this tail by ordinal and insert objects before already returned native items.
    items: [...base.items, ...objectItems],
    source: "native_plus_objects",
    // Provider identity remains native across the composition boundary. Object
    // revision is independently checked by the continuation; span metadata binds its ref.
    revision: stableHash([native.revision, object.revision]),
    providerRevision: native.revision,
    supplementRevision: object.revision,
    availability: objectItems.length > 0 || object.availability === "available" ? object.availability : native.availability,
    completeness: mergeCompleteness([native.completeness, object.completeness]),
    readBytes: (native.readBytes ?? 0) + (object.readBytes ?? 0),
    limitReached: object.limitReached ?? native.limitReached,
    providerNextCursor: null,
    rangeHandled: objectItems.length > 0 ? mergeRangeHandling(native.rangeHandled, object.rangeHandled) : native.rangeHandled,
    visibilityCutoffHandled: objectItems.length === 0 || native.visibilityCutoffHandled === object.visibilityCutoffHandled
      ? native.visibilityCutoffHandled : undefined,
  };
  if (identitiesLimited) return limited(result, "total_items", MAX_SUPPLEMENT_IDENTITIES);
  return object.providerNextCursor
    ? continuation(result, nextState({ phase: "object", objectCursor: object.providerNextCursor, objectRevision: object.revision }))
    : result;
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
    spanScoped?: boolean;
    range?: TranscriptRange | null;
    runItemIdRangeState?: RunItemIdRangeState;
    visibilityCutoffRef?: string | null;
    activeSpanId?: string | null;
    providerCursor?: string | null;
    providerSource?: TranscriptSource | null;
    providerOffset?: number;
    allowLegacyFallback?: boolean;
    limit?: number;
    itemId?: string | null;
    signal?: AbortSignal;
  },
): Promise<RunResolvedSource> {
  const sources: ResolvedSource[] = [];
  const activeSpanIndex = input.activeSpanId
    ? input.spans.findIndex((candidate) => candidate.id === input.activeSpanId)
    : 0;
  if (activeSpanIndex < 0) throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor span is not part of this run");
  const pageLimit = normalizeLimit(input.limit);
  const maxNativeReadBytes = boundedSourceBudget(
    options.maxNativeReadBytes,
    DEFAULT_NATIVE_READ_BYTES,
    MAX_NATIVE_READ_BYTES,
  );
  const maxNativeItemBytes = boundedSourceBudget(
    options.maxNativeItemBytes,
    DEFAULT_NATIVE_ITEM_BYTES,
    MAX_NATIVE_ITEM_BYTES,
  );
  let remainingNativeReadBytes = maxNativeReadBytes;
  const applyRunGlobalItemIds = !input.spanScoped && input.spans.length > 1;
  const spanRange = applyRunGlobalItemIds ? spanRangeWithoutItemIds(input.range) : input.range;
  const runItemIdRange = applyRunGlobalItemIds ? runRangeWithItemIds(input.range) : null;
  const incomingRunItemIdRangeState = {
    resolvedBoundaryKeys: [...(input.runItemIdRangeState?.resolvedBoundaryKeys ?? [])],
  };
  let runItemIdRangeState = incomingRunItemIdRangeState;
  let selectedItems: ResolvedSource["items"] = [];
  let runItemIdRangeEnded = false;
  const spans = input.spans.slice(activeSpanIndex);
  let sourceOffset = input.providerOffset ?? 0;
  for (const [spanOffset, span] of spans.entries()) {
    const collectedCount = runItemIdRange
      ? selectedItems.length
      : sources.reduce((count, source) => count + source.items.length, 0);
    if (collectedCount >= pageLimit) break;
    if (remainingNativeReadBytes < 4) {
      const lastSourceIndex = sources.length - 1;
      if (lastSourceIndex >= 0) {
        const lastSource = sources[lastSourceIndex]!;
        sources[lastSourceIndex] = {
          ...lastSource,
          limitReached: lastSource.limitReached ?? { reason: "page_bytes", maximum: maxNativeReadBytes },
        };
      }
      break;
    }
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
      maxBytes: remainingNativeReadBytes,
      maxItemBytes: Math.min(maxNativeItemBytes, remainingNativeReadBytes),
      itemId: input.itemId ?? null,
      range: providerRangeForRead(spanRange),
      visibilityCutoffRef: input.visibilityCutoffRef ?? span.visibilityCutoffRef,
      signal: input.signal,
    };
    const objectRef = nonEmptyString(span.supplementalObjectRef);
    const cursorObjectSource = binding?.runtimeType === "cursor" && Boolean(objectRef);
    const expiredSupplement = Boolean(objectRef && span.supplementalRetentionExpiredAt);
    const itemsForSpan = (candidate: ResolvedSource) => candidate.items.filter((item) =>
      item.runId === input.run.id && item.spanId === span.id,
    );
    const hasNativeSpanIdentity = binding?.continuity === "native"
      || binding?.continuity === "context_handoff"
      || Boolean(segment?.nativeSessionId)
      || (hookInput.selector.kind !== "pending" && hookInput.selector.kind !== "unresolved");
    const explicitLegacySource = (!hasNativeSpanIdentity
      || hookInput.selector.kind === "pending" || hookInput.selector.kind === "unresolved") && isExplicitLegacyTranscriptSource(input.run, {
      bindingContinuity: binding?.continuity,
    });
    const nativeSourceContract = isNativeTranscriptSource(input.run, {
      bindingContinuity: binding?.continuity,
    });
    const legacyContinuation = spanOffset === 0 && input.providerSource === "legacy";
    const nativeLegacyContinuation = legacyContinuation
      && nativeSourceContract
      && !explicitLegacySource;
    let result = nativeLegacyContinuation
      ? await readNativeBoundLegacySpan(db, options, {
        orgId: input.orgId,
        run: input.run,
        span,
        cursor: providerCursor,
        limit: pageLimit - collectedCount,
        providerOffset,
        signal: input.signal,
      })
      : explicitLegacySource || legacyContinuation
      ? await readLegacySource(db, options, {
        orgId: input.orgId,
        run: input.run,
        binding,
        spanId: span.id,
        cursor: providerCursor,
        limit: pageLimit - collectedCount,
        signal: input.signal,
      })
      : cursorObjectSource
      ? await readNativeSpan(options, hookInput, "object", providerOffset)
      : expiredSupplement
      ? await readNativeSpan(options, hookInput, "object", providerOffset)
      : options.nativeReader && objectRef && options.objectReader
      ? await readNativeWithSupplement(options, hookInput, providerOffset)
      : options.nativeReader
      ? await readNativeSpan(options, hookInput, "native", providerOffset)
      : objectRef && options.objectReader
        ? await readNativeSpan(options, hookInput, "object", providerOffset)
        : await readNativeSpan(options, hookInput, "native", providerOffset);
    let spanItems = itemsForSpan(result);
    // Native-bound spans may show only event copies carrying this exact span/Attempt identity.
    const allowLegacyFallback = input.allowLegacyFallback !== false && !nativeSourceContract;
    const hasRetainedLegacyFallback = isExplicitLegacyTranscriptSource(input.run);
    const shouldReadNativeLegacyFallback = !nativeLegacyContinuation
      && !explicitLegacySource
      && nativeSourceContract
      && spanItems.length === 0
      && result.availability === "offline";
    if (shouldReadNativeLegacyFallback) {
      const legacy = await readNativeBoundLegacySpan(db, options, {
        orgId: input.orgId,
        run: input.run,
        span,
        limit: pageLimit - collectedCount,
        providerOffset,
        signal: input.signal,
      });
      if (legacy.items.length > 0 || legacy.providerNextCursor || legacy.limitReached) {
        result = legacy;
        spanItems = itemsForSpan(result);
      }
    }
    const shouldReadLegacyNow = spanItems.length === 0
      && (isUnavailable(result.availability)
        || (hasRetainedLegacyFallback && result.completeness === "partial"
          && !result.limitReached && !result.providerNextCursor));
    if (!explicitLegacySource && !legacyContinuation && allowLegacyFallback && shouldReadLegacyNow) {
      const legacy = await readLegacySource(db, options, {
        orgId: input.orgId,
        run: input.run,
        binding,
        spanId: span.id,
        limit: pageLimit - collectedCount,
        signal: input.signal,
      });
      if (legacy.items.length > 0 || legacy.providerNextCursor || legacy.limitReached) {
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
    } else if (!explicitLegacySource && !legacyContinuation && allowLegacyFallback
      && hasRetainedLegacyFallback && result.completeness === "partial"
      && !result.limitReached
      && !result.providerNextCursor) {
      result = {
        ...result,
        providerSource: "legacy",
        providerRevision: defaultRevision(input.run, "legacy"),
        providerNextCursor: initialLegacyCursor(input.run),
      };
    }
    const visibilityCutoffRef = input.visibilityCutoffRef ?? span.visibilityCutoffRef;
    const { rangeHandled, visibilityCutoffHandled, ...resultWithoutRangeHandling } = result;
    const pageVisibilityCutoff = visibilityCutoffRef && visibilityCutoffHandled === visibilityCutoffRef
      ? null : visibilityCutoffRef;
    const missingVisibilityBoundary = Boolean(pageVisibilityCutoff && !/^\d+$/u.test(pageVisibilityCutoff)
      && !spanItems.some(item => item.visibility !== "hidden"
        && (item.id === pageVisibilityCutoff || item.sourceEntryId === pageVisibilityCutoff)));
    const rangeVisibleItems = applyVisibilityCutoff(spanItems, pageVisibilityCutoff);
    const sequencedVisibleItems = rangeVisibleItems.map((item, index) => ({
      ...item,
      sequence: providerOffset + index,
    }));
    let source = {
      ...resultWithoutRangeHandling,
      providerPageLimit: result.providerPageLimit ?? hookInput.limit,
      // A page-local missing anchor cannot attest completeness. Providers that
      // cannot prove a full-source cutoff keep the fail-closed fallback.
      ...(missingVisibilityBoundary ? {
        availability: "incompatible" as const, completeness: "unknown" as const, providerNextCursor: null,
      } : {}),
      // Keep each span's visibility boundary, but index numeric ranges over
      // all visible Run items before range selection.
      items: applyRange(sequencedVisibleItems, rangeForProviderPage(spanRange, rangeHandled), providerOffset),
      providerOffset,
      providerNextOffset: providerOffset + rangeVisibleItems.length,
      legacyFallbackEligible: allowLegacyFallback && spanItems.length === 0 && isUnavailable(result.availability),
      providerRevision: result.providerRevision ?? result.revision,
    } satisfies ResolvedSource;
    const nativeBytesRead = result.readBytes ?? 0;
    remainingNativeReadBytes = Math.max(0, remainingNativeReadBytes - nativeBytesRead);
    if (remainingNativeReadBytes < 4 && spanOffset < spans.length - 1) {
      source = {
        ...source,
        limitReached: source.limitReached ?? { reason: "page_bytes", maximum: maxNativeReadBytes },
      };
    }
    sources.push(source);
    sourceOffset = source.providerNextOffset;
    const mergedItems = sources.flatMap((entry) => entry.items);
    if (runItemIdRange) {
      const selection = selectRunItemsForItemIdRange(
        mergedItems,
        runItemIdRange,
        incomingRunItemIdRangeState,
        Boolean(source.providerNextCursor) || spanOffset < spans.length - 1,
      );
      selectedItems = selection.items;
      runItemIdRangeState = selection.state;
      runItemIdRangeEnded = selection.endReached;
    } else {
      selectedItems = mergedItems;
    }

    // A provider continuation owns the remainder of this page. Do not read
    // another span until that continuation has been consumed.
    if (runItemIdRangeEnded) break;
    if (numericRangeEndReached(input.range ?? null, sourceOffset)) break;
    // A resumed cursor is bound to this span's provider revision. Move to the
    // next span with an explicit transition cursor after this source is read.
    if (input.activeSpanId) break;
    if (source.providerNextCursor
      || (runItemIdRange ? selectedItems.length >= pageLimit : source.items.length >= pageLimit - collectedCount)) break;
    if (!allowLegacyFallback
      && source.items.length === 0
      && isUnavailable(source.availability)) break;
  }
  const items = selectedItems;
  const source = mergeSource(sources.map((entry) => entry.source));
  const activeSource = sources.at(-1);
  const activeSpanIndexForCursor = activeSource
    ? activeSpanIndex + sources.length - 1
    : activeSpanIndex;
  return {
    items,
    source,
    revision: stableHash(sources.map((entry) => entry.revision)),
    providerSource: activeSource?.providerSource ?? activeSource?.source ?? null,
    providerRevision: activeSource?.providerRevision ?? null,
    providerPageLimit: activeSource?.providerPageLimit,
    // Public items may include earlier spans, but an in-page cursor replays
    // only the active span. Keep its position in that actual provider page.
    providerPageStart: Math.max(0, items.findIndex(item => item.spanId === activeSource?.spanId)),
    supplementRevision: activeSource?.supplementRevision,
    availability: mergeAvailability(sources.map((entry) => entry.availability)),
    completeness: mergeCompleteness(sources.map((entry) => entry.completeness)),
    limitReached: activeSource?.limitReached ?? null,
    ...(sources.some((entry) => entry.truncated) ? { truncated: true } : {}),
    providerCursor: activeSource?.providerCursor ?? null,
    providerNextCursor: runItemIdRangeEnded ? null : activeSource?.providerNextCursor ?? null,
    providerOffset: activeSource?.providerOffset ?? 0,
    providerNextOffset: activeSource?.providerNextOffset ?? activeSource?.providerOffset ?? 0,
    spanId: activeSource?.spanId ?? null,
    nextSpanId: runItemIdRangeEnded ? null : input.spans[activeSpanIndexForCursor + 1]?.id ?? null,
    ...(runItemIdRange ? { runItemIdRangeState, runItemIdRangeEnded } : {}),
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
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<ResolvedSource> {
  const legacyReader = options.legacyReader ?? createLegacyTranscriptReader({
    logStore: options.logStore,
    maxReadBytes: options.maxLegacyReadBytes,
    maxTotalBytes: options.maxLegacyTotalBytes,
    maxTotalItems: options.maxLegacyTotalItems,
    maxItemBytes: options.maxLegacyItemBytes,
  });
  const raw = await legacyReader.readRun({
    readonly: true,
    run: input.run,
    runtimeType: runtimeTypeFromRun(input.run, input.binding),
    spanId: input.spanId ?? null,
    cursor: input.cursor ?? null,
    limit: input.limit,
    diagnosticProjection: options.diagnosticProjection,
    readEvents: async (eventInput) => await readLegacyEventPage(db, {
      orgId: input.orgId,
      run: input.run,
      diagnosticProjection: options.diagnosticProjection,
      ...eventInput,
    }),
    signal: input.signal,
  });
  const result: LegacyTranscriptReadResult = Array.isArray(raw)
    ? { entries: raw }
    : raw as LegacyTranscriptReadResult;
  const revision = nonEmptyString(result.revision) ?? defaultRevision(input.run, "legacy");
  const itemOffset = result.itemOffset ?? 0;
  return {
    items: normalizeItems(result.entries, {
      runId: input.run.id,
      spanId: input.spanId ?? null,
      origin: "legacy",
      sequenceOffset: itemOffset,
    }),
    source: "legacy",
    revision,
    providerRevision: revision,
    availability: result.availability ?? "available",
    completeness: result.completeness ?? (result.entries.length > 0 ? "complete" : "terminal_only"),
    limitReached: result.limitReached ?? null,
    ...(result.truncated ? { truncated: true } : {}),
    providerCursor: input.cursor ?? null,
    providerNextCursor: result.nextCursor ?? null,
    providerOffset: itemOffset,
    providerNextOffset: itemOffset + result.entries.length,
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
): Promise<RunResolvedSource> {
  const resolved = await resolveRunScope(db, options, input);
  const cursor = decodeCursor(input.cursor);
  const runItemIdRangeState = cursor?.position === 0
    ? (cursor as { runItemIdRangeState?: RunItemIdRangeState }).runItemIdRangeState
    : undefined;
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
  // Span finalization or supplement attachment can change the provider cursor
  // format. Reject the stale window before interpreting that nested cursor.
  assertRunCursorWindow(cursor, { ...input, id: input.runId, windowRevision });
  const binding = resolved.run.chatConversationId
    ? [...resolved.bindingById.values()].find((candidate) => candidate.conversationId === resolved.run.chatConversationId) ?? null
    : null;
  const source: RunResolvedSource = resolved.spans.length > 0
    ? await readNativeSources(db, options, {
      orgId: input.orgId,
      principal: input.principal,
      run: resolved.run,
      spans: resolved.spans,
      bindings: resolved.bindingById,
      segments: resolved.segmentById,
      spanScoped: Boolean(input.spanId),
      range: input.range,
      runItemIdRangeState,
      visibilityCutoffRef: input.visibilityCutoffRef,
      activeSpanId: cursor?.activeSpanId ?? input.spanId ?? null,
      providerCursor: cursor?.providerPageCursor ?? cursor?.providerCursor ?? null,
      providerSource: cursor?.source ?? null,
      providerOffset: cursor?.providerOffset ?? 0,
      allowLegacyFallback: !cursor || cursor.providerRevision === null,
      limit: cursor && cursor.position > 0 ? cursor.providerPageLimit ?? input.limit : input.limit,
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
        cursor: cursor?.providerPageCursor ?? cursor?.providerCursor ?? null,
        limit: input.limit,
        signal: input.signal,
      });
  if (resolved.spans.length > 0) {
    const currentIndex = resolved.spans.findIndex((span) => span.id === source.spanId);
    return {
      ...source,
      nextSpanId: source.runItemIdRangeEnded
        ? null
        : currentIndex >= 0 ? resolved.spans[currentIndex + 1]?.id ?? null : null,
      windowRevision,
    };
  }
  return {
    ...source,
    windowRevision,
    items: pageItemsForRange(source.items, {
      range: input.range,
      visibilityCutoffRef: input.visibilityCutoffRef ?? null,
      sourceOffset: source.providerOffset ?? 0,
    }),
  };
}
