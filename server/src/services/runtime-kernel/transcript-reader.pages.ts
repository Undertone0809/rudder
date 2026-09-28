import type {
  CursorPayload,
  CursorScope,
  ResolvedSource,
  TranscriptAvailability,
  TranscriptCompleteness,
  TranscriptItem,
  TranscriptPage,
  TranscriptPrincipal,
  TranscriptRange,
  TranscriptRangeBoundary,
  TranscriptSource,
} from "./transcript-reader.contracts.js";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT
} from "./transcript-reader.contracts.js";
import {
  compatibilityValueKey,
  selectedPrincipalScope,
  stableHash,
  transcriptReaderError,
} from "./transcript-reader.normalize.js";

export function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(value!)));
}

export function itemMatchesRef(item: TranscriptItem, ref: string): boolean {
  return item.id === ref || item.sourceEntryId === ref;
}

export function lastItemMatchingRef(items: TranscriptItem[], ref: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (itemMatchesRef(items[index]!, ref)) return index;
  }
  return -1;
}

export function applyVisibilityCutoff(items: TranscriptItem[], cutoff: string | null | undefined): TranscriptItem[] {
  const visible = items.filter((item) => item.visibility !== "hidden");
  if (!cutoff) return visible;
  const index = lastItemMatchingRef(visible, cutoff);
  if (index >= 0) return visible.slice(0, index + 1);
  if (/^\d+$/u.test(cutoff)) return visible.filter((item) => item.ordinal <= Number(cutoff));
  // An unknown stop marker must fail closed. It is safer to hide the source
  // than to expose the tail after a stop that cannot be resolved.
  return [];
}

export function applyRange(
  items: TranscriptItem[],
  range: TranscriptRange | null | undefined,
  sourceOffset = 0,
): TranscriptItem[] {
  if (!range) return items;
  const sourceIndex = (item: TranscriptItem) => sourceOffset + items.indexOf(item);
  if (range.itemId) return items.filter((item) => itemMatchesRef(item, range.itemId!));

  const ordinalFor = (value: string | number | TranscriptRangeBoundary | null | undefined): number | null => {
    if (typeof value === "number") return value;
    if (value && typeof value === "object" && typeof value.ordinal === "number") return value.ordinal;
    return null;
  };
  const idFor = (value: string | number | TranscriptRangeBoundary | null | undefined): string | null => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return value.itemId ?? null;
    return null;
  };
  const inclusiveStart = (value: string | number | TranscriptRangeBoundary | null | undefined): TranscriptItem[] => {
    const id = idFor(value);
    if (id) {
      const found = items.findIndex((item) => itemMatchesRef(item, id));
      if (found >= 0) return items.slice(found);
    }
    const ordinal = ordinalFor(value);
    if (ordinal !== null && typeof value !== "number") return items.filter((item) => item.ordinal >= ordinal);
    return !id && typeof value === "number"
      ? items.filter((item) => sourceIndex(item) >= Math.floor(value))
      : [];
  };
  const inclusiveEnd = (value: string | number | TranscriptRangeBoundary | null | undefined): TranscriptItem[] => {
    const id = idFor(value);
    if (id) {
      const found = lastItemMatchingRef(items, id);
      if (found >= 0) return items.slice(0, found + 1);
    }
    const ordinal = ordinalFor(value);
    if (ordinal !== null && typeof value !== "number") return items.filter((item) => item.ordinal <= ordinal);
    return !id && typeof value === "number"
      ? items.filter((item) => sourceIndex(item) <= Math.floor(value))
      : [];
  };
  let selected = range.start === undefined || range.start === null ? items : inclusiveStart(range.start);
  if (range.end !== undefined && range.end !== null) {
    const id = idFor(range.end);
    const found = id ? lastItemMatchingRef(selected, id) : -1;
    if (found >= 0) selected = selected.slice(0, found + 1);
    else {
      const ordinal = ordinalFor(range.end);
      if (ordinal !== null && typeof range.end !== "number") selected = selected.filter((item) => item.ordinal <= ordinal);
      else if (typeof range.end === "number") {
        const endIndex = Math.floor(range.end);
        selected = selected.filter((item) => sourceIndex(item) <= endIndex);
      }
      else selected = [];
    }
  }
  const exclusiveStart = range.fromExclusive ?? range.after ?? null;
  if (exclusiveStart !== null) {
    const id = idFor(exclusiveStart);
    const found = id ? lastItemMatchingRef(selected, id) : -1;
      if (found >= 0) selected = selected.slice(found + 1);
      else {
        const ordinal = ordinalFor(exclusiveStart);
        if (typeof exclusiveStart === "number") selected = selected.filter((item) => sourceIndex(item) > Math.floor(exclusiveStart));
        else if (ordinal !== null) selected = selected.filter((item) => item.ordinal > ordinal);
        else selected = [];
      }
  }
  const throughInclusive = range.throughInclusive ?? null;
  if (throughInclusive !== null) {
    const id = idFor(throughInclusive);
    const found = id ? lastItemMatchingRef(selected, id) : -1;
      if (found >= 0) selected = selected.slice(0, found + 1);
      else {
        const ordinal = ordinalFor(throughInclusive);
        if (typeof throughInclusive === "number") selected = selected.filter((item) => sourceIndex(item) <= Math.floor(throughInclusive));
        else if (ordinal !== null) selected = selected.filter((item) => item.ordinal <= ordinal);
        else selected = [];
      }
  }
  if (range.before !== undefined && range.before !== null) {
    const id = idFor(range.before);
    const found = id ? selected.findIndex((item) => itemMatchesRef(item, id)) : -1;
      if (found >= 0) selected = selected.slice(0, found);
      else {
        const ordinal = ordinalFor(range.before);
        if (typeof range.before === "number") {
          const beforeIndex = Math.floor(range.before);
          selected = selected.filter((item) => sourceIndex(item) < beforeIndex);
        }
        else if (ordinal !== null) selected = selected.filter((item) => item.ordinal < ordinal);
        else selected = [];
      }
  }
  return selected;
}

