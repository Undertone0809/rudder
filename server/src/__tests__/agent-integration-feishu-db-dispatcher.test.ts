import {
  normalize as normalizeLarkMessage,
  type NormalizedMessage,
  type RawMessageEvent,
} from "@larksuiteoapi/node-sdk";
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
import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { integrationRoutes } from "../routes/integrations.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { agentIntegrationService } from "../services/integrations/agent-integrations.js";
import { feishuCallbackCredentialService } from "../services/integrations/feishu/callback-credentials.js";
import { createFeishuInboundDispatcherDbDeps } from "../services/integrations/feishu/inbound-dispatcher-db.js";
import {
  dispatchFeishuInboundMessage,
  type FeishuInboundMessage,
} from "../services/integrations/feishu/inbound-dispatcher.js";
import { isFeishuLongConnectionEnabled } from "../services/integrations/feishu/runtime-registry.js";
import {
  createFeishuRestOutboundSender,
  dispatchFeishuNormalizedMessage,
  feishuIntegrationRuntimeService,
  feishuRuntimePayloadFromNormalizedMessage,
  type FeishuLongConnectionClient,
  type FeishuOutboundSender,
} from "../services/integrations/feishu/runtime.js";
import { feishuIntegrationUserBindingService } from "../services/integrations/feishu/user-bindings.js";

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

