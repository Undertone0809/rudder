import type { NativeTranscriptRangeHandling, NativeTranscriptRawItem, NativeTranscriptReadResult, TranscriptRange } from "./transcript-reader.contracts.js";
import { asRecord, transcriptReaderError } from "./transcript-reader.normalize.js";

export function rawItemsFromResult(result: NativeTranscriptReadResult): readonly NativeTranscriptRawItem[] {
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.entries)) return result.entries;
  return result.item ? [result.item] : [];
}

export function boundedSourceBudget(value: number | undefined, fallback: number, maximum: number): number {
  const candidate = Number.isFinite(value) ? Math.floor(value!) : fallback;
  return Math.max(4, Math.min(maximum, candidate));
}

function jsonStringBytesWithin(value: string, maximum: number): number | null {
  let bytes = 2;
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    const encodedBytes = codePoint === 0x22 || codePoint === 0x5c
      ? 2
      : codePoint <= 0x1f
        ? ([0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(codePoint) ? 2 : 6)
        : codePoint >= 0xd800 && codePoint <= 0xdfff
          ? 6
          : codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    bytes += encodedBytes;
    if (bytes > maximum) return null;
    index += width;
  }
  return bytes <= maximum ? bytes : null;
}

function jsonBytesWithin(
  value: unknown,
  maximum: number,
  ancestors: WeakSet<object> = new WeakSet(),
  depth = 0,
): number | null {
  if (maximum < 1 || depth > 100) return null;
  if (value === null || typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return maximum >= 4 ? 4 : null;
  }
  if (typeof value === "string") return jsonStringBytesWithin(value, maximum);
  if (typeof value === "boolean") return maximum >= (value ? 4 : 5) ? (value ? 4 : 5) : null;
  if (typeof value === "number") {
    const text = Number.isFinite(value) ? String(value) : "null";
    return text.length <= maximum ? text.length : null;
  }
  if (typeof value === "bigint") return null;
  if (typeof value !== "object") return null;
  if (ancestors.has(value)) return null;

  ancestors.add(value);
  try {
    let bytes = 2;
    const append = (size: number | null) => {
      if (size === null || bytes + size > maximum) return false;
      bytes += size;
      return true;
    };
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0 && !append(1)) return null;
        if (!append(jsonBytesWithin(value[index], maximum - bytes, ancestors, depth + 1))) return null;
      }
      return bytes;
    }
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const child = (value as Record<string, unknown>)[key];
      if (typeof child === "undefined" || typeof child === "function" || typeof child === "symbol") continue;
      if (bytes > 2 && !append(1)) return null;
      if (!append(jsonStringBytesWithin(key, maximum - bytes))) return null;
      if (!append(1)) return null;
      if (!append(jsonBytesWithin(child, maximum - bytes, ancestors, depth + 1))) return null;
    }
    return bytes;
  } finally {
    ancestors.delete(value);
  }
}

export function nativeItemsByteLength(
  items: readonly NativeTranscriptRawItem[],
  maxBytes: number,
  maxItemBytes: number,
): number {
  let bytes = 2;
  for (let index = 0; index < items.length; index += 1) {
    if (index > 0) bytes += 1;
    const itemBytes = jsonBytesWithin(items[index], Math.min(maxItemBytes, maxBytes - bytes));
    if (itemBytes === null) {
      throw transcriptReaderError(
        "source_budget_exceeded",
        "Native transcript provider exceeded the requested source byte budget.",
        502,
      );
    }
    bytes += itemBytes;
  }
  if (bytes > maxBytes) {
    throw transcriptReaderError(
      "source_budget_exceeded",
      "Native transcript provider exceeded the requested source byte budget.",
      502,
    );
  }
  return bytes;
}

export function providerRangeForRead(range: TranscriptRange | null | undefined): TranscriptRange | null | undefined {
  if (!range) return range;
  let providerRange = range;
  for (const key of ["start", "end", "fromExclusive", "after", "throughInclusive", "before"] as const) {
    if (typeof providerRange[key] === "number") providerRange = { ...providerRange, [key]: undefined };
  }
  return Object.values(providerRange).some((value) => value !== undefined && value !== null)
    ? providerRange
    : null;
}

function rangeBoundaryItemId(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  const record = asRecord(value);
  return typeof record?.itemId === "string" && record.itemId.length > 0 ? record.itemId : null;
}

export function verifiedRangeHandling(
  range: TranscriptRange | null | undefined,
  reported: NativeTranscriptRangeHandling | undefined,
): NativeTranscriptRangeHandling | undefined {
  const requested = asRecord(range);
  const claimed = asRecord(reported);
  if (!requested || !claimed) return undefined;
  const handling: NativeTranscriptRangeHandling = {};
  const startItemId = rangeBoundaryItemId(requested.start);
  const endItemId = rangeBoundaryItemId(requested.end);
  const exclusiveStartItemId = rangeBoundaryItemId(requested.fromExclusive ?? requested.after);
  const throughInclusiveItemId = rangeBoundaryItemId(requested.throughInclusive);
  const beforeItemId = rangeBoundaryItemId(requested.before);
  if (startItemId && claimed.startItemId === startItemId) handling.startItemId = startItemId;
  if (endItemId && claimed.endItemId === endItemId) handling.endItemId = endItemId;
  if (exclusiveStartItemId && claimed.exclusiveStartItemId === exclusiveStartItemId) {
    handling.exclusiveStartItemId = exclusiveStartItemId;
  }
  if (throughInclusiveItemId && claimed.throughInclusiveItemId === throughInclusiveItemId) {
    handling.throughInclusiveItemId = throughInclusiveItemId;
  }
  if (beforeItemId && claimed.beforeItemId === beforeItemId) handling.beforeItemId = beforeItemId;
  return Object.keys(handling).length > 0 ? handling : undefined;
}

export function mergeRangeHandling(
  left: NativeTranscriptRangeHandling | undefined,
  right: NativeTranscriptRangeHandling | undefined,
): NativeTranscriptRangeHandling | undefined {
  if (!left || !right) return undefined;
  const handling: NativeTranscriptRangeHandling = {};
  for (const key of ["startItemId", "endItemId", "exclusiveStartItemId", "throughInclusiveItemId", "beforeItemId"] as const) {
    if (left[key] && left[key] === right[key]) handling[key] = left[key];
  }
  return Object.keys(handling).length > 0 ? handling : undefined;
}

export function rangeForProviderPage(
  range: TranscriptRange | null | undefined,
  handling: NativeTranscriptRangeHandling | undefined,
): TranscriptRange | null | undefined {
  if (!range || !handling) return range;
  let pageRange = range;
  const omit = (key: keyof TranscriptRange, handledId: string | undefined, value: unknown) => {
    if (handledId && rangeBoundaryItemId(value) === handledId) {
      pageRange = { ...pageRange, [key]: undefined };
    }
  };
  omit("start", handling.startItemId, range.start);
  omit("end", handling.endItemId, range.end);
  omit("throughInclusive", handling.throughInclusiveItemId, range.throughInclusive);
  omit("before", handling.beforeItemId, range.before);
  const exclusiveStart = range.fromExclusive ?? range.after;
  if (handling.exclusiveStartItemId && rangeBoundaryItemId(exclusiveStart) === handling.exclusiveStartItemId) {
    pageRange = { ...pageRange, fromExclusive: undefined, after: undefined };
  }
  return pageRange;
}
