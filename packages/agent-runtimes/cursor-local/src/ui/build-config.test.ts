import { describe, expect, it } from "vitest";
import { buildCursorLocalConfig } from "./build-config.js";

describe("buildCursorLocalConfig", () => {
  it("keeps Cursor's execution mode independent from model effort", () => {
    const config = buildCursorLocalConfig({
      agentRuntimeType: "cursor",
      cwd: "",
      promptTemplate: "",
      model: "gpt-5.3-codex",
      modelFallbacks: [],
      thinkingEffort: "high",
      mode: "plan",
      chrome: false,
      dangerouslySkipPermissions: false,
      search: false,
      dangerouslyBypassSandbox: false,
      command: "cursor-agent",
      args: "",
      extraArgs: "",
      envVars: "",
      envBindings: {},
      url: "",
      bootstrapPrompt: "",
      maxTurnsPerRun: 300,
      heartbeatEnabled: false,
      intervalSec: 300,
      preflightEnabled: true,
      maxConcurrentRuns: 1,
    });

    expect(config).toMatchObject({
      model: "gpt-5.3-codex",
      effort: "high",
      mode: "plan",
    });
  });
});
