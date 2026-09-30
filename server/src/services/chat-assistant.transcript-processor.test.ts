import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import { createRudderInlineVisualStreamSuppressor } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  createAssistantTextAccumulator,
  createSentinelStream,
} from "./chat-assistant.helpers.js";
import { createChatAssistantTranscriptProcessor } from "./chat-assistant.transcript-processor.js";

describe("chat assistant transcript processor", () => {
  it("preserves assistant phases and item boundaries on projected deltas", async () => {
    const emitted: TranscriptEntry[] = [];
    const delivery = {
      source: "native" as const,
      persistRaw: false,
      runId: "run-1",
      spanId: "span-1",
    };
    const processor = createChatAssistantTranscriptProcessor({
      callbacks: {
        onTranscriptEntry: async (entry) => { emitted.push(entry); },
      },
      isInactive: () => false,
      appendTranscriptEntry: async () => undefined,
      resultSentinel: "__RUDDER_RESULT_TEST__",
      transcriptDelivery: delivery,
      assistantTextAccumulator: createAssistantTextAccumulator(),
      finalAssistantTextAccumulator: createAssistantTextAccumulator(),
      sentinelStream: createSentinelStream("__RUDDER_RESULT_TEST__"),
      inlineVisualStream: createRudderInlineVisualStreamSuppressor(),
      commentaryInlineVisualStream: createRudderInlineVisualStreamSuppressor(),
      durableTranscriptImages: new Map(),
      state: { hasNativeFinalMessage: false, hasRuntimeOutputEvidence: false },
    });

    await processor.processTranscriptEntries([
      { kind: "assistant", ts: "2026-09-29T00:00:00.000Z", text: "Commentary.\n", delta: true, phase: "commentary", segmentId: "commentary-1" },
      { kind: "assistant", ts: "2026-09-29T00:00:01.000Z", text: "Unphased process text.\n", delta: true, segmentId: "unphased-1" },
      { kind: "assistant", ts: "2026-09-29T00:00:02.000Z", text: "Final answer.\n", delta: true, phase: "final_answer", segmentId: "final-1" },
    ]);

    expect(emitted.filter((entry) => entry.kind === "assistant").map((entry) => (
      entry.kind === "assistant" ? { text: entry.text, phase: entry.phase, segmentId: entry.segmentId } : null
    ))).toEqual([
      { text: "Commentary.\n", phase: "commentary", segmentId: "commentary-1" },
      { text: "Unphased process text.\n", phase: undefined, segmentId: "unphased-1" },
      { text: "Final answer.\n", phase: "final_answer", segmentId: "final-1" },
    ]);
  });
});
