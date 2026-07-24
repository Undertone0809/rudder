import type { Db } from "@rudderhq/db";
import { chatContextLinks, chatConversations, chatMessages } from "@rudderhq/db";
import { sanitizeChatStructuredPayload, type ChatConversation, type ChatMessage } from "@rudderhq/shared";
import { randomUUID } from "node:crypto";
import { unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

type ContextLinkRow = typeof chatContextLinks.$inferSelect;

export type CreateChatInput = {
  title?: string;
  summary?: string | null;
  preferredAgentId?: string | null;
  modelOverride?: string | null;
  effortOverride?: string | null;
  issueCreationMode: "manual_approval" | "auto_create";
  planMode: boolean;
  createdByUserId: string | null;
  contextLinks?: Array<{
    entityType: "issue" | "project" | "agent";
    entityId: string;
    metadata?: Record<string, unknown> | null;
  }>;
};

export async function createChatConversation(db: Db, orgId: string, data: CreateChatInput) {
  const created = await db.transaction(async (tx) => {
    const [conversation] = await tx
      .insert(chatConversations)
      .values({
        orgId,
        title: data.title?.trim() || "New chat",
        summary: data.summary ?? null,
        preferredAgentId: data.preferredAgentId ?? null,
        modelOverride: data.modelOverride ?? null,
        effortOverride: data.effortOverride ?? null,
        issueCreationMode: data.issueCreationMode,
        planMode: data.planMode,
        createdByUserId: data.createdByUserId,
      })
      .returning();
    if (!conversation) throw new Error("Failed to create chat conversation");

    const contextLinks = data.contextLinks ?? [];
    if (contextLinks.length > 0) {
      await tx
        .insert(chatContextLinks)
        .values(contextLinks.map((link) => ({
          orgId,
          conversationId: conversation.id,
          entityType: link.entityType,
          entityId: link.entityId,
          metadata: link.metadata ?? null,
        })))
        .onConflictDoNothing();
    }
    return conversation;
  });
  return created;
}

export type CreateChatWithInitialMessageInput = {
  title?: string;
  summary?: string | null;
  preferredAgentId?: string | null;
  modelOverride?: string | null;
  effortOverride?: string | null;
  issueCreationMode: "manual_approval" | "auto_create";
  planMode: boolean;
  createdByUserId: string | null;
  contextLinks?: Array<{
    entityType: "issue" | "project" | "agent";
    entityId: string;
    metadata?: Record<string, unknown> | null;
  }>;
  initialMessage: {
    role: "user" | "assistant" | "system";
    kind: "message" | "ask_user" | "issue_proposal" | "operation_proposal" | "system_event";
    status: "streaming" | "completed" | "stopped" | "failed" | "interrupted";
    body: string;
    structuredPayload?: Record<string, unknown> | null;
    replyingAgentId?: string | null;
    chatTurnId?: string | null;
  };
  activity?: {
    actorType: "agent" | "user" | "system";
    actorId: string;
    agentId?: string | null;
    runId?: string | null;
  };
};

export async function createChatWithInitialMessage(
  db: Db,
  orgId: string,
  data: CreateChatWithInitialMessageInput,
  executor?: Db,
): Promise<{ conversation: ChatConversation; message: ChatMessage }> {
  const persist = async (client: Db) => {
    const now = new Date();
    const normalizedBody = data.initialMessage.body.trim();
    if (!normalizedBody) throw unprocessable("Initial chat message body is required");
    const deterministicTitle = normalizedBody.replace(/\s+/g, " ").slice(0, 200);
    const [conversationRow] = await client
      .insert(chatConversations)
      .values({
        orgId,
        title: data.title?.trim() || deterministicTitle,
        summary: data.summary ?? null,
        preferredAgentId: data.preferredAgentId ?? null,
        modelOverride: data.modelOverride ?? null,
        effortOverride: data.effortOverride ?? null,
        issueCreationMode: data.issueCreationMode,
        planMode: data.planMode,
        createdByUserId: data.createdByUserId,
        lastMessageAt: now,
        updatedAt: now,
      })
      .returning();
    if (!conversationRow) throw new Error("Failed to create chat conversation");

    const contextLinks = data.contextLinks ?? [];
    let contextRows: ContextLinkRow[] = [];
    if (contextLinks.length > 0) {
      contextRows = await client
        .insert(chatContextLinks)
        .values(contextLinks.map((link) => ({
          orgId,
          conversationId: conversationRow.id,
          entityType: link.entityType,
          entityId: link.entityId,
          metadata: link.metadata ?? null,
        })))
        .onConflictDoNothing()
        .returning();
    }

    const structuredPayload = sanitizeChatStructuredPayload(data.initialMessage.structuredPayload ?? null);
    const [messageRow] = await client
      .insert(chatMessages)
      .values({
        orgId,
        conversationId: conversationRow.id,
        role: data.initialMessage.role,
        kind: data.initialMessage.kind,
        status: data.initialMessage.status,
        body: normalizedBody,
        structuredPayload,
        replyingAgentId: data.initialMessage.replyingAgentId ?? null,
        chatTurnId: data.initialMessage.chatTurnId ?? (data.initialMessage.role === "user" ? randomUUID() : null),
        turnVariant: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!messageRow) throw new Error("Failed to create initial chat message");

    if (data.activity) {
      const activity = data.activity;
      await logActivity(client, {
        orgId,
        actorType: activity.actorType,
        actorId: activity.actorId,
        agentId: activity.agentId ?? null,
        runId: activity.runId ?? null,
        action: "chat.created",
        entityType: "chat",
        entityId: conversationRow.id,
        details: {
          title: conversationRow.title,
          contextLinkCount: contextLinks.length,
          modelOverride: conversationRow.modelOverride,
          effortOverride: conversationRow.effortOverride,
        },
      });
      await logActivity(client, {
        orgId,
        actorType: activity.actorType,
        actorId: activity.actorId,
        agentId: activity.agentId ?? null,
        runId: activity.runId ?? null,
        action: "chat.message_added",
        entityType: "chat",
        entityId: conversationRow.id,
        details: {
          messageId: messageRow.id,
          role: messageRow.role,
          kind: messageRow.kind,
          status: messageRow.status,
          preview: messageRow.body.slice(0, 280),
        },
      });
    }

    const conversation = {
      ...conversationRow,
      primaryIssue: null,
      latestReplyPreview: messageRow.role === "assistant" ? messageRow.body.slice(0, 280) : null,
      latestUserMessagePreview: messageRow.role === "user" ? messageRow.body.slice(0, 280) : null,
      userMessageCount: messageRow.role === "user" ? 1 : 0,
      contextLinks: contextRows.map((row) => ({ ...row, entity: null })),
      sourceMetadata: null,
      mutability: "native_chat" as const,
      lastReadAt: null,
      isPinned: false,
      isUnread: false,
      unreadCount: 0,
      needsAttention: false,
    } as ChatConversation;
    const message = {
      ...messageRow,
      role: messageRow.role as ChatMessage["role"],
      kind: messageRow.kind as ChatMessage["kind"],
      status: messageRow.status as ChatMessage["status"],
      structuredPayload,
      approval: null,
      attachments: [],
      transcript: [],
    } as ChatMessage;
    return { conversation, message };
  };

  if (executor) return persist(executor);
  return db.transaction(async (tx) => persist(tx as unknown as Db));
}
