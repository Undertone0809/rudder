import { createLarkChannel, Domain, LoggerLevel, type NormalizedMessage } from "@larksuiteoapi/node-sdk";
import type { AgentRuntimeNetworkSuspension } from "@rudderhq/agent-runtime-utils";
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
import { logger } from "../../../middleware/logger.js";
import type { StorageService } from "../../../storage/types.js";
import { chatAgentRunService } from "../../chat-agent-runs.js";
import { chatAssistantService, ChatAssistantStreamError } from "../../chat-assistant.js";
import {
  claimChatGeneration,
  setActiveChatGenerationId,
} from "../../chat-generation-locks.js";
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

export interface FeishuRuntimeIntegration {
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
  addReaction?(input: {
    region: AgentIntegrationProviderRegion;
    appId: string;
    appSecret?: string | null;
    tenantAccessToken?: string | null;
    messageId: string;
    emojiType: string;
  }): Promise<{ reactionId: string | null }>;
  removeReaction?(input: {
    region: AgentIntegrationProviderRegion;
    appId: string;
    appSecret?: string | null;
    tenantAccessToken?: string | null;
    messageId: string;
    reactionId: string;
  }): Promise<void>;
}

export interface FeishuMarkdownCardPayload {
  config: {
    wide_screen_mode: boolean;
  };
  elements: Array<{
    tag: "div";
    text: {
      tag: "lark_md";
      content: string;
    };
  }>;
}

export interface FeishuLongConnectionClient {
  start(input: {
    integration: FeishuRuntimeIntegration;
    credential: FeishuCredential;
    onEvent: (payload: Record<string, unknown>) => Promise<void>;
  }): Promise<{ stop: () => Promise<void> | void }>;
}

export interface FeishuIntegrationRuntime {
  handleEvent: (
    integration: FeishuRuntimeIntegration,
    credential: FeishuCredential,
    payload: Record<string, unknown>,
  ) => Promise<AgentIntegrationInboundDispatchResult>;
  start(): Promise<{ started: number }>;
  isRunning(integrationId: string): boolean;
  stopIntegration(integrationId: string): Promise<boolean>;
  stop(): Promise<void>;
  sendPendingForRuns(runIds: string[]): Promise<number>;
  recoverNetworkWaitingRun(run: {
    id: string;
    orgId: string;
    agentId: string;
    chatConversationId: string | null;
    executionOwnerToken: string | null;
    contextSnapshot: Record<string, unknown> | null;
  }): Promise<boolean>;
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

export function buildFeishuMarkdownCardPayload(markdown: string): FeishuMarkdownCardPayload {
  return {
    config: {
      wide_screen_mode: true,
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: markdown,
        },
      },
    ],
  };
}

class FeishuMessageSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
    readonly providerMessage: string,
  ) {
    super(message);
    this.name = "FeishuMessageSendError";
  }
}

const FEISHU_CARD_PAYLOAD_REJECTION_CODES = new Set([
  99991663,
]);

