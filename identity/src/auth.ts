import { normalizeVerifiedEmail } from "@rudderhq/identity-core";
import {
  claimVerifiedEmail,
  consumeIdentityEmailRateLimit,
  recordSecurityEvent,
  revokeAllIdentityDevices,
  type IdentityDb,
} from "@rudderhq/identity-db";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { bearer, deviceAuthorization, emailOTP } from "better-auth/plugins";
import type { IdentityConfig } from "./config.js";
import { otpMail, passwordResetMail, type IdentityMailAdapter } from "./mail.js";
import { verifiedIdentityAdapter } from "./verified-identity-adapter.js";

function requestMetadata(request?: Request | null) {
  return {
    ipAddress:
      request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request?.headers.get("x-real-ip") ??
      null,
    userAgent: request?.headers.get("user-agent") ?? null,
  };
}

export function createIdentityAuth(input: {
  db: IdentityDb;
  config: IdentityConfig;
  mail: IdentityMailAdapter;
  backgroundTaskHandler?: (promise: Promise<unknown>) => void;
}) {
  const { backgroundTaskHandler, db, config, mail } = input;
  const securityEventMetadata = (request?: Request | null) => ({
    ...requestMetadata(request),
    ipHashKey: config.secret,
  });
  const socialProviders = {
    ...(config.google ? { google: config.google } : {}),
    ...(config.github ? { github: config.github } : {}),
  };

  return betterAuth({
    appName: "Rudder Account",
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    secret: config.secret,
    trustedOrigins: config.allowedOrigins,
    database: verifiedIdentityAdapter(db) as Parameters<typeof betterAuth>[0]["database"],
    socialProviders,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await mail.send(passwordResetMail({ to: user.email, url }));
      },
      onPasswordReset: async ({ user }, request) => {
        await revokeAllIdentityDevices(db, {
          userId: user.id,
          reason: "password-reset",
        });
        await recordSecurityEvent(db, {
          userId: user.id,
          eventType: "password.reset",
          ...securityEventMetadata(request),
        });
      },
    },
    account: {
      updateAccountOnSignIn: false,
      accountLinking: {
        enabled: true,
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 15,
    },
    verification: {
      storeIdentifier: "hashed",
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        const action =
          context.path === "/email-otp/send-verification-otp"
            ? "otp-send"
            : context.path === "/email-otp/request-password-reset"
              ? "password-reset"
              : null;
        const email = context.body?.email;
        if (!action || typeof email !== "string") return;
        const result = await consumeIdentityEmailRateLimit(db, {
          email,
          action,
          maxAttempts: 3,
          windowSeconds: 10 * 60,
          blockSeconds: 15 * 60,
        });
        if (!result.allowed) {
          // Keep the same generic success shape for known and unknown email
          // addresses. This prevents the rate-limit boundary becoming an
          // account-enumeration oracle.
          return context.json({ success: true });
        }
      }),
    },
    plugins: [
      bearer(),
      emailOTP({
        expiresIn: 60 * 10,
        otpLength: 6,
        allowedAttempts: 5,
        storeOTP: "hashed",
        resendStrategy: "rotate",
        sendVerificationOnSignUp: true,
        overrideDefaultEmailVerification: true,
        // Email-bucket limits are enforced persistently in the request hook.
        // Keep this plugin-wide IP guard broad so one user's requests cannot
        // exhaust every other email behind the same NAT.
        rateLimit: { window: 60, max: 100 },
        sendVerificationOTP: async ({ email, otp, type }) => {
          await mail.send(otpMail({ to: normalizeVerifiedEmail(email), otp, type }));
        },
      }),
      deviceAuthorization({
        expiresIn: "10m",
        interval: "5s",
        verificationUri: `${config.baseUrl}/device`,
        validateClient: (clientId) => config.deviceClientIds.has(clientId),
        onDeviceAuthRequest: async (clientId, scope) => {
          await recordSecurityEvent(db, {
            eventType: "device.authorization.requested",
            ipHashKey: config.secret,
            metadata: { clientId, scope: scope ?? null },
          });
        },
      }),
    ],
    advanced: {
      ...(backgroundTaskHandler
        ? { backgroundTasks: { handler: backgroundTaskHandler } }
        : {}),
      trustedProxyHeaders: true,
      ipAddress: {
        ipAddressHeaders: ["x-real-ip", "x-forwarded-for"],
      },
      useSecureCookies: config.baseUrl.startsWith("https://"),
      cookiePrefix: "rudder_identity",
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({
            data: { ...user, email: normalizeVerifiedEmail(user.email) },
          }),
          after: async (user, context) => {
            if (user.emailVerified) await claimVerifiedEmail(db, { userId: user.id, email: user.email });
            await recordSecurityEvent(db, {
              userId: user.id,
              eventType: "account.created",
              ...securityEventMetadata(context?.request),
            });
          },
        },
        update: {
          before: async (user) => (
            user.email ? { data: { ...user, email: normalizeVerifiedEmail(user.email) } } : undefined
          ),
          after: async (user) => {
            if (user.emailVerified) await claimVerifiedEmail(db, { userId: user.id, email: user.email });
          },
        },
      },
      account: {
        create: {
          before: async (account) => ({
            data: {
              ...account,
              accessToken: null,
              refreshToken: null,
              idToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          }),
          after: async (account, context) => {
            await recordSecurityEvent(db, {
              userId: account.userId,
              eventType: "identity.linked",
              metadata: { provider: account.providerId },
              ...securityEventMetadata(context?.request),
            });
          },
        },
      },
      session: {
        create: {
          after: async (session, context) => {
            await recordSecurityEvent(db, {
              userId: session.userId,
              eventType: "session.created",
              ...securityEventMetadata(context?.request),
            });
          },
        },
        delete: {
          after: async (session, context) => {
            await recordSecurityEvent(db, {
              userId: session.userId,
              eventType: "session.revoked",
              ...securityEventMetadata(context?.request),
            });
          },
        },
      },
    },
  });
}

export type IdentityAuth = ReturnType<typeof createIdentityAuth>;