const itemIdBoundaryKeys = ["start", "end", "fromExclusive", "after", "throughInclusive", "before"] as const;

function isItemIdBoundary(value: unknown): boolean {
  return typeof value === "string"
    || Boolean(value && typeof value === "object" && "itemId" in value && (value as TranscriptRangeBoundary).itemId);
}

export function spanRangeWithoutItemIds(range: TranscriptRange | null | undefined): TranscriptRange | null | undefined {
  if (!range) return range;
  const spanRange: Record<string, unknown> = { ...range };
  delete spanRange.itemId;
  for (const key of itemIdBoundaryKeys) {
    if (isItemIdBoundary(range[key])) delete spanRange[key];
  }
  return Object.values(spanRange).some((value) => value !== undefined && value !== null)
    ? spanRange as TranscriptRange
    : null;
}

export function runRangeWithItemIds(range: TranscriptRange | null | undefined): TranscriptRange | null {
  if (!range) return null;
  const itemIdRange: Record<string, unknown> = {};
  if (range.itemId) itemIdRange.itemId = range.itemId;
  for (const key of itemIdBoundaryKeys) {
    if (isItemIdBoundary(range[key])) itemIdRange[key] = range[key];
  }
  return Object.keys(itemIdRange).length > 0 ? itemIdRange as TranscriptRange : null;
}

export type RunItemIdRangeState = { resolvedBoundaryKeys: string[] };

const lowerItemIdBoundaryKeys = ["start", "fromExclusive", "after"] as const;
const upperItemIdBoundaryKeys = ["end", "throughInclusive", "before"] as const;

function boundaryItemId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "itemId" in value) {
    const itemId = (value as TranscriptRangeBoundary).itemId;
    return typeof itemId === "string" && itemId.length > 0 ? itemId : null;
  }
  return null;
}

export function selectRunItemsForItemIdRange(
  items: TranscriptItem[],
  range: TranscriptRange,
  state: RunItemIdRangeState,
  hasMore: boolean,
): { items: TranscriptItem[]; state: RunItemIdRangeState; endReached: boolean } {
  if (range.itemId) return { items: applyRange(items, range), state, endReached: false };

  const resolvedBoundaryKeys = new Set(state.resolvedBoundaryKeys);
  const pendingRange: Record<string, unknown> = { ...range };
  let unresolvedLowerBoundary = false;
  let endReached = false;
  for (const key of itemIdBoundaryKeys) {
    const itemId = boundaryItemId(range[key]);
    if (!itemId) continue;
    if (resolvedBoundaryKeys.has(key)) {
      delete pendingRange[key];
      continue;
    }
    const found = items.some((item) => itemMatchesRef(item, itemId));
    if (found) {
      resolvedBoundaryKeys.add(key);
      if ((upperItemIdBoundaryKeys as readonly string[]).includes(key)) endReached = true;
      continue;
    }
    if (hasMore) {
      delete pendingRange[key];
      if ((lowerItemIdBoundaryKeys as readonly string[]).includes(key)) unresolvedLowerBoundary = true;
    }
  }

  return {
    items: unresolvedLowerBoundary ? [] : applyRange(items, pendingRange as TranscriptRange),
    state: { resolvedBoundaryKeys: [...resolvedBoundaryKeys] },
    endReached,
  };
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function encodeTranscriptCursor(payload: CursorPayload): string {
  return encodeCursor(payload);
}

export function decodeCursor(value: string | null | undefined): CursorPayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (parsed.version !== 1 || (parsed.scope !== "run" && parsed.scope !== "conversation")
      || typeof parsed.orgId !== "string" || typeof parsed.principalScopeRef !== "string"
      || typeof parsed.revision !== "string" || typeof parsed.position !== "number"
      || !Number.isSafeInteger(parsed.position) || parsed.position < 0
      || (parsed.providerOffset !== undefined
        && (!Number.isSafeInteger(parsed.providerOffset) || parsed.providerOffset < 0))) {
      throw new Error("invalid cursor");
    }
    return parsed as CursorPayload;
  } catch {
    throw transcriptReaderError("cursor_invalid", "Invalid transcript cursor");
  }
}

