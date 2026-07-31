import { normalizeVerifiedEmail } from "@rudderhq/identity-core";
import type { AuthError, User } from "@supabase/auth-js";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseRootIdentityConfig } from "./config.js";
import {
  RootIdentityError,
  type RootIdentityActiveSessionVerifier,
  type RootIdentityAdapter,
  type RootIdentityPrincipal,
  type RootIdentityRequestContext,
} from "./root-identity-adapter.js";

type SupabaseRootIdentityAdapterOptions = {
  activeSessionVerifier?: RootIdentityActiveSessionVerifier;
  fetch?: typeof globalThis.fetch;
};

function cookiesFromHeaders(headers: Headers): { name: string; value: string }[] {
  const cookieHeader = headers.get("cookie");
  if (!cookieHeader) return [];
  return cookieHeader.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) return [];
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!name) return [];
    try {
      return [{ name, value: decodeURIComponent(rawValue) }];
    } catch {
      return [{ name, value: rawValue }];
    }
  });
}

function safeNextPath(nextPath: string | undefined): string | null {
  if (!nextPath) return null;
  if (
    !nextPath.startsWith("/") ||
    nextPath.startsWith("//") ||
    nextPath.includes("\\") ||
    /[\r\n]/u.test(nextPath)
  ) {
    throw new RootIdentityError({
      code: "invalid_redirect",
      message: "The post-authentication path must be same-origin",
    });
  }
  const parsed = new URL(nextPath, "https://rudder.invalid");
  if (
    parsed.origin !== "https://rudder.invalid" ||
    parsed.hash ||
    !new Set(["/", "/account", "/device", "/api/desktop/authorize"]).has(parsed.pathname)
  ) {
    throw new RootIdentityError({
      code: "invalid_redirect",
      message: "The post-authentication path is not an allowed Rudder continuation",
    });
  }
  return `${parsed.pathname}${parsed.search}`;
}

function callbackUrl(config: SupabaseRootIdentityConfig, nextPath?: string): string {
  const value = new URL(config.callbackUrl);
  const safePath = safeNextPath(nextPath);
  if (safePath) value.searchParams.set("next", safePath);
  return value.toString();
}

function throwAuthError(error: AuthError | null): void {
  if (!error) return;
  throw new RootIdentityError({
    code: error.code ?? "identity_provider_error",
    message: error.message,
    status: error.status ?? 400,
  });
}

function isUnauthenticated(error: AuthError): boolean {
  return (
    error.name === "AuthSessionMissingError" ||
    error.code === "session_not_found" ||
    error.code === "refresh_token_not_found" ||
    error.code === "refresh_token_already_used" ||
    error.code === "bad_jwt"
  );
}

function verifiedPrincipal(user: User | null): RootIdentityPrincipal {
  if (!user?.id || !user.email || !user.email_confirmed_at) {
    throw new RootIdentityError({
      code: "verified_email_required",
      message: "A verified email identity is required",
      status: 403,
    });
  }
  const displayName =
    typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name.trim()
      ? user.user_metadata.full_name.trim()
      : typeof user.user_metadata?.name === "string" && user.user_metadata.name.trim()
        ? user.user_metadata.name.trim()
        : null;
  const avatarUrl =
    typeof user.user_metadata?.avatar_url === "string" && user.user_metadata.avatar_url.trim()
      ? user.user_metadata.avatar_url.trim()
      : null;
  return {
    id: user.id,
    email: normalizeVerifiedEmail(user.email),
    emailVerified: true,
    displayName,
    avatarUrl,
  };
}

