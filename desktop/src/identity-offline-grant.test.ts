import { issueOfflineGrant } from "@rudderhq/identity-core";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopOfflineGrantStore } from "./identity-offline-grant.js";

const temporaryDirectories: string[] = [];

function temporaryStatePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-offline-grant-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "offline.bin");
}

function fakeSafeStorage(backend = "keychain") {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value: string) => Buffer.from(value, "utf8").reverse(),
    decryptString: (value: Buffer) => Buffer.from(value).reverse().toString("utf8"),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Desktop Offline Grant store", () => {
  it("persists a device-bound grant, advances trusted time, and tombstones it on sign out", () => {
    const identityKeys = generateKeyPairSync("ed25519");
    const identityPublicKeySpki = identityKeys.publicKey
      .export({ format: "der", type: "spki" }).toString("base64url");
    const statePath = temporaryStatePath();
    const store = createDesktopOfflineGrantStore({
      safeStorage: fakeSafeStorage(),
      platform: "darwin",
      statePath,
      issuer: "https://accounts.rudderhq.dev",
      installationId: "installation-1",
    });
    const device = store.prepareDeviceKey()!;
    const nowMs = Date.now();
    const grant = issueOfflineGrant({
      signingPrivateKey: identityKeys.privateKey,
      keyId: "prod-key",
      issuer: "https://accounts.rudderhq.dev",
      accountId: "account-1",
      deviceId: "device-1",
      installationId: "installation-1",
      publicKeyThumbprint: device.thumbprint,
      nowMs,
      trustedTimeMs: nowMs,
      signOutEpoch: device.signOutEpoch,
      jti: randomUUID(),
    });
    store.acceptGrant({
      grant,
      expiresAtMs: nowMs + 30 * 24 * 60 * 60_000,
      keyId: "prod-key",
      identityPublicKeySpki,
      accountId: "account-1",
      deviceId: "device-1",
    });
    store.updateTrustedTime(nowMs + 60_000);

    expect(store.read()).toMatchObject({
      accountId: "account-1",
      trustedTimeMs: nowMs + 60_000,
      signOutEpoch: 0,
    });
    expect(fs.readFileSync(statePath, "utf8")).not.toContain(grant);

    store.signOut();

    expect(store.read()).toBeNull();
    expect(store.prepareDeviceKey()?.signOutEpoch).toBe(1);
    expect(() => store.acceptGrant({
      grant,
      expiresAtMs: nowMs + 30 * 24 * 60 * 60_000,
      keyId: "prod-key",
      identityPublicKeySpki,
      accountId: "account-1",
      deviceId: "device-1",
    })).toThrow("signed_out");
  });

  it("does not create or persist an Offline Grant on Linux basic_text", () => {
    const statePath = temporaryStatePath();
    const store = createDesktopOfflineGrantStore({
      safeStorage: fakeSafeStorage("basic_text"),
      platform: "linux",
      statePath,
      issuer: "https://accounts.rudderhq.dev",
      installationId: "installation-1",
    });
    expect(store.available).toBe(false);
    expect(store.prepareDeviceKey()).toBeNull();
    store.signOut();
    expect(fs.existsSync(statePath)).toBe(false);
  });
});
