import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  clearDesktopLocalSessionCookies,
  establishDesktopLocalSession,
  establishDesktopOfflineLocalSession,
  revokeDesktopLocalSessions,
} from "./identity-local-session.js";

describe("Desktop local account session", () => {
  it("removes both local Board session cookie variants on sign out", async () => {
    const removed: Array<[string, string]> = [];
    await clearDesktopLocalSessionCookies({
      localApiUrl: "http://127.0.0.1:3100/api",
      removeCookie: async (url, name) => {
        removed.push([url, name]);
      },
    });
    expect(removed).toEqual([
      ["http://127.0.0.1:3100", "better-auth.session_token"],
      ["http://127.0.0.1:3100", "__Secure-better-auth.session_token"],
    ]);
  });

  it("revokes every server-side local session before cookie cleanup", async () => {
    let receivedCookie = "";
    let receivedOrigin = "";
    const server = createServer((req, res) => {
      receivedCookie = req.headers.cookie ?? "";
      receivedOrigin = req.headers.origin ?? "";
      res.writeHead(
        receivedCookie.includes("better-auth.session_token=token.signature")
        && receivedOrigin === `http://127.0.0.1:${address.port}`
          ? 200
          : 401,
        {
        "content-type": "application/json",
        },
      );
      res.end(JSON.stringify({ revokedSessionCount: 2 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    try {
      await revokeDesktopLocalSessions({
        localApiUrl: `http://127.0.0.1:${address.port}/api`,
        getCookies: async () => [
          { name: "unrelated", value: "ignored" },
          { name: "better-auth.session_token", value: "token.signature" },
        ],
      });
      expect(receivedCookie).toBe("better-auth.session_token=token.signature");
      expect(receivedOrigin).toBe(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("exchanges once, installs an HttpOnly cookie, and claims legacy state", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ userId: "user-1" }), {
        status: 200,
        headers: {
          "set-cookie": "better-auth.session_token=token.signature; Path=/; HttpOnly; SameSite=Lax; Expires=Wed, 29 Jul 2026 12:00:00 GMT",
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "claimed" }), { status: 200 }));
    const installCookie = vi.fn(async () => undefined);

    await establishDesktopLocalSession({
      localApiUrl: "http://127.0.0.1:3100/api",
      exchangeCode: "exchange-code-at-least-sixteen",
      fetch,
      installCookie,
    });

    expect(installCookie).toHaveBeenCalledWith(expect.objectContaining({
      url: "http://127.0.0.1:3100",
      name: "better-auth.session_token",
      value: "token.signature",
      httpOnly: true,
      secure: false,
      sameSite: "lax",
    }));
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=token.signature",
        origin: "http://127.0.0.1:3100",
      },
    });
  });

  it("does not install a cookie when exchange is denied", async () => {
    const installCookie = vi.fn(async () => undefined);
    await expect(establishDesktopLocalSession({
      localApiUrl: "http://127.0.0.1:3100/api",
      exchangeCode: "exchange-code-at-least-sixteen",
      fetch: vi.fn(async () => new Response(null, { status: 401 })),
      installCookie,
    })).rejects.toThrow("exchange failed");
    expect(installCookie).not.toHaveBeenCalled();
  });

  it("repairs legacy state after establishing an Offline Grant session", async () => {
    const deviceKeys = generateKeyPairSync("ed25519");
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        userId: "user-1",
        nextTrustedTimeMs: 1_800_000_000_000,
      }), {
        status: 200,
        headers: {
          "set-cookie": "better-auth.session_token=offline.signature; Path=/; HttpOnly; SameSite=Lax",
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "already_claimed" }), { status: 200 }));
    const installCookie = vi.fn(async () => undefined);
    const updateTrustedTime = vi.fn();

    await establishDesktopOfflineLocalSession({
      localApiUrl: "http://127.0.0.1:3100/api",
      credential: {
        version: 1,
        issuer: "https://accounts.rudderhq.dev",
        accountId: "account-1",
        deviceId: "device-1",
        installationId: "installation-1",
        grant: "offline-grant",
        expiresAtMs: 1_900_000_000_000,
        keyId: "identity-key",
        identityPublicKeySpki: "identity-public-key",
        devicePrivateKeyPkcs8: deviceKeys.privateKey
          .export({ format: "der", type: "pkcs8" }).toString("base64url"),
        devicePublicKeySpki: deviceKeys.publicKey
          .export({ format: "der", type: "spki" }).toString("base64url"),
        trustedTimeMs: 1_700_000_000_000,
        signOutEpoch: 0,
      },
      nowMs: 1_750_000_000_000,
      fetch,
      installCookie,
      updateTrustedTime,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toEqual(new URL("http://127.0.0.1:3100/api/auth/local-claim"));
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=offline.signature",
        origin: "http://127.0.0.1:3100",
      },
    });
    expect(updateTrustedTime).toHaveBeenCalledWith(1_800_000_000_000);
  });
});
