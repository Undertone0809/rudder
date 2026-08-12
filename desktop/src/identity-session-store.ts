import type {
  IdentityCredentialVault,
  IdentityCredentialVaultStatus,
  IdentityDeviceCredential,
} from "./identity-credential-vault.js";

export type DesktopIdentitySessionStore = {
  persistence: "secure" | "memory" | "unavailable";
  status(): IdentityCredentialVaultStatus | {
    available: true;
    backend: "memory";
    persistence: "process-only";
    reason: "secure_storage_unavailable" | "insecure_linux_backend";
  };
  read(): IdentityDeviceCredential | null;
  write(credential: IdentityDeviceCredential): void;
  clear(): void;
};

export function desktopIdentityMemoryFallbackAllowed(options: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  storageBackend: string;
}): boolean {
  return !options.isPackaged
    || options.platform === "linux";
}

/**
 * Keeps online sign-in usable when Electron cannot provide a secure store.
 * The fallback deliberately has no filesystem path and therefore cannot
 * survive process restart or qualify for an offline grant.
 */
export function createDesktopIdentitySessionStore(
  vault: Pick<IdentityCredentialVault, "status" | "read" | "write" | "clear">,
  options: { allowMemoryFallback?: boolean } = {},
): DesktopIdentitySessionStore {
  const vaultStatus = vault.status();
  if (vaultStatus.available) {
    return {
      persistence: "secure",
      status: () => vault.status(),
      read: () => vault.read(),
      write: (credential) => vault.write(credential),
      clear: () => vault.clear(),
    };
  }

  if (options.allowMemoryFallback === false) {
    return {
      persistence: "unavailable",
      status: () => vault.status(),
      read: () => vault.status().available ? vault.read() : null,
      write: (credential) => {
        if (!vault.status().available) {
          throw new Error("Secure credential storage is unavailable on this device");
        }
        vault.write(credential);
      },
      clear: () => vault.clear(),
    };
  }

  let credential: IdentityDeviceCredential | null = null;
  const reason = vaultStatus.reason === "insecure_linux_backend"
    ? "insecure_linux_backend"
    : "secure_storage_unavailable";
  return {
    persistence: "memory",
    status: () => ({
      available: true,
      backend: "memory",
      persistence: "process-only",
      reason,
    }),
    read: () => credential,
    write: (next) => {
      credential = structuredClone(next);
    },
    clear: () => {
      credential = null;
      // Clear any old secure credential that may remain after a backend change.
      vault.clear();
    },
  };
}
