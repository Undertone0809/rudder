import { describe, expect, it } from "vitest";
import { assertIdentityReleasePolicy } from "./release-policy.js";

describe("assertIdentityReleasePolicy", () => {
  it("rejects production test capabilities", () => {
    expect(() =>
      assertIdentityReleasePolicy({
        channel: "production",
        issuer: "https://accounts.rudderhq.dev",
        allowCapturedMail: true,
        allowTestClients: false,
      }),
    ).toThrow("captured mail");
  });

  it("allows isolated local development", () => {
    expect(() =>
      assertIdentityReleasePolicy({
        channel: "development",
        issuer: "http://127.0.0.1:3200",
        allowCapturedMail: true,
        allowTestClients: true,
      }),
    ).not.toThrow();
  });

  it("fails preview closed for capture mail and test clients", () => {
    for (const policy of [
      { allowCapturedMail: true, allowTestClients: false },
      { allowCapturedMail: false, allowTestClients: true },
    ]) {
      expect(() =>
        assertIdentityReleasePolicy({
          channel: "preview",
          issuer: "https://preview-identity.rudderhq.dev",
          ...policy,
        }),
      ).toThrow();
    }
  });

  it("rejects development capture on a non-loopback HTTP issuer", () => {
    expect(() =>
      assertIdentityReleasePolicy({
        channel: "development",
        issuer: "http://identity.internal",
        allowCapturedMail: true,
        allowTestClients: true,
      }),
    ).toThrow("loopback");
  });

  it("requires an origin-only canonical production issuer", () => {
    for (const issuer of [
      "https://accounts.rudderhq.dev/account",
      "https://user@accounts.rudderhq.dev",
      "https://accounts.rudderhq.dev?preview=true",
      "https://identity.rudderhq.dev",
    ]) {
      expect(() =>
        assertIdentityReleasePolicy({
          channel: "production",
          issuer,
          allowCapturedMail: false,
          allowTestClients: false,
        }),
      ).toThrow();
    }
    expect(() =>
      assertIdentityReleasePolicy({
        channel: "production",
        issuer: "https://accounts.rudderhq.dev",
        allowCapturedMail: false,
        allowTestClients: false,
      }),
    ).not.toThrow();
  });
});
