import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { heartbeatRunEvents } from "@rudderhq/db";
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type {
  HeartbeatRunRecord,
  LegacyTranscriptEventPage,
  ReadDatabase,
  ResolvedSource,
  RunRuntimeSpanRecord,
  TranscriptReadLimit,
  TranscriptReaderOptions,
} from "./transcript-reader.contracts.js";
import {
  DEFAULT_LEGACY_ITEM_BYTES,
  DEFAULT_LEGACY_READ_BYTES,
  DEFAULT_LEGACY_TOTAL_ITEMS,
  DEFAULT_LEGACY_TOTAL_READ_BYTES,
  MAX_LEGACY_ITEM_BYTES,
  MAX_LEGACY_READ_BYTES,
  MAX_LEGACY_TOTAL_ITEMS,
  MAX_LEGACY_TOTAL_READ_BYTES,
  MAX_PAGE_LIMIT,
} from "./transcript-reader.contracts.js";
import { decodeLegacyCursor, encodeLegacyCursor } from "./transcript-reader.legacy-cursor.js";
import {
  asRecord,
  isoDate,
  nonEmptyString,
  normalizeItems,
  stableHash,
  stringAt,
  transcriptEntry,
  transcriptReaderError,
} from "./transcript-reader.normalize.js";
import { normalizeLimit } from "./transcript-reader.pages.js";

function defaultRevision(run: HeartbeatRunRecord, prefix: string): string {
  return stableHash({
    prefix,
    id: run.id,
    logSha256: run.logSha256,
    logBytes: run.logBytes,
    updatedAt: run.updatedAt,
  });
}

function throwIfReadAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error("Legacy transcript read cancelled");
  if (error.name === "Error") error.name = "AbortError";
  throw error;
}

export function entriesFromLegacyEvents(events: readonly Record<string, unknown>[]): TranscriptEntry[] {
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

export function eventSpanId(event: Record<string, unknown>): string | null {
  const payload = asRecord(event.payload);
  const nested = asRecord(payload?.entry ?? payload?.transcriptEntry ?? payload?.transcript);
  return stringAt(payload, ["spanId", "span_id"])
    ?? stringAt(nested, ["spanId", "span_id"]);
}

function eventAttemptId(event: Record<string, unknown>): string | null {
  const payload = asRecord(event.payload);
  const nested = asRecord(payload?.entry ?? payload?.transcriptEntry ?? payload?.transcript);
  return stringAt(payload, ["attemptId", "attempt_id"])
    ?? stringAt(nested, ["attemptId", "attempt_id"]);
}

function legacyEventScope(orgId: string, runId: string) {
  return and(
    eq(heartbeatRunEvents.orgId, orgId),
    eq(heartbeatRunEvents.runId, runId),
    eq(heartbeatRunEvents.eventType, "transcript.entry"),
    isNotNull(heartbeatRunEvents.seq),
  );
}

function legacyEventIdentityScope(identity: { spanId: string; attemptId: string | null }) {
  const spanId = sql<string | null>`coalesce(
    ${heartbeatRunEvents.payload}->>'spanId',
    ${heartbeatRunEvents.payload}->>'span_id',
    ${heartbeatRunEvents.payload}->'entry'->>'spanId',
    ${heartbeatRunEvents.payload}->'entry'->>'span_id',
    ${heartbeatRunEvents.payload}->'transcriptEntry'->>'spanId',
    ${heartbeatRunEvents.payload}->'transcriptEntry'->>'span_id',
    ${heartbeatRunEvents.payload}->'transcript'->>'spanId',
    ${heartbeatRunEvents.payload}->'transcript'->>'span_id'
  )`;
  const attemptId = sql<string | null>`coalesce(
    ${heartbeatRunEvents.payload}->>'attemptId',
    ${heartbeatRunEvents.payload}->>'attempt_id',
    ${heartbeatRunEvents.payload}->'entry'->>'attemptId',
    ${heartbeatRunEvents.payload}->'entry'->>'attempt_id',
    ${heartbeatRunEvents.payload}->'transcriptEntry'->>'attemptId',
    ${heartbeatRunEvents.payload}->'transcriptEntry'->>'attempt_id',
    ${heartbeatRunEvents.payload}->'transcript'->>'attemptId',
    ${heartbeatRunEvents.payload}->'transcript'->>'attempt_id'
  )`;
  return and(
    eq(spanId, identity.spanId),
    identity.attemptId ? eq(attemptId, identity.attemptId) : sql`${attemptId} is null`,
  );
}

interface LegacyEventCursor {
  version: 1;
  afterSeq: number;
  afterId: number;
  highWatermarkId: number;
  revision: string;
}

function encodeLegacyEventCursor(cursor: LegacyEventCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeLegacyEventCursor(value: string | null | undefined): LegacyEventCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<LegacyEventCursor>;
    if (parsed.version !== 1
      || !Number.isSafeInteger(parsed.afterSeq)
      || !Number.isSafeInteger(parsed.afterId)
      || !Number.isSafeInteger(parsed.highWatermarkId)
      || typeof parsed.revision !== "string") throw new Error("invalid event cursor");
    return parsed as LegacyEventCursor;
  } catch {
    throw transcriptReaderError("cursor_invalid", "Invalid legacy event cursor");
  }
}

