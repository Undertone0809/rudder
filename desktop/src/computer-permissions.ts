import type {
  DesktopComputerPlatform,
  DesktopComputerReadiness,
} from "./computer-broker-registration.js";

type CuaPermissionModule = {
  currentMacOsPermissionStatus(): { accessibility: boolean; screenRecording: boolean };
};

type CuaElectronPermissionModule = {
  requestMacOSPermissions(): { accessibility: boolean; screenRecording: boolean };
  openMacOSScreenRecordingSettings(): Promise<void>;
};

type ComputerPermissionDependencies = {
  platform?: NodeJS.Platform;
  readModule?: () => Promise<CuaPermissionModule>;
  readElectronModule?: () => Promise<CuaElectronPermissionModule>;
};

async function readModule(): Promise<CuaPermissionModule> {
  return await import("@trycua/cua-driver") as unknown as CuaPermissionModule;
}

async function readElectronModule(): Promise<CuaElectronPermissionModule> {
  return await import("@trycua/cua-driver/electron") as unknown as CuaElectronPermissionModule;
}

function computerPlatform(platform: NodeJS.Platform): DesktopComputerPlatform {
  return platform === "darwin" || platform === "win32" || platform === "linux"
    ? platform
    : "unsupported";
}

function unavailableReadiness(
  platform: DesktopComputerPlatform,
  driverVersion: string | null,
  reason: string,
): DesktopComputerReadiness {
  return {
    supported: platform !== "unsupported",
    platform,
    driverAvailable: false,
    accessibility: false,
    screenRecording: false,
    actionReady: false,
    permissionPromptAvailable: false,
    screenRecordingSettingsAvailable: false,
    driverVersion,
    reason,
  };
}

export async function readComputerUseReadiness(
  driverVersion: string | null = null,
  dependencies: ComputerPermissionDependencies = {},
): Promise<DesktopComputerReadiness> {
  const platform = computerPlatform(dependencies.platform ?? process.platform);
  if (platform === "unsupported") {
    return {
      supported: false,
      platform,
      driverAvailable: false,
      accessibility: false,
      screenRecording: false,
      actionReady: false,
      permissionPromptAvailable: false,
      screenRecordingSettingsAvailable: false,
      driverVersion,
      reason: "Computer Use requires Rudder Desktop on macOS, Windows, or Linux.",
    };
  }
  try {
    const module = await (dependencies.readModule ?? readModule)();
    if (platform !== "darwin") {
      return {
        supported: true,
        platform,
        driverAvailable: true,
        accessibility: true,
        screenRecording: true,
        actionReady: true,
        permissionPromptAvailable: false,
        screenRecordingSettingsAvailable: false,
        driverVersion,
        reason: null,
      };
    }
    const status = module.currentMacOsPermissionStatus();
    const actionReady = status.accessibility && status.screenRecording;
    return {
      supported: true,
      platform,
      driverAvailable: true,
      accessibility: status.accessibility,
      screenRecording: status.screenRecording,
      actionReady,
      permissionPromptAvailable: true,
      screenRecordingSettingsAvailable: !status.screenRecording,
      driverVersion,
      reason: actionReady ? null : "Accessibility and Screen Recording access are required.",
    };
  } catch {
    return unavailableReadiness(platform, driverVersion, "The bundled Computer Use driver is unavailable.");
  }
}

export async function requestComputerUsePermissions(dependencies: ComputerPermissionDependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") return readComputerUseReadiness(null, dependencies);
  const module = await (dependencies.readElectronModule ?? readElectronModule)();
  module.requestMacOSPermissions();
  return readComputerUseReadiness(null, dependencies);
}

export async function openComputerUseScreenRecordingSettings(dependencies: ComputerPermissionDependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== "darwin") return { opened: false };
  const module = await (dependencies.readElectronModule ?? readElectronModule)();
  await module.openMacOSScreenRecordingSettings();
  return { opened: true };
}
