import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIdentityCredentialVault,
  identityCredentialVaultStatus,
  type IdentityDeviceCredential,
} from "./identity-credential-vault.js";

const temporaryDirectories: string[] = [];

function temporaryCredentialPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-identity-vault-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "identity-device.bin");
}

function fakeSafeStorage(backend = "keychain") {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value: string) => Buffer.from(Buffer.from(value, "utf8").toString("base64url"), "utf8"),
    decryptString: (value: Buffer) => Buffer.from(value.toString("utf8"), "base64url").toString("utf8"),
  };
}

const credential: IdentityDeviceCredential = {
  version: 1,
  issuer: "https://accounts.rudderhq.dev",
  accountId: "account-1",
  accountEmail: "river@rudderhq.dev",
  accountName: "River Alvarez",
  deviceId: "device-1",
  refreshToken: "refresh-secret",
  refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("identity credential vault", () => {
  it("encrypts credentials at rest and restores them", () => {
    const credentialPath = temporaryCredentialPath();
    const vault = createIdentityCredentialVault({
      safeStorage: fakeSafeStorage(),
      platform: "darwin",
      credentialPath,
    });

    vault.write(credential);

    expect(fs.readFileSync(credentialPath, "utf8")).not.toContain("refresh-secret");
    expect(vault.read()).toEqual(credential);
    expect(fs.statSync(credentialPath).mode & 0o777).toBe(0o600);
  });

  it("restores legacy credentials without an account image", () => {
    const credentialPath = temporaryCredentialPath();
    const vault = createIdentityCredentialVault({
      safeStorage: fakeSafeStorage(),
      platform: "darwin",
      credentialPath,
    });

    vault.write(credential);

    expect(vault.read()).toEqual(credential);
    expect(vault.read()?.accountImage).toBeUndefined();
  });

  it("persists a maximum-sized account avatar while rejecting an oversized one", () => {
    const credentialPath = temporaryCredentialPath();
    const vault = createIdentityCredentialVault({
      safeStorage: fakeSafeStorage(),
      platform: "darwin",
      credentialPath,
    });
    const prefix = "data:image/png;base64,";
    const maximumAvatar = prefix + "a".repeat(480 * 1024 - prefix.length);

    vault.write({ ...credential, accountImage: maximumAvatar });

    expect(vault.read()?.accountImage).toBe(maximumAvatar);
    expect(() => vault.write({ ...credential, accountImage: `${maximumAvatar}a` }))
      .toThrow("credential is invalid");
  });

  it("clears the durable credential without exposing its value", () => {
    const credentialPath = temporaryCredentialPath();
    const vault = createIdentityCredentialVault({
      safeStorage: fakeSafeStorage(),
      platform: "win32",
      credentialPath,
    });
    vault.write(credential);

    vault.clear();

    expect(vault.read()).toBeNull();
  });

  it("rejects Linux basic_text storage instead of persisting a plaintext-equivalent secret", () => {
    expect(identityCredentialVaultStatus(fakeSafeStorage("basic_text"), "linux")).toEqual({
      available: false,
      backend: "basic_text",
      reason: "insecure_linux_backend",
    });
    const vault = createIdentityCredentialVault({
      safeStorage: fakeSafeStorage("basic_text"),
      platform: "linux",
      credentialPath: temporaryCredentialPath(),
    });

    expect(() => vault.write(credential)).toThrow("Secure credential storage is unavailable");
  });

  it("allows explicit loopback development issuers but rejects other plaintext origins", () => {
    const localVault = createIdentityCredentialVault({
      safeStorage: fakeSafeStorage(),
      platform: "darwin",
      credentialPath: temporaryCredentialPath(),
    });
    expect(() => localVault.write({ ...credential, issuer: "http://127.0.0.1:3200" })).not.toThrow();
    expect(() => localVault.write({ ...credential, issuer: "http://accounts.example.com" }))
      .toThrow("credential is invalid");
  });

  it("treats corrupt encrypted content as signed out", () => {
    const credentialPath = temporaryCredentialPath();
    fs.writeFileSync(credentialPath, Buffer.from("not-an-encrypted-credential"));
    const vault = createIdentityCredentialVault({
      safeStorage: fakeSafeStorage(),
      platform: "darwin",
      credentialPath,
    });

    expect(vault.read()).toBeNull();
  });

  it("rejects an expired refresh credential during initial vault read", () => {
    const credentialPath = temporaryCredentialPath();
    const vault = createIdentityCredentialVault({
      safeStorage: fakeSafeStorage(),
      platform: "darwin",
      credentialPath,
    });
    const encryptedExpiredCredential = fakeSafeStorage().encryptString(JSON.stringify({
      ...credential,
      refreshTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    }));
    fs.writeFileSync(credentialPath, encryptedExpiredCredential);

    expect(vault.read()).toBeNull();
    expect(() => vault.write({
      ...credential,
      refreshTokenExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    })).toThrow("credential is invalid");
  });
});
