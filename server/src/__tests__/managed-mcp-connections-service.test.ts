import {
  activityLog,
  agentCustomIntegrationBindings,
  agents,
  applyPendingMigrations,
  createDb,
  createLocalPostgresInstance,
  customIntegrationTools,
  ensurePostgresDatabase,
  mcpConnections,
  mcpOAuthGrants,
  organizationSecretVersions,
  organizationSecrets,
  organizations,
  type LocalPostgresInstance,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey, type CreateMcpConnection } from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";
import express from "express";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { managedMcpConnectionRoutes } from "../routes/managed-mcp-connections.js";
import { secretRoutes } from "../routes/secrets.js";
import type { ManagedMcpClient, ManagedMcpClientOptions } from "../services/mcp/managed-client.js";
import { managedMcpConnectionService } from "../services/mcp/managed-connections.js";
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-managed-mcp-connections-"));
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

async function seedOrg(db: ReturnType<typeof createDb>) {
  const orgId = randomUUID();
  await db.insert(organizations).values({
    id: orgId,
    name: "Managed MCP",
    urlKey: deriveOrganizationUrlKey(`Managed MCP ${orgId}`),
    issuePrefix: `M${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  return orgId;
}

function clientWithTools(
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }>,
) {
  return {
    discoverTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } satisfies ManagedMcpClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function holdConnectionRowLock(
  db: ReturnType<typeof createDb>,
  connectionId: string,
) {
  let signalAcquired!: () => void;
  let signalRelease!: () => void;
  const acquired = new Promise<void>((resolve) => {
    signalAcquired = resolve;
  });
  const released = new Promise<void>((resolve) => {
    signalRelease = resolve;
  });
  const transaction = db.transaction(async (tx) => {
    await tx
      .select({ id: mcpConnections.id })
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId))
      .for("update");
    signalAcquired();
    await released;
  });
  await acquired;
  let didRelease = false;
  return {
    release: () => {
      if (didRelease) return;
      didRelease = true;
      signalRelease();
    },
    transaction,
  };
}

async function waitForDatabaseLockWaiters(
  db: ReturnType<typeof createDb>,
  minimum: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.$client.unsafe(
      `select count(*)::int as count
       from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'`,
    ) as Array<{ count: number }>;
    if ((rows[0]?.count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${minimum} PostgreSQL lock waiters`);
}

describe("managedMcpConnectionService", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: LocalPostgresInstance | null = null;
  let dataDir = "";
  const activeServers = new Set<Server>();
  const createClient = vi.fn<(options: ManagedMcpClientOptions) => Promise<ManagedMcpClient>>();

  beforeAll(async () => {
    process.env.RUDDER_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
    createClient.mockReset();
    await db.delete(agentCustomIntegrationBindings);
    await db.delete(customIntegrationTools);
    await db.delete(mcpConnections);
    await db.delete(activityLog);
    await db.delete(organizationSecretVersions);
    await db.delete(organizationSecrets);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function service(overrides: Record<string, unknown> = {}) {
    const managed = managedMcpConnectionService(db, {
      deploymentMode: "local_trusted",
      allowlists: {
        httpOrigins: [],
        stdioCommands: [],
        stdioWorkingDirectories: [],
        stdioEnvironmentNames: [],
      },
      hostEnv: {},
      createClient,
      createOAuthCredential: () => ({
        token: async () => "managed-oauth-test-token",
        refresh: async () => undefined,
      }),
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
      ...overrides,
    });
    return {
      ...managed,
      create: (
        orgId: string,
        input: Omit<CreateMcpConnection, "scope"> & Partial<Pick<CreateMcpConnection, "scope">>,
        actor?: Parameters<typeof managed.create>[2],
      ) => managed.create(orgId, { scope: "organization", ...input }, actor),
    };
  }

  async function apiApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", managedMcpConnectionRoutes(db, {
      deploymentMode: "local_trusted",
      serverPort: 3100,
      allowlists: {
        httpOrigins: [],
        stdioCommands: [],
        stdioWorkingDirectories: [],
        stdioEnvironmentNames: [],
      },
      hostEnv: {},
      createClient,
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
    }));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    activeServers.add(server);
    await once(server, "listening");
    return server;
  }

  it("ensures curated providers from registry defaults without accepting client endpoints or credentials", async () => {
    const orgId = await seedOrg(db);
    const svc = service();

    const supabase = await svc.ensureOfficial(
      orgId,
      "supabase",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );
    const linear = await svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );
    const notion = await svc.ensureOfficial(
      orgId,
      "notion",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );

    expect([supabase.accessMode, linear.accessMode, notion.accessMode]).toEqual([
      "read_only",
      "read_write",
      "provider_default",
    ]);
    expect([supabase.status, linear.status, notion.status]).toEqual(["draft", "draft", "draft"]);
    expect([supabase.hasCredentials, linear.hasCredentials, notion.hasCredentials]).toEqual([
      false,
      false,
      false,
    ]);
    await expect(svc.create(orgId, {
      name: "bad-curated",
      displayName: "Bad",
      provider: "linear",
      transport: "streamable_http",
      safeConfig: { url: "https://attacker.test/mcp" },
      secrets: { bearerToken: "never-persist-this" },
    } as never, { userId: "owner-1" })).rejects.toThrow(/custom|curated/i);
  });

  it("rejects GitHub from the generic create service before persistence", async () => {
    const orgId = await seedOrg(db);
    const svc = service();

    await expect(svc.create(orgId, {
      name: "github-generic",
      displayName: "GitHub",
      provider: "github",
      transport: "streamable_http",
      safeConfig: {
        endpoint: "https://api.githubcopilot.com/mcp/",
        scopeMode: "account",
      },
      secrets: { bearerToken: "github_pat_12345678901234567890" },
    } as never, { userId: "owner-1" })).rejects.toThrow(/custom|curated/i);
    expect(await db.select().from(mcpConnections)).toHaveLength(0);
    expect(await db.select().from(organizationSecrets)).toHaveLength(0);
  });

  it("keeps GitHub PAT rotation and activation on reconnect, never generic update", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const initialPat = "github_pat_12345678901234567890";
    const replacementPat = "github_pat_22345678901234567890";
    const connection = await svc.ensureOfficial(
      orgId,
      "github",
      { scope: "organization", ownerAgentId: null, pat: initialPat },
      { userId: "owner-1" },
    );
    await db.update(mcpConnections).set({ status: "error", enabled: false })
      .where(eq(mcpConnections.id, connection.id));
    const [before] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    const beforeSecret = await secretService(db).resolveSecretValue(
      orgId,
      before!.credentialSecretId!,
      "latest",
    );

    await expect(svc.update(orgId, connection.id, {
      enabled: true,
      secrets: { bearerToken: replacementPat },
    }, { userId: "owner-1" })).rejects.toThrow(/reconnect/i);

    const [afterRejectedUpdate] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    expect(afterRejectedUpdate).toMatchObject({
      status: "error",
      enabled: false,
      credentialSecretId: before!.credentialSecretId,
    });
    expect(await secretService(db).resolveSecretValue(
      orgId,
      afterRejectedUpdate!.credentialSecretId!,
      "latest",
    )).toBe(beforeSecret);
    expect(await db.select().from(organizationSecrets)).toHaveLength(1);
    expect(createClient).not.toHaveBeenCalled();

    await expect(svc.reconnect(
      orgId,
      connection.id,
      { userId: "owner-1" },
      { githubPat: replacementPat },
    )).resolves.toMatchObject({ status: "active", enabled: true });
    createClient.mockResolvedValue(clientWithTools([
      { name: "search_repositories", inputSchema: { type: "object" } },
    ]));
    await svc.refreshTools(orgId, connection.id, { userId: "owner-1" });
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient.mock.calls[0]?.[0]).toMatchObject({
      credentials: { headers: { Authorization: `Bearer ${replacementPat}` } },
    });
  });

  it("accepts GitHub PAT through the real API/service/runtime path and reconnects after disable", async () => {
    const orgId = await seedOrg(db);
    const app = await apiApp();
    const initialPat = "github_pat_12345678901234567890";
    const replacementPat = "github_pat_22345678901234567890";
    const client = clientWithTools([
      { name: "search_code", inputSchema: { type: "object" } },
    ]);
    createClient.mockResolvedValue(client);

    const connected = await request(app)
      .post(`/api/orgs/${orgId}/mcp/providers/github/connect`)
      .send({ scope: "organization", accessMode: "read_only", pat: initialPat });
    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({
      provider: "github",
      status: "active",
      enabled: true,
      hasCredentials: true,
      safeConfig: {
        endpoint: "https://api.githubcopilot.com/mcp/",
        scopeMode: "account",
      },
    });
    expect(JSON.stringify(connected.body)).not.toContain(initialPat);
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient.mock.calls[0]?.[0]).toMatchObject({
      url: "https://api.githubcopilot.com/mcp/",
      credentials: { headers: { Authorization: `Bearer ${initialPat}` } },
    });
    const connectionId = connected.body.id as string;

    const disconnected = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/disconnect`)
      .send({});
    expect(disconnected.status).toBe(200);
    expect(disconnected.body).toMatchObject({
      provider: "github",
      status: "disabled",
      enabled: false,
      hasCredentials: false,
    });

    const genericPatch = await request(app)
      .patch(`/api/orgs/${orgId}/mcp/connections/${connectionId}`)
      .send({ enabled: true, secrets: { bearerToken: replacementPat } });
    expect(genericPatch.status).toBe(422);
    expect(createClient).toHaveBeenCalledOnce();
    expect(await request(app)
      .get(`/api/orgs/${orgId}/mcp/connections/${connectionId}`))
      .toMatchObject({ status: 200, body: expect.objectContaining({
        status: "disabled",
        enabled: false,
        hasCredentials: false,
      }) });

    const reconnected = await request(app)
      .post(`/api/orgs/${orgId}/mcp/connections/${connectionId}/reconnect`)
      .send({ pat: replacementPat });
    expect(reconnected.status).toBe(200);
    expect(reconnected.body).toMatchObject({
      provider: "github",
      status: "active",
      enabled: true,
      hasCredentials: true,
    });
    expect(JSON.stringify(reconnected.body)).not.toContain(replacementPat);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient.mock.calls[1]?.[0]).toMatchObject({
      url: "https://api.githubcopilot.com/mcp/",
      credentials: { headers: { Authorization: `Bearer ${replacementPat}` } },
    });
  });

  it("single-flights concurrent official provider ensure calls to one canonical connection", async () => {
    const orgId = await seedOrg(db);
    const svc = service();

    const ensured = await Promise.all(Array.from({ length: 6 }, () =>
      svc.ensureOfficial(
        orgId,
        "supabase",
        { scope: "organization", ownerAgentId: null, accessMode: "read_only" },
        { userId: "owner-1" },
      )));

    expect(new Set(ensured.map((connection) => connection.id)).size).toBe(1);
    const rows = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.orgId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "supabase",
      canonicalState: "canonical",
      scopeMode: "account",
      externalScope: null,
    });
  });

  it("keeps organization and per-agent official connections independent and validates ownership", async () => {
    const orgId = await seedOrg(db);
    const otherOrgId = await seedOrg(db);
    const [owner, peer, foreign] = await db.insert(agents).values([
      {
        orgId,
        name: "Owner",
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        orgId,
        name: "Peer",
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        orgId: otherOrgId,
        name: "Foreign",
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]).returning();
    const svc = service();
    const organization = await svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );
    const agent = await svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "agent", ownerAgentId: owner!.id },
      { userId: "owner-1" },
    );
    const peerConnection = await svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "agent", ownerAgentId: peer!.id },
      { userId: "owner-1" },
    );

    expect(new Set([organization.id, agent.id, peerConnection.id]).size).toBe(3);
    expect(organization).toMatchObject({ scope: "organization", ownerAgentId: null });
    expect(agent).toMatchObject({ scope: "agent", ownerAgentId: owner!.id });
    await expect(db.update(mcpConnections).set({
      externalScope: "shared-linear-workspace",
    }).where(eq(mcpConnections.id, organization.id))).resolves.toBeDefined();
    await expect(db.update(mcpConnections).set({
      externalScope: "shared-linear-workspace",
    }).where(eq(mcpConnections.id, agent.id))).resolves.toBeDefined();
    await expect(svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "agent", ownerAgentId: owner!.id },
      { userId: "owner-1" },
    )).resolves.toMatchObject({ id: agent.id });
    await expect(svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "agent", ownerAgentId: foreign!.id },
      { userId: "owner-1" },
    )).rejects.toThrow(/organization/i);
    await expect(db.insert(mcpConnections).values({
      orgId,
      scope: "agent",
      ownerAgentId: foreign!.id,
      name: `cross-org-${randomUUID()}`,
      displayName: "Cross organization",
      provider: "custom",
      transport: "streamable_http",
      accessMode: "provider_default",
      safeConfig: { url: "https://foreign.example.test/mcp" },
    })).rejects.toThrow();
  });

  it("stores GitHub PATs as managed credentials and forwards only a Bearer header at runtime", async () => {
    const orgId = await seedOrg(db);
    const client = clientWithTools([]);
    createClient.mockResolvedValue(client);
    const svc = service();
    const pat = "github_pat_12345678901234567890";
    const connection = await svc.ensureOfficial(
      orgId,
      "github",
      { scope: "organization", ownerAgentId: null, pat },
      { userId: "owner-1" },
    );

    expect(connection).toMatchObject({
      provider: "github",
      status: "active",
      hasCredentials: true,
      safeConfig: {
        endpoint: "https://api.githubcopilot.com/mcp/",
        scopeMode: "account",
      },
    });
    expect(JSON.stringify(connection)).not.toContain(pat);
    const [storedConnection] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    const [storedSecret] = await db.select().from(organizationSecrets)
      .where(eq(organizationSecrets.id, storedConnection!.credentialSecretId!));
    expect(storedSecret?.purpose).toBe("managed_mcp_connection");
    expect(await secretService(db).resolveSecretValue(orgId, storedSecret!.id, "latest"))
      .toContain(pat);

    await svc.refreshTools(orgId, connection.id, { userId: "owner-1" });
    const options = createClient.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      transport: "streamable_http",
      url: "https://api.githubcopilot.com/mcp/",
      credentials: {
        headers: { Authorization: `Bearer ${pat}` },
      },
    });
    const activity = await db.select().from(activityLog).where(eq(activityLog.orgId, orgId));
    expect(JSON.stringify(activity)).not.toContain(pat);
  });

  it("keeps GitHub draft, active, error, disabled, and PAT replacement transitions distinct", async () => {
    const orgId = await seedOrg(db);
    const firstClient = clientWithTools([{ name: "search_code", inputSchema: { type: "object" } }]);
    const failingClient = clientWithTools([]);
    failingClient.discoverTools.mockRejectedValue(new Error("GitHub discovery failed"));
    const replacementClient = clientWithTools([{ name: "search_repositories", inputSchema: { type: "object" } }]);
    createClient
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(failingClient)
      .mockResolvedValueOnce(replacementClient);
    const svc = service();
    const pat = "github_pat_12345678901234567890";
    const replacementPat = "github_pat_22345678901234567890";
    const draft = await svc.ensureOfficial(
      orgId,
      "github",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );
    expect(draft).toMatchObject({ status: "draft", hasCredentials: false });
    await expect(svc.refreshTools(orgId, draft.id)).rejects.toThrow(/not ready/i);

    const active = await svc.ensureOfficial(
      orgId,
      "github",
      { scope: "organization", ownerAgentId: null, pat },
      { userId: "owner-1" },
    );
    expect(active).toMatchObject({ status: "active", hasCredentials: true });
    await svc.refreshTools(orgId, active.id);
    expect(await svc.get(orgId, active.id)).toMatchObject({ status: "active" });

    await expect(svc.refreshTools(orgId, active.id)).rejects.toThrow(
      "Managed MCP tool discovery failed",
    );
    expect(await svc.get(orgId, active.id)).toMatchObject({
      status: "error",
      enabled: true,
      hasCredentials: true,
    });

    const reconnected = await svc.reconnect(
      orgId,
      active.id,
      { userId: "owner-1" },
      { githubPat: replacementPat },
    );
    expect(reconnected).toMatchObject({ status: "active", hasCredentials: true });
    await svc.refreshTools(orgId, active.id);
    expect(await svc.get(orgId, active.id)).toMatchObject({ status: "active" });

    const disconnected = await svc.disconnect(orgId, active.id, { userId: "owner-1" });
    expect(disconnected).toMatchObject({
      status: "disabled",
      enabled: false,
      hasCredentials: false,
    });
    expect(await db.select().from(organizationSecrets)
      .where(eq(organizationSecrets.orgId, orgId))).toHaveLength(0);
  });

  it("serializes concurrent GitHub PAT replacements without orphan credentials", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const connection = await svc.ensureOfficial(
      orgId,
      "github",
      {
        scope: "organization",
        ownerAgentId: null,
        pat: "github_pat_12345678901234567890",
      },
      { userId: "owner-1" },
    );
    const lock = await holdConnectionRowLock(db, connection.id);
    let settled: PromiseSettledResult<unknown>[];
    try {
      const replacements = [
        svc.reconnect(
          orgId,
          connection.id,
          { userId: "owner-a" },
          { githubPat: "github_pat_22345678901234567890" },
        ),
        svc.reconnect(
          orgId,
          connection.id,
          { userId: "owner-b" },
          { githubPat: "github_pat_32345678901234567890" },
        ),
      ];
      await waitForDatabaseLockWaiters(db, 2);
      lock.release();
      settled = await Promise.allSettled(replacements);
      await lock.transaction;
    } finally {
      lock.release();
      await lock.transaction;
    }

    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const [after] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    const storedSecrets = await db.select().from(organizationSecrets);
    const storedVersions = await db.select().from(organizationSecretVersions);
    expect(storedSecrets).toHaveLength(1);
    expect(storedVersions).toHaveLength(1);
    expect(after?.status).toBe("active");
    expect(after?.credentialSecretId).toBe(storedSecrets[0]?.id);
    expect(storedVersions[0]?.secretId).toBe(after?.credentialSecretId);
    expect([
      JSON.stringify({ bearerToken: "github_pat_22345678901234567890" }),
      JSON.stringify({ bearerToken: "github_pat_32345678901234567890" }),
    ]).toContain(await secretService(db).resolveSecretValue(
      orgId,
      after!.credentialSecretId!,
      "latest",
    ));
  });

  it("serializes concurrent GitHub reconnect and disconnect without resurrecting orphans", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const connection = await svc.ensureOfficial(
      orgId,
      "github",
      {
        scope: "organization",
        ownerAgentId: null,
        pat: "github_pat_12345678901234567890",
      },
      { userId: "owner-1" },
    );
    const lock = await holdConnectionRowLock(db, connection.id);
    let settled: PromiseSettledResult<unknown>[];
    try {
      const reconnect = svc.reconnect(
        orgId,
        connection.id,
        { userId: "owner-reconnect" },
        { githubPat: "github_pat_22345678901234567890" },
      );
      const disconnect = svc.disconnect(orgId, connection.id, { userId: "owner-disconnect" });
      await waitForDatabaseLockWaiters(db, 2);
      lock.release();
      settled = await Promise.allSettled([reconnect, disconnect]);
      await lock.transaction;
    } finally {
      lock.release();
      await lock.transaction;
    }

    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const [after] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    const storedSecrets = await db.select().from(organizationSecrets);
    const storedVersions = await db.select().from(organizationSecretVersions);
    if (after?.status === "active") {
      expect(after.credentialSecretId).toBe(storedSecrets[0]?.id);
      expect(storedSecrets).toHaveLength(1);
      expect(storedVersions).toHaveLength(1);
      expect(await secretService(db).resolveSecretValue(
        orgId,
        after.credentialSecretId!,
        "latest",
      )).toBe(JSON.stringify({ bearerToken: "github_pat_22345678901234567890" }));
    } else {
      expect(after?.status).toBe("disabled");
      expect(after?.credentialSecretId).toBeNull();
      expect(storedSecrets).toHaveLength(0);
      expect(storedVersions).toHaveLength(0);
    }
  });

  it("builds each official runtime client from that connection's isolated OAuth credential", async () => {
    const orgId = await seedOrg(db);
    const [owner] = await db.insert(agents).values({
      orgId,
      name: "Credential owner",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const createOAuthCredential = vi.fn((credentialOrgId: string, connectionId: string) => ({
      token: async () => `token:${credentialOrgId}:${connectionId}`,
      refresh: async () => undefined,
    }));
    const runtimeClient = clientWithTools([]);
    const runtimeClientFactory = vi.fn(async () => runtimeClient);
    const svc = service({
      createOAuthCredential,
      createClient: runtimeClientFactory,
    });
    const organizationConnection = await svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );
    const agentConnection = await svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "agent", ownerAgentId: owner!.id },
      { userId: "owner-1" },
    );
    await db.update(mcpConnections).set({
      status: "active",
      enabled: true,
      externalScope: "shared-workspace",
    }).where(eq(mcpConnections.id, organizationConnection.id));
    await db.update(mcpConnections).set({
      status: "active",
      enabled: true,
      externalScope: "shared-workspace",
    }).where(eq(mcpConnections.id, agentConnection.id));
    const secrets = await db.insert(organizationSecrets).values([
      {
        orgId,
        name: `organization-oauth-${randomUUID()}`,
        provider: "local_encrypted",
        purpose: "managed_mcp_oauth",
        latestVersion: 1,
      },
      {
        orgId,
        name: `agent-oauth-${randomUUID()}`,
        provider: "local_encrypted",
        purpose: "managed_mcp_oauth",
        latestVersion: 1,
      },
    ]).returning();
    await db.insert(mcpOAuthGrants).values([
      {
        orgId,
        connectionId: organizationConnection.id,
        credentialSecretId: secrets[0]!.id,
        status: "active",
      },
      {
        orgId,
        connectionId: agentConnection.id,
        credentialSecretId: secrets[1]!.id,
        status: "active",
      },
    ]);

    await expect(svc.openRuntimeClient(orgId, organizationConnection.id))
      .resolves.toBe(runtimeClient);
    await expect(svc.openRuntimeClient(orgId, agentConnection.id))
      .resolves.toBe(runtimeClient);
    expect(createOAuthCredential.mock.calls).toEqual([
      [orgId, organizationConnection.id],
      [orgId, agentConnection.id],
    ]);
  });

  it("prepares one non-canonical Supabase account candidate without changing the legacy connection", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const legacy = await svc.ensureOfficial(
      orgId,
      "supabase",
      { scope: "organization", ownerAgentId: null, accessMode: "read_only" },
      { userId: "owner-1" },
    );
    await db.update(mcpConnections).set({
      scopeMode: "legacy_project",
      externalScope: "legacy-project-ref",
      status: "active",
      enabled: true,
    }).where(eq(mcpConnections.id, legacy.id));

    const [first, second] = await Promise.all([
      svc.prepareSupabaseAccountUpgrade(orgId, legacy.id, { userId: "owner-1" }),
      svc.prepareSupabaseAccountUpgrade(orgId, legacy.id, { userId: "owner-1" }),
    ]);

    expect(first.id).toBe(second.id);
    const rows = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.orgId, orgId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === legacy.id)).toMatchObject({
      canonicalState: "canonical",
      scopeMode: "legacy_project",
      externalScope: "legacy-project-ref",
      status: "active",
      enabled: true,
    });
    expect(rows.find((row) => row.id === first.id)).toMatchObject({
      canonicalState: "superseded",
      supersededByConnectionId: legacy.id,
      scopeMode: "account",
      externalScope: null,
      status: "draft",
    });
  });

  it("rejects generic patches that would broaden legacy Supabase project scope", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const legacy = await svc.ensureOfficial(
      orgId,
      "supabase",
      { scope: "organization", ownerAgentId: null, accessMode: "read_only" },
      { userId: "owner-1" },
    );
    await db.update(mcpConnections).set({
      scopeMode: "legacy_project",
      externalScope: "legacy-project-ref",
      status: "active",
      enabled: true,
    }).where(eq(mcpConnections.id, legacy.id));

    await expect(svc.update(
      orgId,
      legacy.id,
      { externalScope: null },
      { userId: "owner-1" },
    )).rejects.toThrow(/upgrade to account access/i);
    await expect(svc.get(orgId, legacy.id)).resolves.toMatchObject({
      externalScope: "legacy-project-ref",
    });
  });

  it("never decrypts curated OAuth tokens when the provider-neutral credential factory is missing", async () => {
    const orgId = await seedOrg(db);
    const oauthSecret = await secretService(db).create(orgId, {
      name: "Managed OAuth fallback trap",
      provider: "local_encrypted",
      value: JSON.stringify({
        tokens: { access_token: "must-not-become-static-bearer" },
      }),
    }, undefined, {
      allowManaged: true,
      purpose: "managed_mcp_oauth",
    });
    const svc = service({ createOAuthCredential: undefined });
    const connection = await svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );
    await db.insert(mcpOAuthGrants).values({
      orgId,
      connectionId: connection.id,
      credentialSecretId: oauthSecret.id,
      status: "active",
    });
    await db.update(mcpConnections).set({
      status: "active",
      enabled: true,
      externalScope: "workspace-a",
    }).where(eq(mcpConnections.id, connection.id));

    await expect(svc.refreshTools(orgId, connection.id))
      .rejects.toThrow(/credential factory is not configured/i);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("encrypts custom HTTP credential material, redacts summaries, preserves it, replaces it, and clears it", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const created = await svc.create(orgId, {
      name: "custom-http",
      displayName: "Custom HTTP",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        secretHeaderNames: ["Authorization"],
      },
      secrets: {
        headers: { Authorization: "Bearer super-secret-value" },
      },
    }, { userId: "owner-1" });

    expect(created.hasCredentials).toBe(true);
    expect(JSON.stringify(created)).not.toContain("super-secret-value");
    expect(JSON.stringify(created)).not.toContain("credentialSecretId");
    const [connection] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, created.id));
    expect(connection?.safeConfig).not.toContain("super-secret-value");
    const versions = await db.select().from(organizationSecretVersions);
    expect(JSON.stringify(versions)).not.toContain("super-secret-value");

    await svc.update(orgId, created.id, { displayName: "Renamed" }, { userId: "owner-1" });
    expect((await svc.get(orgId, created.id)).hasCredentials).toBe(true);

    const originalSecretId = connection!.credentialSecretId;
    await svc.update(orgId, created.id, {
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        secretHeaderNames: ["Authorization"],
      },
      secrets: {
        headers: { Authorization: "Bearer rotated-secret-value" },
      },
    }, { userId: "owner-1" });
    const [replacedConnection] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, created.id));
    const replacementSecrets = await db.select().from(organizationSecrets);
    const replacementVersions = await db.select().from(organizationSecretVersions);
    expect(replacedConnection?.credentialSecretId).not.toBe(originalSecretId);
    expect(replacementSecrets).toHaveLength(1);
    expect(replacementSecrets[0]).toMatchObject({
      id: replacedConnection?.credentialSecretId,
      latestVersion: 1,
    });
    expect(replacementVersions).toHaveLength(1);
    expect(replacementVersions[0]?.secretId).toBe(replacedConnection?.credentialSecretId);

    await svc.update(orgId, created.id, {
      safeConfig: { url: "https://mcp.example.test/mcp" },
    }, { userId: "owner-1" });
    expect((await svc.get(orgId, created.id)).hasCredentials).toBe(false);
    expect((await db.select().from(organizationSecrets))).toHaveLength(0);
    expect((await db.select().from(organizationSecretVersions))).toHaveLength(0);
    const audits = await db.select().from(activityLog)
      .where(eq(activityLog.entityId, created.id));
    expect(audits.filter((audit) => audit.action === "mcp_connection.created")).toHaveLength(1);
    expect(audits.filter((audit) => audit.action === "mcp_connection.updated")).toHaveLength(3);
    expect(audits.find((audit) => audit.action === "mcp_connection.created")).toMatchObject({
      actorType: "user",
      actorId: "owner-1",
      details: {
        provider: "custom",
        transport: "streamable_http",
        status: "draft",
      },
    });
    expect(JSON.stringify(audits)).not.toContain("super-secret-value");
    expect(JSON.stringify(audits)).not.toContain("rotated-secret-value");
    expect(JSON.stringify(audits)).not.toContain("safeConfig");
  });

  it("hides managed MCP credentials from public secret mutations while internal discovery can resolve them", async () => {
    const orgId = await seedOrg(db);
    const client = clientWithTools([]);
    createClient.mockResolvedValue(client);
    const svc = service();
    const connection = await svc.create(orgId, {
      name: "purpose-isolated",
      displayName: "Purpose isolated",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        secretHeaderNames: ["Authorization"],
      },
      secrets: { headers: { Authorization: "Bearer managed-only-secret" } },
    }, { userId: "owner-1" });
    const [storedConnection] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    const [storedSecret] = await db.select().from(organizationSecrets)
      .where(eq(organizationSecrets.id, storedConnection!.credentialSecretId!));
    expect((storedSecret as { purpose?: string }).purpose).toBe("managed_mcp_connection");
    expect(connection).not.toHaveProperty("purpose");

    const publicSecrets = secretService(db);
    expect(await publicSecrets.list(orgId)).toEqual([]);
    expect(await publicSecrets.getById(storedSecret!.id)).toBeNull();
    await expect(publicSecrets.rotate(
      storedSecret!.id,
      { value: "public-rotation-must-fail" },
    )).rejects.toThrow(/not found/i);
    await expect(publicSecrets.update(
      storedSecret!.id,
      { description: "public-update-must-fail" },
    )).rejects.toThrow(/not found/i);
    expect(await publicSecrets.remove(storedSecret!.id)).toBeNull();

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "member-1",
        orgIds: [orgId],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    activeServers.add(server);
    await once(server, "listening");
    const listResponse = await request(server).get(`/api/orgs/${orgId}/secrets`);
    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toEqual([]);
    expect((await request(server)
      .post(`/api/secrets/${storedSecret!.id}/rotate`)
      .send({ value: "member-rotation-must-fail" })).status).toBe(404);
    expect((await request(server)
      .patch(`/api/secrets/${storedSecret!.id}`)
      .send({ description: "member-update-must-fail" })).status).toBe(404);
    expect((await request(server).delete(`/api/secrets/${storedSecret!.id}`)).status).toBe(404);
    expect((await request(server)
      .post(`/api/orgs/${orgId}/secrets`)
      .send({
        name: "forged-purpose",
        value: "forged",
        purpose: "managed_mcp_connection",
      })).status).toBe(400);

    await svc.refreshTools(orgId, connection.id);
    expect(createClient).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("does not read arbitrary host environment names for authenticated HTTP connections", async () => {
    const orgId = await seedOrg(db);
    const svc = service({
      deploymentMode: "authenticated",
      hostEnv: { ALLOWED_TOKEN: "allowed", HOST_DATABASE_PASSWORD: "forbidden" },
      allowlists: {
        httpOrigins: [],
        stdioCommands: [],
        stdioWorkingDirectories: [],
        stdioEnvironmentNames: ["ALLOWED_TOKEN"],
      },
    });

    await expect(svc.create(orgId, {
      name: "host-env-leak",
      displayName: "Leak",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        headersFromEnv: { Authorization: "HOST_DATABASE_PASSWORD" },
      },
    }, { userId: "owner-1" })).rejects.toThrow(/environment.*allowlist|not allowed/i);
  });

  it("constructs unauthenticated, encrypted header, direct Bearer, and allowlisted host-env HTTP clients", async () => {
    const orgId = await seedOrg(db);
    const clients = Array.from({ length: 4 }, () => clientWithTools([]));
    for (const client of clients) createClient.mockResolvedValueOnce(client);
    const svc = service({ hostEnv: { HOST_TOKEN: "host-env-token" } });
    const base = {
      displayName: "HTTP",
      provider: "custom" as const,
      transport: "streamable_http" as const,
    };
    const unauthenticated = await svc.create(orgId, {
      ...base,
      name: "unauthenticated",
      safeConfig: { url: "https://mcp.example.test/mcp" },
    }, { userId: "owner-1" });
    const encryptedHeader = await svc.create(orgId, {
      ...base,
      name: "encrypted-header",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        secretHeaderNames: ["Authorization"],
      },
      secrets: { headers: { Authorization: "Basic encrypted-header-value" } },
    }, { userId: "owner-1" });
    const directBearer = await svc.create(orgId, {
      ...base,
      name: "direct-bearer",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        hasBearerToken: true,
      },
      secrets: { bearerToken: "encrypted-bearer-value" },
    }, { userId: "owner-1" });
    const hostEnvironment = await svc.create(orgId, {
      ...base,
      name: "host-environment",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        headersFromEnv: { Authorization: "HOST_TOKEN" },
      },
    }, { userId: "owner-1" });

    for (const connection of [
      unauthenticated,
      encryptedHeader,
      directBearer,
      hostEnvironment,
    ]) {
      await svc.refreshTools(orgId, connection.id);
    }

    const options = createClient.mock.calls.map(([input]) => input);
    expect(options[0]).toMatchObject({
      transport: "streamable_http",
      credentials: { headers: {} },
    });
    expect(options[1]).toMatchObject({
      credentials: { headers: { Authorization: "Basic encrypted-header-value" } },
    });
    expect(options[2]).toMatchObject({
      credentials: { headers: { Authorization: "Bearer encrypted-bearer-value" } },
    });
    expect(options[3]).toMatchObject({
      credentials: { headers: { Authorization: "host-env-token" } },
    });
    expect(JSON.stringify(await svc.list(orgId))).not.toContain("encrypted-header-value");
    expect(JSON.stringify(await svc.list(orgId))).not.toContain("encrypted-bearer-value");
    expect(JSON.stringify(await svc.list(orgId))).not.toContain("host-env-token");
  });

  it("rejects custom HTTP targets that resolve to loopback without an exact origin allowlist", async () => {
    const orgId = await seedOrg(db);
    const svc = service({
      dnsLookup: async () => [{ address: "127.0.0.1", family: 4 as const }],
    });

    await expect(svc.create(orgId, {
      name: "loopback",
      displayName: "Loopback",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: { url: "https://internal.example.test/mcp" },
    }, { userId: "owner-1" })).rejects.toThrow(/policy rejected/i);
    expect(await svc.list(orgId)).toEqual([]);
  });

  it("applies authenticated STDIO argv, cwd, and environment allowlists before persistence", async () => {
    const orgId = await seedOrg(db);
    const cwd = process.cwd();
    const allowed = service({
      deploymentMode: "authenticated",
      allowlists: {
        httpOrigins: [],
        stdioCommands: [[process.execPath, "--version"]],
        stdioWorkingDirectories: [cwd],
        stdioEnvironmentNames: ["MCP_TOKEN"],
      },
    });
    const created = await allowed.create(orgId, {
      name: "stdio-allowed",
      displayName: "STDIO allowed",
      provider: "custom",
      transport: "stdio",
      safeConfig: {
        command: process.execPath,
        args: ["--version"],
        cwd,
        secretEnvNames: ["MCP_TOKEN"],
      },
      secrets: { env: { MCP_TOKEN: "encrypted-stdio-token" } },
    }, { userId: "owner-1" });
    expect(created.hasCredentials).toBe(true);
    expect(JSON.stringify(created)).not.toContain("encrypted-stdio-token");

    await expect(allowed.create(orgId, {
      name: "stdio-denied",
      displayName: "STDIO denied",
      provider: "custom",
      transport: "stdio",
      safeConfig: {
        command: process.execPath,
        args: ["--version"],
        cwd,
        forwardedEnv: ["UNLISTED_HOST_SECRET"],
      },
    }, { userId: "owner-1" })).rejects.toThrow(/policy rejected/i);
  });

  it("rejects unsafe or obviously sensitive static env/header names at persistence", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const unsafeHttpConfigs = [
      { staticHeaders: { Host: "attacker.test" } },
      { staticHeaders: { Connection: "keep-alive" } },
      { staticHeaders: { Forwarded: "for=127.0.0.1" } },
      { staticHeaders: { "X-MCP-Token": "plaintext-token" } },
      { staticHeaders: { "X-Client-Key": "plaintext-key" } },
      { headersFromEnv: { Host: "SAFE_ENV" } },
    ];
    for (const [index, config] of unsafeHttpConfigs.entries()) {
      await expect(svc.create(orgId, {
        name: `unsafe-http-${index}`,
        displayName: `Unsafe HTTP ${index}`,
        provider: "custom",
        transport: "streamable_http",
        safeConfig: {
          url: "https://mcp.example.test/mcp",
          ...config,
        },
      }, { userId: "owner-1" })).rejects.toThrow(/policy|sensitive|controlled/i);
    }
    await expect(svc.create(orgId, {
      name: "unsafe-secret-header",
      displayName: "Unsafe secret header",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        secretHeaderNames: ["Host"],
      },
      secrets: { headers: { Host: "encrypted-but-controlled" } },
    }, { userId: "owner-1" })).rejects.toThrow(/policy|controlled/i);
    await expect(svc.create(orgId, {
      name: "plaintext-stdio-secret",
      displayName: "Plaintext STDIO secret",
      provider: "custom",
      transport: "stdio",
      safeConfig: {
        command: process.execPath,
        args: ["--version"],
        staticEnv: { MCP_TOKEN: "plaintext-token" },
      },
    }, { userId: "owner-1" })).rejects.toThrow(/sensitive/i);
    expect(await svc.list(orgId)).toEqual([]);
  });

  it("discovers real client tools, reconciles drift, never expands existing bindings, and always closes", async () => {
    const orgId = await seedOrg(db);
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Builder",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const firstClient = clientWithTools([
      { name: "search", inputSchema: { type: "object" } },
      { name: "write", inputSchema: { type: "object" } },
    ]);
    const secondClient = clientWithTools([
      { name: "search", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "new_tool", inputSchema: { type: "object" } },
    ]);
    createClient.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);
    const svc = service();
    const connection = await svc.create(orgId, {
      name: "discoverable",
      displayName: "Discoverable",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: { url: "https://mcp.example.test/mcp" },
    }, { userId: "owner-1" });

    const first = await svc.refreshTools(orgId, connection.id);
    const search = first.find((tool) => tool.externalToolName === "search")!;
    await db.update(agentCustomIntegrationBindings).set({
      status: "active",
      enabledToolIds: [search.id],
    }).where(and(
      eq(agentCustomIntegrationBindings.agentId, agentId),
      eq(agentCustomIntegrationBindings.connectionId, connection.id),
    ));

    const second = await svc.refreshTools(orgId, connection.id);
    expect(second.map((tool) => [tool.externalToolName, tool.enabled, tool.removedAt !== null]))
      .toEqual([
        ["new_tool", true, false],
        ["search", true, false],
        ["write", false, true],
      ]);
    const [binding] = await db.select().from(agentCustomIntegrationBindings);
    expect(binding?.enabledToolIds).toEqual([search.id]);
    expect(firstClient.close).toHaveBeenCalledOnce();
    expect(secondClient.close).toHaveBeenCalledOnce();
    expect((await svc.get(orgId, connection.id)).status).toBe("active");
  });

  it("persists only custom tools admitted by the connection allowlist and denylist", async () => {
    const orgId = await seedOrg(db);
    createClient.mockResolvedValue(clientWithTools([
      { name: "read_rows", inputSchema: { type: "object" } },
      { name: "write_rows", inputSchema: { type: "object" } },
      { name: "delete_rows", inputSchema: { type: "object" } },
    ]));
    const svc = service();
    const connection = await svc.create(orgId, {
      name: "filtered-tools",
      displayName: "Filtered tools",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        toolAllowlist: ["read_rows", "write_rows"],
        toolDenylist: ["write_rows"],
      },
    }, { userId: "owner-1" });

    const tools = await svc.refreshTools(orgId, connection.id);
    expect(tools.map((tool) => tool.externalToolName)).toEqual(["read_rows"]);
  });

  it("restores a tool after a denylist round trip", async () => {
    const orgId = await seedOrg(db);
    createClient.mockResolvedValue(clientWithTools([
      { name: "read_rows", inputSchema: { type: "object" } },
    ]));
    const svc = service();
    const connection = await svc.create(orgId, {
      name: "round-trip-filter",
      displayName: "Round trip filter",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        toolAllowlist: ["read_rows"],
      },
    }, { userId: "owner-1" });

    expect(await svc.refreshTools(orgId, connection.id)).toEqual([
      expect.objectContaining({
        externalToolName: "read_rows",
        enabled: true,
        removedAt: null,
      }),
    ]);
    await svc.update(orgId, connection.id, {
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        toolAllowlist: ["read_rows"],
        toolDenylist: ["read_rows"],
      },
    }, { userId: "owner-1" });
    expect(await svc.refreshTools(orgId, connection.id)).toEqual([
      expect.objectContaining({
        externalToolName: "read_rows",
        enabled: false,
      }),
    ]);
    await svc.update(orgId, connection.id, {
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        toolAllowlist: ["read_rows"],
      },
    }, { userId: "owner-1" });
    expect(await svc.refreshTools(orgId, connection.id)).toEqual([
      expect.objectContaining({
        externalToolName: "read_rows",
        enabled: true,
        removedAt: null,
      }),
    ]);
  });

  it("does not let a slow discovery revive a connection disconnected during network I/O", async () => {
    const orgId = await seedOrg(db);
    const discovery = deferred<Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>>();
    const client = clientWithTools([]);
    client.discoverTools.mockReturnValue(discovery.promise);
    createClient.mockResolvedValue(client);
    const svc = service();
    const connection = await svc.create(orgId, {
      name: "slow-disconnect",
      displayName: "Slow disconnect",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: { url: "https://mcp.example.test/mcp" },
    }, { userId: "owner-1" });

    const refreshing = svc.refreshTools(orgId, connection.id);
    await vi.waitFor(() => expect(client.discoverTools).toHaveBeenCalledOnce());
    await svc.disconnect(orgId, connection.id, { userId: "owner-1" });
    discovery.resolve([{ name: "must_not_survive", inputSchema: { type: "object" } }]);

    await expect(refreshing).rejects.toMatchObject({ status: 409 });
    expect(await svc.get(orgId, connection.id)).toMatchObject({
      status: "disabled",
      enabled: false,
    });
    expect(await svc.listTools(orgId, connection.id)).toEqual([]);
  });

  it("opens runtime clients with the persisted startup and tool timeouts", async () => {
    const orgId = await seedOrg(db);
    const discoveryClient = clientWithTools([]);
    const runtimeClient = clientWithTools([]);
    createClient
      .mockResolvedValueOnce(discoveryClient)
      .mockResolvedValueOnce(runtimeClient);
    const svc = service();
    const connection = await svc.create(orgId, {
      name: "runtime-timeouts",
      displayName: "Runtime timeouts",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: { url: "https://mcp.example.test/mcp" },
      startupTimeoutMs: 3_500,
      toolTimeoutMs: 12_345,
    }, { userId: "owner-1" });
    await svc.refreshTools(orgId, connection.id);

    await expect(svc.openRuntimeClient(orgId, connection.id))
      .resolves.toBe(runtimeClient);
    expect(createClient).toHaveBeenLastCalledWith(expect.objectContaining({
      startupTimeoutMs: 3_500,
      toolTimeoutMs: 12_345,
    }));
  });

  it("allows only one concurrent refresh from the same lifecycle snapshot", async () => {
    const orgId = await seedOrg(db);
    const discovery = deferred<Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>>();
    const firstClient = clientWithTools([]);
    const secondClient = clientWithTools([]);
    firstClient.discoverTools.mockReturnValue(discovery.promise);
    secondClient.discoverTools.mockReturnValue(discovery.promise);
    createClient.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);
    const svc = service();
    const connection = await svc.create(orgId, {
      name: "concurrent-refresh",
      displayName: "Concurrent refresh",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: { url: "https://mcp.example.test/mcp" },
    }, { userId: "owner-1" });

    const first = svc.refreshTools(orgId, connection.id);
    const second = svc.refreshTools(orgId, connection.id);
    await vi.waitFor(() => {
      expect(firstClient.discoverTools).toHaveBeenCalledOnce();
      expect(secondClient.discoverTools).toHaveBeenCalledOnce();
    });
    discovery.resolve([{ name: "search", inputSchema: { type: "object" } }]);
    const settled = await Promise.allSettled([first, second]);

    expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejection = settled.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({ reason: { status: 409 } });
    expect(await svc.get(orgId, connection.id)).toMatchObject({
      status: "active",
      enabled: true,
    });
    expect((await svc.listTools(orgId, connection.id)).map((tool) => tool.externalToolName))
      .toEqual(["search"]);
  });

  it("closes the client, stores a redacted error state, and never returns upstream secrets when discovery fails", async () => {
    const orgId = await seedOrg(db);
    const failingClient = clientWithTools([]);
    failingClient.discoverTools.mockRejectedValue(
      new Error("OAuth authorization failed for Bearer leaked-token"),
    );
    createClient.mockResolvedValue(failingClient);
    const svc = service();
    const connection = await svc.create(orgId, {
      name: "failing",
      displayName: "Failing",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: { url: "https://mcp.example.test/mcp" },
    }, { userId: "owner-1" });

    await expect(svc.refreshTools(orgId, connection.id)).rejects.toThrow(
      "Managed MCP tool discovery failed",
    );
    expect(failingClient.close).toHaveBeenCalledOnce();
    expect((await svc.get(orgId, connection.id)).status).toBe("error");
    expect(JSON.stringify(await svc.get(orgId, connection.id))).not.toContain("leaked-token");
    const [failureAudit] = await db.select().from(activityLog)
      .where(eq(activityLog.action, "mcp_connection.discovery_failed"));
    expect(failureAudit).toMatchObject({
      orgId,
      actorType: "system",
      actorId: "system",
      entityType: "mcp_connection",
      entityId: connection.id,
      details: {
        provider: "custom",
        reason: "upstream_discovery_failed",
      },
    });
    expect(JSON.stringify(failureAudit)).not.toContain("leaked-token");
  });

  it("preserves an active official connection and its last good catalog when rediscovery fails", async () => {
    const orgId = await seedOrg(db);
    const firstClient = clientWithTools([
      { name: "list_projects", inputSchema: { type: "object" } },
    ]);
    const failingClient = clientWithTools([]);
    failingClient.discoverTools.mockRejectedValue(new Error("temporary provider outage"));
    createClient.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(failingClient);
    const svc = service();
    const connection = await svc.ensureOfficial(
      orgId,
      "supabase",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );
    const oauthSecret = await secretService(db).create(orgId, {
      name: "Supabase stable OAuth",
      provider: "local_encrypted",
      value: JSON.stringify({
        tokens: { access_token: "stable-access-token" },
      }),
    }, undefined, {
      allowManaged: true,
      purpose: "managed_mcp_oauth",
    });
    await db.insert(mcpOAuthGrants).values({
      orgId,
      connectionId: connection.id,
      credentialSecretId: oauthSecret.id,
      status: "active",
    });
    await db.update(mcpConnections).set({
      status: "active",
      enabled: true,
    }).where(eq(mcpConnections.id, connection.id));
    await svc.refreshTools(orgId, connection.id);

    await expect(svc.refreshTools(orgId, connection.id)).rejects.toThrow(
      "Managed MCP tool discovery failed",
    );

    expect(await svc.get(orgId, connection.id)).toMatchObject({
      status: "active",
      enabled: true,
    });
    expect((await svc.listTools(orgId, connection.id)).map((tool) => tool.externalToolName))
      .toEqual(["list_projects"]);
    expect(await db.select().from(activityLog)
      .where(eq(activityLog.action, "mcp_connection.discovery_failed")))
      .toEqual([expect.objectContaining({ entityId: connection.id })]);
  });

  it("extends system-derived official bindings after discovery without widening legacy-narrowed bindings", async () => {
    const orgId = await seedOrg(db);
    const [derivedAgent, narrowedAgent] = await db.insert(agents).values([
      {
        orgId,
        name: "Derived policy agent",
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        orgId,
        name: "Legacy narrowed agent",
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]).returning();
    const firstClient = clientWithTools([
      { name: "list_projects", inputSchema: { type: "object" } },
      { name: "get_project", inputSchema: { type: "object" } },
    ]);
    const secondClient = clientWithTools([
      { name: "list_projects", inputSchema: { type: "object" } },
      { name: "get_project", inputSchema: { type: "object" } },
      { name: "get_advisors", inputSchema: { type: "object" } },
    ]);
    createClient.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);
    const svc = service();
    const connection = await svc.ensureOfficial(
      orgId,
      "supabase",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );
    const oauthSecret = await secretService(db).create(orgId, {
      name: "Supabase policy refresh OAuth",
      provider: "local_encrypted",
      value: JSON.stringify({ tokens: { access_token: "policy-refresh-token" } }),
    }, undefined, {
      allowManaged: true,
      purpose: "managed_mcp_oauth",
    });
    await db.insert(mcpOAuthGrants).values({
      orgId,
      connectionId: connection.id,
      credentialSecretId: oauthSecret.id,
      status: "active",
    });
    await db.update(mcpConnections).set({
      status: "active",
      enabled: true,
    }).where(eq(mcpConnections.id, connection.id));
    const originalTools = await svc.refreshTools(orgId, connection.id);
    const originalIds = originalTools.map((tool) => tool.id);
    const listId = originalTools.find((tool) => tool.externalToolName === "list_projects")!.id;
    await db.update(agentCustomIntegrationBindings).set({
      status: "active",
      accessMode: "read_only",
      enabledToolIds: [listId],
    }).where(and(
      eq(agentCustomIntegrationBindings.agentId, narrowedAgent!.id),
      eq(agentCustomIntegrationBindings.connectionId, connection.id),
    ));

    const refreshedTools = await svc.refreshTools(orgId, connection.id);
    const refreshedIds = refreshedTools
      .filter((tool) => tool.enabled && !tool.removedAt)
      .map((tool) => tool.id)
      .sort();
    const bindings = await db.select().from(agentCustomIntegrationBindings);
    const derived = bindings.find((binding) => binding.agentId === derivedAgent!.id)!;
    const narrowed = bindings.find((binding) => binding.agentId === narrowedAgent!.id)!;

    expect(derived.enabledToolIds.sort()).toEqual(refreshedIds);
    expect(derived.policyRevision).toBe(2);
    expect(narrowed.enabledToolIds).toEqual([listId]);
    expect(narrowed.policyRevision).toBe(1);
  });

  it("requires reconnect before a disabled or reauthorization/error connection can discover again", async () => {
    const orgId = await seedOrg(db);
    const client = clientWithTools([]);
    createClient.mockResolvedValue(client);
    const svc = service();
    const connection = await svc.create(orgId, {
      name: "strict-lifecycle",
      displayName: "Strict lifecycle",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: { url: "https://mcp.example.test/mcp" },
    }, { userId: "owner-1" });

    await svc.disconnect(orgId, connection.id);
    await expect(svc.update(
      orgId,
      connection.id,
      { enabled: true },
      { userId: "owner-1" },
    )).rejects.toThrow(/reconnect/i);
    await expect(svc.refreshTools(orgId, connection.id)).rejects.toThrow(/reconnect/i);
    expect(createClient).not.toHaveBeenCalled();

    for (const status of [
      "authorizing",
      "selecting_scope",
      "needs_reauth",
      "revoked",
      "error",
    ] as const) {
      await db.update(mcpConnections)
        .set({ status, enabled: true })
        .where(eq(mcpConnections.id, connection.id));
      await expect(svc.refreshTools(orgId, connection.id)).rejects.toThrow(/reconnect/i);
      expect(createClient).not.toHaveBeenCalled();
    }

    await svc.reconnect(orgId, connection.id);
    expect(await svc.get(orgId, connection.id)).toMatchObject({
      status: "draft",
      enabled: true,
    });
    await svc.refreshTools(orgId, connection.id);
    expect(createClient).toHaveBeenCalledOnce();
  });

  it("keeps the old credential/config consistent when clear or any replacement DB update fails", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const secrets = secretService(db);
    const connection = await svc.create(orgId, {
      name: "atomic-secret-change",
      displayName: "Atomic secret change",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        secretHeaderNames: ["Authorization"],
      },
      secrets: { headers: { Authorization: "Bearer original-secret" } },
    }, { userId: "owner-1" });
    const [before] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    expect(before?.credentialSecretId).toBeTruthy();
    const originalValue = await secrets.resolveSecretValue(
      orgId,
      before!.credentialSecretId!,
      "latest",
    );

    await db.$client.unsafe(`
      create function reject_managed_mcp_connection_update() returns trigger as $$
      begin
        raise exception 'forced managed MCP connection update failure';
      end;
      $$ language plpgsql;
      create trigger reject_managed_mcp_connection_update
      before update on mcp_connections
      for each row execute function reject_managed_mcp_connection_update();
    `);
    try {
      await expect(svc.update(orgId, connection.id, {
        safeConfig: { url: "https://mcp.example.test/mcp" },
      }, { userId: "owner-1" })).rejects.toThrow();
      let [after] = await db.select().from(mcpConnections)
        .where(eq(mcpConnections.id, connection.id));
      expect(after?.credentialSecretId).toBe(before?.credentialSecretId);
      expect(after?.safeConfig).toEqual(before?.safeConfig);
      expect(await db.select().from(organizationSecrets)).toHaveLength(1);

      await expect(svc.update(orgId, connection.id, {
        secrets: { headers: { Authorization: "Bearer same-shape-rotated-secret" } },
      }, { userId: "owner-1" })).rejects.toThrow();
      [after] = await db.select().from(mcpConnections)
        .where(eq(mcpConnections.id, connection.id));
      expect(after?.credentialSecretId).toBe(before?.credentialSecretId);
      expect(after?.safeConfig).toEqual(before?.safeConfig);
      expect(await secrets.resolveSecretValue(
        orgId,
        before!.credentialSecretId!,
        "latest",
      )).toBe(originalValue);
      expect((await db.select().from(organizationSecrets))[0]?.latestVersion).toBe(1);
      expect(await db.select().from(organizationSecretVersions)).toHaveLength(1);

      await expect(svc.update(orgId, connection.id, {
        safeConfig: {
          url: "https://mcp.example.test/mcp",
          secretHeaderNames: ["X-API-Key"],
        },
        secrets: { headers: { "X-API-Key": "rotated-secret" } },
      }, { userId: "owner-1" })).rejects.toThrow();
      [after] = await db.select().from(mcpConnections)
        .where(eq(mcpConnections.id, connection.id));
      expect(after?.credentialSecretId).toBe(before?.credentialSecretId);
      expect(after?.safeConfig).toEqual(before?.safeConfig);
      expect((await db.select().from(organizationSecrets))[0]?.latestVersion).toBe(1);
      expect(await db.select().from(organizationSecretVersions)).toHaveLength(1);
    } finally {
      await db.$client.unsafe(`
        drop trigger if exists reject_managed_mcp_connection_update on mcp_connections;
        drop function if exists reject_managed_mcp_connection_update();
      `);
    }
  });

  it("rolls back replacement and clear when deleting the old managed credential fails", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const secrets = secretService(db);
    const connection = await svc.create(orgId, {
      name: "atomic-secret-delete",
      displayName: "Atomic secret delete",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        secretHeaderNames: ["Authorization"],
      },
      secrets: { headers: { Authorization: "Bearer original-delete-secret" } },
    }, { userId: "owner-1" });
    const [before] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    const oldSecretId = before!.credentialSecretId!;
    const originalValue = await secrets.resolveSecretValue(orgId, oldSecretId, "latest");

    await db.$client.unsafe(`
      create function reject_old_managed_mcp_credential_delete() returns trigger as $$
      begin
        if old.id = '${oldSecretId}'::uuid then
          raise exception 'forced old managed MCP credential delete failure';
        end if;
        return old;
      end;
      $$ language plpgsql;
      create trigger reject_old_managed_mcp_credential_delete
      before delete on organization_secrets
      for each row execute function reject_old_managed_mcp_credential_delete();
    `);
    try {
      await expect(svc.update(orgId, connection.id, {
        secrets: { headers: { Authorization: "Bearer replacement-delete-secret" } },
      }, { userId: "owner-1" })).rejects.toThrow();
      await expect(svc.update(orgId, connection.id, {
        safeConfig: { url: "https://mcp.example.test/mcp" },
      }, { userId: "owner-1" })).rejects.toThrow();

      const [after] = await db.select().from(mcpConnections)
        .where(eq(mcpConnections.id, connection.id));
      expect(after?.credentialSecretId).toBe(oldSecretId);
      expect(after?.safeConfig).toEqual(before?.safeConfig);
      expect(await secrets.resolveSecretValue(orgId, oldSecretId, "latest")).toBe(originalValue);
      expect(await db.select().from(organizationSecrets)).toHaveLength(1);
      expect(await db.select().from(organizationSecretVersions)).toHaveLength(1);
    } finally {
      await db.$client.unsafe(`
        drop trigger if exists reject_old_managed_mcp_credential_delete on organization_secrets;
        drop function if exists reject_old_managed_mcp_credential_delete();
      `);
    }
  });

  it("rolls back create, update, disconnect, and refresh when managed audit persistence fails", async () => {
    const orgId = await seedOrg(db);
    const refreshClient = clientWithTools([
      { name: "must_rollback", inputSchema: { type: "object" } },
    ]);
    createClient.mockResolvedValue(refreshClient);
    const svc = service();
    const updateConnection = await svc.create(orgId, {
      name: "audit-update",
      displayName: "Audit update",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        secretHeaderNames: ["Authorization"],
      },
      secrets: { headers: { Authorization: "Bearer audit-original" } },
    }, { userId: "owner-1" });
    const disconnectConnection = await svc.create(orgId, {
      name: "audit-disconnect",
      displayName: "Audit disconnect",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: { url: "https://mcp.example.test/mcp" },
    }, { userId: "owner-1" });
    const refreshConnection = await svc.create(orgId, {
      name: "audit-refresh",
      displayName: "Audit refresh",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: { url: "https://mcp.example.test/mcp" },
    }, { userId: "owner-1" });
    const [updateBefore] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, updateConnection.id));
    const auditCountBefore = (await db.select().from(activityLog)).length;

    await db.$client.unsafe(`
      create function reject_managed_mcp_activity_insert() returns trigger as $$
      begin
        raise exception 'forced managed MCP activity insert failure';
      end;
      $$ language plpgsql;
      create trigger reject_managed_mcp_activity_insert
      before insert on activity_log
      for each row execute function reject_managed_mcp_activity_insert();
    `);
    try {
      await expect(svc.create(orgId, {
        name: "audit-create-must-rollback",
        displayName: "Audit create rollback",
        provider: "custom",
        transport: "streamable_http",
        safeConfig: {
          url: "https://mcp.example.test/mcp",
          secretHeaderNames: ["Authorization"],
        },
        secrets: { headers: { Authorization: "Bearer audit-create-secret" } },
      }, { userId: "owner-1" })).rejects.toThrow();
      await expect(svc.update(orgId, updateConnection.id, {
        secrets: { headers: { Authorization: "Bearer audit-replacement" } },
      }, { userId: "owner-1" })).rejects.toThrow();
      await expect(svc.disconnect(
        orgId,
        disconnectConnection.id,
        { userId: "owner-1" },
      )).rejects.toThrow();
      await expect(svc.refreshTools(
        orgId,
        refreshConnection.id,
        { userId: "owner-1" },
      )).rejects.toThrow();

      expect((await svc.list(orgId)).map((connection) => connection.name)).not.toContain(
        "audit-create-must-rollback",
      );
      const [updateAfter] = await db.select().from(mcpConnections)
        .where(eq(mcpConnections.id, updateConnection.id));
      expect(updateAfter?.credentialSecretId).toBe(updateBefore?.credentialSecretId);
      expect(await db.select().from(organizationSecrets)).toHaveLength(1);
      expect(await db.select().from(organizationSecretVersions)).toHaveLength(1);
      expect(await svc.get(orgId, disconnectConnection.id)).toMatchObject({
        status: "draft",
        enabled: true,
      });
      expect(await svc.get(orgId, refreshConnection.id)).toMatchObject({
        status: "draft",
        enabled: true,
      });
      expect(await svc.listTools(orgId, refreshConnection.id)).toEqual([]);
      expect(await db.select().from(activityLog)).toHaveLength(auditCountBefore);
    } finally {
      await db.$client.unsafe(`
        drop trigger if exists reject_managed_mcp_activity_insert on activity_log;
        drop function if exists reject_managed_mcp_activity_insert();
      `);
    }
  });

  it("serializes concurrent same-shape replacements without orphan credentials", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const secrets = secretService(db);
    const connection = await svc.create(orgId, {
      name: "concurrent-replacements",
      displayName: "Concurrent replacements",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        secretHeaderNames: ["Authorization"],
      },
      secrets: { headers: { Authorization: "Bearer original-concurrent-secret" } },
    }, { userId: "owner-1" });
    const lock = await holdConnectionRowLock(db, connection.id);
    let settled: PromiseSettledResult<unknown>[];
    try {
      const replacements = [
        svc.update(orgId, connection.id, {
          secrets: { headers: { Authorization: "Bearer concurrent-replacement-a" } },
        }, { userId: "owner-a" }),
        svc.update(orgId, connection.id, {
          secrets: { headers: { Authorization: "Bearer concurrent-replacement-b" } },
        }, { userId: "owner-b" }),
      ];
      await waitForDatabaseLockWaiters(db, 2);
      lock.release();
      settled = await Promise.allSettled(replacements);
      await lock.transaction;
    } finally {
      lock.release();
      await lock.transaction;
    }

    expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const [after] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    const storedSecrets = await db.select().from(organizationSecrets);
    const storedVersions = await db.select().from(organizationSecretVersions);
    expect(storedSecrets).toHaveLength(1);
    expect(storedVersions).toHaveLength(1);
    expect(after?.credentialSecretId).toBe(storedSecrets[0]?.id);
    expect(storedVersions[0]?.secretId).toBe(after?.credentialSecretId);
    expect([
      JSON.stringify({ headers: { Authorization: "Bearer concurrent-replacement-a" } }),
      JSON.stringify({ headers: { Authorization: "Bearer concurrent-replacement-b" } }),
    ]).toContain(await secrets.resolveSecretValue(
      orgId,
      after!.credentialSecretId!,
      "latest",
    ));
  });

  it("serializes concurrent replacement and clear with a winner-consistent final state", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const connection = await svc.create(orgId, {
      name: "concurrent-replace-clear",
      displayName: "Concurrent replace clear",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: {
        url: "https://mcp.example.test/mcp",
        secretHeaderNames: ["Authorization"],
      },
      secrets: { headers: { Authorization: "Bearer original-replace-clear" } },
    }, { userId: "owner-1" });
    const lock = await holdConnectionRowLock(db, connection.id);
    let settled: PromiseSettledResult<unknown>[];
    try {
      const replacement = svc.update(orgId, connection.id, {
        secrets: { headers: { Authorization: "Bearer replacement-winner" } },
      }, { userId: "owner-replace" });
      const clear = svc.update(orgId, connection.id, {
        safeConfig: { url: "https://mcp.example.test/mcp" },
      }, { userId: "owner-clear" });
      await waitForDatabaseLockWaiters(db, 2);
      lock.release();
      settled = await Promise.allSettled([replacement, clear]);
      await lock.transaction;
    } finally {
      lock.release();
      await lock.transaction;
    }

    expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const replacementWon = settled[0]?.status === "fulfilled";
    const [after] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, connection.id));
    const storedSecrets = await db.select().from(organizationSecrets);
    const storedVersions = await db.select().from(organizationSecretVersions);
    expect(after?.credentialSecretId !== null).toBe(replacementWon);
    expect(after?.safeConfig).toEqual(replacementWon
      ? {
          url: "https://mcp.example.test/mcp",
          secretHeaderNames: ["Authorization"],
        }
      : { url: "https://mcp.example.test/mcp" });
    expect(storedSecrets).toHaveLength(replacementWon ? 1 : 0);
    expect(storedVersions).toHaveLength(replacementWon ? 1 : 0);
    if (replacementWon) {
      expect(storedSecrets[0]?.id).toBe(after?.credentialSecretId);
      expect(storedVersions[0]?.secretId).toBe(after?.credentialSecretId);
    }
  });

  it("invalidates an active curated grant transactionally when reconnect begins", async () => {
    const orgId = await seedOrg(db);
    const grantCredential = await secretService(db).create(orgId, {
      name: "Linear OAuth credential",
      provider: "local_encrypted",
      value: JSON.stringify({ accessToken: "old-linear-token" }),
    }, undefined, {
      allowManaged: true,
      purpose: "managed_mcp_oauth",
    });
    const client = clientWithTools([]);
    createClient.mockResolvedValue(client);
    const svc = service();
    const connection = await svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );
    await db.insert(mcpOAuthGrants).values({
      orgId,
      connectionId: connection.id,
      credentialSecretId: grantCredential.id,
      status: "active",
    });
    await db.update(mcpConnections)
      .set({ status: "active", enabled: true })
      .where(eq(mcpConnections.id, connection.id));

    expect(await svc.reconnect(orgId, connection.id)).toMatchObject({
      status: "authorizing",
      enabled: true,
    });
    const [grant] = await db.select().from(mcpOAuthGrants)
      .where(eq(mcpOAuthGrants.connectionId, connection.id));
    expect(grant).toMatchObject({
      status: "needs_reauth",
      statusMetadata: { reason: "connection_reconnect" },
      credentialSecretId: null,
    });
    expect(await db.select().from(organizationSecrets)
      .where(eq(organizationSecrets.id, grantCredential.id)))
      .toHaveLength(0);
    await expect(svc.refreshTools(orgId, connection.id)).rejects.toThrow(/not ready/i);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("keeps legacy_manual records read-only and non-executable", async () => {
    const orgId = await seedOrg(db);
    const [legacy] = await db.insert(mcpConnections).values({
      orgId,
      name: "legacy",
      displayName: "Legacy",
      provider: "custom",
      transport: "legacy_manual",
      safeConfig: { legacyConfigRetained: true },
      status: "disabled",
      enabled: false,
    }).returning();
    const svc = service();

    expect((await svc.get(orgId, legacy!.id)).transport).toBe("legacy_manual");
    await expect(svc.update(
      orgId,
      legacy!.id,
      { displayName: "Modified" },
      { userId: "owner-1" },
    )).rejects.toThrow(/legacy.*new managed connection/i);
    await expect(svc.refreshTools(orgId, legacy!.id)).rejects.toThrow(
      /legacy.*new managed connection/i,
    );
    await expect(svc.reconnect(orgId, legacy!.id)).rejects.toThrow(
      /legacy.*new managed connection/i,
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it("creates account-scoped Supabase without a project and enforces centralized access-mode rules", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const supabase = await svc.ensureOfficial(
      orgId,
      "supabase",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );
    const notion = await svc.ensureOfficial(
      orgId,
      "notion",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );

    const [storedSupabase] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, supabase.id));
    expect(storedSupabase?.scopeMode).toBe("account");
    expect(storedSupabase?.externalScope).toBeNull();
    await expect(svc.refreshTools(orgId, supabase.id)).rejects.toThrow(/not ready/i);
    await expect(svc.update(
      orgId,
      notion.id,
      { accessMode: "read_only" },
      { userId: "owner-1" },
    )).rejects.toThrow(/does not support/i);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("requires the dedicated access-mode path and reauthorization for Linear write escalation", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const linear = await svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );

    await expect(svc.update(
      orgId,
      linear.id,
      { accessMode: "read_only" },
      { userId: "owner-1" },
    )).rejects.toThrow(/dedicated access-mode/i);

    await expect(svc.update(
      orgId,
      linear.id,
      { accessMode: "read_only" },
      { userId: "owner-1" },
      { allowCuratedAccessMode: true },
    )).resolves.toMatchObject({ accessMode: "read_only" });
    await db.update(mcpConnections).set({ status: "active" })
      .where(eq(mcpConnections.id, linear.id));

    await expect(svc.update(
      orgId,
      linear.id,
      { accessMode: "read_write" },
      { userId: "owner-1" },
      { allowCuratedAccessMode: true },
    )).rejects.toThrow(/reconnect|reauthoriz/i);

    await db.update(mcpConnections).set({ accessMode: "read_write" })
      .where(eq(mcpConnections.id, linear.id));
    await expect(svc.update(
      orgId,
      linear.id,
      { accessMode: "read_only" },
      { userId: "owner-1" },
      { allowCuratedAccessMode: true },
    )).rejects.toThrow(/reconnect|reauthoriz/i);

    await db.update(mcpConnections).set({
      status: "revoked",
      enabled: false,
    }).where(eq(mcpConnections.id, linear.id));
    await expect(svc.update(
      orgId,
      linear.id,
      { accessMode: "read_write" },
      { userId: "owner-1" },
      { allowCuratedAccessMode: true },
    )).resolves.toMatchObject({ accessMode: "read_write" });
  });

  it("does not let direct updates bypass OAuth for active official access changes", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const supabase = await svc.ensureOfficial(
      orgId,
      "supabase",
      { scope: "organization", ownerAgentId: null, accessMode: "read_only" },
      { userId: "owner-1" },
    );
    await db.update(mcpConnections).set({
      status: "active",
      enabled: true,
    }).where(eq(mcpConnections.id, supabase.id));

    await expect(svc.update(
      orgId,
      supabase.id,
      { accessMode: "read_write" },
      { userId: "owner-1" },
      { allowCuratedAccessMode: true },
    )).rejects.toThrow(/reauthoriz/i);
    await expect(svc.get(orgId, supabase.id)).resolves.toMatchObject({
      accessMode: "read_only",
      status: "active",
    });
  });

  it("does not let a superseded official connection be re-enabled", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const supabase = await svc.ensureOfficial(
      orgId,
      "supabase",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );
    await db.update(mcpConnections).set({
      canonicalState: "superseded",
      enabled: false,
      status: "active",
    }).where(eq(mcpConnections.id, supabase.id));

    await expect(svc.update(
      orgId,
      supabase.id,
      { enabled: true },
      { userId: "owner-1" },
    )).rejects.toThrow(/superseded/i);
    await expect(svc.get(orgId, supabase.id)).resolves.toMatchObject({
      enabled: false,
      status: "active",
    });
  });

  it("rejects Linear access-mode changes while OAuth is authorizing", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const linear = await svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "organization", ownerAgentId: null, accessMode: "read_only" },
      { userId: "owner-1" },
    );
    await db.update(mcpConnections).set({ status: "authorizing" })
      .where(eq(mcpConnections.id, linear.id));

    await expect(svc.update(
      orgId,
      linear.id,
      { accessMode: "read_write" },
      { userId: "owner-1" },
      { allowCuratedAccessMode: true },
    )).rejects.toThrow(/reconnect|reauthoriz/i);
    const [persisted] = await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, linear.id));
    expect(persisted).toMatchObject({
      accessMode: "read_only",
      status: "authorizing",
    });
  });

  it("does not regress a concurrently activated connection to its stale pre-lock status", async () => {
    const orgId = await seedOrg(db);
    const lookupEntered = deferred<void>();
    const releaseLookup = deferred<void>();
    const svc = service();
    const linear = await svc.ensureOfficial(
      orgId,
      "linear",
      { scope: "organization", ownerAgentId: null },
      { userId: "owner-1" },
    );
    await db.update(mcpConnections).set({ status: "authorizing" })
      .where(eq(mcpConnections.id, linear.id));

    const racingService = service({
      dnsLookup: async () => {
        lookupEntered.resolve();
        await releaseLookup.promise;
        return [{ address: "93.184.216.34", family: 4 as const }];
      },
    });
    const update = racingService.update(
      orgId,
      linear.id,
      { enabled: true },
      { userId: "owner-1" },
    );
    await lookupEntered.promise;
    await db.update(mcpConnections).set({
      status: "active",
      updatedAt: new Date(Date.now() + 1_000),
    }).where(eq(mcpConnections.id, linear.id));
    releaseLookup.resolve();

    await expect(update).resolves.toMatchObject({
      status: "active",
      enabled: true,
    });
    await expect(svc.get(orgId, linear.id)).resolves.toMatchObject({
      status: "active",
      enabled: true,
    });
  });

  it("scopes reads and mutations to the organization and implements disable/reconnect lifecycle", async () => {
    const orgId = await seedOrg(db);
    const otherOrgId = await seedOrg(db);
    const svc = service();
    const connection = await svc.create(orgId, {
      name: "lifecycle",
      displayName: "Lifecycle",
      provider: "custom",
      transport: "streamable_http",
      safeConfig: { url: "https://mcp.example.test/mcp" },
    }, { userId: "owner-1" });

    await expect(svc.get(otherOrgId, connection.id)).rejects.toThrow("MCP connection not found");
    await svc.disconnect(orgId, connection.id);
    expect(await svc.get(orgId, connection.id)).toMatchObject({
      status: "disabled",
      enabled: false,
    });
    await svc.reconnect(orgId, connection.id);
    expect(await svc.get(orgId, connection.id)).toMatchObject({
      status: "draft",
      enabled: true,
    });
  });
});
