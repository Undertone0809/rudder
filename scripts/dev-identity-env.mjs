const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_CAPTURE_MAILBOX_SECRET = "rudder-dev-capture-mailbox-secret";
const DEFAULT_SECURITY_HASH_SECRET = "rudder-dev-security-hash-secret-local-only";

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parsePort(value, key) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${key} must be a valid TCP port`);
  }
  return port;
}

function defaultIdentityPort(serverPort) {
  // Keep the account service away from the normal server/Desktop port ranges
  // while retaining a deterministic one-to-one mapping for worktree dev envs.
  return 43_100 + (serverPort % 1_000);
}

function supabaseRootInputs(env) {
  return {
    environment: nonEmpty(env.IDENTITY_SUPABASE_AUTH_ENVIRONMENT) ?? "auto",
    projectUrl: nonEmpty(env.IDENTITY_SUPABASE_URL) ?? nonEmpty(env.SUPABASE_URL),
    publishableKey:
      nonEmpty(env.IDENTITY_SUPABASE_PUBLISHABLE_KEY)
      ?? nonEmpty(env.SUPABASE_PUBLISHABLE_KEY)
      ?? nonEmpty(env.SUPABASE_ANON_KEY),
  };
}

/**
 * Resolves the local Identity child-process environment used by `pnpm dev`.
 *
 * This does not implement auth itself. It guarantees that Desktop and Server
 * point at the loopback Identity façade, then lets Identity's `auto` root-auth
 * selection choose the complete in-process fixture or a fully configured
 * hosted development Supabase project.
 */
export function resolveDevIdentityEnvironment(baseEnv) {
  const serverPort = parsePort(nonEmpty(baseEnv.PORT) ?? "3100", "PORT");
  const identityPort = parsePort(
    nonEmpty(baseEnv.RUDDER_IDENTITY_DEV_PORT) ?? String(defaultIdentityPort(serverPort)),
    "RUDDER_IDENTITY_DEV_PORT",
  );
  if (
    identityPort === serverPort
    || identityPort === parsePort(
      nonEmpty(baseEnv.RUDDER_EMBEDDED_POSTGRES_PORT) ?? "54329",
      "RUDDER_EMBEDDED_POSTGRES_PORT",
    )
  ) {
    throw new Error("RUDDER_IDENTITY_DEV_PORT must not overlap the Server or embedded Postgres port");
  }

  const root = supabaseRootInputs(baseEnv);
  if (!["auto", "fixture", "hosted"].includes(root.environment)) {
    throw new Error("IDENTITY_SUPABASE_AUTH_ENVIRONMENT must be auto, fixture, or hosted");
  }
  if (Boolean(root.projectUrl) !== Boolean(root.publishableKey)) {
    throw new Error("Supabase URL and publishable key must be configured together");
  }
  if (root.environment === "fixture" && (root.projectUrl || root.publishableKey)) {
    throw new Error("Fixture auth cannot be combined with hosted Supabase credentials");
  }
  if (root.environment === "hosted" && (!root.projectUrl || !root.publishableKey)) {
    throw new Error("Hosted Supabase Auth requires a URL and publishable key");
  }

  const hosted = root.environment === "hosted"
    || (root.environment === "auto" && Boolean(root.projectUrl && root.publishableKey));
  const explicitIdentityDatabaseUrl = nonEmpty(baseEnv.IDENTITY_DATABASE_URL);
  if (hosted && !explicitIdentityDatabaseUrl) {
    throw new Error(
      "Hosted development Supabase Auth requires IDENTITY_DATABASE_URL for the matching Rudder Identity schema",
    );
  }

  const identityOrigin = `http://${LOOPBACK_HOST}:${identityPort}`;
  const embeddedDatabaseUrl =
    `postgres://rudder:rudder@${LOOPBACK_HOST}:${
      parsePort(
        nonEmpty(baseEnv.RUDDER_EMBEDDED_POSTGRES_PORT) ?? "54329",
        "RUDDER_EMBEDDED_POSTGRES_PORT",
      )
    }/rudder`;
  const identityDatabaseUrl =
    explicitIdentityDatabaseUrl
    ?? nonEmpty(baseEnv.DATABASE_URL)
    ?? embeddedDatabaseUrl;
  const migrationDatabaseUrl =
    nonEmpty(baseEnv.IDENTITY_MIGRATION_DATABASE_URL)
    ?? identityDatabaseUrl;

  const env = {
    ...baseEnv,
    RUDDER_IDENTITY_ORIGIN: identityOrigin,
    IDENTITY_BASE_URL: identityOrigin,
    IDENTITY_RELEASE_CHANNEL: "development",
    IDENTITY_ALLOWED_ORIGINS: identityOrigin,
    IDENTITY_DATABASE_URL: identityDatabaseUrl,
    IDENTITY_MIGRATION_DATABASE_URL: migrationDatabaseUrl,
    IDENTITY_SECURITY_HASH_SECRET:
      nonEmpty(baseEnv.IDENTITY_SECURITY_HASH_SECRET)
      ?? nonEmpty(baseEnv.IDENTITY_BETTER_AUTH_SECRET)
      ?? DEFAULT_SECURITY_HASH_SECRET,
    IDENTITY_SUPPORT_EMAIL:
      nonEmpty(baseEnv.IDENTITY_SUPPORT_EMAIL) ?? "support@rudderhq.dev",
    IDENTITY_DEVICE_CLIENT_IDS:
      nonEmpty(baseEnv.IDENTITY_DEVICE_CLIENT_IDS) ?? "rudder-desktop",
    IDENTITY_MAIL_MODE: hosted ? "supabase_smtp" : "capture",
    IDENTITY_MAIL_FROM:
      nonEmpty(baseEnv.IDENTITY_MAIL_FROM)
      ?? nonEmpty(baseEnv.EMAIL_FROM)
      ?? "Rudder Dev <dev@rudder.test>",
    IDENTITY_CAPTURE_MAILBOX_SECRET:
      nonEmpty(baseEnv.IDENTITY_CAPTURE_MAILBOX_SECRET)
      ?? DEFAULT_CAPTURE_MAILBOX_SECRET,
  };
  // `pnpm dev` is always a local development process. Inheriting Vercel's
  // release marker would make Identity interpret this loopback child as a
  // preview/production deployment.
  delete env.VERCEL_ENV;

  return {
    env,
    identityOrigin,
    rootAuthMode: hosted ? "hosted" : "fixture",
    mailbox:
      hosted
        ? null
        : {
            url: new URL("/api/dev/mailbox", identityOrigin).toString(),
            secret: env.IDENTITY_CAPTURE_MAILBOX_SECRET,
          },
  };
}
