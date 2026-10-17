import type { IdentitySafeStorage } from "./identity-credential-vault.js";

const macMemoryOnlyStorage: IdentitySafeStorage = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => "mac_memory_only",
  encryptString: () => {
    throw new Error("macOS secure credential persistence is disabled");
  },
  decryptString: () => {
    throw new Error("macOS secure credential persistence is disabled");
  },
};

/**
 * Electron safeStorage can synchronously open a blocking Keychain NSAlert in
 * an unsigned macOS development shell before Rudder creates its first window.
 *
 * Keep the development shell memory-only so local and CI startup do not depend
 * on the operator's login Keychain. A marked packaged smoke may also opt into
 * memory-only storage for a local account-gate fixture because ad-hoc test
 * bundles can block on a Keychain prompt before their first window. Native
 * packaged smoke remains the default.
 * Production packaged builds must use the platform vault; otherwise a successful
 * Rudder Account sign-in is discarded on every restart. The credential vault
 * still fails closed when Electron reports that encryption is unavailable.
 */
export function resolveDesktopIdentitySafeStorage(options: {
  safeStorage: IdentitySafeStorage;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  packagedSmokeBypassRequested?: boolean;
  packagedSmokeMemoryStorageRequested?: boolean;
}): IdentitySafeStorage {
  if (
    options.platform === "darwin"
    && (
      !options.isPackaged
      || options.packagedSmokeBypassRequested === true
      || options.packagedSmokeMemoryStorageRequested === true
    )
  ) {
    return macMemoryOnlyStorage;
  }
  return options.safeStorage;
}
