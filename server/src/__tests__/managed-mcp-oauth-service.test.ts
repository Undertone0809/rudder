import type {
  AuthOptions,
  AuthResult,
  OAuthClientProvider,
} from "@modelcontextprotocol/client";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/client";
import {
  activityLog,
  applyPendingMigrations,
  authUsers,
  createDb,
  createLocalPostgresInstance,
  ensurePostgresDatabase,
  instanceUserRoles,
  mcpConnections,
  mcpOAuthGrants,
  mcpOAuthSessions,
  organizationMemberships,
  organizationSecretVersions,
  organizationSecrets,
  organizations,
  type LocalPostgresInstance,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  managedMcpOAuthService,
  type ManagedMcpOAuthServiceOptions,
} from "../services/mcp/oauth.js";
import { secretService } from "../services/secrets.js";

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-managed-mcp-oauth-"));
  const port = await getAvailablePort();
  const initdb = "/opt/homebrew/bin/initdb";
  const pgCtl = "/opt/homebrew/bin/pg_ctl";
  if (!fs.existsSync(initdb) || !fs.existsSync(pgCtl)) {
    const { instance } = await createLocalPostgresInstance({
      databaseDir: dataDir,
      user: "rudder",
      password: "rudder",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => {},
      onError: () => {},
    });
    await instance.initialise();
    await instance.start();
    const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "rudder");
    const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    await applyPendingMigrations(connectionString);
    return { connectionString, dataDir, instance };
  }
  execFileSync(
    initdb,
    ["-D", dataDir, "-U", "rudder", "-A", "trust", "--encoding=UTF8", "--locale=C"],
    { stdio: "ignore" },
  );
  execFileSync(pgCtl, [
    "-D",
    dataDir,
    "-o",
    `-h 127.0.0.1 -p ${port}`,
    "-w",
    "start",
  ], { stdio: "ignore" });
  const instance = {
    initialise: async () => undefined,
    start: async () => undefined,
    stop: async () => {
      execFileSync(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
    },
  } satisfies LocalPostgresInstance;
  execFileSync("/opt/homebrew/bin/createdb", [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "rudder",
    "rudder",
  ], { stdio: "ignore" });
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

async function seedOwner(db: ReturnType<typeof createDb>) {
  const orgId = randomUUID();
  const userId = `owner-${randomUUID()}`;
  const now = new Date();
  await db.insert(organizations).values({
    id: orgId,
    name: "OAuth MCP",
    urlKey: deriveOrganizationUrlKey(`OAuth MCP ${orgId}`),
    issuePrefix: `O${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(authUsers).values({
    id: userId,
    name: "Owner",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(organizationMemberships).values({
    orgId,
    principalType: "user",
    principalId: userId,
    membershipRole: "owner",
    status: "active",
  });
  return { orgId, userId };
}

async function seedConnection(
  db: ReturnType<typeof createDb>,
  orgId: string,
  provider: "supabase" | "linear" | "notion",
  accessMode: "provider_default" | "read_only" | "read_write",
) {
  return db.insert(mcpConnections).values({
    orgId,
    name: `${provider}-${randomUUID().slice(0, 8)}`,
    displayName: provider,
    provider,
    transport: "streamable_http",
    accessMode,
    safeConfig: {},
    status: "draft",
  }).returning().then((rows) => rows[0]!);
}

function oauthAuthStub(): ManagedMcpOAuthServiceOptions["oauthAuth"] {
  return vi.fn(async (
    provider: OAuthClientProvider,
    options: AuthOptions,
  ): Promise<AuthResult> => {
    if (options.authorizationCode) {
      await provider.saveTokens({
        access_token: "snake-access-token",
        refresh_token: "snake-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
        issuer: "https://oauth.example.test",
      });
      return "AUTHORIZED";
    }
    await provider.saveClientInformation?.({
      client_id: "dcr-client",
      client_secret: "dcr-secret",
      issuer: "https://oauth.example.test",
    });
    await provider.saveCodeVerifier("pkce-verifier");
    await provider.saveDiscoveryState?.({
      authorizationServerUrl: "https://oauth.example.test",
      authorizationServerMetadata: {
        issuer: "https://oauth.example.test",
        authorization_endpoint: "https://oauth.example.test/authorize",
        token_endpoint: "https://oauth.example.test/token",
        revocation_endpoint: "https://oauth.example.test/revoke",
      },
    });
    const state = await provider.state?.();
    await provider.redirectToAuthorization(
      new URL(`https://oauth.example.test/authorize?state=${state}&code_challenge=challenge&code_challenge_method=S256`),
    );
    return "REDIRECT";
  });
}

