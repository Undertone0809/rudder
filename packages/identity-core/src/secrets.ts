import { createHash, timingSafeEqual } from "node:crypto";

export function hashOpaqueSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function opaqueSecretMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueSecret(value));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b\d{6}\b/gu, "[REDACTED_OTP]")
    .replace(/(bearer\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(/((?:^|[?&\s])(?:token|code|secret)=)[^&\s]+/giu, "$1[REDACTED]");
}
