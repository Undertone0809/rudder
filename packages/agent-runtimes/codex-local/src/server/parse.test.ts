import { describe, expect, it } from "vitest";
import { parseCodexJsonl } from "./parse.js";

describe("parseCodexJsonl", () => {
  it("does not promote incomplete assistant progress to a final summary", () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Partial progress before stop." } }),
    ].join("\n"));

    expect(parsed.sessionId).toBe("thread-123");
    expect(parsed.summary).toBe("");
  });

  it("does not promote incomplete reasoning to a final summary", () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Internal reasoning before stop." } }),
    ].join("\n"));

    expect(parsed.summary).toBe("");
  });

  it("uses completed assistant messages as the final summary", () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final visible answer." } }),
      JSON.stringify({
        type: "turn.completed",
        result: "Final visible answer.",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
    ].join("\n"));

    expect(parsed.summary).toBe("Final visible answer.");
  });
});
