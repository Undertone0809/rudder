import {
  generateOfflineDeviceKeyPair,
  hashOpaqueSecret,
} from "@rudderhq/identity-core";
import {
  createIdentityDb,
  identityServerExchangeCodes,
  resolveVerifiedIdentity,
  securityEvents,
} from "@rudderhq/identity-db";
import { eq } from "drizzle-orm";
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
import { getIdentityRuntime, resetIdentityRuntimeForTests } from "./runtime.js";
import { verifiedIdentityAdapter } from "./verified-identity-adapter.js";

const TEST_SECRET = "identity-e2e-secret-with-at-least-thirty-two-characters";
const CAPTURE_MAILBOX_SECRET = "identity-e2e-capture-mailbox-secret";
const OFFLINE_SIGNING_KEYS = generateKeyPairSync("ed25519");

function cookieFrom(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
}

describe("Rudder Identity HTTP journey", () => {
  let postgres: EmbeddedPostgres | undefined;
  let httpServer: Server | undefined;
  let tempDirectory: string;
  let baseUrl: string;
  const backgroundTasks = new Set<Promise<unknown>>();

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
        "x-real-ip": "127.0.0.1",
        ...headers,
      },
      body: JSON.stringify(body),
      redirect: "manual",
    });

  async function latestOtp(email: string, category?: string): Promise<string> {
    const mailbox = await capturedMailbox();
    const message = mailbox.messages
      .filter((candidate) => candidate.to === email && (!category || candidate.category === category))
      .at(-1);
    const otp = message?.text.match(/\b(\d{6})\b/u)?.[1];
    if (!otp) throw new Error(`No OTP captured for ${email}`);
    return otp;
  }

  async function capturedMailbox() {
    await Promise.all(backgroundTasks);
    return await (await fetch(`${baseUrl}/api/dev/mailbox`, {
      headers: { authorization: `Bearer ${CAPTURE_MAILBOX_SECRET}` },
    })).json() as {
      messages: Array<{ to: string; text: string; category: string }>;
    };
  }

  beforeAll(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "rudder-identity-e2e-"));
    const externalDatabaseUrl = process.env.RUDDER_IDENTITY_TEST_DATABASE_URL?.trim();
    let databaseUrl = externalDatabaseUrl;
    if (!databaseUrl) {
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
      databaseUrl = `postgres://identity:identity-e2e-password@127.0.0.1:${postgresPort}/postgres`;
    }
    const migrationConnection = createIdentityDb(databaseUrl);
    await migrate(migrationConnection.db, {
      migrationsFolder: fileURLToPath(
        new URL("../../packages/identity-db/src/migrations", import.meta.url),
      ),
      migrationsSchema: "rudder_identity",
      migrationsTable: "__drizzle_migrations",
    });
    await migrationConnection.close();

    const server = createServer((req, res) => {
      void identityHandler(req, res, {
        backgroundTaskHandler: (promise) => {
          let tracked: Promise<unknown>;
          tracked = promise.finally(() => backgroundTasks.delete(tracked));
          backgroundTasks.add(tracked);
        },
      }).catch(() => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "internal_server_error" }));
      });
    });
    httpServer = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Identity E2E server failed");
    baseUrl = `http://127.0.0.1:${address.port}`;
    Object.assign(process.env, {
      IDENTITY_RELEASE_CHANNEL: "test",
      IDENTITY_BASE_URL: baseUrl,
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
      process.env.IDENTITY_DATABASE_URL = databaseUrl;
      process.env.IDENTITY_BETTER_AUTH_SECRET = secret;
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

  it("runs password signup, verification, reset, and session revocation", async () => {
    const email = "password-e2e@example.com";
    const signUp = await post("/api/auth/sign-up/email", {
      name: "Password E2E",
      email,
      password: "initial-password",
    });
    expect(signUp.status).toBe(200);
    const verify = await post("/api/auth/email-otp/verify-email", {
      email,
      otp: await latestOtp(email, "email-verification"),
    });
    expect(verify.status).toBe(200);

    const first = await post("/api/auth/sign-in/email", {
      email,
      password: "initial-password",
    });
    const second = await post("/api/auth/sign-in/email", {
      email,
      password: "initial-password",
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstCookie = cookieFrom(first);
    const secondCookie = cookieFrom(second);

    expect((await post("/api/auth/email-otp/request-password-reset", { email })).status).toBe(200);
    const reset = await post("/api/auth/email-otp/reset-password", {
      email,
      otp: await latestOtp(email, "forget-password"),
      password: "replacement-password",
    });
    expect(reset.status).toBe(200);

    const oldPassword = await post("/api/auth/sign-in/email", {
      email,
      password: "initial-password",
    });
    const newPassword = await post("/api/auth/sign-in/email", {
      email,
      password: "replacement-password",
    });
    expect(oldPassword.status).toBe(401);
    expect(newPassword.status).toBe(200);
    for (const cookie of [firstCookie, secondCookie]) {
      const session = await fetch(`${baseUrl}/api/auth/get-session`, { headers: { cookie } });
      const value = await session.json() as { session?: unknown } | null;
      expect(value?.session ?? null).toBeNull();
    }
  });

  it("lists and revokes web sessions without mixing or revoking the current session", async () => {
    const email = "web-sessions-e2e@example.com";
    const password = "web-session-password";
    expect(
      (await post("/api/auth/sign-up/email", {
        name: "Web Session E2E",
        email,
        password,
      })).status,
    ).toBe(200);
    expect(
      (await post("/api/auth/email-otp/verify-email", {
        email,
        otp: await latestOtp(email, "email-verification"),
      })).status,
    ).toBe(200);

    const currentSignIn = await post("/api/auth/sign-in/email", { email, password });
    const otherSignIn = await post("/api/auth/sign-in/email", { email, password });
    const currentCookie = cookieFrom(currentSignIn);
    const otherCookie = cookieFrom(otherSignIn);

    const listed = await fetch(`${baseUrl}/api/account/web-sessions`, {
      headers: { cookie: currentCookie },
    });
    expect(listed.status).toBe(200);
    const sessionList = await listed.json() as {
      sessions: Array<{ id: string; current: boolean; token?: string }>;
    };
    expect(sessionList.sessions).toHaveLength(2);
    expect(sessionList.sessions.filter((session) => session.current)).toHaveLength(1);
    expect(sessionList.sessions.every((session) => session.token === undefined)).toBe(true);
    const currentSession = sessionList.sessions.find((session) => session.current)!;
    const otherSession = sessionList.sessions.find((session) => !session.current)!;

    expect(
      (await fetch(`${baseUrl}/api/account/web-sessions/${currentSession.id}`, {
        method: "DELETE",
        headers: { cookie: currentCookie },
      })).status,
    ).toBe(400);
    expect(
      (await fetch(`${baseUrl}/api/auth/get-session`, {
        headers: { cookie: currentCookie },
      })).status,
    ).toBe(200);

    expect(
      (await fetch(`${baseUrl}/api/account/web-sessions/${otherSession.id}`, {
        method: "DELETE",
        headers: { cookie: currentCookie },
      })).status,
    ).toBe(200);
    expect(
      (await fetch(`${baseUrl}/api/auth/get-session`, {
        headers: { cookie: otherCookie },
      }).then((response) => response.json()) as { session?: unknown } | null)?.session ?? null,
    ).toBeNull();

    const thirdSignIn = await post("/api/auth/sign-in/email", { email, password });
    const thirdCookie = cookieFrom(thirdSignIn);
    expect(
      (await post("/api/account/web-sessions/revoke-others", {}, {
        cookie: currentCookie,
      })).status,
    ).toBe(200);
    expect(
      (await fetch(`${baseUrl}/api/auth/get-session`, {
        headers: { cookie: currentCookie },
      }).then((response) => response.json()) as { session?: unknown } | null)?.session,
    ).toBeTruthy();
    expect(
      (await fetch(`${baseUrl}/api/auth/get-session`, {
        headers: { cookie: thirdCookie },
      }).then((response) => response.json()) as { session?: unknown } | null)?.session ?? null,
    ).toBeNull();

    expect(
      (await post("/api/auth/sign-out", {}, { cookie: currentCookie })).status,
    ).toBe(200);
    expect(
      (await fetch(`${baseUrl}/api/auth/get-session`, {
        headers: { cookie: currentCookie },
      }).then((response) => response.json()) as { session?: unknown } | null)?.session ?? null,
    ).toBeNull();
  });

  it("persists email-bucket OTP limits without exposing account existence", async () => {
    const email = "rate-limit-e2e@example.com";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await post("/api/auth/email-otp/send-verification-otp", {
        email: attempt % 2 === 0 ? email.toUpperCase() : email,
        type: "sign-in",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
    }
    const mailbox = await capturedMailbox();
    expect(mailbox.messages.filter((message) => message.to === email)).toHaveLength(3);

    const existingReset = await post("/api/auth/email-otp/request-password-reset", {
      email: "password-e2e@example.com",
    });
    const unknownReset = await post("/api/auth/email-otp/request-password-reset", {
      email: "unknown-rate-limit-e2e@example.com",
    });
    expect(existingReset.status).toBe(unknownReset.status);
    expect(await existingReset.json()).toEqual(await unknownReset.json());
  });

  it("keeps password recovery identical when mail delivery is slow and fails", async () => {
    const runtime = getIdentityRuntime();
    const originalSend = runtime.mail.send.bind(runtime.mail);
    runtime.mail.send = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      throw new Error("injected mail transport failure");
    };
    try {
      const startedAt = Date.now();
      const [existingReset, unknownReset] = await Promise.all([
        post("/api/auth/email-otp/request-password-reset", {
          email: "password-e2e@example.com",
        }),
        post("/api/auth/email-otp/request-password-reset", {
          email: `unknown-mail-failure-${randomUUID()}@example.com`,
        }),
      ]);
      const responseTimeMs = Date.now() - startedAt;

      expect(existingReset.status).toBe(200);
      expect(unknownReset.status).toBe(200);
      expect(await existingReset.json()).toEqual({ success: true });
      expect(await unknownReset.json()).toEqual({ success: true });
      expect(responseTimeMs).toBeLessThan(400);
      await Promise.all(backgroundTasks);
    } finally {
      runtime.mail.send = originalSend;
    }
  });

  it("converges concurrent verified Google and GitHub identities on one account", async () => {
    const email = `verified-link-${randomUUID()}@example.com`;
    const [google, github] = await Promise.all([
      resolveVerifiedIdentity(getIdentityRuntime().db, {
        provider: "google",
        providerSubject: `google-${randomUUID()}`,
        email,
        emailVerified: true,
        name: "Verified Link Fixture",
      }),
      resolveVerifiedIdentity(getIdentityRuntime().db, {
        provider: "github",
        providerSubject: `github-${randomUUID()}`,
        email: email.toUpperCase(),
        emailVerified: true,
        name: "Verified Link Fixture",
      }),
    ]);
    expect(google.userId).toBe(github.userId);
    expect([google.created, github.created].sort()).toEqual([false, true]);

    const adapterFactory = verifiedIdentityAdapter(getIdentityRuntime().db);
    const adapter = adapterFactory({} as Parameters<typeof adapterFactory>[0]);
    const adapterEmail = `adapter-link-${randomUUID()}@example.com`;
    const [firstUser, secondUser] = await Promise.all([
      adapter.create({
        model: "user",
        data: {
          name: "Google Fixture",
          email: adapterEmail,
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        forceAllowId: true,
      }),
      adapter.create({
        model: "user",
        data: {
          name: "GitHub Fixture",
          email: adapterEmail.toUpperCase(),
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        forceAllowId: true,
      }),
    ]);
    expect(firstUser?.id).toBe(secondUser?.id);
  });

  it("runs OTP login, PKCE exchange, refresh rotation, device list, and revoke", async () => {
    const email = "pkce-e2e@example.com";
    expect(
      (await post("/api/auth/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      })).status,
    ).toBe(200);
    const signIn = await post("/api/auth/sign-in/email-otp", {
      email,
      otp: await latestOtp(email, "sign-in"),
    });
    expect(signIn.status).toBe(200);
    const signInBody = await signIn.clone().json() as { token: string };
    const cookie = cookieFrom(signIn);

    expect(
      (await post("/api/desktop/device-session", {
        client_id: "rudder-desktop",
        installation_id: "device-authorization-fallback",
        device_name: "Device Authorization E2E",
      })).status,
    ).toBe(401);
    const fallbackSession = await post("/api/desktop/device-session", {
      client_id: "rudder-desktop",
      installation_id: "device-authorization-fallback",
      device_name: "Device Authorization E2E",
    }, { authorization: `Bearer ${signInBody.token}` });
    expect(fallbackSession.status).toBe(200);
    expect(await fallbackSession.json()).toEqual(expect.objectContaining({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      device: expect.objectContaining({
        installationId: "device-authorization-fallback",
      }),
    }));

    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = "http://127.0.0.1:49998/callback";
    const authorize = new URL(`${baseUrl}/api/desktop/authorize`);
    for (const [key, value] of Object.entries({
      client_id: "rudder-desktop",
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: randomBytes(20).toString("base64url"),
      audience: "identity-e2e-installation",
    })) {
      authorize.searchParams.set(key, value);
    }
    const authorization = await fetch(authorize, { headers: { cookie }, redirect: "manual" });
    expect(authorization.status).toBe(302);
    const code = new URL(authorization.headers.get("location")!).searchParams.get("code");

    for (const unsafeRedirect of [
      "http://localhost:49998/callback",
      "http://user@127.0.0.1:49998/callback",
      "http://user:password@[::1]:49998/callback",
    ]) {
      const unsafeAuthorize = new URL(authorize);
      unsafeAuthorize.searchParams.set("redirect_uri", unsafeRedirect);
      expect((await fetch(unsafeAuthorize, {
        headers: { cookie },
        redirect: "manual",
      })).status).toBe(400);
    }

    const offlineDevice = generateOfflineDeviceKeyPair();
    const exchange = await post("/api/desktop/token", {
      grant_type: "authorization_code",
      code,
      client_id: "rudder-desktop",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      installation_id: "identity-e2e-installation",
      device_name: "E2E Desktop",
      device_public_key_thumbprint: offlineDevice.thumbprint,
      sign_out_epoch: 0,
    });
    expect(exchange.status).toBe(200);
    const tokens = await exchange.json() as {
      access_token: string;
      refresh_token: string;
      device: { id: string };
      offline_grant: string;
      offline_grant_key_id: string;
    };
    expect(tokens.offline_grant).toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
    expect(tokens.offline_grant_key_id).toBe("identity-e2e-key");
    const offlineKey = await fetch(`${baseUrl}/.well-known/rudder-offline-grant-key`);
    expect(await offlineKey.json()).toMatchObject({
      issuer: baseUrl,
      kid: "identity-e2e-key",
      alg: "EdDSA",
    });
    const replayedCode = await post("/api/desktop/token", {
      grant_type: "authorization_code",
      code,
      client_id: "rudder-desktop",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      installation_id: "identity-e2e-installation",
      device_name: "E2E Desktop",
    });
    expect(replayedCode.status).toBe(400);

    const devices = await fetch(`${baseUrl}/api/account/devices`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    const deviceList = await devices.json() as { devices: Array<{ id: string; current: boolean }> };
    expect(deviceList.devices).toContainEqual(expect.objectContaining({
      id: tokens.device.id,
      current: true,
    }));

    const serverExchange = await post("/api/server/exchange", {
      installation_id: "identity-e2e-installation",
      audience: "identity-e2e-installation",
    }, { authorization: `Bearer ${tokens.access_token}` });
    expect(serverExchange.status).toBe(200);
    expect(
      (await post("/api/server/exchange", {
        installation_id: "identity-e2e-installation",
        audience: "different-installation",
      }, { authorization: `Bearer ${tokens.access_token}` })).status,
    ).toBe(400);
    const serverCode = (await serverExchange.json() as { code: string }).code;
    expect(
      (await post("/api/server/exchange/verify", {
        code: serverCode,
        expected_audience: "wrong-local-server",
        expected_installation_id: "identity-e2e-installation",
      })).status,
    ).toBe(400);
    const verifiedExchange = await post("/api/server/exchange/verify", {
      code: serverCode,
      expected_audience: "identity-e2e-installation",
      expected_installation_id: "identity-e2e-installation",
    });
    expect(await verifiedExchange.json()).toEqual(expect.objectContaining({
      issuer: baseUrl,
      subject: expect.any(String),
      audience: "identity-e2e-installation",
      installationId: "identity-e2e-installation",
      email,
      jti: expect.any(String),
    }));
    expect(
      (await post("/api/server/exchange/verify", {
        code: serverCode,
        expected_audience: "identity-e2e-installation",
        expected_installation_id: "wrong-installation",
      })).status,
    ).toBe(400);

    const expiringExchange = await post("/api/server/exchange", {
      installation_id: "identity-e2e-installation",
      audience: "identity-e2e-installation",
    }, { authorization: `Bearer ${tokens.access_token}` });
    const expiringCode = (await expiringExchange.json() as { code: string }).code;
    await getIdentityRuntime().db
      .update(identityServerExchangeCodes)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(identityServerExchangeCodes.codeHash, hashOpaqueSecret(expiringCode)));
    expect(
      (await post("/api/server/exchange/verify", {
        code: expiringCode,
        expected_audience: "identity-e2e-installation",
        expected_installation_id: "identity-e2e-installation",
      })).status,
    ).toBe(400);

    const refresh = await post("/api/desktop/refresh", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: "rudder-desktop",
    });
    expect(refresh.status).toBe(200);
    const rotated = await refresh.json() as { access_token: string; refresh_token: string };
    expect(
      (await post("/api/desktop/refresh", {
        grant_type: "refresh_token",
        refresh_token: rotated.refresh_token,
        client_id: "rudder-cli",
      })).status,
    ).toBe(400);
    expect(
      (await post("/api/desktop/refresh", {
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: "rudder-desktop",
      })).status,
    ).toBe(400);
    expect(
      (await fetch(`${baseUrl}/api/account/devices/${tokens.device.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${rotated.access_token}` },
      })).status,
    ).toBe(200);
    expect(
      (await fetch(`${baseUrl}/api/account/devices`, {
        headers: { authorization: `Bearer ${rotated.access_token}` },
      })).status,
    ).toBe(401);
  });

  it("sets a first password only after recent email verification, then changes it", async () => {
    const email = "set-password-e2e@example.com";
    expect(
      (await post("/api/auth/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      })).status,
    ).toBe(200);
    const otpSession = await post("/api/auth/sign-in/email-otp", {
      email,
      otp: await latestOtp(email, "sign-in"),
    });
    const otpCookie = cookieFrom(otpSession);

    expect(
      (await post("/api/account/password", {
        otp: "000000",
        newPassword: "first-password",
      }, { cookie: otpCookie })).status,
    ).toBe(400);
    expect(
      (await post("/api/account/password/verification", {}, { cookie: otpCookie })).status,
    ).toBe(200);
    expect(
      (await post("/api/account/password", {
        otp: await latestOtp(email, "email-verification"),
        newPassword: "first-password",
      }, { cookie: otpCookie })).status,
    ).toBe(200);

    const passwordSession = await post("/api/auth/sign-in/email", {
      email,
      password: "first-password",
    });
    expect(passwordSession.status).toBe(200);
    const passwordCookie = cookieFrom(passwordSession);

    const verifier = randomBytes(48).toString("base64url");
    const redirectUri = "http://127.0.0.1:49997/callback";
    const authorize = new URL(`${baseUrl}/api/desktop/authorize`);
    for (const [key, value] of Object.entries({
      client_id: "rudder-desktop",
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: randomBytes(20).toString("base64url"),
      audience: "password-change-installation",
    })) {
      authorize.searchParams.set(key, value);
    }
    const authorization = await fetch(authorize, {
      headers: { cookie: passwordCookie },
      redirect: "manual",
    });
    const code = new URL(authorization.headers.get("location")!).searchParams.get("code");
    const deviceExchange = await post("/api/desktop/token", {
      grant_type: "authorization_code",
      code,
      client_id: "rudder-desktop",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      installation_id: "password-change-installation",
      device_name: "Password Change Device",
    });
    const deviceTokens = await deviceExchange.json() as { access_token: string };

    expect(
      (await post("/api/auth/change-password", {
        currentPassword: "first-password",
        newPassword: "changed-password",
        revokeOtherSessions: true,
      }, { cookie: passwordCookie })).status,
    ).toBe(200);
    expect(
      (await fetch(`${baseUrl}/api/account/devices`, {
        headers: { authorization: `Bearer ${deviceTokens.access_token}` },
      })).status,
    ).toBe(200);
    expect(
      (await post("/api/auth/sign-in/email", {
        email,
        password: "first-password",
      })).status,
    ).toBe(401);
    expect(
      (await post("/api/auth/sign-in/email", {
        email,
        password: "changed-password",
      })).status,
    ).toBe(200);
    for (const eventType of ["password.set", "password.changed"]) {
      const events = await getIdentityRuntime().db
        .select({ eventType: securityEvents.eventType })
        .from(securityEvents)
        .where(eq(securityEvents.eventType, eventType));
      expect(events).toHaveLength(1);
    }
  });

  it("runs the Device Authorization request contract", async () => {
    const response = await post("/api/auth/device/code", {
      client_id: "rudder-desktop",
      scope: "openid profile email",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({
      device_code: expect.any(String),
      user_code: expect.any(String),
      verification_uri: `${baseUrl}/device`,
      expires_in: 600,
      interval: 5,
    }));
  });

  it("approves a claimed Device Authorization and exchanges it for a desktop device session", async () => {
    const email = "device-authorization-e2e@example.com";
    await post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
    const signIn = await post("/api/auth/sign-in/email-otp", {
      email,
      otp: await latestOtp(email, "sign-in"),
    });
    const cookie = cookieFrom(signIn);

    const issued = await post("/api/auth/device/code", {
      client_id: "rudder-desktop",
      scope: "openid profile email",
    });
    const device = await issued.json() as { device_code: string; user_code: string };

    expect(
      (await post("/api/auth/device/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: "rudder-cli",
      })).status,
    ).toBe(400);

    const verification = await fetch(
      `${baseUrl}/device?user_code=${encodeURIComponent(device.user_code)}`,
      { headers: { cookie } },
    );
    expect(verification.status).toBe(200);
    expect(verification.headers.get("cache-control")).toBe("no-store");

    expect(
      (await post("/api/auth/device/approve", {
        userCode: device.user_code,
      }, { cookie })).status,
    ).toBe(200);

    const polled = await post("/api/auth/device/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: "rudder-desktop",
    });
    expect(polled.status).toBe(200);
    const deviceAuthorizationToken = await polled.json() as { access_token: string };

    const desktopSession = await post("/api/desktop/device-session", {
      client_id: "rudder-desktop",
      installation_id: "device-authorization-complete",
      device_name: "Device Authorization Complete E2E",
    }, { authorization: `Bearer ${deviceAuthorizationToken.access_token}` });
    expect(desktopSession.status).toBe(200);
    const desktopTokens = await desktopSession.json() as {
      access_token: string;
      refresh_token: string;
      device: { installationId: string };
    };
    expect(desktopTokens).toEqual(expect.objectContaining({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      device: expect.objectContaining({
        installationId: "device-authorization-complete",
      }),
    }));
    expect(
      (await post("/api/desktop/refresh", {
        grant_type: "refresh_token",
        refresh_token: desktopTokens.refresh_token,
        client_id: "rudder-cli",
      })).status,
    ).toBe(400);
    expect(
      (await post("/api/desktop/refresh", {
        grant_type: "refresh_token",
        refresh_token: desktopTokens.refresh_token,
        client_id: "rudder-desktop",
      })).status,
    ).toBe(200);
  });

  it("returns a server failure instead of invalid_grant when refresh storage is unavailable", async () => {
    const runtime = getIdentityRuntime();
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
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_server_error" });
  });
});
