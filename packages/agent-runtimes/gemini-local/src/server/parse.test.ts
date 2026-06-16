import { describe, expect, it } from "vitest";
import { parseGeminiJsonl } from "./parse.js";

describe("parseGeminiJsonl", () => {
  it("parses current Gemini CLI assistant message events", () => {
    const parsed = parseGeminiJsonl([
      JSON.stringify({ type: "init", session_id: "session-1" }),
      JSON.stringify({ type: "message", role: "assistant", content: "hello", delta: true }),
      JSON.stringify({ type: "result", status: "success" }),
    ].join("\n"));

    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.summary).toBe("hello");
  });
});
