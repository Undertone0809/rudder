import type { Db } from "@rudderhq/db";
import {
  agentIntegrationBindingTokens,
  agentIntegrationChatBindings,
  agentIntegrationInboundAudit,
  agentIntegrationInboundDedup,
  agentIntegrationOutboundMessages,
  agentIntegrationUserBindings,
  agentIntegrations,
  agents,
  chatConversations,
  chatGenerations,
  chatMessages,
  organizationMemberships,
} from "@rudderhq/db";
import { formatMessengerTitle } from "@rudderhq/shared";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { findServerAdapter } from "../../../agent-runtimes/registry.js";
import { chatAgentRunService } from "../../chat-agent-runs.js";
import { cancelActiveChatGeneration, getActiveChatGeneration } from "../../chat-generation-locks.js";
import { chatTitleGenerationService } from "../../chat-title-generation.js";
import { chatService } from "../../chats.js";
import { issueService } from "../../issues.js";
import { isPostgresError } from "../../postgres-errors.js";
import { productIntelligenceService, type ProductIntelligenceExecuteInput } from "../../product-intelligence.js";
import {
  executeAdapterWithModelFallbacks,
  sanitizeUntrustedRuntimeConfig,
} from "../../runtime-kernel/model-fallback.js";
import { secretService } from "../../secrets.js";
import { runtimeResultText } from "../../title-generation.js";
import type {
  AgentIntegrationInboundDispatcherDeps,
  FeishuInboundMessage,
  ResolvedAgentIntegration,
} from "./inbound-dispatcher.js";

const BINDING_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_DAILY_SESSION_ROLLOVER_HOURS = 24;
const DAILY_SESSION_STARTED_TEXT = "New daily session started.";

