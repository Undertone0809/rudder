import { describe, expect, it } from "vitest";
import {
  desktopAccountBypassAllowed,
  desktopIdentityProcessMemoryFallbackAllowed,
  desktopStartupRequiresAccount,
  resolveDesktopPackagedSmokeIdentityPolicy,
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

  it("keeps storage-only smoke opt-in separate from the packaged auth bypass", () => {
    const policy = resolveDesktopPackagedSmokeIdentityPolicy({
      isPackaged: true,
      appName: "Rudder-smoke-packaged-4312",
      packagedTestIdentityMarkerValid: true,
      platform: "darwin",
      authBypassRequested: false,
      storageMode: "memory",
      memoryOnlyStorageOptInRequested: true,
    });

    expect(policy).toEqual({
      packagedSmokeBypassRequested: false,
      packagedSmokeMemoryStorageRequested: true,
    });
    expect(desktopStartupRequiresAccount({
      isPackaged: true,
      bypassRequested: true,
      packagedSmokeBypassRequested: policy.packagedSmokeBypassRequested,
      identityStatus: "signed-out",
    })).toBe(true);
  });

  it.each([
    {
      name: "unpackaged app",
      isPackaged: false,
      appName: "Rudder-smoke-packaged-4312",
      packagedTestIdentityMarkerValid: true,
      platform: "darwin" as const,
      storageMode: "memory",
      memoryOnlyStorageOptInRequested: true,
    },
    {
      name: "ordinary packaged app",
      isPackaged: true,
      appName: "Rudder",
      packagedTestIdentityMarkerValid: true,
      platform: "darwin" as const,
      storageMode: "memory",
      memoryOnlyStorageOptInRequested: true,
    },
    {
      name: "packaged app without the marker",
      isPackaged: true,
      appName: "Rudder-smoke-packaged-4312",
      packagedTestIdentityMarkerValid: false,
      platform: "darwin" as const,
      storageMode: "memory",
      memoryOnlyStorageOptInRequested: true,
    },
    {
      name: "non-macOS smoke app",
      isPackaged: true,
      appName: "Rudder-smoke-packaged-4312",
      packagedTestIdentityMarkerValid: true,
      platform: "linux" as const,
      storageMode: "memory",
      memoryOnlyStorageOptInRequested: true,
    },
    {
      name: "missing storage mode",
      isPackaged: true,
      appName: "Rudder-smoke-packaged-4312",
      packagedTestIdentityMarkerValid: true,
      platform: "darwin" as const,
      storageMode: undefined,
      memoryOnlyStorageOptInRequested: true,
    },
    {
      name: "native storage mode",
      isPackaged: true,
      appName: "Rudder-smoke-packaged-4312",
      packagedTestIdentityMarkerValid: true,
      platform: "darwin" as const,
      storageMode: "native",
      memoryOnlyStorageOptInRequested: true,
    },
    {
      name: "missing storage opt-in",
      isPackaged: true,
      appName: "Rudder-smoke-packaged-4312",
      packagedTestIdentityMarkerValid: true,
      platform: "darwin" as const,
      storageMode: "memory",
      memoryOnlyStorageOptInRequested: false,
    },
  ])("does not enable packaged smoke policy for $name", (input) => {
    expect(resolveDesktopPackagedSmokeIdentityPolicy({
      ...input,
      authBypassRequested: false,
    })).toEqual({
      packagedSmokeBypassRequested: false,
      packagedSmokeMemoryStorageRequested: false,
    });
  });

  it("preserves the old marked smoke auth-bypass truth table", () => {
    expect(resolveDesktopPackagedSmokeIdentityPolicy({
      isPackaged: true,
      appName: "Rudder-smoke-packaged-4312",
      packagedTestIdentityMarkerValid: true,
      platform: "linux",
      authBypassRequested: true,
      storageMode: undefined,
      memoryOnlyStorageOptInRequested: false,
    })).toEqual({
      packagedSmokeBypassRequested: true,
      packagedSmokeMemoryStorageRequested: false,
    });
  });

  it("adds packaged process-memory sessions only for the scoped Darwin storage fixture", () => {
    expect(desktopIdentityProcessMemoryFallbackAllowed({
      isPackaged: true,
      platform: "darwin",
      packagedSmokeMemoryStorageRequested: false,
    })).toBe(false);
    expect(desktopIdentityProcessMemoryFallbackAllowed({
      isPackaged: true,
      platform: "darwin",
      packagedSmokeMemoryStorageRequested: true,
    })).toBe(true);
    expect(desktopIdentityProcessMemoryFallbackAllowed({
      isPackaged: true,
      platform: "win32",
      packagedSmokeMemoryStorageRequested: true,
    })).toBe(false);
    expect(desktopIdentityProcessMemoryFallbackAllowed({
      isPackaged: true,
      platform: "linux",
      packagedSmokeMemoryStorageRequested: false,
    })).toBe(true);
    expect(desktopIdentityProcessMemoryFallbackAllowed({
      isPackaged: false,
      platform: "darwin",
      packagedSmokeMemoryStorageRequested: false,
    })).toBe(true);
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
