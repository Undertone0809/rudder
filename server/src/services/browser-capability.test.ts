import { describe, expect, it } from "vitest";
import { resolveBrowserCapability } from "./browser-capability.js";

describe("resolveBrowserCapability", () => {
  it("keeps legacy deployment-mode behavior when trust is omitted", () => {
    expect(resolveBrowserCapability({
      deploymentMode: "local_trusted",
      browserEnabled: true,
      agentRuntimeType: "codex_local",
    }).runEligible).toBe(true);
    expect(resolveBrowserCapability({
      deploymentMode: "authenticated",
      browserEnabled: true,
      agentRuntimeType: "codex_local",
    }).runEligible).toBe(false);
  });

  it("allows authenticated data access and trusted local runtime capability to vary independently", () => {
    expect(resolveBrowserCapability({
      deploymentMode: "authenticated",
      localRuntimeTrust: "trusted",
      browserEnabled: true,
      agentRuntimeType: "codex_local",
    }).runEligible).toBe(true);
  });
});
