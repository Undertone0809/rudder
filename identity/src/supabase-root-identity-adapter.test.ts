import { describe, expect, it, vi } from "vitest";
import type { SupabaseRootIdentityConfig } from "./config.js";
import type {
  RootIdentityCookieMutation,
  RootIdentityRequestContext,
} from "./root-identity-adapter.js";
import { createSupabaseRootIdentityAdapter } from "./supabase-root-identity-adapter.js";

const config: Extract<SupabaseRootIdentityConfig, { environment: "hosted" }> = {
  environment: "hosted",
  projectUrl: "https://project.supabase.co",
  publishableKey: "sb_publishable_test",
  callbackUrl: "https://accounts.rudderhq.dev/auth/callback",
  passwordResetUrl: "https://accounts.rudderhq.dev/reset-password",
  cookieName: "__Host-rudder_account",
  cookieSecure: true,
};

const verifiedUser = {
  id: "b6b65953-cfee-44a0-a01e-18bd1a82d227",
  aud: "authenticated",
  role: "authenticated",
  email: "User@Example.COM",
  email_confirmed_at: "2026-07-30T01:00:00.000Z",
  phone: "",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {
    full_name: "Rudder User",
    avatar_url: "https://example.com/avatar.png",
  },
  identities: [],
  created_at: "2026-07-30T01:00:00.000Z",
  updated_at: "2026-07-30T01:00:00.000Z",
};

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function sessionCookie(): string {
  const session = {
    access_token: jwt({
      sub: verifiedUser.id,
      role: "authenticated",
      session_id: "92c29e2e-14b0-4f3a-93b6-c2a9ff0f1f0d",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "refresh-token",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    user: verifiedUser,
  };
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

function requestContext(cookie?: string) {
  const cookieBatches: {
    cookies: RootIdentityCookieMutation[];
    responseHeaders: Readonly<Record<string, string>>;
  }[] = [];
  const requestHeaders = new Headers(cookie ? { cookie } : undefined);
  const context: RootIdentityRequestContext = {
    requestHeaders,
    setCookies: (cookies, responseHeaders) => {
      cookieBatches.push({ cookies, responseHeaders });
    },
  };
  return { context, cookieBatches };
}

function sessionResponse(): Record<string, unknown> {
  return {
    access_token: jwt({
      sub: verifiedUser.id,
      role: "authenticated",
      session_id: "92c29e2e-14b0-4f3a-93b6-c2a9ff0f1f0d",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    refresh_token: "new-refresh-token",
    expires_in: 3600,
    token_type: "bearer",
    user: verifiedUser,
  };
}

describe("createSupabaseRootIdentityAdapter", () => {
  it("returns no principal when the request has no root-auth cookie", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const adapter = createSupabaseRootIdentityAdapter(config, { fetch: fetchMock });
    const { context } = requestContext();

    await expect(adapter.getPrincipal(context)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates the cookie session with the Supabase user endpoint", async () => {
    const requests: Request[] = [];
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(verifiedUser);
    });
    const adapter = createSupabaseRootIdentityAdapter(config, { fetch: fetchMock });
    const { context } = requestContext(
      `${config.cookieName}=${encodeURIComponent(sessionCookie())}`,
    );

    await expect(adapter.getPrincipal(context)).resolves.toEqual({
      id: verifiedUser.id,
      email: "user@example.com",
      emailVerified: true,
      displayName: "Rudder User",
      avatarUrl: "https://example.com/avatar.png",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://project.supabase.co/auth/v1/user");
    expect(requests[0]!.headers.get("authorization")).toContain("Bearer ");
  });

  it("never accepts an unverified email as a Rudder principal", async () => {
    const fetchMock: typeof fetch = vi.fn(async () =>
      Response.json({ ...verifiedUser, email_confirmed_at: null }),
    );
    const adapter = createSupabaseRootIdentityAdapter(config, { fetch: fetchMock });
    const { context } = requestContext(
      `${config.cookieName}=${encodeURIComponent(sessionCookie())}`,
    );

    await expect(adapter.getPrincipal(context)).resolves.toBeNull();
  });

  it("does not disguise a provider outage as a signed-out session", async () => {
    const fetchMock: typeof fetch = vi.fn(async () => {
      throw new Error("fixture provider unavailable");
    });
    const adapter = createSupabaseRootIdentityAdapter(config, { fetch: fetchMock });
    const { context } = requestContext(
      `${config.cookieName}=${encodeURIComponent(sessionCookie())}`,
    );

    await expect(adapter.getPrincipal(context)).rejects.toThrow("fixture provider unavailable");
  });

  it("fails closed when a sensitive action cannot confirm the active session row", async () => {
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      return new URL(request.url).pathname === "/auth/v1/user"
        ? Response.json(verifiedUser)
        : Response.json({});
    });
    const { context } = requestContext(
      `${config.cookieName}=${encodeURIComponent(sessionCookie())}`,
    );

    await expect(
      createSupabaseRootIdentityAdapter(config, { fetch: fetchMock })
        .requireActivePrincipal(context),
    ).rejects.toMatchObject({
      code: "active_session_verification_unavailable",
      status: 503,
    });

    await expect(
      createSupabaseRootIdentityAdapter(config, {
        activeSessionVerifier: async () => false,
        fetch: fetchMock,
      }).requireActivePrincipal(context),
    ).rejects.toMatchObject({ code: "session_revoked", status: 401 });
  });

  it("creates provider-neutral OAuth PKCE redirects with HttpOnly host cookies", async () => {
    const adapter = createSupabaseRootIdentityAdapter(config);
    const { context, cookieBatches } = requestContext();

    const result = await adapter.beginOAuth(context, {
      provider: "github",
      nextPath: "/api/desktop/authorize?state=local-state",
    });

    const redirect = new URL(result.redirectUrl);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(
      "https://project.supabase.co/auth/v1/authorize",
    );
    expect(redirect.searchParams.get("provider")).toBe("github");
    expect(redirect.searchParams.get("code_challenge_method")).toBe("s256");
    const callback = new URL(redirect.searchParams.get("redirect_to")!);
    expect(callback.pathname).toBe("/auth/callback");
    expect(callback.searchParams.get("next")).toBe(
      "/api/desktop/authorize?state=local-state",
    );
    expect(callback.searchParams.get("sb_flow_id")).toMatch(/^[A-Za-z0-9_-]{8,64}$/u);
    const writtenCookies = cookieBatches.flatMap((batch) => batch.cookies);
    expect(writtenCookies.length).toBeGreaterThan(0);
    expect(writtenCookies.every(({ options }) =>
      options.httpOnly === true &&
      options.secure === true &&
      options.sameSite === "lax" &&
      options.path === "/" &&
      options.domain === undefined
    )).toBe(true);
    expect(cookieBatches.at(-1)?.responseHeaders["cache-control"]).toContain("no-store");
  });

  it("rejects cross-origin OAuth continuation paths", async () => {
    const adapter = createSupabaseRootIdentityAdapter(config);
    const { context } = requestContext();
    for (const nextPath of [
      "//attacker.example/callback",
      "/api/internal/not-an-auth-continuation",
    ]) {
      await expect(adapter.beginOAuth(context, {
        provider: "google",
        nextPath,
      })).rejects.toMatchObject({ code: "invalid_redirect" });
    }
  });

  it("uses Supabase OTP and password endpoints and writes only secure cookies", async () => {
    const requests: Request[] = [];
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/auth/v1/user") return Response.json(verifiedUser);
      if (
        url.pathname === "/auth/v1/verify" ||
        (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password")
      ) {
        return Response.json(sessionResponse());
      }
      return Response.json({});
    });
    const adapter = createSupabaseRootIdentityAdapter(config, { fetch: fetchMock });

    const otp = requestContext();
    await adapter.sendEmailOtp(otp.context, { email: " USER@example.com " });
    await expect(adapter.verifyEmailOtp(otp.context, {
      email: " USER@example.com ",
      token: "123456",
      purpose: "sign-in",
    })).resolves.toMatchObject({ id: verifiedUser.id, emailVerified: true });
    await expect(adapter.verifyEmailOtp(otp.context, {
      email: " USER@example.com ",
      token: "234567",
      purpose: "email-verification",
    })).resolves.toMatchObject({ id: verifiedUser.id, emailVerified: true });

    const password = requestContext();
    await expect(adapter.signInWithPassword(password.context, {
      email: " USER@example.com ",
      password: "correct horse battery staple",
    })).resolves.toMatchObject({ id: verifiedUser.id, emailVerified: true });

    const paths = requests.map((request) => new URL(request.url).pathname);
    expect(paths).toContain("/auth/v1/otp");
    expect(paths).toContain("/auth/v1/verify");
    expect(paths).toContain("/auth/v1/token");
    const verifyTypes = await Promise.all(
      requests
        .filter((request) => new URL(request.url).pathname === "/auth/v1/verify")
        .map(async (request) => {
          const body = await request.clone().json() as { type?: string };
          return body.type;
        }),
    );
    expect(verifyTypes).toEqual(["email", "signup"]);
    const writtenCookies = [...otp.cookieBatches, ...password.cookieBatches]
      .flatMap((batch) => batch.cookies);
    expect(writtenCookies.length).toBeGreaterThan(0);
    expect(writtenCookies.every(({ options }) =>
      options.httpOnly === true && options.secure === true
    )).toBe(true);
  });

  it.each([
    ["current", "local"],
    ["others", "others"],
    ["global", "global"],
  ] as const)("maps %s sign-out to Supabase %s scope", async (scope, expectedScope) => {
    const requests: Request[] = [];
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return new URL(request.url).pathname === "/auth/v1/user"
        ? Response.json(verifiedUser)
        : Response.json({});
    });
    const activeSessionVerifier = vi.fn(async () => true);
    const adapter = createSupabaseRootIdentityAdapter(config, {
      activeSessionVerifier,
      fetch: fetchMock,
    });
    const { context } = requestContext(
      `${config.cookieName}=${encodeURIComponent(sessionCookie())}`,
    );

    await adapter.signOut(context, scope);
    const logout = requests.find((request) =>
      new URL(request.url).pathname === "/auth/v1/logout"
    );
    expect(logout).toBeDefined();
    expect(new URL(logout!.url).searchParams.get("scope")).toBe(expectedScope);
    expect(activeSessionVerifier).toHaveBeenCalledWith({
      userId: verifiedUser.id,
      sessionId: "92c29e2e-14b0-4f3a-93b6-c2a9ff0f1f0d",
    });
  });

  it("routes PKCE callback, password lifecycle, and recovery through Supabase Auth", async () => {
    const requests: Request[] = [];
    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/auth/v1/user") {
        return request.method === "PUT"
          ? Response.json({ user: verifiedUser })
          : Response.json(verifiedUser);
      }
      if (
        url.pathname === "/auth/v1/token" ||
        url.pathname === "/auth/v1/signup" ||
        url.pathname === "/auth/v1/verify"
      ) {
        return Response.json(sessionResponse());
      }
      if (url.pathname === "/auth/v1/reauthenticate") {
        return Response.json({ user: verifiedUser });
      }
      return Response.json({});
    });
    const adapter = createSupabaseRootIdentityAdapter(config, {
      activeSessionVerifier: async () => true,
      fetch: fetchMock,
    });

    const callbackStart = requestContext();
    const oauthRedirect = await adapter.beginOAuth(callbackStart.context, { provider: "google" });
    const verifierCookie = callbackStart.cookieBatches
      .flatMap((batch) => batch.cookies)
      .filter(({ value, options }) => value && options.maxAge !== 0)
      .map(({ name, value }) => `${name}=${encodeURIComponent(value)}`)
      .join("; ");
    expect(verifierCookie).not.toBe("");
    const callback = requestContext(verifierCookie);
    const callbackUrl = new URL(new URL(oauthRedirect.redirectUrl).searchParams.get("redirect_to")!);
    await expect(adapter.completePkceCallback(callback.context, {
      code: "supabase-pkce-code",
      flowId: callbackUrl.searchParams.get("sb_flow_id") ?? undefined,
    })).resolves.toMatchObject({ id: verifiedUser.id });

    const signUp = requestContext();
    await expect(adapter.signUpWithPassword(signUp.context, {
      email: "user@example.com",
      password: "correct horse battery staple",
    })).resolves.toMatchObject({
      principal: { id: verifiedUser.id },
      verificationRequired: false,
    });

    const recovery = requestContext();
    await adapter.requestPasswordReset(recovery.context, {
      email: "user@example.com",
    });
    await expect(adapter.resetPasswordWithOtp(recovery.context, {
      email: "user@example.com",
      token: "345678",
      newPassword: "recovered correct horse battery staple",
    }, async () => undefined)).resolves.toMatchObject({ id: verifiedUser.id });
    const recoveryVerifierCookie = recovery.cookieBatches
      .flatMap((batch) => batch.cookies)
      .filter(({ value, options }) => value && options.maxAge !== 0)
      .map(({ name, value }) => `${name}=${encodeURIComponent(value)}`)
      .join("; ");
    await expect(adapter.completePasswordRecovery(
      requestContext(recoveryVerifierCookie).context,
      {
      code: "supabase-recovery-pkce-code",
      },
    )).resolves.toMatchObject({ id: verifiedUser.id });
    await expect(adapter.completePasswordRecovery(requestContext().context, {
      tokenHash: "supabase-recovery-token-hash",
    })).resolves.toMatchObject({ id: verifiedUser.id });

    const authenticated = requestContext(
      `${config.cookieName}=${encodeURIComponent(sessionCookie())}`,
    );
    await adapter.requestPasswordChangeVerification(authenticated.context);
    const beforePasswordMutation = vi.fn(async () => undefined);
    await expect(adapter.updatePassword(authenticated.context, {
      newPassword: "new correct horse battery staple",
      verificationCode: "654321",
      revokeOthers: true,
    }, beforePasswordMutation)).resolves.toMatchObject({ id: verifiedUser.id });
    expect(beforePasswordMutation).toHaveBeenCalledWith(
      expect.objectContaining({ id: verifiedUser.id }),
    );
    await expect(adapter.updateRecoveredPassword(authenticated.context, {
      newPassword: "recovery page correct horse battery staple",
    }, async () => undefined)).resolves.toMatchObject({ id: verifiedUser.id });

    const pathAndGrant = requests.map((request) => {
      const url = new URL(request.url);
      return `${request.method} ${url.pathname}?grant_type=${url.searchParams.get("grant_type") ?? ""}`;
    });
    expect(pathAndGrant).toContain("POST /auth/v1/token?grant_type=pkce");
    const oauthUserRequest = requests.find((request) =>
      request.method === "GET" && new URL(request.url).pathname === "/auth/v1/user"
    );
    expect(oauthUserRequest?.headers.get("authorization")).toBe(
      `Bearer ${String(sessionResponse().access_token)}`,
    );
    expect(pathAndGrant).toContain("POST /auth/v1/signup?grant_type=");
    expect(pathAndGrant).toContain("POST /auth/v1/recover?grant_type=");
    expect(pathAndGrant).toContain("POST /auth/v1/verify?grant_type=");
    expect(pathAndGrant).toContain("GET /auth/v1/reauthenticate?grant_type=");
    expect(pathAndGrant).toContain("PUT /auth/v1/user?grant_type=");
    expect(pathAndGrant).toContain("POST /auth/v1/logout?grant_type=");
    expect(
      requests
        .filter((request) => new URL(request.url).pathname === "/auth/v1/logout")
        .map((request) => new URL(request.url).searchParams.get("scope")),
    ).toContain("others");
  });
});
