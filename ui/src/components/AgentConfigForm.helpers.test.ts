import { describe, expect, it } from "vitest";
import { defaultCommandForRuntime, defaultConfigForRuntime, defaultModelForRuntime } from "./AgentConfigForm.helpers";

describe("AgentConfigForm runtime defaults", () => {
  it("uses cursor-agent for new Cursor agents", () => {
    expect(defaultCommandForRuntime("cursor")).toBe("cursor-agent");
    expect(defaultConfigForRuntime("cursor")).toMatchObject({
      command: "cursor-agent",
    });
  });

  it("uses locally runnable default models for OpenCode and Pi", () => {
    expect(defaultModelForRuntime("opencode_local")).toBe("opencode/deepseek-v4-flash-free");
    expect(defaultConfigForRuntime("opencode_local")).toMatchObject({
      model: "opencode/deepseek-v4-flash-free",
    });

    expect(defaultModelForRuntime("pi_local")).toBe("kimi-coding/kimi-for-coding");
    expect(defaultConfigForRuntime("pi_local")).toMatchObject({
      model: "kimi-coding/kimi-for-coding",
    });
  });
});