function shouldFallbackToText(error: unknown) {
  if (!(error instanceof FeishuMessageSendError)) return false;
  if (error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500) return false;
  if (error.code !== null && FEISHU_CARD_PAYLOAD_REJECTION_CODES.has(error.code)) return true;
  const message = error.providerMessage.toLowerCase();
  return Boolean(
    error.status >= 400
      && /(card|interactive|content|payload|message type|msg_type)/
        .test(message)
      && /(invalid|unsupported|malformed|illegal|bad request|rejected)/
        .test(message),
  );
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
  async function sendMessage(input: {
    region: AgentIntegrationProviderRegion;
    appId: string;
    appSecret?: string | null;
    tenantAccessToken?: string | null;
    chatId: string;
    msgType: "interactive" | "text";
    content: string;
  }) {
    const token = await resolveTenantAccessToken(input);
    const res = await fetch(`${feishuOpenApiBase(input.region)}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        receive_id: input.chatId,
        msg_type: input.msgType,
        content: input.content,
      }),
    });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    const data = json.data && typeof json.data === "object" ? json.data as Record<string, unknown> : null;
    const code = typeof json.code === "number" ? json.code : null;
    if (!res.ok || (code !== null && code !== 0)) {
      const providerMessage = firstString(json.msg) ?? res.statusText;
      throw new FeishuMessageSendError(
        `Failed to send Feishu message: ${providerMessage}`,
        res.status,
        code,
        providerMessage,
      );
    }
    return { messageId: firstString(data?.message_id) };
  }

  return {
    sendText: async (input) => {
      try {
        return await sendMessage({
          ...input,
          msgType: "interactive",
          content: JSON.stringify(buildFeishuMarkdownCardPayload(input.text)),
        });
      } catch (error) {
        if (!shouldFallbackToText(error)) throw error;
        logger.warn({ err: error, chatId: input.chatId }, "Feishu markdown card rejected; falling back to text message");
      }
      return sendMessage({
        ...input,
        msgType: "text",
        content: JSON.stringify({ text: input.text }),
      });
    },
    addReaction: async (input) => {
      const token = await resolveTenantAccessToken(input);
      const res = await fetch(`${feishuOpenApiBase(input.region)}/open-apis/im/v1/messages/${encodeURIComponent(input.messageId)}/reactions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reaction_type: {
            emoji_type: input.emojiType,
          },
        }),
      });
      const json = await res.json().catch(() => ({})) as Record<string, unknown>;
      const data = json.data && typeof json.data === "object" ? json.data as Record<string, unknown> : null;
      const reactionId = firstString(data?.reaction_id)
        ?? firstString((data?.reaction as Record<string, unknown> | undefined)?.reaction_id);
      if (!res.ok || (typeof json.code === "number" && json.code !== 0)) {
        throw new Error(`Failed to add Feishu reaction: ${firstString(json.msg) ?? res.statusText}`);
      }
      return { reactionId };
    },
    removeReaction: async (input) => {
      const token = await resolveTenantAccessToken(input);
      const res = await fetch(`${feishuOpenApiBase(input.region)}/open-apis/im/v1/messages/${encodeURIComponent(input.messageId)}/reactions/${encodeURIComponent(input.reactionId)}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });
      const json = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok || (typeof json.code === "number" && json.code !== 0)) {
        throw new Error(`Failed to remove Feishu reaction: ${firstString(json.msg) ?? res.statusText}`);
      }
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

function larkDomain(region: AgentIntegrationProviderRegion) {
  return region === "lark_global" ? Domain.Lark : Domain.Feishu;
}

export function feishuRuntimePayloadFromNormalizedMessage(
  msg: NormalizedMessage,
  integration: FeishuRuntimeIntegration,
): Record<string, unknown> {
  const rawSenderId = msg.raw && typeof msg.raw === "object" && "sender" in msg.raw
    ? (msg.raw as {
      sender?: {
        sender_id?: {
          union_id?: unknown;
        };
      };
    }).sender?.sender_id
    : null;
  const senderUnionId = typeof rawSenderId?.union_id === "string" && rawSenderId.union_id.trim().length > 0
    ? rawSenderId.union_id
    : null;
  return {
    appId: integration.externalAppId,
    botOpenId: integration.externalBotOpenId,
    eventId: msg.messageId,
    messageId: msg.messageId,
    chatId: msg.chatId,
    chatType: msg.chatType,
    senderOpenId: msg.senderId,
    senderUnionId,
    body: msg.content,
    commandBody: msg.content,
    addressedToBot: msg.chatType === "p2p" || msg.mentionedBot,
    messageType: msg.rawContentType,
    parentMessageId: msg.replyToMessageId ?? msg.rootId ?? null,
    receivedAt: msg.createTime > 0 ? new Date(msg.createTime).toISOString() : undefined,
  };
}

export async function dispatchFeishuNormalizedMessage(input: {
  msg: NormalizedMessage;
  integration: FeishuRuntimeIntegration;
  onEvent: (payload: Record<string, unknown>) => Promise<void>;
}) {
  try {
    await input.onEvent(feishuRuntimePayloadFromNormalizedMessage(input.msg, input.integration));
    return true;
  } catch (err) {
    logger.error({
      err,
      integrationId: input.integration.id,
      appId: input.integration.externalAppId,
      messageId: input.msg.messageId,
    }, "Feishu long-connection event handling failed");
    return false;
  }
}

export function createFeishuLongConnectionClient(): FeishuLongConnectionClient {
  return {
    start: async ({ integration, credential, onEvent }) => {
      const appSecret = credential.appSecret;
      if (!appSecret) {
        throw new Error("Feishu credential secret must include appSecret for long connection");
      }
      const channel = createLarkChannel({
        appId: credential.appId ?? integration.externalAppId,
        appSecret,
        domain: larkDomain(integration.providerRegion),
        source: "rudder/agent-integrations",
        loggerLevel: LoggerLevel.warn,
        includeRawEvent: true,
        policy: {
          dmMode: "open",
          requireMention: true,
          respondToMentionAll: false,
        },
      });
      const unsubscribeMessage = channel.on("message", async (msg) => {
        await dispatchFeishuNormalizedMessage({ msg, integration, onEvent });
      });
      const unsubscribeError = channel.on("error", (err) => {
        logger.error({ err, integrationId: integration.id }, "Feishu long-connection channel error");
      });
      await channel.connect();
      logger.info({
        integrationId: integration.id,
        appId: integration.externalAppId,
      }, "Feishu long-connection channel connected");
      return {
        stop: async () => {
          unsubscribeMessage();
          unsubscribeError();
          await channel.disconnect();
        },
      };
    },
  };
}

export function createDisabledFeishuLongConnectionClient(): FeishuLongConnectionClient {
  return {
    start: async () => {
      logger.info("Feishu long-connection runtime is disabled; skipping channel start");
      return {
        stop: () => {},
      };
    },
  };
}

function bindingRequiredText() {
  return "Rudder received your message, but your Feishu identity is not bound to this organization yet. Open Rudder and bind this Feishu account before continuing.";
}

async function withWorkingReaction<T>(
  sender: FeishuOutboundSender,
  integration: FeishuRuntimeIntegration,
  credential: FeishuCredential,
  event: FeishuInboundMessage,
  fn: () => Promise<T>,
) {
  let reactionId: string | null = null;
  if (sender.addReaction) {
    try {
      const reaction = await sender.addReaction({
        region: integration.providerRegion,
        appId: credential.appId ?? integration.externalAppId,
        appSecret: credential.appSecret,
        tenantAccessToken: credential.tenantAccessToken,
        messageId: event.messageId,
        emojiType: "OnIt",
      });
      reactionId = reaction.reactionId;
    } catch (err) {
      logger.warn({ err, integrationId: integration.id, messageId: event.messageId }, "Failed to add Feishu working reaction");
    }
  }
  try {
    return await fn();
  } finally {
    if (reactionId && sender.removeReaction) {
      try {
        await sender.removeReaction({
          region: integration.providerRegion,
          appId: credential.appId ?? integration.externalAppId,
          appSecret: credential.appSecret,
          tenantAccessToken: credential.tenantAccessToken,
          messageId: event.messageId,
          reactionId,
        });
      } catch (err) {
        logger.warn({ err, integrationId: integration.id, messageId: event.messageId, reactionId }, "Failed to remove Feishu working reaction");
      }
    }
  }
}

function persistableAssistantKind(kind: "message" | "ask_user" | "issue_proposal" | "operation_proposal" | "automation_create") {
  return kind === "automation_create" ? "message" : kind;
}

function asChatMessage(row: Awaited<ReturnType<ReturnType<typeof chatService>["listMessages"]>>[number]) {
  if (!["user", "assistant", "system"].includes(row.role)) {
    throw new Error(`Unsupported chat message role: ${row.role}`);
  }
  if (!["message", "ask_user", "issue_proposal", "operation_proposal", "system_event"].includes(row.kind)) {
    throw new Error(`Unsupported chat message kind: ${row.kind}`);
  }
  if (!["streaming", "completed", "stopped", "failed", "interrupted"].includes(row.status)) {
    throw new Error(`Unsupported chat message status: ${row.status}`);
  }
  return row as ChatMessage;
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
): FeishuIntegrationRuntime {
  const secrets = secretService(db);
  const chats = chatService(db);
  const chatRuns = chatAgentRunService(db);
  const assistant = options.assistant ?? chatAssistantService(db, options.storage);
  const sender = options.sender ?? createFeishuRestOutboundSender();
  const client = options.client ?? createFeishuLongConnectionClient();
  const stops = new Map<string, () => Promise<void> | void>();
  const starting = new Set<string>();

  async function sendAndRecord(input: {
    integration: FeishuRuntimeIntegration;
    credential: FeishuCredential;
    chatId: string;
    text: string;
    conversationId?: string | null;
    chatMessageId?: string | null;
    runId?: string | null;
    issueId?: string | null;
    abortSignal?: AbortSignal | null;
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
      if (input.abortSignal?.aborted) {
        if (record) {
          await db
            .update(agentIntegrationOutboundMessages)
            .set({ status: "error", updatedAt: new Date() })
            .where(eq(agentIntegrationOutboundMessages.id, record.id));
        }
        return null;
      }
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
    activeGeneration: {
      abortController: AbortController;
      generationId: string;
      attemptEpoch?: number;
      ownerToken?: string | null;
      release: () => void;
    },
    resume?: { runId: string; ownerToken: string },
  ) {
    const conversation = await chats.getById(result.conversationId) as ChatConversation | null;
    const userMessage = result.chatMessageId
      ? await chats
        .listMessages(result.conversationId, { includeTranscript: false })
        .then((rows) => rows.find((message) => message.id === result.chatMessageId))
        .then((row) => row ? asChatMessage(row) : null)
      : null;
    if (!conversation || !userMessage) {
      throw new Error("Feishu accepted inbound message is missing its Rudder chat conversation or user message");
    }
    const activeConversation = conversation;

    async function deleteAssistantMessageIfStopped(messageId: string) {
      if (!activeGeneration.abortController.signal.aborted) return false;
      await db
        .delete(chatMessages)
        .where(and(
          eq(chatMessages.id, messageId),
          eq(chatMessages.conversationId, activeConversation.id),
          eq(chatMessages.role, "assistant"),
        ));
      return true;
    }

    let generationTerminalStatus: "completed" | "failed" | "stopped" | "aborted" = "failed";
    let waitingForNetwork = false;
    let assistantMessage: ChatMessage | null = null;
    try {
      let activeRunId: string | null = null;
      const streamed = await assistant.streamChatAssistantReply({
        conversation,
        contextLinks: Array.isArray(conversation.contextLinks) ? conversation.contextLinks : [],
        messages: [userMessage],
        userMessageId: result.chatMessageId,
        stream: false,
        runContext: {
          chatGenerationId: activeGeneration.generationId,
          feishuIntegrationId: integration.id,
          feishuChatId: event.chatId,
          feishuMessageId: event.messageId,
        },
        ...(resume
          ? { resumeRunId: resume.runId, resumeRunOwnerToken: resume.ownerToken }
          : {}),
        abortSignal: activeGeneration.abortController.signal,
        onRunCreated: (runId) => {
          activeRunId = runId;
        },
        onWaitingForNetwork: async (suspension: AgentRuntimeNetworkSuspension) => {
          const marked = await chats.generationProtocol.markWaitingForNetwork({
            orgId: conversation.orgId,
            conversationId: conversation.id,
            generationId: activeGeneration.generationId,
            expectedAttemptEpoch: activeGeneration.attemptEpoch ?? 1,
            suspension: suspension as unknown as Record<string, unknown>,
          });
          if (marked.stopped) {
            generationTerminalStatus = "stopped";
            if (!activeGeneration.abortController.signal.aborted) activeGeneration.abortController.abort();
            return;
          }
          waitingForNetwork = true;
        },
      });
      if (streamed.outcome === "stopped") {
        generationTerminalStatus = "stopped";
        return;
      }
      if (streamed.outcome === "waiting_for_network" || waitingForNetwork) {
        return;
      }
      if (activeGeneration.abortController.signal.aborted) {
        generationTerminalStatus = "stopped";
        return;
      }
      const reply = streamed.reply;
      assistantMessage = await chats.addMessage(conversation.id, {
        orgId: conversation.orgId,
        role: "assistant",
        kind: persistableAssistantKind(reply.kind),
        body: reply.body,
        structuredPayload: null,
        runId: activeRunId,
        replyingAgentId: reply.replyingAgentId ?? integration.agentId,
      }) as ChatMessage;
      if (await deleteAssistantMessageIfStopped(assistantMessage.id)) {
        generationTerminalStatus = "stopped";
        return;
      }
      if (activeGeneration.abortController.signal.aborted) {
        generationTerminalStatus = "stopped";
        return;
      }
      const sent = await sendAndRecord({
        integration,
        credential,
        chatId: event.chatId,
        text: reply.body,
        conversationId: conversation.id,
        chatMessageId: assistantMessage.id,
        runId: activeRunId ?? result.runId,
        issueId: result.issueId,
        abortSignal: activeGeneration.abortController.signal,
      });
      if (!sent && await deleteAssistantMessageIfStopped(assistantMessage.id)) {
        generationTerminalStatus = "stopped";
        return;
      }
      if (activeRunId) {
        await chatRuns.linkAssistantMessage(activeRunId, conversation.id, assistantMessage.id);
      }
      if (await deleteAssistantMessageIfStopped(assistantMessage.id)) {
        generationTerminalStatus = "stopped";
        return;
      }
      generationTerminalStatus = "completed";
    } catch (error) {
      if (activeGeneration.abortController.signal.aborted) {
        if (assistantMessage) {
          await deleteAssistantMessageIfStopped(assistantMessage.id);
        }
        generationTerminalStatus = "stopped";
        return;
      }
      generationTerminalStatus = "failed";
      throw error;
    } finally {
      if (waitingForNetwork) {
        activeGeneration.release();
        return;
      }
      await chats.markGenerationTerminal(activeGeneration.generationId, generationTerminalStatus).catch((error: unknown) => {
        logger.warn({ err: error, generationId: activeGeneration.generationId }, "failed to mark Feishu chat generation terminal");
      });
      activeGeneration.release();
    }
  }

  async function runAcceptedReplyInBackground(
    integration: FeishuRuntimeIntegration,
    credential: FeishuCredential,
    event: FeishuInboundMessage,
    result: Extract<AgentIntegrationInboundDispatchResult, { status: "accepted" }>,
    activeGeneration: {
      abortController: AbortController;
      generationId: string;
      attemptEpoch?: number;
      ownerToken?: string | null;
      release: () => void;
    },
  ) {
    const leaseTimer = activeGeneration.ownerToken
      ? setInterval(() => {
          void chats.renewGenerationControlLease({
            generationId: activeGeneration.generationId,
            attemptEpoch: activeGeneration.attemptEpoch ?? 1,
            ownerToken: activeGeneration.ownerToken!,
          }).catch(() => undefined);
        }, 10_000)
      : null;
    leaseTimer?.unref?.();
    let didEnterReplyCompletion = false;
    try {
      await withWorkingReaction(sender, integration, credential, event, async () => {
        didEnterReplyCompletion = true;
        try {
          await completeAcceptedReply(integration, credential, event, result, activeGeneration);
        } catch (error) {
          activeGeneration.release();
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
      });
    } catch (error) {
      if (!didEnterReplyCompletion) {
        activeGeneration.release();
        const terminalStatus = activeGeneration.abortController.signal.aborted ? "stopped" : "failed";
        await chats.markGenerationTerminal(activeGeneration.generationId, terminalStatus).catch((markError: unknown) => {
          logger.warn({
            err: markError,
            generationId: activeGeneration.generationId,
          }, "failed to mark Feishu chat generation terminal after background reply setup failure");
        });
      }
      if (!activeGeneration.abortController.signal.aborted) {
        logger.error({
          err: error,
          integrationId: integration.id,
          conversationId: result.conversationId,
          chatMessageId: result.chatMessageId,
        }, "Feishu accepted reply background task failed");
      }
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
    }
  }

  async function recoverNetworkWaitingRun(run: {
    id: string;
    orgId: string;
    agentId: string;
    chatConversationId: string | null;
    executionOwnerToken: string | null;
    contextSnapshot: Record<string, unknown> | null;
  }): Promise<boolean> {
    const context = run.contextSnapshot ?? {};
    const integrationId = firstString(context.feishuIntegrationId);
    const conversationId = run.chatConversationId
      ?? firstString(context.conversationId);
    const generationId = firstString(context.chatGenerationId);
    const chatMessageId = firstString(context.userMessageId) ?? firstString(context.messageId);
    const externalChatId = firstString(context.feishuChatId);
    const ownerToken = run.executionOwnerToken;
    if (!integrationId || !conversationId || !generationId || !chatMessageId || !externalChatId || !ownerToken) {
      return false;
    }

    const integrationRow = await db
      .select()
      .from(agentIntegrations)
      .where(and(eq(agentIntegrations.id, integrationId), eq(agentIntegrations.orgId, run.orgId)))
      .then((rows) => rows[0] ?? null);
    if (!integrationRow || integrationRow.provider !== "feishu") return false;
    const secretValue = await secrets.resolveSecretValue(
      integrationRow.orgId,
      integrationRow.appCredentialSecretId,
      "latest",
    );
    const credential = parseFeishuCredential(secretValue);
    const integration: FeishuRuntimeIntegration = {
      id: integrationRow.id,
      orgId: integrationRow.orgId,
      agentId: integrationRow.agentId,
      providerRegion: integrationRow.providerRegion as AgentIntegrationProviderRegion,
      appCredentialSecretId: integrationRow.appCredentialSecretId,
      externalAppId: integrationRow.externalAppId,
      externalBotOpenId: integrationRow.externalBotOpenId,
    };
    const generation = await chats.getLatestGeneration(conversationId);
    if (!generation || generation.id !== generationId || generation.status !== "waiting_for_network") return false;

    const abortController = new AbortController();
    const release = claimChatGeneration(conversationId, abortController, generationId);
    if (!release) return true;
    setActiveChatGenerationId(conversationId, generationId);
    const resumed = await chats.generationProtocol.markNetworkResumed({
      orgId: run.orgId,
      conversationId,
      generationId,
      expectedAttemptEpoch: generation.attemptEpoch,
    });
    const event = {
      provider: "feishu" as const,
      eventId: `network-resume:${run.id}`,
      appId: integration.externalAppId,
      botOpenId: integration.externalBotOpenId,
      chatId: externalChatId,
      chatType: "p2p" as const,
      messageId: firstString(context.feishuMessageId) ?? chatMessageId,
      senderOpenId: "rudder-network-recovery",
      senderUnionId: null,
      body: "",
      commandBody: "",
      addressedToBot: true,
      messageType: "text",
    } satisfies FeishuInboundMessage;
    const result = {
      status: "accepted" as const,
      conversationId,
      chatMessageId,
      issueId: firstString(context.issueId),
      runId: run.id,
      outbound: {
        provider: "feishu" as const,
        externalChatId,
        externalMessageId: null,
        text: "",
      },
    } satisfies Extract<AgentIntegrationInboundDispatchResult, { status: "accepted" }>;
    try {
      await completeAcceptedReply(
        integration,
        credential,
        event,
        result,
        {
          abortController,
          generationId,
          attemptEpoch: resumed.attemptEpoch,
          ownerToken: resumed.controlOwnerToken,
          release,
        },
        { runId: run.id, ownerToken },
      );
    } catch (error) {
      logger.warn({ err: error, runId: run.id }, "Feishu network-wait recovery failed");
      release();
    }
    return true;
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
        text: result.outbound?.text ?? bindingRequiredText(),
      });
      return result;
    }
    if (result.status === "quick_command") {
      await sendAndRecord({
        integration,
        credential,
        chatId: event.chatId,
        text: result.outbound.text,
        conversationId: result.conversationId,
        chatMessageId: result.chatMessageId,
        runId: result.runId,
      });
      return result;
    }
    if (result.status === "accepted") {
      if (result.outbound.text.startsWith("New daily session started.")) {
        await sendAndRecord({
          integration,
          credential,
          chatId: event.chatId,
          text: "New daily session started.",
          conversationId: result.conversationId,
          chatMessageId: null,
          runId: null,
        });
      }
      if (result.replyInProgress) {
        return result;
      }
      const conversation = await chats.getById(result.conversationId) as ChatConversation | null;
      if (!conversation) {
        throw new Error("Feishu accepted inbound message is missing its Rudder chat conversation");
      }
      const abortController = new AbortController();
      const releaseGeneration = claimChatGeneration(conversation.id, abortController, null);
      if (!releaseGeneration) {
        throw new Error("A Feishu chat reply is already being generated for this conversation");
      }
      let generation: Awaited<ReturnType<typeof chats.createGeneration>>;
      try {
        generation = await chats.createGeneration(conversation.orgId, conversation.id);
      } catch (error) {
        releaseGeneration();
        throw error;
      }
      setActiveChatGenerationId(conversation.id, generation.id);
      void runAcceptedReplyInBackground(integration, credential, event, result, {
        abortController,
        generationId: generation.id,
        attemptEpoch: generation.attemptEpoch,
        ownerToken: generation.controlOwnerToken,
        release: releaseGeneration,
      });
    }
    return result;
  }

  return {
    handleEvent,
    isRunning: (integrationId) => stops.has(integrationId),
    stopIntegration: async (integrationId) => {
      const stop = stops.get(integrationId);
      if (!stop) return false;
      stops.delete(integrationId);
      await Promise.resolve(stop());
      return true;
    },
    start: async () => {
      const integrations = await loadRuntimeIntegrations(db);
      let started = 0;
      for (const integration of integrations) {
        if (stops.has(integration.id) || starting.has(integration.id)) continue;
        starting.add(integration.id);
        try {
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
          started += 1;
        } catch (err) {
          logger.error({
            err,
            integrationId: integration.id,
            orgId: integration.orgId,
            appId: integration.externalAppId,
          }, "Feishu long-connection integration startup failed");
        } finally {
          starting.delete(integration.id);
        }
      }
      return { started };
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
    recoverNetworkWaitingRun,
  };
}
