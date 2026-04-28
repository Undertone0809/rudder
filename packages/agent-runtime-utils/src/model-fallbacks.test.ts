import { describe, expect, it } from "vitest";
import { buildModelAttemptSpecs, normalizeModelFallbacks } from "./model-fallbacks.js";

describe("model fallback helpers", () => {
  it("normalizes legacy string fallback models against the primary runtime", () => {
    expect(
      normalizeModelFallbacks(
        ["gpt-5.5", " gpt-5.4 ", "", "gpt-5.3", "gpt-5.2"],
        { agentRuntimeType: "codex_local", model: "gpt-5.5" },
      ),
    ).toEqual([
      { agentRuntimeType: "codex_local", model: "gpt-5.4" },
      { agentRuntimeType: "codex_local", model: "gpt-5.3" },
      { agentRuntimeType: "codex_local", model: "gpt-5.2" },
    ]);
  });

  it("normalizes provider-aware fallback entries with per-runtime config", () => {
    expect(
      normalizeModelFallbacks(
        [
          { agentRuntimeType: "codex_local", model: "gpt-5.5" },
          {
            agentRuntimeType: "claude_local",
            model: "claude-sonnet-4-6",
            config: { effort: "high" },
          },
          {
            agentRuntimeType: "opencode_local",
            model: "anthropic/claude-sonnet-4-5",
            command: "opencode",
            modelFallbacks: [{ agentRuntimeType: "codex_local", model: "nested" }],
          },
        ],
        { agentRuntimeType: "codex_local", model: "gpt-5.5" },
      ),
    ).toEqual([
      {
        agentRuntimeType: "claude_local",
        model: "claude-sonnet-4-6",
        config: { effort: "high" },
      },
      {
        agentRuntimeType: "opencode_local",
        model: "anthropic/claude-sonnet-4-5",
        config: { command: "opencode" },
      },
    ]);
  });

  it("builds primary then fallback attempt specs", () => {
    expect(buildModelAttemptSpecs({
      model: "primary",
      modelFallbacks: [
        { agentRuntimeType: "codex_local", model: "backup-1" },
        { agentRuntimeType: "claude_local", model: "backup-2", config: { effort: "medium" } },
      ],
    }, "codex_local")).toEqual([
      {
        index: 0,
        agentRuntimeType: "codex_local",
        model: "primary",
        config: {
          model: "primary",
          modelFallbacks: [
            { agentRuntimeType: "codex_local", model: "backup-1" },
            { agentRuntimeType: "claude_local", model: "backup-2", config: { effort: "medium" } },
          ],
        },
        isFallback: false,
        fallbackIndex: null,
        totalFallbacks: 2,
      },
      {
        index: 1,
        agentRuntimeType: "codex_local",
        model: "backup-1",
        config: null,
        isFallback: true,
        fallbackIndex: 1,
        totalFallbacks: 2,
      },
      {
        index: 2,
        agentRuntimeType: "claude_local",
        model: "backup-2",
        config: { effort: "medium" },
        isFallback: true,
        fallbackIndex: 2,
        totalFallbacks: 2,
      },
    ]);
  });
});
