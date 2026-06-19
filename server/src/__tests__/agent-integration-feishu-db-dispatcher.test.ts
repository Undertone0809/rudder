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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { integrationRoutes } from "../routes/integrations.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { feishuCallbackCredentialService } from "../services/integrations/feishu/callback-credentials.js";
import { createFeishuInboundDispatcherDbDeps } from "../services/integrations/feishu/inbound-dispatcher-db.js";
import {
  dispatchFeishuInboundMessage,
  type FeishuInboundMessage,
} from "../services/integrations/feishu/inbound-dispatcher.js";
import {
  feishuIntegrationRuntimeService,
  type FeishuLongConnectionClient,
  type FeishuOutboundSender,
} from "../services/integrations/feishu/runtime.js";

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
  });

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

    expect(result).toEqual({ status: "binding_required" });
    expect(sent).toEqual([
      {
        chatId: "oc_chat",
        text: expect.stringContaining("not bound"),
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

    expect(sent).toEqual([{ chatId: "oc_ws", text: expect.stringContaining("not bound") }]);
    await expect(db.select().from(agentIntegrationBindingTokens)).resolves.toHaveLength(1);
    const [outbound] = await db.select().from(agentIntegrationOutboundMessages);
    expect(outbound).toMatchObject({
      externalChatId: "oc_ws",
      externalMessageId: "om_ws_response",
      status: "final",
    });
  });

  it("sends the accepted assistant reply back to Feishu and patches the pending outbound record", async () => {
    const seeded = await seedIntegration({
      credentialValue: JSON.stringify({ appSecret: "feishu-app-secret" }),
    });
    const sent: Array<{ chatId: string; text: string }> = [];
    const sender: FeishuOutboundSender = {
      sendText: async (input) => {
        sent.push({ chatId: input.chatId, text: input.text });
        return { messageId: "om_agent_reply" };
      },
    };
    const runtime = feishuIntegrationRuntimeService(db, {
      sender,
      assistant: {
        streamChatAssistantReply: async () => {
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
});
