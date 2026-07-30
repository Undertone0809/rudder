import { describe, expect, it, vi } from "vitest";
import { identityCredentialVaultStatus } from "./identity-credential-vault.js";
import { resolveDesktopIdentitySafeStorage } from "./identity-safe-storage-policy.js";

function poisonSafeStorage() {
  return {
    isEncryptionAvailable: vi.fn(() => {
      throw new Error("native safeStorage probe must not run");
    }),
    getSelectedStorageBackend: vi.fn(() => {
      throw new Error("native safeStorage backend probe must not run");
    }),
    encryptString: vi.fn(() => {
      throw new Error("native safeStorage encryption must not run");
    }),
    decryptString: vi.fn(() => {
      throw new Error("native safeStorage decryption must not run");
    }),
  };
}

describe("Desktop Identity safe storage policy", () => {
  it.each([false, true])(
    "never touches native safeStorage on macOS (isPackaged=%s)",
    (isPackaged) => {
    const nativeStorage = poisonSafeStorage();
    const selectedStorage = resolveDesktopIdentitySafeStorage({
      safeStorage: nativeStorage,
      isPackaged,
      platform: "darwin",
    });

    expect(identityCredentialVaultStatus(selectedStorage, "darwin")).toEqual({
      available: false,
      backend: "mac_memory_only",
      reason: "encryption_unavailable",
    });
    expect(nativeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(nativeStorage.getSelectedStorageBackend).not.toHaveBeenCalled();
    expect(nativeStorage.encryptString).not.toHaveBeenCalled();
    expect(nativeStorage.decryptString).not.toHaveBeenCalled();
    },
  );

  it.each([
    { isPackaged: true, platform: "linux" as const },
    { isPackaged: true, platform: "win32" as const },
  ])("preserves native secure storage outside packaged macOS (%o)", (input) => {
    const nativeStorage = poisonSafeStorage();
    expect(resolveDesktopIdentitySafeStorage({
      safeStorage: nativeStorage,
      ...input,
    })).toBe(nativeStorage);
  });
});
