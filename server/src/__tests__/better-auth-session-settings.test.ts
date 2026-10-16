import { afterEach, describe, expect, it, vi } from "vitest";
import { betterAuthSessionCookieSettings } from "../auth/better-auth.js";
import type { Config } from "../config.js";

function config(overrides: Partial<Config> = {}) {
  return {
    authBaseUrlMode: "auto",
    authPublicBaseUrl: null,
    ...overrides,
  } as Config;
}

afterEach(() => vi.unstubAllEnvs());

describe("Better Auth session-cookie settings", () => {
  it("uses the same secret precedence as the Better Auth instance", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "  exact Better Auth secret  ");
    vi.stubEnv("RUDDER_AGENT_JWT_SECRET", "fallback secret");
    expect(betterAuthSessionCookieSettings(config()).secret).toBe("  exact Better Auth secret  ");

    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(betterAuthSessionCookieSettings(config()).secret).toBe("");
    vi.stubEnv("BETTER_AUTH_SECRET", undefined);
    expect(betterAuthSessionCookieSettings(config()).secret).toBe("fallback secret");
  });

  it("matches Better Auth secure-cookie resolution without inferring HTTPS from an unrelated URL", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RUDDER_PUBLIC_URL", undefined);
    expect(betterAuthSessionCookieSettings(config({
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://auth.example.test",
    })).secureCookie).toBe(true);
    expect(betterAuthSessionCookieSettings(config({
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "http://auth.example.test",
    })).secureCookie).toBe(false);

    vi.stubEnv("RUDDER_PUBLIC_URL", "https://public.example.test");
    expect(betterAuthSessionCookieSettings(config()).secureCookie).toBe(false);
    vi.stubEnv("RUDDER_PUBLIC_URL", "http://public.example.test");
    expect(betterAuthSessionCookieSettings(config({
      authBaseUrlMode: "explicit",
      authPublicBaseUrl: "https://auth.example.test",
    })).secureCookie).toBe(false);

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RUDDER_PUBLIC_URL", undefined);
    expect(betterAuthSessionCookieSettings(config()).secureCookie).toBe(true);
  });
});
