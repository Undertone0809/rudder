import { describe, expect, it } from "vitest";
import { summarizeTokenUsage, tokenUsageCacheRatio } from "./token-usage.js";

describe("token usage helpers", () => {
  it("treats OpenAI/Codex cached input as a subset of total input tokens", () => {
    const summary = summarizeTokenUsage({
      provider: "openai",
      inputTokens: 498_406,
      cachedInputTokens: 457_856,
      outputTokens: 6_588,
    });

    expect(summary).toMatchObject({
      inputTokens: 498_406,
      cachedInputTokens: 457_856,
      outputTokens: 6_588,
      uncachedInputTokens: 40_550,
      promptTokens: 498_406,
      totalTokens: 504_994,
    });
    expect(tokenUsageCacheRatio(summary)).toBeCloseTo(0.9186, 4);
  });

  it("treats Claude cached input as additive even when cached is below input", () => {
    const summary = summarizeTokenUsage({
      provider: "anthropic",
      inputTokens: 1_000,
      cachedInputTokens: 500,
      outputTokens: 25,
    });

    expect(summary).toMatchObject({
      inputTokens: 1_000,
      cachedInputTokens: 500,
      outputTokens: 25,
      uncachedInputTokens: 1_000,
      promptTokens: 1_500,
      totalTokens: 1_525,
    });
    expect(tokenUsageCacheRatio(summary)).toBeCloseTo(1 / 3, 4);
  });

  it("treats Gemini cached content as included in prompt tokens", () => {
    const summary = summarizeTokenUsage({
      provider: "google",
      inputTokens: 1_000,
      cachedInputTokens: 300,
      outputTokens: 50,
    });

    expect(summary).toMatchObject({
      uncachedInputTokens: 700,
      promptTokens: 1_000,
      totalTokens: 1_050,
    });
    expect(tokenUsageCacheRatio(summary)).toBeCloseTo(0.3, 4);
  });

  it("allows callers to pass explicit additive semantics", () => {
    const summary = summarizeTokenUsage({
      cachedInputTokenSemantics: "additional_to_input",
      inputTokens: 100,
      cachedInputTokens: 250,
      outputTokens: 25,
    });

    expect(summary.promptTokens).toBe(350);
    expect(summary.totalTokens).toBe(375);
  });
});
