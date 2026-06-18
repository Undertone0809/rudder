import { DEFAULT_CODEX_LOCAL_MODEL, models as codexLocalModels } from "@rudderhq/agent-runtime-codex-local";
import { describe, expect, it } from "vitest";
import { resolveRuntimeModels } from "./runtime-models";

describe("resolveRuntimeModels", () => {
  it("includes codex fallback models when discovery is empty", () => {
    const models = resolveRuntimeModels("codex_local");

    expect(models).toEqual(codexLocalModels);
    expect(models[0]?.id).toBe(DEFAULT_CODEX_LOCAL_MODEL);
    expect(models.map((model) => model.id)).toEqual(codexLocalModels.map((model) => model.id));
    expect(models.some((model) => model.id === "gpt-5.5-codex")).toBe(true);
    expect(models.some((model) => model.id === "codex-mini-latest")).toBe(true);
    expect(models.some((model) => model.id === "gpt-5")).toBe(false);
    expect(models.some((model) => model.id === "o3")).toBe(false);
  });

  it("ignores discovered codex models so the menu stays aligned with Codex", () => {
    const models = resolveRuntimeModels("codex_local", [
      { id: DEFAULT_CODEX_LOCAL_MODEL, label: "Custom Codex Default" },
      { id: "gpt-5-pro", label: "gpt-5-pro" },
    ]);

    expect(models).toEqual(codexLocalModels);
    expect(models.filter((model) => model.id === DEFAULT_CODEX_LOCAL_MODEL)).toHaveLength(1);
    expect(models.some((model) => model.id === "gpt-5-pro")).toBe(false);
  });

  it("does not add fallback models for runtimes without them", () => {
    expect(resolveRuntimeModels("opencode_local")).toEqual([]);
  });
});
