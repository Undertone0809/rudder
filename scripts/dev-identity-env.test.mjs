import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveDevIdentityEnvironment } from "./dev-identity-env.mjs";

test("zero-config dev selects the complete local fixture and loopback Identity", () => {
  const result = resolveDevIdentityEnvironment({
    PORT: "3100",
    RUDDER_EMBEDDED_POSTGRES_PORT: "54329",
    RUDDER_IDENTITY_ORIGIN: "https://accounts.rudderhq.dev",
    IDENTITY_BASE_URL: "https://accounts.rudderhq.dev",
    IDENTITY_RELEASE_CHANNEL: "production",
    VERCEL_ENV: "production",
  });

  assert.equal(result.rootAuthMode, "fixture");
  assert.equal(result.identityOrigin, "http://127.0.0.1:43200");
  assert.equal(result.env.RUDDER_IDENTITY_ORIGIN, result.identityOrigin);
  assert.equal(result.env.IDENTITY_BASE_URL, result.identityOrigin);
  assert.equal(result.env.IDENTITY_ALLOWED_ORIGINS, result.identityOrigin);
  assert.equal(result.env.IDENTITY_RELEASE_CHANNEL, "development");
  assert.equal(result.env.VERCEL_ENV, undefined);
  assert.equal(result.env.IDENTITY_SUPABASE_URL, undefined);
  assert.equal(result.env.IDENTITY_MAIL_MODE, "capture");
  assert.match(result.env.IDENTITY_DATABASE_URL, /127\.0\.0\.1:54329\/rudder$/u);
  assert.equal(result.mailbox?.url, "http://127.0.0.1:43200/api/dev/mailbox");
  assert.ok((result.mailbox?.secret.length ?? 0) >= 16);
});

test("complete hosted development Supabase config keeps the local Identity facade", () => {
  const result = resolveDevIdentityEnvironment({
    PORT: "4100",
    RUDDER_EMBEDDED_POSTGRES_PORT: "55329",
    IDENTITY_SUPABASE_URL: "https://dev-project.supabase.co",
    IDENTITY_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_dev",
    IDENTITY_DATABASE_URL: "postgres://identity:secret@dev.db.example.com:5432/postgres",
  });

  assert.equal(result.rootAuthMode, "hosted");
  assert.equal(result.identityOrigin, "http://127.0.0.1:43200");
  assert.equal(result.env.RUDDER_IDENTITY_ORIGIN, result.identityOrigin);
  assert.equal(result.env.IDENTITY_SUPABASE_URL, "https://dev-project.supabase.co");
  assert.equal(result.env.IDENTITY_MAIL_MODE, "supabase_smtp");
  assert.equal(result.mailbox, null);
});

test("partial hosted Supabase config fails before any dev child starts", () => {
  assert.throws(
    () => resolveDevIdentityEnvironment({
      IDENTITY_SUPABASE_URL: "https://dev-project.supabase.co",
    }),
    /URL and publishable key must be configured together/u,
  );
});

test("hosted auth requires its matching Identity database", () => {
  assert.throws(
    () => resolveDevIdentityEnvironment({
      SUPABASE_URL: "https://dev-project.supabase.co",
      SUPABASE_ANON_KEY: "anon-dev",
    }),
    /requires IDENTITY_DATABASE_URL/u,
  );
});

test("explicit fixture refuses hosted credentials instead of silently ignoring them", () => {
  assert.throws(
    () => resolveDevIdentityEnvironment({
      IDENTITY_SUPABASE_AUTH_ENVIRONMENT: "fixture",
      IDENTITY_SUPABASE_URL: "https://dev-project.supabase.co",
      IDENTITY_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_dev",
    }),
    /cannot be combined/u,
  );
});

test("Identity port cannot overlap other local services", () => {
  assert.throws(
    () => resolveDevIdentityEnvironment({
      PORT: "3100",
      RUDDER_EMBEDDED_POSTGRES_PORT: "54329",
      RUDDER_IDENTITY_DEV_PORT: "3100",
    }),
    /must not overlap/u,
  );
});

test("identity-core exposes compiled JavaScript to the Electron runtime", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../packages/identity-core/package.json", import.meta.url), "utf8"),
  );

  assert.equal(packageJson.exports["."].development, undefined);
  assert.equal(packageJson.exports["."].types, "./src/index.ts");
  assert.equal(packageJson.exports["."].default, "./dist/index.js");
});
