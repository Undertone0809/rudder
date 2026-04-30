import { describe, expect, it } from "vitest";
import { createVersionedFeedbackMailtoUrl, resolveRudderAppVersion } from "./app-version.js";

describe("resolveRudderAppVersion", () => {
  it("prefers the managed Rudder runtime version over the Electron package version", () => {
    expect(resolveRudderAppVersion({
      serverRuntimeVersion: "0.1.0-canary.27",
      bootRuntimeVersion: "0.1.0",
      desktopAppVersion: "0.1.0",
    })).toBe("0.1.0-canary.27");
  });

  it("uses the boot runtime version while the server handle is not available", () => {
    expect(resolveRudderAppVersion({
      bootRuntimeVersion: "0.1.0-canary.12",
      desktopAppVersion: "0.1.0",
    })).toBe("0.1.0-canary.12");
  });

  it("falls back to the Electron package version", () => {
    expect(resolveRudderAppVersion({
      desktopAppVersion: "0.1.0-canary.3",
    })).toBe("0.1.0-canary.3");
  });
});

describe("createVersionedFeedbackMailtoUrl", () => {
  it("includes the resolved Rudder version in the feedback subject", () => {
    expect(createVersionedFeedbackMailtoUrl({
      email: "feedback@example.com",
      version: "0.1.0-canary.27",
    })).toBe("mailto:feedback@example.com?subject=Rudder+feedback+%280.1.0-canary.27%29");
  });
});
