import type { TranscriptEntry } from "@/agent-runtimes";
import { describe, expect, it } from "vitest";
import { chatProcessTranscriptEntries } from "./Chat.response-annotation-selection";

const readerEntry: TranscriptEntry = {
  kind: "assistant",
  ts: "2026-09-22T00:00:00.000Z",
  text: "Reader transcript",
};

const legacyEntry: TranscriptEntry = {
  kind: "assistant",
  ts: "2026-09-22T00:00:01.000Z",
  text: "Legacy transcript",
};

describe("chatProcessTranscriptEntries", () => {
  it("uses the Reader map for native Run messages without falling back to message transcript", () => {
    const message = {
      id: "message-native",
      runId: "run-native",
      transcript: [legacyEntry],
    };

    expect(chatProcessTranscriptEntries(
      message,
      { [message.id]: [legacyEntry] },
      new Map([[message.runId, [readerEntry]]]),
    )).toEqual([readerEntry]);
  });

  it("does not expose legacy transcript data while a native Reader result is pending", () => {
    const message = {
      id: "message-native-pending",
      runId: "run-native-pending",
      transcript: [legacyEntry],
    };

    expect(chatProcessTranscriptEntries(
      message,
      { [message.id]: [legacyEntry] },
      new Map(),
    )).toEqual([]);
  });

  it("keeps the legacy message transcript path only for messages without a Run", () => {
    const message = {
      id: "message-legacy",
      runId: null,
      transcript: [legacyEntry],
    };

    expect(chatProcessTranscriptEntries(
      message,
      {},
      new Map(),
    )).toEqual([legacyEntry]);
  });
});
