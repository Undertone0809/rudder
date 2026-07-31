import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createOfflineGrantProof,
  generateOfflineDeviceKeyPair,
  issueOfflineGrant,
  MAX_OFFLINE_GRANT_LIFETIME_MS,
  offlineRequestBodyHash,
  verifyOfflineGrantAndProof,
} from "./offline-grant.js";

const nowMs = Date.parse("2026-07-29T00:00:00.000Z");

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function asLegacyGrant(
  grant: string,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): string {
  const [header, payload] = grant.split(".");
  const claims = JSON.parse(
    Buffer.from(payload!, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  claims.version = 1;
  claims.signOutEpoch = claims.localSignOutEpoch;
  delete claims.localSignOutEpoch;
  delete claims.authSchemaEpoch;
  delete claims.accountAuthEpoch;
  delete claims.deviceAuthEpoch;
  const encodedPayload = Buffer.from(stableJson(claims)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  const signature = sign(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function fixture() {
  const identityKeys = generateKeyPairSync("ed25519");
  const deviceKeys = generateOfflineDeviceKeyPair();
  const grant = issueOfflineGrant({
    signingPrivateKey: identityKeys.privateKey,
    keyId: "identity-key-1",
    issuer: "https://accounts.rudderhq.dev",
    accountId: "account-1",
    deviceId: "device-1",
    installationId: "default",
    publicKeyThumbprint: deviceKeys.thumbprint,
    nowMs,
    trustedTimeMs: nowMs,
    localSignOutEpoch: 3,
    authSchemaEpoch: 2,
    accountAuthEpoch: 4,
    deviceAuthEpoch: 5,
    jti: "grant-1",
  });
  const bodyHash = offlineRequestBodyHash('{"intent":"open-local-board"}');
  const proof = createOfflineGrantProof({
    grant,
    devicePrivateKey: deviceKeys.privateKey,
    method: "POST",
    path: "/api/auth/offline",
    bodyHash,
    nonce: "server-challenge-1",
    issuedAtMs: nowMs + 1_000,
  });
  return { identityKeys, deviceKeys, grant, proof, bodyHash };
}

function verifyFixture(
  value: ReturnType<typeof fixture>,
  overrides: Partial<Parameters<typeof verifyOfflineGrantAndProof>[0]> = {},
) {
  const usedNonces = new Set<string>();
  return verifyOfflineGrantAndProof({
    grant: value.grant,
    proof: value.proof,
    identityPublicKey: value.identityKeys.publicKey,
    expectedKeyId: "identity-key-1",
    devicePublicKey: value.deviceKeys.publicKey,
    expectedIssuer: "https://accounts.rudderhq.dev",
    expectedInstallationId: "default",
    expectedDeviceId: "device-1",
    expectedAccountId: "account-1",
    expectedMethod: "POST",
    expectedPath: "/api/auth/offline",
    expectedBodyHash: value.bodyHash,
    nowMs: nowMs + 1_000,
    lastTrustedTimeMs: nowMs,
    localSignOutEpoch: 3,
    consumeNonce: (nonce) => {
      if (usedNonces.has(nonce)) return false;
      usedNonces.add(nonce);
      return true;
    },
    ...overrides,
  });
}

describe("Local offline grant proof of possession", () => {
  it("verifies an installation-bound grant and advances trusted time", () => {
    const value = fixture();
    const result = verifyFixture(value);

    expect(result.claims).toMatchObject({
      accountId: "account-1",
      deviceId: "device-1",
      installationId: "default",
      audience: "rudder-local-board",
      localSignOutEpoch: 3,
      authSchemaEpoch: 2,
      accountAuthEpoch: 4,
      deviceAuthEpoch: 5,
    });
    expect(result.nextTrustedTimeMs).toBe(nowMs + 1_000);
  });

  it("rejects a copied grant without the bound device private key", () => {
    const value = fixture();
    const attacker = generateOfflineDeviceKeyPair();
    const attackerProof = createOfflineGrantProof({
      grant: value.grant,
      devicePrivateKey: attacker.privateKey,
      method: "POST",
      path: "/api/auth/offline",
      bodyHash: value.bodyHash,
      nonce: "attacker-challenge",
      issuedAtMs: nowMs + 1_000,
    });

    expect(() => verifyFixture(value, {
      proof: attackerProof,
      devicePublicKey: attacker.publicKey,
    })).toThrow("device_key_mismatch");
  });

  it("rejects nonce replay after one valid proof", () => {
    const value = fixture();
    let consumed = false;
    const options = {
      consumeNonce: () => {
        if (consumed) return false;
        consumed = true;
        return true;
      },
    };
    expect(() => verifyFixture(value, options)).not.toThrow();
    expect(() => verifyFixture(value, options)).toThrow("proof_replay");
  });

  it("rejects a grant after any server-owned auth epoch advances", () => {
    const value = fixture();
    expect(() => verifyFixture(value, { expectedAuthSchemaEpoch: 3 }))
      .toThrow("offline_grant_revoked");
    expect(() => verifyFixture(value, { expectedAccountAuthEpoch: 5 }))
      .toThrow("offline_grant_revoked");
    expect(() => verifyFixture(value, { expectedDeviceAuthEpoch: 6 }))
      .toThrow("offline_grant_revoked");
  });

  it("rejects legacy grants online but preserves their bounded offline residual", () => {
    const value = fixture();
    const legacyGrant = asLegacyGrant(
      value.grant,
      value.identityKeys.privateKey,
    );
    const legacyProof = createOfflineGrantProof({
      grant: legacyGrant,
      devicePrivateKey: value.deviceKeys.privateKey,
      method: "POST",
      path: "/api/auth/offline",
      bodyHash: value.bodyHash,
      nonce: "legacy-offline-proof",
      issuedAtMs: nowMs + 1_000,
    });
    const legacy = { ...value, grant: legacyGrant, proof: legacyProof };

    expect(() => verifyFixture(legacy)).toThrow("invalid_offline_grant");
    expect(() => verifyFixture(legacy, { allowLegacyOffline: true }))
      .not.toThrow();
  });

  it("rejects clock rollback, expiry, installation mismatch, and local sign-out", () => {
    const value = fixture();
    expect(() => verifyFixture(value, {
      nowMs: nowMs - 6 * 60 * 1000,
      lastTrustedTimeMs: nowMs,
    })).toThrow("clock_rollback");
    expect(() => verifyFixture(value, {
      nowMs: nowMs + MAX_OFFLINE_GRANT_LIFETIME_MS,
      proof: createOfflineGrantProof({
        grant: value.grant,
        devicePrivateKey: value.deviceKeys.privateKey,
        method: "POST",
        path: "/api/auth/offline",
        bodyHash: value.bodyHash,
        nonce: "expiry-challenge",
        issuedAtMs: nowMs + MAX_OFFLINE_GRANT_LIFETIME_MS,
      }),
    })).toThrow("grant_expired");
    expect(() => verifyFixture(value, { expectedInstallationId: "restored-copy" }))
      .toThrow("binding_mismatch");
    expect(() => verifyFixture(value, { localSignOutEpoch: 4 }))
      .toThrow("signed_out");
  });

  it("will not issue a grant longer than 30 days", () => {
    const identityKeys = generateKeyPairSync("ed25519");
    const deviceKeys = generateOfflineDeviceKeyPair();
    expect(() => issueOfflineGrant({
      signingPrivateKey: identityKeys.privateKey,
      keyId: "identity-key-1",
      issuer: "https://accounts.rudderhq.dev",
      accountId: "account-1",
      deviceId: "device-1",
      installationId: "default",
      publicKeyThumbprint: deviceKeys.thumbprint,
      nowMs,
      expiresAtMs: nowMs + MAX_OFFLINE_GRANT_LIFETIME_MS + 1,
      trustedTimeMs: nowMs,
      localSignOutEpoch: 0,
      authSchemaEpoch: 2,
      accountAuthEpoch: 0,
      deviceAuthEpoch: 0,
      jti: "grant-too-long",
    })).toThrow("lifetime");
  });
});