function createBindingToken() {
  return `rudder_feishu_${randomBytes(24).toString("hex")}`;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function integrationStatus(value: string): ResolvedAgentIntegration["status"] {
  if (value === "active" || value === "revoked" || value === "error") return value;
  return "error";
}

function chatTitle(event: FeishuInboundMessage) {
  return formatMessengerTitle(event.body) ?? "New chat";
}

function feishuQuickCommandMessage(command: "new" | "stop", event: FeishuInboundMessage, details: Record<string, unknown> = {}) {
  return {
    source: "agent_integration",
    provider: event.provider,
    command,
    integrationId: details.integrationId,
    externalChatId: event.chatId,
    externalChatType: event.chatType,
    externalMessageId: event.messageId,
    externalEventId: event.eventId,
    externalSenderOpenId: event.senderOpenId,
    externalSenderUnionId: event.senderUnionId,
    externalParentMessageId: event.parentMessageId ?? null,
    ...details,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function readPositiveNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function feishuSettings(integration: { settings?: unknown }) {
  const settings = asRecord(integration.settings);
  const feishu = asRecord(settings.feishu);
  return {
    dailySessionRolloverEnabled: readBoolean(feishu.dailySessionRolloverEnabled, true),
    dailySessionRolloverHours: Math.min(168, Math.max(1, Math.floor(readPositiveNumber(
      feishu.dailySessionRolloverHours,
      DEFAULT_DAILY_SESSION_ROLLOVER_HOURS,
    )))),
    dailySessionRolloverNotifyFeishu: readBoolean(feishu.dailySessionRolloverNotifyFeishu, true),
  };
}

function hasActiveGeneration(conversationId: string) {
  return Boolean(getActiveChatGeneration(conversationId));
}

async function hasPersistedActiveGeneration(db: Db, conversationId: string) {
  if (hasActiveGeneration(conversationId)) return true;
  const row = await db
    .select({ id: chatGenerations.id })
    .from(chatGenerations)
    .where(
      and(
        eq(chatGenerations.conversationId, conversationId),
        inArray(chatGenerations.status, ["active", "tool_busy", "closing"]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

async function buildDeterministicSessionSummary(db: Db, conversationId: string) {
  const messages = await db
    .select({
      role: chatMessages.role,
      body: chatMessages.body,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(asc(chatMessages.createdAt))
    .limit(8);
  const userMessages = messages.filter((message) => message.role === "user");
  const first = userMessages[0]?.body?.trim() || messages[0]?.body?.trim() || null;
  const latest = userMessages.at(-1)?.body?.trim() || messages.at(-1)?.body?.trim() || null;
  return {
    source: "deterministic",
    messageCount: messages.length,
    summary: first && latest && first !== latest
      ? `Previous Feishu session started with: ${first}\nLatest user message: ${latest}`
      : first
        ? `Previous Feishu session: ${first}`
        : null,
  };
}

async function buildSmartSessionSummary(input: {
  db: Db;
  productIntelligence: { execute(input: ProductIntelligenceExecuteInput): Promise<unknown> };
  orgId: string;
  conversationId: string;
}) {
  const messages = await input.db
    .select({
      role: chatMessages.role,
      body: chatMessages.body,
    })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, input.conversationId))
    .orderBy(asc(chatMessages.createdAt))
    .limit(40);
  const transcript = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role}: ${message.body}`)
    .join("\n\n")
    .trim();
  if (!transcript) return null;
  const result = await input.productIntelligence.execute({
    orgId: input.orgId,
    purpose: "reasoning",
    feature: "feishu_daily_session_summary",
    prompt: [
      "Summarize this previous Feishu work session for the next Rudder session.",
      "Return 3-6 concise bullets. Preserve decisions, open loops, and user preferences.",
      "Do not invent facts.",
      "",
      transcript,
    ].join("\n"),
  });
  const summary = runtimeResultText(result).trim();
  return summary ? { source: "smart_intelligence", messageCount: messages.length, summary } : null;
}

async function buildAgentRuntimeSessionSummary(input: {
  db: Db;
  orgId: string;
  agentId: string;
  conversationId: string;
}) {
  const agent = await input.db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, input.orgId), eq(agents.id, input.agentId)))
    .then((rows) => rows[0] ?? null);
  if (!agent) return null;
  const adapter = findServerAdapter(agent.agentRuntimeType);
  if (!adapter) return null;
  const messages = await input.db
    .select({
      role: chatMessages.role,
      body: chatMessages.body,
    })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, input.conversationId))
    .orderBy(asc(chatMessages.createdAt))
    .limit(40);
  const transcript = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role}: ${message.body}`)
    .join("\n\n")
    .trim();
  if (!transcript) return null;
  const secrets = secretService(input.db);
  const { config } = await secrets.resolveAdapterConfigForRuntime(input.orgId, agent.agentRuntimeConfig ?? {});
  const prompt = [
    "Summarize this previous Feishu work session for the next Rudder session.",
    "Return 3-6 concise bullets. Preserve decisions, open loops, and user preferences.",
    "Do not invent facts.",
    "",
    transcript,
  ].join("\n");
  const runtimeConfig = sanitizeUntrustedRuntimeConfig({
    ...config,
    promptTemplate: prompt,
  });
  const result = await executeAdapterWithModelFallbacks(adapter, {
    runId: `feishu-session-summary-${randomUUID()}`,
    agent: {
      id: agent.id,
      orgId: input.orgId,
      name: agent.name,
      agentRuntimeType: agent.agentRuntimeType,
      agentRuntimeConfig: runtimeConfig,
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: runtimeConfig,
    context: {
      chatPrompt: prompt,
      rudderScene: "feishu_daily_session_summary",
      chatConversationId: input.conversationId,
    },
    onLog: async () => {},
  }, {
    resolveAdapter: findServerAdapter,
  });
  const summary = runtimeResultText(result).trim();
  return summary ? { source: "agent_runtime", messageCount: messages.length, summary } : null;
}

async function switchFeishuSession(input: {
  db: Db;
  integration: ResolvedAgentIntegration & { settings?: unknown };
  userId: string | null;
  event: FeishuInboundMessage;
  previousConversationId: string;
  reason: "manual_new" | "daily_rollover";
  notifyFeishu: boolean;
  includeSummary: boolean;
  productIntelligence: { execute(input: ProductIntelligenceExecuteInput): Promise<unknown> };
}) {
  let summary = null;
  if (input.includeSummary) {
    try {
      summary = await buildSmartSessionSummary({
        db: input.db,
        productIntelligence: input.productIntelligence,
        orgId: input.integration.orgId,
        conversationId: input.previousConversationId,
      });
    } catch {
      summary = null;
    }
    if (!summary) {
      try {
        summary = await buildAgentRuntimeSessionSummary({
          db: input.db,
          orgId: input.integration.orgId,
          agentId: input.integration.agentId,
          conversationId: input.previousConversationId,
        });
      } catch {
        summary = null;
      }
    }
    summary ??= await buildDeterministicSessionSummary(input.db, input.previousConversationId);
  }
  const nextConversation = await input.db.transaction(async (tx) => {
    const now = new Date();
    const [lockedBinding] = await tx
      .update(agentIntegrationChatBindings)
      .set({ updatedAt: now })
      .where(
        and(
          eq(agentIntegrationChatBindings.orgId, input.integration.orgId),
          eq(agentIntegrationChatBindings.integrationId, input.integration.id),
          eq(agentIntegrationChatBindings.externalChatId, input.event.chatId),
        ),
      )
      .returning({
        id: agentIntegrationChatBindings.id,
        conversationId: agentIntegrationChatBindings.conversationId,
      });
    if (!lockedBinding) throw new Error("Failed to lock Feishu chat binding for session switch");
    if (lockedBinding.conversationId !== input.previousConversationId) {
      return { id: lockedBinding.conversationId, raced: true };
    }

    const created = await createFeishuChatConversation(input.db, tx as unknown as Db, {
      orgId: input.integration.orgId,
      agentId: input.integration.agentId,
      userId: input.userId,
      provider: input.integration.provider,
      initialMessage: {
        role: "system",
        kind: "system_event",
        status: "completed",
        body: input.reason === "daily_rollover" ? DAILY_SESSION_STARTED_TEXT : "New Feishu session started.",
        structuredPayload: {
          eventType: "agent_integration_session_started",
          ...feishuQuickCommandMessage("new", input.event, {
            integrationId: input.integration.id,
            previousConversationId: input.previousConversationId,
            reason: input.reason,
            notifyFeishu: input.notifyFeishu,
            summary,
          }),
        },
      },
    });
    const conversation = created.conversation;

    await tx.insert(chatMessages).values({
      orgId: input.integration.orgId,
      conversationId: input.previousConversationId,
      role: "system",
      kind: "system_event",
      body: input.reason === "daily_rollover" ? DAILY_SESSION_STARTED_TEXT : "New Feishu session started.",
      structuredPayload: feishuQuickCommandMessage("new", input.event, {
        integrationId: input.integration.id,
        previousConversationId: input.previousConversationId,
        nextConversationId: conversation.id,
        reason: input.reason,
        notifyFeishu: input.notifyFeishu,
        summary,
      }),
    });

    const [updatedBinding] = await tx
      .update(agentIntegrationChatBindings)
      .set({
        conversationId: conversation.id,
        externalChatType: input.event.chatType,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(agentIntegrationChatBindings.orgId, input.integration.orgId),
          eq(agentIntegrationChatBindings.id, lockedBinding.id),
          eq(agentIntegrationChatBindings.conversationId, input.previousConversationId),
        ),
      )
      .returning({ conversationId: agentIntegrationChatBindings.conversationId });
    if (!updatedBinding) throw new Error("Failed to switch Feishu chat binding");
    return conversation;
  });
  return nextConversation;
}

async function createFeishuChatConversation(
  db: Db,
  executor: Db,
  input: {
    orgId: string;
    agentId: string;
    userId: string | null;
    provider: string;
    title?: string;
    initialMessage: {
      role: "user" | "system";
      kind: "message" | "system_event";
      status: "completed";
      body: string;
      structuredPayload: Record<string, unknown>;
    };
  },
) {
  return chatService(db).createWithInitialMessage(input.orgId, {
      title: input.title ?? "New chat",
      summary: null,
      preferredAgentId: input.agentId,
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: input.userId,
      contextLinks: [{ entityType: "agent", entityId: input.agentId, metadata: { source: "agent_integration", provider: input.provider } }],
      initialMessage: input.initialMessage,
    }, executor);
}

export interface FeishuInboundDispatcherDbOptions {
  orgId?: string;
  enqueueAgentRun?: boolean;
  createOutboundPlaceholder?: boolean;
  startTitleGeneration?: boolean;
  productIntelligence?: {
    execute(input: ProductIntelligenceExecuteInput): Promise<unknown>;
  };
}

export function createFeishuInboundDispatcherDbDeps(
  db: Db,
  options: FeishuInboundDispatcherDbOptions = {},
): AgentIntegrationInboundDispatcherDeps {
  const chats = chatService(db);
  const issues = issueService(db);
  const chatRuns = chatAgentRunService(db);
  const chatTitles = chatTitleGenerationService({
    chats,
    productIntelligence: options.productIntelligence ?? productIntelligenceService(db),
  });
  const productIntelligence = options.productIntelligence ?? productIntelligenceService(db);

  const deps: AgentIntegrationInboundDispatcherDeps = {
    resolveActiveIntegration: async (event) => {
      const conditions = [
        eq(agentIntegrations.provider, event.provider),
        eq(agentIntegrations.externalAppId, event.appId),
        eq(agentIntegrations.status, "active"),
      ];
      if (options.orgId) {
        conditions.push(eq(agentIntegrations.orgId, options.orgId));
      }
      if (event.botOpenId) {
        conditions.push(
          or(isNull(agentIntegrations.externalBotOpenId), eq(agentIntegrations.externalBotOpenId, event.botOpenId))!,
        );
      }
      const rows = await db
        .select()
        .from(agentIntegrations)
        .where(and(...conditions));
      const exactBotMatches = event.botOpenId
        ? rows.filter((row) => row.externalBotOpenId === event.botOpenId)
        : [];
      const candidates = exactBotMatches.length > 0 ? exactBotMatches : rows;
      if (candidates.length !== 1) return null;
      const row = candidates[0];
      if (!row) return null;
      return {
        id: row.id,
        orgId: row.orgId,
        agentId: row.agentId,
        provider: row.provider as ResolvedAgentIntegration["provider"],
        status: integrationStatus(row.status),
        settings: row.settings ?? {},
      };
    },

    auditDrop: async (input) => {
      await db.insert(agentIntegrationInboundAudit).values({
        orgId: input.orgId,
        integrationId: input.integrationId,
        provider: input.provider,
        externalChatId: input.externalChatId,
        externalChatType: input.externalChatType,
        externalEventId: input.externalEventId,
        externalMessageId: input.externalMessageId,
        senderOpenId: input.senderOpenId,
        dropReason: input.dropReason,
        bodyPersisted: false,
        metadata: input.metadata ?? null,
      });
    },

    resolveUserBinding: async (integration, event) => {
      const identityCondition = event.senderUnionId
        ? or(
          eq(agentIntegrationUserBindings.externalOpenId, event.senderOpenId),
          eq(agentIntegrationUserBindings.externalUnionId, event.senderUnionId),
        )
        : eq(agentIntegrationUserBindings.externalOpenId, event.senderOpenId);
      if (!identityCondition) return null;

      const row = await db
        .select()
        .from(agentIntegrationUserBindings)
        .where(
          and(
            eq(agentIntegrationUserBindings.integrationId, integration.id),
            identityCondition,
            isNull(agentIntegrationUserBindings.revokedAt),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      const membership = await db
        .select({ id: organizationMemberships.id })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.orgId, integration.orgId),
            eq(organizationMemberships.principalType, "user"),
            eq(organizationMemberships.principalId, row.userId),
            eq(organizationMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);

      return {
        userId: row.userId,
        orgMember: Boolean(membership),
      };
    },

    mintBindingToken: async (integration, event) => {
      const token = createBindingToken();
      const expiresAt = new Date(Date.now() + BINDING_TOKEN_TTL_MS);
      await db.insert(agentIntegrationBindingTokens).values({
        orgId: integration.orgId,
        integrationId: integration.id,
        tokenHash: hashToken(token),
        externalOpenId: event.senderOpenId,
        externalUnionId: event.senderUnionId,
        expiresAt,
      });
      return { token, expiresAt };
    },

    tryInsertDedup: async (integration, event) => {
      try {
        await db.insert(agentIntegrationInboundDedup).values({
          orgId: integration.orgId,
          integrationId: integration.id,
          provider: integration.provider,
          externalMessageId: event.messageId,
          externalEventId: event.eventId,
          receivedAt: event.receivedAt ?? new Date(),
        });
        return true;
      } catch (error) {
        if (isPostgresError(error, "23505")) return false;
        throw error;
      }
    },

    ensureChatBinding: async (integration, binding, event) => {
      const existing = await db
        .select({
          conversationId: agentIntegrationChatBindings.conversationId,
          createdAt: chatConversations.createdAt,
        })
        .from(agentIntegrationChatBindings)
        .innerJoin(chatConversations, eq(agentIntegrationChatBindings.conversationId, chatConversations.id))
        .where(
          and(
            eq(agentIntegrationChatBindings.integrationId, integration.id),
            eq(agentIntegrationChatBindings.externalChatId, event.chatId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existing) {
        const settings = feishuSettings(integration);
        const receivedAt = event.receivedAt ?? new Date();
        const ageMs = receivedAt.getTime() - existing.createdAt.getTime();
        const shouldRollover = settings.dailySessionRolloverEnabled
          && ageMs >= settings.dailySessionRolloverHours * 60 * 60 * 1000;
        const replyInProgress = await hasPersistedActiveGeneration(db, existing.conversationId);
        if (replyInProgress) {
          return { ...existing, replyInProgress: true };
        }
        if (!shouldRollover) {
          return existing;
        }
        const next = await switchFeishuSession({
          db,
          integration,
          userId: binding.userId,
          event,
          previousConversationId: existing.conversationId,
          reason: "daily_rollover",
          notifyFeishu: settings.dailySessionRolloverNotifyFeishu,
          includeSummary: true,
          productIntelligence,
        });
        return {
          conversationId: next.id,
          created: true,
          dailySessionStarted: true,
          notifyFeishu: settings.dailySessionRolloverNotifyFeishu,
          initialTitle: "New chat",
        };
      }

      const initialTitle = chatTitle(event);
      try {
        return await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db;
          const initial = await createFeishuChatConversation(db, txDb, {
            orgId: integration.orgId,
            agentId: integration.agentId,
            userId: binding.userId,
            provider: integration.provider,
            title: initialTitle,
            initialMessage: {
              role: "user",
              kind: "message",
              status: "completed",
              body: event.body,
              structuredPayload: {
                eventType: "agent_integration_inbound",
                source: "agent_integration",
                provider: integration.provider,
                integrationId: integration.id,
                externalChatId: event.chatId,
                externalChatType: event.chatType,
                externalMessageId: event.messageId,
                externalEventId: event.eventId,
                externalSenderOpenId: event.senderOpenId,
                externalSenderUnionId: event.senderUnionId,
                externalParentMessageId: event.parentMessageId ?? null,
              },
            },
          });
          const inserted = await txDb.insert(agentIntegrationChatBindings).values({
            orgId: integration.orgId,
            integrationId: integration.id,
            conversationId: initial.conversation.id,
            externalChatId: event.chatId,
            externalChatType: event.chatType,
          }).returning({ conversationId: agentIntegrationChatBindings.conversationId }).then((rows) => rows[0]);
          if (!inserted) throw new Error("Failed to create Feishu chat binding");
          return { ...inserted, created: true, initialTitle, initialMessageId: initial.message.id };
        });
      } catch (error) {
        if (!isPostgresError(error, "23505")) throw error;
      }

      const raced = await db
        .select({
          conversationId: agentIntegrationChatBindings.conversationId,
          createdAt: chatConversations.createdAt,
        })
        .from(agentIntegrationChatBindings)
        .innerJoin(chatConversations, eq(agentIntegrationChatBindings.conversationId, chatConversations.id))
        .where(
          and(
            eq(agentIntegrationChatBindings.integrationId, integration.id),
            eq(agentIntegrationChatBindings.externalChatId, event.chatId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!raced) throw new Error("Failed to resolve Feishu chat binding after conflict");
      return raced;
    },

    handleQuickCommand: async (integration, binding, chat, command, event) => {
      if (command.kind === "new") {
        const nextConversation = await switchFeishuSession({
          db,
          integration,
          userId: binding.userId,
          event,
          previousConversationId: chat.conversationId,
          reason: "manual_new",
          notifyFeishu: true,
          includeSummary: false,
          productIntelligence,
        });
        return {
          command: "new",
          conversationId: nextConversation.id,
          chatMessageId: null,
          runId: null,
          text: "New session started.",
        };
      }

      const active = getActiveChatGeneration(chat.conversationId);
      const latestActiveGeneration = active
        ? null
        : await db
          .select()
          .from(chatGenerations)
          .where(
            and(
              eq(chatGenerations.conversationId, chat.conversationId),
              inArray(chatGenerations.status, ["active", "tool_busy", "closing"]),
            ),
          )
          .orderBy(desc(chatGenerations.startedAt), desc(chatGenerations.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
      const stopped = cancelActiveChatGeneration(chat.conversationId);
      const generationId = active?.generationId ?? null;
      const staleGenerationId = stopped ? null : latestActiveGeneration?.id ?? null;
      if (generationId) {
        const now = new Date();
        await db
          .update(chatGenerations)
          .set({
            status: "stopped",
            terminalReason: "stopped",
            completedAt: now,
            updatedAt: now,
          })
          .where(eq(chatGenerations.id, generationId));
      }
      const ack = await chats.addMessage(chat.conversationId, {
        orgId: integration.orgId,
        role: "system",
        kind: "system_event",
        body: stopped ? "Feishu session stop requested." : "No active Feishu reply to stop.",
        structuredPayload: feishuQuickCommandMessage("stop", event, {
          integrationId: integration.id,
          generationId,
          staleGenerationId,
          stopped,
        }),
      });
      return {
        command: "stop",
        conversationId: chat.conversationId,
        chatMessageId: ack.id,
        runId: null,
        text: stopped ? "Stop requested." : "No active reply to stop.",
      };
    },

    appendInboundMessage: async (integration, binding, chat, event) => {
      if (chat.initialMessageId) {
        const initialMessage = await chats.getMessage(chat.conversationId, chat.initialMessageId);
        if (!initialMessage) throw new Error("Atomic Feishu first message was not persisted");
        if (options.startTitleGeneration !== false) {
          const conversation = await chats.getById(chat.conversationId);
          if (conversation) chatTitles.startAutomaticGeneration(conversation, initialMessage, { expectedCurrentTitle: chat.initialTitle });
        }
        return { chatMessageId: initialMessage.id };
      }
      const message = await chats.addMessage(chat.conversationId, {
        orgId: integration.orgId,
        role: "user",
        kind: "message",
        body: event.body,
        structuredPayload: {
          eventType: "agent_integration_inbound",
          source: "agent_integration",
          provider: integration.provider,
          integrationId: integration.id,
          externalChatId: event.chatId,
          externalChatType: event.chatType,
          externalMessageId: event.messageId,
          externalEventId: event.eventId,
          externalSenderOpenId: event.senderOpenId,
          externalSenderUnionId: event.senderUnionId,
          externalParentMessageId: event.parentMessageId ?? null,
        },
      });
      if (options.startTitleGeneration !== false) {
        const conversation = await chats.getById(chat.conversationId);
        if (conversation) {
          chatTitles.startAutomaticGeneration(conversation, message, {
            expectedCurrentTitle: chat.initialTitle,
          });
        }
      }
      return { chatMessageId: message.id };
    },

    createIssueFromCommand: async (integration, binding, chat, message, command, event) => {
      const issue = await issues.create(integration.orgId, {
        title: command.title,
        description: command.body,
        status: "todo",
        priority: "medium",
        assigneeAgentId: integration.agentId,
        createdByUserId: binding.userId,
        originKind: "agent_integration",
        originId: `${integration.provider}:${event.messageId}`,
      });
      await db
        .update(chatConversations)
        .set({ primaryIssueId: issue.id, updatedAt: new Date() })
        .where(eq(chatConversations.id, chat.conversationId));
      await chats.addContextLink(chat.conversationId, integration.orgId, {
        entityType: "issue",
        entityId: issue.id,
        metadata: {
          source: "agent_integration",
          provider: integration.provider,
          chatMessageId: message.chatMessageId,
          externalMessageId: event.messageId,
        },
      });
      return { issueId: issue.id };
    },

  };

  if (options.enqueueAgentRun !== false) {
    deps.enqueueAgentRun = async (integration, _binding, chat, message, _event, issue) => {
      const conversation = await chats.getById(chat.conversationId);
      if (!conversation) throw new Error("Feishu chat conversation not found");
      const run = await chatRuns.createRun({
        conversation,
        agentId: integration.agentId,
        triggerDetail: "chat_assistant_reply_stream",
        userMessageId: message.chatMessageId,
        linkedIssueIds: issue ? [issue.issueId] : [],
        linkedProjectId: null,
        sourceMetadata: {
          source: "agent_integration",
          provider: integration.provider,
          integrationId: integration.id,
          externalChatId: _event.chatId,
          externalChatType: _event.chatType,
          externalMessageId: _event.messageId,
          externalEventId: _event.eventId,
        },
      });
      return { runId: run.id };
    };
  }

  if (options.createOutboundPlaceholder !== false) {
    deps.createOutboundPlaceholder = async (integration, chat, event, message, issue, run) => {
      await db.insert(agentIntegrationOutboundMessages).values({
        orgId: integration.orgId,
        integrationId: integration.id,
        conversationId: chat.conversationId,
        chatMessageId: message.chatMessageId,
        issueId: issue?.issueId ?? null,
        runId: run?.runId ?? null,
        externalChatId: event.chatId,
        status: "pending",
      });
    };
  }

  return deps;
}

export type FeishuInboundDispatcherDbDeps = ReturnType<typeof createFeishuInboundDispatcherDbDeps>;
