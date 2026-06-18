import {
  activityLog,
  agentIntegrationBindingTokens,
  agentIntegrationChatBindings,
  agentIntegrationInboundAudit,
  agentIntegrationInboundDedup,
  agentIntegrationOutboundMessages,
  agentIntegrationUserBindings,
  agentIntegrations,
  agents,
  applyPendingMigrations,
  chatContextLinks,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  organizationMemberships,
  organizationSecretVersions,
  organizationSecrets,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { feishuCallbackCredentialService } from "../services/integrations/feishu/callback-credentials.js";
import { createFeishuInboundDispatcherDbDeps } from "../services/integrations/feishu/inbound-dispatcher-db.js";
import {
  dispatchFeishuInboundMessage,
  type FeishuInboundMessage,
} from "../services/integrations/feishu/inbound-dispatcher.js";

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

function getExternalDatabaseUrl() {
  return process.env.RUDDER_FEISHU_DISPATCHER_TEST_DATABASE_URL?.trim()
    || process.env.RUDDER_MESSENGER_SERVICE_TEST_DATABASE_URL?.trim()
    || null;
}

async function startTempDatabase() {
  const externalDatabaseUrl = getExternalDatabaseUrl();
  if (externalDatabaseUrl) {
    await applyPendingMigrations(externalDatabaseUrl);
    return { connectionString: externalDatabaseUrl, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-feishu-dispatcher-"));
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

function inboundEvent(overrides: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
  return {
    provider: "feishu",
    eventId: `event-${randomUUID()}`,
    appId: "cli_a_feishu_app",
    botOpenId: "ou_bot",
    chatId: "oc_chat",
    chatType: "p2p",
    messageId: `om_${randomUUID()}`,
    senderOpenId: "ou_sender",
    senderUnionId: "on_sender",
    body: "hello from Feishu",
    commandBody: "hello from Feishu",
    addressedToBot: true,
    messageType: "text",
    receivedAt: new Date("2026-06-18T08:00:00.000Z"),
    ...overrides,
  };
}

describe("Feishu inbound dispatcher DB deps", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentIntegrationOutboundMessages);
    await db.delete(agentIntegrationInboundAudit);
    await db.delete(agentIntegrationInboundDedup);
    await db.delete(agentIntegrationBindingTokens);
    await db.delete(agentIntegrationChatBindings);
    await db.delete(agentIntegrationUserBindings);
    await db.delete(chatContextLinks);
    await db.delete(chatMessages);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(chatConversations);
    await db.delete(issues);
    await db.delete(agentIntegrations);
    await db.delete(organizationSecretVersions);
    await db.delete(organizationSecrets);
    await db.delete(organizationMemberships);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function seedIntegration(options: { bindUser?: boolean; member?: boolean; credentialValue?: string } = {}) {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const secretId = randomUUID();
    const integrationId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const preparedSecret = await localEncryptedProvider.createVersion({
      value: options.credentialValue ?? "feishu-app-secret",
      externalRef: null,
    });

    await db.insert(organizations).values({
      id: orgId,
      name: "Feishu Dispatcher Org",
      urlKey: deriveOrganizationUrlKey(`Feishu Dispatcher Org ${orgId}`),
      issuePrefix: `F${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Feishu Agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(organizationSecrets).values({
      id: secretId,
      orgId,
      name: "Feishu app credentials",
      provider: "local_encrypted",
    });
    await db.insert(organizationSecretVersions).values({
      secretId,
      version: 1,
      material: preparedSecret.material,
      valueSha256: preparedSecret.valueSha256,
    });
    await db.insert(agentIntegrations).values({
      id: integrationId,
      orgId,
      agentId,
      provider: "feishu",
      status: "active",
      transport: "long_connection",
      providerRegion: "feishu_cn",
      appCredentialSecretId: secretId,
      externalAppId: "cli_a_feishu_app",
      externalBotOpenId: "ou_bot",
    });
    if (options.member ?? true) {
      await db.insert(organizationMemberships).values({
        id: randomUUID(),
        orgId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "member",
      });
    }
    if (options.bindUser ?? true) {
      await db.insert(agentIntegrationUserBindings).values({
        id: randomUUID(),
        orgId,
        integrationId,
        userId,
        externalOpenId: "ou_sender",
        externalUnionId: "on_sender",
      });
    }

    return { orgId, agentId, integrationId, userId };
  }

  it("resolves Feishu callback verification credentials from the active integration secret", async () => {
    const seeded = await seedIntegration({
      credentialValue: JSON.stringify({
        verificationToken: "callback-token",
        encryptKey: "callback-encrypt-key",
      }),
    });

    await expect(feishuCallbackCredentialService(db).resolveForCallback(seeded.orgId, {
      appId: "cli_a_feishu_app",
    })).resolves.toEqual({
      verificationToken: "callback-token",
      encryptKey: "callback-encrypt-key",
    });
  });

  it("creates binding tokens for unbound users without dedup or message body persistence", async () => {
    const seeded = await seedIntegration({ bindUser: false });

    const result = await dispatchFeishuInboundMessage(
      inboundEvent({ body: "do not persist this until bound" }),
      createFeishuInboundDispatcherDbDeps(db),
    );

    expect(result).toEqual({ status: "binding_required" });
    await expect(db.select().from(agentIntegrationBindingTokens)).resolves.toHaveLength(1);
    await expect(db.select().from(agentIntegrationInboundDedup)).resolves.toHaveLength(0);
    await expect(db.select().from(chatMessages)).resolves.toHaveLength(0);

    const [audit] = await db.select().from(agentIntegrationInboundAudit);
    expect(audit).toMatchObject({
      orgId: seeded.orgId,
      integrationId: seeded.integrationId,
      dropReason: "unbound_user",
      bodyPersisted: false,
    });
    expect(audit).not.toHaveProperty("body");
  });

  it("accepts bound messages into chat, issue, run, and outbound placeholder records", async () => {
    const seeded = await seedIntegration();
    const event = inboundEvent({
      messageId: "om_accept",
      eventId: "event_accept",
      commandBody: "/issue Fix Feishu inbox\nRoute accepted messages into Rudder.",
      body: "/issue Fix Feishu inbox\nRoute accepted messages into Rudder.",
    });

    const result = await dispatchFeishuInboundMessage(event, createFeishuInboundDispatcherDbDeps(db));

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") throw new Error("Expected accepted result");
    expect(result.issueId).toEqual(expect.any(String));
    expect(result.runId).toEqual(expect.any(String));

    const messages = await db.select().from(chatMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      orgId: seeded.orgId,
      conversationId: result.conversationId,
      role: "user",
      kind: "message",
      body: event.body,
    });
    expect(messages[0]?.structuredPayload).toMatchObject({
      source: "agent_integration",
      provider: "feishu",
      integrationId: seeded.integrationId,
      externalMessageId: "om_accept",
    });

    const [issue] = await db.select().from(issues).where(eq(issues.id, result.issueId!));
    expect(issue).toMatchObject({
      title: "Fix Feishu inbox",
      description: "Route accepted messages into Rudder.",
      status: "todo",
      assigneeAgentId: seeded.agentId,
      createdByUserId: seeded.userId,
      originKind: "agent_integration",
      originId: "feishu:om_accept",
    });

    await expect(db.select().from(agentIntegrationInboundDedup)).resolves.toHaveLength(1);
    await expect(db.select().from(agentIntegrationChatBindings)).resolves.toHaveLength(1);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, result.runId!))).resolves.toHaveLength(1);
    const [outbound] = await db.select().from(agentIntegrationOutboundMessages);
    expect(outbound).toMatchObject({
      orgId: seeded.orgId,
      integrationId: seeded.integrationId,
      conversationId: result.conversationId,
      chatMessageId: result.chatMessageId,
      issueId: result.issueId,
      runId: result.runId,
      externalChatId: event.chatId,
      status: "pending",
    });
  });

  it("dedupes repeated messages before appending a second chat message", async () => {
    await seedIntegration();
    const event = inboundEvent({ messageId: "om_duplicate", eventId: "event_duplicate" });
    const deps = createFeishuInboundDispatcherDbDeps(db);

    await expect(dispatchFeishuInboundMessage(event, deps)).resolves.toMatchObject({ status: "accepted" });
    await expect(dispatchFeishuInboundMessage({ ...event, eventId: "event_duplicate_retry" }, deps)).resolves.toEqual({
      status: "dropped",
      reason: "duplicate",
    });

    await expect(db.select().from(chatMessages)).resolves.toHaveLength(1);
    await expect(db.select().from(agentIntegrationInboundDedup)).resolves.toHaveLength(1);
    const audits = await db.select().from(agentIntegrationInboundAudit);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ dropReason: "duplicate", bodyPersisted: false });
  });
});
