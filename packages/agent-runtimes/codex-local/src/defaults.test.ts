import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_REASONING_EFFORT,
  resolveCodexLocalModel,
  resolveCodexLocalReasoningEffort,
  withCodexLocalModelDefaults,
} from "./defaults.js";

describe("Codex local defaults", () => {
  it("uses Luna Medium when model and effort are omitted", () => {
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6-luna");
    expect(DEFAULT_CODEX_LOCAL_REASONING_EFFORT).toBe("medium");
    expect(resolveCodexLocalModel({})).toBe("gpt-5.6-luna");
    expect(resolveCodexLocalReasoningEffort({})).toBe("medium");
  });

  it("preserves explicit model and effort overrides", () => {
    expect(resolveCodexLocalModel({ model: "gpt-5.6-sol" })).toBe("gpt-5.6-sol");
    expect(resolveCodexLocalReasoningEffort({ modelReasoningEffort: "high" })).toBe("high");
    expect(resolveCodexLocalReasoningEffort({ reasoningEffort: "low" })).toBe("low");
  });
});

describe("Codex creation model defaults", () => {
  it("fills blank settings without changing the input or unrelated controls", () => {
    const source = { model: "  ", reasoningEffort: "", search: false, env: { KEY: "value" } };
    expect(withCodexLocalModelDefaults(source)).toEqual({
      ...source,
      model: "gpt-5.6-luna",
      modelReasoningEffort: "medium",
    });
    expect(source.model).toBe("  ");
    expect(source).not.toHaveProperty("modelReasoningEffort");
  });

  it.each([
    { model: "gpt-5.6-sol", modelReasoningEffort: "ultra" },
    { model: "gpt-5.5", reasoningEffort: "high" },
  ])("preserves explicit model/effort settings: %j", (config) => {
    expect(withCodexLocalModelDefaults(config)).toEqual(config);
  });
});
