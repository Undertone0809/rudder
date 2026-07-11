import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptMacChromiumCookie,
  deriveMacChromiumCookieKey,
} from "./browser-cookie-crypto-macos.js";

function encryptV10(key: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10", "ascii"), cipher.update(plaintext), cipher.final()]);
}

describe("macOS Chromium cookie crypto", () => {
  it("derives the Chromium v10 key with the macOS PBKDF2 contract", () => {
    const key = deriveMacChromiumCookieKey(Buffer.from("test-password"));
    expect(key.toString("hex")).toBe("c0ffe4c25f07f62bfc6ab011d9efa54e");
    key.fill(0);
  });

  it("decrypts v10 cookies before schema v24 without a host hash", () => {
    const key = deriveMacChromiumCookieKey(Buffer.from("test-password"));
    const encryptedValue = encryptV10(key, Buffer.from("session-token"));

    expect(decryptMacChromiumCookie({ encryptedValue, key, hostKey: ".example.com", databaseVersion: 23 }))
      .toEqual({ ok: true, value: "session-token" });
    key.fill(0);
  });

  it("verifies and strips the v24 SHA-256 host prefix", () => {
    const key = deriveMacChromiumCookieKey(Buffer.from("test-password"));
    const hostKey = ".example.com";
    const plaintext = Buffer.concat([
      createHash("sha256").update(hostKey).digest(),
      Buffer.from("signed-in"),
    ]);
    const encryptedValue = encryptV10(key, plaintext);

    expect(decryptMacChromiumCookie({ encryptedValue, key, hostKey, databaseVersion: 24 }))
      .toEqual({ ok: true, value: "signed-in" });
    expect(decryptMacChromiumCookie({ encryptedValue, key, hostKey: ".attacker.test", databaseVersion: 24 }))
      .toEqual({ ok: false, errorCode: "COOKIE_HOST_HASH_MISMATCH" });
    key.fill(0);
  });

  it.each([
    [Buffer.from("v11not-macos"), "COOKIE_ENCRYPTION_UNSUPPORTED"],
    [Buffer.from("v10short"), "COOKIE_DECRYPT_FAILED"],
  ] as const)("rejects unsupported or malformed ciphertext", (encryptedValue, errorCode) => {
    const key = Buffer.alloc(16, 1);
    expect(decryptMacChromiumCookie({ encryptedValue, key, hostKey: "example.com", databaseVersion: 23 }))
      .toEqual({ ok: false, errorCode });
    key.fill(0);
  });

  it("rejects decrypted cookie values that are not valid UTF-8", () => {
    const key = Buffer.alloc(16, 2);
    const encryptedValue = encryptV10(key, Buffer.from([0xff]));
    expect(decryptMacChromiumCookie({ encryptedValue, key, hostKey: "example.com", databaseVersion: 23 }))
      .toEqual({ ok: false, errorCode: "COOKIE_VALUE_INVALID" });
    key.fill(0);
  });
});
