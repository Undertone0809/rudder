import { describe, expect, it } from "vitest";
import {
  isDesktopSystemPermissionId,
  resolveAccessibilityStatus,
  resolveAutomationStatus,
  resolveDesktopSystemPermissions,
  resolveFullDiskAccessStatus,
  resolveSystemPermissionSettingsUrl,
} from "./system-permissions.js";

describe("system permission status", () => {
  it("reports full disk access as authorized when a protected probe is readable", () => {
    expect(
      resolveFullDiskAccessStatus({
        platform: "darwin",
        homeDir: "/Users/example",
        access: () => undefined,
      }),
    ).toBe("authorized");
  });

  it("reports full disk access as needing access when a protected probe is denied", () => {
    expect(
      resolveFullDiskAccessStatus({
        platform: "darwin",
        homeDir: "/Users/example",
        access: () => {
          const error = new Error("denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        },
      }),
    ).toBe("needs_access");
  });

  it("keeps full disk access unknown when no probe target exists", () => {
    expect(
      resolveFullDiskAccessStatus({
        platform: "darwin",
        homeDir: "/Users/example",
        access: () => {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
      }),
    ).toBe("unknown");
  });

  it("uses the macOS accessibility trust result without prompting", () => {
    expect(resolveAccessibilityStatus({ platform: "darwin", isTrusted: () => true })).toBe("authorized");
    expect(resolveAccessibilityStatus({ platform: "darwin", isTrusted: () => false })).toBe("needs_access");
  });

  it("marks automation as a per-app macOS permission", () => {
    expect(resolveAutomationStatus({ platform: "darwin" })).toBe("per_app");
  });

  it("resolves only the known macOS permission settings targets", () => {
    expect(isDesktopSystemPermissionId("fullDiskAccess")).toBe(true);
    expect(isDesktopSystemPermissionId("unknown")).toBe(false);
    expect(resolveSystemPermissionSettingsUrl({ platform: "darwin", permission: "fullDiskAccess" }))
      .toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
    expect(resolveSystemPermissionSettingsUrl({ platform: "darwin", permission: "accessibility" }))
      .toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    expect(resolveSystemPermissionSettingsUrl({ platform: "darwin", permission: "automation" }))
      .toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Automation");
  });

  it("does not expose macOS permission settings targets on other platforms", () => {
    expect(resolveSystemPermissionSettingsUrl({ platform: "win32", permission: "fullDiskAccess" })).toBeNull();
  });

  it("returns unsupported statuses outside macOS", () => {
    expect(
      resolveDesktopSystemPermissions({
        platform: "linux",
      }),
    ).toEqual({
      fullDiskAccess: "unsupported",
      accessibility: "unsupported",
      automation: "unsupported",
    });
  });
});
