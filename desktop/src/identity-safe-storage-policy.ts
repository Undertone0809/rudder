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
 * Current macOS artifacts are intentionally built without a Developer ID.
 * Electron safeStorage can synchronously open a blocking Keychain NSAlert in
 * those ad-hoc signed bundles before Rudder creates its first window.
 *
 * Keep macOS fail-closed in both development and packaged validation: online
 * sessions remain process-only and no credential or Offline Grant is written
 * to disk. This also keeps local and CI verification independent of the
 * operator's unlocked login Keychain. When signing and notarization are
 * enabled, replace this with an immutable signed-build capability verified by
 * the release workflow.
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
