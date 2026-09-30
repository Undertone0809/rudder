import {
  redactTranscriptEntryPaths,
  type TranscriptEntry,
} from "@rudderhq/agent-runtime-utils";
import { buildTranscript, getHistoricalTranscriptParser } from "@rudderhq/run-intelligence-core";
import type { RunLogHandle, RunLogReadResult, RunLogStore } from "../run-log-store.js";
import type { HeartbeatRunRecord, TranscriptReadLimit } from "./transcript-reader.contracts.js";
import { isoDate } from "./transcript-reader.normalize.js";

interface LegacyOutputEntry {
  entry: TranscriptEntry;
  offset: number;
}

export interface LegacyLogPage {
  entries: TranscriptEntry[];
  offset: number;
  skipEntries: number;
  readBytes: number;
  eof: boolean;
  next: boolean;
  limitReached: TranscriptReadLimit | null;
}

function throwIfReadAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = signal.reason instanceof Error ? signal.reason : new Error("Legacy transcript read cancelled");
  if (error.name === "Error") error.name = "AbortError";
  throw error;
}

function parseLegacyLogRecord(line: string, fallbackTs: string): { ts: string; stream: string; chunk: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
    const chunk = typeof parsed.chunk === "string" ? parsed.chunk : "";
    if (!chunk) return null;
    return {
      ts: typeof parsed.ts === "string" ? parsed.ts : fallbackTs,
      stream: parsed.stream === "stderr" || parsed.stream === "system" ? parsed.stream : "stdout",
      chunk,
    };
  } catch {
    return null;
  }
}

