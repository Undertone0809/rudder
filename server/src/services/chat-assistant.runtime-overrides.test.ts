import { describe, expect, it } from "vitest";
import { applyChatRuntimeOverrides } from "./chat-assistant.runtime-overrides.js";

describe("chat assistant runtime overrides", () => {
  it("rejects the legacy Light label for Codex CLI reasoning", () => {
    const result = applyChatRuntimeOverrides(
      "codex_local",
      {
        model: "gpt-5.6-sol",
        modelReasoningEffort: "light",
        reasoningEffort: "light",
      },
      "gpt-5.6-sol",
      undefined,
    );

    expect(result).not.toHaveProperty("modelReasoningEffort");
    expect(result).not.toHaveProperty("reasoningEffort");
  });

  it("keeps official Codex CLI reasoning levels for the selected model", () => {
    const result = applyChatRuntimeOverrides(
      "codex_local",
      { model: "gpt-5.6-sol" },
      "gpt-5.6-sol",
      "low",
    );

    expect(result).toMatchObject({
      model: "gpt-5.6-sol",
      modelReasoningEffort: "low",
    });
  });

  it("clears unsupported Claude and Pi effort values before runtime execution", () => {
    expect(applyChatRuntimeOverrides(
      "claude_local",
      { model: "claude-haiku-4-6", effort: "high" },
      "claude-haiku-4-6",
      undefined,
    )).not.toHaveProperty("effort");

    expect(applyChatRuntimeOverrides(
      "pi_local",
      { model: "kimi-coding/kimi-for-coding", thinking: "invalid" },
      "kimi-coding/kimi-for-coding",
      undefined,
    )).not.toHaveProperty("thinking");

    expect(applyChatRuntimeOverrides(
      "pi_local",
      { model: "kimi-coding/kimi-for-coding", thinking: "high" },
      "kimi-coding/kimi-for-coding",
      undefined,
      [{ id: "kimi-coding/kimi-for-coding", label: "Kimi for Coding", capabilities: { reasoning: true } }],
    )).not.toHaveProperty("thinking");

    expect(applyChatRuntimeOverrides(
      "pi_local",
      { model: "kimi-coding/kimi-for-coding", thinking: "high" },
      "kimi-coding/kimi-for-coding",
      undefined,
    )).toMatchObject({ thinking: "high" });

    expect(applyChatRuntimeOverrides(
      "opencode_local",
      { model: "openai/gpt-5.6-luna", variant: "max" },
      "openai/gpt-5.6-luna",
      undefined,
    )).toMatchObject({ variant: "max" });

    expect(applyChatRuntimeOverrides(
      "pi_local",
      { model: "kimi-coding/kimi-for-coding", thinking: "invalid" },
      "kimi-coding/kimi-for-coding",
      undefined,
    )).not.toHaveProperty("thinking");
  });

  it("uses the discovered model catalog for OpenCode, Pi, and Cursor overrides", () => {
    expect(applyChatRuntimeOverrides(
      "codex_local",
      { model: "gpt-5.6-sol", modelReasoningEffort: "high" },
      "gpt-5.6-sol",
      undefined,
      [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol", variants: ["low", "medium"] }],
    )).not.toHaveProperty("modelReasoningEffort");

    expect(applyChatRuntimeOverrides(
      "opencode_local",
      { model: "opencode/model-a", variant: "max" },
      "opencode/model-a",
      undefined,
      [{ id: "opencode/model-a", label: "Model A", variants: ["low", "medium"] }],
    )).not.toHaveProperty("variant");

    expect(applyChatRuntimeOverrides(
      "pi_local",
      { model: "openai/gpt-5.6-luna", thinking: "xhigh" },
      "openai/gpt-5.6-luna",
      undefined,
      [{ id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", variants: ["off", "minimal", "low", "medium", "high", "xhigh"] }],
    )).toMatchObject({ thinking: "xhigh" });

    expect(applyChatRuntimeOverrides(
      "cursor",
      { model: "gpt-5.3-codex", effort: "high" },
      "gpt-5.3-codex",
      undefined,
      [{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex", variants: ["low", "high"] }],
    )).toMatchObject({ effort: "high" });

    expect(applyChatRuntimeOverrides(
      "cursor",
      { model: "gpt-5.3-codex", mode: "plan", effort: "high" },
      "gpt-5.3-codex",
      undefined,
      [{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex", variants: ["low", "high"] }],
    )).toMatchObject({ mode: "plan", effort: "high" });

    expect(applyChatRuntimeOverrides(
      "opencode_local",
      { model: "opencode/unknown", variant: "max" },
      "opencode/unknown",
      undefined,
      [{ id: "opencode/known", label: "Known", variants: ["low", "medium"] }],
    )).not.toHaveProperty("variant");
  });
});