export function decodeTranscriptCursor(value: string | null | undefined): CursorPayload | null {
  return decodeCursor(value);
}

function assertCursor(
  cursor: CursorPayload | null,
  input: {
    scope: CursorScope;
    orgId: string;
    principalScopeRef: string;
    principalType?: string | null;
    principalId?: string | null;
    id: string;
    spanId?: string | null;
    source: TranscriptSource;
    range: TranscriptRange | null;
    visibilityCutoffRef: string | null;
    revision: string;
  },
) {
  if (!cursor) return 0;
  if (cursor.scope !== input.scope || cursor.orgId !== input.orgId || cursor.principalScopeRef !== input.principalScopeRef
    || cursor.revision !== input.revision
    || (input.scope === "run" ? cursor.runId !== input.id : cursor.conversationId !== input.id)
    || (cursor.principalType !== undefined && cursor.principalType !== (input.principalType ?? undefined))
    || (cursor.principalId !== undefined && cursor.principalId !== (input.principalId ?? undefined))
    || (cursor.spanId !== undefined && (cursor.spanId ?? null) !== (input.spanId ?? null))) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this scope");
  }
  if (cursor.source !== undefined && cursor.source !== input.source) {
    throw transcriptReaderError("cursor_source_mismatch", "Transcript cursor does not belong to this source");
  }
  if (cursor.range !== undefined && compatibilityValueKey(cursor.range) !== compatibilityValueKey(input.range)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this range");
  }
  if (cursor.visibilityCutoffRef !== undefined
    && (cursor.visibilityCutoffRef ?? null) !== (input.visibilityCutoffRef ?? null)) {
    throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this visibility cutoff");
  }
  return cursor.position;
}

export function pageFromItems(
  items: TranscriptItem[],
  input: {
    scope: CursorScope;
    id: string;
    orgId: string;
    principalScopeRef: string;
    principalType?: string | null;
    principalId?: string | null;
    spanId?: string | null;
    cursor?: string | null;
    limit?: number;
    source: TranscriptSource;
    range?: TranscriptRange | null;
    visibilityCutoffRef?: string | null;
    revision: string;
    availability: TranscriptAvailability;
    completeness: TranscriptCompleteness;
  },
): TranscriptPage {
  const cursor = decodeCursor(input.cursor);
  const position = assertCursor(cursor, {
    scope: input.scope,
    orgId: input.orgId,
    principalScopeRef: input.principalScopeRef,
    principalType: input.principalType,
    principalId: input.principalId,
    id: input.id,
    spanId: input.spanId ?? null,
    source: input.source,
    range: input.range ?? null,
    visibilityCutoffRef: input.visibilityCutoffRef ?? null,
    revision: input.revision,
  });
  const limit = normalizeLimit(input.limit);
  const pageItems = items.slice(position, position + limit);
  const nextPosition = position + pageItems.length;
  const nextCursor = nextPosition < items.length
    ? encodeCursor({
      version: 1,
      scope: input.scope,
      orgId: input.orgId,
      principalScopeRef: input.principalScopeRef,
      principalType: input.principalType ?? undefined,
      principalId: input.principalId ?? undefined,
      ...(input.scope === "run" ? { runId: input.id } : { conversationId: input.id }),
      spanId: input.spanId ?? null,
      source: input.source,
      range: input.range ?? null,
      visibilityCutoffRef: input.visibilityCutoffRef ?? null,
      revision: input.revision,
      position: nextPosition,
    })
    : null;
  return {
    items: pageItems,
    nextCursor,
    source: input.source,
    revision: input.revision,
    availability: input.availability,
    completeness: input.completeness,
  };
}

