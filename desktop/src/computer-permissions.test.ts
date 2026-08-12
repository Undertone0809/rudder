import { describe, expect, it, vi } from "vitest";
import {
  openComputerUseScreenRecordingSettings,
  readComputerUseReadiness,
  requestComputerUsePermissions,
} from "./computer-permissions.js";

describe("Computer Use platform permission preflight", () => {
  it.each(["win32", "linux"] as const)("treats %s as promptless when the native driver loads", async (platform) => {
    const readiness = await readComputerUseReadiness("0.19.2", {
      platform,
      readModule: async () => ({
        currentMacOsPermissionStatus: () => ({ accessibility: false, screenRecording: false }),
      }),
    });

    expect(readiness).toMatchObject({
      supported: true,
      platform,
      driverAvailable: true,
      actionReady: true,
      permissionPromptAvailable: false,
      screenRecordingSettingsAvailable: false,
      reason: null,
    });
  });

  it("preflights both macOS TCC permissions", async () => {
    const readiness = await readComputerUseReadiness("0.19.2", {
      platform: "darwin",
      readModule: async () => ({
        currentMacOsPermissionStatus: () => ({ accessibility: true, screenRecording: false }),
      }),
    });

    expect(readiness).toMatchObject({
      supported: true,
      platform: "darwin",
      driverAvailable: true,
      accessibility: true,
      screenRecording: false,
      actionReady: false,
      permissionPromptAvailable: true,
      screenRecordingSettingsAvailable: true,
    });
  });

  it("requests macOS permissions before refreshing readiness", async () => {
    const requestMacOSPermissions = vi.fn(() => ({ accessibility: true, screenRecording: true }));
    const readiness = await requestComputerUsePermissions({
      platform: "darwin",
      readElectronModule: async () => ({
        requestMacOSPermissions,
        openMacOSScreenRecordingSettings: vi.fn(),
      }),
      readModule: async () => ({
        currentMacOsPermissionStatus: () => ({ accessibility: true, screenRecording: true }),
      }),
    });

    expect(requestMacOSPermissions).toHaveBeenCalledTimes(1);
    expect(readiness.actionReady).toBe(true);
  });

  it("does not open macOS permission UI on other platforms", async () => {
    const openMacOSScreenRecordingSettings = vi.fn();
    const result = await openComputerUseScreenRecordingSettings({
      platform: "win32",
      readElectronModule: async () => ({
        requestMacOSPermissions: vi.fn(),
        openMacOSScreenRecordingSettings,
      }),
    });

    expect(result).toEqual({ opened: false });
    expect(openMacOSScreenRecordingSettings).not.toHaveBeenCalled();
  });

  it("fails closed when the platform or native driver is unavailable", async () => {
    await expect(readComputerUseReadiness(null, { platform: "aix" })).resolves.toMatchObject({
      supported: false,
      platform: "unsupported",
      actionReady: false,
    });
    await expect(readComputerUseReadiness(null, {
      platform: "linux",
      readModule: async () => { throw new Error("missing native package"); },
    })).resolves.toMatchObject({
      supported: true,
      platform: "linux",
      driverAvailable: false,
      actionReady: false,
    });
  });
});
