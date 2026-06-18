import { describe, expect, it } from "vitest";
import { estimateCodexCostUsd, resolveCodexTokenPrice } from "./cost.js";

describe("Codex subscription cost estimator", () => {
  it("uses the GPT-5.5 API-equivalent rate for subscription usage", () => {
    expect(estimateCodexCostUsd("gpt-5.5", {
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      outputTokens: 100_000,
    })).toBeCloseTo(7.1, 6);
  });

  it("keeps Codex-specific model rates distinct from base model rates", () => {
    expect(resolveCodexTokenPrice("gpt-5.5")).toMatchObject({
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
    });
    expect(resolveCodexTokenPrice("gpt-5.5-codex")).toMatchObject({
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
    });
  });

  it("supports provider-prefixed OpenAI model ids", () => {
    expect(estimateCodexCostUsd("openai/gpt-5.1-codex-mini", {
      inputTokens: 1_000_000,
      cachedInputTokens: 100_000,
      outputTokens: 1_000_000,
    })).toBeCloseTo(2.2275, 6);
  });

  it("covers non-Codex OpenAI models that can be selected for Codex runs", () => {
    expect(estimateCodexCostUsd("gpt-4.1", {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 1_000_000,
    })).toBeCloseTo(9.25, 6);

    expect(resolveCodexTokenPrice("o3")).toMatchObject({
      inputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 8,
    });
  });

  it("keeps legacy Codex model aliases priced for existing agent configs", () => {
    expect(estimateCodexCostUsd("gpt-5.3-codex-spark", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 100_000,
    })).toBeCloseTo(3.15, 6);
  });

  it("does not estimate unknown models", () => {
    expect(resolveCodexTokenPrice("gpt-future")).toBeNull();
    expect(estimateCodexCostUsd("gpt-future", {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
    })).toBeNull();
  });
});
