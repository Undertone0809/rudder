import {
  generateOfflineDeviceKeyPair,
  hashOpaqueSecret,
} from "@rudderhq/identity-core";
import {
  accountEmails,
  beginCredentialRevocationIntent,
  claimCredentialRevocationIntent,
  completeCredentialRevocationIntent,
  createIdentityDb,
  credentialRevocationIntents,
  identityAuthAccounts,
  identityServerExchangeCodes,
  identityUsers,
  markCredentialProviderMutationComplete,
  recoverCredentialRevocationIntents,
  resolveVerifiedIdentity,
  securityEvents,
  supabaseAuthUserBindings,
} from "@rudderhq/identity-db";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import EmbeddedPostgres from "embedded-postgres";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityHandler } from "./handler.js";
import {
  RootIdentityError,
  type RootIdentityAdapter,
  type RootIdentityOtpPurpose,
  type RootIdentityPrincipal,
  type RootIdentityRequestContext,
  type RootIdentitySignOutScope,
} from "./root-identity-adapter.js";
import { getIdentityRuntime, resetIdentityRuntimeForTests } from "./runtime.js";

const TEST_SECRET = "identity-e2e-secret-with-at-least-thirty-two-characters";
const CAPTURE_MAILBOX_SECRET = "identity-e2e-capture-mailbox-secret";
const OFFLINE_SIGNING_KEYS = generateKeyPairSync("ed25519");
const FIXTURE_COOKIE = "rudder_root_fixture";

type FixtureUser = RootIdentityPrincipal & {
  password: string | null;
};

class FixtureRootIdentityAdapter implements RootIdentityAdapter {
  private readonly users = new Map<string, FixtureUser>();
  private readonly sessions = new Map<string, FixtureUser>();
  private readonly otps = new Map<string, { purpose: "email" | "signup" | "recovery"; token: string }>();

  latestOtp(email: string): string {
    const otp = this.otps.get(email.trim().toLowerCase());
    if (!otp) throw new Error(`No root-auth OTP for ${email}`);
    return otp.token;
  }

  authUserId(email: string): string {
    const user = this.users.get(email.trim().toLowerCase());
    if (!user) throw new Error(`No root-auth user for ${email}`);
    return user.id;
  }

