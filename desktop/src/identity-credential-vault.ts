import fs from "node:fs";
import path from "node:path";

const MAX_ACCOUNT_IMAGE_LENGTH = 480 * 1024;
const MAX_CREDENTIAL_PLAINTEXT_BYTES = 512 * 1024;
const MAX_ENCRYPTED_CREDENTIAL_BYTES = 768 * 1024;

export type IdentityDeviceCredential = {
  version: 1;
  issuer: string;
  accountId: string;
  accountEmail: string;
  accountName: string;
  accountImage?: string | null;
  deviceId: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
};

export type IdentitySafeStorage = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

export type IdentityCredentialVaultStatus =
  | { available: true; backend: string }
  | { available: false; backend: string; reason: "encryption_unavailable" | "insecure_linux_backend" };

export type IdentityCredentialVault = ReturnType<typeof createIdentityCredentialVault>;

export function identityCredentialVaultStatus(
  safeStorage: IdentitySafeStorage,
  platform: NodeJS.Platform,
): IdentityCredentialVaultStatus {
  const backend = safeStorage.getSelectedStorageBackend?.() ?? "platform_default";
  if (!safeStorage.isEncryptionAvailable()) {
    return { available: false, backend, reason: "encryption_unavailable" };
  }
  if (platform === "linux" && backend === "basic_text") {
    return { available: false, backend, reason: "insecure_linux_backend" };
  }
  return { available: true, backend };
}

function parseCredential(raw: string): IdentityDeviceCredential | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_CREDENTIAL_PLAINTEXT_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1
    || typeof record.issuer !== "string"
    || typeof record.accountId !== "string"
    || typeof record.accountEmail !== "string"
    || typeof record.accountName !== "string"
    || (record.accountImage !== undefined
      && record.accountImage !== null
      && typeof record.accountImage !== "string")
    || typeof record.deviceId !== "string"
    || typeof record.refreshToken !== "string"
    || typeof record.refreshTokenExpiresAt !== "string"
  ) {
    return null;
  }
  let issuer: URL;
  try {
    issuer = new URL(record.issuer);
  } catch {
    return null;
  }
  const secureIssuer = issuer.protocol === "https:";
  const localDevelopmentIssuer = issuer.protocol === "http:"
    && (issuer.hostname === "127.0.0.1" || issuer.hostname === "localhost");
  if (
    (!secureIssuer && !localDevelopmentIssuer)
    || record.accountId.length === 0
    || !record.accountEmail.includes("@")
    || record.accountName.length === 0
    || (typeof record.accountImage === "string"
      && record.accountImage.length > MAX_ACCOUNT_IMAGE_LENGTH)
    || record.deviceId.length === 0
    || record.refreshToken.length === 0
    || Number.isNaN(Date.parse(record.refreshTokenExpiresAt))
    || Date.parse(record.refreshTokenExpiresAt) <= Date.now()
  ) {
    return null;
  }
  return record as IdentityDeviceCredential;
}

export function createIdentityCredentialVault(options: {
  safeStorage: IdentitySafeStorage;
  platform: NodeJS.Platform;
  credentialPath: string;
}) {
  const status = () => identityCredentialVaultStatus(options.safeStorage, options.platform);

  return {
    status,

    read(): IdentityDeviceCredential | null {
      if (!status().available) return null;
      let encrypted: Buffer;
      try {
        encrypted = fs.readFileSync(options.credentialPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      if (encrypted.byteLength === 0 || encrypted.byteLength > MAX_ENCRYPTED_CREDENTIAL_BYTES) return null;
      try {
        return parseCredential(options.safeStorage.decryptString(encrypted));
      } catch {
        return null;
      }
    },

    write(credential: IdentityDeviceCredential): void {
      const currentStatus = status();
      if (!currentStatus.available) {
        throw new Error(`Secure credential storage is unavailable (${currentStatus.reason})`);
      }
      const serialized = JSON.stringify(credential);
      if (!parseCredential(serialized)) {
        throw new Error("Identity device credential is invalid");
      }
      const encrypted = options.safeStorage.encryptString(serialized);
      if (encrypted.byteLength === 0 || encrypted.byteLength > MAX_ENCRYPTED_CREDENTIAL_BYTES) {
        throw new Error("Encrypted identity credential is invalid");
      }
      fs.mkdirSync(path.dirname(options.credentialPath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${options.credentialPath}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporaryPath, encrypted, { mode: 0o600 });
        fs.renameSync(temporaryPath, options.credentialPath);
        fs.chmodSync(options.credentialPath, 0o600);
      } finally {
        fs.rmSync(temporaryPath, { force: true });
      }
    },

    clear(): void {
      fs.rmSync(options.credentialPath, { force: true });
    },
  };
}