export function numericRangeEndReached(range: TranscriptRange | null, nextOffset: number | undefined): boolean {
  if (nextOffset === undefined) return false;
  const exclusiveEnds = [range?.end, range?.throughInclusive]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .map((value) => Math.floor(value) + 1);
  if (typeof range?.before === "number" && Number.isFinite(range.before)) {
    exclusiveEnds.push(Math.floor(range.before));
  }
  return exclusiveEnds.length > 0 && nextOffset >= Math.min(...exclusiveEnds);
}

export function runCursorPayload(input: {
  id: string;
  orgId: string;
  principal: TranscriptPrincipal;
  spanId: string | null;
  source: TranscriptSource;
  range: TranscriptRange | null;
  visibilityCutoffRef: string | null;
  windowRevision: string;
  providerRevision: string | null;
  activeSpanId: string | null;
  providerPageCursor: string | null;
  providerNextCursor: string | null;
  providerOffset: number;
  position: number;
  sourceTransition?: boolean;
  runItemIdRangeState?: RunItemIdRangeState;
}): CursorPayload {
  return {
    version: 1,
    scope: "run",
    orgId: input.orgId,
    principalScopeRef: selectedPrincipalScope(input.principal, input.orgId),
    principalType: input.principal.type ?? undefined,
    principalId: input.principal.id ?? undefined,
    runId: input.id,
    spanId: input.spanId,
    source: input.source,
    range: input.range,
    visibilityCutoffRef: input.visibilityCutoffRef,
    windowRevision: input.windowRevision,
    providerRevision: input.providerRevision,
    activeSpanId: input.activeSpanId,
    providerPageCursor: input.providerPageCursor,
    providerNextCursor: input.providerNextCursor,
    providerOffset: input.providerOffset,
    ...(input.sourceTransition ? { sourceTransition: true } : {}),
    ...(input.runItemIdRangeState ? { runItemIdRangeState: input.runItemIdRangeState } : {}),
    revision: stableHash({
      windowRevision: input.windowRevision,
      providerRevision: input.providerRevision,
      activeSpanId: input.activeSpanId,
      providerOffset: input.providerOffset,
      ...(input.runItemIdRangeState ? { runItemIdRangeState: input.runItemIdRangeState } : {}),
    }),
    position: input.position,
  } as CursorPayload;
}

