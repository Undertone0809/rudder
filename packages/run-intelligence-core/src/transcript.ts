import { redactHomePathUserSegments, redactTranscriptEntryPaths, type StdoutLineParser, type TranscriptEntry } from "@rudder/agent-runtime-utils";
import type { RunLogChunk } from "./types.js";

export function buildTranscript(
  chunks: RunLogChunk[],
  parser: StdoutLineParser,
  opts?: { censorUsernameInLogs?: boolean },
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let stdoutBuffer = "";
  const redactionOptions = { enabled: opts?.censorUsernameInLogs ?? false };

  const appendEntry = (entry: TranscriptEntry) => {
    if ((entry.kind === "thinking" || entry.kind === "assistant") && entry.delta) {
      const last = entries[entries.length - 1];
      if (last && last.kind === entry.kind && last.delta) {
        last.text += entry.text;
        last.ts = entry.ts;
        return;
      }
    }
    entries.push(entry);
  };

  for (const chunk of chunks) {
    if (chunk.stream === "stderr") {
      appendEntry({ kind: "stderr", ts: chunk.ts, text: redactHomePathUserSegments(chunk.chunk, redactionOptions) });
      continue;
    }
    if (chunk.stream === "system") {
      appendEntry({ kind: "system", ts: chunk.ts, text: redactHomePathUserSegments(chunk.chunk, redactionOptions) });
      continue;
    }

    const combined = stdoutBuffer + chunk.chunk;
    const lines = combined.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      for (const entry of parser(trimmed, chunk.ts)) {
        appendEntry(redactTranscriptEntryPaths(entry, redactionOptions));
      }
    }
  }

  const trailing = stdoutBuffer.trim();
  if (trailing) {
    const ts = chunks.length > 0 ? chunks[chunks.length - 1]!.ts : new Date().toISOString();
    for (const entry of parser(trailing, ts)) {
      appendEntry(redactTranscriptEntryPaths(entry, redactionOptions));
    }
  }

  return entries;
}

export function parseNdjsonLog(content: string | null | undefined): RunLogChunk[] {
  if (!content) return [];
  const chunks: RunLogChunk[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
      const ts = typeof parsed.ts === "string" ? parsed.ts : new Date().toISOString();
      const stream = parsed.stream === "stderr" || parsed.stream === "system" ? parsed.stream : "stdout";
      const chunk = typeof parsed.chunk === "string" ? parsed.chunk : "";
      if (!chunk) continue;
      chunks.push({ ts, stream, chunk });
    } catch {
      continue;
    }
  }
  return chunks;
}
