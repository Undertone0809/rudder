import type { Db } from "@rudderhq/db";
import {
  chatAttachments,
  chatContextLinks,
  chatConversations,
  chatMessages,
} from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  type ChatConversation,
} from "@rudderhq/shared";
import { and, asc, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { conflict, notFound, unprocessable } from "../errors.js";
import { createChatAnnotationCopySourceResolver } from "./chat-annotation-copy-lineage.js";
import { ensureChatFamilyGroup } from "./chat-family-groups.js";

export const SIDE_CHAT_TTL_MS = 2 * 60 * 60 * 1000;
const SIDE_CHAT_TITLE_PREFIX = "Side chat from: ";
const CHAT_TITLE_MAX_LENGTH = 200;

type ConversationRow = typeof chatConversations.$inferSelect;

function expiresAtFrom(at: Date) {
  return new Date(at.getTime() + SIDE_CHAT_TTL_MS);
}

function sideChatTitleFromSource(sourceTitle: string) {
  const availableSourceLength = CHAT_TITLE_MAX_LENGTH - SIDE_CHAT_TITLE_PREFIX.length;
  const boundedSourceTitle = sourceTitle.trim().slice(0, availableSourceLength).trimEnd() || "Chat";
  return `${SIDE_CHAT_TITLE_PREFIX}${boundedSourceTitle}`;
}

export function sideChatService(db: Db) {
  function assertOwner(conversation: Pick<ConversationRow, "conversationKind" | "createdByUserId">, userId: string | null) {
    if (conversation.conversationKind !== "side_chat") return;
    if (!userId || conversation.createdByUserId !== userId) {
      throw notFound("Chat conversation not found");
    }
  }

  async function getRaw(conversationId: string) {
    return db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.id, conversationId))
      .then((rows) => rows[0] ?? null);
  }

  async function getOwnedSideChat(conversationId: string, userId: string) {
    const conversation = await getRaw(conversationId);
    if (!conversation || conversation.conversationKind !== "side_chat") {
      throw notFound("Side Chat not found");
    }
    assertOwner(conversation, userId);
    return conversation;
  }

  async function hydrated(conversationId: string, userId: string) {
    const conversation = await getRaw(conversationId);
    if (!conversation) throw notFound("Side Chat not found");
    assertOwner(conversation, userId);
    return {
      ...conversation,
      status: conversation.status as ChatConversation["status"],
      conversationKind: conversation.conversationKind as ChatConversation["conversationKind"],
      sideChatState: conversation.sideChatState as ChatConversation["sideChatState"],
      issueCreationMode: conversation.issueCreationMode as ChatConversation["issueCreationMode"],
      latestReplyPreview: null,
      latestUserMessagePreview: null,
      userMessageCount: 0,
      primaryIssue: null,
      contextLinks: [],
      sourceMetadata: null,
      mutability: "native_chat",
      lastReadAt: null,
      isPinned: false,
      unreadCount: 0,
      isUnread: false,
      needsAttention: false,
      chatRuntime: {
        sourceType: "unconfigured",
        sourceLabel: "Unconfigured",
        runtimeAgentId: null,
        agentRuntimeType: null,
        model: null,
        available: false,
        error: null,
      },
    } satisfies ChatConversation;
  }

  async function assertAccessible(conversation: ChatConversation, userId: string | null) {
    assertOwner(conversation as ConversationRow, userId);
    return conversation;
  }

  async function markExpired(conversationId: string, now: Date) {
    await db
      .update(chatConversations)
      .set({
        sideChatState: "expired",
        sideChatExpiresAt: null,
        updatedAt: now,
      })
      .where(and(
        eq(chatConversations.id, conversationId),
        eq(chatConversations.conversationKind, "side_chat"),
        eq(chatConversations.sideChatState, "active"),
      ));
  }

  async function assertMutable(conversation: ChatConversation, userId: string | null, now = new Date()) {
    if (conversation.conversationKind !== "side_chat") return conversation;
    assertOwner(conversation as ConversationRow, userId);
    if (conversation.sideChatState === "kept") return conversation;
    if (conversation.sideChatState !== "active") {
      throw conflict("Side Chat is read-only");
    }
    const expiresAt = conversation.sideChatExpiresAt ? new Date(conversation.sideChatExpiresAt) : null;
    if (!expiresAt || expiresAt.getTime() <= now.getTime()) {
      await markExpired(conversation.id, now);
      throw conflict("Side Chat expired");
    }
    return conversation;
  }

  async function touch(conversation: ChatConversation, userId: string | null, at = new Date()) {
    if (conversation.conversationKind !== "side_chat" || conversation.sideChatState !== "active") {
      return conversation;
    }
    assertOwner(conversation as ConversationRow, userId);
    await db
      .update(chatConversations)
      .set({
        sideChatExpiresAt: expiresAtFrom(at),
        updatedAt: at,
      })
      .where(and(
        eq(chatConversations.id, conversation.id),
        eq(chatConversations.sideChatState, "active"),
      ));
    return hydrated(conversation.id, userId!);
  }

  async function create(input: {
    sourceConversationId: string;
    sourceMessageId: string;
    clientMutationId: string;
    orgId: string;
    userId: string;
    preferredAgentId?: string;
    modelOverride?: string | null;
    effortOverride?: string | null;
  }) {
    const createdId = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(chatConversations)
        .where(and(
          eq(chatConversations.orgId, input.orgId),
          eq(chatConversations.createdByUserId, input.userId),
          eq(chatConversations.sideChatClientMutationId, input.clientMutationId),
        ))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        if (
          existing.conversationKind !== "side_chat"
          || existing.forkedFromConversationId !== input.sourceConversationId
          || existing.forkedFromMessageId !== input.sourceMessageId
          || (
            input.preferredAgentId !== undefined
            && existing.preferredAgentId !== input.preferredAgentId
          )
          || (
            input.modelOverride !== undefined
            && existing.modelOverride !== input.modelOverride
          )
          || (
            input.effortOverride !== undefined
            && existing.effortOverride !== input.effortOverride
          )
        ) {
          throw conflict("Side Chat creation id was already used for different source context");
        }
        return existing.id;
      }

      const source = await tx
        .select()
        .from(chatConversations)
        .where(and(
          eq(chatConversations.id, input.sourceConversationId),
          eq(chatConversations.orgId, input.orgId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!source) throw notFound("Chat conversation not found");

      const sourceMessages = await tx
        .select()
        .from(chatMessages)
        .where(and(
          eq(chatMessages.orgId, input.orgId),
          eq(chatMessages.conversationId, source.id),
          isNull(chatMessages.supersededAt),
        ))
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
      const anchorIndex = sourceMessages.findIndex((message) => message.id === input.sourceMessageId);
      const anchor = anchorIndex >= 0 ? sourceMessages[anchorIndex] : null;
      if (!anchor || anchor.role !== "assistant" || anchor.kind !== "message" || anchor.status !== "completed") {
        throw unprocessable("Side Chat source must be a completed assistant response");
      }

      const now = new Date();
      const rootConversationId = source.forkRootConversationId ?? source.id;
      const [child] = await tx
        .insert(chatConversations)
        .values({
          orgId: input.orgId,
          status: "active",
          conversationKind: "side_chat",
          messengerVisible: false,
          sideChatState: "active",
          sideChatExpiresAt: expiresAtFrom(now),
          sideChatClientMutationId: input.clientMutationId,
          title: sideChatTitleFromSource(source.title),
          summary: source.summary,
          preferredAgentId: input.preferredAgentId ?? source.preferredAgentId,
          modelOverride: input.modelOverride ?? null,
          effortOverride: input.effortOverride ?? null,
          routedAgentId: input.preferredAgentId ?? source.routedAgentId,
          primaryIssueId: source.primaryIssueId,
          forkedFromConversationId: source.id,
          forkedFromMessageId: anchor.id,
          forkRootConversationId: rootConversationId,
          issueCreationMode: source.issueCreationMode,
          planMode: source.planMode,
          createdByUserId: input.userId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!child) {
        const raced = await tx
          .select()
          .from(chatConversations)
          .where(and(
            eq(chatConversations.orgId, input.orgId),
            eq(chatConversations.createdByUserId, input.userId),
            eq(chatConversations.sideChatClientMutationId, input.clientMutationId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!raced) throw new Error("Failed to create Side Chat");
        if (
          raced.conversationKind !== "side_chat"
          || raced.forkedFromConversationId !== input.sourceConversationId
          || raced.forkedFromMessageId !== input.sourceMessageId
          || (
            input.preferredAgentId !== undefined
            && raced.preferredAgentId !== input.preferredAgentId
          )
          || (
            input.modelOverride !== undefined
            && raced.modelOverride !== input.modelOverride
          )
          || (
            input.effortOverride !== undefined
            && raced.effortOverride !== input.effortOverride
          )
        ) {
          throw conflict("Side Chat creation id was already used for different source context");
        }
        return raced.id;
      }

      const contextLinks = await tx
        .select()
        .from(chatContextLinks)
        .where(eq(chatContextLinks.conversationId, source.id))
        .orderBy(asc(chatContextLinks.createdAt));
      if (contextLinks.length > 0) {
        await tx
          .insert(chatContextLinks)
          .values(contextLinks.map((link) => ({
            orgId: input.orgId,
            conversationId: child.id,
            entityType: link.entityType,
            entityId: link.entityId,
            metadata: link.metadata,
          })))
          .onConflictDoNothing();
      }

      const copiedSourceMessages = sourceMessages.slice(0, anchorIndex + 1);
      const copiedMessageIds = new Map(
        copiedSourceMessages.map((message) => [message.id, randomUUID()]),
      );
      const resolveAnnotationSource = await createChatAnnotationCopySourceResolver({
        tx,
        orgId: input.orgId,
        sourceConversation: source,
        messages: copiedSourceMessages,
        operationLabel: "Side Chat",
      });

      const sourceAttachments = copiedMessageIds.size > 0
        ? await tx
          .select()
          .from(chatAttachments)
          .where(inArray(chatAttachments.messageId, [...copiedMessageIds.keys()]))
          .orderBy(asc(chatAttachments.createdAt))
        : [];
      const sourceAttachmentById = new Map(
        sourceAttachments.map((attachment) => [attachment.id, attachment]),
      );
      const copiedAttachmentIds = new Map(
        sourceAttachments.map((attachment) => [attachment.id, randomUUID()]),
      );

      for (const message of copiedSourceMessages) {
        const copiedAnnotations = chatInlineAnnotationsFromStructuredPayload(
          message.structuredPayload,
        ).map((annotation) => {
          const copiedAnnotationAttachments = annotation.attachmentIds.map((attachmentId) => {
            const sourceAttachment = sourceAttachmentById.get(attachmentId);
            const copiedAttachmentId = copiedAttachmentIds.get(attachmentId);
            if (
              !sourceAttachment
              || sourceAttachment.messageId !== message.id
              || !copiedAttachmentId
            ) {
              throw unprocessable("Side Chat annotation attachment is not owned by its copied user message");
            }
            return copiedAttachmentId;
          });
          if (annotation.surface === "workspace_file" || annotation.surface === "local_file") {
            return {
              ...annotation,
              sourceConversationId: child.id,
              attachmentIds: copiedAnnotationAttachments,
            };
          }
          const sourceMessage = resolveAnnotationSource(annotation);
          const copiedSourceMessageId = sourceMessage
            ? copiedMessageIds.get(sourceMessage.id)
            : null;
          if (
            !sourceMessage
            || !copiedSourceMessageId
            || sourceMessage.role !== "assistant"
            || sourceMessage.kind !== "message"
          ) {
            throw unprocessable("Side Chat annotation source message falls outside the copied range");
          }
          return {
            ...annotation,
            sourceConversationId: child.id,
            sourceMessageId: copiedSourceMessageId,
            attachmentIds: copiedAnnotationAttachments,
          };
        });
        await tx.insert(chatMessages).values({
          id: copiedMessageIds.get(message.id)!,
          orgId: input.orgId,
          conversationId: child.id,
          role: message.role,
          kind: message.kind,
          status: message.status === "streaming" ? "interrupted" : message.status,
          body: message.body,
          structuredPayload: copiedAnnotations.length > 0
            ? { inlineAnnotations: copiedAnnotations }
            : null,
          approvalId: null,
          runId: null,
          replyingAgentId: message.replyingAgentId,
          chatTurnId: null,
          turnVariant: 0,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        });
      }

      if (sourceAttachments.length > 0) {
        await tx.insert(chatAttachments).values(sourceAttachments.flatMap((attachment) => {
          const copiedMessageId = copiedMessageIds.get(attachment.messageId);
          const copiedAttachmentId = copiedAttachmentIds.get(attachment.id);
          return copiedMessageId && copiedAttachmentId ? [{
            id: copiedAttachmentId,
            orgId: input.orgId,
            conversationId: child.id,
            messageId: copiedMessageId,
            assetId: attachment.assetId,
          }] : [];
        }));
      }

      const [systemEvent] = await tx
        .insert(chatMessages)
        .values({
          orgId: input.orgId,
          conversationId: child.id,
          role: "system",
          kind: "system_event",
          status: "completed",
          body: `Side Chat started from [${source.title}](chat://${source.id}).`,
          structuredPayload: {
            eventType: "side_chat_started",
            sourceConversationId: source.id,
            sourceConversationTitle: source.title,
            sourceMessageId: anchor.id,
            copiedSourceMessageId: copiedMessageIds.get(anchor.id),
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await tx
        .update(chatConversations)
        .set({ lastMessageAt: systemEvent?.createdAt ?? now, updatedAt: now })
        .where(eq(chatConversations.id, child.id));
      return child.id;
    });

    return hydrated(createdId, input.userId);
  }

  async function destroy(input: { conversationId: string; userId: string }) {
    const conversation = await getOwnedSideChat(input.conversationId, input.userId);
    if (conversation.sideChatState === "kept" || conversation.messengerVisible) {
      throw conflict("A kept Side Chat is a normal Messenger chat");
    }
    const deleted = await db
      .delete(chatConversations)
      .where(and(
        eq(chatConversations.id, conversation.id),
        eq(chatConversations.createdByUserId, input.userId),
        eq(chatConversations.conversationKind, "side_chat"),
        eq(chatConversations.messengerVisible, false),
        ne(chatConversations.sideChatState, "kept"),
      ))
      .returning({ id: chatConversations.id });
    if (!deleted[0]) throw conflict("Side Chat could not be destroyed");
    return deleted[0];
  }

  async function keepInMessenger(input: { conversationId: string; userId: string }) {
    const conversation = await getOwnedSideChat(input.conversationId, input.userId);
    if (conversation.sideChatState === "kept" && conversation.messengerVisible) {
      return hydrated(conversation.id, input.userId);
    }
    if (conversation.sideChatState !== "active") throw conflict("Only an active Side Chat can be kept in Messenger");

    const outcome = await db.transaction(async (tx) => {
      const now = new Date();
      const expired = await tx
        .update(chatConversations)
        .set({
          sideChatState: "expired",
          sideChatExpiresAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(chatConversations.id, conversation.id),
          eq(chatConversations.sideChatState, "active"),
          eq(chatConversations.messengerVisible, false),
          or(
            isNull(chatConversations.sideChatExpiresAt),
            lte(chatConversations.sideChatExpiresAt, now),
          ),
        ))
        .returning({ id: chatConversations.id });
      if (expired.length > 0) return "expired" as const;

      const transitioned = await tx
        .update(chatConversations)
        .set({
          status: "active",
          messengerVisible: true,
          sideChatState: "kept",
          sideChatExpiresAt: null,
          sideChatKeptAt: now,
          resolvedAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(chatConversations.id, conversation.id),
          eq(chatConversations.sideChatState, "active"),
          eq(chatConversations.messengerVisible, false),
          gt(chatConversations.sideChatExpiresAt, now),
        ))
        .returning({ id: chatConversations.id });
      if (transitioned.length === 0) {
        const latest = await tx
          .select({ sideChatState: chatConversations.sideChatState, messengerVisible: chatConversations.messengerVisible })
          .from(chatConversations)
          .where(eq(chatConversations.id, conversation.id))
          .then((rows) => rows[0] ?? null);
        if (latest?.sideChatState === "kept" && latest.messengerVisible) return "kept" as const;
        throw conflict("Only an active Side Chat can be kept in Messenger");
      }

      const sourceConversationId = conversation.forkedFromConversationId;
      if (!sourceConversationId) {
        throw conflict("Side Chat source is no longer available");
      }
      const source = await tx
        .select({
          id: chatConversations.id,
          title: chatConversations.title,
          forkRootConversationId: chatConversations.forkRootConversationId,
        })
        .from(chatConversations)
        .where(and(
          eq(chatConversations.id, sourceConversationId),
          eq(chatConversations.orgId, conversation.orgId),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!source) throw conflict("Side Chat source is no longer available");
      await ensureChatFamilyGroup(tx, {
        orgId: conversation.orgId,
        userId: input.userId,
        rootConversationId: conversation.forkRootConversationId ?? source.forkRootConversationId ?? source.id,
        sourceConversationId: source.id,
        childConversationId: conversation.id,
        groupName: source.title,
      });
      return "kept" as const;
    });

    if (outcome === "expired") throw conflict("Side Chat expired");

    return hydrated(conversation.id, input.userId);
  }

  return {
    create,
    destroy,
    keepInMessenger,
    assertAccessible,
    assertMutable,
    touch,
  };
}
