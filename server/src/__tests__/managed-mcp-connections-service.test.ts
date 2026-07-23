import {
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
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

describe("managedMcpConnectionService", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: LocalPostgresInstance | null = null;
  let dataDir = "";
  const createClient = vi.fn<(options: ManagedMcpClientOptions) => Promise<ManagedMcpClient>>();

  beforeAll(async () => {
    process.env.RUDDER_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    createClient.mockReset();
    await db.delete(agentCustomIntegrationBindings);
    await db.delete(customIntegrationTools);
    await db.delete(mcpConnections);
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
    return managedMcpConnectionService(db, {
      deploymentMode: "local_trusted",
      allowlists: {
        httpOrigins: [],
        stdioCommands: [],
        stdioWorkingDirectories: [],
        stdioEnvironmentNames: [],
      },
      hostEnv: {},
      createClient,
      dnsLookup: async () => [{ address: "93.184.216.34", family: 4 as const }],
      ...overrides,
    });
  }

  it("creates curated providers from registry defaults without accepting client endpoints or credentials", async () => {
    const orgId = await seedOrg(db);
    const svc = service();

    const supabase = await svc.create(orgId, {
      name: "supabase-main",
      displayName: "Supabase",
      provider: "supabase",
      transport: "streamable_http",
      safeConfig: {},
    }, { userId: "owner-1" });
    const linear = await svc.create(orgId, {
      name: "linear-main",
      displayName: "Linear",
      provider: "linear",
      transport: "streamable_http",
      safeConfig: {},
    }, { userId: "owner-1" });
    const notion = await svc.create(orgId, {
      name: "notion-main",
      displayName: "Notion",
      provider: "notion",
      transport: "streamable_http",
      safeConfig: {},
    }, { userId: "owner-1" });

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
    }, { userId: "owner-1" })).rejects.toThrow();
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
    await db.insert(agentCustomIntegrationBindings).values({
      orgId,
      agentId,
      connectionId: connection.id,
      status: "active",
      enabledToolIds: [search.id],
    });

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

  it("invalidates an active curated grant transactionally when reconnect begins", async () => {
    const orgId = await seedOrg(db);
    const grantCredential = await secretService(db).create(orgId, {
      name: "Linear OAuth credential",
      provider: "local_encrypted",
      value: JSON.stringify({ accessToken: "old-linear-token" }),
    });
    const client = clientWithTools([]);
    createClient.mockResolvedValue(client);
    const svc = service();
    const connection = await svc.create(orgId, {
      name: "linear-reconnect",
      displayName: "Linear reconnect",
      provider: "linear",
      transport: "streamable_http",
      safeConfig: {},
    }, { userId: "owner-1" });
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
    });
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

  it("requires a Supabase project before discovery and enforces centralized access-mode rules", async () => {
    const orgId = await seedOrg(db);
    const svc = service();
    const supabase = await svc.create(orgId, {
      name: "supabase",
      displayName: "Supabase",
      provider: "supabase",
      transport: "streamable_http",
      safeConfig: {},
    }, { userId: "owner-1" });
    const notion = await svc.create(orgId, {
      name: "notion",
      displayName: "Notion",
      provider: "notion",
      transport: "streamable_http",
      safeConfig: {},
    }, { userId: "owner-1" });

    await expect(svc.refreshTools(orgId, supabase.id)).rejects.toThrow(
      /selected project/i,
    );
    await expect(svc.update(
      orgId,
      notion.id,
      { accessMode: "read_only" },
      { userId: "owner-1" },
    )).rejects.toThrow(/does not support/i);
    expect(createClient).not.toHaveBeenCalled();
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
