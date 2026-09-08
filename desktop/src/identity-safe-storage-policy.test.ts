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
  it("keeps the unsigned macOS development shell memory-only", () => {
    const nativeStorage = poisonSafeStorage();
    const selectedStorage = resolveDesktopIdentitySafeStorage({
      safeStorage: nativeStorage,
      isPackaged: false,
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
  });

  it.each([
    { isPackaged: true, platform: "darwin" as const },
    { isPackaged: true, platform: "linux" as const },
    { isPackaged: true, platform: "win32" as const },
  ])("preserves native secure storage for packaged apps (%o)", (input) => {
    const nativeStorage = poisonSafeStorage();
    expect(resolveDesktopIdentitySafeStorage({
      safeStorage: nativeStorage,
      ...input,
    })).toBe(nativeStorage);
  });

  it("keeps a marker-gated packaged macOS smoke memory-only", () => {
    const nativeStorage = poisonSafeStorage();
    const selectedStorage = resolveDesktopIdentitySafeStorage({
      safeStorage: nativeStorage,
      isPackaged: true,
      platform: "darwin",
      packagedSmokeBypassRequested: true,
    });

    expect(identityCredentialVaultStatus(selectedStorage, "darwin")).toEqual({
      available: false,
      backend: "mac_memory_only",
      reason: "encryption_unavailable",
    });
    expect(nativeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(nativeStorage.getSelectedStorageBackend).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)(
    "does not weaken packaged smoke storage on %s",
    (platform) => {
      const nativeStorage = poisonSafeStorage();
      expect(resolveDesktopIdentitySafeStorage({
        safeStorage: nativeStorage,
        isPackaged: true,
        platform,
        packagedSmokeBypassRequested: true,
      })).toBe(nativeStorage);
    },
  );
});
