import {
  activityLog,
  agentCustomIntegrationBindings,
  agents,
  applyPendingMigrations,
  createDb,
  createLocalPostgresInstance,
  customIntegrationToolCalls,
  customIntegrationTools,
  ensurePostgresDatabase,
  heartbeatRuns,
  mcpConnections,
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
import { managedMcpBindingService } from "../services/mcp/managed-bindings.js";
import { ManagedMcpClientError, type ManagedMcpClient } from "../services/mcp/managed-client.js";
import {
  boundedRedactedMcpAuditRecord,
  managedMcpRuntimeService,
} from "../services/mcp/managed-runtime.js";
import { normalizeMcpDiscoveredTools } from "../services/mcp/tool-discovery.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Missing test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-managed-mcp-bindings-"));
  const port = await availablePort();
  const initdb = "/opt/homebrew/bin/initdb";
  const pgCtl = "/opt/homebrew/bin/pg_ctl";
  if (fs.existsSync(initdb) && fs.existsSync(pgCtl)) {
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
        execFileSync(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "stop"], {
          stdio: "ignore",
        });
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
  const admin = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(admin, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

async function seed(db: ReturnType<typeof createDb>) {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  await db.insert(organizations).values([
    {
      id: orgId,
      name: "MCP Bindings",
      urlKey: deriveOrganizationUrlKey(`MCP Bindings ${orgId}`),
      issuePrefix: `B${orgId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    },
    {
      id: otherOrgId,
      name: "Other MCP Bindings",
      urlKey: deriveOrganizationUrlKey(`Other MCP Bindings ${otherOrgId}`),
      issuePrefix: `O${otherOrgId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    },
  ]);
  await db.insert(agents).values([
    {
      id: agentId,
      orgId,
      name: "Builder",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: otherAgentId,
      orgId: otherOrgId,
      name: "Other",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);
  const [first, second, foreign] = await db.insert(mcpConnections).values([
    {
      orgId,
      name: "alpha",
      displayName: "Alpha",
      provider: "custom",
      transport: "streamable_http",
      accessMode: "provider_default",
      status: "active",
      safeConfig: { url: "https://alpha.example.test/mcp" },
      enabled: true,
      required: false,
      activatedAt: new Date(),
    },
    {
      orgId,
      name: "beta",
      displayName: "Beta",
      provider: "custom",
      transport: "streamable_http",
      accessMode: "provider_default",
      status: "active",
      safeConfig: { url: "https://beta.example.test/mcp" },
      enabled: true,
      required: false,
      activatedAt: new Date(),
    },
    {
      orgId: otherOrgId,
      name: "foreign",
      displayName: "Foreign",
      provider: "custom",
      transport: "streamable_http",
      accessMode: "provider_default",
      status: "active",
      safeConfig: { url: "https://foreign.example.test/mcp" },
      enabled: true,
      required: false,
      activatedAt: new Date(),
    },
  ]).returning();
  const [alphaRead, alphaWrite, betaRead, foreignRead] = await db
    .insert(customIntegrationTools)
    .values([
      {
        orgId,
        connectionId: first!.id,
        externalToolName: "read",
        rudderToolName: "external.alpha.read",
        inputSchema: { type: "object" },
        status: "active",
        enabled: true,
      },
      {
        orgId,
        connectionId: first!.id,
        externalToolName: "write",
        rudderToolName: "external.alpha.write",
        inputSchema: { type: "object" },
        status: "active",
        enabled: true,
      },
      {
        orgId,
        connectionId: second!.id,
        externalToolName: "read",
        rudderToolName: "external.beta.read",
        inputSchema: { type: "object" },
        status: "active",
        enabled: true,
      },
      {
        orgId: otherOrgId,
        connectionId: foreign!.id,
        externalToolName: "read",
        rudderToolName: "external.foreign.read",
        inputSchema: { type: "object" },
        status: "active",
        enabled: true,
      },
    ])
    .returning();
  return {
    orgId,
    otherOrgId,
    agentId,
    otherAgentId,
    first: first!,
    second: second!,
    foreign: foreign!,
    alphaRead: alphaRead!,
    alphaWrite: alphaWrite!,
    betaRead: betaRead!,
    foreignRead: foreignRead!,
  };
}

describe("managedMcpBindingService", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: LocalPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    await db.delete(customIntegrationToolCalls);
    await db.delete(activityLog);
    await db.delete(agentCustomIntegrationBindings);
    await db.delete(customIntegrationTools);
    await db.delete(mcpConnections);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("defaults a first binding to current active tools and never auto-adds later discoveries", async () => {
    const fixture = await seed(db);
    const svc = managedMcpBindingService(db);

    const created = await svc.upsert(
      fixture.orgId,
      fixture.agentId,
      fixture.first.id,
      {},
      { userId: "board" },
    );
    expect(created.binding?.enabledToolIds.sort()).toEqual([
      fixture.alphaRead.id,
      fixture.alphaWrite.id,
    ].sort());
    expect(await db.select({ action: activityLog.action }).from(activityLog)
      .where(eq(activityLog.entityId, created.binding!.id))).toEqual([
      { action: "mcp_agent_binding.created" },
    ]);

    const [later] = await db.insert(customIntegrationTools).values({
      orgId: fixture.orgId,
      connectionId: fixture.first.id,
      externalToolName: "new-tool",
      rudderToolName: "external.alpha.new-tool",
      inputSchema: { type: "object" },
      status: "active",
      enabled: true,
    }).returning();
    const runtime = await svc.listRuntimeBindings(fixture.orgId, fixture.agentId);
    expect(runtime[0]?.toolPolicy.allowedToolNames.sort()).toEqual([
      "external.alpha.read",
      "external.alpha.write",
    ]);
    expect(runtime[0]?.toolPolicy.allowedToolNames).not.toContain(later!.rudderToolName);

    await db.update(customIntegrationTools).set({
      status: "removed",
      enabled: false,
      removedAt: new Date(),
    }).where(eq(customIntegrationTools.id, fixture.alphaWrite.id));
    expect((await svc.listRuntimeBindings(fixture.orgId, fixture.agentId))[0]
      ?.toolPolicy.allowedToolNames).toEqual(["external.alpha.read"]);
  });

  it("preserves disabled and revoked binding state when a tool-only update omits status", async () => {
    const fixture = await seed(db);
    const svc = managedMcpBindingService(db);
    await svc.upsert(fixture.orgId, fixture.agentId, fixture.first.id, {
      status: "disabled",
    });
    const disabled = await svc.upsert(fixture.orgId, fixture.agentId, fixture.first.id, {
      enabledToolIds: [fixture.alphaRead.id],
    });
    expect(disabled.binding).toMatchObject({
      status: "disabled",
      enabledToolIds: [fixture.alphaRead.id],
    });
    const persistedDisabled = await db.select().from(agentCustomIntegrationBindings)
      .where(eq(agentCustomIntegrationBindings.id, disabled.binding!.id))
      .then((rows) => rows[0]!);
    expect(persistedDisabled.revokedAt).toBeNull();

    await svc.upsert(fixture.orgId, fixture.agentId, fixture.second.id, {});
    const revoked = await svc.revoke(
      fixture.orgId,
      fixture.agentId,
      fixture.second.id,
      { userId: "board" },
    );
    const persistedRevoked = await db.select().from(agentCustomIntegrationBindings)
      .where(eq(agentCustomIntegrationBindings.id, revoked!.binding!.id))
      .then((rows) => rows[0]!);
    expect(persistedRevoked.revokedAt).toBeInstanceOf(Date);
    const updated = await svc.upsert(fixture.orgId, fixture.agentId, fixture.second.id, {
      enabledToolIds: [fixture.betaRead.id],
    });
    expect(updated.binding).toMatchObject({
      status: "revoked",
      enabledToolIds: [fixture.betaRead.id],
    });
    const persistedUpdated = await db.select().from(agentCustomIntegrationBindings)
      .where(eq(agentCustomIntegrationBindings.id, updated.binding!.id))
      .then((rows) => rows[0]!);
    expect(persistedUpdated.revokedAt?.getTime())
      .toBe(persistedRevoked.revokedAt?.getTime());
  });

  it("uses the persisted tool namespace as the runtime server name for long connection names", async () => {
    const fixture = await seed(db);
    const connectionName = "c".repeat(80);
    const [normalized] = normalizeMcpDiscoveredTools(connectionName, [{
      name: "read",
      inputSchema: { type: "object" },
    }]);
    const [connection] = await db.insert(mcpConnections).values({
      orgId: fixture.orgId,
      name: connectionName,
      displayName: "Long connection",
      provider: "custom",
      transport: "streamable_http",
      accessMode: "provider_default",
      status: "active",
      safeConfig: { url: "https://long.example.test/mcp" },
      enabled: true,
      required: false,
      activatedAt: new Date(),
    }).returning();
    const [tool] = await db.insert(customIntegrationTools).values({
      orgId: fixture.orgId,
      connectionId: connection!.id,
      externalToolName: "read",
      rudderToolName: normalized!.rudderToolName,
      inputSchema: { type: "object" },
      status: "active",
      enabled: true,
    }).returning();
    const svc = managedMcpBindingService(db);
    await svc.upsert(fixture.orgId, fixture.agentId, connection!.id, {
      enabledToolIds: [tool!.id],
    });

    const runtime = await svc.listRuntimeBindings(fixture.orgId, fixture.agentId);
    const binding = runtime.find((entry) =>
      entry.toolPolicy.allowedToolNames.includes(normalized!.rudderToolName));
    const expectedNamespace = normalized!.rudderToolName
      .slice("external.".length, -".read".length);
    expect(binding).toMatchObject({
      serverName: expectedNamespace,
      toolPolicy: { allowedToolNames: [normalized!.rudderToolName] },
    });
    expect(normalized!.rudderToolName.startsWith(`external.${binding!.serverName}.`))
      .toBe(true);
  });

  it("rejects foreign and cross-connection tool IDs", async () => {
    const fixture = await seed(db);
    const svc = managedMcpBindingService(db);

    await expect(svc.upsert(
      fixture.orgId,
      fixture.agentId,
      fixture.first.id,
      { enabledToolIds: [fixture.betaRead.id] },
    )).rejects.toThrow("Enabled tools must belong to the selected MCP connection");
    await expect(svc.upsert(
      fixture.orgId,
      fixture.agentId,
      fixture.foreign.id,
      {},
    )).rejects.toThrow("MCP connection not found");
    await expect(svc.listForAgent(fixture.orgId, fixture.otherAgentId))
      .rejects.toThrow("Agent must belong to same organization");
  });

  it("excludes malformed bindings whose joined connection belongs to another organization", async () => {
    const fixture = await seed(db);
    await db.insert(agentCustomIntegrationBindings).values({
      orgId: fixture.orgId,
      agentId: fixture.agentId,
      connectionId: fixture.foreign.id,
      status: "active",
      enabledToolIds: [fixture.foreignRead.id],
    });

    await expect(managedMcpBindingService(db).listRuntimeBindings(
      fixture.orgId,
      fixture.agentId,
    )).resolves.toEqual([]);
  });

  it("keeps bounded audit records within 24 KiB for multibyte UTF-8 content", () => {
    const audit = boundedRedactedMcpAuditRecord(Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `field${index}`,
        "😀".repeat(2_048),
      ]),
    ));

    expect(Buffer.byteLength(JSON.stringify(audit), "utf8"))
      .toBeLessThanOrEqual(24 * 1_024);
  });

  it("omits unavailable optional bindings, fails unavailable required bindings, and returns exact neutral DTOs", async () => {
    const fixture = await seed(db);
    const svc = managedMcpBindingService(db);
    await svc.upsert(fixture.orgId, fixture.agentId, fixture.first.id, {});
    await svc.upsert(fixture.orgId, fixture.agentId, fixture.second.id, {});

    const available = await svc.listRuntimeBindings(fixture.orgId, fixture.agentId);
    expect(available).toEqual([
      {
        bindingId: expect.any(String),
        serverName: "alpha",
        toolPolicy: {
          mode: "allowlist",
          allowedToolNames: ["external.alpha.read", "external.alpha.write"],
        },
        required: false,
        startupTimeoutMs: 10_000,
        toolTimeoutMs: 60_000,
      },
      {
        bindingId: expect.any(String),
        serverName: "beta",
        toolPolicy: {
          mode: "allowlist",
          allowedToolNames: ["external.beta.read"],
        },
        required: false,
        startupTimeoutMs: 10_000,
        toolTimeoutMs: 60_000,
      },
    ]);
    expect(JSON.stringify(available)).not.toMatch(
      /provider|connectionId|externalScope|safeConfig|credential|token|url/iu,
    );

    await db.update(mcpConnections).set({ enabled: false, status: "disabled" })
      .where(eq(mcpConnections.id, fixture.first.id));
    expect((await svc.listRuntimeBindings(fixture.orgId, fixture.agentId))
      .map((binding) => binding.serverName)).toEqual(["beta"]);

    await db.update(mcpConnections).set({ required: true })
      .where(eq(mcpConnections.id, fixture.first.id));
    await expect(svc.listRuntimeBindings(fixture.orgId, fixture.agentId))
      .rejects.toThrow("Required managed MCP connection alpha is unavailable");
  });

  it("revokes bindings without deleting the organization connection", async () => {
    const fixture = await seed(db);
    const svc = managedMcpBindingService(db);
    await svc.upsert(fixture.orgId, fixture.agentId, fixture.first.id, {});

    const revoked = await svc.revoke(
      fixture.orgId,
      fixture.agentId,
      fixture.first.id,
      { userId: "board" },
    );
    expect(revoked?.binding?.status).toBe("revoked");
    expect((await db.select({ action: activityLog.action }).from(activityLog)
      .where(eq(activityLog.entityId, revoked!.binding!.id)))
      .map((row) => row.action)).toEqual([
      "mcp_agent_binding.created",
      "mcp_agent_binding.revoked",
    ]);
    expect(await db.select().from(mcpConnections)
      .where(eq(mcpConnections.id, fixture.first.id))).toHaveLength(1);
    expect(await svc.listRuntimeBindings(fixture.orgId, fixture.agentId)).toEqual([]);
  });

  it("locks and revalidates the connection before deriving first-bind defaults", async () => {
    const fixture = await seed(db);
    const svc = managedMcpBindingService(db);
    const acquired = deferred<void>();
    const disable = deferred<void>();
    const blocker = db.transaction(async (tx) => {
      await tx.select({ id: mcpConnections.id }).from(mcpConnections)
        .where(eq(mcpConnections.id, fixture.first.id))
        .for("update");
      acquired.resolve();
      await disable.promise;
      await tx.update(mcpConnections)
        .set({ status: "disabled", enabled: false, disabledAt: new Date() })
        .where(eq(mcpConnections.id, fixture.first.id));
    });
    await acquired.promise;

    const upsert = svc.upsert(fixture.orgId, fixture.agentId, fixture.first.id, {});
    const early = await Promise.race([
      upsert.then(() => "settled", () => "settled"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    disable.resolve();
    await blocker;
    expect(early).toBe("pending");
    await expect(upsert).rejects.toThrow(
      "Only active managed MCP connections can be bound to agents",
    );
    expect(await db.select().from(agentCustomIntegrationBindings)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("dispatches allowlisted tools for a live signed run and writes bounded redacted audit", async () => {
    const fixture = await seed(db);
    const bindingSummary = await managedMcpBindingService(db).upsert(
      fixture.orgId,
      fixture.agentId,
      fixture.first.id,
      { enabledToolIds: [fixture.alphaRead.id] },
    );
    const [run] = await db.insert(heartbeatRuns).values({
      orgId: fixture.orgId,
      agentId: fixture.agentId,
      status: "running",
      startedAt: new Date(),
    }).returning();
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      structuredContent: {
        token: "upstream-secret",
        nested: { authorization: "Bearer should-not-persist" },
        bearerValue: "Bearer standalone-secret",
        opaque: "sk-proj-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        long: "x".repeat(100_000),
      },
    });
    const close = vi.fn().mockResolvedValue(undefined);
    const openClient = vi.fn().mockResolvedValue({
      discoverTools: vi.fn(),
      callTool,
      close,
    } satisfies ManagedMcpClient);
    const runtime = managedMcpRuntimeService(db, {
      openClient,
      requireUsableGrant: vi.fn(),
    });
    const identity = {
      orgId: fixture.orgId,
      agentId: fixture.agentId,
      runId: run!.id,
    };

    expect((await runtime.listTools(identity, bindingSummary.binding!.id))
      .map((tool) => tool.name)).toEqual(["external.alpha.read"]);
    const result = await runtime.callTool(
      identity,
      bindingSummary.binding!.id,
      "external.alpha.read",
      {
        query: "hello",
        password: "input-secret",
        nested: { accessToken: "nested-secret" },
        note: "Basic cHJpdmF0ZTpwYXNzd29yZA==",
        comment: "prefix Bearer private-token-value suffix",
      },
    );
    expect(result).toEqual(expect.objectContaining({
      content: [{ type: "text", text: "ok" }],
    }));
    expect(callTool).toHaveBeenCalledWith("read", {
      query: "hello",
      password: "input-secret",
      nested: { accessToken: "nested-secret" },
      note: "Basic cHJpdmF0ZTpwYXNzd29yZA==",
      comment: "prefix Bearer private-token-value suffix",
    });
    expect(openClient).toHaveBeenCalledWith(fixture.orgId, fixture.first.id);
    expect(close).toHaveBeenCalledTimes(1);

    const [audit] = await db.select().from(customIntegrationToolCalls);
    expect(audit).toEqual(expect.objectContaining({
      orgId: fixture.orgId,
      agentId: fixture.agentId,
      runId: run!.id,
      connectionId: fixture.first.id,
      toolId: fixture.alphaRead.id,
      status: "success",
    }));
    const persisted = JSON.stringify({
      input: audit!.sanitizedInput,
      result: audit!.sanitizedResult,
      outcome: audit!.redactedDispatchOutcome,
    });
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(64 * 1024);
    expect(persisted).not.toContain("input-secret");
    expect(persisted).not.toContain("nested-secret");
    expect(persisted).not.toContain("upstream-secret");
    expect(persisted).not.toContain("should-not-persist");
    expect(persisted).not.toContain("standalone-secret");
    expect(persisted).not.toContain("sk-proj-");
    expect(persisted).not.toContain("cHJpdmF0");
    expect(persisted).not.toContain("private-token-value");
    expect(persisted).toContain("***REDACTED***");
  });

  it("revalidates the signed run, binding, connection, and current tool allowlist", async () => {
    const fixture = await seed(db);
    const summary = await managedMcpBindingService(db).upsert(
      fixture.orgId,
      fixture.agentId,
      fixture.first.id,
      { enabledToolIds: [fixture.alphaRead.id] },
    );
    const [queuedRun] = await db.insert(heartbeatRuns).values({
      orgId: fixture.orgId,
      agentId: fixture.agentId,
      status: "queued",
    }).returning();
    const requireUsableGrant = vi.fn();
    const runtime = managedMcpRuntimeService(db, {
      openClient: vi.fn(),
      requireUsableGrant,
    });
    const identity = {
      orgId: fixture.orgId,
      agentId: fixture.agentId,
      runId: queuedRun!.id,
    };
    await expect(runtime.listTools(identity, summary.binding!.id))
      .rejects.toThrow("Managed MCP runtime context is not active");

    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() })
      .where(eq(heartbeatRuns.id, queuedRun!.id));
    await expect(runtime.listTools({
      ...identity,
      agentId: fixture.otherAgentId,
    }, summary.binding!.id)).rejects.toThrow(
      "Managed MCP runtime context is not active",
    );

    await db.update(mcpConnections).set({ provider: "linear" })
      .where(eq(mcpConnections.id, fixture.first.id));
    requireUsableGrant.mockRejectedValueOnce(
      new Error("revoked provider grant with secret detail"),
    );
    await expect(runtime.listTools(identity, summary.binding!.id))
      .rejects.toThrow("Managed MCP binding is unavailable");
    expect(requireUsableGrant).toHaveBeenCalledWith(
      fixture.orgId,
      fixture.first.id,
    );
    await db.update(mcpConnections).set({ provider: "custom" })
      .where(eq(mcpConnections.id, fixture.first.id));

    await db.update(customIntegrationTools).set({
      status: "removed",
      enabled: false,
      removedAt: new Date(),
    }).where(eq(customIntegrationTools.id, fixture.alphaRead.id));
    expect(await runtime.listTools(identity, summary.binding!.id)).toEqual([]);
    await expect(runtime.callTool(
      identity,
      summary.binding!.id,
      "external.alpha.read",
      {},
    )).rejects.toThrow("Managed MCP tool is not enabled for this run");
    expect(await db.select().from(customIntegrationToolCalls)).toEqual([
      expect.objectContaining({
        toolId: fixture.alphaRead.id,
        status: "blocked",
        errorCode: "mcp_tool_not_allowed",
      }),
    ]);
    await expect(runtime.callTool(
      identity,
      summary.binding!.id,
      "external.alpha.unknown",
      { token: "unknown-secret" },
    )).rejects.toThrow("Managed MCP tool is not enabled for this run");
    expect((await db.select({ action: activityLog.action }).from(activityLog))
      .map((row) => row.action)).toContain("mcp_tool_call.blocked_unknown");

    await db.update(mcpConnections).set({ status: "disabled", enabled: false })
      .where(eq(mcpConnections.id, fixture.first.id));
    await expect(runtime.listTools(identity, summary.binding!.id))
      .rejects.toThrow("Managed MCP binding is unavailable");

    await db.update(mcpConnections).set({ status: "active", enabled: true })
      .where(eq(mcpConnections.id, fixture.first.id));
    await db.update(agentCustomIntegrationBindings)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(agentCustomIntegrationBindings.id, summary.binding!.id));
    await expect(runtime.listTools(identity, summary.binding!.id))
      .rejects.toThrow("Managed MCP binding is unavailable");
  });

  it.each([
    ["mcp_tool_timeout"],
    ["mcp_upstream_unauthorized"],
    ["mcp_tool_failed"],
  ])("audits safe upstream %s failures and always closes the client", async (code) => {
    const fixture = await seed(db);
    const summary = await managedMcpBindingService(db).upsert(
      fixture.orgId,
      fixture.agentId,
      fixture.first.id,
      { enabledToolIds: [fixture.alphaRead.id] },
    );
    const [run] = await db.insert(heartbeatRuns).values({
      orgId: fixture.orgId,
      agentId: fixture.agentId,
      status: "running",
      startedAt: new Date(),
    }).returning();
    const close = vi.fn().mockResolvedValue(undefined);
    const runtime = managedMcpRuntimeService(db, {
      openClient: vi.fn().mockResolvedValue({
        discoverTools: vi.fn(),
        callTool: vi.fn().mockRejectedValue(
          new ManagedMcpClientError(code, "secret upstream details"),
        ),
        close,
      } satisfies ManagedMcpClient),
      requireUsableGrant: vi.fn(),
    });

    const failure = runtime.callTool({
      orgId: fixture.orgId,
      agentId: fixture.agentId,
      runId: run!.id,
    }, summary.binding!.id, "external.alpha.read", {
      authorization: "Bearer private",
    });
    await expect(failure).rejects.toMatchObject({
      code,
      message: code === "mcp_tool_timeout"
        ? "Managed MCP tool call timed out"
        : code === "mcp_upstream_unauthorized"
          ? "Managed MCP authorization was rejected"
          : "Managed MCP tool call failed",
    });
    await expect(failure).rejects.not.toThrow("secret upstream details");
    expect(close).toHaveBeenCalledTimes(1);
    const [audit] = await db.select().from(customIntegrationToolCalls);
    expect(audit).toEqual(expect.objectContaining({
      status: "error",
      errorCode: code,
    }));
    expect(JSON.stringify(audit)).not.toContain("secret upstream details");
    expect(JSON.stringify(audit)).not.toContain("Bearer private");
  });
});
