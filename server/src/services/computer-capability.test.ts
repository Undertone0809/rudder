import { describe, expect, it } from "vitest";
import { resolveComputerUseCapability } from "./computer-capability.js";

describe("Computer Use capability", () => {
  it("projects only for enabled local Desktop-backed codex_local Runs", () => {
    expect(resolveComputerUseCapability({
      deploymentMode: "local_trusted",
      enabled: true,
      desktopReady: true,
      agentRuntimeType: "codex_local",
    })).toEqual({ instanceEligible: true, runtimeSupported: true, runEligible: true });

    for (const override of [
      { enabled: false },
      { desktopReady: false },
      { deploymentMode: "authenticated" as const },
      { agentRuntimeType: "claude_local" },
    ]) {
      expect(resolveComputerUseCapability({
        deploymentMode: "local_trusted",
        enabled: true,
        desktopReady: true,
        agentRuntimeType: "codex_local",
        ...override,
      }).runEligible).toBe(false);
    }
  });
});
