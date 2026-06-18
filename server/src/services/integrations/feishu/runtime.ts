import type { Db } from "@rudderhq/db";
import {
  agentIntegrationOutboundMessages,
  agentIntegrations,
  chatMessages,
} from "@rudderhq/db";
import type {
  AgentIntegrationProviderRegion,
  ChatConversation,
  ChatMessage,
} from "@rudderhq/shared";
import { and, eq, inArray } from "drizzle-orm";
import WebSocket from "ws";
import { logger } from "../../../middleware/logger.js";
import type { StorageService } from "../../../storage/types.js";
import { chatAssistantService, ChatAssistantStreamError } from "../../chat-assistant.js";
import { chatAgentRunService } from "../../chat-agent-runs.js";
import { chatService } from "../../chats.js";
import { secretService } from "../../secrets.js";
import { createFeishuInboundDispatcherDbDeps } from "./inbound-dispatcher-db.js";
import {
  dispatchFeishuInboundMessage,
  type AgentIntegrationInboundDispatchResult,
  type FeishuInboundMessage,
} from "./inbound-dispatcher.js";
import { normalizeMockFeishuInboundEvent } from "./inbound-normalizer.js";

interface FeishuCredential {
  appId?: string | null;
  appSecret?: string | null;
  verificationToken?: string | null;
  encryptKey?: string | null;
  tenantAccessToken?: string | null;
  websocketUrl?: string | null;
}

interface FeishuRuntimeIntegration {
  id: string;
  orgId: string;
  agentId: string;
  providerRegion: AgentIntegrationProviderRegion;
  appCredentialSecretId: string;
  externalAppId: string;
  externalBotOpenId: string | null;
}

export interface FeishuOutboundSender {
  sendText(input: {
    region: AgentIntegrationProviderRegion;
    appId: string;
    appSecret?: string | null;
    tenantAccessToken?: string | null;
    chatId: string;
    text: string;
  }): Promise<{ messageId: string | null }>;
}

export interface FeishuLongConnectionClient {
  start(input: {
    integration: FeishuRuntimeIntegration;
    credential: FeishuCredential;
    onEvent: (payload: Record<string, unknown>) => Promise<void>;
  }): Promise<{ stop: () => Promise<void> | void }>;
}

type FeishuAssistantRunner = Pick<ReturnType<typeof chatAssistantService>, "streamChatAssistantReply">;

function firstString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseFeishuCredential(value: string): FeishuCredential {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        appId: firstString(record.appId) ?? firstString(record.app_id),
        appSecret: firstString(record.appSecret) ?? firstString(record.app_secret),
        verificationToken: firstString(record.verificationToken) ?? firstString(record.verification_token),
        encryptKey: firstString(record.encryptKey) ?? firstString(record.encrypt_key),
        tenantAccessToken: firstString(record.tenantAccessToken) ?? firstString(record.tenant_access_token),
        websocketUrl: firstString(record.websocketUrl) ?? firstString(record.websocket_url),
      };
    }
  } catch {
    // Plain strings are legacy callback verification tokens and cannot drive long connection.
  }
  return { verificationToken: firstString(value) };
}

function feishuOpenApiBase(region: AgentIntegrationProviderRegion) {
  return region === "lark_global" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

async function resolveTenantAccessToken(input: {
  region: AgentIntegrationProviderRegion;
  appId: string;
  appSecret?: string | null;
  tenantAccessToken?: string | null;
}) {
  if (input.tenantAccessToken) return input.tenantAccessToken;
  if (!input.appSecret) {
    throw new Error("Feishu credential secret must include appSecret or tenantAccessToken for outbound send");
  }
  const res = await fetch(`${feishuOpenApiBase(input.region)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: input.appId,
      app_secret: input.appSecret,
    }),
  });
  const json = await res.json() as Record<string, unknown>;
  const token = firstString(json.tenant_access_token);
  if (!res.ok || !token) {
    throw new Error(`Failed to resolve Feishu tenant access token: ${firstString(json.msg) ?? res.statusText}`);
  }
  return token;
}

export function createFeishuRestOutboundSender(): FeishuOutboundSender {
  return {
    sendText: async (input) => {
      const token = await resolveTenantAccessToken(input);
      const res = await fetch(`${feishuOpenApiBase(input.region)}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: input.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: input.text }),
        }),
      });
      const json = await res.json() as Record<string, unknown>;
      const data = json.data && typeof json.data === "object" ? json.data as Record<string, unknown> : null;
      if (!res.ok || (typeof json.code === "number" && json.code !== 0)) {
        throw new Error(`Failed to send Feishu message: ${firstString(json.msg) ?? res.statusText}`);
      }
      return { messageId: firstString(data?.message_id) };
    },
  };
}

function normalizeLongConnectionPayload(payload: Record<string, unknown>, integration: FeishuRuntimeIntegration) {
  const event = normalizeMockFeishuInboundEvent(payload);
  return {
    ...event,
    appId: event.appId || integration.externalAppId,
    botOpenId: event.botOpenId ?? integration.externalBotOpenId,
  } satisfies FeishuInboundMessage;
}

