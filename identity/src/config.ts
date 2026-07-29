import {
  assertIdentityReleasePolicy,
  type IdentityReleaseChannel,
} from "@rudderhq/identity-core";

export type IdentityConfig = {
  releaseChannel: IdentityReleaseChannel;
  baseUrl: string;
  databaseUrl: string;
  secret: string;
  supportEmail: string;
  allowedOrigins: string[];
  deviceClientIds: Set<string>;
  offlineGrant?: {
    keyId: string;
    privateKeyPkcs8: string;
  };
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
  mail:
    | { mode: "capture"; from: string; mailboxSecret: string }
    | { mode: "resend"; from: string; apiKey: string };
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function requiredWithAlias(env: NodeJS.ProcessEnv, key: string, alias: string): string {
  const value = env[key]?.trim() || env[alias]?.trim();
  if (!value) throw new Error(`${key} (or ${alias}) is required`);
  return value;
}

function optionalPair(
  env: NodeJS.ProcessEnv,
  idKey: string,
  secretKey: string,
): { clientId: string; clientSecret: string } | undefined {
  const clientId = env[idKey]?.trim();
  const clientSecret = env[secretKey]?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(`${idKey} and ${secretKey} must be configured together`);
  }
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

export function readIdentityConfig(env: NodeJS.ProcessEnv = process.env): IdentityConfig {
  const vercelEnv = env.VERCEL_ENV?.trim();
  const configuredReleaseChannel = env.IDENTITY_RELEASE_CHANNEL?.trim();
  if (vercelEnv && !configuredReleaseChannel) {
    throw new Error("IDENTITY_RELEASE_CHANNEL is required when VERCEL_ENV is set");
  }
  const releaseChannel = (configuredReleaseChannel ?? "development") as IdentityReleaseChannel;
  if (!["development", "test", "preview", "production"].includes(releaseChannel)) {
    throw new Error("IDENTITY_RELEASE_CHANNEL is invalid");
  }
  if (vercelEnv) {
    if (!["development", "preview", "production"].includes(vercelEnv)) {
      throw new Error("VERCEL_ENV is invalid");
    }
    if (releaseChannel !== vercelEnv) {
      throw new Error("IDENTITY_RELEASE_CHANNEL must match VERCEL_ENV");
    }
  }

  const baseUrl = required(env, "IDENTITY_BASE_URL");
  const secret = required(env, "IDENTITY_BETTER_AUTH_SECRET");
  if (secret.length < 32) throw new Error("IDENTITY_BETTER_AUTH_SECRET must be at least 32 characters");

  const mailMode = env.IDENTITY_MAIL_MODE ?? (
    releaseChannel === "development" || releaseChannel === "test" ? "capture" : "resend"
  );
  const from = requiredWithAlias(env, "IDENTITY_MAIL_FROM", "EMAIL_FROM");
  const mail = mailMode === "resend"
    ? {
        mode: "resend" as const,
        from,
        apiKey: requiredWithAlias(env, "IDENTITY_RESEND_API_KEY", "RESEND_API_KEY"),
      }
    : mailMode === "capture"
      ? {
          mode: "capture" as const,
          from,
          mailboxSecret: required(env, "IDENTITY_CAPTURE_MAILBOX_SECRET"),
        }
      : (() => {
          throw new Error("IDENTITY_MAIL_MODE must be capture or resend");
        })();

  assertIdentityReleasePolicy({
    channel: releaseChannel,
    issuer: baseUrl,
    allowCapturedMail: mail.mode === "capture",
    allowTestClients: releaseChannel === "development" || releaseChannel === "test",
  });

  const google = optionalPair(env, "IDENTITY_GOOGLE_CLIENT_ID", "IDENTITY_GOOGLE_CLIENT_SECRET");
  const github = optionalPair(env, "IDENTITY_GITHUB_CLIENT_ID", "IDENTITY_GITHUB_CLIENT_SECRET");
  if (releaseChannel === "production" && (!google || !github)) {
    throw new Error("Production Identity requires Google and GitHub OAuth credentials");
  }
  const offlineGrantKeyId = env.IDENTITY_OFFLINE_GRANT_KEY_ID?.trim();
  const offlineGrantPrivateKey = env.IDENTITY_OFFLINE_GRANT_PRIVATE_KEY?.trim();
  if (Boolean(offlineGrantKeyId) !== Boolean(offlineGrantPrivateKey)) {
    throw new Error("IDENTITY_OFFLINE_GRANT_KEY_ID and IDENTITY_OFFLINE_GRANT_PRIVATE_KEY must be configured together");
  }
  if (releaseChannel === "production" && (!offlineGrantKeyId || !offlineGrantPrivateKey)) {
    throw new Error("Production Identity requires an Offline Grant signing key");
  }

  const allowedOrigins = (env.IDENTITY_ALLOWED_ORIGINS ?? baseUrl)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (releaseChannel === "production" || releaseChannel === "preview") {
    for (const allowedOrigin of allowedOrigins) {
      const parsed = new URL(allowedOrigin);
      if (
        parsed.protocol !== "https:" ||
        parsed.origin !== allowedOrigin ||
        parsed.username ||
        parsed.password
      ) {
        throw new Error("IDENTITY_ALLOWED_ORIGINS must contain HTTPS origins only");
      }
    }
  }

  return {
    releaseChannel,
    baseUrl,
    databaseUrl: required(env, "IDENTITY_DATABASE_URL"),
    secret,
    supportEmail: required(env, "IDENTITY_SUPPORT_EMAIL"),
    allowedOrigins,
    deviceClientIds: new Set(
      required(env, "IDENTITY_DEVICE_CLIENT_IDS")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    offlineGrant: offlineGrantKeyId && offlineGrantPrivateKey
      ? { keyId: offlineGrantKeyId, privateKeyPkcs8: offlineGrantPrivateKey }
      : undefined,
    google,
    github,
    mail,
  };
}
