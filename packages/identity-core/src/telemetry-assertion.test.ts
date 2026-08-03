import { describe, expect, it } from "vitest";
import {
  generateProductAnalyticsAssertionKeyPair,
  issueProductAnalyticsAssertion,
  verifyProductAnalyticsAssertion,
} from "./telemetry-assertion.js";

describe("product analytics assertion", () => {
  it("requires the telemetry audience and short lifetime", () => {
    const keys = generateProductAnalyticsAssertionKeyPair();
    const assertion = issueProductAnalyticsAssertion({
      signingPrivateKey: keys.privateKey,
      keyId: "telemetry-key-1",
      issuer: "https://accounts.rudderhq.dev",
      installationId: "install-1",
      pseudonymousInstallationId: "install-hash",
      analyticsSubject: "subject-hash",
      consentVersion: "v1",
      consentEpoch: 2,
      nowMs: 1_000,
      expiresAtMs: 2_000,
      jti: "assertion-1",
    });
    expect(verifyProductAnalyticsAssertion({
      assertion,
      identityPublicKey: keys.publicKey,
      expectedKeyId: "telemetry-key-1",
      expectedIssuer: "https://accounts.rudderhq.dev",
      expectedInstallationId: "install-1",
      expectedConsentEpoch: 2,
      expectedAnalyticsSubject: "subject-hash",
      nowMs: 1_500,
    }).audience).toBe("telemetry-collector");
    expect(() => verifyProductAnalyticsAssertion({
      assertion,
      identityPublicKey: keys.publicKey,
      expectedKeyId: "telemetry-key-1",
      expectedIssuer: "https://accounts.rudderhq.dev",
      expectedInstallationId: "install-1",
      nowMs: 2_001,
    })).toThrow("invalid_telemetry_assertion");
  });
});
