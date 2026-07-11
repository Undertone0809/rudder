import { createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from "node:crypto";

export type MacChromiumCookieDecryptResult =
  | { ok: true; value: string }
  | {
      ok: false;
      errorCode:
        | "COOKIE_DECRYPT_FAILED"
        | "COOKIE_ENCRYPTION_UNSUPPORTED"
        | "COOKIE_HOST_HASH_MISMATCH"
        | "COOKIE_VALUE_INVALID";
    };

export function deriveMacChromiumCookieKey(password: Uint8Array): Buffer {
  return pbkdf2Sync(password, Buffer.from("saltysalt", "ascii"), 1003, 16, "sha1");
}

export function decryptMacChromiumCookie(input: {
  encryptedValue: Uint8Array;
  key: Uint8Array;
  hostKey: string;
  databaseVersion: number;
}): MacChromiumCookieDecryptResult {
  const encryptedValue = Buffer.from(input.encryptedValue);
  const prefix = encryptedValue.subarray(0, 3).toString("ascii");
  if (prefix !== "v10") {
    return { ok: false, errorCode: "COOKIE_ENCRYPTION_UNSUPPORTED" };
  }
  const ciphertext = encryptedValue.subarray(3);
  if (input.key.byteLength !== 16 || ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    return { ok: false, errorCode: "COOKIE_DECRYPT_FAILED" };
  }

  let plaintext: Buffer | null = null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", input.key, Buffer.alloc(16, 0x20));
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return { ok: false, errorCode: "COOKIE_DECRYPT_FAILED" };
  }

  try {
    let valueBytes = plaintext;
    if (input.databaseVersion >= 24) {
      if (plaintext.length < 32) return { ok: false, errorCode: "COOKIE_HOST_HASH_MISMATCH" };
      const expectedHash = createHash("sha256").update(input.hostKey, "utf8").digest();
      const actualHash = plaintext.subarray(0, 32);
      if (!timingSafeEqual(actualHash, expectedHash)) {
        return { ok: false, errorCode: "COOKIE_HOST_HASH_MISMATCH" };
      }
      valueBytes = plaintext.subarray(32);
    }

    try {
      return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(valueBytes) };
    } catch {
      return { ok: false, errorCode: "COOKIE_VALUE_INVALID" };
    }
  } finally {
    plaintext.fill(0);
  }
}
