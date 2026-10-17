export type DesktopPackagedSmokeIdentityPolicyOptions = {
  isPackaged: boolean;
  appName: string;
  packagedTestIdentityMarkerValid: boolean;
  platform: NodeJS.Platform;
  authBypassRequested: boolean;
  storageMode: string | undefined;
  memoryOnlyStorageOptInRequested: boolean;
};

export type DesktopPackagedSmokeIdentityPolicy = {
  packagedSmokeBypassRequested: boolean;
  packagedSmokeMemoryStorageRequested: boolean;
};

export function resolveDesktopPackagedSmokeIdentityPolicy(
  options: DesktopPackagedSmokeIdentityPolicyOptions,
): DesktopPackagedSmokeIdentityPolicy {
  const markedPackagedSmoke = options.isPackaged
    && options.appName.startsWith("Rudder-smoke-")
    && options.packagedTestIdentityMarkerValid;

  return {
    // Keep the existing auth bypass contract independent from storage mode.
    packagedSmokeBypassRequested: markedPackagedSmoke && options.authBypassRequested,
    packagedSmokeMemoryStorageRequested: markedPackagedSmoke
      && options.platform === "darwin"
      && options.storageMode === "memory"
      && options.memoryOnlyStorageOptInRequested,
  };
}

export function desktopIdentityProcessMemoryFallbackAllowed(options: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  packagedSmokeMemoryStorageRequested: boolean;
}): boolean {
  return !options.isPackaged
    || options.platform === "linux"
    || (
      options.isPackaged
      && options.platform === "darwin"
      && options.packagedSmokeMemoryStorageRequested
    );
}

export function desktopAccountBypassAllowed(options: {
  isPackaged: boolean;
  bypassRequested: boolean;
  packagedSmokeBypassRequested?: boolean;
}): boolean {
  return (!options.isPackaged && options.bypassRequested)
    || (options.isPackaged && options.packagedSmokeBypassRequested === true);
}

export function desktopStartupRequiresAccount(options: {
  isPackaged: boolean;
  bypassRequested: boolean;
  packagedSmokeBypassRequested?: boolean;
  identityStatus: "signed-out" | "signing-in" | "device-authorization" | "signed-in" | "error";
}): boolean {
  return !desktopAccountBypassAllowed(options) && options.identityStatus !== "signed-in";
}
