import { describe, expect, it } from "vitest";
import {
  CODEX_LOCAL_REASONING_EFFORT_OPTIONS,
  piLocalThinkingEffortOptionsForModel,
  withDefaultThinkingEffortOption,
} from "./runtime-thinking-effort";

describe("runtime thinking effort options", () => {
  it("uses Codex reasoning effort levels supported by Codex", () => {
    expect(CODEX_LOCAL_REASONING_EFFORT_OPTIONS).toEqual([
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "Extra High" },
    ]);
  });

  it("prepends a caller-provided default label without mutating the base options", () => {
    const withDefault = withDefaultThinkingEffortOption("Default", CODEX_LOCAL_REASONING_EFFORT_OPTIONS);
    const withAuto = withDefaultThinkingEffortOption("Auto", CODEX_LOCAL_REASONING_EFFORT_OPTIONS);

    expect(withDefault[0]).toEqual({ value: "", label: "Default" });
    expect(withAuto[0]).toEqual({ value: "", label: "Auto" });
    expect(withDefault.slice(1)).toEqual(CODEX_LOCAL_REASONING_EFFORT_OPTIONS);
    expect(withAuto.slice(1)).toEqual(CODEX_LOCAL_REASONING_EFFORT_OPTIONS);
  });

  it("uses Pi's default model map and hides thinking for non-reasoning models", () => {
    expect(piLocalThinkingEffortOptionsForModel("openai/model", {
      capabilities: { reasoning: true },
    }).map((option) => option.value)).toEqual(["", "off", "minimal", "low", "medium", "high"]);
    expect(piLocalThinkingEffortOptionsForModel("openai/model", {
      variants: ["off"],
      capabilities: { reasoning: false },
    })).toEqual([]);
  });
});
