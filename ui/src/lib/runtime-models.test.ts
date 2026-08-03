import { DEFAULT_CODEX_LOCAL_MODEL, models as codexLocalModels } from "@rudderhq/agent-runtime-codex-local";
import { describe, expect, it } from "vitest";
import { resolveRuntimeModels } from "./runtime-models";

describe("resolveRuntimeModels", () => {
  it("includes codex fallback models when discovery is empty", () => {
    const models = resolveRuntimeModels("codex_local");

    expect(models).toEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6-sol" },
      { id: "gpt-5.6-terra", label: "GPT-5.6-terra" },
      { id: "gpt-5.6-luna", label: "GPT-5.6-luna" },
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "gpt-5.4", label: "GPT-5.4" },
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
      { id: "gpt-5.2", label: "GPT-5.2" },
    ]);
    expect(models.some((model) => model.id === DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
    expect(models.map((model) => model.id)).toEqual(codexLocalModels.map((model) => model.id));
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

  it("uses the model id when an adapter omits its label", () => {
    expect(resolveRuntimeModels("opencode_local", [{ id: "openai/gpt-5.4" } as never])).toEqual([
      { id: "openai/gpt-5.4", label: "openai/gpt-5.4" },
    ]);
  });

  it("does not add fallback models for runtimes without them", () => {
    expect(resolveRuntimeModels("opencode_local")).toEqual([]);
  });
});
