import { describe, expect, it } from "vitest";
import { parseGeminiStdoutLine } from "./parse-stdout.js";

describe("parseGeminiStdoutLine", () => {
  it("marks Gemini assistant message deltas so transcript rendering can merge them", () => {
    const line = JSON.stringify({
      type: "message",
      role: "assistant",
      content: "skill** enabled.",
      delta: true,
    });

    expect(parseGeminiStdoutLine(line, "2026-06-02T10:29:40.000Z")).toEqual([
      {
        kind: "assistant",
        ts: "2026-06-02T10:29:40.000Z",
        text: "skill** enabled.",
        delta: true,
      },
    ]);
  });
});
