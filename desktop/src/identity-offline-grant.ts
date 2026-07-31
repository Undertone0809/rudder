import {
  generateOfflineDeviceKeyPair,
  offlineDevicePublicKeyThumbprint,
  verifyOfflineGrant,
} from "@rudderhq/identity-core";
import { createPublicKey } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  identityCredentialVaultStatus,
  type IdentitySafeStorage,
} from "./identity-credential-vault.js";

const MAX_OFFLINE_STATE_BYTES = 64 * 1024;

export type DesktopOfflineGrantCredential = {
  version: 1;
  issuer: string;
  accountId: string;
  deviceId: string;
  installationId: string;
  grant: string;
  expiresAtMs: number;
  keyId: string;
  identityPublicKeySpki: string;
  devicePrivateKeyPkcs8: string;
  devicePublicKeySpki: string;
  trustedTimeMs: number;
  localSignOutEpoch: number;
};

type OfflineState = {
  version: 2;
  localSignOutEpoch: number;
  credential: DesktopOfflineGrantCredential | null;
};

function parseState(raw: string): OfflineState | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_OFFLINE_STATE_BYTES) return null;
  try {
    const value = JSON.parse(raw) as {
      version?: unknown;
      localSignOutEpoch?: unknown;
      signOutEpoch?: unknown;
      credential?: (Partial<DesktopOfflineGrantCredential> & {
        signOutEpoch?: unknown;
      }) | null;
    };
    const localSignOutEpoch =
      value.version === 2 ? value.localSignOutEpoch : value.signOutEpoch;
    if (
      (value.version !== 1 && value.version !== 2)
      || !Number.isSafeInteger(localSignOutEpoch)
      || Number(localSignOutEpoch) < 0
    ) return null;
    if (value.credential === null) {
      return {
        version: 2,
        localSignOutEpoch: Number(localSignOutEpoch),
        credential: null,
      };
    }
    const credential = value.credential as Partial<DesktopOfflineGrantCredential> | undefined;
    const credentialLocalSignOutEpoch =
      credential?.localSignOutEpoch
      ?? (value.credential as { signOutEpoch?: unknown } | undefined)?.signOutEpoch;
    if (
      credential?.version !== 1
      || typeof credential.issuer !== "string"
      || typeof credential.accountId !== "string"
      || typeof credential.deviceId !== "string"
      || typeof credential.installationId !== "string"
      || typeof credential.grant !== "string"
      || typeof credential.keyId !== "string"
      || typeof credential.identityPublicKeySpki !== "string"
      || typeof credential.devicePrivateKeyPkcs8 !== "string"
      || typeof credential.devicePublicKeySpki !== "string"
      || !Number.isSafeInteger(credential.expiresAtMs)
      || !Number.isSafeInteger(credential.trustedTimeMs)
      || !Number.isSafeInteger(credentialLocalSignOutEpoch)
      || Number(credentialLocalSignOutEpoch) < 0
    ) return null;
    return {
      version: 2,
      localSignOutEpoch: Number(localSignOutEpoch),
      credential: {
        ...credential,
        localSignOutEpoch: Number(credentialLocalSignOutEpoch),
      } as DesktopOfflineGrantCredential,
    };
  } catch {
    return null;
  }
}

