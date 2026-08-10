import type { DesktopComputerReadiness } from "./computer-broker-registration.js";

type CuaPermissionModule = {
  currentMacOsPermissionStatus(): { accessibility: boolean; screenRecording: boolean };
};

type CuaElectronPermissionModule = {
  requestMacOSPermissions(): { accessibility: boolean; screenRecording: boolean };
  openMacOSScreenRecordingSettings(): Promise<void>;
};

async function readModule(): Promise<CuaPermissionModule> {
  return await import("@trycua/cua-driver") as unknown as CuaPermissionModule;
}

export async function readComputerUseReadiness(driverVersion: string | null = null): Promise<DesktopComputerReadiness> {
  if (process.platform !== "darwin") {
    return {
      supported: false,
      accessibility: false,
      screenRecording: false,
      actionReady: false,
      driverVersion,
      reason: "Computer Use is initially available only on macOS Rudder Desktop.",
    };
  }
  try {
    const status = (await readModule()).currentMacOsPermissionStatus();
    const actionReady = status.accessibility && status.screenRecording;
    return {
      supported: true,
      accessibility: status.accessibility,
      screenRecording: status.screenRecording,
      actionReady,
      driverVersion,
      reason: actionReady ? null : "Accessibility and Screen Recording access are required.",
    };
  } catch {
    return {
      supported: true,
      accessibility: false,
      screenRecording: false,
      actionReady: false,
      driverVersion,
      reason: "The bundled Computer Use driver is unavailable.",
    };
  }
}

export async function requestComputerUsePermissions() {
  if (process.platform !== "darwin") return readComputerUseReadiness();
  const module = await import("@trycua/cua-driver/electron") as unknown as CuaElectronPermissionModule;
  module.requestMacOSPermissions();
  return readComputerUseReadiness();
}

export async function openComputerUseScreenRecordingSettings() {
  if (process.platform !== "darwin") return { opened: false };
  const module = await import("@trycua/cua-driver/electron") as unknown as CuaElectronPermissionModule;
  await module.openMacOSScreenRecordingSettings();
  return { opened: true };
}
