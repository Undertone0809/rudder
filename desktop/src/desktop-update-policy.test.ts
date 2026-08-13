import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  findAuthorizedDesktopRelease,
  verifyDesktopUpdatePolicy,
  type DesktopUpdatePolicyPayload,
} from "./desktop-update-policy.js";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

describe("desktop signed update policy", () => {
  it("accepts a valid signed exact release binding", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload: DesktopUpdatePolicyPayload = {
      schema: 1,
      sequence: 4,
      keyId: "vendor-2026",
      issuedAt: "2026-08-13T00:00:00.000Z",
      expiresAt: "2026-08-14T00:00:00.000Z",
      channel: "stable",
      platform: "darwin",
      arch: "arm64",
      releases: [{
        version: "0.7.5",
        assetName: "Rudder.zip",
        assetSha256: "a".repeat(64),
        releaseDigest: "b".repeat(64),
      }],
    };
    const signature = sign(null, Buffer.from(canonicalize(payload)), privateKey).toString("base64url");
    const result = verifyDesktopUpdatePolicy(
      { payload, signature },
      { keys: { "vendor-2026": publicKey.export({ type: "spki", format: "pem" }) }, now: new Date("2026-08-13T12:00:00.000Z") },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(findAuthorizedDesktopRelease(result.policy, {
        version: "0.7.5",
        assetName: "Rudder.zip",
        assetSha256: "a".repeat(64),
        releaseDigest: "b".repeat(64),
      })).not.toBeNull();
    }
  });

  it("rejects tampering, expiry, replay, and revoked exact bindings", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload: DesktopUpdatePolicyPayload = {
      schema: 1,
      sequence: 2,
      keyId: "k",
      issuedAt: "2026-08-12T00:00:00.000Z",
      expiresAt: "2026-08-13T00:00:00.000Z",
      channel: "stable",
      platform: "darwin",
      arch: "arm64",
      releases: [{ version: "0.7.5", assetName: "Rudder.zip", assetSha256: "a".repeat(64), releaseDigest: "b".repeat(64), revoked: true }],
    };
    const signature = sign(null, Buffer.from(canonicalize(payload)), privateKey).toString("base64url");
    const trust = { keys: { k: publicKey.export({ type: "spki", format: "pem" }) }, now: new Date("2026-08-12T12:00:00.000Z") };
    expect(verifyDesktopUpdatePolicy({ payload: { ...payload, sequence: 1 }, signature }, trust)).toMatchObject({ ok: false, reason: "invalid_policy_signature" });
    expect(verifyDesktopUpdatePolicy({ payload, signature }, { ...trust, now: new Date("2026-08-13T00:00:00.000Z") })).toMatchObject({ ok: false, reason: "policy_expired_or_not_yet_valid" });
    expect(verifyDesktopUpdatePolicy({ payload, signature }, { ...trust, highestAcceptedSequence: 2 })).toMatchObject({ ok: false, reason: "policy_sequence_replay" });
    const valid = verifyDesktopUpdatePolicy({ payload, signature }, trust);
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(findAuthorizedDesktopRelease(valid.policy, { version: "0.7.5", assetName: "Rudder.zip", assetSha256: "a".repeat(64), releaseDigest: "b".repeat(64) })).toBeNull();
  });
});
