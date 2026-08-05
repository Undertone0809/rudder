import { describe, expect, it } from "vitest";
import {
  readIdentityConfig,
  readSupabaseRootIdentityConfig,
} from "./config.js";

const baseEnv = {
  IDENTITY_RELEASE_CHANNEL: "development",
  IDENTITY_BASE_URL: "http://127.0.0.1:3200",
  IDENTITY_DATABASE_URL: "postgres://identity@127.0.0.1/identity",
  IDENTITY_SECURITY_HASH_SECRET: "a-development-secret-that-is-at-least-32-characters",
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
      IDENTITY_MAIL_MODE: "supabase_smtp",
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

  it("requires a complete private collector sync configuration", () => {
    expect(() => readIdentityConfig({
      ...baseEnv,
      IDENTITY_TELEMETRY_COLLECTOR_URL: "https://telemetry.rudderhq.dev",
    })).toThrow("must be configured together");

    const config = readIdentityConfig({
      ...baseEnv,
      IDENTITY_TELEMETRY_COLLECTOR_URL: "https://telemetry.rudderhq.dev",
      IDENTITY_TELEMETRY_COLLECTOR_CONSENT_SYNC_SECRET: "c".repeat(32),
      IDENTITY_TELEMETRY_ASSERTION_KEY_ID: "telemetry-key",
      IDENTITY_TELEMETRY_ASSERTION_PRIVATE_KEY: "private-key",
      IDENTITY_TELEMETRY_SUBJECT_SECRET: "s".repeat(32),
      IDENTITY_TELEMETRY_REVOKE_SECRET: "r".repeat(32),
    });
    expect(config.telemetry?.collectorConsentSync).toEqual({
      collectorUrl: "https://telemetry.rudderhq.dev",
      syncSecret: "c".repeat(32),
    });
  });

  it("requires HTTPS for collector sync outside local development", () => {
    expect(() => readIdentityConfig({
      ...baseEnv,
      IDENTITY_TELEMETRY_COLLECTOR_URL: "ftp://telemetry.rudderhq.dev",
      IDENTITY_TELEMETRY_COLLECTOR_CONSENT_SYNC_SECRET: "c".repeat(32),
      IDENTITY_TELEMETRY_ASSERTION_KEY_ID: "telemetry-key",
      IDENTITY_TELEMETRY_ASSERTION_PRIVATE_KEY: "private-key",
      IDENTITY_TELEMETRY_SUBJECT_SECRET: "s".repeat(32),
      IDENTITY_TELEMETRY_REVOKE_SECRET: "r".repeat(32),
    })).toThrow("must be a valid origin");

    expect(() => readIdentityConfig({
      ...baseEnv,
      IDENTITY_RELEASE_CHANNEL: "preview",
      IDENTITY_BASE_URL: "https://preview-identity.rudderhq.dev",
      IDENTITY_MAIL_MODE: "supabase_smtp",
      IDENTITY_TELEMETRY_COLLECTOR_URL: "http://telemetry.rudderhq.dev",
      IDENTITY_TELEMETRY_COLLECTOR_CONSENT_SYNC_SECRET: "c".repeat(32),
      IDENTITY_TELEMETRY_ASSERTION_KEY_ID: "telemetry-key",
      IDENTITY_TELEMETRY_ASSERTION_PRIVATE_KEY: "private-key",
      IDENTITY_TELEMETRY_SUBJECT_SECRET: "s".repeat(32),
      IDENTITY_TELEMETRY_REVOKE_SECRET: "r".repeat(32),
    })).toThrow("must use HTTPS");
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

  it("rejects preview captured mail and defaults preview to Supabase SMTP", () => {
    expect(() =>
      readIdentityConfig({
        ...baseEnv,
        IDENTITY_RELEASE_CHANNEL: "preview",
        IDENTITY_BASE_URL: "https://preview-identity.rudderhq.dev",
      }),
    ).toThrow("captured mail");

    expect(readIdentityConfig({
      ...baseEnv,
      IDENTITY_RELEASE_CHANNEL: "preview",
      IDENTITY_BASE_URL: "https://preview-identity.rudderhq.dev",
      IDENTITY_MAIL_MODE: undefined,
    }).mail).toEqual({ mode: "supabase_smtp" });
  });

  it("requires an explicit mailbox secret for capture mode", () => {
    expect(() =>
      readIdentityConfig({
        ...baseEnv,
        IDENTITY_CAPTURE_MAILBOX_SECRET: undefined,
      }),
    ).toThrow("IDENTITY_CAPTURE_MAILBOX_SECRET");
  });

  it("keeps the Better Auth secret only as a migration-window alias", () => {
    const {
      IDENTITY_SECURITY_HASH_SECRET: _securityHashSecret,
      ...legacyEnv
    } = baseEnv;
    expect(readIdentityConfig({
      ...legacyEnv,
      IDENTITY_BETTER_AUTH_SECRET: "a-legacy-secret-that-is-at-least-32-characters",
    }).secret).toBe("a-legacy-secret-that-is-at-least-32-characters");
  });

  it("rejects non-origin allowed origins outside local development", () => {
    expect(() =>
      readIdentityConfig({
        ...baseEnv,
        IDENTITY_RELEASE_CHANNEL: "preview",
        IDENTITY_BASE_URL: "https://preview-identity.rudderhq.dev",
        IDENTITY_ALLOWED_ORIGINS: "https://preview-identity.rudderhq.dev/callback",
        IDENTITY_MAIL_MODE: "supabase_smtp",
      }),
    ).toThrow("HTTPS origins only");
  });
});

describe("readSupabaseRootIdentityConfig", () => {
  it("uses a zero-configuration in-process fixture for development", () => {
    expect(readSupabaseRootIdentityConfig({
      baseUrl: "http://127.0.0.1:3200",
      releaseChannel: "development",
    }, {})).toEqual({
      environment: "fixture",
      callbackUrl: "http://127.0.0.1:3200/auth/callback",
      passwordResetUrl: "http://127.0.0.1:3200/reset-password",
      cookieName: "rudder_account",
      cookieSecure: false,
    });
  });

  it("requires hosted HTTPS Supabase Auth for preview and production", () => {
    expect(() => readSupabaseRootIdentityConfig({
      baseUrl: "https://accounts.rudderhq.dev",
      releaseChannel: "production",
    }, {})).toThrow("hosted Supabase Auth");

    expect(readSupabaseRootIdentityConfig({
      baseUrl: "https://accounts.rudderhq.dev",
      releaseChannel: "production",
    }, {
      IDENTITY_SUPABASE_URL: "https://qroqfgbaifzeqlygafjr.supabase.co",
      IDENTITY_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    })).toMatchObject({
      environment: "hosted",
      cookieName: "__Host-rudder_account",
      cookieSecure: true,
    });
  });

  it("selects an explicitly allowed hosted development Supabase pair", () => {
    expect(readSupabaseRootIdentityConfig({
      baseUrl: "http://127.0.0.1:3200",
      releaseChannel: "test",
    }, {
      IDENTITY_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      IDENTITY_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
      IDENTITY_SUPABASE_ALLOWED_DEV_PROJECT_REFS: "abcdefghijklmnopqrst",
    })).toMatchObject({
      environment: "hosted",
      projectUrl: "https://abcdefghijklmnopqrst.supabase.co",
    });
  });

  it("uses the real adapter for a complete local Supabase pair in development", () => {
    expect(readSupabaseRootIdentityConfig({
      baseUrl: "http://127.0.0.1:3200",
      releaseChannel: "development",
    }, {
      IDENTITY_SUPABASE_URL: "http://127.0.0.1:54321",
      IDENTITY_SUPABASE_PUBLISHABLE_KEY: "local-anon-key",
    })).toMatchObject({
      environment: "hosted",
      projectUrl: "http://127.0.0.1:54321",
      cookieSecure: false,
    });
  });

  it("rejects explicit fixture in preview and incomplete hosted configuration", () => {
    expect(() => readSupabaseRootIdentityConfig({
      baseUrl: "https://preview.accounts.rudderhq.dev",
      releaseChannel: "preview",
    }, {
      IDENTITY_SUPABASE_AUTH_ENVIRONMENT: "fixture",
    })).toThrow("hosted Supabase Auth");

    expect(() => readSupabaseRootIdentityConfig({
      baseUrl: "http://127.0.0.1:3200",
      releaseChannel: "development",
    }, {
      IDENTITY_SUPABASE_URL: "https://qroqfgbaifzeqlygafjr.supabase.co",
    })).toThrow("configured together");
  });

  it("locks preview to an explicit matching non-production project ref", () => {
    expect(() => readSupabaseRootIdentityConfig({
      baseUrl: "https://preview.accounts.rudderhq.dev",
      releaseChannel: "preview",
    }, {
      IDENTITY_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      IDENTITY_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    })).toThrow("EXPECTED_PROJECT_REF");

    expect(() => readSupabaseRootIdentityConfig({
      baseUrl: "https://preview.accounts.rudderhq.dev",
      releaseChannel: "preview",
    }, {
      IDENTITY_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      IDENTITY_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
      IDENTITY_SUPABASE_EXPECTED_PROJECT_REF: "zyxwvutsrqponmlkjihg",
    })).toThrow("expected project ref");

    expect(() => readSupabaseRootIdentityConfig({
      baseUrl: "https://preview.accounts.rudderhq.dev",
      releaseChannel: "preview",
    }, {
      IDENTITY_SUPABASE_URL: "https://qroqfgbaifzeqlygafjr.supabase.co",
      IDENTITY_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
      IDENTITY_SUPABASE_EXPECTED_PROJECT_REF: "qroqfgbaifzeqlygafjr",
    })).toThrow("separate from production");
  });

  it("hard-locks production to the Rudder production project ref", () => {
    expect(() => readSupabaseRootIdentityConfig({
      baseUrl: "https://accounts.rudderhq.dev",
      releaseChannel: "production",
    }, {
      IDENTITY_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      IDENTITY_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
      IDENTITY_SUPABASE_EXPECTED_PROJECT_REF: "abcdefghijklmnopqrst",
    })).toThrow("locked to Supabase project qroqfgbaifzeqlygafjr");

    expect(() => readSupabaseRootIdentityConfig({
      baseUrl: "https://accounts.rudderhq.dev",
      releaseChannel: "production",
    }, {
      IDENTITY_SUPABASE_URL: "https://qroqfgbaifzeqlygafjr.supabase.co",
      IDENTITY_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
      IDENTITY_SUPABASE_EXPECTED_PROJECT_REF: "abcdefghijklmnopqrst",
    })).toThrow("locked to Supabase project qroqfgbaifzeqlygafjr");
  });

  it("rejects production Supabase in development and unallowlisted hosted dev projects", () => {
    expect(() => readSupabaseRootIdentityConfig({
      baseUrl: "http://127.0.0.1:3200",
      releaseChannel: "development",
    }, {
      IDENTITY_SUPABASE_URL: "https://qroqfgbaifzeqlygafjr.supabase.co",
      IDENTITY_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
      IDENTITY_SUPABASE_ALLOWED_DEV_PROJECT_REFS: "qroqfgbaifzeqlygafjr",
    })).toThrow("must not connect to the production");

    expect(() => readSupabaseRootIdentityConfig({
      baseUrl: "http://127.0.0.1:3200",
      releaseChannel: "development",
    }, {
      IDENTITY_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      IDENTITY_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    })).toThrow("explicitly allowed");
  });

  it("rejects Supabase service-role and secret keys", () => {
    const serviceRolePayload = Buffer.from(JSON.stringify({ role: "service_role" }))
      .toString("base64url");
    for (const publishableKey of [
      "sb_secret_should-never-be-used",
      `header.${serviceRolePayload}.signature`,
    ]) {
      expect(() => readSupabaseRootIdentityConfig({
        baseUrl: "https://accounts.rudderhq.dev",
        releaseChannel: "production",
      }, {
        IDENTITY_SUPABASE_URL: "https://qroqfgbaifzeqlygafjr.supabase.co",
        IDENTITY_SUPABASE_PUBLISHABLE_KEY: publishableKey,
        IDENTITY_SUPABASE_EXPECTED_PROJECT_REF: "qroqfgbaifzeqlygafjr",
      })).toThrow("secret/service-role");
    }
  });
});
