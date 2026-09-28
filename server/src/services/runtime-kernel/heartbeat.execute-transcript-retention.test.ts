import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { describe, expect, it } from "vitest";
import { createHeartbeatExecutionTranscriptAppender } from "./heartbeat.execute-transcript-retention.js";

describe("heartbeat execution transcript appender", () => {
  it("forwards parsed chunks and finalized tails to the native supplement", async () => {
    const transcript: TranscriptEntry[] = [];
    const supplemented: TranscriptEntry[][] = [];
    const stdoutBuffer = { pending: "", droppingOverlongLine: false };
    const stderrBuffer = { pending: "", droppingOverlongLine: false };
    const appendSupplement = async (entries: readonly TranscriptEntry[]) => { supplemented.push([...entries]); };
    const supplement = {
      append: appendSupplement,
      finalize: async (entries: TranscriptEntry[], finalizeTranscript: () => Promise<void>) => {
        const transcriptStart = entries.length;
        await finalizeTranscript();
        await appendSupplement(entries.slice(transcriptStart));
      },
    };
    const appender = createHeartbeatExecutionTranscriptAppender({
      transcript,
      stdoutBuffer,
      stderrBuffer,
      stdoutParser: () => (line, ts) => [{ kind: "assistant", ts, text: line }],
      persistRawTranscript: () => true,
      supplement,
    });

    await appender.appendChunk("stdout", "assistant: complete\nassistant: tail");
    await appender.appendChunk("stderr", "warning\n");
    await appender.finalize();

    expect(transcript.map((entry) => ({
      kind: entry.kind,
      text: "text" in entry ? entry.text : undefined,
    }))).toEqual([
      { kind: "assistant", text: "assistant: complete" },
      { kind: "stderr", text: "warning" },
      { kind: "assistant", text: "assistant: tail" },
    ]);
    expect(supplemented).toEqual([
      [expect.objectContaining({ kind: "assistant", text: "assistant: complete" })],
      [expect.objectContaining({ kind: "stderr", text: "warning" })],
      [expect.objectContaining({ kind: "assistant", text: "assistant: tail" })],
    ]);
  });
});