function websocketUrl(region: AgentIntegrationProviderRegion, credential: FeishuCredential) {
  if (credential.websocketUrl) return credential.websocketUrl;
  const base = region === "lark_global"
    ? "wss://open.larksuite.com/open-apis/im/v1/events"
    : "wss://open.feishu.cn/open-apis/im/v1/events";
  return base;
}

export function createFeishuLongConnectionClient(): FeishuLongConnectionClient {
  return {
    start: async ({ integration, credential, onEvent }) => {
      const token = await resolveTenantAccessToken({
        region: integration.providerRegion,
        appId: credential.appId ?? integration.externalAppId,
        appSecret: credential.appSecret,
        tenantAccessToken: credential.tenantAccessToken,
      });
      const ws = new WebSocket(websocketUrl(integration.providerRegion, credential), {
        headers: { Authorization: `Bearer ${token}` },
      });
      ws.on("message", (data) => {
        const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        void Promise.resolve()
          .then(() => JSON.parse(raw) as Record<string, unknown>)
          .then(onEvent)
          .catch((err) => {
            logger.error({ err, integrationId: integration.id }, "Feishu long-connection event handling failed");
          });
      });
      ws.on("error", (err) => {
        logger.error({ err, integrationId: integration.id }, "Feishu long-connection socket error");
      });
      return {
        stop: () => {
          ws.close();
        },
      };
    },
  };
}

function bindingRequiredText() {
  return "Rudder received your message, but your Feishu identity is not bound to this organization yet. Open Rudder and bind this Feishu account before continuing.";
}

function persistableAssistantKind(kind: "message" | "ask_user" | "issue_proposal" | "operation_proposal" | "automation_create") {
  return kind === "automation_create" ? "message" : kind;
}

async function loadRuntimeIntegrations(db: Db) {
  return db
    .select()
    .from(agentIntegrations)
    .where(
      and(
        eq(agentIntegrations.provider, "feishu"),
        eq(agentIntegrations.transport, "long_connection"),
        eq(agentIntegrations.status, "active"),
      ),
    )
    .then((rows) => rows.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      agentId: row.agentId,
      providerRegion: row.providerRegion as AgentIntegrationProviderRegion,
      appCredentialSecretId: row.appCredentialSecretId,
      externalAppId: row.externalAppId,
      externalBotOpenId: row.externalBotOpenId,
    })));
}

