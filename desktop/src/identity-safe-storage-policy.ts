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
 * an unsigned macOS build before Rudder creates its first window.
 *
 * The current macOS artifacts are not Developer ID signed, so they cannot
 * safely promise durable Keychain-backed identity credentials. Keep all
 * current macOS shells memory-only until signed-build capability is wired into
 * the release pipeline. The credential vault still fails closed when Electron
 * reports that encryption is unavailable on other platforms.
 */
export function resolveDesktopIdentitySafeStorage(options: {
  safeStorage: IdentitySafeStorage;
  isPackaged: boolean;
  platform: NodeJS.Platform;
}): IdentitySafeStorage {
  if (options.platform === "darwin") {
    return macMemoryOnlyStorage;
  }
  return options.safeStorage;
}
