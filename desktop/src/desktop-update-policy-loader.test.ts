import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { readDesktopAutoUpdateState, resolveDesktopAutoUpdateStatePath } from "./desktop-auto-update-state.js";
import { createDesktopUpdatePolicyLoader } from "./desktop-update-policy-loader.js";
import type { DesktopUpdatePolicyPayload } from "./desktop-update-policy.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

function envelope(sequence = 7) {
  const keys = generateKeyPairSync("ed25519");
  const payload: DesktopUpdatePolicyPayload = {
    schema: 1,
    sequence,
    keyId: "test-key",
    issuedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: "2026-08-14T00:00:00.000Z",
    channel: "stable",
    platform: "darwin",
    arch: "arm64",
    releases: [{
      version: "0.7.5",
      assetName: "Rudder-0.7.5-macos-arm64-portable.zip",
      assetSha256: "a".repeat(64),
      releaseDigest: "b".repeat(64),
    }],
  };
  return {
    keys,
    payload,
    envelope: {
      payload,
      signature: sign(null, Buffer.from(canonicalize(payload)), keys.privateKey).toString("base64url"),
    },
  };
}

describe("desktop signed update policy loader", () => {
  it("verifies, persists, and authorizes the exact release identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-policy-loader-"));
    roots.push(root);
    const signed = envelope();
    const policyLoader = createDesktopUpdatePolicyLoader({
      userDataPath: root,
      channel: "stable",
      arch: "arm64",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      keys: { "test-key": signed.keys.publicKey.export({ type: "spki", format: "pem" }) },
      fetchImpl: async () => new Response(JSON.stringify(signed.envelope), { status: 200 }),
    });

    await expect(policyLoader.refresh()).resolves.toMatchObject({ ok: true, source: "network" });
    expect(readDesktopAutoUpdateState(resolveDesktopAutoUpdateStatePath(root)).acceptedPolicySequence).toBe(7);
    expect(policyLoader.hasUsablePolicy()).toBe(true);
    expect(policyLoader.authorizeRelease({
      version: "0.7.5",
      assetName: "Rudder-0.7.5-macos-arm64-portable.zip",
      assetSha256: "a".repeat(64),
      releaseDigest: "b".repeat(64),
    })).not.toBeNull();
    expect(policyLoader.authorizeRelease({
      version: "0.7.5",
      assetName: "Rudder-0.7.5-macos-arm64-portable.zip",
      assetSha256: "c".repeat(64),
      releaseDigest: "b".repeat(64),
    })).toBeNull();
  });

  it("uses only the accepted authenticated cache after network failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-policy-loader-cache-"));
    roots.push(root);
    const signed = envelope(8);
    const first = createDesktopUpdatePolicyLoader({
      userDataPath: root,
      channel: "stable",
      arch: "arm64",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      keys: { "test-key": signed.keys.publicKey.export({ type: "spki", format: "pem" }) },
      fetchImpl: async () => new Response(JSON.stringify(signed.envelope), { status: 200 }),
    });
    await first.refresh();
    const second = createDesktopUpdatePolicyLoader({
      userDataPath: root,
      channel: "stable",
      arch: "arm64",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      keys: { "test-key": signed.keys.publicKey.export({ type: "spki", format: "pem" }) },
      fetchImpl: async () => { throw new Error("offline"); },
    });
    await expect(second.refresh()).resolves.toMatchObject({ ok: true, source: "cache" });
    expect(second.getPolicy()?.sequence).toBe(8);
  });

  it("rejects a policy signed for another architecture before accepting its sequence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-policy-loader-arch-"));
    roots.push(root);
    const signed = envelope();
    signed.payload.arch = "x64";
    signed.envelope.signature = sign(null, Buffer.from(canonicalize(signed.payload)), signed.keys.privateKey).toString("base64url");
    const policyLoader = createDesktopUpdatePolicyLoader({
      userDataPath: root,
      channel: "stable",
      arch: "arm64",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      keys: { "test-key": signed.keys.publicKey.export({ type: "spki", format: "pem" }) },
      fetchImpl: async () => new Response(JSON.stringify(signed.envelope), { status: 200 }),
    });
    await expect(policyLoader.refresh()).resolves.toMatchObject({ ok: false, reason: "policy_runtime_mismatch" });
    expect(readDesktopAutoUpdateState(resolveDesktopAutoUpdateStatePath(root)).acceptedPolicySequence).toBe(-1);
  });
});
