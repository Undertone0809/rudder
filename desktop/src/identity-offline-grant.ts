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
  signOutEpoch: number;
};

type OfflineState = {
  version: 1;
  signOutEpoch: number;
  credential: DesktopOfflineGrantCredential | null;
};

function parseState(raw: string): OfflineState | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_OFFLINE_STATE_BYTES) return null;
  try {
    const value = JSON.parse(raw) as Partial<OfflineState>;
    if (
      value.version !== 1
      || !Number.isSafeInteger(value.signOutEpoch)
      || Number(value.signOutEpoch) < 0
    ) return null;
    if (value.credential === null) return value as OfflineState;
    const credential = value.credential as Partial<DesktopOfflineGrantCredential> | undefined;
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
      || credential.signOutEpoch !== value.signOutEpoch
    ) return null;
    return value as OfflineState;
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
    if (!available) return { version: 1, signOutEpoch: 0, credential: null };
    try {
      const encrypted = fs.readFileSync(options.statePath);
      if (encrypted.byteLength === 0 || encrypted.byteLength > MAX_OFFLINE_STATE_BYTES) {
        return { version: 1, signOutEpoch: 0, credential: null };
      }
      return parseState(options.safeStorage.decryptString(encrypted))
        ?? { version: 1, signOutEpoch: 0, credential: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, signOutEpoch: 0, credential: null };
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
      signOutEpoch: number;
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
      return { ...pendingDeviceKeys!, signOutEpoch: state.signOutEpoch };
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
        localSignOutEpoch: state.signOutEpoch,
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
        signOutEpoch: state.signOutEpoch,
      };
      writeState({ version: 1, signOutEpoch: state.signOutEpoch, credential });
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
          version: 1,
          signOutEpoch: state.signOutEpoch + 1,
          credential: null,
        });
      } finally {
        pendingDeviceKeys = null;
      }
    },
  };
}
