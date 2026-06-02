import { describe, expect, it } from "vitest";
import { AGENT_RUN_CONCURRENCY_DEFAULT } from "@rudderhq/shared";
import { defaultCreateValues } from "./agent-config-defaults";
import {
  filterRuntimeEnvironmentDisplayChecks,
  normalizeModelFallbacksForEditor,
  normalizeRuntimeEnvironmentDisplayStatus,
} from "./AgentConfigForm";

describe("agent config defaults", () => {
  it("defaults new agents to three concurrent runs", () => {
    expect(defaultCreateValues.maxConcurrentRuns).toBe(AGENT_RUN_CONCURRENCY_DEFAULT);
    expect(defaultCreateValues.maxConcurrentRuns).toBe(3);
  });

  it("defaults timer heartbeat preflight on for new agents", () => {
    expect(defaultCreateValues.preflightEnabled).toBe(true);
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

  it("suppresses warning-only environment results in the display layer", () => {
    expect(normalizeRuntimeEnvironmentDisplayStatus("warn")).toBe("pass");
    expect(
      filterRuntimeEnvironmentDisplayChecks({
        checks: [
          { code: "info_check", level: "info", message: "Looks fine" },
          { code: "warn_check", level: "warn", message: "Auth is optional" },
        ],
      }),
    ).toEqual([]);
  });

  it("keeps error environment results visible in the display layer", () => {
    const checks = filterRuntimeEnvironmentDisplayChecks({
      checks: [
        { code: "warn_check", level: "warn", message: "Auth is optional" },
        { code: "error_check", level: "error", message: "Command failed" },
      ],
    });

    expect(normalizeRuntimeEnvironmentDisplayStatus("fail")).toBe("fail");
    expect(checks).toEqual([
      { code: "error_check", level: "error", message: "Command failed" },
    ]);
  });

  it("classifies local setup failures separately from runtime failures", () => {
    const result = {
      checks: [
        { code: "opencode_command_resolvable", level: "info" as const, message: "Command exists" },
        { code: "opencode_model_invalid", level: "error" as const, message: "Model unavailable" },
        { code: "opencode_hello_probe_auth_required", level: "warn" as const, message: "Auth required" },
      ],
    };

    expect(normalizeRuntimeEnvironmentDisplayStatus("fail", result)).toBe("setup");
    expect(filterRuntimeEnvironmentDisplayChecks(result, { includeWarnings: true })).toEqual([
      { code: "opencode_model_invalid", level: "error", message: "Model unavailable" },
      { code: "opencode_hello_probe_auth_required", level: "warn", message: "Auth required" },
    ]);
  });
});
