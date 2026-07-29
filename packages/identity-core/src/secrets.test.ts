import { describe, expect, it } from "vitest";
import { hashOpaqueSecret, opaqueSecretMatches, redactSensitiveText } from "./secrets.js";

describe("opaque secret helpers", () => {
  it("hashes deterministically and compares safely", () => {
    const hash = hashOpaqueSecret("refresh-secret");
    expect(hash).not.toContain("refresh-secret");
    expect(opaqueSecretMatches("refresh-secret", hash)).toBe(true);
    expect(opaqueSecretMatches("wrong", hash)).toBe(false);
  });

  it("redacts OTPs and URL or bearer credentials", () => {
    expect(redactSensitiveText("OTP 123456 bearer abc? token=secret")).toBe(
      "OTP [REDACTED_OTP] bearer [REDACTED] token=[REDACTED]",
    );
    expect(redactSensitiveText("/callback?code=secret&state=ok")).toBe(
      "/callback?code=[REDACTED]&state=ok",
    );
  });
});
