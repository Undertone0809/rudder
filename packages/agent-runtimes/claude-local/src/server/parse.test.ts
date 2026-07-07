import { describe, expect, it } from "vitest";
import { detectClaudeLoginRequired, parseClaudeStreamJson } from "./parse.js";

describe("parseClaudeStreamJson", () => {
  it("does not promote incomplete assistant text to a final summary", () => {
    const parsed = parseClaudeStreamJson([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session-1",
        model: "claude-opus",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Partial progress before stop." }],
        },
      }),
    ].join("\n"));

    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.model).toBe("claude-opus");
    expect(parsed.summary).toBe("");
  });

  it("does not promote incomplete thinking blocks to a final summary", () => {
    const parsed = parseClaudeStreamJson([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "Internal reasoning before stop." }],
        },
      }),
    ].join("\n"));

    expect(parsed.summary).toBe("");
  });

  it("uses completed assistant text when the terminal result text is empty", () => {
    const parsed = parseClaudeStreamJson([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Completed visible answer." }],
        },
      }),
      JSON.stringify({
        type: "result",
        session_id: "session-1",
        result: "",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }),
    ].join("\n"));

    expect(parsed.summary).toBe("Completed visible answer.");
  });

  it("includes Claude cache creation tokens in cached input totals", () => {
    const parsed = parseClaudeStreamJson([
      JSON.stringify({
        type: "result",
        session_id: "session-1",
        usage: {
          input_tokens: 1_000,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 250,
          output_tokens: 25,
        },
        total_cost_usd: 0.01,
        result: "done",
      }),
    ].join("\n"));

    expect(parsed.usage).toMatchObject({
      inputTokens: 1_000,
      cachedInputTokens: 750,
      outputTokens: 25,
    });
  });
});

describe("detectClaudeLoginRequired", () => {
  it("detects Claude Code slash-command login prompts", () => {
    const detected = detectClaudeLoginRequired({
      parsed: null,
      stdout: "",
      stderr: "Not logged in · Please run /login",
    });

    expect(detected.requiresLogin).toBe(true);
  });

  it("detects current Claude auth login prompts", () => {
    const detected = detectClaudeLoginRequired({
      parsed: null,
      stdout: "",
      stderr: "Authentication required. Please run claude auth login.",
    });

    expect(detected.requiresLogin).toBe(true);
  });
});
