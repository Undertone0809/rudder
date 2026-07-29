import {
  activityLog,
  applyPendingMigrations,
  authSessions,
  authUsers,
  createDb,
  ensurePostgresDatabase,
  externalUserBindings,
  installationAccountBindings,
  instanceUserRoles,
  organizationMemberships,
  organizations,
  serverExchangeRedemptions,
} from "@rudderhq/db";
import {
  createOfflineGrantProof,
  generateOfflineDeviceKeyPair,
  issueOfflineGrant,
  offlineRequestBodyHash,
} from "@rudderhq/identity-core";
import { eq, sql } from "drizzle-orm";
import express from "express";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createIdentityServerExchangeVerifier,
  createLocalAccountSessionResolver,
  localAccountAuthService,
  type VerifiedServerExchange,
} from "../services/local-account-auth.js";
import { accountSessionRequired } from "../middleware/account-session-required.js";
import { actorMiddleware } from "../middleware/auth.js";
import { localAccountAuthRoutes } from "../routes/local-account-auth.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startTempDatabase() {
  const external = process.env.RUDDER_LOCAL_ACCOUNT_AUTH_TEST_DATABASE_URL?.trim();
  if (external) {
    await applyPendingMigrations(external);
    return { connectionString: external, dataDir: "", instance: null };
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-local-account-auth-"));
  const databaseDir = path.join(dataDir, "db");
  const port = await getAvailablePort();
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const instance = new EmbeddedPostgres({
    databaseDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: (message: unknown) => {
      if (process.env.RUDDER_TEST_POSTGRES_DEBUG === "true") console.error(message);
    },
  }) as EmbeddedPostgresInstance;
  await instance.initialise();
  await instance.start();
  await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("localAccountAuthService", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let claims!: VerifiedServerExchange;

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`drop trigger if exists fail_claim_activity on activity_log`);
    await db.execute(sql`drop function if exists fail_claim_activity()`);
    await db.delete(activityLog);
    await db.delete(organizationMemberships);
    await db.delete(installationAccountBindings);
    await db.delete(instanceUserRoles);
    await db.delete(authSessions);
    await db.delete(serverExchangeRedemptions);
    await db.delete(externalUserBindings);
    await db.delete(authUsers);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function service(overrides: Partial<VerifiedServerExchange> = {}) {
    claims = {
      issuer: "https://accounts.rudderhq.dev",
      subject: "account-1",
      audience: "rudder-installation:test",
      installationId: "installation-1",
      jti: "exchange-1",
      expiresAt: new Date(Date.now() + 60_000),
      email: "operator@example.com",
      emailVerified: true,
      name: "Operator",
      ...overrides,
    };
    return localAccountAuthService(db, {
      expectedIssuer: "https://accounts.rudderhq.dev",
      audience: "rudder-installation:test",
      installationId: "installation-1",
      secureCookie: false,
      sessionSecret: "fixture-better-auth-secret",
      verifier: { verify: async () => claims },
    });
  }

  it.each([
    ["wrong issuer", { issuer: "https://evil.example" }],
    ["wrong audience", { audience: "another-installation" }],
    ["expired exchange", { expiresAt: new Date(Date.now() - 1) }],
  ])("rejects %s before creating local state", async (_label, overrides) => {
    await expect(service(overrides).redeem("fixture-exchange-code")).rejects.toMatchObject({ status: 401 });
    expect(await db.select().from(serverExchangeRedemptions)).toHaveLength(0);
    expect(await db.select().from(authUsers)).toHaveLength(0);
  });

  it("atomically consumes jti once, maps the user, and emits an HttpOnly session", async () => {
    const svc = service();
    const first = await svc.redeem("fixture-exchange-code");
    expect(first.session.setCookie).toContain("HttpOnly");
    expect(first.session.setCookie).toContain("SameSite=Lax");
    await expect(svc.redeem("fixture-exchange-code")).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(serverExchangeRedemptions)).toHaveLength(1);
    expect(await db.select().from(externalUserBindings)).toHaveLength(1);
    expect(await db.select().from(authSessions)).toHaveLength(1);
    const cookie = first.session.setCookie.split(";")[0]!;
    const resolveSession = createLocalAccountSessionResolver(db, {
      sessionSecret: "fixture-better-auth-secret",
      secureCookie: false,
    });
    await expect(resolveSession({ cookie })).resolves.toMatchObject({
      user: { id: first.userId, email: "operator@example.com" },
    });
    await expect(resolveSession({ cookie: `${cookie}tampered` })).resolves.toBeNull();
  });

  it("claims only active legacy organizations and rejects another account", async () => {
    const svc = service();
    const { userId } = await svc.redeem("fixture-exchange-code");
    const [ownedOrg, unrelatedOrg] = await db
      .insert(organizations)
      .values([
        { name: "Owned", urlKey: "owned", issuePrefix: "OWN" },
        { name: "Unrelated", urlKey: "unrelated", issuePrefix: "UNR" },
      ])
      .returning();
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    await db.insert(organizationMemberships).values({
      orgId: ownedOrg!.id,
      principalType: "user",
      principalId: "local-board",
      status: "active",
      membershipRole: "owner",
    });

    const claimed = await svc.claimLegacyInstallation({
      installationId: "installation-1",
      issuer: claims.issuer,
      subject: claims.subject,
      localUserId: userId,
    });
    expect(claimed.orgIds).toEqual([ownedOrg!.id]);
    const targetMemberships = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.principalId, userId));
    expect(targetMemberships.map((row) => row.orgId)).toEqual([ownedOrg!.id]);
    expect(targetMemberships.some((row) => row.orgId === unrelatedOrg!.id)).toBe(false);

    await expect(svc.claimLegacyInstallation({
      installationId: "installation-1",
      issuer: claims.issuer,
      subject: "account-2",
      localUserId: userId,
    })).rejects.toMatchObject({ status: 403 });
  });

  it("rolls back the installation binding, roles, and memberships when claim audit fails", async () => {
    const svc = service();
    const { userId } = await svc.redeem("fixture-exchange-code");
    const [org] = await db.insert(organizations).values({
      name: "Owned",
      urlKey: "owned",
      issuePrefix: "OWN",
    }).returning();
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    await db.insert(organizationMemberships).values({
      orgId: org!.id,
      principalType: "user",
      principalId: "local-board",
      status: "active",
      membershipRole: "owner",
    });
    await db.execute(sql`
      create function fail_claim_activity() returns trigger language plpgsql as $$
      begin raise exception 'fixture audit failure'; end $$;
    `);
    await db.execute(sql`
      create trigger fail_claim_activity before insert on activity_log
      for each row execute function fail_claim_activity()
    `);

    await expect(svc.claimLegacyInstallation({
      installationId: "installation-1",
      issuer: claims.issuer,
      subject: claims.subject,
      localUserId: userId,
    })).rejects.toThrow();
    expect(await db.select().from(installationAccountBindings)).toHaveLength(0);
    expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, userId))).toHaveLength(0);
    const legacy = await db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.principalId, "local-board"));
    expect(legacy).toHaveLength(1);
    expect(legacy[0]?.status).toBe("active");
  });

  it("runs the HTTP exchange, session gate, replay defense, and legacy claim end to end", async () => {
    service();
    const exchangePolicy = {
      expectedIssuer: "https://accounts.rudderhq.dev",
      audience: "rudder-installation:test",
      installationId: "installation-1",
      secureCookie: false,
      sessionSecret: "fixture-better-auth-secret",
      verifier: { verify: async () => claims },
    };
    const resolveSession = createLocalAccountSessionResolver(db, {
      sessionSecret: exchangePolicy.sessionSecret,
      secureCookie: false,
    });
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, {
      deploymentMode: "local_trusted",
      authRequirement: "required",
      resolveSession: (req) => resolveSession(req.headers),
    }));
    app.use(accountSessionRequired("required"));
    app.get("/api/browser/session-check", (_req, res) => res.json({ ok: true }));
    app.get("/api/cli/session-check", (_req, res) => res.json({ ok: true }));
    app.use("/api", localAccountAuthRoutes(db, {
      installationId: "installation-1",
      exchangePolicy,
    }));
    app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.status ?? 500).json({ error: error.message ?? "failed" });
    });

    expect((await request(app).get("/api/orgs")).status).toBe(401);
    const exchanged = await request(app)
      .post("/api/auth/local-exchange")
      .send({ exchangeCode: "fixture-exchange-code" });
    expect(exchanged.status).toBe(200);
    const cookie = exchanged.headers["set-cookie"]?.[0];
    expect(cookie).toContain("HttpOnly");
    expect((await request(app)
      .post("/api/auth/local-claim")
      .set("Cookie", cookie!)).status).toBe(200);
    claims.jti = "exchange-2";
    const secondExchange = await request(app)
      .post("/api/auth/local-exchange")
      .send({ exchangeCode: "second-fixture-exchange-code" });
    const secondCookie = secondExchange.headers["set-cookie"]?.[0];
    expect(secondExchange.status).toBe(200);
    expect((await request(app)
      .get("/api/browser/session-check")
      .set("Cookie", secondCookie!)).status).toBe(200);
    const signedOut = await request(app)
      .post("/api/auth/local-signout-all")
      .set("Cookie", cookie!);
    expect(signedOut.status).toBe(200);
    expect(signedOut.body).toEqual({ revokedSessionCount: 2 });
    expect(await db.select().from(authSessions)).toHaveLength(0);
    expect((await request(app)
      .get("/api/browser/session-check")
      .set("Cookie", cookie!)).status).toBe(401);
    expect((await request(app)
      .get("/api/cli/session-check")
      .set("Cookie", secondCookie!)).status).toBe(401);
    expect((await request(app)
      .post("/api/auth/local-exchange")
      .send({ exchangeCode: "second-fixture-exchange-code" })).status).toBe(409);
  });

  it("establishes an offline session and rejects copied, replayed, expired, rolled-back, and signed-out grants", async () => {
    const online = service();
    const { userId } = await online.redeem("fixture-exchange-code");
    await online.claimLegacyInstallation({
      installationId: "installation-1",
      issuer: claims.issuer,
      subject: claims.subject,
      localUserId: userId,
    });

    const identityKeys = generateKeyPairSync("ed25519");
    const deviceKeys = generateOfflineDeviceKeyPair();
    const nowBase = Date.now();
    const grant = issueOfflineGrant({
      signingPrivateKey: identityKeys.privateKey,
      keyId: "fixture-key",
      issuer: claims.issuer,
      accountId: claims.subject,
      deviceId: "device-1",
      installationId: "installation-1",
      publicKeyThumbprint: deviceKeys.thumbprint,
      nowMs: nowBase,
      trustedTimeMs: nowBase,
      signOutEpoch: 0,
      jti: randomUUID(),
    });
    let nowMs = nowBase + 10 * 60_000;
    const policy = {
      expectedIssuer: claims.issuer,
      audience: "rudder-installation:test",
      installationId: "installation-1",
      secureCookie: false,
      sessionSecret: "fixture-better-auth-secret",
      verifier: { verify: async () => claims },
      now: () => new Date(nowMs),
      offline: {
        identityKeyId: "fixture-key",
        identityPublicKeySpki: identityKeys.publicKey
          .export({ format: "der", type: "spki" }).toString("base64url"),
        expectedAccountId: claims.subject,
        expectedDeviceId: "device-1",
        lastTrustedTimeMs: nowBase,
        localSignOutEpoch: 0,
      },
    };
    const createProof = (
      privateKey = deviceKeys.privateKey,
      nonce = randomBytes(24).toString("base64url"),
    ) => createOfflineGrantProof({
      grant,
      devicePrivateKey: privateKey,
      method: "POST",
      path: "/api/auth/local-offline",
      bodyHash: offlineRequestBodyHash(""),
      nonce,
      issuedAtMs: nowMs,
    });
    const proof = createProof();
    const input = {
      grant,
      proof,
      devicePublicKeySpki: deviceKeys.publicKey
        .export({ format: "der", type: "spki" }).toString("base64url"),
    };

    const firstService = localAccountAuthService(db, policy);
    const first = await firstService.redeemOffline(input);
    expect(first.session.setCookie).toContain("HttpOnly");
    expect(policy.offline.lastTrustedTimeMs).toBe(nowMs);

    // A fresh verifier instance still observes the database-backed nonce.
    await expect(localAccountAuthService(db, policy).redeemOffline(input))
      .rejects.toMatchObject({ status: 409 });

    const attackerKeys = generateOfflineDeviceKeyPair();
    await expect(firstService.redeemOffline({
      ...input,
      proof: createProof(attackerKeys.privateKey),
    })).rejects.toMatchObject({ status: 401 });
    await expect(firstService.redeemOffline({
      ...input,
      proof: createProof(attackerKeys.privateKey),
      devicePublicKeySpki: attackerKeys.publicKey
        .export({ format: "der", type: "spki" }).toString("base64url"),
    })).rejects.toMatchObject({ status: 401 });

    // The in-process trusted-time floor advances monotonically.
    nowMs = nowBase;
    await expect(firstService.redeemOffline({
      ...input,
      proof: createProof(),
    })).rejects.toMatchObject({ status: 401 });

    nowMs = nowBase + 31 * 24 * 60 * 60_000;
    await expect(firstService.redeemOffline({
      ...input,
      proof: createProof(),
    })).rejects.toMatchObject({ status: 401 });

    nowMs = nowBase + 10 * 60_000;
    policy.offline.localSignOutEpoch = 1;
    await expect(firstService.redeemOffline({
      ...input,
      proof: createProof(),
    })).rejects.toMatchObject({ status: 401 });
  });
});

describe("Identity server exchange verifier", () => {
  it("pins HTTPS, audience, and parsed verified account claims", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      issuer: "https://accounts.rudderhq.dev",
      subject: "account-1",
      audience: "installation-1",
      installationId: "installation-1",
      jti: "exchange-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      email: "VERIFIED@example.com",
      name: "Verified",
    }), { status: 200 }));
    const verifier = createIdentityServerExchangeVerifier({
      identityOrigin: "https://accounts.rudderhq.dev/path",
      expectedAudience: "installation-1",
      expectedInstallationId: "installation-1",
      fetch,
    });

    await expect(verifier.verify("one-time-code-at-least-sixteen")).resolves.toMatchObject({
      issuer: "https://accounts.rudderhq.dev",
      audience: "installation-1",
      email: "verified@example.com",
      emailVerified: true,
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      code: "one-time-code-at-least-sixteen",
      expected_audience: "installation-1",
      expected_installation_id: "installation-1",
    });
    expect(() => createIdentityServerExchangeVerifier({
      identityOrigin: "http://identity.attacker.example",
      expectedAudience: "audience",
      expectedInstallationId: "installation-1",
    })).toThrow("HTTPS");
  });
});
