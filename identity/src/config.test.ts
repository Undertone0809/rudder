import { describe, expect, it } from "vitest";
import { readIdentityConfig } from "./config.js";

const baseEnv = {
  IDENTITY_RELEASE_CHANNEL: "development",
  IDENTITY_BASE_URL: "http://127.0.0.1:3200",
  IDENTITY_DATABASE_URL: "postgres://identity@127.0.0.1/identity",
  IDENTITY_BETTER_AUTH_SECRET: "a-development-secret-that-is-at-least-32-characters",
  IDENTITY_DEVICE_CLIENT_IDS: "rudder-desktop,rudder-cli",
  IDENTITY_SUPPORT_EMAIL: "support@rudderhq.dev",
  IDENTITY_MAIL_FROM: "Rudder Account <account@updates.rudderhq.dev>",
  IDENTITY_MAIL_MODE: "capture",
  IDENTITY_CAPTURE_MAILBOX_SECRET: "capture-mailbox-test-secret",
};

describe("readIdentityConfig", () => {
  it("defaults to development only outside Vercel", () => {
    const { IDENTITY_RELEASE_CHANNEL: _releaseChannel, ...localEnv } = baseEnv;
    expect(readIdentityConfig(localEnv).releaseChannel).toBe("development");
  });

  it("requires an explicit release channel on Vercel", () => {
    const { IDENTITY_RELEASE_CHANNEL: _releaseChannel, ...vercelEnv } = baseEnv;
    expect(() => readIdentityConfig({
      ...vercelEnv,
      VERCEL_ENV: "preview",
    })).toThrow("IDENTITY_RELEASE_CHANNEL is required");
  });

  it.each([
    ["production", "preview"],
    ["preview", "production"],
    ["development", "preview"],
  ])("rejects Vercel %s with Identity %s", (vercelEnv, identityChannel) => {
    expect(() => readIdentityConfig({
      ...baseEnv,
      VERCEL_ENV: vercelEnv,
      IDENTITY_RELEASE_CHANNEL: identityChannel,
    })).toThrow("must match VERCEL_ENV");
  });

  it("accepts an explicitly matched Vercel preview channel", () => {
    expect(readIdentityConfig({
      ...baseEnv,
      VERCEL_ENV: "preview",
      IDENTITY_RELEASE_CHANNEL: "preview",
      IDENTITY_BASE_URL: "https://preview-identity.rudderhq.dev",
      IDENTITY_MAIL_MODE: "resend",
      IDENTITY_RESEND_API_KEY: "resend-fixture-key",
    }).releaseChannel).toBe("preview");
  });

  it("supports provider-free captured-mail development", () => {
    const config = readIdentityConfig(baseEnv);
    expect(config.mail.mode).toBe("capture");
    expect(config.deviceClientIds.has("rudder-desktop")).toBe(true);
    expect(config.google).toBeUndefined();
  });

  it("rejects half-configured OAuth providers", () => {
    expect(() =>
      readIdentityConfig({
        ...baseEnv,
        IDENTITY_GOOGLE_CLIENT_ID: "client",
      }),
    ).toThrow("must be configured together");
  });

  it("rejects production captured mail before any request is served", () => {
    expect(() =>
      readIdentityConfig({
        ...baseEnv,
        IDENTITY_RELEASE_CHANNEL: "production",
        IDENTITY_BASE_URL: "https://accounts.rudderhq.dev",
      }),
    ).toThrow("captured mail");
  });

  it("rejects preview captured mail and defaults preview to Resend", () => {
    expect(() =>
      readIdentityConfig({
        ...baseEnv,
        IDENTITY_RELEASE_CHANNEL: "preview",
        IDENTITY_BASE_URL: "https://preview-identity.rudderhq.dev",
      }),
    ).toThrow("captured mail");

    expect(() =>
      readIdentityConfig({
        ...baseEnv,
        IDENTITY_RELEASE_CHANNEL: "preview",
        IDENTITY_BASE_URL: "https://preview-identity.rudderhq.dev",
        IDENTITY_MAIL_MODE: undefined,
      }),
    ).toThrow("IDENTITY_RESEND_API_KEY");
  });

  it("requires an explicit mailbox secret for capture mode", () => {
    expect(() =>
      readIdentityConfig({
        ...baseEnv,
        IDENTITY_CAPTURE_MAILBOX_SECRET: undefined,
      }),
    ).toThrow("IDENTITY_CAPTURE_MAILBOX_SECRET");
  });

  it("accepts existing Vercel Resend aliases", () => {
    const config = readIdentityConfig({
      ...baseEnv,
      IDENTITY_MAIL_MODE: "resend",
      IDENTITY_MAIL_FROM: undefined,
      IDENTITY_RESEND_API_KEY: undefined,
      EMAIL_FROM: "Rudder Account <account@updates.rudderhq.dev>",
      RESEND_API_KEY: "resend-fixture-key",
    });
    expect(config.mail).toMatchObject({
      mode: "resend",
      from: "Rudder Account <account@updates.rudderhq.dev>",
      apiKey: "resend-fixture-key",
    });
  });

  it("rejects non-origin allowed origins outside local development", () => {
    expect(() =>
      readIdentityConfig({
        ...baseEnv,
        IDENTITY_RELEASE_CHANNEL: "preview",
        IDENTITY_BASE_URL: "https://preview-identity.rudderhq.dev",
        IDENTITY_ALLOWED_ORIGINS: "https://preview-identity.rudderhq.dev/callback",
        IDENTITY_MAIL_MODE: "resend",
        IDENTITY_RESEND_API_KEY: "resend-fixture-key",
      }),
    ).toThrow("HTTPS origins only");
  });
});