function jwtStringClaim(token: string, claim: string): string | null {
  const [, payload] = token.split(".");
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[claim];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function createSupabaseRootIdentityAdapter(
  config: Extract<SupabaseRootIdentityConfig, { environment: "hosted" }>,
  options: SupabaseRootIdentityAdapterOptions = {},
): RootIdentityAdapter {
  const createRequestClient = (context: RootIdentityRequestContext) => {
    const cookiePolicy: CookieOptions = {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "lax",
      path: "/",
    };
    return createServerClient(config.projectUrl, config.publishableKey, {
      cookieOptions: {
        name: config.cookieName,
        ...cookiePolicy,
      },
      cookieEncoding: "base64url",
      cookies: {
        getAll: () => cookiesFromHeaders(context.requestHeaders),
        setAll: async (cookies, responseHeaders) => {
          await context.setCookies(
            cookies.map(({ name, value, options: providerOptions }) => ({
              name,
              value,
              options: {
                ...providerOptions,
                ...cookiePolicy,
                // Auth state must remain host-only. Never forward a provider
                // supplied Domain attribute across Rudder subdomains.
                domain: undefined,
              },
            })),
            {
              "cache-control": "private, no-cache, no-store, must-revalidate, max-age=0",
              expires: "0",
              pragma: "no-cache",
              ...responseHeaders,
            },
          );
        },
      },
      global: options.fetch ? { fetch: options.fetch } : undefined,
      auth: {
        flowType: "pkce",
        detectSessionInUrl: false,
        persistSession: true,
        autoRefreshToken: false,
        // Bind each callback to the verifier created for that OAuth attempt.
        // The identifier is non-secret and is validated by auth-js before it
        // is used as part of a storage key.
        experimental: { appendPkceFlowIdToRedirects: true },
      },
    });
  };

  const getVerifiedPrincipal = async (
    client: ReturnType<typeof createRequestClient>,
  ): Promise<RootIdentityPrincipal> => {
    // getUser performs a server round-trip and must remain the trust boundary.
    // getSession alone reads cookie storage and is not sufficient authorization.
    const { data, error } = await client.auth.getUser();
    throwAuthError(error);
    return verifiedPrincipal(data.user);
  };

  const getActivePrincipal = async (
    client: ReturnType<typeof createRequestClient>,
  ): Promise<RootIdentityPrincipal> => {
    const principal = await getVerifiedPrincipal(client);
    const { data, error } = await client.auth.getSession();
    throwAuthError(error);
    const accessToken = data.session?.access_token;
    const sessionId = accessToken ? jwtStringClaim(accessToken, "session_id") : null;
    const tokenSubject = accessToken ? jwtStringClaim(accessToken, "sub") : null;
    if (!sessionId || tokenSubject !== principal.id) {
      throw new RootIdentityError({
        code: "active_session_required",
        message: "The authenticated session cannot be confirmed",
        status: 401,
      });
    }
    if (!options.activeSessionVerifier) {
      throw new RootIdentityError({
        code: "active_session_verification_unavailable",
        message: "Active session verification is unavailable",
        status: 503,
      });
    }
    if (!await options.activeSessionVerifier({ userId: principal.id, sessionId })) {
      throw new RootIdentityError({
        code: "session_revoked",
        message: "This session is no longer active",
        status: 401,
      });
    }
    return principal;
  };

  return {
    async getPrincipal(context) {
      const client = createRequestClient(context);
      const { data, error } = await client.auth.getUser();
      if (error) {
        if (isUnauthenticated(error)) return null;
        throwAuthError(error);
      }
      if (!data.user) return null;
      try {
        return verifiedPrincipal(data.user);
      } catch (principalError) {
        if (
          principalError instanceof RootIdentityError &&
          principalError.code === "verified_email_required"
        ) {
          return null;
        }
        throw principalError;
      }
    },

    async requireActivePrincipal(context) {
      return getActivePrincipal(createRequestClient(context));
    },

    async beginOAuth(context, input) {
      const client = createRequestClient(context);
      const { data, error } = await client.auth.signInWithOAuth({
        provider: input.provider,
        options: {
          redirectTo: callbackUrl(config, input.nextPath),
          skipBrowserRedirect: true,
        },
      });
      throwAuthError(error);
      if (!data.url) {
        throw new RootIdentityError({
          code: "oauth_redirect_missing",
          message: "The identity provider did not return an OAuth redirect",
          status: 502,
        });
      }
      return { redirectUrl: data.url };
    },

    async completePkceCallback(context, input) {
      const client = createRequestClient(context);
      const { data, error } = await client.auth.exchangeCodeForSession(
        input.code,
        input.flowId ? { flowId: input.flowId } : undefined,
      );
      throwAuthError(error);
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        throw new RootIdentityError({
          code: "identity_provider_error",
          message: "The identity provider did not return an active session",
          status: 502,
        });
      }
      // Validate the just-exchanged credential directly. Re-reading the
      // request cookie here can race the response's Set-Cookie handoff.
      const { data: userData, error: userError } = await client.auth.getUser(accessToken);
      throwAuthError(userError);
      return verifiedPrincipal(userData.user);
    },

    async sendEmailOtp(context, input) {
      const client = createRequestClient(context);
      const { error } = await client.auth.signInWithOtp({
        email: normalizeVerifiedEmail(input.email),
        options: {
          shouldCreateUser: true,
          emailRedirectTo: callbackUrl(config, input.nextPath),
        },
      });
      throwAuthError(error);
    },

    async verifyEmailOtp(context, input) {
      const client = createRequestClient(context);
      const { data, error } = await client.auth.verifyOtp({
        email: normalizeVerifiedEmail(input.email),
        token: input.token,
        type: input.purpose === "email-verification" ? "signup" : "email",
      });
      throwAuthError(error);
      return verifiedPrincipal(data.user);
    },

    async signUpWithPassword(context, input) {
      const client = createRequestClient(context);
      const { data, error } = await client.auth.signUp({
        email: normalizeVerifiedEmail(input.email),
        password: input.password,
        options: { emailRedirectTo: config.callbackUrl },
      });
      throwAuthError(error);
      return {
        principal: data.user?.email_confirmed_at ? verifiedPrincipal(data.user) : null,
        verificationRequired: !data.user?.email_confirmed_at,
      };
    },

    async signInWithPassword(context, input) {
      const client = createRequestClient(context);
      const { error } = await client.auth.signInWithPassword({
        email: normalizeVerifiedEmail(input.email),
        password: input.password,
      });
      throwAuthError(error);
      return getVerifiedPrincipal(client);
    },

    async requestPasswordReset(context, input) {
      const client = createRequestClient(context);
      const { error } = await client.auth.resetPasswordForEmail(
        normalizeVerifiedEmail(input.email),
        { redirectTo: config.passwordResetUrl },
      );
      throwAuthError(error);
    },

    async resetPasswordWithOtp(context, input, beforeMutation) {
      const client = createRequestClient(context);
      const { data: verified, error: verificationError } = await client.auth.verifyOtp({
        email: normalizeVerifiedEmail(input.email),
        token: input.token,
        type: "recovery",
      });
      throwAuthError(verificationError);
      const verifiedUser = verifiedPrincipal(verified.user);
      await beforeMutation(verifiedUser);
      const { data, error } = await client.auth.updateUser({
        password: input.newPassword,
      });
      throwAuthError(error);
      const principal = verifiedPrincipal(data.user);
      const { error: signOutError } = await client.auth.signOut({ scope: "global" });
      if (signOutError) {
        throw new RootIdentityError({
          code: "password_updated_signout_failed",
          message: "Password updated, but existing browser sessions could not be revoked",
          status: 503,
        });
      }
      return principal;
    },

    async completePasswordRecovery(context, input) {
      const client = createRequestClient(context);
      if (input.code) {
        const { error } = await client.auth.exchangeCodeForSession(input.code);
        throwAuthError(error);
      } else if (input.tokenHash) {
        const { error } = await client.auth.verifyOtp({
          token_hash: input.tokenHash,
          type: "recovery",
        });
        throwAuthError(error);
      } else {
        throw new RootIdentityError({
          code: "invalid_recovery_link",
          message: "The password recovery link is invalid",
        });
      }
      return getVerifiedPrincipal(client);
    },

    async updateRecoveredPassword(context, input, beforeMutation) {
      const client = createRequestClient(context);
      const activePrincipal = await getActivePrincipal(client);
      await beforeMutation(activePrincipal);
      const { data, error } = await client.auth.updateUser({
        password: input.newPassword,
      });
      throwAuthError(error);
      const principal = verifiedPrincipal(data.user);
      const { error: signOutError } = await client.auth.signOut({ scope: "global" });
      if (signOutError) {
        throw new RootIdentityError({
          code: "password_updated_signout_failed",
          message: "Password updated, but existing browser sessions could not be revoked",
          status: 503,
        });
      }
      return principal;
    },

    async requestPasswordChangeVerification(context) {
      const client = createRequestClient(context);
      await getActivePrincipal(client);
      const { error } = await client.auth.reauthenticate();
      throwAuthError(error);
    },

    async updatePassword(context, input, beforeMutation) {
      const client = createRequestClient(context);
      const activePrincipal = await getActivePrincipal(client);
      await beforeMutation(activePrincipal);
      const { data, error } = await client.auth.updateUser({
        password: input.newPassword,
        nonce: input.verificationCode,
      });
      throwAuthError(error);
      if (input.revokeOthers) {
        const { error: signOutError } = await client.auth.signOut({ scope: "others" });
        throwAuthError(signOutError);
      }
      return verifiedPrincipal(data.user);
    },

    async signOut(context, scope) {
      const client = createRequestClient(context);
      await getActivePrincipal(client);
      const { error } = await client.auth.signOut({
        scope: scope === "current" ? "local" : scope,
      });
      throwAuthError(error);
    },
  };
}