export async function readLegacyLogPage(
  store: RunLogStore,
  handle: RunLogHandle,
  input: {
    run: HeartbeatRunRecord;
    runtimeType: string;
    offset: number;
    skipEntries: number;
    totalBytes: number;
    totalItems: number;
    pageBytes: number;
    totalBytesLimit: number;
    totalItemsLimit: number;
    itemBytesLimit: number;
    limit: number;
    signal?: AbortSignal;
  },
): Promise<LegacyLogPage> {
  const fallbackTs = isoDate(input.run.startedAt ?? input.run.createdAt);
  const parser = getHistoricalTranscriptParser(input.runtimeType);
  const entries: TranscriptEntry[] = [];
  const replayOffsets: number[] = [];
  let skipRemaining = input.skipEntries;
  let offset = input.offset;
  let readBytes = 0;
  let lineBuffer = "";
  let lineStart = offset;
  let stdoutBuffer = "";
  let stdoutBufferOffset: number | null = null;
  let stdoutBufferTs = fallbackTs;
  let pendingDelta: LegacyOutputEntry | null = null;
  let stopped = false;
  let stopOffset: number | null = null;
  let eof = false;
  let limitReached: TranscriptReadLimit | null = null;

  type DeltaEntry = Extract<TranscriptEntry, { kind: "thinking" | "assistant" }> & { delta: true };
  const isDelta = (entry: TranscriptEntry): entry is DeltaEntry =>
    (entry.kind === "thinking" || entry.kind === "assistant") && entry.delta === true;
  const entryByteLength = (entry: TranscriptEntry) => Buffer.byteLength(JSON.stringify(entry), "utf8");
  const finalize = (output: LegacyOutputEntry, resumeOffset: number): boolean => {
    replayOffsets.push(output.offset);
    if (skipRemaining > 0) {
      skipRemaining -= 1;
      return true;
    }
    if (input.totalItems + entries.length >= input.totalItemsLimit) {
      limitReached = { reason: "total_items", maximum: input.totalItemsLimit };
      stopped = true;
      stopOffset = resumeOffset;
      return false;
    }
    if (entryByteLength(output.entry) > input.itemBytesLimit) {
      limitReached = { reason: "item_bytes", maximum: input.itemBytesLimit };
      stopped = true;
      stopOffset = resumeOffset;
      return false;
    }
    entries.push(output.entry);
    if (entries.length >= input.limit) {
      stopped = true;
      stopOffset = resumeOffset;
      return false;
    }
    return true;
  };
  const append = (entry: TranscriptEntry, sourceOffset: number): boolean => {
    if (pendingDelta) {
      const pending = pendingDelta.entry;
      if (isDelta(entry) && isDelta(pending) && pending.kind === entry.kind) {
        pending.text += entry.text;
        pending.ts = entry.ts;
        if (entryByteLength(pending) > input.itemBytesLimit) {
          limitReached = { reason: "item_bytes", maximum: input.itemBytesLimit };
          stopped = true;
          stopOffset = pendingDelta.offset;
          return false;
        }
        return true;
      }
      const previous = pendingDelta;
      pendingDelta = null;
      if (!finalize(previous, sourceOffset)) return false;
    }
    const output = { entry, offset: sourceOffset };
    if (isDelta(entry)) {
      if (entryByteLength(entry) > input.itemBytesLimit) {
        limitReached = { reason: "item_bytes", maximum: input.itemBytesLimit };
        stopped = true;
        stopOffset = sourceOffset;
        return false;
      }
      pendingDelta = output;
      return true;
    }
    return finalize(output, sourceOffset);
  };
  const appendStdoutText = (text: string, ts: string, sourceOffset: number): boolean => {
    if (!stdoutBuffer) stdoutBufferOffset = sourceOffset;
    const combined = stdoutBuffer + text;
    const lines = combined.split(/\r?\n/u);
    stdoutBuffer = lines.pop() ?? "";
    stdoutBufferTs = ts;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      for (const parsed of parser(trimmed, ts)) {
        const entry = redactTranscriptEntryPaths(parsed, { enabled: false });
        if (!append(entry, stdoutBufferOffset ?? sourceOffset)) return false;
      }
      stdoutBufferOffset = sourceOffset;
    }
    if (!stdoutBuffer) stdoutBufferOffset = null;
    if (Buffer.byteLength(stdoutBuffer, "utf8") > input.itemBytesLimit) {
      limitReached = { reason: "item_bytes", maximum: input.itemBytesLimit };
      stopped = true;
      stopOffset = stdoutBufferOffset ?? sourceOffset;
      return false;
    }
    return true;
  };
  const processLogLine = (line: string, sourceOffset: number): boolean => {
    if (Buffer.byteLength(line, "utf8") > input.itemBytesLimit) {
      limitReached = { reason: "item_bytes", maximum: input.itemBytesLimit };
      stopped = true;
      stopOffset = sourceOffset;
      return false;
    }
    const chunk = parseLegacyLogRecord(line, fallbackTs);
    if (!chunk) return true;
    if (chunk.stream === "stdout") return appendStdoutText(chunk.chunk, chunk.ts, sourceOffset);
    const parsed = buildTranscript([{ stream: chunk.stream as "stderr" | "system", chunk: chunk.chunk, ts: chunk.ts }], parser);
    for (const entry of parsed) {
      if (!append(entry, sourceOffset)) return false;
    }
    return true;
  };

  while (!stopped) {
    throwIfReadAborted(input.signal);
    const pageRemaining = input.pageBytes - readBytes;
    const totalRemaining = input.totalBytesLimit - input.totalBytes - readBytes;
    if (totalRemaining < 4) {
      limitReached = { reason: "total_bytes", maximum: input.totalBytesLimit };
      break;
    }
    if (pageRemaining < 4) break;
    const requestOffset = offset;
    const requestBytes = Math.min(16 * 1024, pageRemaining, totalRemaining);
    const result: RunLogReadResult = await store.read(handle, {
      offset,
      limitBytes: requestBytes,
      signal: input.signal,
    });
    throwIfReadAborted(input.signal);
    const nextOffset = result.nextOffset ?? result.endOffset;
    const returnedBytes = result.endOffset - requestOffset;
    if (!Number.isSafeInteger(result.endOffset) || returnedBytes < 0
      || returnedBytes > requestBytes
      || (!result.eof && (!Number.isSafeInteger(nextOffset) || nextOffset <= requestOffset))) {
      throw new Error("Legacy transcript reader made no progress or exceeded its byte limit");
    }
    readBytes += returnedBytes;
    offset = result.endOffset;

    const combined = lineBuffer + result.content;
    let currentLineStart = lineBuffer ? lineStart : requestOffset;
    const pieces = combined.split("\n");
    for (let index = 0; index < pieces.length - 1 && !stopped; index += 1) {
      const line = pieces[index]!;
      if (!processLogLine(line.endsWith("\r") ? line.slice(0, -1) : line, currentLineStart)) break;
      currentLineStart += Buffer.byteLength(line, "utf8") + 1;
    }
    lineBuffer = pieces.at(-1) ?? "";
    lineStart = currentLineStart;
    if (Buffer.byteLength(lineBuffer, "utf8") > input.itemBytesLimit) {
      limitReached = { reason: "item_bytes", maximum: input.itemBytesLimit };
      stopped = true;
      stopOffset = lineStart;
    }

    if (result.eof && !stopped) {
      eof = true;
      if (lineBuffer) {
        processLogLine(lineBuffer, lineStart);
        lineBuffer = "";
      }
      if (!stopped && stdoutBuffer.trim()) {
        for (const parsed of parser(stdoutBuffer.trim(), stdoutBufferTs)) {
          if (!append(redactTranscriptEntryPaths(parsed, { enabled: false }), stdoutBufferOffset ?? lineStart)) break;
        }
      }
      if (!stopped && pendingDelta) {
        const pending = pendingDelta;
        pendingDelta = null;
        finalize(pending, pending.offset);
      }
      if (stopped) eof = false;
      break;
    }
    if (result.eof) {
      eof = !stopped;
      break;
    }
    if (readBytes >= input.pageBytes) break;
  }

  if (input.totalBytes + readBytes + 4 > input.totalBytesLimit && !eof && !limitReached) {
    limitReached = { reason: "total_bytes", maximum: input.totalBytesLimit };
  }
  let restartOffset = stopOffset;
  if (lineBuffer) restartOffset = restartOffset === null ? lineStart : Math.min(restartOffset, lineStart);
  if (stdoutBuffer) restartOffset = restartOffset === null
    ? stdoutBufferOffset ?? offset
    : Math.min(restartOffset, stdoutBufferOffset ?? offset);
  const pendingAtPageEnd = pendingDelta as LegacyOutputEntry | null;
  if (pendingAtPageEnd) restartOffset = restartOffset === null
    ? pendingAtPageEnd.offset
    : Math.min(restartOffset, pendingAtPageEnd.offset);
  const next = !eof && !limitReached;
  if (next && restartOffset === null) restartOffset = offset;
  const nextOffset = restartOffset ?? offset;
  const nextSkip = next
    ? replayOffsets.filter((sourceOffset) => sourceOffset >= nextOffset).length
    : 0;
  if (next && nextOffset === input.offset && nextSkip === input.skipEntries && readBytes >= input.pageBytes) {
    limitReached = { reason: "page_bytes", maximum: input.pageBytes };
  }
  return {
    entries,
    offset: nextOffset,
    skipEntries: next ? nextSkip : 0,
    readBytes,
    eof,
    next: next && !limitReached,
    limitReached,
  };
}
