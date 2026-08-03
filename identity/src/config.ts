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
  telemetry?: {
    keyId: string;
    privateKeyPkcs8: string;
    subjectSecret: string;
    revokeSecret: string;
  };
  google?: { clientId: string; clientSecret: string };
  github?: { clientId: string; clientSecret: string };
  mail:
    | { mode: "capture"; from: string; mailboxSecret: string }
    | { mode: "supabase_smtp" };
};

type SupabaseRootIdentityConfigBase = {
  callbackUrl: string;
  passwordResetUrl: string;
  cookieName: string;
  cookieSecure: boolean;
};

export type SupabaseRootIdentityConfig =
  | (SupabaseRootIdentityConfigBase & {
      environment: "fixture";
    })
  | (SupabaseRootIdentityConfigBase & {
      environment: "hosted";
      projectUrl: string;
      publishableKey: string;
    });

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

function requiredAny(env: NodeJS.ProcessEnv, keys: string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  throw new Error(`${keys.join(" (or ")}${")".repeat(keys.length - 1)} is required`);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";
}

const PRODUCTION_SUPABASE_PROJECT_REF = "qroqfgbaifzeqlygafjr";

function supabaseProjectRef(hostname: string): string | null {
  const match = /^([a-z0-9]{20})\.supabase\.co$/u.exec(hostname);
  return match?.[1] ?? null;
}

function projectRefSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function jwtRole(value: string): string | null {
  const [, payload] = value.split(".");
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const role = (parsed as Record<string, unknown>).role;
    return typeof role === "string" ? role : null;
  } catch {
    return null;
  }
}

/**
 * Reads the root-auth configuration independently from the legacy Identity
 * configuration. Keeping this boundary separate allows an additive cutover:
 * the Supabase adapter can be verified before the Better Auth handler is
 * removed, without ever making both systems share credentials or cookies.
 */
