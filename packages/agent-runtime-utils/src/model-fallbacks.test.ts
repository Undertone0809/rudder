import { describe, expect, it } from "vitest";
import { buildModelAttemptSpecs, normalizeModelFallbacks } from "./model-fallbacks.js";

describe("model fallback helpers", () => {
  it("normalizes fallback models to two unique non-primary entries", () => {
    expect(normalizeModelFallbacks(["gpt-5.5", " gpt-5.4 ", "", "gpt-5.3", "gpt-5.2"], "gpt-5.5"))
      .toEqual(["gpt-5.4", "gpt-5.3"]);
  });

  it("builds primary then fallback attempt specs", () => {
    expect(buildModelAttemptSpecs({
      model: "primary",
      modelFallbacks: ["backup-1", "backup-2"],
    })).toEqual([
      {
        index: 0,
        model: "primary",
        isFallback: false,
        fallbackIndex: null,
        totalFallbacks: 2,
      },
      {
        index: 1,
        model: "backup-1",
        isFallback: true,
        fallbackIndex: 1,
        totalFallbacks: 2,
      },
      {
        index: 2,
        model: "backup-2",
        isFallback: true,
        fallbackIndex: 2,
        totalFallbacks: 2,
      },
    ]);
  });
});
