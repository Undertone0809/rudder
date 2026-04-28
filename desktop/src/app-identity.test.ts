import { describe, expect, it } from "vitest";
import { defaultDesktopAppName, resolveDesktopAppName } from "./app-identity.js";

describe("desktop app identity", () => {
  it("keeps dev and e2e isolated from the default packaged app name", () => {
    expect(defaultDesktopAppName("dev")).toBe("Rudder-dev");
    expect(defaultDesktopAppName("e2e")).toBe("Rudder-e2e");
    expect(defaultDesktopAppName("prod_local")).toBe("Rudder");
  });

  it("allows smoke and other isolated runs to override the app name explicitly", () => {
    expect(resolveDesktopAppName("prod_local", "Rudder-smoke-4310")).toBe("Rudder-smoke-4310");
  });

  it("ignores blank app-name overrides", () => {
    expect(resolveDesktopAppName("prod_local", "   ")).toBe("Rudder");
  });
});
