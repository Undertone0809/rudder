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
 * the unsigned macOS development shell before Rudder creates its first window.
 *
 * Keep the development shell memory-only so local and CI startup do not depend
 * on the operator's login Keychain. Packaged builds must use the platform
 * vault: otherwise a successful Rudder Account sign-in is discarded on every
 * restart. The credential vault still fails closed when Electron reports that
 * encryption is unavailable.
 */
export function resolveDesktopIdentitySafeStorage(options: {
  safeStorage: IdentitySafeStorage;
  isPackaged: boolean;
  platform: NodeJS.Platform;
}): IdentitySafeStorage {
  if (options.platform === "darwin" && !options.isPackaged) {
    return macMemoryOnlyStorage;
  }
  return options.safeStorage;
}
