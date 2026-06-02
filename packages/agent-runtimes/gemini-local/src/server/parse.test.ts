import { describe, expect, it } from "vitest";
import { parseGeminiJsonl } from "./parse.js";

describe("parseGeminiJsonl", () => {
  it("merges Gemini assistant deltas without adding markdown-breaking newlines", () => {
    const stdout = [
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "I have **conversation-to-",
        delta: true,
      }),
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "skill** enabled.",
        delta: true,
      }),
      JSON.stringify({
        type: "result",
        status: "success",
      }),
    ].join("\n");

    expect(parseGeminiJsonl(stdout).summary).toBe("I have **conversation-to-skill** enabled.");
  });
});
