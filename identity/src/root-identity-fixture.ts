import { createHash, randomUUID } from "node:crypto";
import type { SupabaseRootIdentityConfig } from "./config.js";
import { otpMail, passwordResetMail, type IdentityMailAdapter } from "./mail.js";
import {
  RootIdentityError,
  type RootIdentityAdapter,
  type RootIdentityPrincipal,
  type RootIdentityRequestContext,
  type RootIdentitySignOutScope,
} from "./root-identity-adapter.js";

type FixtureConfig = Extract<SupabaseRootIdentityConfig, { environment: "fixture" }>;
type FixtureUser = RootIdentityPrincipal & { password: string | null };

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function deterministicUserId(email: string): string {
  const digest = createHash("sha256").update(email).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function cookieValue(context: RootIdentityRequestContext, name: string): string | null {
  const raw = context.requestHeaders.get("cookie");
  const entry = raw
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`));
  if (!entry) return null;
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return entry.slice(name.length + 1);
  }
}

/**
 * Complete zero-infrastructure root-auth implementation for local development
 * and E2E. It is intentionally in-process and cannot be selected by preview or
 * production configuration.
 */
export function createRootIdentityFixture(
  config: FixtureConfig,
  mail: IdentityMailAdapter,
): RootIdentityAdapter {
  const users = new Map<string, FixtureUser>();
  const sessions = new Map<string, FixtureUser>();
  const otps = new Map<string, { purpose: "email" | "signup" | "recovery"; token: string }>();

  const getUser = (emailValue: string, password: string | null = null): FixtureUser => {
    const email = normalizedEmail(emailValue);
    const existing = users.get(email);
    if (existing) {
      if (password !== null) existing.password = password;
      return existing;
    }
    const user: FixtureUser = {
      id: deterministicUserId(email),
      email,
      emailVerified: true,
      displayName: email.split("@")[0] ?? null,
      avatarUrl: null,
      password,
    };
    users.set(email, user);
    return user;
  };

  const setSession = async (
    context: RootIdentityRequestContext,
    user: FixtureUser,
  ): Promise<void> => {
    const token = randomUUID();
    sessions.set(token, user);
    await context.setCookies(
      [{
        name: config.cookieName,
        value: token,
        options: {
          httpOnly: true,
          secure: config.cookieSecure,
          sameSite: "lax",
          path: "/",
        },
      }],
      { "cache-control": "private, no-store" },
    );
  };

  const clearCookie = async (
    context: RootIdentityRequestContext,
  ): Promise<void> => {
    await context.setCookies(
      [{
        name: config.cookieName,
        value: "",
        options: {
          httpOnly: true,
          secure: config.cookieSecure,
          maxAge: 0,
          sameSite: "lax",
          path: "/",
        },
      }],
      { "cache-control": "private, no-store" },
    );
  };

  const clearSessions = async (
    context: RootIdentityRequestContext,
    user: FixtureUser,
  ): Promise<void> => {
    for (const [token, sessionUser] of sessions) {
      if (sessionUser.id === user.id) sessions.delete(token);
    }
    await clearCookie(context);
  };

  const principal = (context: RootIdentityRequestContext): FixtureUser | null => {
    const token = cookieValue(context, config.cookieName);
    return token ? sessions.get(token) ?? null : null;
  };

  const requirePrincipal = (context: RootIdentityRequestContext): FixtureUser => {
    const user = principal(context);
    if (!user) {
      throw new RootIdentityError({
        code: "session_revoked",
        message: "This fixture session is no longer active",
        status: 401,
      });
    }
    return user;
  };

  const issueOtp = async (
    emailValue: string,
    purpose: "email" | "signup" | "recovery",
    token: string,
  ): Promise<void> => {
    const email = normalizedEmail(emailValue);
    otps.set(email, { purpose, token });
    await mail.send(otpMail({
      to: email,
      otp: token,
      type:
        purpose === "recovery"
          ? "forget-password"
          : purpose === "signup"
            ? "email-verification"
            : "sign-in",
    }));
  };

  const verifyOtp = (
    emailValue: string,
    token: string,
    purpose: "email" | "signup" | "recovery",
  ): FixtureUser => {
    const email = normalizedEmail(emailValue);
    const otp = otps.get(email);
    if (!otp || otp.token !== token || otp.purpose !== purpose) {
      throw new RootIdentityError({
        code: "otp_expired",
        message: "The fixture code is invalid or expired",
      });
    }
    otps.delete(email);
    return getUser(email);
  };

  return {
    async getPrincipal(context) {
      return principal(context);
    },
    async requireActivePrincipal(context) {
      return requirePrincipal(context);
    },
    async beginOAuth(_context, input) {
      const callback = new URL(config.callbackUrl);
      callback.searchParams.set("code", `fixture-${input.provider}`);
      if (input.nextPath) callback.searchParams.set("next", input.nextPath);
      return { redirectUrl: callback.toString() };
    },
    async completePkceCallback(context, input) {
      const provider = input.code === "fixture-google"
        ? "google"
        : input.code === "fixture-github"
          ? "github"
          : null;
      if (!provider) {
        throw new RootIdentityError({
          code: "invalid_oauth_code",
          message: "The fixture OAuth code is invalid",
        });
      }
      const user = getUser(`${provider}.fixture@rudder.test`);
      await setSession(context, user);
      return user;
    },
    async sendEmailOtp(_context, input) {
      await issueOtp(input.email, "email", "123456");
    },
    async verifyEmailOtp(context, input) {
      const purpose = input.purpose === "email-verification" ? "signup" : "email";
      const user = verifyOtp(input.email, input.token, purpose);
      await setSession(context, user);
      return user;
    },
    async signUpWithPassword(_context, input) {
      getUser(input.email, input.password);
      await issueOtp(input.email, "signup", "234567");
      return { principal: null, verificationRequired: true };
    },
    async signInWithPassword(context, input) {
      const user = users.get(normalizedEmail(input.email));
      if (!user || user.password !== input.password) {
        throw new RootIdentityError({
          code: "invalid_credentials",
          message: "The email or password is incorrect",
          status: 401,
        });
      }
      await setSession(context, user);
      return user;
    },
    async requestPasswordReset(_context, input) {
      const email = normalizedEmail(input.email);
      if (!users.has(email)) return;
      await issueOtp(email, "recovery", "345678");
      const link = new URL(config.passwordResetUrl);
      link.searchParams.set("token_hash", "345678");
      link.searchParams.set("type", "recovery");
      await mail.send(passwordResetMail({
        to: email,
        url: link.toString(),
        code: "345678",
      }));
    },
    async resetPasswordWithOtp(context, input, beforeMutation) {
      const user = verifyOtp(input.email, input.token, "recovery");
      await beforeMutation(user);
      user.password = input.newPassword;
      await clearSessions(context, user);
      return user;
    },
    async completePasswordRecovery(context, input) {
      const token = input.code ?? input.tokenHash;
      const match = [...otps.entries()].find(([, otp]) =>
        otp.purpose === "recovery" && otp.token === token
      );
      if (!match) {
        throw new RootIdentityError({
          code: "invalid_recovery_link",
          message: "The fixture recovery link is invalid",
        });
      }
      const user = users.get(match[0]);
      if (!user) throw new Error("Fixture recovery user missing");
      otps.delete(match[0]);
      await setSession(context, user);
      return user;
    },
    async updateRecoveredPassword(context, input, beforeMutation) {
      const user = requirePrincipal(context);
      await beforeMutation(user);
      user.password = input.newPassword;
      await clearSessions(context, user);
      return user;
    },
    async requestPasswordChangeVerification(context) {
      const user = requirePrincipal(context);
      await issueOtp(user.email, "recovery", "456789");
    },
    async updatePassword(context, input, beforeMutation) {
      const user = requirePrincipal(context);
      verifyOtp(user.email, input.verificationCode, "recovery");
      await beforeMutation(user);
      user.password = input.newPassword;
      if (input.revokeOthers) {
        const currentToken = cookieValue(context, config.cookieName);
        for (const [token, sessionUser] of sessions) {
          if (sessionUser.id === user.id && token !== currentToken) sessions.delete(token);
        }
      }
      return user;
    },
    async signOut(context, scope: RootIdentitySignOutScope) {
      const currentToken = cookieValue(context, config.cookieName);
      const user = requirePrincipal(context);
      if (scope === "current") {
        sessions.delete(currentToken!);
        await clearCookie(context);
        return;
      }
      if (scope === "others") {
        for (const [token, sessionUser] of sessions) {
          if (sessionUser.id === user.id && token !== currentToken) {
            sessions.delete(token);
          }
        }
        return;
      }
      await clearSessions(context, user);
    },
  };
}