function createRouteApp(db: ReturnType<typeof createDb>, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  }));
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", integrationRoutes(db));
  app.use(errorHandler);
  return app;
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

    return { orgId, agentId, integrationId, secretId, userId };
  }

  it("enables Feishu long connection by default and only disables it explicitly", () => {
    expect(isFeishuLongConnectionEnabled(undefined)).toBe(true);
    expect(isFeishuLongConnectionEnabled("")).toBe(true);
    expect(isFeishuLongConnectionEnabled("true")).toBe(true);
    expect(isFeishuLongConnectionEnabled("false")).toBe(false);
    expect(isFeishuLongConnectionEnabled("0")).toBe(false);
    expect(isFeishuLongConnectionEnabled("no")).toBe(false);
  });

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

  it("reactivates a revoked Feishu integration instead of violating the per-agent provider unique index", async () => {
    const seeded = await seedIntegration({ bindUser: false });
    const nextSecretId = randomUUID();
    const preparedSecret = await localEncryptedProvider.createVersion({
      value: JSON.stringify({ appId: "cli_new_feishu_app", appSecret: "new-secret" }),
      externalRef: null,
    });
    await db.insert(organizationSecrets).values({
      id: nextSecretId,
      orgId: seeded.orgId,
      name: "Feishu app credentials replacement",
      provider: "local_encrypted",
    });
    await db.insert(organizationSecretVersions).values({
      secretId: nextSecretId,
      version: 1,
      material: preparedSecret.material,
      valueSha256: preparedSecret.valueSha256,
    });
    await agentIntegrationService(db).revokeForAgent(seeded.orgId, seeded.agentId, seeded.integrationId);

    const reactivated = await agentIntegrationService(db).create(seeded.orgId, {
      agentId: seeded.agentId,
      provider: "feishu",
      transport: "long_connection",
      providerRegion: "feishu_cn",
      appCredentialSecretId: nextSecretId,
      externalAppId: "cli_new_feishu_app",
      installerUserId: "ou_new_installer",
      manageUrl: "https://open.feishu.cn/app/cli_new_feishu_app",
    });

    expect(reactivated).toMatchObject({
      id: seeded.integrationId,
      status: "active",
      appCredentialSecretId: nextSecretId,
      externalAppId: "cli_new_feishu_app",
      installerUserId: "ou_new_installer",
      revokedAt: null,
    });
    await expect(db.select().from(agentIntegrations)).resolves.toHaveLength(1);
  });

  it("creates binding tokens for unbound users without dedup or message body persistence", async () => {
    const seeded = await seedIntegration({ bindUser: false });

    const result = await dispatchFeishuInboundMessage(
      inboundEvent({ body: "do not persist this until bound" }),
      createFeishuInboundDispatcherDbDeps(db),
    );

    expect(result.status).toBe("binding_required");
    if (result.status !== "binding_required") throw new Error("Expected binding_required result");
    expect(result.bindingToken.token).toMatch(/^rudder_feishu_[a-f0-9]{48}$/);
    expect(result.outbound).toMatchObject({
      provider: "feishu",
      externalChatId: "oc_chat",
      externalMessageId: null,
    });
    expect(result.outbound.text).toContain(result.bindingToken.token);
    const tokens = await db.select().from(agentIntegrationBindingTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.tokenHash).not.toBe(result.bindingToken.token);
    expect(tokens[0]?.expiresAt?.getTime()).toBe(result.bindingToken.expiresAt.getTime());
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

  it("auto-binds the installer Feishu identity for an active Rudder org member", async () => {
    const seeded = await seedIntegration({ bindUser: false });
    const binding = await feishuIntegrationUserBindingService(db).bindActiveOrgUserByOpenId({
      orgId: seeded.orgId,
      integrationId: seeded.integrationId,
      userId: seeded.userId,
      externalOpenId: "ou_installer",
    });

    expect(binding).toMatchObject({
      orgId: seeded.orgId,
      integrationId: seeded.integrationId,
      userId: seeded.userId,
      externalOpenId: "ou_installer",
    });

    const result = await dispatchFeishuInboundMessage(
      inboundEvent({ senderOpenId: "ou_installer", senderUnionId: null, messageId: "om_auto_bound" }),
      createFeishuInboundDispatcherDbDeps(db),
    );
    expect(result.status).toBe("accepted");
    await expect(db.select().from(agentIntegrationBindingTokens)).resolves.toHaveLength(0);
    await expect(db.select().from(chatMessages)).resolves.toHaveLength(1);
  });

  it("resolves auto-bound Feishu users by union id when the message open id differs", async () => {
    const seeded = await seedIntegration({ bindUser: false });
    const binding = await feishuIntegrationUserBindingService(db).bindActiveOrgUserByOpenId({
      orgId: seeded.orgId,
      integrationId: seeded.integrationId,
      userId: seeded.userId,
      externalOpenId: "ou_installer",
      externalUnionId: "on_installer",
    });

    expect(binding).toMatchObject({
      orgId: seeded.orgId,
      integrationId: seeded.integrationId,
      userId: seeded.userId,
      externalOpenId: "ou_installer",
      externalUnionId: "on_installer",
    });

    const result = await dispatchFeishuInboundMessage(
      inboundEvent({
        senderOpenId: "ou_message_sender",
        senderUnionId: "on_installer",
        messageId: "om_auto_bound_union",
      }),
      createFeishuInboundDispatcherDbDeps(db),
    );
    expect(result.status).toBe("accepted");
    await expect(db.select().from(agentIntegrationBindingTokens)).resolves.toHaveLength(0);
    await expect(db.select().from(chatMessages)).resolves.toHaveLength(1);
  });

  it("does not auto-bind a Feishu installer identity for a non-member user", async () => {
    const seeded = await seedIntegration({ bindUser: false, member: false });
    const binding = await feishuIntegrationUserBindingService(db).bindActiveOrgUserByOpenId({
      orgId: seeded.orgId,
      integrationId: seeded.integrationId,
      userId: seeded.userId,
      externalOpenId: "ou_installer",
    });

    expect(binding).toBeNull();
    await expect(db.select().from(agentIntegrationUserBindings)).resolves.toHaveLength(0);
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
    const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, result.conversationId));
    expect(conversation?.title).toBe("/issue Fix Feishu inbox");

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
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, result.runId!));
    expect(run?.contextSnapshot).toMatchObject({
      source: "agent_integration",
      provider: "feishu",
      integrationId: seeded.integrationId,
      externalChatId: event.chatId,
      externalChatType: event.chatType,
      externalMessageId: event.messageId,
    });
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
    expect(result.outbound).toMatchObject({
      provider: "feishu",
      externalChatId: event.chatId,
      externalMessageId: null,
      text: `已写入 Rudder Messenger，并开始处理（issue=${result.issueId}, run=${result.runId}）。`,
    });
  });

  it("drives the mock inbound route through DB-backed Messenger issue run and outbound writes", async () => {
    const seeded = await seedIntegration();
    const app = createRouteApp(db, {
      type: "board",
      userId: "board-user",
      orgIds: [seeded.orgId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/orgs/${seeded.orgId}/integrations/feishu/mock-inbound`)
      .send({
        botOpenId: "ou_bot",
        header: { event_id: "event_route_e2e", app_id: "cli_a_feishu_app" },
        event: {
          sender: { sender_id: { open_id: "ou_sender", union_id: "on_sender" } },
          message: {
            message_id: "om_route_e2e",
            chat_id: "oc_chat",
            chat_type: "p2p",
            message_type: "text",
            content: JSON.stringify({ text: "/issue Route Feishu drill\nCreate issue from mock hook." }),
          },
        },
      });

    expect(res.status).toBe(201);
    expect(res.body.normalized).toMatchObject({
      eventId: "event_route_e2e",
      messageId: "om_route_e2e",
      chatId: "oc_chat",
      chatType: "p2p",
      addressedToBot: true,
    });
    expect(res.body.result).toMatchObject({
      status: "accepted",
      conversationId: expect.any(String),
      chatMessageId: expect.any(String),
      issueId: expect.any(String),
      runId: expect.any(String),
    });

    const messages = await db.select().from(chatMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe("/issue Route Feishu drill\nCreate issue from mock hook.");

    const [issue] = await db.select().from(issues).where(eq(issues.id, res.body.result.issueId));
    expect(issue).toMatchObject({
      title: "Route Feishu drill",
      originKind: "agent_integration",
      originId: "feishu:om_route_e2e",
      assigneeAgentId: seeded.agentId,
      createdByUserId: seeded.userId,
    });
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, res.body.result.runId))).resolves.toHaveLength(1);
    const [outbound] = await db.select().from(agentIntegrationOutboundMessages);
    expect(outbound).toMatchObject({
      orgId: seeded.orgId,
      integrationId: seeded.integrationId,
      conversationId: res.body.result.conversationId,
      chatMessageId: res.body.result.chatMessageId,
      issueId: res.body.result.issueId,
      runId: res.body.result.runId,
      externalChatId: "oc_chat",
      status: "pending",
    });
    await expect(db.select().from(agentIntegrationInboundDedup)).resolves.toHaveLength(1);
  }, 15_000);

  it("sends a real outbound binding-required response from long-connection events", async () => {
    const seeded = await seedIntegration({
      bindUser: false,
      credentialValue: JSON.stringify({ appSecret: "feishu-app-secret" }),
    });
    const sent: Array<{ chatId: string; text: string }> = [];
    const sender: FeishuOutboundSender = {
      sendText: async (input) => {
        sent.push({ chatId: input.chatId, text: input.text });
        return { messageId: "om_binding_response" };
      },
    };
    const runtime = feishuIntegrationRuntimeService(db, { sender });

    const result = await runtime.handleEvent(
      {
        id: seeded.integrationId,
        orgId: seeded.orgId,
        agentId: seeded.agentId,
        providerRegion: "feishu_cn",
        appCredentialSecretId: seeded.secretId,
        externalAppId: "cli_a_feishu_app",
        externalBotOpenId: "ou_bot",
      },
      { appSecret: "feishu-app-secret" },
      {
        appId: "cli_a_feishu_app",
        botOpenId: "ou_bot",
        eventId: "event_binding_required",
        messageId: "om_binding_required",
        chatId: "oc_chat",
        chatType: "p2p",
        senderOpenId: "ou_sender",
        senderUnionId: "on_sender",
        body: "hello",
      },
    );

    expect(result.status).toBe("binding_required");
    expect(result.outbound).toMatchObject({
      provider: "feishu",
      externalChatId: "oc_chat",
      externalMessageId: null,
      text: expect.stringContaining("rudder_feishu_"),
    });
    expect(sent).toEqual([
      {
        chatId: "oc_chat",
        text: expect.stringContaining("rudder_feishu_"),
      },
    ]);
    const [outbound] = await db.select().from(agentIntegrationOutboundMessages);
    expect(outbound).toMatchObject({
      orgId: seeded.orgId,
      integrationId: seeded.integrationId,
      externalChatId: "oc_chat",
      externalMessageId: "om_binding_response",
      status: "final",
    });
  });

  it("starts a Feishu long-connection client and dispatches inbound events through the runtime", async () => {
    const seeded = await seedIntegration({
      bindUser: false,
      credentialValue: JSON.stringify({ appSecret: "feishu-app-secret" }),
    });
    const sent: Array<{ chatId: string; text: string }> = [];
    let onEvent: ((payload: Record<string, unknown>) => Promise<void>) | null = null;
    const sender: FeishuOutboundSender = {
      sendText: async (input) => {
        sent.push({ chatId: input.chatId, text: input.text });
        return { messageId: "om_ws_response" };
      },
    };
    const client: FeishuLongConnectionClient = {
      start: async (input) => {
        expect(input.integration.id).toBe(seeded.integrationId);
        expect(input.credential.appSecret).toBe("feishu-app-secret");
        onEvent = input.onEvent;
        return { stop: () => {} };
      },
    };
    const runtime = feishuIntegrationRuntimeService(db, { sender, client });

    await expect(runtime.start()).resolves.toEqual({ started: 1 });
    await onEvent?.({
      appId: "cli_a_feishu_app",
      botOpenId: "ou_bot",
      eventId: "event_ws_binding",
      messageId: "om_ws_binding",
      chatId: "oc_ws",
      chatType: "p2p",
      senderOpenId: "ou_sender",
      body: "hello from websocket",
    });

    expect(sent).toEqual([{ chatId: "oc_ws", text: expect.stringContaining("rudder_feishu_") }]);
    await expect(db.select().from(agentIntegrationBindingTokens)).resolves.toHaveLength(1);
    const [outbound] = await db.select().from(agentIntegrationOutboundMessages);
    expect(outbound).toMatchObject({
      externalChatId: "oc_ws",
      externalMessageId: "om_ws_response",
      status: "final",
    });
  });

  it("dispatches SDK normalized channel messages through the runtime", async () => {
    const seeded = await seedIntegration({
      bindUser: false,
      credentialValue: JSON.stringify({ appId: "cli_a_feishu_app", appSecret: "feishu-app-secret" }),
    });
    await feishuIntegrationUserBindingService(db).bindActiveOrgUserByOpenId({
      orgId: seeded.orgId,
      integrationId: seeded.integrationId,
      userId: seeded.userId,
      externalOpenId: "ou_installer",
    });
    const sent: Array<{ chatId: string; text: string }> = [];
    let onEvent: ((payload: Record<string, unknown>) => Promise<void>) | null = null;
    const sender: FeishuOutboundSender = {
      sendText: async (input) => {
        sent.push({ chatId: input.chatId, text: input.text });
        return { messageId: "om_sdk_response" };
      },
    };
    const client: FeishuLongConnectionClient = {
      start: async (input) => {
        onEvent = input.onEvent;
        await input.onEvent({
          appId: input.integration.externalAppId,
          botOpenId: input.integration.externalBotOpenId,
          eventId: "om_sdk_message",
          messageId: "om_sdk_message",
          chatId: "oc_sdk_chat",
          chatType: "p2p",
          senderOpenId: "ou_installer",
          body: "hello from sdk channel",
          commandBody: "hello from sdk channel",
          addressedToBot: true,
          messageType: "text",
          receivedAt: "2026-06-18T08:00:00.000Z",
        });
        return { stop: () => {} };
      },
    };
    const runtime = feishuIntegrationRuntimeService(db, {
      sender,
      client,
      assistant: {
        streamChatAssistantReply: async () => ({
          outcome: "completed",
          partialBody: "Rudder Feishu reply",
          replyingAgentId: seeded.agentId,
          reply: {
            kind: "message",
            body: "Rudder Feishu reply",
            structuredPayload: null,
            replyingAgentId: seeded.agentId,
          },
        }),
      },
    });

    await expect(runtime.start()).resolves.toEqual({ started: 1 });
    expect(onEvent).toEqual(expect.any(Function));
    expect(sent).toEqual([{ chatId: "oc_sdk_chat", text: "Rudder Feishu reply" }]);
    const messages = await db.select().from(chatMessages);
    expect(messages.map((message) => ({ role: message.role, body: message.body }))).toEqual([
      { role: "user", body: "hello from sdk channel" },
      { role: "assistant", body: "Rudder Feishu reply" },
    ]);
  });

  it("maps SDK normalized channel messages into Rudder Feishu inbound payloads", async () => {
    const rawEvent: RawMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou_sender",
          union_id: "on_sender",
        },
      },
      message: {
        message_id: "om_sdk_message",
        chat_id: "oc_sdk_chat",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello normalized channel" }),
        mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Feishu Agent", tenant_key: "tenant" }],
        parent_id: "om_parent",
        create_time: String(Date.parse("2026-06-18T08:00:00.000Z")),
      },
    };
    const msg = await normalizeLarkMessage(rawEvent, {
      botIdentity: { openId: "ou_bot", name: "Feishu Agent" },
      includeRaw: true,
    }) as NormalizedMessage;
    const payload = feishuRuntimePayloadFromNormalizedMessage(
      msg,
      {
        id: "integration-1",
        orgId: "org-1",
        agentId: "agent-1",
        providerRegion: "feishu_cn",
        appCredentialSecretId: "secret-1",
        externalAppId: "cli_a_feishu_app",
        externalBotOpenId: "ou_bot",
      },
    );

    expect(payload).toMatchObject({
      appId: "cli_a_feishu_app",
      botOpenId: "ou_bot",
      eventId: "om_sdk_message",
      messageId: "om_sdk_message",
      chatId: "oc_sdk_chat",
      chatType: "group",
      senderOpenId: "ou_sender",
      senderUnionId: "on_sender",
      body: "hello normalized channel",
      commandBody: "hello normalized channel",
      addressedToBot: true,
      messageType: "text",
      parentMessageId: "om_parent",
      receivedAt: "2026-06-18T08:00:00.000Z",
    });
  });

  it("contains SDK channel message handling failures per event", async () => {
    const rawEvent: RawMessageEvent = {
      sender: {
        sender_id: {
          open_id: "ou_sender",
        },
      },
      message: {
        message_id: "om_sdk_failure",
        chat_id: "oc_sdk_chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "hello failing handler" }),
        mentions: [],
        create_time: String(Date.parse("2026-06-18T08:00:00.000Z")),
      },
    };
    const msg = await normalizeLarkMessage(rawEvent, {
      botIdentity: { openId: "ou_bot", name: "Feishu Agent" },
      includeRaw: true,
    }) as NormalizedMessage;
    const onEvent = vi.fn(async () => {
      throw new Error("handler failed");
    });

    await expect(dispatchFeishuNormalizedMessage({
      msg,
      integration: {
        id: "integration-1",
        orgId: "org-1",
        agentId: "agent-1",
        providerRegion: "feishu_cn",
        appCredentialSecretId: "secret-1",
        externalAppId: "cli_a_feishu_app",
        externalBotOpenId: "ou_bot",
      },
      onEvent,
    })).resolves.toBe(false);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "om_sdk_failure",
      messageId: "om_sdk_failure",
      body: "hello failing handler",
    }));
  });

  it("sends the accepted assistant reply back to Feishu and patches the pending outbound record", async () => {
    const seeded = await seedIntegration({
      credentialValue: JSON.stringify({ appSecret: "feishu-app-secret" }),
    });
    const sent: Array<{ chatId: string; text: string }> = [];
    const reactions: Array<{ action: "add" | "remove"; messageId: string; emojiType?: string; reactionId?: string }> = [];
    const sender: FeishuOutboundSender = {
      sendText: async (input) => {
        sent.push({ chatId: input.chatId, text: input.text });
        return { messageId: "om_agent_reply" };
      },
      addReaction: async (input) => {
        reactions.push({ action: "add", messageId: input.messageId, emojiType: input.emojiType });
        return { reactionId: "reaction_working" };
      },
      removeReaction: async (input) => {
        reactions.push({ action: "remove", messageId: input.messageId, reactionId: input.reactionId });
      },
    };
    const runtime = feishuIntegrationRuntimeService(db, {
      sender,
      assistant: {
        streamChatAssistantReply: async (input) => {
          expect(input.messages[0]?.attachments).toEqual([]);
          return {
            outcome: "completed",
            partialBody: "Agent accepted this request.",
            replyingAgentId: seeded.agentId,
            reply: {
              kind: "message",
              body: "Agent accepted this request.",
              structuredPayload: null,
              replyingAgentId: seeded.agentId,
            },
          };
        },
      },
    });

    const result = await runtime.handleEvent(
      {
        id: seeded.integrationId,
        orgId: seeded.orgId,
        agentId: seeded.agentId,
        providerRegion: "feishu_cn",
        appCredentialSecretId: seeded.secretId,
        externalAppId: "cli_a_feishu_app",
        externalBotOpenId: "ou_bot",
      },
      { appSecret: "feishu-app-secret" },
      {
        appId: "cli_a_feishu_app",
        botOpenId: "ou_bot",
        eventId: "event_accepted_reply",
        messageId: "om_accepted_reply",
        chatId: "oc_chat",
        chatType: "p2p",
        senderOpenId: "ou_sender",
        senderUnionId: "on_sender",
        body: "please reply",
      },
    );

    expect(result.status).toBe("accepted");
    expect(reactions).toEqual([
      { action: "add", messageId: "om_accepted_reply", emojiType: "OnIt" },
      { action: "remove", messageId: "om_accepted_reply", reactionId: "reaction_working" },
    ]);
    expect(sent).toEqual([{ chatId: "oc_chat", text: "Agent accepted this request." }]);
    const messages = await db.select().from(chatMessages);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const outbounds = await db.select().from(agentIntegrationOutboundMessages);
    expect(outbounds).toHaveLength(1);
    expect(outbounds[0]).toMatchObject({
      orgId: seeded.orgId,
      integrationId: seeded.integrationId,
      externalChatId: "oc_chat",
      externalMessageId: "om_agent_reply",
      status: "final",
    });
    expect(outbounds[0]?.chatMessageId).toBe(messages[1]?.id);
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

  it("sends Feishu reaction requests with the documented OnIt emoji type", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        code: 0,
        data: { reaction_id: "reaction_working" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    try {
      const sender = createFeishuRestOutboundSender();
      const reaction = await sender.addReaction?.({
        region: "feishu_cn",
        appId: "cli_app",
        tenantAccessToken: "tenant-token",
        messageId: "om message/1",
        emojiType: "OnIt",
      });
      await sender.removeReaction?.({
        region: "feishu_cn",
        appId: "cli_app",
        tenantAccessToken: "tenant-token",
        messageId: "om message/1",
        reactionId: reaction?.reactionId ?? "reaction_working",
      });
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://open.feishu.cn/open-apis/im/v1/messages/om%20message%2F1/reactions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual(expect.objectContaining({
      Authorization: "Bearer tenant-token",
      "Content-Type": "application/json",
    }));
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      reaction_type: { emoji_type: "OnIt" },
    });
    expect(calls[1]?.url).toBe("https://open.feishu.cn/open-apis/im/v1/messages/om%20message%2F1/reactions/reaction_working");
    expect(calls[1]?.init.method).toBe("DELETE");
  });
});
