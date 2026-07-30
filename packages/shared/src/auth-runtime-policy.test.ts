import { describe, expect, it } from "vitest";
import {
  authRequirementForDeploymentMode,
  localRuntimeTrustForDeploymentMode,
} from "./constants.js";

describe("auth and local runtime policy compatibility", () => {
  it("preserves legacy deployment-mode defaults", () => {
    expect(authRequirementForDeploymentMode("local_trusted")).toBe("optional");
    expect(localRuntimeTrustForDeploymentMode("local_trusted")).toBe("trusted");
    expect(authRequirementForDeploymentMode("authenticated")).toBe("required");
    expect(localRuntimeTrustForDeploymentMode("authenticated")).toBe("untrusted");
  });
});
