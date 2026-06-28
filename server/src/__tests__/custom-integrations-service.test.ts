import {
  agentCustomIntegrationBindings,
  activityLog,
  agents,
  applyPendingMigrations,
  createDb,
  customIntegrationToolCalls,
  customIntegrationTools,
  customIntegrations,
  ensurePostgresDatabase,
  organizationSecretVersions,
  organizationSecrets,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { customIntegrationService } from "../services/integrations/custom-integrations.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

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
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-custom-integrations-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
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

async function seedOrgAndAgents(db: ReturnType<typeof createDb>) {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const agentId = randomUUID();
  const secondAgentId = randomUUID();
  const otherOrgAgentId = randomUUID();
  await db.insert(organizations).values([
    {
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey(`Rudder ${orgId}`),
      issuePrefix: `T${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    },
    {
      id: otherOrgId,
      name: "Other",
      urlKey: deriveOrganizationUrlKey(`Other ${otherOrgId}`),
      issuePrefix: `T${otherOrgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
      id: secondAgentId,
      orgId,
      name: "Reviewer",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: otherOrgAgentId,
      orgId: otherOrgId,
      name: "External",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);
  return { orgId, otherOrgId, agentId, secondAgentId, otherOrgAgentId };
}

describe("customIntegrationService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof customIntegrationService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    process.env.RUDDER_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = customIntegrationService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    await db.delete(customIntegrationToolCalls);
    await db.delete(activityLog);
    await db.delete(agentCustomIntegrationBindings);
    await db.delete(customIntegrationTools);
    await db.delete(customIntegrations);
    await db.delete(organizationSecretVersions);
    await db.delete(organizationSecrets);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates an agent-scoped MCP integration without exposing credential ids", async () => {
    const { orgId, agentId } = await seedOrgAndAgents(db);

    const created = await svc.createForAgent(orgId, agentId, {
      scope: "agent",
      kind: "mcp_server",
      displayName: "Linear MCP",
      config: { serverUrl: "https://mcp.example.com" },
      credential: { value: "secret-token" },
      tools: [{ externalToolName: "search_issues", description: "Search issues" }],
    }, { userId: "user-1" });

    expect(created.scope).toBe("agent");
    expect(created.ownerAgentId).toBe(agentId);
    expect(created.hasCredentialSecret).toBe(true);
    expect(JSON.stringify(created)).not.toContain("credentialSecretId");
    expect(created.tools[0]?.enabled).toBe(true);
    expect(created.tools[0]?.rudderToolName).toBe("custom.linear-mcp.search_issues");
  });

  it("allows organization-scoped integrations to bind within the same organization only", async () => {
    const { orgId, otherOrgId, agentId, secondAgentId, otherOrgAgentId } = await seedOrgAndAgents(db);

    const created = await svc.createForAgent(orgId, agentId, {
      scope: "organization",
      kind: "custom_api",
      displayName: "CRM API",
      config: { baseUrl: "https://crm.example.com" },
      tools: [{ externalToolName: "lookup_contact" }],
    }, { userId: "user-1" });
    const toolId = created.tools[0]!.id;

    const rebound = await svc.updateBindingForAgent(orgId, secondAgentId, created.id, {
      enabledToolIds: [toolId],
    });
    expect(rebound.binding?.agentId).toBe(secondAgentId);
    expect(rebound.tools[0]?.enabled).toBe(true);

    await expect(svc.updateBindingForAgent(otherOrgId, otherOrgAgentId, created.id, {
      enabledToolIds: [toolId],
    })).rejects.toThrow("Custom integration not found");
  });

  it("blocks agent-scoped integrations from another agent and excludes disabled tools from runtime prompt data", async () => {
    const { orgId, agentId, secondAgentId } = await seedOrgAndAgents(db);

    const created = await svc.createForAgent(orgId, agentId, {
      scope: "agent",
      kind: "mcp_server",
      displayName: "Personal Feishu MCP",
      tools: [
        { externalToolName: "read_doc" },
        { externalToolName: "write_doc" },
      ],
      enabledToolNames: ["read_doc"],
    }, { userId: "user-1" });

    await expect(svc.updateBindingForAgent(orgId, secondAgentId, created.id, {
      enabledToolIds: [created.tools[0]!.id],
    })).rejects.toThrow("Agent-scoped custom integrations can only be used by their owner agent");

    const tools = await svc.listRuntimeToolsForAgent(orgId, agentId);
    expect(tools.map((tool) => tool.toolName)).toEqual(["custom.personal-feishu-mcp.read_doc"]);
    expect(JSON.stringify(tools)).not.toContain("write_doc");
  });
});