export function feishuIntegrationRuntimeService(
  db: Db,
  options: {
    storage?: StorageService;
    sender?: FeishuOutboundSender;
    client?: FeishuLongConnectionClient;
    assistant?: FeishuAssistantRunner;
  } = {},
) {
  const secrets = secretService(db);
  const chats = chatService(db);
  const chatRuns = chatAgentRunService(db);
  const assistant = options.assistant ?? chatAssistantService(db, options.storage);
  const sender = options.sender ?? createFeishuRestOutboundSender();
  const client = options.client ?? createFeishuLongConnectionClient();
  const stops = new Map<string, () => Promise<void> | void>();

  async function sendAndRecord(input: {
    integration: FeishuRuntimeIntegration;
    credential: FeishuCredential;
    chatId: string;
    text: string;
    conversationId?: string | null;
    chatMessageId?: string | null;
    runId?: string | null;
    issueId?: string | null;
  }) {
    const [record] = await db
      .insert(agentIntegrationOutboundMessages)
      .values({
        orgId: input.integration.orgId,
        integrationId: input.integration.id,
        conversationId: input.conversationId ?? null,
        chatMessageId: input.chatMessageId ?? null,
        runId: input.runId ?? null,
        issueId: input.issueId ?? null,
        externalChatId: input.chatId,
        status: "pending",
      })
      .returning();
    try {
      const sent = await sender.sendText({
        region: input.integration.providerRegion,
        appId: input.credential.appId ?? input.integration.externalAppId,
        appSecret: input.credential.appSecret,
        tenantAccessToken: input.credential.tenantAccessToken,
        chatId: input.chatId,
        text: input.text,
      });
      if (record) {
        await db
          .update(agentIntegrationOutboundMessages)
          .set({
            externalMessageId: sent.messageId,
            status: "final",
            lastPatchedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(agentIntegrationOutboundMessages.id, record.id));
      }
      return sent;
    } catch (error) {
      if (record) {
        await db
          .update(agentIntegrationOutboundMessages)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(agentIntegrationOutboundMessages.id, record.id));
      }
      throw error;
    }
  }

  async function completeAcceptedReply(
    integration: FeishuRuntimeIntegration,
    credential: FeishuCredential,
    event: FeishuInboundMessage,
    result: Extract<AgentIntegrationInboundDispatchResult, { status: "accepted" }>,
  ) {
    const conversation = await chats.getById(result.conversationId) as ChatConversation | null;
    const userMessage = result.chatMessageId
      ? await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.id, result.chatMessageId))
        .then((rows) => rows[0] as ChatMessage | undefined)
      : null;
    if (!conversation || !userMessage) {
      throw new Error("Feishu accepted inbound message is missing its Rudder chat conversation or user message");
    }

    let activeRunId: string | null = null;
    const streamed = await assistant.streamChatAssistantReply({
      conversation,
      contextLinks: Array.isArray(conversation.contextLinks) ? conversation.contextLinks : [],
      messages: [userMessage],
      userMessageId: result.chatMessageId,
      stream: false,
      onRunCreated: (runId) => {
        activeRunId = runId;
      },
    });
    if (streamed.outcome !== "completed") {
      throw new Error("Feishu chat assistant reply stopped before completion");
    }
    const reply = streamed.reply;
    const assistantMessage = await chats.addMessage(conversation.id, {
      orgId: conversation.orgId,
      role: "assistant",
      kind: persistableAssistantKind(reply.kind),
      body: reply.body,
      structuredPayload: null,
      runId: activeRunId,
      replyingAgentId: reply.replyingAgentId ?? integration.agentId,
    }) as ChatMessage;
    if (activeRunId) {
      await chatRuns.linkAssistantMessage(activeRunId, conversation.id, assistantMessage.id);
    }
    await sendAndRecord({
      integration,
      credential,
      chatId: event.chatId,
      text: reply.body,
      conversationId: conversation.id,
      chatMessageId: assistantMessage.id,
      runId: activeRunId ?? result.runId,
      issueId: result.issueId,
    });
  }

  async function handleEvent(
    integration: FeishuRuntimeIntegration,
    credential: FeishuCredential,
    payload: Record<string, unknown>,
  ) {
    const event = normalizeLongConnectionPayload(payload, integration);
    const result = await dispatchFeishuInboundMessage(
      event,
      createFeishuInboundDispatcherDbDeps(db, {
        orgId: integration.orgId,
        enqueueAgentRun: false,
        createOutboundPlaceholder: false,
      }),
    );
    if (result.status === "binding_required") {
      await sendAndRecord({
        integration,
        credential,
        chatId: event.chatId,
        text: bindingRequiredText(),
      });
      return result;
    }
    if (result.status === "accepted") {
      try {
        await completeAcceptedReply(integration, credential, event, result);
      } catch (error) {
        const body = error instanceof ChatAssistantStreamError && error.partialBody
          ? error.partialBody
          : "Rudder accepted your message, but the agent reply failed before a final response was produced.";
        await sendAndRecord({
          integration,
          credential,
          chatId: event.chatId,
          text: body,
          conversationId: result.conversationId,
          chatMessageId: result.chatMessageId,
          runId: result.runId,
          issueId: result.issueId,
        });
        throw error;
      }
    }
    return result;
  }

  return {
    handleEvent,
    start: async () => {
      const integrations = await loadRuntimeIntegrations(db);
      for (const integration of integrations) {
        if (stops.has(integration.id)) continue;
        const secretValue = await secrets.resolveSecretValue(
          integration.orgId,
          integration.appCredentialSecretId,
          "latest",
        );
        const credential = parseFeishuCredential(secretValue);
        const runner = await client.start({
          integration,
          credential,
          onEvent: async (payload) => {
            await handleEvent(integration, credential, payload);
          },
        });
        stops.set(integration.id, runner.stop);
      }
      return { started: integrations.length };
    },
    stop: async () => {
      const currentStops = [...stops.values()];
      stops.clear();
      await Promise.all(currentStops.map((stop) => Promise.resolve(stop())));
    },
    sendPendingForRuns: async (runIds: string[]) => {
      if (runIds.length === 0) return 0;
      const rows = await db
        .select({
          outbound: agentIntegrationOutboundMessages,
          integration: agentIntegrations,
          message: chatMessages,
        })
        .from(agentIntegrationOutboundMessages)
        .innerJoin(agentIntegrations, eq(agentIntegrationOutboundMessages.integrationId, agentIntegrations.id))
        .innerJoin(chatMessages, eq(agentIntegrationOutboundMessages.chatMessageId, chatMessages.id))
        .where(
          and(
            inArray(agentIntegrationOutboundMessages.runId, runIds),
            eq(agentIntegrationOutboundMessages.status, "pending"),
          ),
        );
      let sent = 0;
      for (const row of rows) {
        const secretValue = await secrets.resolveSecretValue(
          row.integration.orgId,
          row.integration.appCredentialSecretId,
          "latest",
        );
        const credential = parseFeishuCredential(secretValue);
        await sendAndRecord({
          integration: {
            id: row.integration.id,
            orgId: row.integration.orgId,
            agentId: row.integration.agentId,
            providerRegion: row.integration.providerRegion as AgentIntegrationProviderRegion,
            appCredentialSecretId: row.integration.appCredentialSecretId,
            externalAppId: row.integration.externalAppId,
            externalBotOpenId: row.integration.externalBotOpenId,
          },
          credential,
          chatId: row.outbound.externalChatId,
          text: row.message.body,
          conversationId: row.outbound.conversationId,
          chatMessageId: row.outbound.chatMessageId,
          runId: row.outbound.runId,
          issueId: row.outbound.issueId,
        });
        sent += 1;
      }
      return sent;
    },
  };
}
