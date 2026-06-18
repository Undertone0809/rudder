import type { Db } from "@rudderhq/db";
import {
  agentIntegrationBindingTokens,
  agentIntegrationChatBindings,
  agentIntegrationInboundAudit,
  agentIntegrationInboundDedup,
  agentIntegrationOutboundMessages,
  agentIntegrationUserBindings,
  agentIntegrations,
  chatConversations,
  organizationMemberships,
} from "@rudderhq/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { chatAgentRunService } from "../../chat-agent-runs.js";
import { chatService } from "../../chats.js";
import { issueService } from "../../issues.js";
import type {
  AgentIntegrationInboundDispatcherDeps,
  FeishuInboundMessage,
  ResolvedAgentIntegration,
} from "./inbound-dispatcher.js";

const BINDING_TOKEN_TTL_MS = 15 * 60 * 1000;

function isUniqueViolation(error: unknown) {
  return (error as { code?: unknown }).code === "23505";
}

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
  const prefix = event.chatType === "group" ? "Feishu group" : "Feishu chat";
  return `${prefix} ${event.chatId}`.slice(0, 120);
}

export function createFeishuInboundDispatcherDbDeps(db: Db): AgentIntegrationInboundDispatcherDeps {
  const chats = chatService(db);
  const issues = issueService(db);
  const chatRuns = chatAgentRunService(db);

  return {
    resolveActiveIntegration: async (event) => {
      const conditions = [
        eq(agentIntegrations.provider, event.provider),
        eq(agentIntegrations.externalAppId, event.appId),
        eq(agentIntegrations.status, "active"),
      ];
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
      const row = await db
        .select()
        .from(agentIntegrationUserBindings)
        .where(
          and(
            eq(agentIntegrationUserBindings.integrationId, integration.id),
            eq(agentIntegrationUserBindings.externalOpenId, event.senderOpenId),
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
      await db.insert(agentIntegrationBindingTokens).values({
        orgId: integration.orgId,
        integrationId: integration.id,
        tokenHash: hashToken(token),
        externalOpenId: event.senderOpenId,
        externalUnionId: event.senderUnionId,
        expiresAt: new Date(Date.now() + BINDING_TOKEN_TTL_MS),
      });
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
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },

    ensureChatBinding: async (integration, binding, event) => {
      const existing = await db
        .select({ conversationId: agentIntegrationChatBindings.conversationId })
        .from(agentIntegrationChatBindings)
        .where(
          and(
            eq(agentIntegrationChatBindings.integrationId, integration.id),
            eq(agentIntegrationChatBindings.externalChatId, event.chatId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (existing) return existing;

      const conversation = await chats.create(integration.orgId, {
        title: chatTitle(event),
        summary: null,
        preferredAgentId: integration.agentId,
        issueCreationMode: "manual_approval",
        planMode: false,
        createdByUserId: binding.userId,
        contextLinks: [
          {
            entityType: "agent",
            entityId: integration.agentId,
            metadata: { source: "agent_integration", provider: integration.provider },
          },
        ],
      });
      if (!conversation) throw new Error("Failed to create Feishu chat conversation");

      try {
        const inserted = await db
          .insert(agentIntegrationChatBindings)
          .values({
            orgId: integration.orgId,
            integrationId: integration.id,
            conversationId: conversation.id,
            externalChatId: event.chatId,
            externalChatType: event.chatType,
          })
          .returning({ conversationId: agentIntegrationChatBindings.conversationId })
          .then((rows) => rows[0]);
        if (inserted) return inserted;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }

      const raced = await db
        .select({ conversationId: agentIntegrationChatBindings.conversationId })
        .from(agentIntegrationChatBindings)
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

    appendInboundMessage: async (integration, binding, chat, event) => {
      const message = await chats.addMessage(chat.conversationId, {
        orgId: integration.orgId,
        role: "user",
        kind: "message",
        body: event.body,
        structuredPayload: {
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

    enqueueAgentRun: async (integration, _binding, chat, message, _event, issue) => {
      const conversation = await chats.getById(chat.conversationId);
      if (!conversation) throw new Error("Feishu chat conversation not found");
      const run = await chatRuns.createRun({
        conversation,
        agentId: integration.agentId,
        triggerDetail: "chat_assistant_reply_stream",
        userMessageId: message.chatMessageId,
        linkedIssueIds: issue ? [issue.issueId] : [],
        linkedProjectId: null,
      });
      return { runId: run.id };
    },

    createOutboundPlaceholder: async (integration, chat, event, message, issue, run) => {
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
    },
  };
}

export type FeishuInboundDispatcherDbDeps = ReturnType<typeof createFeishuInboundDispatcherDbDeps>;
