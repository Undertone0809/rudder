import { describe, expect, it } from "vitest";
import { parseGeminiJsonl } from "@rudderhq/agent-runtime-gemini-local/server";
import { parseGeminiStdoutLine } from "@rudderhq/agent-runtime-gemini-local/ui";
import { buildTranscript, parseNdjsonLog } from "./transcript.js";

describe("Gemini transcript parsing", () => {
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

  it("preserves Gemini delta boundaries when building transcript entries from run logs", () => {
    const log = [
      {
        ts: "2026-06-02T10:29:40.000Z",
        stream: "stdout",
        chunk: `${JSON.stringify({ type: "message", role: "assistant", content: "I have **conversation-to-", delta: true })}\n`,
      },
      {
        ts: "2026-06-02T10:29:41.000Z",
        stream: "stdout",
        chunk: `${JSON.stringify({ type: "message", role: "assistant", content: "skill** enabled.", delta: true })}\n`,
      },
    ].map((entry) => JSON.stringify(entry)).join("\n");

    expect(buildTranscript(parseNdjsonLog(log), parseGeminiStdoutLine)).toEqual([
      {
        kind: "assistant",
        ts: "2026-06-02T10:29:41.000Z",
        text: "I have **conversation-to-skill** enabled.",
        delta: true,
      },
    ]);
  });
});
