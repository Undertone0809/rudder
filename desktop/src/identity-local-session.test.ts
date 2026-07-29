import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  clearDesktopLocalSessionCookies,
  establishDesktopLocalSession,
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
    const server = createServer((req, res) => {
      receivedCookie = req.headers.cookie ?? "";
      res.writeHead(receivedCookie.includes("better-auth.session_token=token.signature") ? 200 : 401, {
        "content-type": "application/json",
      });
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
      headers: { cookie: "better-auth.session_token=token.signature" },
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
});
