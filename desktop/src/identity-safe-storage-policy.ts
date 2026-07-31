import type { IdentitySafeStorage } from "./identity-credential-vault.js";

const macMemoryOnlyStorage: IdentitySafeStorage = {
  isEncryptionAvailable: () => false,
  getSelectedStorageBackend: () => "mac_memory_only",
  encryptString: () => {
    throw new Error("Packaged macOS secure credential persistence is disabled");
  },
  decryptString: () => {
    throw new Error("Packaged macOS secure credential persistence is disabled");
  },
};

/**
 * Electron safeStorage can synchronously open a blocking Keychain NSAlert in
 * the unsigned development shell before Rudder creates its first window.
 *
 * Keep only the development shell memory-only so local and CI startup remains
 * independent of the operator's unlocked login Keychain. Packaged builds must
 * use the platform vault: otherwise a successful Rudder Account sign-in is
 * discarded on restart and the release cannot provide a durable device
 * session. The credential vault still fails closed when Electron reports that
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
