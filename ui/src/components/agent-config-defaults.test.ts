import { describe, expect, it } from "vitest";
import { AGENT_RUN_CONCURRENCY_DEFAULT } from "@rudderhq/shared";
import { defaultCreateValues } from "./agent-config-defaults";
import { normalizeModelFallbacksForEditor } from "./AgentConfigForm";

describe("agent config defaults", () => {
  it("defaults new agents to three concurrent runs", () => {
    expect(defaultCreateValues.maxConcurrentRuns).toBe(AGENT_RUN_CONCURRENCY_DEFAULT);
    expect(defaultCreateValues.maxConcurrentRuns).toBe(3);
  });

  it("does not configure fallback models unless the operator opts in", () => {
    expect(defaultCreateValues.modelFallbacks).toEqual([]);
  });

  it("keeps same-provider fallback drafts editable even when they temporarily match the primary model", () => {
    expect(
      normalizeModelFallbacksForEditor(
        [{ agentRuntimeType: "codex_local", model: "gpt-5.5" }],
        { agentRuntimeType: "codex_local", model: "gpt-5.5" },
      ),
    ).toEqual([{ agentRuntimeType: "codex_local", model: "gpt-5.5" }]);
  });
});