function serviceOptions(
  patch: Partial<ManagedMcpOAuthServiceOptions> = {},
): ManagedMcpOAuthServiceOptions {
  return {
    deploymentMode: "local_trusted",
    serverPort: 4310,
    allowlists: {
      httpOrigins: [],
      stdioCommands: [],
      stdioWorkingDirectories: [],
      stdioEnvironmentNames: [],
    },
    dnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
    oauthAuth: oauthAuthStub(),
    discoverProviderScope: async ({ provider }) => provider === "supabase"
      ? {
          options: [
            { id: "project-a", displayName: "Project A", metadata: { region: "us-east-1" } },
            { id: "project-b", displayName: "Project B", metadata: { region: "eu-west-1" } },
          ],
        }
      : {
          options: [],
          selected: {
            id: `${provider}-workspace`,
            displayName: `${provider} workspace`,
            metadata: { workspaceName: `${provider} workspace` },
          },
        },
    refreshConnectionTools: vi.fn(async () => []),
    ...patch,
  };
}

describe("managedMcpOAuthService", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: LocalPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    process.env.RUDDER_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    await db.delete(mcpOAuthSessions);
    await db.delete(mcpOAuthGrants);
    await db.delete(mcpConnections);
    await db.delete(activityLog);
    await db.delete(organizationSecretVersions);
    await db.delete(organizationSecrets);
    await db.delete(organizationMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await db.$client.end();
    await instance?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    delete process.env.RUDDER_SECRETS_MASTER_KEY;
  });

  it("starts with a canonical callback and stores only a hashed one-time state", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "supabase", "read_only");
    const svc = managedMcpOAuthService(db, serviceOptions());

    const started = await svc.start(orgId, connection.id, { userId });
    const authorizationUrl = new URL(started.authorizationUrl);
    const rawState = authorizationUrl.searchParams.get("state");
    expect(rawState).toHaveLength(64);
    expect(started.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);

    const session = await db.select().from(mcpOAuthSessions)
      .where(eq(mcpOAuthSessions.connectionId, connection.id))
      .then((rows) => rows[0]!);
    expect(session.redirectUri).toBe("http://127.0.0.1:4310/api/mcp/oauth/callback");
    expect(session.stateHash).toBe(createHash("sha256").update(rawState!).digest("hex"));
    expect(JSON.stringify(session)).not.toContain(rawState);
    const secret = await db.select().from(organizationSecrets)
      .where(eq(organizationSecrets.id, session.credentialSecretId))
      .then((rows) => rows[0]!);
    expect(secret.purpose).toBe("managed_mcp_oauth");
    const material = await secretService(db).resolveSecretValue(orgId, secret.id, "latest");
    expect(material).toContain("dcr-secret");
    expect(material).toContain("pkce-verifier");
    expect(material).not.toContain(rawState);
    const updated = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id))
      .then((rows) => rows[0]!);
    expect(updated.status).toBe("authorizing");
  });

  it("consumes callback state once and moves Supabase to selecting_scope", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "supabase", "read_only");
    const svc = managedMcpOAuthService(db, serviceOptions());
    const started = await svc.start(orgId, connection.id, { userId });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;

    await expect(svc.callback({ state, code: "provider-code", iss: "https://oauth.example.test" }))
      .resolves.toEqual({ connectionId: connection.id, status: "selecting_scope" });
    await expect(svc.callback({ state, code: "replay-code" }))
      .rejects.toMatchObject({ status: 422 });

    const grant = await db.select().from(mcpOAuthGrants)
      .where(eq(mcpOAuthGrants.connectionId, connection.id))
      .then((rows) => rows[0]!);
    expect(grant.status).toBe("active");
    expect(grant.authorizingUserId).toBe(userId);
    expect(grant.credentialSecretId).not.toBeNull();
    const options = await svc.listScopeOptions(orgId, connection.id);
    expect(options).toEqual([
      { id: "project-a", displayName: "Project A", metadata: { region: "us-east-1" } },
      { id: "project-b", displayName: "Project B", metadata: { region: "eu-west-1" } },
    ]);
    expect(JSON.stringify(await svc.getGrantSummary(orgId, connection.id)))
      .not.toContain("snake-access-token");
  });

  it("bounds and sanitizes provider scope options before persistence or API output", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "supabase", "read_only");
    const svc = managedMcpOAuthService(db, serviceOptions({
      discoverProviderScope: async () => ({
        options: Array.from({ length: 550 }, (_, index) => ({
          id: index === 501 ? "project-1" : `project-${index}`,
          displayName: `Project ${index}`,
          metadata: {
            region: "us-east-1",
            status: "ACTIVE",
            access_token: "must-never-persist",
            businessRows: [{ secret: "must-never-persist" }],
            oversized: "x".repeat(20_000),
          },
        })),
      }),
    }));
    const started = await svc.start(orgId, connection.id, { userId });
    await svc.callback({
      state: new URL(started.authorizationUrl).searchParams.get("state")!,
      code: "provider-code",
    });

    const options = await svc.listScopeOptions(orgId, connection.id);
    expect(options).toHaveLength(500);
    expect(new Set(options.map((option) => option.id)).size).toBe(500);
    expect(JSON.stringify(options)).not.toContain("must-never-persist");
    expect(JSON.stringify(options).length).toBeLessThan(200_000);
    expect(options[0]?.metadata).toEqual({ region: "us-east-1", status: "ACTIVE" });
  });

  it("rejects unknown and expired state without reflecting provider errors", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "supabase", "read_only");
    const svc = managedMcpOAuthService(db, serviceOptions());
    const started = await svc.start(orgId, connection.id, { userId });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await db.update(mcpOAuthSessions)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(mcpOAuthSessions.connectionId, connection.id));

    await expect(svc.callback({ state, code: "expired-code" }))
      .rejects.toMatchObject({ status: 422 });
    await expect(svc.callback({
      state: "f".repeat(64),
      error: "access_denied",
      errorDescription: "attacker-controlled-secret-description",
      iss: "https://attacker.example",
    })).rejects.toMatchObject({
      status: 422,
      message: expect.not.stringContaining("attacker-controlled"),
    });
  });

  it("consumes a known provider-error callback once without reflecting its description", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "linear", "read_write");
    const svc = managedMcpOAuthService(db, serviceOptions());
    const started = await svc.start(orgId, connection.id, { userId });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;

    await expect(svc.callback({
      state,
      error: "access_denied",
      errorDescription: "attacker-controlled-provider-description",
      iss: "https://attacker.example",
    })).rejects.toMatchObject({
      status: 422,
      message: expect.not.stringContaining("attacker-controlled"),
    });
    await expect(svc.callback({ state, code: "replay" }))
      .rejects.toMatchObject({ status: 422 });
    const session = await db.select().from(mcpOAuthSessions)
      .where(eq(mcpOAuthSessions.connectionId, connection.id))
      .then((rows) => rows[0]!);
    expect(session.status).toBe("error");
    expect(session.consumedAt).not.toBeNull();
    expect(JSON.stringify(session.statusMetadata)).not.toContain("attacker-controlled");
    expect(session.credentialSecretId).toBeNull();
  });

  it("keeps callback consumed and deletes its session secret when token exchange fails", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "linear", "read_write");
    const startAuth = oauthAuthStub()!;
    let tokenExchangeCalls = 0;
    const oauthAuth = vi.fn(async (
      provider: OAuthClientProvider,
      authOptions: AuthOptions,
    ): Promise<AuthResult> => {
      if (authOptions.authorizationCode) {
        tokenExchangeCalls += 1;
        throw new Error(`issuer mismatch: ${authOptions.iss}`);
      }
      return startAuth(provider, authOptions);
    });
    const svc = managedMcpOAuthService(db, serviceOptions({ oauthAuth }));
    const started = await svc.start(orgId, connection.id, { userId });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    const [before] = await db.select().from(mcpOAuthSessions)
      .where(eq(mcpOAuthSessions.connectionId, connection.id));
    const attackerIssuer = "https://attacker.example.test";

    await expect(svc.callback({
      state,
      code: "provider-code",
      iss: attackerIssuer,
    })).rejects.toMatchObject({
      status: 422,
      message: expect.not.stringContaining(attackerIssuer),
    });
    await expect(svc.callback({
      state,
      code: "replay-code",
      iss: attackerIssuer,
    })).rejects.toMatchObject({ status: 422 });

    expect(tokenExchangeCalls).toBe(1);
    const [session] = await db.select().from(mcpOAuthSessions)
      .where(eq(mcpOAuthSessions.connectionId, connection.id));
    const [updated] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    expect(session).toMatchObject({ status: "consumed", credentialSecretId: null });
    expect(session?.consumedAt).not.toBeNull();
    expect(updated?.status).toBe("error");
    expect(await db.select().from(organizationSecrets)
      .where(eq(organizationSecrets.id, before!.credentialSecretId!)))
      .toHaveLength(0);
    expect(JSON.stringify(await db.select().from(activityLog))).not.toContain(attackerIssuer);
  });

  it("expires a prior unconsumed session and deletes its secret when starting again", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "linear", "read_write");
    const svc = managedMcpOAuthService(db, serviceOptions());
    const first = await svc.start(orgId, connection.id, { userId });
    const firstSession = await db.select().from(mcpOAuthSessions)
      .where(eq(mcpOAuthSessions.connectionId, connection.id))
      .then((rows) => rows[0]!);
    const second = await svc.start(orgId, connection.id, { userId });
    const firstState = new URL(first.authorizationUrl).searchParams.get("state")!;
    const secondState = new URL(second.authorizationUrl).searchParams.get("state")!;

    await expect(svc.callback({ state: firstState, code: "stale-code" }))
      .rejects.toMatchObject({ status: 422 });
    await expect(svc.callback({ state: secondState, code: "current-code" }))
      .resolves.toMatchObject({ connectionId: connection.id });
    expect(await db.select().from(organizationSecrets)
      .where(eq(organizationSecrets.id, firstSession.credentialSecretId!)))
      .toHaveLength(0);
  });

  it("invalidates and deletes an active grant when a fresh authorization starts", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "linear", "read_write");
    const svc = managedMcpOAuthService(db, serviceOptions());
    const first = await svc.start(orgId, connection.id, { userId });
    await svc.callback({
      state: new URL(first.authorizationUrl).searchParams.get("state")!,
      code: "first-code",
    });
    const [activeGrant] = await db.select().from(mcpOAuthGrants)
      .where(eq(mcpOAuthGrants.connectionId, connection.id));

    await svc.start(orgId, connection.id, { userId });

    const [grant] = await db.select().from(mcpOAuthGrants)
      .where(eq(mcpOAuthGrants.connectionId, connection.id));
    const [updated] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    expect(grant).toMatchObject({
      status: "needs_reauth",
      credentialSecretId: null,
      statusMetadata: { reason: "authorization_restarted" },
    });
    expect(updated).toMatchObject({ status: "authorizing", enabled: true });
    expect(await db.select().from(organizationSecrets)
      .where(eq(organizationSecrets.id, activeGrant!.credentialSecretId!)))
      .toHaveLength(0);
    await expect(svc.createCredential(orgId, connection.id).token())
      .rejects.toMatchObject({ status: 422 });
  });

  it("validates Supabase project selection against discovered options", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "supabase", "read_only");
    const refreshConnectionTools = vi.fn(async () => []);
    const svc = managedMcpOAuthService(db, serviceOptions({ refreshConnectionTools }));
    const started = await svc.start(orgId, connection.id, { userId });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await svc.callback({ state, code: "provider-code" });

    await expect(svc.selectScope(orgId, connection.id, {
      connectionId: connection.id,
      externalScope: "forged-project",
      accessMode: "read_only",
    }, { userId })).rejects.toMatchObject({ status: 422 });
    await svc.selectScope(orgId, connection.id, {
      connectionId: connection.id,
      externalScope: "project-b",
      accessMode: "read_write",
    }, { userId });

    const updated = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id))
      .then((rows) => rows[0]!);
    expect(updated.externalScope).toBe("project-b");
    expect(updated.accessMode).toBe("read_write");
    expect(updated.safeConfig).toEqual({
      featureGroups: { mode: "provider_default", excluded: ["storage"] },
    });
    expect(updated.status).toBe("active");
    const [selectedGrant] = await db.select().from(mcpOAuthGrants)
      .where(eq(mcpOAuthGrants.connectionId, connection.id));
    expect(selectedGrant?.statusMetadata).toEqual({});
    expect(refreshConnectionTools).toHaveBeenCalledOnce();
  });

  it.each([
    ["linear", "read_only", "https://mcp.linear.app/mcp/readonly"],
    ["notion", "provider_default", "https://mcp.notion.com/mcp"],
  ] as const)("activates %s with a provider workspace and runs discovery", async (
    provider,
    accessMode,
    expectedEndpoint,
  ) => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, provider, accessMode);
    const refreshConnectionTools = vi.fn(async () => []);
    const svc = managedMcpOAuthService(db, serviceOptions({ refreshConnectionTools }));
    const started = await svc.start(orgId, connection.id, { userId });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await expect(svc.callback({ state, code: "provider-code" }))
      .resolves.toEqual({ connectionId: connection.id, status: "active" });

    const updated = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id))
      .then((rows) => rows[0]!);
    expect(updated.externalScope).toBe(`${provider}-workspace`);
    expect(updated.accessMode).toBe(accessMode);
    expect(refreshConnectionTools).toHaveBeenCalledWith(
      orgId,
      connection.id,
      expect.any(Object),
    );
    expect(svc.resolveProviderEndpoint(updated)).toBe(expectedEndpoint);
  });

  it("invalidates an active grant as soon as its authorizer is no longer an owner", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "linear", "read_write");
    const svc = managedMcpOAuthService(db, serviceOptions());
    const started = await svc.start(orgId, connection.id, { userId });
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;
    await svc.callback({ state, code: "provider-code" });
    const originalGrant = await db.select().from(mcpOAuthGrants)
      .where(eq(mcpOAuthGrants.connectionId, connection.id))
      .then((rows) => rows[0]!);
    await db.update(organizationMemberships)
      .set({ membershipRole: "member" })
      .where(and(
        eq(organizationMemberships.orgId, orgId),
        eq(organizationMemberships.principalId, userId),
      ));

    await expect(svc.getGrantSummary(orgId, connection.id))
      .rejects.toMatchObject({ status: 422 });
    const grant = await db.select().from(mcpOAuthGrants)
      .where(eq(mcpOAuthGrants.connectionId, connection.id))
      .then((rows) => rows[0]!);
    const updated = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id))
      .then((rows) => rows[0]!);
    expect(grant.status).toBe("needs_reauth");
    expect(grant.credentialSecretId).toBeNull();
    expect(updated.status).toBe("needs_reauth");
    expect(updated.enabled).toBe(false);
    expect(await db.select().from(organizationSecrets)
      .where(eq(organizationSecrets.id, originalGrant.credentialSecretId!)))
      .toHaveLength(0);
  });

  it("accepts instance-admin and local-implicit authorizers without owner membership", async () => {
    const admin = await seedOwner(db);
    await db.delete(organizationMemberships)
      .where(eq(organizationMemberships.principalId, admin.userId));
    await db.insert(instanceUserRoles).values({
      userId: admin.userId,
      role: "instance_admin",
    });
    const adminConnection = await seedConnection(db, admin.orgId, "linear", "read_write");
    const adminSvc = managedMcpOAuthService(db, serviceOptions({
      deploymentMode: "authenticated",
      authPublicBaseUrl: "https://rudder.example.test",
    }));
    const adminStarted = await adminSvc.start(admin.orgId, adminConnection.id, {
      userId: admin.userId,
      isInstanceAdmin: true,
    });
    await expect(adminSvc.callback({
      state: new URL(adminStarted.authorizationUrl).searchParams.get("state")!,
      code: "admin-code",
    })).resolves.toMatchObject({ status: "active" });

    const local = await seedOwner(db);
    const localConnection = await seedConnection(db, local.orgId, "notion", "provider_default");
    const localSvc = managedMcpOAuthService(db, serviceOptions());
    const localStarted = await localSvc.start(local.orgId, localConnection.id, {
      localImplicit: true,
    });
    await expect(localSvc.callback({
      state: new URL(localStarted.authorizationUrl).searchParams.get("state")!,
      code: "local-code",
    })).resolves.toMatchObject({ status: "active" });
    const localGrant = await db.select().from(mcpOAuthGrants)
      .where(eq(mcpOAuthGrants.connectionId, localConnection.id))
      .then((rows) => rows[0]!);
    expect(localGrant.authorizingUserId).toBeNull();
  });

  it("single-flights concurrent refresh and preserves the rotated refresh token", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "linear", "read_write");
    let refreshCalls = 0;
    const oauthAuth = vi.fn(async (
      provider: OAuthClientProvider,
      authOptions: AuthOptions,
    ): Promise<AuthResult> => {
      if (authOptions.authorizationCode) {
        await provider.saveTokens({
          access_token: "access-before-refresh",
          refresh_token: "refresh-before-rotation",
          token_type: "Bearer",
          expires_in: 1,
          issuer: "https://oauth.example.test",
        });
        return "AUTHORIZED";
      }
      if (await provider.tokens()) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        await provider.saveTokens({
          access_token: "access-after-refresh",
          refresh_token: "refresh-after-rotation",
          token_type: "Bearer",
          expires_in: 3600,
          issuer: "https://oauth.example.test",
        });
        return "AUTHORIZED";
      }
      await provider.saveCodeVerifier("verifier");
      await provider.redirectToAuthorization(new URL(
        `https://oauth.example.test/authorize?state=${await provider.state?.()}`,
      ));
      return "REDIRECT";
    });
    const svc = managedMcpOAuthService(db, serviceOptions({ oauthAuth }));
    const started = await svc.start(orgId, connection.id, { userId });
    await svc.callback({
      state: new URL(started.authorizationUrl).searchParams.get("state")!,
      code: "initial-code",
    });
    const credential = svc.createCredential(orgId, connection.id);
    const secondServiceCredential = managedMcpOAuthService(
      db,
      serviceOptions({ oauthAuth }),
    ).createCredential(orgId, connection.id);

    await Promise.all([
      credential.refresh(),
      credential.refresh(),
      secondServiceCredential.refresh(),
    ]);
    expect(refreshCalls).toBe(1);
    await expect(credential.token()).resolves.toBe("access-after-refresh");
    const grant = await db.select().from(mcpOAuthGrants)
      .where(eq(mcpOAuthGrants.connectionId, connection.id))
      .then((rows) => rows[0]!);
    const raw = await secretService(db)
      .resolveSecretValue(orgId, grant.credentialSecretId!, "latest");
    expect(raw).toContain("refresh-after-rotation");
    expect(raw).not.toContain("refresh-before-rotation");
  });

  it("commits needs_reauth and deletes credentials on invalid_grant", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "linear", "read_write");
    const initialAuth = oauthAuthStub()!;
    const oauthAuth = vi.fn(async (
      provider: OAuthClientProvider,
      authOptions: AuthOptions,
    ): Promise<AuthResult> => {
      if (!authOptions.authorizationCode && await provider.tokens()) {
        throw new OAuthError(
          OAuthErrorCode.InvalidGrant,
          "provider details must stay private",
        );
      }
      return initialAuth(provider, authOptions);
    });
    const svc = managedMcpOAuthService(db, serviceOptions({ oauthAuth }));
    const started = await svc.start(orgId, connection.id, { userId });
    await svc.callback({
      state: new URL(started.authorizationUrl).searchParams.get("state")!,
      code: "initial-code",
    });
    const originalGrant = await db.select().from(mcpOAuthGrants)
      .where(eq(mcpOAuthGrants.connectionId, connection.id))
      .then((rows) => rows[0]!);

    await expect(svc.createCredential(orgId, connection.id).refresh())
      .rejects.toMatchObject({
        status: 422,
        message: expect.not.stringContaining("provider details"),
      });
    const grant = await db.select().from(mcpOAuthGrants)
      .where(eq(mcpOAuthGrants.connectionId, connection.id))
      .then((rows) => rows[0]!);
    const updated = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id))
      .then((rows) => rows[0]!);
    expect(grant.status).toBe("needs_reauth");
    expect(grant.credentialSecretId).toBeNull();
    expect(updated.status).toBe("needs_reauth");
    expect(await db.select().from(organizationSecrets)
      .where(eq(organizationSecrets.id, originalGrant.credentialSecretId!)))
      .toHaveLength(0);
  });

  it("never resolves an active grant token while its connection is authorizing or revoked", async () => {
    const { orgId, userId } = await seedOwner(db);
    const connection = await seedConnection(db, orgId, "linear", "read_write");
    const svc = managedMcpOAuthService(db, serviceOptions());
    const started = await svc.start(orgId, connection.id, { userId });
    await svc.callback({
      state: new URL(started.authorizationUrl).searchParams.get("state")!,
      code: "provider-code",
    });
    const credential = svc.createCredential(orgId, connection.id);
    await expect(credential.token()).resolves.toBe("snake-access-token");

    await db.update(mcpConnections).set({
      status: "authorizing",
      enabled: true,
    }).where(eq(mcpConnections.id, connection.id));
    await expect(credential.token()).rejects.toMatchObject({ status: 422 });

    await db.update(mcpConnections).set({
      status: "revoked",
      enabled: false,
      revokedAt: new Date(),
    }).where(eq(mcpConnections.id, connection.id));
    await expect(credential.token()).rejects.toMatchObject({ status: 422 });
  });

  it("revokes locally and deletes credentials even when upstream revocation fails", async () => {
    const port = await getAvailablePort();
    const receivedBodies: string[] = [];
    const revocationServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        receivedBodies.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(503).end("provider-private-failure");
      });
    });
    await new Promise<void>((resolve) => revocationServer.listen(port, "127.0.0.1", resolve));
    try {
      const { orgId, userId } = await seedOwner(db);
      const connection = await seedConnection(db, orgId, "linear", "read_write");
      const upstreamOrigin = `http://revocation.test:${port}`;
      const baseAuth = oauthAuthStub()!;
      const oauthAuth = vi.fn(async (
        provider: OAuthClientProvider,
        authOptions: AuthOptions,
      ): Promise<AuthResult> => {
        const result = await baseAuth(provider, authOptions);
        if (!authOptions.authorizationCode) {
          const discovery = await provider.discoveryState?.();
          await provider.saveDiscoveryState?.({
            ...discovery!,
            authorizationServerMetadata: {
              ...discovery!.authorizationServerMetadata,
              revocation_endpoint: `${upstreamOrigin}/revoke`,
            },
          });
        }
        return result;
      });
      const svc = managedMcpOAuthService(db, serviceOptions({
        oauthAuth,
        allowlists: {
          httpOrigins: [upstreamOrigin],
          stdioCommands: [],
          stdioWorkingDirectories: [],
          stdioEnvironmentNames: [],
        },
        dnsLookup: async (hostname) => hostname === "revocation.test"
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "8.8.8.8", family: 4 }],
      }));
      const started = await svc.start(orgId, connection.id, { userId });
      await svc.callback({
        state: new URL(started.authorizationUrl).searchParams.get("state")!,
        code: "provider-code",
      });
      const activeGrant = await db.select().from(mcpOAuthGrants)
        .where(eq(mcpOAuthGrants.connectionId, connection.id))
        .then((rows) => rows[0]!);

      await expect(svc.revoke(orgId, connection.id, { userId }))
        .resolves.toMatchObject({
          id: connection.id,
          status: "revoked",
          enabled: false,
        });

      const grant = await db.select().from(mcpOAuthGrants)
        .where(eq(mcpOAuthGrants.connectionId, connection.id))
        .then((rows) => rows[0]!);
      expect(grant.status).toBe("revoked");
      expect(grant.credentialSecretId).toBeNull();
      expect(grant.revokedAt).not.toBeNull();
      expect(await db.select().from(organizationSecrets)
        .where(eq(organizationSecrets.id, activeGrant.credentialSecretId!)))
        .toHaveLength(0);
      expect(receivedBodies).toHaveLength(1);
      expect(new URLSearchParams(receivedBodies[0]).get("token"))
        .toBe("snake-refresh-token");
      expect(JSON.stringify(await db.select().from(activityLog)))
        .not.toContain("provider-private-failure");
    } finally {
      await new Promise<void>((resolve, reject) => revocationServer.close((error) => (
        error ? reject(error) : resolve()
      )));
    }
  });

  it("waits for an in-flight refresh and revokes the latest rotated token", async () => {
    const port = await getAvailablePort();
    const receivedTokens: string[] = [];
    const revocationServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        receivedTokens.push(
          new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("token") ?? "",
        );
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => revocationServer.listen(port, "127.0.0.1", resolve));
    try {
      const { orgId, userId } = await seedOwner(db);
      const connection = await seedConnection(db, orgId, "linear", "read_write");
      const upstreamOrigin = `http://rotation.test:${port}`;
      let refreshEntered!: () => void;
      let releaseRefresh!: () => void;
      const refreshStarted = new Promise<void>((resolve) => {
        refreshEntered = resolve;
      });
      const refreshBarrier = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const oauthAuth = vi.fn(async (
        provider: OAuthClientProvider,
        authOptions: AuthOptions,
      ): Promise<AuthResult> => {
        if (authOptions.authorizationCode) {
          await provider.saveTokens({
            access_token: "access-before-refresh",
            refresh_token: "refresh-before-rotation",
            token_type: "Bearer",
            issuer: "https://oauth.example.test",
          });
          return "AUTHORIZED";
        }
        if (await provider.tokens()) {
          refreshEntered();
          await refreshBarrier;
          await provider.saveTokens({
            access_token: "access-after-refresh",
            refresh_token: "refresh-after-rotation",
            token_type: "Bearer",
            issuer: "https://oauth.example.test",
          });
          return "AUTHORIZED";
        }
        await provider.saveCodeVerifier("verifier");
        await provider.saveDiscoveryState?.({
          authorizationServerUrl: "https://oauth.example.test",
          authorizationServerMetadata: {
            issuer: "https://oauth.example.test",
            authorization_endpoint: "https://oauth.example.test/authorize",
            token_endpoint: "https://oauth.example.test/token",
            revocation_endpoint: `${upstreamOrigin}/revoke`,
          },
        });
        await provider.redirectToAuthorization(new URL(
          `https://oauth.example.test/authorize?state=${await provider.state?.()}`,
        ));
        return "REDIRECT";
      });
      const svc = managedMcpOAuthService(db, serviceOptions({
        oauthAuth,
        allowlists: {
          httpOrigins: [upstreamOrigin],
          stdioCommands: [],
          stdioWorkingDirectories: [],
          stdioEnvironmentNames: [],
        },
        dnsLookup: async (hostname) => hostname === "rotation.test"
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "8.8.8.8", family: 4 }],
      }));
      const started = await svc.start(orgId, connection.id, { userId });
      await svc.callback({
        state: new URL(started.authorizationUrl).searchParams.get("state")!,
        code: "provider-code",
      });

      const refresh = svc.createCredential(orgId, connection.id).refresh();
      await refreshStarted;
      const revoke = svc.revoke(orgId, connection.id, { userId });
      releaseRefresh();
      await Promise.all([refresh, revoke]);

      expect(receivedTokens).toEqual(["refresh-after-rotation"]);
      const [grant] = await db.select().from(mcpOAuthGrants)
        .where(eq(mcpOAuthGrants.connectionId, connection.id));
      const [updated] = await db.select().from(mcpConnections)
        .where(eq(mcpConnections.id, connection.id));
      expect(grant).toMatchObject({ status: "revoked", credentialSecretId: null });
      expect(updated).toMatchObject({ status: "revoked", enabled: false });
    } finally {
      await new Promise<void>((resolve, reject) => revocationServer.close((error) => (
        error ? reject(error) : resolve()
      )));
    }
  });
});
