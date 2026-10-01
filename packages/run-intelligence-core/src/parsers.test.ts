import { describe, expect, it } from "vitest";
import { getHistoricalTranscriptParser, getTranscriptParser } from "./parsers.js";

describe("transcript parsers", () => {
  it("decodes removed Gemini CLI records only on history-reading paths", () => {
    const ts = "2026-09-30T00:00:00.000Z";
    const line = JSON.stringify({ type: "thinking", text: "Inspecting the request" });

    expect(getTranscriptParser("gemini_local")(line, ts)).toEqual([
      { kind: "stdout", ts, text: line },
    ]);
    expect(getHistoricalTranscriptParser("gemini_local")(line, ts)).toEqual([
      { kind: "thinking", ts, text: "Inspecting the request" },
    ]);
    expect(getHistoricalTranscriptParser("gemini_local")(
      JSON.stringify({ type: "user", message: "secret legacy user input" }),
      ts,
    )).toEqual([]);
    expect(getHistoricalTranscriptParser("gemini_local")(
      JSON.stringify({ type: "message", role: "user", content: "secret message input" }),
      ts,
    )).toEqual([]);
    expect(getHistoricalTranscriptParser("openclaw_gateway")).toBe(getTranscriptParser("openclaw_gateway"));
  });
});