export async function readLegacyEventPage(
  db: ReadDatabase,
  input: {
    orgId: string;
    run: HeartbeatRunRecord;
    identity?: { spanId: string; attemptId: string | null };
    cursor?: string | null;
    limit: number;
    maxBytes: number;
    maxItemBytes: number;
    signal?: AbortSignal;
  },
): Promise<LegacyTranscriptEventPage> {
  throwIfReadAborted(input.signal);
  const scope = and(
    legacyEventScope(input.orgId, input.run.id),
    input.identity ? legacyEventIdentityScope(input.identity) : undefined,
  );
  const cursor = decodeLegacyEventCursor(input.cursor);
  const highWatermarkRows = await db.select({ id: heartbeatRunEvents.id })
    .from(heartbeatRunEvents)
    .where(scope)
    .orderBy(desc(heartbeatRunEvents.id))
    .limit(1);
  throwIfReadAborted(input.signal);
  const currentHighWatermarkId = Number((highWatermarkRows[0] as { id?: unknown } | undefined)?.id ?? 0);
  const highWatermarkId = cursor?.highWatermarkId ?? currentHighWatermarkId;
  const revision = defaultRevision(input.run, input.identity
    ? `events:${stableHash(input.identity)}:${highWatermarkId}`
    : `events:${highWatermarkId}`);
  if (cursor && cursor.revision !== revision) {
    throw transcriptReaderError("cursor_revision_mismatch", "Legacy event transcript changed during pagination");
  }
  if (cursor && cursor.highWatermarkId !== currentHighWatermarkId) {
    throw transcriptReaderError("cursor_revision_mismatch", "Legacy event transcript changed during pagination");
  }
  if (highWatermarkId === 0) {
    return { events: [], nextCursor: null, revision, readBytes: 0 };
  }

  const afterCondition = cursor
    ? or(
      gt(heartbeatRunEvents.seq, cursor.afterSeq),
      and(eq(heartbeatRunEvents.seq, cursor.afterSeq), gt(heartbeatRunEvents.id, cursor.afterId)),
    )
    : undefined;
  const eventBytes = sql<number>`octet_length(coalesce(${heartbeatRunEvents.payload}::text, ''))
    + octet_length(coalesce(${heartbeatRunEvents.stream}, ''))
    + octet_length(coalesce(${heartbeatRunEvents.level}, ''))
    + octet_length(coalesce(${heartbeatRunEvents.color}, ''))
    + octet_length(coalesce(${heartbeatRunEvents.message}, ''))
    + octet_length(coalesce(${heartbeatRunEvents.idempotencyKey}, '')) + 128`;
  const metadata = await db.select({
    id: heartbeatRunEvents.id,
    seq: heartbeatRunEvents.seq,
    byteLength: eventBytes,
  })
    .from(heartbeatRunEvents)
    .where(and(
      scope,
      lte(heartbeatRunEvents.id, highWatermarkId),
      afterCondition,
    ))
    .orderBy(asc(heartbeatRunEvents.seq), asc(heartbeatRunEvents.id))
    .limit(Math.min(MAX_PAGE_LIMIT, Math.max(1, input.limit)) + 1);
  throwIfReadAborted(input.signal);

  const selected: Array<{ id: number; seq: number; byteLength: number }> = [];
  let bytes = 0;
  let limitReached: TranscriptReadLimit | null = null;
  for (const raw of metadata as Array<{ id: number; seq: number; byteLength: number }>) {
    const row = { id: Number(raw.id), seq: Number(raw.seq), byteLength: Number(raw.byteLength) };
    if (row.byteLength > input.maxItemBytes) {
      if (selected.length === 0) limitReached = { reason: "item_bytes", maximum: input.maxItemBytes };
      break;
    }
    if (row.byteLength > input.maxBytes - bytes) {
      if (selected.length === 0) limitReached = { reason: "page_bytes", maximum: input.maxBytes };
      break;
    }
    selected.push(row);
    bytes += row.byteLength;
    if (selected.length >= input.limit) break;
  }
  if (selected.length === 0) {
    return { events: [], nextCursor: null, revision, readBytes: 0, limitReached };
  }

  const ids = selected.map((row) => row.id);
  const rows = await db.select()
    .from(heartbeatRunEvents)
    .where(and(scope, lte(heartbeatRunEvents.id, highWatermarkId), inArray(heartbeatRunEvents.id, ids)))
    .orderBy(asc(heartbeatRunEvents.seq), asc(heartbeatRunEvents.id));
  throwIfReadAborted(input.signal);
  if (rows.length !== selected.length) {
    throw transcriptReaderError("cursor_revision_mismatch", "Legacy event transcript changed during pagination");
  }
  if (input.identity && (rows as Record<string, unknown>[]).some((event) =>
    event.orgId !== input.orgId
      || event.runId !== input.run.id
      || eventSpanId(event) !== input.identity!.spanId
      || eventAttemptId(event) !== input.identity!.attemptId,
  )) {
    throw transcriptReaderError("cursor_revision_mismatch", "Legacy transcript event identity changed during pagination");
  }
  const last = selected.at(-1)!;
  const hasMore = metadata.length > selected.length || Boolean(limitReached);
  return {
    events: rows as Record<string, unknown>[],
    nextCursor: hasMore ? encodeLegacyEventCursor({
      version: 1,
      afterSeq: last.seq,
      afterId: last.id,
      highWatermarkId,
      revision,
    }) : null,
    revision,
    readBytes: bytes,
  };
}