export function createDesktopOfflineGrantStore(options: {
  safeStorage: IdentitySafeStorage;
  platform: NodeJS.Platform;
  statePath: string;
  issuer: string;
  installationId: string;
}) {
  const available = identityCredentialVaultStatus(options.safeStorage, options.platform).available;
  let pendingDeviceKeys: {
    privateKeyPkcs8: string;
    publicKeySpki: string;
    thumbprint: string;
  } | null = null;

  const readState = (): OfflineState => {
    if (!available) return { version: 2, localSignOutEpoch: 0, credential: null };
    try {
      const encrypted = fs.readFileSync(options.statePath);
      if (encrypted.byteLength === 0 || encrypted.byteLength > MAX_OFFLINE_STATE_BYTES) {
        return { version: 2, localSignOutEpoch: 0, credential: null };
      }
      return parseState(options.safeStorage.decryptString(encrypted))
        ?? { version: 2, localSignOutEpoch: 0, credential: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 2, localSignOutEpoch: 0, credential: null };
      }
      throw error;
    }
  };

  const writeState = (state: OfflineState): void => {
    if (!available) return;
    const raw = JSON.stringify(state);
    if (!parseState(raw)) throw new Error("Offline Grant state is invalid");
    const encrypted = options.safeStorage.encryptString(raw);
    if (encrypted.byteLength === 0 || encrypted.byteLength > MAX_OFFLINE_STATE_BYTES) {
      throw new Error("Encrypted Offline Grant state is invalid");
    }
    fs.mkdirSync(path.dirname(options.statePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${options.statePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, encrypted, { mode: 0o600 });
      fs.renameSync(temporaryPath, options.statePath);
      fs.chmodSync(options.statePath, 0o600);
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  };

  return {
    available,

    prepareDeviceKey(): {
      privateKeyPkcs8: string;
      publicKeySpki: string;
      thumbprint: string;
      localSignOutEpoch: number;
    } | null {
      if (!available) return null;
      const state = readState();
      const existing = state.credential;
      if (existing?.issuer === options.issuer && existing.installationId === options.installationId) {
        const publicKey = createPublicKey({
          key: Buffer.from(existing.devicePublicKeySpki, "base64url"),
          format: "der",
          type: "spki",
        });
        pendingDeviceKeys = {
          privateKeyPkcs8: existing.devicePrivateKeyPkcs8,
          publicKeySpki: existing.devicePublicKeySpki,
          thumbprint: offlineDevicePublicKeyThumbprint(publicKey),
        };
      } else if (!pendingDeviceKeys) {
        const keys = generateOfflineDeviceKeyPair();
        pendingDeviceKeys = {
          privateKeyPkcs8: keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
          publicKeySpki: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
          thumbprint: keys.thumbprint,
        };
      }
      return {
        ...pendingDeviceKeys!,
        localSignOutEpoch: state.localSignOutEpoch,
      };
    },

    acceptGrant(input: {
      grant: string;
      expiresAtMs: number;
      keyId: string;
      identityPublicKeySpki: string;
      accountId: string;
      deviceId: string;
    }): DesktopOfflineGrantCredential {
      if (!available || !pendingDeviceKeys) throw new Error("Secure Offline Grant storage is unavailable");
      const state = readState();
      const identityPublicKey = createPublicKey({
        key: Buffer.from(input.identityPublicKeySpki, "base64url"),
        format: "der",
        type: "spki",
      });
      const nowMs = Date.now();
      const claims = verifyOfflineGrant({
        grant: input.grant,
        identityPublicKey,
        expectedKeyId: input.keyId,
        expectedIssuer: options.issuer,
        expectedInstallationId: options.installationId,
        expectedDeviceId: input.deviceId,
        expectedAccountId: input.accountId,
        nowMs,
        lastTrustedTimeMs: state.credential?.trustedTimeMs ?? 0,
        // This is a Desktop-owned tombstone. Identity only echoes the value
        // supplied on the current credential request; server revocation uses
        // the separate schema/account/device epochs in the signed grant.
        localSignOutEpoch: state.localSignOutEpoch,
      });
      if (claims.publicKeyThumbprint !== pendingDeviceKeys.thumbprint) {
        throw new Error("Offline Grant device binding is invalid");
      }
      const credential: DesktopOfflineGrantCredential = {
        version: 1,
        issuer: options.issuer,
        accountId: input.accountId,
        deviceId: input.deviceId,
        installationId: options.installationId,
        grant: input.grant,
        expiresAtMs: input.expiresAtMs,
        keyId: input.keyId,
        identityPublicKeySpki: input.identityPublicKeySpki,
        devicePrivateKeyPkcs8: pendingDeviceKeys.privateKeyPkcs8,
        devicePublicKeySpki: pendingDeviceKeys.publicKeySpki,
        trustedTimeMs: Math.max(nowMs, claims.trustedTimeMs),
        localSignOutEpoch:
          claims.version === 1
            ? claims.signOutEpoch
            : claims.localSignOutEpoch,
      };
      writeState({
        version: 2,
        localSignOutEpoch: state.localSignOutEpoch,
        credential,
      });
      return credential;
    },

    read(): DesktopOfflineGrantCredential | null {
      const state = readState();
      const value = state.credential;
      if (
        !value
        || value.issuer !== options.issuer
        || value.installationId !== options.installationId
      ) return null;
      return value;
    },

    updateTrustedTime(nextTrustedTimeMs: number): void {
      const state = readState();
      if (!state.credential || nextTrustedTimeMs <= state.credential.trustedTimeMs) return;
      writeState({
        ...state,
        credential: { ...state.credential, trustedTimeMs: nextTrustedTimeMs },
      });
    },

    signOut(): void {
      try {
        if (!available) {
          // A fail-closed memory-only build may follow an older secure build.
          // Remove stale encrypted state without decrypting it or touching the
          // unavailable native secure-storage API.
          fs.rmSync(options.statePath, { force: true });
          return;
        }
        const state = readState();
        writeState({
          version: 2,
          localSignOutEpoch: state.localSignOutEpoch + 1,
          credential: null,
        });
      } finally {
        pendingDeviceKeys = null;
      }
    },
  };
}