export function pageFromRunSource(
  source: ResolvedSource & {
    runItemIdRangeState?: RunItemIdRangeState;
    runItemIdRangeEnded?: boolean;
  },
  input: {
    id: string;
    orgId: string;
    principal: TranscriptPrincipal;
    spanId?: string | null;
    cursor?: string | null;
    limit?: number;
    range?: TranscriptRange | null;
    visibilityCutoffRef?: string | null;
  },
): TranscriptPage {
  const cursor = decodeCursor(input.cursor);
  const range = input.range ?? null;
  const cutoff = input.visibilityCutoffRef ?? null;
  const windowRevision = source.windowRevision ?? stableHash({
    id: input.id,
    spanId: input.spanId ?? null,
    range,
    cutoff,
  });
  let position = 0;
  let sourceTransition = false;
  if (cursor) {
    if (cursor.scope !== "run"
      || cursor.orgId !== input.orgId
      || cursor.principalScopeRef !== selectedPrincipalScope(input.principal, input.orgId)
      || (cursor.principalType !== undefined && cursor.principalType !== (input.principal.type ?? undefined))
      || (cursor.principalId !== undefined && cursor.principalId !== (input.principal.id ?? undefined))
      || cursor.runId !== input.id
      || (cursor.spanId ?? null) !== (input.spanId ?? null)) {
      throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this scope");
    }
    if (cursor.range !== undefined && compatibilityValueKey(cursor.range) !== compatibilityValueKey(range)) {
      throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this range");
    }
    if (cursor.visibilityCutoffRef !== undefined && (cursor.visibilityCutoffRef ?? null) !== cutoff) {
      throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this visibility cutoff");
    }
    if (cursor.windowRevision && cursor.windowRevision !== windowRevision) {
      throw transcriptReaderError("cursor_revision_mismatch", "Transcript cursor window revision is no longer current");
    }
    if (cursor.activeSpanId && cursor.activeSpanId !== source.spanId) {
      throw transcriptReaderError("cursor_scope_mismatch", "Transcript cursor does not belong to this span");
    }
    sourceTransition = cursor.sourceTransition === true;
    const providerSource = source.providerSource ?? source.source;
    if (!sourceTransition && cursor.source && cursor.source !== providerSource) {
      throw transcriptReaderError("cursor_source_mismatch", "Transcript cursor does not belong to this source");
    }
    const providerRevision = source.providerRevision ?? source.revision;
    if (cursor.providerRevision && cursor.providerRevision !== providerRevision) {
      throw transcriptReaderError("cursor_revision_mismatch", "Transcript cursor provider revision is no longer current");
    }
    const expectedCursorRevision = stableHash({
      windowRevision,
      providerRevision: cursor.providerRevision ?? null,
      activeSpanId: cursor.activeSpanId ?? null,
      ...(cursor.providerOffset === undefined ? {} : { providerOffset: cursor.providerOffset }),
      ...((cursor as CursorPayload & { runItemIdRangeState?: RunItemIdRangeState }).runItemIdRangeState
        ? { runItemIdRangeState: (cursor as CursorPayload & { runItemIdRangeState?: RunItemIdRangeState }).runItemIdRangeState }
        : {}),
    });
    if (cursor.revision !== expectedCursorRevision) {
      throw transcriptReaderError("cursor_revision_mismatch", "Transcript cursor revision is invalid");
    }
    position = cursor.position;
  }

  if (position > source.items.length) {
    throw transcriptReaderError("cursor_invalid", "Transcript cursor is past the provider page");
  }
  const limit = normalizeLimit(input.limit);
  const pageItems = source.items.slice(position, position + limit);
  const nextPosition = position + pageItems.length;
  const rangeEnded = numericRangeEndReached(range, source.providerNextOffset) || source.runItemIdRangeEnded === true;
  const runItemIdRangeState = source.runItemIdRangeState;
  let nextCursor: string | null = null;
  if (nextPosition < source.items.length && !rangeEnded) {
    nextCursor = encodeCursor(runCursorPayload({
      id: input.id,
      orgId: input.orgId,
      principal: input.principal,
      spanId: input.spanId ?? null,
      source: source.providerSource ?? source.source,
      range,
      visibilityCutoffRef: cutoff,
      windowRevision,
      providerRevision: source.providerRevision ?? source.revision,
      activeSpanId: source.spanId,
      providerPageCursor: source.providerCursor,
      providerNextCursor: source.providerNextCursor,
      providerOffset: source.providerOffset ?? 0,
      position: nextPosition,
      runItemIdRangeState,
    }));
  } else if (source.providerNextCursor && !rangeEnded) {
    nextCursor = encodeCursor(runCursorPayload({
      id: input.id,
      orgId: input.orgId,
      principal: input.principal,
      spanId: input.spanId ?? null,
      source: source.providerSource ?? source.source,
      range,
      visibilityCutoffRef: cutoff,
      windowRevision,
      providerRevision: source.providerRevision ?? source.revision,
      activeSpanId: source.spanId,
      providerPageCursor: source.providerNextCursor,
      providerNextCursor: null,
      providerOffset: source.providerNextOffset ?? source.providerOffset ?? 0,
      position: 0,
      runItemIdRangeState,
    }));
  } else if (source.nextSpanId && !rangeEnded) {
    nextCursor = encodeCursor(runCursorPayload({
      id: input.id,
      orgId: input.orgId,
      principal: input.principal,
      spanId: input.spanId ?? null,
      source: source.source,
      range,
      visibilityCutoffRef: cutoff,
      windowRevision,
      providerRevision: null,
      activeSpanId: source.nextSpanId,
      providerPageCursor: null,
      providerNextCursor: null,
      providerOffset: source.providerNextOffset ?? source.providerOffset ?? 0,
      position: 0,
      sourceTransition: true,
      runItemIdRangeState,
    }));
  }

  if (nextCursor && nextCursor === input.cursor) {
    throw transcriptReaderError("cursor_invalid", "Transcript cursor did not advance");
  }

  return {
    items: pageItems,
    nextCursor,
    source: source.source,
    revision: source.revision,
    availability: source.availability,
    completeness: source.completeness,
    ...(source.limitReached ? { limitReached: source.limitReached } : {}),
    ...(source.truncated ? { truncated: true } : {}),
  };
}

export function pageItemsForRange(
  items: TranscriptItem[],
  input: { range?: TranscriptRange | null; visibilityCutoffRef?: string | null; sourceOffset?: number },
) {
  return applyRange(applyVisibilityCutoff(items, input.visibilityCutoffRef), input.range, input.sourceOffset);
}
