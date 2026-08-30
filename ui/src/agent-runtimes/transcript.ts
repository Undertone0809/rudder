import { redactHomePathUserSegments, redactTranscriptEntryPaths } from "@rudderhq/agent-runtime-utils";
import type { StdoutLineParser, TranscriptEntry } from "./types";

type StreamingTextEntry = Extract<TranscriptEntry, { kind: "assistant" | "thinking" }> & {
  streamStartTs?: string;
};

function streamStartTs(entry: TranscriptEntry): string | undefined {
  const candidate = (entry as StreamingTextEntry).streamStartTs?.trim();
  return candidate || undefined;
}

export type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string };
export type TranscriptBuildOptions = { censorUsernameInLogs?: boolean };
export type TranscriptLogBuildState = { stdoutBuffer: string; lastStdoutTs: string | null };

export function appendTranscriptEntry(entries: TranscriptEntry[], entry: TranscriptEntry) {
  if ((entry.kind === "thinking" || entry.kind === "assistant") && entry.delta) {
    const lastIndex = entries.length - 1;
    const last = entries[lastIndex];
    const phasesAreCompatible = (
      last?.kind !== "assistant"
      || entry.kind !== "assistant"
      || last.phase === undefined
      || entry.phase === undefined
      || last.phase === entry.phase
    );
    const segmentsAreCompatible = last
      && (last.kind === "thinking" || last.kind === "assistant")
      && (last.segmentId || entry.segmentId)
      ? Boolean(last.segmentId && entry.segmentId && last.segmentId === entry.segmentId)
      : true;
    if (
      last
      && last.kind === entry.kind
      && last.delta
      && phasesAreCompatible
      && segmentsAreCompatible
    ) {
      entries[lastIndex] = {
        ...last,
        text: last.text + entry.text,
        ts: entry.ts,
        ...((last.kind === "assistant" || last.kind === "thinking")
          ? { streamStartTs: streamStartTs(last) ?? last.ts }
          : {}),
        ...(last.kind === "assistant" && entry.kind === "assistant" && (last.phase ?? entry.phase)
          ? { phase: last.phase ?? entry.phase }
          : {}),
      };
      return;
    }
  }
  entries.push(entry);
}

export function appendTranscriptEntries(entries: TranscriptEntry[], incoming: TranscriptEntry[]) {
  for (const entry of incoming) {
    appendTranscriptEntry(entries, entry);
  }
}

export function createTranscriptLogBuildState(): TranscriptLogBuildState {
  return { stdoutBuffer: "", lastStdoutTs: null };
}

export function appendRunLogChunkToTranscript(
  entries: TranscriptEntry[],
  state: TranscriptLogBuildState,
  chunk: RunLogChunk,
  parser: StdoutLineParser,
  opts?: TranscriptBuildOptions,
) {
  const redactionOptions = { enabled: opts?.censorUsernameInLogs ?? false };

  if (chunk.stream === "stderr") {
    entries.push({ kind: "stderr", ts: chunk.ts, text: redactHomePathUserSegments(chunk.chunk, redactionOptions) });
    return;
  }
  if (chunk.stream === "system") {
    entries.push({ kind: "system", ts: chunk.ts, text: redactHomePathUserSegments(chunk.chunk, redactionOptions) });
    return;
  }

  state.lastStdoutTs = chunk.ts;
  const combined = state.stdoutBuffer + chunk.chunk;
  const lines = combined.split(/\r?\n/);
  state.stdoutBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    appendTranscriptEntries(entries, parser(trimmed, chunk.ts).map((entry) => redactTranscriptEntryPaths(entry, redactionOptions)));
  }
}

export function flushTranscriptLogBuffer(
  entries: TranscriptEntry[],
  state: TranscriptLogBuildState,
  parser: StdoutLineParser,
  opts?: TranscriptBuildOptions,
) {
  const trailing = state.stdoutBuffer.trim();
  if (!trailing) return;

  const redactionOptions = { enabled: opts?.censorUsernameInLogs ?? false };
  appendTranscriptEntries(
    entries,
    parser(trailing, state.lastStdoutTs ?? new Date().toISOString()).map((entry) =>
      redactTranscriptEntryPaths(entry, redactionOptions),
    ),
  );
  state.stdoutBuffer = "";
}

export function buildTranscript(
  chunks: RunLogChunk[],
  parser: StdoutLineParser,
  opts?: TranscriptBuildOptions,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const state = createTranscriptLogBuildState();

  for (const chunk of chunks) {
    appendRunLogChunkToTranscript(entries, state, chunk, parser, opts);
  }
  flushTranscriptLogBuffer(entries, state, parser, opts);

  return entries;
}
