import { DEFAULT_CODEX_LOCAL_MODEL, models as codexLocalModels } from "@rudderhq/agent-runtime-codex-local";
import { describe, expect, it } from "vitest";
import { resolveRuntimeModels } from "./runtime-models";

describe("resolveRuntimeModels", () => {
  it("includes codex fallback models when discovery is empty", () => {
    const models = resolveRuntimeModels("codex_local");

    expect(models).toEqual(codexLocalModels);
    expect(models.some((model) => model.id === DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
    expect(models.map((model) => model.id)).toEqual(codexLocalModels.map((model) => model.id));
  });

  it("prefers the official Codex catalog over static fallback models", () => {
    const models = resolveRuntimeModels("codex_local", [
      { id: DEFAULT_CODEX_LOCAL_MODEL, label: "Official Codex Default", variants: ["low"] },
      { id: "codex-auto-review", label: "Codex Auto Review", variants: ["low", "high"] },
    ]);

    expect(models[0]).toEqual({
      id: DEFAULT_CODEX_LOCAL_MODEL,
      label: "Official Codex Default",
      variants: ["low"],
    });
    expect(models.filter((model) => model.id === DEFAULT_CODEX_LOCAL_MODEL)).toHaveLength(1);
    expect(models.some((model) => model.id === "codex-auto-review")).toBe(true);
    expect(models.map((model) => model.id)).toContain("gpt-5.5");
  });

  it("uses the model id when an adapter omits its label", () => {
    expect(resolveRuntimeModels("opencode_local", [{ id: "openai/gpt-5.4" } as never])).toEqual([
      { id: "openai/gpt-5.4", label: "openai/gpt-5.4" },
    ]);
  });

  it("preserves runtime-discovered model variants", () => {
    expect(resolveRuntimeModels("opencode_local", [
      {
        id: "opencode/deepseek-v4-flash-free",
        label: "DeepSeek V4 Flash Free",
        variants: ["low", "medium", "low", "  "],
      },
    ])).toEqual([
      {
        id: "opencode/deepseek-v4-flash-free",
        label: "DeepSeek V4 Flash Free",
        variants: ["low", "medium"],
      },
    ]);
  });

  it("does not add fallback models for runtimes without them", () => {
    expect(resolveRuntimeModels("opencode_local")).toEqual([]);
  });
});