  private cookie(context: RootIdentityRequestContext): string | null {
    const raw = context.requestHeaders.get("cookie");
    const entry = raw
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${FIXTURE_COOKIE}=`));
    return entry ? decodeURIComponent(entry.slice(FIXTURE_COOKIE.length + 1)) : null;
  }

  private async establish(
    context: RootIdentityRequestContext,
    user: FixtureUser,
  ): Promise<void> {
    const token = randomUUID();
    this.sessions.set(token, user);
    await context.setCookies(
      [{
        name: FIXTURE_COOKIE,
        value: token,
        options: { httpOnly: true, sameSite: "lax", path: "/" },
      }],
      { "cache-control": "private, no-store" },
    );
  }

  private verifiedUser(email: string, password: string | null = null): FixtureUser {
    const normalized = email.trim().toLowerCase();
    const existing = this.users.get(normalized);
    if (existing) {
      if (password !== null) existing.password = password;
      return existing;
    }
    const user: FixtureUser = {
      id: randomUUID(),
      email: normalized,
      emailVerified: true,
      displayName: normalized.split("@")[0] ?? null,
      avatarUrl: null,
      password,
    };
    this.users.set(normalized, user);
    return user;
  }

  async getPrincipal(context: RootIdentityRequestContext): Promise<RootIdentityPrincipal | null> {
    const token = this.cookie(context);
    return token ? this.sessions.get(token) ?? null : null;
  }

  async requireActivePrincipal(
    context: RootIdentityRequestContext,
  ): Promise<RootIdentityPrincipal> {
    const principal = await this.getPrincipal(context);
    if (!principal) {
      throw new RootIdentityError({
        code: "session_revoked",
        message: "This session is no longer active",
        status: 401,
      });
    }
    return principal;
  }

  async beginOAuth(
    _context: RootIdentityRequestContext,
    input: { provider: "google" | "github"; nextPath?: string },
  ): Promise<{ redirectUrl: string }> {
    return {
      redirectUrl: `https://oauth.fixture/${input.provider}?next=${encodeURIComponent(input.nextPath ?? "/")}`,
    };
  }

  async completePkceCallback(
    context: RootIdentityRequestContext,
    input: { code: string },
  ): Promise<RootIdentityPrincipal> {
    const email = input.code.includes("@") ? input.code : "oauth-fixture@example.com";
    const user = this.verifiedUser(email);
    await this.establish(context, user);
    return user;
  }

  async sendEmailOtp(
    _context: RootIdentityRequestContext,
    input: { email: string },
  ): Promise<void> {
    this.otps.set(input.email.trim().toLowerCase(), { purpose: "email", token: "123456" });
  }

  async verifyEmailOtp(
    context: RootIdentityRequestContext,
    input: { email: string; token: string; purpose: RootIdentityOtpPurpose },
  ): Promise<RootIdentityPrincipal> {
    const email = input.email.trim().toLowerCase();
    const otp = this.otps.get(email);
    const expectedPurpose = input.purpose === "email-verification" ? "signup" : "email";
    if (!otp || otp.token !== input.token || otp.purpose !== expectedPurpose) {
      throw new RootIdentityError({ code: "otp_expired", message: "Invalid OTP" });
    }
    const user = this.verifiedUser(email);
    this.otps.delete(email);
    await this.establish(context, user);
    return user;
  }

  async signUpWithPassword(
    _context: RootIdentityRequestContext,
    input: { email: string; password: string },
  ): Promise<{ principal: null; verificationRequired: true }> {
    const email = input.email.trim().toLowerCase();
    this.verifiedUser(email, input.password);
    this.otps.set(email, { purpose: "signup", token: "234567" });
    return { principal: null, verificationRequired: true };
  }

  async signInWithPassword(
    context: RootIdentityRequestContext,
    input: { email: string; password: string },
  ): Promise<RootIdentityPrincipal> {
    const user = this.users.get(input.email.trim().toLowerCase());
    if (!user || user.password !== input.password) {
      throw new RootIdentityError({
        code: "invalid_credentials",
        message: "Invalid credentials",
        status: 401,
      });
    }
    await this.establish(context, user);
    return user;
  }

  async requestPasswordReset(
    _context: RootIdentityRequestContext,
    input: { email: string },
  ): Promise<void> {
    const email = input.email.trim().toLowerCase();
    if (this.users.has(email)) {
      this.otps.set(email, { purpose: "recovery", token: "345678" });
    }
  }

  async resetPasswordWithOtp(
    context: RootIdentityRequestContext,
    input: { email: string; token: string; newPassword: string },
    beforeMutation: (principal: RootIdentityPrincipal) => Promise<void>,
  ): Promise<RootIdentityPrincipal> {
    const email = input.email.trim().toLowerCase();
    const otp = this.otps.get(email);
    const user = this.users.get(email);
    if (!user || !otp || otp.purpose !== "recovery" || otp.token !== input.token) {
      throw new RootIdentityError({ code: "otp_expired", message: "Invalid OTP" });
    }
    await beforeMutation(user);
    user.password = input.newPassword;
    this.otps.delete(email);
    for (const [candidate, sessionUser] of this.sessions) {
      if (sessionUser.id === user.id) this.sessions.delete(candidate);
    }
    await context.setCookies(
      [{
        name: FIXTURE_COOKIE,
        value: "",
        options: { httpOnly: true, maxAge: 0, sameSite: "lax", path: "/" },
      }],
      { "cache-control": "private, no-store" },
    );
    return user;
  }

  async completePasswordRecovery(
    context: RootIdentityRequestContext,
    input: { code?: string; tokenHash?: string },
  ): Promise<RootIdentityPrincipal> {
    const recoveryToken = input.code ?? input.tokenHash;
    const match = [...this.otps.entries()].find(([, value]) =>
      value.purpose === "recovery" && value.token === recoveryToken
    );
    if (!match) {
      throw new RootIdentityError({
        code: "invalid_recovery_link",
        message: "Invalid recovery link",
      });
    }
    const user = this.users.get(match[0]);
    if (!user) throw new Error("Fixture recovery user missing");
    this.otps.delete(match[0]);
    await this.establish(context, user);
    return user;
  }

  async updateRecoveredPassword(
    context: RootIdentityRequestContext,
    input: { newPassword: string },
    beforeMutation: (principal: RootIdentityPrincipal) => Promise<void>,
  ): Promise<RootIdentityPrincipal> {
    const principal = await this.requireActivePrincipal(context);
    const user = this.users.get(principal.email);
    if (!user) throw new Error("Fixture recovery user missing");
    await beforeMutation(user);
    user.password = input.newPassword;
    for (const [candidate, sessionUser] of this.sessions) {
      if (sessionUser.id === user.id) this.sessions.delete(candidate);
    }
    await context.setCookies(
      [{
        name: FIXTURE_COOKIE,
        value: "",
        options: { httpOnly: true, maxAge: 0, sameSite: "lax", path: "/" },
      }],
      { "cache-control": "private, no-store" },
    );
    return user;
  }

  async requestPasswordChangeVerification(
    context: RootIdentityRequestContext,
  ): Promise<void> {
    const principal = await this.getPrincipal(context);
    if (!principal) {
      throw new RootIdentityError({ code: "unauthorized", message: "Unauthorized", status: 401 });
    }
    this.otps.set(principal.email, { purpose: "recovery", token: "456789" });
  }

  async updatePassword(
    context: RootIdentityRequestContext,
    input: {
      newPassword: string;
      verificationCode: string;
      revokeOthers: boolean;
    },
    beforeMutation: (principal: RootIdentityPrincipal) => Promise<void>,
  ): Promise<RootIdentityPrincipal> {
    const principal = await this.getPrincipal(context);
    const otp = principal ? this.otps.get(principal.email) : null;
    if (!principal || !otp || otp.token !== input.verificationCode) {
      throw new RootIdentityError({ code: "reauthentication_required", message: "Reauthenticate" });
    }
    const user = this.users.get(principal.email)!;
    await beforeMutation(user);
    user.password = input.newPassword;
    this.otps.delete(principal.email);
    return user;
  }

  async signOut(
    context: RootIdentityRequestContext,
    scope: RootIdentitySignOutScope,
  ): Promise<void> {
    const token = this.cookie(context);
    const current = token ? this.sessions.get(token) : null;
    if (!current) {
      throw new RootIdentityError({ code: "unauthorized", message: "Unauthorized", status: 401 });
    }
    if (scope === "current") {
      this.sessions.delete(token!);
    } else {
      for (const [candidate, user] of this.sessions) {
        if (user.id === current.id && (scope === "global" || candidate !== token)) {
          this.sessions.delete(candidate);
        }
      }
    }
    if (scope !== "others") {
      await context.setCookies(
        [{
          name: FIXTURE_COOKIE,
          value: "",
          options: { httpOnly: true, maxAge: 0, sameSite: "lax", path: "/" },
        }],
        { "cache-control": "private, no-store" },
      );
    }
  }
}

