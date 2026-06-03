import { describe, expect, it } from "vitest";
import { DEFAULT_CURSOR_LOCAL_COMMAND } from "@rudderhq/agent-runtime-cursor-local";
import { defaultCommandForRuntime, defaultModelForRuntime } from "./AgentConfigForm.helpers";

describe("AgentConfigForm runtime defaults", () => {
  it("uses Cursor Agent CLI as the Cursor runtime command", () => {
    expect(defaultCommandForRuntime("cursor")).toBe(DEFAULT_CURSOR_LOCAL_COMMAND);
    expect(defaultCommandForRuntime("cursor")).toBe("cursor-agent");
  });

  it("defaults Pi agents to a configurable DeepSeek model", () => {
    expect(defaultModelForRuntime("pi_local")).toBe("deepseek/deepseek-v4-flash");
  });
});