export async function readNativeBoundLegacySpan(
  db: ReadDatabase,
  options: TranscriptReaderOptions,
  input: {
    orgId: string;
    run: HeartbeatRunRecord;
    span: RunRuntimeSpanRecord;
    cursor?: string | null;
    limit?: number;
    providerOffset: number;
    signal?: AbortSignal;
  },
): Promise<ResolvedSource> {
  const state = decodeLegacyCursor(input.cursor) ?? {
    version: 1 as const,
    phase: "events" as const,
    offset: 0,
    skipEntries: 0,
    totalBytes: 0,
    totalItems: 0,
  };
  if (state.phase !== "events") {
    throw transcriptReaderError("cursor_invalid", "Invalid native-bound legacy transcript cursor");
  }
  const maxReadBytes = Math.max(4, Math.min(MAX_LEGACY_READ_BYTES, Math.floor(options.maxLegacyReadBytes ?? DEFAULT_LEGACY_READ_BYTES)));
  const maxTotalBytes = Math.max(4, Math.min(MAX_LEGACY_TOTAL_READ_BYTES, Math.floor(options.maxLegacyTotalBytes ?? DEFAULT_LEGACY_TOTAL_READ_BYTES)));
  const maxTotalItems = Math.max(1, Math.min(MAX_LEGACY_TOTAL_ITEMS, Math.floor(options.maxLegacyTotalItems ?? DEFAULT_LEGACY_TOTAL_ITEMS)));
  const maxItemBytes = Math.max(4, Math.min(MAX_LEGACY_ITEM_BYTES, Math.floor(options.maxLegacyItemBytes ?? DEFAULT_LEGACY_ITEM_BYTES)));
  const limit = Math.min(normalizeLimit(input.limit), maxTotalItems - state.totalItems);
  const maxBytes = Math.min(maxReadBytes, maxTotalBytes - state.totalBytes);
  const budgetLimit: TranscriptReadLimit | null = limit <= 0
    ? { reason: "total_items", maximum: maxTotalItems }
    : maxBytes <= 0
      ? { reason: "total_bytes", maximum: maxTotalBytes }
      : null;
  const eventPage = budgetLimit
    ? null
    : await readLegacyEventPage(db, {
      orgId: input.orgId,
      run: input.run,
      identity: { spanId: input.span.id, attemptId: input.span.attemptId ?? null },
      cursor: state.eventCursor,
      limit,
      maxBytes,
      maxItemBytes,
      signal: input.signal,
    });
  const revision = eventPage?.revision ?? defaultRevision(input.run, `native-bound-legacy:${input.span.id}:${input.span.attemptId ?? "none"}`);
  const entries = entriesFromLegacyEvents(eventPage?.events ?? []);
  const nextTotalBytes = state.totalBytes + (eventPage?.readBytes ?? 0);
  const nextTotalItems = state.totalItems + (eventPage?.events.length ?? 0);
  const totalLimit: TranscriptReadLimit | null = eventPage?.nextCursor && nextTotalBytes >= maxTotalBytes
    ? { reason: "total_bytes", maximum: maxTotalBytes }
    : eventPage?.nextCursor && nextTotalItems >= maxTotalItems
      ? { reason: "total_items", maximum: maxTotalItems }
      : null;
  const limitReached = budgetLimit ?? eventPage?.limitReached ?? totalLimit;
  const hasMore = Boolean(eventPage?.nextCursor) && !limitReached;
  const items = normalizeItems(entries, {
    runId: input.run.id,
    spanId: input.span.id,
    origin: "legacy",
  });
  const retainedCopyAvailable = Boolean(eventPage && (eventPage.events.length > 0 || eventPage.limitReached));
  return {
    items,
    source: "legacy",
    revision,
    providerRevision: revision,
    availability: retainedCopyAvailable ? "available" : "offline",
    completeness: hasMore || limitReached ? "partial" : "unknown",
    limitReached,
    providerCursor: input.cursor ?? null,
    providerNextCursor: hasMore ? encodeLegacyCursor({
      ...state,
      phase: "events",
      offset: 0,
      skipEntries: 0,
      totalBytes: nextTotalBytes,
      totalItems: nextTotalItems,
      eventCursor: eventPage?.nextCursor ?? null,
    }) : null,
    providerOffset: input.providerOffset,
    providerNextOffset: input.providerOffset + items.length,
    spanId: input.span.id,
  };
}