function cookieFrom(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

describe("Rudder Identity HTTP journey with Supabase root-auth fixture", () => {
  let postgres: EmbeddedPostgres | undefined;
  let httpServer: Server | undefined;
  let tempDirectory: string;
  let baseUrl: string;
  const rootIdentity = new FixtureRootIdentityAdapter();

  async function availablePort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("Unable to reserve test port");
    await new Promise<void>((resolve, reject) => {
      probe.close((error) => error ? reject(error) : resolve());
    });
    return address.port;
  }

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-real-ip": "127.0.0.1",
        ...headers,
      },
      body: JSON.stringify(body),
      redirect: "manual",
    });

  async function otpSignIn(email: string): Promise<string> {
    expect(
      (await post("/api/root-auth/email-otp/send", { email, nextPath: "/" })).status,
    ).toBe(200);
    const response = await post("/api/root-auth/email-otp/verify", {
      email,
      token: rootIdentity.latestOtp(email),
      purpose: "sign-in",
    });
    expect(response.status).toBe(200);
    return cookieFrom(response);
  }

  beforeAll(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "rudder-identity-e2e-"));
    const postgresPort = await availablePort();
    postgres = new EmbeddedPostgres({
      databaseDir: join(tempDirectory, "postgres"),
      user: "identity",
      password: "identity-e2e-password",
      port: postgresPort,
      persistent: false,
    });
    await postgres.initialise();
    await postgres.start();
    const databaseUrl =
      `postgres://identity:identity-e2e-password@127.0.0.1:${postgresPort}/postgres`;
    const migrationConnection = createIdentityDb(databaseUrl);
    await migrationConnection.db.execute(sql.raw(`
      CREATE ROLE rudder_identity_app;
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE SCHEMA rudder_identity;
      GRANT USAGE ON SCHEMA rudder_identity TO rudder_identity_app;
      CREATE SCHEMA auth;
      CREATE TABLE auth.sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        not_after timestamptz
      );
    `));
    await migrate(migrationConnection.db, {
      migrationsFolder: fileURLToPath(
        new URL("../../packages/identity-db/src/migrations", import.meta.url),
      ),
      migrationsSchema: "rudder_identity",
      migrationsTable: "__drizzle_migrations",
    });
    const verifierUserId = randomUUID();
    const activeVerifierSessionId = randomUUID();
    const expiredVerifierSessionId = randomUUID();
    await migrationConnection.db.execute(sql`
      insert into auth.sessions (id, user_id, not_after)
      values
        (
          ${activeVerifierSessionId}::uuid,
          ${verifierUserId}::uuid,
          now() + interval '5 minutes'
        ),
        (
          ${expiredVerifierSessionId}::uuid,
          ${verifierUserId}::uuid,
          now() - interval '5 minutes'
        )
    `);
    const verifierPrivileges = await migrationConnection.db.execute<{
      auth_schema_usage: boolean;
      id_select: boolean;
      user_id_select: boolean;
      not_after_select: boolean;
      verifier_execute: boolean;
    }>(sql`
      select
        has_schema_privilege('rudder_identity_app', 'auth', 'USAGE')
          as auth_schema_usage,
        has_column_privilege('rudder_identity_app', 'auth.sessions', 'id', 'SELECT')
          as id_select,
        has_column_privilege('rudder_identity_app', 'auth.sessions', 'user_id', 'SELECT')
          as user_id_select,
        has_column_privilege('rudder_identity_app', 'auth.sessions', 'not_after', 'SELECT')
          as not_after_select,
        has_function_privilege(
          'rudder_identity_app',
          'rudder_identity.is_active_auth_session(uuid, uuid)',
          'EXECUTE'
        ) as verifier_execute
    `);
    expect(verifierPrivileges).toEqual([
      {
        auth_schema_usage: false,
        id_select: false,
        user_id_select: false,
        not_after_select: false,
        verifier_execute: true,
      },
    ]);
    await migrationConnection.db.execute(sql.raw("SET ROLE rudder_identity_app"));
    const verifierResults = await migrationConnection.db.execute<{
      active: boolean;
      expired: boolean;
      wrong_user: boolean;
    }>(sql`
      select
        rudder_identity.is_active_auth_session(
          ${activeVerifierSessionId}::uuid,
          ${verifierUserId}::uuid
        ) as active,
        rudder_identity.is_active_auth_session(
          ${expiredVerifierSessionId}::uuid,
          ${verifierUserId}::uuid
        ) as expired,
        rudder_identity.is_active_auth_session(
          ${activeVerifierSessionId}::uuid,
          ${randomUUID()}::uuid
        ) as wrong_user
    `);
    await migrationConnection.db.execute(sql.raw("RESET ROLE"));
    expect(verifierResults).toEqual([
      { active: true, expired: false, wrong_user: false },
    ]);
    await migrationConnection.close();

    Object.assign(process.env, {
      IDENTITY_RELEASE_CHANNEL: "test",
      IDENTITY_BASE_URL: "http://127.0.0.1",
      IDENTITY_DATABASE_URL: databaseUrl,
      IDENTITY_BETTER_AUTH_SECRET: TEST_SECRET,
      IDENTITY_DEVICE_CLIENT_IDS: "rudder-desktop,rudder-cli",
      IDENTITY_SUPPORT_EMAIL: "support@rudderhq.dev",
      IDENTITY_MAIL_FROM: "Rudder Account <account@updates.rudderhq.dev>",
      IDENTITY_MAIL_MODE: "capture",
      IDENTITY_CAPTURE_MAILBOX_SECRET: CAPTURE_MAILBOX_SECRET,
      IDENTITY_OFFLINE_GRANT_KEY_ID: "identity-e2e-key",
      IDENTITY_OFFLINE_GRANT_PRIVATE_KEY: OFFLINE_SIGNING_KEYS.privateKey
        .export({ format: "der", type: "pkcs8" }).toString("base64url"),
    });

    const server = createServer((req, res) => {
      void identityHandler(req, res, { rootIdentityAdapter: rootIdentity }).catch(() => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "internal_server_error" }));
      });
    });
    httpServer = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Identity E2E server failed");
    baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.IDENTITY_BASE_URL = baseUrl;
    await resetIdentityRuntimeForTests();
  }, 60_000);

  afterAll(async () => {
    await resetIdentityRuntimeForTests();
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer?.close((error) => error ? reject(error) : resolve());
      });
    }
    if (postgres) await postgres.stop();
    await rm(tempDirectory, { recursive: true, force: true });
  }, 30_000);

  it("serves the login surface and exposes no Better Auth root routes", async () => {
    const home = await fetch(`${baseUrl}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("cache-control")).toBe("no-store");
    expect(await home.text()).toContain("Continue with Google");
    const logo = await fetch(`${baseUrl}/rudder-logo.png`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${baseUrl}/favicon.ico`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
    expect((await post("/api/auth/sign-in/email", {
      email: "legacy@example.com",
      password: "not-used",
    })).status).toBe(404);
  });

  it("serves legal and bootstrap assets without database or auth secrets", async () => {
    const databaseUrl = process.env.IDENTITY_DATABASE_URL;
    const secret = process.env.IDENTITY_BETTER_AUTH_SECRET;
    delete process.env.IDENTITY_DATABASE_URL;
    delete process.env.IDENTITY_BETTER_AUTH_SECRET;
    try {
      expect((await fetch(`${baseUrl}/`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/privacy`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/terms`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/identity.js`)).status).toBe(200);
      const logo = await fetch(`${baseUrl}/rudder-logo.png`);
      expect(logo.status).toBe(200);
      expect(logo.headers.get("content-type")).toBe("image/png");
      expect((await fetch(`${baseUrl}/favicon.ico`)).status).toBe(200);
    } finally {
      if (databaseUrl === undefined) delete process.env.IDENTITY_DATABASE_URL;
      else process.env.IDENTITY_DATABASE_URL = databaseUrl;
      if (secret === undefined) delete process.env.IDENTITY_BETTER_AUTH_SECRET;
      else process.env.IDENTITY_BETTER_AUTH_SECRET = secret;
    }
  });

  it("serves production routes and the four login controls", async () => {
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
    const homeResponse = await fetch(`${baseUrl}/`);
    expect(homeResponse.headers.get("cache-control")).toBe("no-store");
    const home = await homeResponse.text();
    expect(home).toContain("Continue with Google");
    expect(home).toContain("Continue with GitHub");
    expect(home).toContain("Continue with email code");
    expect(home).toContain("Sign in with password");
    expect((await fetch(`${baseUrl}/privacy`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/terms`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/identity.js`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/rudder-logo.png`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/favicon.ico`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/dev/mailbox`)).status).toBe(404);
  });

  it("runs OAuth, OTP, password signup/reset and scoped sign-out through root-auth", async () => {
    const oauth = await post("/api/root-auth/oauth", {
      provider: "google",
      nextPath: "/account",
    });
    expect(await oauth.json()).toEqual({
      redirectUrl: "https://oauth.fixture/google?next=%2Faccount",
    });
    const callback = await fetch(
      `${baseUrl}/auth/callback?code=oauth-e2e%40example.com&next=%2Faccount`,
      { redirect: "manual" },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/account");
    expect(
      (await fetch(`${baseUrl}/account`, {
        headers: { cookie: cookieFrom(callback) },
      })).status,
    ).toBe(200);

    const email = "password-root@example.com";
    const signup = await post("/api/root-auth/password/sign-up", {
      email,
      password: "initial-password",
    });
    expect(await signup.json()).toMatchObject({
      signedIn: false,
      verificationRequired: true,
    });
    const verification = await post("/api/root-auth/email-otp/verify", {
      email,
      token: rootIdentity.latestOtp(email),
      purpose: "email-verification",
    });
    expect(verification.status).toBe(200);

    expect(
      (await post("/api/root-auth/password/reset/request", { email })).status,
    ).toBe(200);
    expect(
      (await post("/api/root-auth/password/reset/confirm", {
        email,
        token: rootIdentity.latestOtp(email),
        newPassword: "replacement-password",
      })).status,
    ).toBe(200);
    expect(
      (await post("/api/root-auth/password/sign-in", {
        email,
        password: "initial-password",
      })).status,
    ).toBe(401);
    const signedIn = await post("/api/root-auth/password/sign-in", {
      email,
      password: "replacement-password",
    });
    expect(signedIn.status).toBe(200);
    const signedInCookie = cookieFrom(signedIn);
    expect(
      (await post("/api/root-auth/password/update", {
        newPassword: "must-not-change-without-code",
      }, { cookie: signedInCookie })).status,
    ).toBe(400);
    expect(
      (await post("/api/root-auth/password/reauthenticate", {}, {
        cookie: signedInCookie,
      })).status,
    ).toBe(200);
    const passwordChanged = await post("/api/root-auth/password/update", {
      newPassword: "replacement-password-again",
      verificationCode: rootIdentity.latestOtp(email),
      revokeOthers: false,
    }, { cookie: signedInCookie });
    expect(passwordChanged.status).toBe(200);
    expect(await passwordChanged.json()).toMatchObject({
      success: true,
      browserSessionsRevoked: false,
      desktopSessionsRevoked: false,
      localServerSessionStatus: "expires-or-syncs",
    });
    expect(
      (await post("/api/root-auth/sign-out", { scope: "others" }, {
        cookie: signedInCookie,
      })).status,
    ).toBe(200);
  });

  it("projects OAuth and Email OTP for one verified root user into one Rudder binding", async () => {
    const email = "linked-methods@example.com";
    const oauthCallback = await fetch(
      `${baseUrl}/auth/callback?code=${encodeURIComponent(email)}&next=%2Faccount`,
      { redirect: "manual" },
    );
    expect(oauthCallback.status).toBe(302);
    expect(
      (await fetch(`${baseUrl}/account`, {
        headers: { cookie: cookieFrom(oauthCallback) },
      })).status,
    ).toBe(200);

    const otpCookie = await otpSignIn(email.toUpperCase());
    expect(
      (await fetch(`${baseUrl}/account`, { headers: { cookie: otpCookie } })).status,
    ).toBe(200);

    const runtime = getIdentityRuntime();
    const bindings = await runtime.db
      .select({
        authUserId: supabaseAuthUserBindings.authUserId,
        rudderUserId: supabaseAuthUserBindings.rudderUserId,
        normalizedEmail: supabaseAuthUserBindings.normalizedEmail,
      })
      .from(supabaseAuthUserBindings)
      .where(eq(supabaseAuthUserBindings.normalizedEmail, email));
    expect(bindings).toEqual([{
      authUserId: rootIdentity.authUserId(email),
      rudderUserId: expect.any(String),
      normalizedEmail: email,
    }]);
  });

  it("converges concurrent verified Google and GitHub first login in PostgreSQL", async () => {
    const databaseUrl = process.env.IDENTITY_DATABASE_URL;
    if (!databaseUrl) throw new Error("Identity E2E database URL missing");
    const googleConnection = createIdentityDb(databaseUrl);
    const githubConnection = createIdentityDb(databaseUrl);
    const email = "Concurrent.Link+tag@Example.com";
    const normalizedEmail = email.toLowerCase();

    try {
      const [google, github] = await Promise.all([
        resolveVerifiedIdentity(googleConnection.db, {
          provider: "google",
          providerSubject: "google-concurrent-subject",
          email,
          emailVerified: true,
          name: "Concurrent Owner",
        }),
        resolveVerifiedIdentity(githubConnection.db, {
          provider: "github",
          providerSubject: "github-concurrent-subject",
          email: ` ${normalizedEmail} `,
          emailVerified: true,
          name: "Concurrent Owner",
        }),
      ]);

      expect(google.userId).toBe(github.userId);
      expect([google.created, github.created].sort()).toEqual([false, true]);

      const users = await googleConnection.db
        .select({ id: identityUsers.id })
        .from(identityUsers)
        .where(eq(identityUsers.email, normalizedEmail));
      const emails = await googleConnection.db
        .select({ userId: accountEmails.userId })
        .from(accountEmails)
        .where(eq(accountEmails.normalizedEmail, normalizedEmail));
      const providers = await googleConnection.db
        .select({
          providerId: identityAuthAccounts.providerId,
          accountId: identityAuthAccounts.accountId,
          userId: identityAuthAccounts.userId,
        })
        .from(identityAuthAccounts)
        .where(eq(identityAuthAccounts.userId, google.userId));
      const events = await googleConnection.db
        .select({ eventType: securityEvents.eventType })
        .from(securityEvents)
        .where(eq(securityEvents.userId, google.userId));

      expect(users).toEqual([{ id: google.userId }]);
      expect(emails).toEqual([{ userId: google.userId }]);
      expect(providers).toEqual(expect.arrayContaining([
        {
          providerId: "google",
          accountId: "google-concurrent-subject",
          userId: google.userId,
        },
        {
          providerId: "github",
          accountId: "github-concurrent-subject",
          userId: google.userId,
        },
      ]));
      expect(providers).toHaveLength(2);
      expect(events.map(({ eventType }) => eventType).sort()).toEqual([
        "account.created",
        "identity.linked",
      ]);
    } finally {
      await Promise.all([googleConnection.close(), githubConnection.close()]);
    }
  });

  it("fails closed on login CSRF and completes the recovery-link page journey", async () => {
    const crossOrigin = await fetch(`${baseUrl}/api/root-auth/password/sign-in`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({
        email: "csrf@example.com",
        password: "not-relevant",
      }),
    });
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toMatchObject({ error: "invalid_origin" });

    const wrongContentType = await fetch(`${baseUrl}/api/root-auth/email-otp/send`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        origin: baseUrl,
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ email: "csrf@example.com" }),
    });
    expect(wrongContentType.status).toBe(403);
    expect(await wrongContentType.json()).toMatchObject({
      error: "invalid_content_type",
    });
    const missingFetchMetadata = await fetch(
      `${baseUrl}/api/root-auth/email-otp/send`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: baseUrl,
        },
        body: JSON.stringify({ email: "csrf@example.com" }),
      },
    );
    expect(missingFetchMetadata.status).toBe(403);
    expect(await missingFetchMetadata.json()).toMatchObject({
      error: "invalid_fetch_metadata",
    });

    const email = "recovery-link@example.com";
    expect((await post("/api/root-auth/password/sign-up", {
      email,
      password: "initial-recovery-password",
    })).status).toBe(200);
    expect((await post("/api/root-auth/email-otp/verify", {
      email,
      token: rootIdentity.latestOtp(email),
      purpose: "email-verification",
    })).status).toBe(200);
    expect((await post("/api/root-auth/password/reset/request", { email })).status).toBe(200);

    const recoveryPage = await fetch(
      `${baseUrl}/reset-password?token_hash=${rootIdentity.latestOtp(email)}&type=recovery`,
    );
    expect(recoveryPage.status).toBe(200);
    expect(await recoveryPage.clone().text()).toContain('id="recovery-password-form"');
    const completed = await post(
      "/api/root-auth/password/recovery/complete",
      { newPassword: "replacement-from-recovery-link" },
      { cookie: cookieFrom(recoveryPage) },
    );
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({
      passwordUpdated: true,
      browserSessionsRevoked: true,
      desktopSessionsRevoked: true,
      localServerSessionStatus: "expires-or-syncs",
    });
    expect((await post("/api/root-auth/password/sign-in", {
      email,
      password: "replacement-from-recovery-link",
    })).status).toBe(200);
  });

  it("keeps native Desktop OTP sessions server-side and returns only a Rudder PKCE code", async () => {
    const email = "native-desktop-otp@example.com";
    const verifier = randomBytes(48).toString("base64url");
    const redirectUri = "http://127.0.0.1:49998/callback";
    expect((await post("/api/desktop/native-auth/email-otp/send", {
      client_id: "rudder-desktop",
      email,
    })).status).toBe(200);

    expect((await post("/api/desktop/native-auth/email-otp/verify", {
      client_id: "rudder-desktop",
      email,
      token: rootIdentity.latestOtp(email),
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      audience: "",
    })).status).toBe(400);

    const authorization = await post("/api/desktop/native-auth/email-otp/verify", {
      client_id: "rudder-desktop",
      email,
      token: rootIdentity.latestOtp(email),
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      audience: "native-desktop-installation",
    });
    expect(authorization.status).toBe(200);
    expect(authorization.headers.getSetCookie()).toEqual([]);
    const authorizationBody = await authorization.json() as Record<string, unknown>;
    expect(authorizationBody).toEqual({ code: expect.any(String) });
    expect(JSON.stringify(authorizationBody)).not.toMatch(/access_token|refresh_token|session/iu);

    const exchanged = await post("/api/desktop/token", {
      grant_type: "authorization_code",
      code: authorizationBody.code,
      client_id: "rudder-desktop",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      installation_id: "native-desktop-installation",
      device_name: "Native OTP Desktop",
      sign_out_epoch: 0,
    });
    expect(exchanged.status).toBe(200);
    expect(await exchanged.json()).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      account: { email },
    });
  });

  it("keeps native Desktop password sign-in and reset off the browser session surface", async () => {
    const email = "native-desktop-password@example.com";
    expect((await post("/api/root-auth/password/sign-up", {
      email,
      password: "initial-native-password",
    })).status).toBe(200);
    expect((await post("/api/root-auth/email-otp/verify", {
      email,
      token: rootIdentity.latestOtp(email),
      purpose: "email-verification",
    })).status).toBe(200);

    const authorizationInput = (verifier: string, suffix: string) => ({
      client_id: "rudder-desktop",
      redirect_uri: `http://127.0.0.1:49997/${suffix}`,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      audience: `native-password-${suffix}`,
    });
    const passwordVerifier = randomBytes(48).toString("base64url");
    const passwordSignIn = await post("/api/desktop/native-auth/password/sign-in", {
      ...authorizationInput(passwordVerifier, "sign-in"),
      email,
      password: "initial-native-password",
    });
    expect(passwordSignIn.status).toBe(200);
    expect(passwordSignIn.headers.getSetCookie()).toEqual([]);
    expect(await passwordSignIn.json()).toEqual({ code: expect.any(String) });

    expect((await post("/api/desktop/native-auth/password/reset/request", {
      client_id: "rudder-desktop",
      email,
    })).status).toBe(200);
    const resetVerifier = randomBytes(48).toString("base64url");
    const passwordReset = await post("/api/desktop/native-auth/password/reset/confirm", {
      ...authorizationInput(resetVerifier, "reset"),
      email,
      token: rootIdentity.latestOtp(email),
      newPassword: "replacement-native-password",
    });
    expect(passwordReset.status).toBe(200);
    expect(passwordReset.headers.getSetCookie()).toEqual([]);
    expect(await passwordReset.json()).toEqual({ code: expect.any(String) });

    const oldPassword = await post("/api/desktop/native-auth/password/sign-in", {
      ...authorizationInput(randomBytes(48).toString("base64url"), "old-password"),
      email,
      password: "initial-native-password",
    });
    expect(oldPassword.status).toBe(401);
  });

  it("uses Supabase browser identity only to issue Rudder Desktop PKCE credentials", async () => {
    const email = "desktop-pkce@example.com";
    const cookie = await otpSignIn(email);
    const verifier = randomBytes(48).toString("base64url");
    const redirectUri = "http://127.0.0.1:49999/callback";
    const authorize = new URL(`${baseUrl}/api/desktop/authorize`);
    for (const [key, value] of Object.entries({
      client_id: "rudder-desktop",
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: randomBytes(20).toString("base64url"),
      audience: "desktop-pkce-installation",
    })) {
      authorize.searchParams.set(key, value);
    }
    const authorization = await fetch(authorize, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(authorization.status).toBe(302);
    const code = new URL(authorization.headers.get("location")!).searchParams.get("code");
    const exchanged = await post("/api/desktop/token", {
      grant_type: "authorization_code",
      code,
      client_id: "rudder-desktop",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      installation_id: "desktop-pkce-installation",
      device_name: "PKCE E2E Desktop",
      sign_out_epoch: 0,
      device_public_key_thumbprint: generateOfflineDeviceKeyPair().thumbprint,
    });
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json() as {
      access_token: string;
      refresh_token: string;
      offline_grant: string;
      account: { id: string };
      device: { id: string };
    };
    expect(tokens).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      offline_grant: expect.any(String),
    });

    const exchange = await post("/api/server/exchange", {
      installation_id: "desktop-pkce-installation",
      audience: "desktop-pkce-installation",
    }, { authorization: `Bearer ${tokens.access_token}` });
    const exchangeCode = (await exchange.json() as { code: string }).code;
    expect(
      (await post("/api/server/exchange/verify", {
        code: exchangeCode,
        expected_audience: "desktop-pkce-installation",
        expected_installation_id: "desktop-pkce-installation",
      })).status,
    ).toBe(200);
    const runtime = getIdentityRuntime();
    const pending = await beginCredentialRevocationIntent(runtime.db, {
      userId: tokens.account.id,
      rootIdentityUserId: rootIdentity.authUserId(email),
      operation: "password-change",
      deviceScope: "none",
    });
    await expect(beginCredentialRevocationIntent(runtime.db, {
      userId: tokens.account.id,
      rootIdentityUserId: rootIdentity.authUserId(email),
      operation: "password-change",
      deviceScope: "none",
    })).resolves.toMatchObject({ id: pending.id, state: "pending-provider" });
    await expect(beginCredentialRevocationIntent(runtime.db, {
      userId: tokens.account.id,
      rootIdentityUserId: rootIdentity.authUserId(email),
      operation: "global-sign-out",
      deviceScope: "all",
    })).rejects.toThrow("credential_revocation_pending");
    expect(
      (await fetch(`${baseUrl}/api/account/devices`, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })).status,
    ).toBe(401);
    await markCredentialProviderMutationComplete(runtime.db, pending.id);
    await completeCredentialRevocationIntent(runtime.db, pending.id);
    expect(
      (await fetch(`${baseUrl}/api/account/devices/${tokens.device.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${tokens.access_token}` },
      })).status,
    ).toBe(200);

    const recoverable = await beginCredentialRevocationIntent(runtime.db, {
      userId: tokens.account.id,
      rootIdentityUserId: rootIdentity.authUserId(email),
      operation: "global-sign-out",
      deviceScope: "all",
    });
    await markCredentialProviderMutationComplete(runtime.db, recoverable.id);
    const firstRecoveryAt = new Date();
    await expect(recoverCredentialRevocationIntents(runtime.db, {
      claimOwner: "fault-injection-worker",
      now: firstRecoveryAt,
      maxClaims: 1,
      revokeRudderCredentials: async () => {
        throw new Error("injected_rudder_revocation_failure");
      },
    })).resolves.toEqual({ completed: 0, failed: 1, escalated: 0 });
    await expect(runtime.db
      .select({
        state: credentialRevocationIntents.state,
        claimOwner: credentialRevocationIntents.claimOwner,
        lastError: credentialRevocationIntents.lastError,
      })
      .from(credentialRevocationIntents)
      .where(eq(credentialRevocationIntents.id, recoverable.id)))
      .resolves.toEqual([{
        state: "pending-rudder",
        claimOwner: null,
        lastError: "injected_rudder_revocation_failure",
      }]);

    let retried = 0;
    await expect(recoverCredentialRevocationIntents(runtime.db, {
      claimOwner: "replacement-worker",
      now: new Date(firstRecoveryAt.getTime() + 5_000),
      maxClaims: 1,
      revokeRudderCredentials: async () => {
        retried += 1;
      },
    })).resolves.toEqual({ completed: 1, failed: 0, escalated: 0 });
    expect(retried).toBe(1);
    await expect(runtime.db
      .select({ state: credentialRevocationIntents.state })
      .from(credentialRevocationIntents)
      .where(eq(credentialRevocationIntents.id, recoverable.id)))
      .resolves.toEqual([{ state: "completed" }]);

    const abandonedLease = await beginCredentialRevocationIntent(runtime.db, {
      userId: tokens.account.id,
      rootIdentityUserId: rootIdentity.authUserId(email),
      operation: "password-change",
      deviceScope: "none",
    });
    await markCredentialProviderMutationComplete(runtime.db, abandonedLease.id);
    const crashedAt = new Date();
    await expect(claimCredentialRevocationIntent(runtime.db, {
      claimOwner: "crashed-worker",
      now: crashedAt,
    })).resolves.toMatchObject({
      id: abandonedLease.id,
      claimOwner: "crashed-worker",
    });
    await expect(recoverCredentialRevocationIntents(runtime.db, {
      claimOwner: "lease-takeover-worker",
      now: new Date(crashedAt.getTime() + 31_000),
      maxClaims: 1,
      revokeRudderCredentials: async () => undefined,
    })).resolves.toEqual({ completed: 1, failed: 0, escalated: 0 });

    const uncertainProvider = await beginCredentialRevocationIntent(runtime.db, {
      userId: tokens.account.id,
      rootIdentityUserId: rootIdentity.authUserId(email),
      operation: "password-reset",
      deviceScope: "all",
    });
    const manualRepairAt = new Date();
    await runtime.db
      .update(credentialRevocationIntents)
      .set({ updatedAt: new Date(manualRepairAt.getTime() - 10_000) })
      .where(eq(credentialRevocationIntents.id, uncertainProvider.id));
    await expect(recoverCredentialRevocationIntents(runtime.db, {
      claimOwner: "manual-repair-worker",
      now: manualRepairAt,
      manualRepairAfterMs: 1_000,
      maxClaims: 1,
      revokeRudderCredentials: async () => {
        throw new Error("provider stage must never be replayed");
      },
    })).resolves.toEqual({ completed: 0, failed: 0, escalated: 1 });
    await expect(runtime.db
      .select({ state: credentialRevocationIntents.state })
      .from(credentialRevocationIntents)
      .where(eq(credentialRevocationIntents.id, uncertainProvider.id)))
      .resolves.toEqual([{ state: "manual-repair" }]);
  });

  it("prefills Desktop email through a short-lived PKCE-bound opaque intent", async () => {
    const binding = {
      client_id: "rudder-desktop",
      redirect_uri: "http://127.0.0.1:49998/callback",
      code_challenge: randomBytes(32).toString("base64url"),
      state: randomBytes(20).toString("base64url"),
    };
    const created = await post("/api/desktop/sign-in-intent", {
      ...binding,
      method: "email_otp",
      email: "Desktop-Prefill@Example.com",
    });
    expect(created.status).toBe(200);
    const { intent } = await created.json() as { intent: string };
    expect(intent).not.toContain("Desktop-Prefill");

    const resolved = await post("/api/desktop/sign-in-intent/resolve", {
      ...binding,
      intent,
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({
      method: "email_otp",
      email: "desktop-prefill@example.com",
    });

    const wrongBinding = await post("/api/desktop/sign-in-intent/resolve", {
      ...binding,
      state: randomBytes(20).toString("base64url"),
      intent,
    });
    expect(wrongBinding.status).toBe(400);
  });

  it("approves a Rudder-owned Device Code and polling directly issues the device session", async () => {
    const cookie = await otpSignIn("device-code@example.com");
    const issued = await post("/api/desktop/device-code", {
      client_id: "rudder-desktop",
      scope: "openid profile email",
    });
    expect(issued.status).toBe(200);
    const device = await issued.json() as { device_code: string; user_code: string };
    expect(
      (await fetch(`${baseUrl}/device?user_code=${encodeURIComponent(device.user_code)}`, {
        headers: { cookie },
      })).status,
    ).toBe(200);
    expect(
      (await post("/api/desktop/device-code/approve", {
        userCode: device.user_code,
      }, { cookie })).status,
    ).toBe(200);

    const polled = await post("/api/desktop/device-code/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: "rudder-desktop",
      installation_id: "device-code-installation",
      device_name: "Device Code E2E",
      sign_out_epoch: 0,
    });
    expect(polled.status).toBe(200);
    expect(await polled.json()).toMatchObject({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      device: { installationId: "device-code-installation" },
    });
    expect(
      (await post("/api/desktop/device-code/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: "rudder-desktop",
        installation_id: "replay",
        device_name: "Replay",
        sign_out_epoch: 0,
      })).status,
    ).toBe(400);
  });

  it("persistently rate-limits approve and deny mutations by normalized user code", async () => {
    const cookie = await otpSignIn("device-rate-limit@example.com");
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(
        (await post("/api/desktop/device-code/approve", {
          userCode: attempt % 2 === 0 ? "RATE-LIMIT" : "rate limit",
        }, { cookie })).status,
      ).toBe(400);
    }
    const limited = await post("/api/desktop/device-code/deny", {
      userCode: "RATE LIMIT",
    }, { cookie });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("returns a server failure instead of invalid_grant when refresh storage is unavailable", async () => {
    const runtime = getIdentityRuntime({ rootIdentityAdapter: rootIdentity });
    const database = runtime.db as typeof runtime.db & {
      transaction: (...args: unknown[]) => Promise<never>;
    };
    database.transaction = async () => {
      throw new Error("fixture_database_unavailable");
    };

    const response = await post("/api/desktop/refresh", {
      grant_type: "refresh_token",
      refresh_token: "valid-shape-refresh-token",
      client_id: "rudder-desktop",
      sign_out_epoch: 0,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_server_error" });
  });

  it("rejects expired server exchange codes", async () => {
    const runtime = getIdentityRuntime({ rootIdentityAdapter: rootIdentity });
    const code = randomBytes(32).toString("base64url");
    await runtime.db
      .update(identityServerExchangeCodes)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(identityServerExchangeCodes.codeHash, hashOpaqueSecret(code)));
    expect(
      (await post("/api/server/exchange/verify", {
        code,
        expected_audience: "local",
        expected_installation_id: "local",
      })).status,
    ).toBe(400);
  });
});
