import { describe, expect, it } from "vitest";
import { defaultCommandForRuntime, defaultConfigForRuntime } from "./AgentConfigForm.helpers";

describe("AgentConfigForm runtime defaults", () => {
  it("uses cursor-agent for new Cursor agents", () => {
    expect(defaultCommandForRuntime("cursor")).toBe("cursor-agent");
    expect(defaultConfigForRuntime("cursor")).toMatchObject({
      command: "cursor-agent",
    });
  });
});
