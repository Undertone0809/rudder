import { describe, expect, it } from "vitest";
import {
  desktopAccountBypassAllowed,
  desktopStartupRequiresAccount,
} from "./identity-startup-policy.js";

describe("Desktop account startup policy", () => {
  it("never permits the development bypass in a stable packaged build", () => {
    expect(desktopAccountBypassAllowed({
      isPackaged: true,
      bypassRequested: true,
    })).toBe(false);
    expect(desktopStartupRequiresAccount({
      isPackaged: true,
      bypassRequested: true,
      identityStatus: "signed-out",
    })).toBe(true);
  });

  it("permits only the explicitly marked packaged smoke bypass", () => {
    expect(desktopAccountBypassAllowed({
      isPackaged: true,
      bypassRequested: false,
      packagedSmokeBypassRequested: true,
    })).toBe(true);
    expect(desktopStartupRequiresAccount({
      isPackaged: true,
      bypassRequested: false,
      packagedSmokeBypassRequested: true,
      identityStatus: "signed-out",
    })).toBe(false);
  });

  it("gates signed-out startup and permits signed-in startup", () => {
    expect(desktopStartupRequiresAccount({
      isPackaged: false,
      bypassRequested: false,
      identityStatus: "signed-out",
    })).toBe(true);
    expect(desktopStartupRequiresAccount({
      isPackaged: true,
      bypassRequested: false,
      identityStatus: "signed-in",
    })).toBe(false);
  });

  it("allows only an explicit development bypass fixture", () => {
    expect(desktopStartupRequiresAccount({
      isPackaged: false,
      bypassRequested: true,
      identityStatus: "signed-out",
    })).toBe(false);
  });
});
