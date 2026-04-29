import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { appendWithCap, MAX_EXCERPT_BYTES } from "../../agent-runtimes/utils.js";

export function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

export function appendTranscriptEntriesFromChunk(input: {
  buffer: string;
  chunk: string;
  transcript: TranscriptEntry[];
  parser?: ((line: string, ts: string) => TranscriptEntry[]) | null;
  finalize?: boolean;
  kind: "stdout" | "stderr";
}) {
  const combined = `${input.buffer}${input.chunk}`;
  const lines = combined.split(/\r?\n/);
  const trailing = lines.pop() ?? "";
  const completeLines = input.finalize && trailing ? [...lines, trailing] : lines;
  for (const line of completeLines) {
    if (!line.trim()) continue;
    const ts = new Date().toISOString();
    const parsed = input.parser ? input.parser(line, ts) : [];
    if (parsed.length > 0) {
      input.transcript.push(...parsed);
    } else {
      input.transcript.push({
        ts,
        kind: input.kind,
        text: line,
      });
    }
  }
  return input.finalize ? "" : trailing;
}
