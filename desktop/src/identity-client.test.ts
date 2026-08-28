import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDesktopSignInIntent, createDesktopIdentityClient } from "./identity-client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Desktop Identity client", () => {
  it("adds only an opaque intent to the PKCE authorize URL", () => {
    const authorize = applyDesktopSignInIntent(
      new URL("https://accounts.rudderhq.dev/api/desktop/authorize?state=opaque"),
      "opaque_intent_with_enough_random_material",
    );
    expect(authorize.searchParams.get("login_intent")).toBe(
      "opaque_intent_with_enough_random_material",
    );
    expect(authorize.searchParams.has("login_method")).toBe(false);
    expect(authorize.searchParams.has("login_email")).toBe(false);
    expect(authorize.searchParams.get("state")).toBe("opaque");
    expect(() => applyDesktopSignInIntent(
      new URL("https://accounts.rudderhq.dev/api/desktop/authorize"),
      "not valid!",
    )).toThrow("invalid sign-in intent");
  });

  it("rejects insecure non-local issuers", () => {
    expect(() => createDesktopIdentityClient({
      identityOrigin: "http://accounts.example.com",
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: vi.fn(() => null), write: vi.fn(), clear: vi.fn() },
      openExternal: vi.fn(),
    })).toThrow("must use HTTPS");
  });

  it("reads public Identity provider capabilities without credentials", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      providers: { emailOtp: true, password: true, google: false, github: true },
    }), { status: 200 }));
    const client = createDesktopIdentityClient({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: vi.fn(() => null), write: vi.fn(), clear: vi.fn() },
      openExternal: vi.fn(),
      fetch,
    });

    await expect(client.getAuthProviders()).resolves.toEqual({ google: false, github: true });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://accounts.rudderhq.dev/api/health"),
      expect.objectContaining({
        headers: { accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("keeps production provider choices visible when the capability probe is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const client = createDesktopIdentityClient({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: vi.fn(() => null), write: vi.fn(), clear: vi.fn() },
      openExternal: vi.fn(),
      fetch,
      authProviderFallback: { google: true, github: true },
    });

    await expect(client.getAuthProviders()).resolves.toEqual({ google: true, github: true });
  });

  it("keeps providers visible when a health response omits capability fields", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ providers: { emailOtp: true } }), { status: 200 }));
    const client = createDesktopIdentityClient({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: vi.fn(() => null), write: vi.fn(), clear: vi.fn() },
      openExternal: vi.fn(),
      fetch,
      authProviderFallback: { google: true, github: true },
    });

    await expect(client.getAuthProviders()).resolves.toEqual({ google: true, github: true });
  });

  it("uses the production fallback for an unavailable health response", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi.fn(async () => new Response("service unavailable", { status: 503 }));
    const client = createDesktopIdentityClient({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: vi.fn(() => null), write: vi.fn(), clear: vi.fn() },
      openExternal: vi.fn(),
      fetch,
      authProviderFallback: { google: true, github: true },
    });

    await expect(client.getAuthProviders()).resolves.toEqual({ google: true, github: true });
  });

  it("binds account-linked telemetry assertions to the consented local user", async () => {
    const stored = {
      version: 1 as const,
      issuer: "https://accounts.rudderhq.dev",
      accountId: "account-1",
      accountEmail: "river@rudderhq.dev",
      accountName: "River Alvarez",
      deviceId: "device-1",
      refreshToken: "refresh-old",
      refreshTokenExpiresAt: "2026-08-29T00:00:00.000Z",
    };
    const assertion = "a".repeat(32);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-new",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "refresh-new",
        account: { id: "account-1", email: "river@rudderhq.dev", name: "River Alvarez", image: null },
        device: { id: "device-1", installationId: "installation-1", displayName: "Test Mac" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ assertion }), { status: 200 }));
    const client = createDesktopIdentityClient({
      identityOrigin: stored.issuer,
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: () => stored, write: vi.fn(), clear: vi.fn() },
      openExternal: vi.fn(),
      fetch,
    });

    await expect(client.issueProductAnalyticsAssertion({
      mode: "account_linked",
      consentVersion: "v1",
      consentEpoch: 3,
      pseudonymousInstallationId: "b".repeat(64),
      consentedLocalUserId: "user-a",
    })).resolves.toBe(`Bearer ${assertion}`);

    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      installation_id: "installation-1",
      mode: "account_linked",
      consented_local_user_id: "user-a",
    });
  });

  it("clears the credential vault on local sign-out", async () => {
    const clear = vi.fn();
    const client = createDesktopIdentityClient({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: vi.fn(() => null), write: vi.fn(), clear },
      openExternal: vi.fn(),
    });

    await client.signOut();

    expect(clear).toHaveBeenCalledOnce();
  });

  it("completes local sign-out when stale credential file cleanup fails", async () => {
    const offlineSignOut = vi.fn(() => {
      throw new Error("offline file is locked");
    });
    const clear = vi.fn(() => {
      throw new Error("credential file is locked");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createDesktopIdentityClient({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: vi.fn(() => null), write: vi.fn(), clear },
      offlineGrantStore: {
        prepareDeviceKey: vi.fn(() => null),
        acceptGrant: vi.fn(),
        signOut: offlineSignOut,
      },
      openExternal: vi.fn(),
    });

    await expect(client.signOut()).resolves.toBeUndefined();

    expect(offlineSignOut).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "[rudder-desktop] local account credentials could not be fully removed",
      expect.objectContaining({ message: "offline file is locked" }),
      expect.objectContaining({ message: "credential file is locked" }),
    );
  });

  it("rotates the encrypted refresh credential before listing device sessions", async () => {
    const stored = {
      version: 1 as const,
      issuer: "https://accounts.rudderhq.dev",
      accountId: "account-1",
      accountEmail: "river@rudderhq.dev",
      accountName: "River Alvarez",
      deviceId: "device-1",
      refreshToken: "refresh-old",
      refreshTokenExpiresAt: "2026-08-29T00:00:00.000Z",
    };
    const write = vi.fn();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-new",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "refresh-new",
        account: { id: "account-1", email: "river@rudderhq.dev", name: "River Alvarez", image: null },
        device: { id: "device-1", installationId: "installation-1", displayName: "Test Mac" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        devices: [{
          id: "device-1",
          displayName: "Test Mac",
          createdAt: "2026-07-29T00:00:00.000Z",
          lastSeenAt: "2026-07-29T01:00:00.000Z",
          revokedAt: null,
          current: true,
        }],
      }), { status: 200 }));
    const client = createDesktopIdentityClient({
      identityOrigin: stored.issuer,
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: () => stored, write, clear: vi.fn() },
      openExternal: vi.fn(),
      fetch,
    });

    await expect(client.listDeviceSessions()).resolves.toEqual([{
      id: "device-1",
      name: "Test Mac",
      platform: null,
      createdAt: "2026-07-29T00:00:00.000Z",
      lastSeenAt: "2026-07-29T01:00:00.000Z",
      current: true,
    }]);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "refresh-new" }));
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      headers: { authorization: "Bearer access-new" },
    });
  });

  it("persists the refreshed account avatar and falls back to it when profile is not deployed", async () => {
    const avatar = "https://lh3.googleusercontent.com/a/avatar";
    let stored = {
      version: 1 as const,
      issuer: "https://accounts.rudderhq.dev",
      accountId: "account-1",
      accountEmail: "river@rudderhq.dev",
      accountName: "River Alvarez",
      deviceId: "device-1",
      refreshToken: "refresh-old",
      refreshTokenExpiresAt: "2026-08-29T00:00:00.000Z",
    };
    const write = vi.fn((next) => { stored = next; });
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-new",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "refresh-new",
        account: { id: "account-1", email: "river@rudderhq.dev", name: "River Alvarez", image: avatar },
        device: { id: "device-1", installationId: "installation-1", displayName: "Test Mac" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not_found" }), { status: 404 }));
    const client = createDesktopIdentityClient({
      identityOrigin: stored.issuer,
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: () => stored, write, clear: vi.fn() },
      openExternal: vi.fn(),
      fetch,
    });

    await expect(client.getProfile()).resolves.toEqual({
      id: "account-1",
      email: "river@rudderhq.dev",
      name: "River Alvarez",
      image: avatar,
    });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      refreshToken: "refresh-new",
      accountImage: avatar,
    }));
  });

  it("persists successful profile reads and updates without replacing the refresh credential", async () => {
    const originalAvatar = "https://example.test/original.png";
    const updatedAvatar = "data:image/png;base64,AAAA";
    let stored = {
      version: 1 as const,
      issuer: "https://accounts.rudderhq.dev",
      accountId: "account-1",
      accountEmail: "river@rudderhq.dev",
      accountName: "River Alvarez",
      accountImage: originalAvatar,
      deviceId: "device-1",
      refreshToken: "refresh-old",
      refreshTokenExpiresAt: "2026-08-29T00:00:00.000Z",
    };
    const write = vi.fn((next) => { stored = next; });
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-new",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "refresh-new",
        account: { id: "account-1", email: "river@rudderhq.dev", name: "River Alvarez", image: originalAvatar },
        device: { id: "device-1", installationId: "installation-1", displayName: "Test Mac" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "account-1", email: "river@rudderhq.dev", name: "River", image: originalAvatar,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "account-1", email: "river@rudderhq.dev", name: "River", image: updatedAvatar,
      }), { status: 200 }));
    const client = createDesktopIdentityClient({
      identityOrigin: stored.issuer,
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: () => stored, write, clear: vi.fn() },
      openExternal: vi.fn(),
      fetch,
    });

    await expect(client.getProfile()).resolves.toMatchObject({ name: "River", image: originalAvatar });
    await expect(client.updateProfile({ image: updatedAvatar })).resolves.toMatchObject({ image: updatedAvatar });
    expect(stored).toMatchObject({
      accountName: "River",
      accountImage: updatedAvatar,
      refreshToken: "refresh-new",
    });
  });

  it("refreshes the device token and requests a one-time local server exchange", async () => {
    const stored = {
      version: 1 as const,
      issuer: "https://accounts.rudderhq.dev",
      accountId: "account-1",
      accountEmail: "river@rudderhq.dev",
      accountName: "River Alvarez",
      deviceId: "device-1",
      refreshToken: "refresh-old",
      refreshTokenExpiresAt: "2026-08-29T00:00:00.000Z",
    };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-new",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "refresh-new",
        account: { id: "account-1", email: "river@rudderhq.dev", name: "River Alvarez", image: null },
        device: { id: "device-1", installationId: "installation-1", displayName: "Test Mac" },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: "one-time-server-exchange-code",
        expires_in: 60,
      }), { status: 200 }));
    const client = createDesktopIdentityClient({
      identityOrigin: stored.issuer,
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: () => stored, write: vi.fn(), clear: vi.fn() },
      openExternal: vi.fn(),
      fetch,
    });

    await expect(client.createServerExchange("installation-1"))
      .resolves.toBe("one-time-server-exchange-code");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      installation_id: "installation-1",
      audience: "installation-1",
    });
  });

  it("single-flights refresh rotation across concurrent account requests", async () => {
    let credential = {
      version: 1 as const,
      issuer: "https://accounts.rudderhq.dev",
      accountId: "account-1",
      accountEmail: "river@rudderhq.dev",
      accountName: "River Alvarez",
      deviceId: "device-1",
      refreshToken: "refresh-old",
      refreshTokenExpiresAt: "2026-08-29T00:00:00.000Z",
    };
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/api/desktop/refresh")) {
        await refreshGate;
        return new Response(JSON.stringify({
          access_token: "access-new",
          token_type: "Bearer",
          expires_in: 900,
          refresh_token: "refresh-new",
          account: { id: "account-1", email: "river@rudderhq.dev", name: "River Alvarez", image: null },
          device: { id: "device-1", installationId: "installation-1", displayName: "Test Mac" },
        }), { status: 200 });
      }
      if (url.endsWith("/api/account/devices")) {
        return new Response(JSON.stringify({ devices: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "one-time-server-exchange-code" }), { status: 200 });
    });
    const client = createDesktopIdentityClient({
      identityOrigin: credential.issuer,
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: {
        read: () => credential,
        write: (next) => { credential = next; },
        clear: vi.fn(),
      },
      openExternal: vi.fn(),
      fetch,
    });

    const devices = client.listDeviceSessions();
    const exchange = client.createServerExchange("installation-1");
    releaseRefresh();
    await expect(Promise.all([devices, exchange])).resolves.toEqual([
      [],
      "one-time-server-exchange-code",
    ]);
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/api/desktop/refresh")))
      .toHaveLength(1);
    expect(credential.refreshToken).toBe("refresh-new");
  });

  it.each([
    [429, "rate_limited"],
    [503, "internal_server_error"],
    [500, "invalid_grant"],
  ])(
    "preserves refresh and Offline Grant credentials on transient Identity %s",
    async (status, error) => {
      const stored = {
        version: 1 as const,
        issuer: "https://accounts.rudderhq.dev",
        accountId: "account-1",
        accountEmail: "river@rudderhq.dev",
        accountName: "River Alvarez",
        deviceId: "device-1",
        refreshToken: "refresh-old",
        refreshTokenExpiresAt: "2026-08-29T00:00:00.000Z",
      };
      const clear = vi.fn();
      const signOut = vi.fn();
      const client = createDesktopIdentityClient({
        identityOrigin: stored.issuer,
        installationId: "installation-1",
        deviceName: "Test Mac",
        vault: { read: () => stored, write: vi.fn(), clear },
        offlineGrantStore: {
          prepareDeviceKey: vi.fn(() => null),
          acceptGrant: vi.fn(),
          signOut,
        },
        openExternal: vi.fn(),
        fetch: vi.fn(async () => new Response(
          JSON.stringify({ error }),
          { status },
        )),
      });

      await expect(client.listDeviceSessions()).rejects.toMatchObject({
        code: "IDENTITY_UNAVAILABLE",
      });
      expect(clear).not.toHaveBeenCalled();
      expect(signOut).not.toHaveBeenCalled();
    },
  );

  it("preserves credentials and normalizes a refresh network failure", async () => {
    const stored = {
      version: 1 as const,
      issuer: "https://accounts.rudderhq.dev",
      accountId: "account-1",
      accountEmail: "river@rudderhq.dev",
      accountName: "River Alvarez",
      deviceId: "device-1",
      refreshToken: "refresh-old",
      refreshTokenExpiresAt: "2026-08-29T00:00:00.000Z",
    };
    const clear = vi.fn();
    const signOut = vi.fn();
    const client = createDesktopIdentityClient({
      identityOrigin: stored.issuer,
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: () => stored, write: vi.fn(), clear },
      offlineGrantStore: {
        prepareDeviceKey: vi.fn(() => null),
        acceptGrant: vi.fn(),
        signOut,
      },
      openExternal: vi.fn(),
      fetch: vi.fn(async () => {
        throw new TypeError("network unavailable");
      }),
    });

    await expect(client.listDeviceSessions()).rejects.toMatchObject({
      code: "IDENTITY_UNAVAILABLE",
    });
    expect(clear).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("clears refresh and Offline Grant credentials only on explicit invalid_grant", async () => {
    const stored = {
      version: 1 as const,
      issuer: "https://accounts.rudderhq.dev",
      accountId: "account-1",
      accountEmail: "river@rudderhq.dev",
      accountName: "River Alvarez",
      deviceId: "device-1",
      refreshToken: "refresh-old",
      refreshTokenExpiresAt: "2026-08-29T00:00:00.000Z",
    };
    const clear = vi.fn();
    const signOut = vi.fn();
    const client = createDesktopIdentityClient({
      identityOrigin: stored.issuer,
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: () => stored, write: vi.fn(), clear },
      offlineGrantStore: {
        prepareDeviceKey: vi.fn(() => null),
        acceptGrant: vi.fn(),
        signOut,
      },
      openExternal: vi.fn(),
      fetch: vi.fn(async () => new Response(
        JSON.stringify({ error: "invalid_grant" }),
        { status: 400 },
      )),
    });

    await expect(client.listDeviceSessions()).rejects.toMatchObject({
      code: "IDENTITY_SESSION_REJECTED",
    });
    expect(clear).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledOnce();
  });

  it("keeps email OTP native and exchanges only a Rudder PKCE code", async () => {
    const openExternal = vi.fn(async () => undefined);
    const write = vi.fn();
    const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/desktop/native-auth/email-otp/send") {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.pathname === "/api/desktop/native-auth/password/reset/request") {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (url.pathname === "/api/desktop/native-auth/email-otp/verify") {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          client_id: "rudder-desktop",
          email: "river@example.com",
          token: "123456",
          code_challenge_method: "S256",
          audience: "installation-1",
        });
        expect(body.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
        expect(init?.headers).toEqual({ "content-type": "application/json" });
        return new Response(JSON.stringify({ code: "rudder-one-time-authorization-code" }), { status: 200 });
      }
      if (url.pathname === "/api/desktop/token") {
        return new Response(JSON.stringify({
          access_token: "access-new",
          token_type: "Bearer",
          expires_in: 900,
          refresh_token: "refresh-new",
          account: { id: "account-1", email: "river@example.com", name: "River", image: null },
          device: { id: "device-1", installationId: "installation-1", displayName: "Test Mac" },
        }), { status: 200 });
      }
      throw new Error(`Unexpected Identity request: ${url.pathname}`);
    });
    const client = createDesktopIdentityClient({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: vi.fn(() => null), write, clear: vi.fn() },
      openExternal,
      fetch,
    });

    await client.sendEmailOtp("river@example.com");
    await client.requestPasswordReset("river@example.com");
    await expect(client.nativeSignIn({
      method: "email_otp",
      email: "river@example.com",
      token: "123456",
    })).resolves.toMatchObject({ account: { id: "account-1" }, device: { id: "device-1" } });

    expect(openExternal).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "refresh-new" }));
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/api/desktop/native-auth/email-otp/send",
      "/api/desktop/native-auth/password/reset/request",
      "/api/desktop/native-auth/email-otp/verify",
      "/api/desktop/token",
    ]);
  });

  it.each([
    [{ method: "password" as const, email: "river@example.com", password: "valid-password" }, "/api/desktop/native-auth/password/sign-in"],
    [{
      method: "password_reset" as const,
      email: "river@example.com",
      token: "123456",
      newPassword: "replacement-password",
    }, "/api/desktop/native-auth/password/reset/confirm"],
  ])("keeps %s native without an OS browser handoff", async (input, expectedPath) => {
    const openExternal = vi.fn(async () => undefined);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ code: "rudder-one-time-authorization-code" }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-new",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "refresh-new",
        account: { id: "account-1", email: "river@example.com", name: "River", image: null },
        device: { id: "device-1", installationId: "installation-1", displayName: "Test Mac" },
      }), { status: 200 }));
    const client = createDesktopIdentityClient({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: vi.fn(() => null), write: vi.fn(), clear: vi.fn() },
      openExternal,
      fetch,
    });

    await client.nativeSignIn(input);

    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname).toBe(expectedPath);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("continues Google OAuth in the system browser with PKCE loopback", async () => {
    const fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/desktop/sign-in-intent") {
        return new Response(JSON.stringify({ intent: "opaque_intent_with_enough_random_material" }), { status: 200 });
      }
      if (url.pathname === "/api/desktop/token") {
        return new Response(JSON.stringify({
          access_token: "access-new",
          token_type: "Bearer",
          expires_in: 900,
          refresh_token: "refresh-new",
          account: { id: "account-1", email: "river@example.com", name: "River", image: null },
          device: { id: "device-1", installationId: "installation-1", displayName: "Test Mac" },
        }), { status: 200 });
      }
      throw new Error(`Unexpected Identity request: ${url.pathname}`);
    });
    const openExternal = vi.fn(async (target: string) => {
      const login = new URL(target);
      expect(login.origin).toBe("https://accounts.rudderhq.dev");
      expect(login.pathname).toBe("/");
      const authorize = new URL(login.searchParams.get("next")!, login.origin);
      expect(authorize.pathname).toBe("/api/desktop/authorize");
      expect(authorize.searchParams.get("login_intent")).toBe("opaque_intent_with_enough_random_material");
      const callback = new URL(authorize.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "browser-rudder-authorization-code");
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      await globalThis.fetch(callback);
    });
    const client = createDesktopIdentityClient({
      identityOrigin: "https://accounts.rudderhq.dev",
      installationId: "installation-1",
      deviceName: "Test Mac",
      vault: { read: vi.fn(() => null), write: vi.fn(), clear: vi.fn() },
      openExternal,
      fetch,
    });

    await expect(client.signIn({ method: "google" })).resolves.toMatchObject({
      account: { id: "account-1" },
    });
    expect(openExternal).toHaveBeenCalledOnce();
  });
});
