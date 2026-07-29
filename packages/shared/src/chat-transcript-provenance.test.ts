import { describe, expect, it } from "vitest";
import {
  coalesceChatTranscriptTextEntries,
  withChatTranscriptGenerationProvenance,
} from "./chat-transcript-provenance.js";

describe("chat transcript generation provenance", () => {
  it("coalesces adjacent deltas while preserving the inclusive generation sequence range", () => {
    const generationId = "10000000-0000-4000-8000-000000000001";
    const first = withChatTranscriptGenerationProvenance(
      { kind: "thinking", ts: "2026-07-23T10:00:00.000Z", text: "Inspect ", delta: true },
      { generationId, generationSeq: 7 },
    );
    const second = withChatTranscriptGenerationProvenance(
      { kind: "thinking", ts: "2026-07-23T10:00:01.000Z", text: "the source.", delta: true },
      { generationId, generationSeq: 8 },
    );

    expect(coalesceChatTranscriptTextEntries([first, second])).toEqual([{
      kind: "thinking",
      ts: "2026-07-23T10:00:01.000Z",
      text: "Inspect the source.",
      delta: true,
      generationId,
      generationSeqStart: 7,
      generationSeqEnd: 8,
    }]);
  });

  it("keeps lifecycle boundaries, sequence gaps, and different generations separate", () => {
    const firstGenerationId = "10000000-0000-4000-8000-000000000001";
    const secondGenerationId = "10000000-0000-4000-8000-000000000002";
    const entries = [
      withChatTranscriptGenerationProvenance(
        { kind: "assistant", ts: "2026-07-23T10:00:00.000Z", text: "First", delta: true },
        { generationId: firstGenerationId, generationSeq: 2 },
      ),
      { kind: "system" as const, ts: "2026-07-23T10:00:01.000Z", text: "reasoning completed" },
      withChatTranscriptGenerationProvenance(
        { kind: "assistant", ts: "2026-07-23T10:00:02.000Z", text: "Second", delta: true },
        { generationId: firstGenerationId, generationSeq: 4 },
      ),
      withChatTranscriptGenerationProvenance(
        { kind: "assistant", ts: "2026-07-23T10:00:03.000Z", text: "Third", delta: true },
        { generationId: secondGenerationId, generationSeq: 5 },
      ),
    ];

    expect(coalesceChatTranscriptTextEntries(entries)).toEqual(entries);
  });

  it("uses a provider segment to merge unprovenanced chunks without crossing item boundaries", () => {
    const entries = [
      {
        kind: "assistant" as const,
        ts: "2026-07-27T10:00:00.000Z",
        text: "先检查 `rudder",
        delta: true,
        phase: "commentary" as const,
        segmentId: "commentary-1",
      },
      {
        kind: "assistant" as const,
        ts: "2026-07-27T10:00:01.000Z",
        text: "-docs`，再继续。",
        delta: true,
        phase: "commentary" as const,
        segmentId: "commentary-1",
      },
      {
        kind: "assistant" as const,
        ts: "2026-07-27T10:00:02.000Z",
        text: "这是另一条进度。",
        delta: true,
        phase: "commentary" as const,
        segmentId: "commentary-2",
      },
    ];

    expect(coalesceChatTranscriptTextEntries(entries)).toEqual([
      {
        kind: "assistant",
        ts: "2026-07-27T10:00:01.000Z",
        text: "先检查 `rudder-docs`，再继续。",
        delta: true,
        phase: "commentary",
        segmentId: "commentary-1",
      },
      entries[2],
    ]);
  });

  it("does not hide a generation gap even when the provider segment is stable", () => {
    const generationId = "10000000-0000-4000-8000-000000000001";
    const first = withChatTranscriptGenerationProvenance(
      {
        kind: "assistant",
        ts: "2026-07-27T10:00:00.000Z",
        text: "先检查 ",
        delta: true,
        segmentId: "commentary-1",
      },
      { generationId, generationSeq: 2 },
    );
    const second = withChatTranscriptGenerationProvenance(
      {
        kind: "assistant",
        ts: "2026-07-27T10:00:01.000Z",
        text: "实现。",
        delta: true,
        segmentId: "commentary-1",
      },
      { generationId, generationSeq: 4 },
    );

    expect(coalesceChatTranscriptTextEntries([first, second])).toEqual([first, second]);
  });
});
