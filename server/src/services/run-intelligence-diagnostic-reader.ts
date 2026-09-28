import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { TranscriptItem, TranscriptPage } from "./runtime-kernel/transcript-reader.js";

export const MAX_DIAGNOSTIC_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const MAX_DIAGNOSTIC_TRANSCRIPT_PAGE_BYTES = 1024 * 1024;

export interface RunDiagnosticProjection {
  completeness: "complete" | "partial" | "terminal_only" | "unknown";
  source: string;
  availability: string;
  limitReached: TranscriptPage["limitReached"];
  truncatedItems: number;
  omittedSources: string[];
  readFailure: boolean;
}

export interface RunDiagnosticTraceState {
  nextTurnIndex: number;
  activeTurnIndex: number | null;
}

export interface RunDiagnosticReaderPosition {
  sourceCursor: string | null;
  itemOffset: number;
  stepOffset: number;
  traceState: RunDiagnosticTraceState;
}

export interface RunDiagnosticEntryPosition {
  stepIndex: number;
  turnIndex: number | null;
  after: RunDiagnosticReaderPosition;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function readBoundedRunDiagnosticTranscript(input: {
  readPage(cursor: string | null, limit: number): Promise<TranscriptPage>;
  toEntry(item: TranscriptItem): TranscriptEntry | null;
  position?: RunDiagnosticReaderPosition;
  omittedSources?: string[];
}): Promise<{
  entries: TranscriptEntry[];
  entryPositions: RunDiagnosticEntryPosition[];
  projection: RunDiagnosticProjection;
  nextPosition: RunDiagnosticReaderPosition | null;
  revision: string | null;
}> {
  const entries: TranscriptEntry[] = [];
  const entryPositions: RunDiagnosticEntryPosition[] = [];
  const startPosition = input.position ?? {
    sourceCursor: null,
    itemOffset: 0,
    stepOffset: 0,
    traceState: { nextTurnIndex: 0, activeTurnIndex: null },
  };
  let cursor = startPosition.sourceCursor;
  let itemOffset = startPosition.itemOffset;
  let stepOffset = startPosition.stepOffset;
  let traceState = { ...startPosition.traceState };
  let source = "native";
  let availability = "unknown";
  let completeness: RunDiagnosticProjection["completeness"] = "unknown";
  let limitReached: TranscriptPage["limitReached"] = null;
  let truncatedItems = 0;
  let bytesRead = 0;
  let sourceTruncated = false;
  let readFailure = false;
  let ended = false;
  let nextPosition: RunDiagnosticReaderPosition | null = startPosition;
  let revision: string | null = null;

  try {
    for (let pageCount = 0; pageCount < 256; pageCount += 1) {
      const page = await input.readPage(cursor, 50);
      source = page.source;
      availability = page.availability;
      completeness = page.completeness;
      revision = page.revision;
      if (page.limitReached) limitReached = page.limitReached;
      sourceTruncated ||= page.truncated === true;
      let budgetExceeded = false;
      for (let index = itemOffset; index < page.items.length; index += 1) {
        const item = page.items[index]!;
        const entry = input.toEntry(item);
        if (!entry) {
          itemOffset = index + 1;
          nextPosition = { sourceCursor: cursor, itemOffset, stepOffset, traceState: { ...traceState } };
          continue;
        }
        const bytes = Buffer.byteLength(JSON.stringify(item) ?? "null", "utf8");
        const kind = entry.kind;
        let nextTurnIndex = traceState.nextTurnIndex;
        let activeTurnIndex = traceState.activeTurnIndex;
        let turnIndex: number | null = null;
        if (kind === "assistant" || kind === "thinking") {
          if (activeTurnIndex === null) activeTurnIndex = ++nextTurnIndex;
          turnIndex = activeTurnIndex;
        } else if (kind === "tool_call" || kind === "tool_result" || kind === "result") {
          if (activeTurnIndex === null) activeTurnIndex = ++nextTurnIndex;
          turnIndex = activeTurnIndex;
          if (kind === "result") activeTurnIndex = null;
        }
        if (bytes > MAX_DIAGNOSTIC_TRANSCRIPT_BYTES) {
          sourceTruncated = true;
          truncatedItems += 1;
          limitReached = { reason: "item_bytes", maximum: MAX_DIAGNOSTIC_TRANSCRIPT_BYTES };
          stepOffset += 1;
          traceState = { nextTurnIndex, activeTurnIndex };
          itemOffset = index + 1;
          nextPosition = { sourceCursor: cursor, itemOffset, stepOffset, traceState: { ...traceState } };
          continue;
        }
        if (bytes > MAX_DIAGNOSTIC_TRANSCRIPT_BYTES - bytesRead) {
          limitReached = { reason: "total_bytes", maximum: MAX_DIAGNOSTIC_TRANSCRIPT_BYTES };
          nextPosition = { sourceCursor: cursor, itemOffset: index, stepOffset, traceState: { ...traceState } };
          budgetExceeded = true;
          break;
        }
        bytesRead += bytes;
        const originalLengths = asRecord((entry as Record<string, unknown>).__rudderOriginalLengths);
        const truncatedFields = (entry as Record<string, unknown>).__rudderTruncatedFields;
        if ((originalLengths && Object.keys(originalLengths).length > 0)
          || (Array.isArray(truncatedFields) && truncatedFields.length > 0)) {
          truncatedItems += 1;
        }
        entries.push(entry);
        stepOffset += 1;
        traceState = { nextTurnIndex, activeTurnIndex };
        itemOffset = index + 1;
        nextPosition = { sourceCursor: cursor, itemOffset, stepOffset, traceState: { ...traceState } };
        entryPositions.push({
          stepIndex: stepOffset,
          turnIndex,
          after: {
            sourceCursor: nextPosition.sourceCursor,
            itemOffset: nextPosition.itemOffset,
            stepOffset: nextPosition.stepOffset,
            traceState: { ...nextPosition.traceState },
          },
        });
      }
      if (budgetExceeded) break;
      if (page.nextCursor) {
        if (page.nextCursor === cursor) throw new Error("Transcript reader cursor made no progress");
        cursor = page.nextCursor;
        itemOffset = 0;
        nextPosition = { sourceCursor: cursor, itemOffset, stepOffset, traceState: { ...traceState } };
        continue;
      }
      if (page.items.length === 0 || itemOffset >= page.items.length) {
        ended = true;
        nextPosition = null;
        break;
      }
    }
  } catch {
    readFailure = true;
    nextPosition = null;
  }

  if (!ended && !limitReached && !readFailure) {
    limitReached = { reason: "total_items", maximum: 256 * 50 };
  }
  if (sourceTruncated || truncatedItems > 0 || limitReached || readFailure
    || (input.omittedSources?.length ?? 0) > 0) {
    completeness = "partial";
  }

  return {
    entries,
    entryPositions,
    projection: {
      completeness,
      source,
      availability,
      limitReached,
      truncatedItems,
      omittedSources: input.omittedSources ?? [],
      readFailure,
    },
    nextPosition,
    revision,
  };
}