export function readSupabaseRootIdentityConfig(
  input: {
    baseUrl: string;
    releaseChannel: IdentityReleaseChannel;
  },
  env: NodeJS.ProcessEnv = process.env,
): SupabaseRootIdentityConfig {
  const configuredEnvironment =
    env.IDENTITY_SUPABASE_AUTH_ENVIRONMENT?.trim() ?? "auto";
  if (!["auto", "fixture", "hosted"].includes(configuredEnvironment)) {
    throw new Error("IDENTITY_SUPABASE_AUTH_ENVIRONMENT must be auto, fixture, or hosted");
  }
  const projectUrlValue =
    env.IDENTITY_SUPABASE_URL?.trim() || env.SUPABASE_URL?.trim();
  const publishableKeyValue =
    env.IDENTITY_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    env.SUPABASE_PUBLISHABLE_KEY?.trim() ||
    env.SUPABASE_ANON_KEY?.trim();
  if (Boolean(projectUrlValue) !== Boolean(publishableKeyValue)) {
    throw new Error("Supabase URL and publishable key must be configured together");
  }
  const environment = (
    configuredEnvironment === "auto"
      ? projectUrlValue && publishableKeyValue
        ? "hosted"
        : "fixture"
      : configuredEnvironment
  ) as SupabaseRootIdentityConfig["environment"];
  if (
    (input.releaseChannel === "production" || input.releaseChannel === "preview") &&
    environment !== "hosted"
  ) {
    throw new Error("Preview and production Identity require hosted Supabase Auth");
  }

  const baseUrl = new URL(input.baseUrl);
  const cookieSecure = baseUrl.protocol === "https:";
  const cookieName =
    env.IDENTITY_SUPABASE_COOKIE_NAME?.trim() ??
    (cookieSecure ? "__Host-rudder_account" : "rudder_account");
  if (!/^(?:__Host-)?[A-Za-z0-9_.-]+$/u.test(cookieName)) {
    throw new Error("IDENTITY_SUPABASE_COOKIE_NAME is invalid");
  }
  if (cookieName.startsWith("__Host-") && !cookieSecure) {
    throw new Error("__Host- Supabase cookies require an HTTPS Identity base URL");
  }

  const common = {
    callbackUrl: new URL("/auth/callback", baseUrl).toString(),
    passwordResetUrl: new URL("/reset-password", baseUrl).toString(),
    cookieName,
    cookieSecure,
  };
  if (environment === "fixture") return { ...common, environment: "fixture" };

  if (!projectUrlValue || !publishableKeyValue) {
    throw new Error("Hosted Supabase Auth requires a URL and publishable key");
  }
  const projectUrl = new URL(projectUrlValue);
  if (
    projectUrl.username ||
    projectUrl.password ||
    projectUrl.pathname !== "/" ||
    projectUrl.search ||
    projectUrl.hash
  ) {
    throw new Error("IDENTITY_SUPABASE_URL must be an origin without credentials");
  }
  const loopbackProject = isLoopbackHostname(projectUrl.hostname);
  const projectRef = supabaseProjectRef(projectUrl.hostname);
  const productionLike =
    input.releaseChannel === "preview" || input.releaseChannel === "production";
  if (
    (productionLike && (projectUrl.protocol !== "https:" || loopbackProject)) ||
    (!productionLike &&
      projectUrl.protocol !== "https:" &&
      !(projectUrl.protocol === "http:" && loopbackProject))
  ) {
    throw new Error(
      "Preview/production Supabase Auth requires non-loopback HTTPS; development may use HTTP loopback",
    );
  }
  if (input.releaseChannel === "production") {
    const configuredExpectedProjectRef =
      env.IDENTITY_SUPABASE_EXPECTED_PROJECT_REF?.trim();
    if (
      configuredExpectedProjectRef &&
      configuredExpectedProjectRef !== PRODUCTION_SUPABASE_PROJECT_REF
    ) {
      throw new Error(
        `Production Identity is locked to Supabase project ${PRODUCTION_SUPABASE_PROJECT_REF}`,
      );
    }
    if (projectRef !== PRODUCTION_SUPABASE_PROJECT_REF) {
      throw new Error(
        `Production Identity is locked to Supabase project ${PRODUCTION_SUPABASE_PROJECT_REF}`,
      );
    }
  } else if (input.releaseChannel === "preview") {
    const expectedProjectRef =
      env.IDENTITY_SUPABASE_EXPECTED_PROJECT_REF?.trim();
    if (!expectedProjectRef) {
      throw new Error(
        "Preview Identity requires IDENTITY_SUPABASE_EXPECTED_PROJECT_REF",
      );
    }
    if (expectedProjectRef === PRODUCTION_SUPABASE_PROJECT_REF) {
      throw new Error(
        "Preview Identity must use a Supabase project separate from production",
      );
    }
    if (!projectRef || projectRef !== expectedProjectRef) {
      throw new Error("Supabase project URL does not match the expected project ref");
    }
  } else if (!loopbackProject) {
    if (projectRef === PRODUCTION_SUPABASE_PROJECT_REF) {
      throw new Error(
        "Development/test Identity must not connect to the production Supabase project",
      );
    }
    const allowedDevProjectRefs = projectRefSet(
      env.IDENTITY_SUPABASE_ALLOWED_DEV_PROJECT_REFS,
    );
    if (!projectRef || !allowedDevProjectRefs.has(projectRef)) {
      throw new Error(
        "Hosted development/test Supabase Auth requires an explicitly allowed development project ref",
      );
    }
  }
  if (
    publishableKeyValue.startsWith("sb_secret_") ||
    jwtRole(publishableKeyValue) === "service_role"
  ) {
    throw new Error("Supabase secret/service-role keys are forbidden in root-auth configuration");
  }
  return {
    ...common,
    environment: "hosted",
    projectUrl: projectUrl.origin,
    publishableKey: publishableKeyValue,
  };
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
  const secret = requiredAny(env, [
    "IDENTITY_SECURITY_HASH_SECRET",
    // Kept as a rollback-compatible alias for one migration window.
    "IDENTITY_BETTER_AUTH_SECRET",
  ]);
  if (secret.length < 32) {
    throw new Error("IDENTITY_SECURITY_HASH_SECRET must be at least 32 characters");
  }

  const mailMode = env.IDENTITY_MAIL_MODE ?? (
    releaseChannel === "development" || releaseChannel === "test" ? "capture" : "supabase_smtp"
  );
  const mail = mailMode === "capture"
      ? {
          mode: "capture" as const,
          from: requiredWithAlias(env, "IDENTITY_MAIL_FROM", "EMAIL_FROM"),
          mailboxSecret: required(env, "IDENTITY_CAPTURE_MAILBOX_SECRET"),
        }
      : mailMode === "supabase_smtp"
        ? { mode: "supabase_smtp" as const }
      : (() => {
          throw new Error("IDENTITY_MAIL_MODE must be capture or supabase_smtp");
        })();

  assertIdentityReleasePolicy({
    channel: releaseChannel,
    issuer: baseUrl,
    allowCapturedMail: mail.mode === "capture",
    allowTestClients: releaseChannel === "development" || releaseChannel === "test",
  });

  const google = optionalPair(env, "IDENTITY_GOOGLE_CLIENT_ID", "IDENTITY_GOOGLE_CLIENT_SECRET");
  const github = optionalPair(env, "IDENTITY_GITHUB_CLIENT_ID", "IDENTITY_GITHUB_CLIENT_SECRET");
  const offlineGrantKeyId = env.IDENTITY_OFFLINE_GRANT_KEY_ID?.trim();
  const offlineGrantPrivateKey = env.IDENTITY_OFFLINE_GRANT_PRIVATE_KEY?.trim();
  if (Boolean(offlineGrantKeyId) !== Boolean(offlineGrantPrivateKey)) {
    throw new Error("IDENTITY_OFFLINE_GRANT_KEY_ID and IDENTITY_OFFLINE_GRANT_PRIVATE_KEY must be configured together");
  }
  if (releaseChannel === "production" && (!offlineGrantKeyId || !offlineGrantPrivateKey)) {
    throw new Error("Production Identity requires an Offline Grant signing key");
  }

  const telemetryKeyId = env.IDENTITY_TELEMETRY_ASSERTION_KEY_ID?.trim();
  const telemetryPrivateKey = env.IDENTITY_TELEMETRY_ASSERTION_PRIVATE_KEY?.trim();
  const telemetrySubjectSecret = env.IDENTITY_TELEMETRY_SUBJECT_SECRET?.trim();
  const telemetryRevokeSecret = env.IDENTITY_TELEMETRY_REVOKE_SECRET?.trim();
  const telemetryValues = [telemetryKeyId, telemetryPrivateKey, telemetrySubjectSecret, telemetryRevokeSecret];
  if (telemetryValues.some(Boolean) && telemetryValues.some((value) => !value)) {
    throw new Error("Identity telemetry assertion and subject secrets must be configured together");
  }
  if (telemetrySubjectSecret && telemetrySubjectSecret.length < 32) {
    throw new Error("IDENTITY_TELEMETRY_SUBJECT_SECRET must be at least 32 characters");
  }
  if (telemetryRevokeSecret && telemetryRevokeSecret.length < 32) {
    throw new Error("IDENTITY_TELEMETRY_REVOKE_SECRET must be at least 32 characters");
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
    telemetry: telemetryKeyId && telemetryPrivateKey && telemetrySubjectSecret && telemetryRevokeSecret
      ? { keyId: telemetryKeyId, privateKeyPkcs8: telemetryPrivateKey, subjectSecret: telemetrySubjectSecret, revokeSecret: telemetryRevokeSecret }
      : undefined,
    google,
    github,
    mail,
  };
}
