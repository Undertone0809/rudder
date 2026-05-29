import { describe, expect, it } from "vitest";
import { detectClaudeLoginRequired, parseClaudeStreamJson } from "./parse.js";

describe("parseClaudeStreamJson", () => {
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
