import { describe, expect, it } from "vitest";
import { DEFAULT_CODEX_LOCAL_MODEL } from "@rudderhq/agent-runtime-codex-local";
import { resolveRuntimeModels } from "./runtime-models";

describe("resolveRuntimeModels", () => {
  it("includes codex fallback models when discovery is empty", () => {
    const models = resolveRuntimeModels("codex_local");

    expect(models.some((model) => model.id === DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
    expect(models.some((model) => model.id === "gpt-5.5")).toBe(true);
    expect(models.some((model) => model.id === "gpt-5.4")).toBe(true);
  });

  it("keeps discovered models ahead of fallback duplicates", () => {
    const models = resolveRuntimeModels("codex_local", [
      { id: DEFAULT_CODEX_LOCAL_MODEL, label: "Custom Codex Default" },
      { id: "gpt-5-pro", label: "gpt-5-pro" },
    ]);

    expect(models.find((model) => model.id === DEFAULT_CODEX_LOCAL_MODEL)?.label).toBe(
      "Custom Codex Default",
    );
    expect(models.filter((model) => model.id === DEFAULT_CODEX_LOCAL_MODEL)).toHaveLength(1);
    expect(models.some((model) => model.id === "gpt-5-pro")).toBe(true);
  });

  it("does not add fallback models for runtimes without them", () => {
    expect(resolveRuntimeModels("opencode_local")).toEqual([]);
  });
});
