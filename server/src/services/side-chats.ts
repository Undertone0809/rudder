import type { Db } from "@rudderhq/db";
import {
  assets,
  chatAttachments,
  chatContextLinks,
  chatConversations,
  chatGenerations,
  chatMessages,
  chatQueuedMessages,
  heartbeatRuns,
  runtimeBindings,
  sideChatCloseIntents,
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
import { hasActiveChatGeneration } from "./chat-generation-locks.js";
import { selectedChatMessageBranchCondition } from "./chat-message-branch.js";
import { QUEUED_ANNOTATION_ASSETS_KEY, queuedAnnotationAssetState } from "./chat-queued-message-materialization.js";
import { ACTIVE_CHAT_GENERATION_STATUSES } from "./chats.constants.js";
import { recordProductAnalyticsChatCreated } from "./product-analytics.js";
import {
  deleteReleasedRuntimeRetentionClaimsInTransaction,
  ensureRuntimeRetentionClaimsInTransaction,
  expireRuntimeRetentionClaimsInTransaction,
  lockRuntimeRetentionScope,
  promoteRuntimeRetentionClaimsInTransaction,
  releaseRuntimeRetentionClaimsInTransaction,
  renewRuntimeRetentionClaimsInTransaction,
  type RuntimeRetentionDb,
} from "./runtime-kernel/runtime-retention.js";
import { persistSideChatProviderCleanupIntents } from "./side-chat-provider-cleanup.js";

export const SIDE_CHAT_TTL_MS = 2 * 60 * 60 * 1000;
const SIDE_CHAT_TITLE_PREFIX = "Side chat from: ";
const CHAT_TITLE_MAX_LENGTH = 200;

export function sideChatRetentionPurpose(conversationId: string) {
  return `side_chat:${conversationId}`;
}

export function sideChatRetentionResource(conversationId: string) {
  return `chat:${conversationId}`;
}

export function sideChatRunReference(conversationId: string) {
  return or(
    eq(heartbeatRuns.chatConversationId, conversationId),
    and(
      eq(heartbeatRuns.scene, "side_chat"),
      eq(heartbeatRuns.targetType, "chat_conversation"),
      eq(heartbeatRuns.targetId, conversationId),
    ),
  );
}

function sideChatRetentionPrincipal(userId: string) {
  return `user:${userId}`;
}

type ConversationRow = typeof chatConversations.$inferSelect;

type SideChatCreateInput = {
  sourceConversationId: string;
  sourceMessageId: string;
  clientMutationId: string;
  orgId: string;
  userId: string;
  preferredAgentId?: string;
};

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

  async function ensureSideChatRetentionClaim(
    tx: RuntimeRetentionDb,
    conversation: Pick<ConversationRow, "id" | "orgId" | "sideChatState" | "sideChatExpiresAt">,
    userId: string,
  ) {
    if (conversation.sideChatState === "expired") return;
    if (conversation.sideChatState === "active" && !conversation.sideChatExpiresAt) return;
    await ensureRuntimeRetentionClaimsInTransaction(tx, {
      orgId: conversation.orgId,
      claims: [{
        resourceRef: sideChatRetentionResource(conversation.id),
        purpose: sideChatRetentionPurpose(conversation.id),
        principalScopeRef: sideChatRetentionPrincipal(userId),
        expiresAt: conversation.sideChatState === "kept" ? null : conversation.sideChatExpiresAt,
      }],
    });
  }

  async function markExpired(conversationId: string, now: Date, userId: string) {
    await db.transaction(async (tx) => {
      const txRetention = tx as unknown as RuntimeRetentionDb;
      const seed = await tx.select({ orgId: chatConversations.orgId }).from(chatConversations)
        .where(eq(chatConversations.id, conversationId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!seed) return;
      await lockRuntimeRetentionScope(txRetention, seed.orgId);
      const existing = await tx.select().from(chatConversations)
        .where(and(
          eq(chatConversations.id, conversationId),
          eq(chatConversations.orgId, seed.orgId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existing || existing.conversationKind !== "side_chat") return;
      assertOwner(existing, userId);
      const [expired] = await tx
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
        ))
        .returning({ id: chatConversations.id });
      if (!expired) return;
      await expireRuntimeRetentionClaimsInTransaction(txRetention, {
        orgId: existing.orgId,
        purpose: sideChatRetentionPurpose(existing.id),
        principalScopeRef: sideChatRetentionPrincipal(userId),
        now,
        force: true,
      });
    });
  }

  async function assertMutable(conversation: ChatConversation, userId: string | null, now = new Date()) {
    if (conversation.conversationKind !== "side_chat") return conversation;
    assertOwner(conversation as ConversationRow, userId);
    const latest = await getRaw(conversation.id);
    if (!latest || latest.orgId !== conversation.orgId) throw notFound("Side Chat not found");
    assertOwner(latest, userId);
    if (latest.sideChatState === "kept" && latest.messengerVisible) return conversation;
    if (latest.sideChatState !== "active") {
      throw conflict("Side Chat is read-only");
    }
    const expiresAt = latest.sideChatExpiresAt;
    if (!expiresAt || expiresAt.getTime() <= now.getTime()) {
      await markExpired(conversation.id, now, userId!);
      throw conflict("Side Chat expired");
    }
    return conversation;
  }

  async function touch(conversation: ChatConversation, userId: string | null, at = new Date()) {
    if (conversation.conversationKind !== "side_chat" || conversation.sideChatState !== "active") {
      return conversation;
    }
    assertOwner(conversation as ConversationRow, userId);
    await db.transaction(async (tx) => {
      const txRetention = tx as unknown as RuntimeRetentionDb;
      await lockRuntimeRetentionScope(txRetention, conversation.orgId);
      const latest = await tx.select().from(chatConversations)
        .where(and(
          eq(chatConversations.id, conversation.id),
          eq(chatConversations.orgId, conversation.orgId),
          eq(chatConversations.conversationKind, "side_chat"),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!latest || latest.sideChatState !== "active") return;
      const nextExpiresAt = expiresAtFrom(at);
      const [touched] = await tx
        .update(chatConversations)
        .set({
          sideChatExpiresAt: nextExpiresAt,
          updatedAt: at,
        })
        .where(and(
          eq(chatConversations.id, latest.id),
          eq(chatConversations.sideChatState, "active"),
        ))
        .returning({ id: chatConversations.id });
      if (!touched) return;
      const renewed = await renewRuntimeRetentionClaimsInTransaction(txRetention, {
        orgId: latest.orgId,
        purpose: sideChatRetentionPurpose(latest.id),
        principalScopeRef: sideChatRetentionPrincipal(userId!),
        expiresAt: nextExpiresAt,
      });
      if (renewed.length === 0) {
        await ensureSideChatRetentionClaim(txRetention, {
          id: latest.id,
          orgId: latest.orgId,
          sideChatState: latest.sideChatState,
          sideChatExpiresAt: nextExpiresAt,
        }, userId!);
      }
    });
    return hydrated(conversation.id, userId!);
  }

  function assertIdempotentCreateMatches(existing: ConversationRow, input: SideChatCreateInput) {
    if (
      existing.conversationKind !== "side_chat"
      || existing.forkedFromConversationId !== input.sourceConversationId
      || existing.forkedFromMessageId !== input.sourceMessageId
      || (
        input.preferredAgentId !== undefined
        && existing.preferredAgentId !== input.preferredAgentId
      )
    ) {
      throw conflict("Side Chat creation id was already used for different source context");
    }
  }

  async function findExistingForCreate(input: SideChatCreateInput) {
    const existing = await db
      .select()
      .from(chatConversations)
      .where(and(
        eq(chatConversations.orgId, input.orgId),
        eq(chatConversations.createdByUserId, input.userId),
        eq(chatConversations.sideChatClientMutationId, input.clientMutationId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;
    assertIdempotentCreateMatches(existing, input);
    return hydrated(existing.id, input.userId);
  }

  async function create(input: SideChatCreateInput) {
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
        assertIdempotentCreateMatches(existing, input);
        await ensureSideChatRetentionClaim(tx as unknown as RuntimeRetentionDb, existing, input.userId);
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

      const anchor = await tx
        .select()
        .from(chatMessages)
        .where(and(
          eq(chatMessages.orgId, input.orgId),
          eq(chatMessages.conversationId, source.id),
          eq(chatMessages.id, input.sourceMessageId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!anchor || anchor.role !== "assistant" || anchor.kind !== "message" || anchor.status !== "completed") {
        throw unprocessable("Side Chat source must be a completed assistant response");
      }

      const sourceMessages = await tx
        .select()
        .from(chatMessages)
        .where(and(
          eq(chatMessages.orgId, input.orgId),
          eq(chatMessages.conversationId, source.id),
          selectedChatMessageBranchCondition(anchor),
        ))
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
      const anchorIndex = sourceMessages.findIndex((message) => message.id === input.sourceMessageId);
      if (anchorIndex < 0) throw unprocessable("Side Chat source message branch could not be resolved");

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
          modelOverride: null,
          effortOverride: null,
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
        assertIdempotentCreateMatches(raced, input);
        await ensureSideChatRetentionClaim(tx as unknown as RuntimeRetentionDb, raced, input.userId);
        return raced.id;
      }

      await ensureSideChatRetentionClaim(tx as unknown as RuntimeRetentionDb, child, input.userId);

      await recordProductAnalyticsChatCreated(tx as unknown as Db, {
        orgId: input.orgId,
        conversationId: child.id,
        createdAt: child.createdAt,
        createdByUserId: input.userId,
        actorType: "human",
        actorId: input.userId,
        creationPath: "side_chat",
        planMode: child.planMode,
        initialRole: "system",
      });

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
        const sourceLineage = {
          conversationId: source.id,
          messageId: message.id,
          runId: message.runId,
          approvalId: message.approvalId,
          chatTurnId: message.chatTurnId,
          turnVariant: message.turnVariant,
        };
        const copiedStructuredPayload = {
          sideChatSource: sourceLineage,
          ...(copiedAnnotations.length > 0 ? { inlineAnnotations: copiedAnnotations } : {}),
        };
        await tx.insert(chatMessages).values({
          id: copiedMessageIds.get(message.id)!,
          orgId: input.orgId,
          conversationId: child.id,
          role: message.role,
          kind: message.kind,
          status: message.status === "streaming" ? "interrupted" : message.status,
          body: message.body,
          structuredPayload: copiedStructuredPayload,
          approvalId: null,
          // Source identity is lineage only, never an execution/control alias.
          // Readers must authorize the source separately before resolving it.
          runId: null,
          replyingAgentId: message.replyingAgentId,
          chatTurnId: null,
          turnVariant: message.turnVariant,
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

  async function requestClose(input: { conversationId: string; userId: string }) {
    return db.transaction(async (tx) => {
      const [seed] = await tx.select({ orgId: chatConversations.orgId }).from(chatConversations)
        .where(eq(chatConversations.id, input.conversationId)).limit(1);
      if (!seed) throw notFound("Side Chat not found");
      const txRetention = tx as unknown as RuntimeRetentionDb;
      await lockRuntimeRetentionScope(txRetention, seed.orgId);
      const [conversation] = await tx.select().from(chatConversations)
        .where(and(eq(chatConversations.id, input.conversationId), eq(chatConversations.orgId, seed.orgId)))
        .for("update");
      if (!conversation || conversation.conversationKind !== "side_chat") throw notFound("Side Chat not found");
      assertOwner(conversation, input.userId);
      if (conversation.sideChatState === "kept" || conversation.messengerVisible) {
        throw conflict("A kept Side Chat is a normal Messenger chat");
      }
      const [existing] = await tx.select().from(sideChatCloseIntents).where(and(
        eq(sideChatCloseIntents.orgId, conversation.orgId),
        eq(sideChatCloseIntents.conversationId, conversation.id),
      )).limit(1);
      if (existing) return existing;

      const bindings = await tx.select({ id: runtimeBindings.id }).from(runtimeBindings)
        .where(and(eq(runtimeBindings.orgId, conversation.orgId), eq(runtimeBindings.conversationId, conversation.id)))
        .for("update");
      if (bindings.length > 0) {
        const [descendant] = await tx.select({ id: runtimeBindings.id }).from(runtimeBindings)
          .where(and(
            eq(runtimeBindings.orgId, conversation.orgId),
            inArray(runtimeBindings.parentBindingId, bindings.map(({ id }) => id)),
          )).limit(1);
        if (descendant) {
          throw conflict("Side Chat has native runtime descendants; keep it or resolve the descendant references first");
        }
      }

      const now = new Date();
      const [intent] = await tx.insert(sideChatCloseIntents).values({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        ownerUserId: input.userId,
        sourceConversationId: conversation.forkedFromConversationId,
        sourceMessageId: conversation.forkedFromMessageId,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      }).returning();
      if (!intent) throw new Error("Failed to persist Side Chat close intent");
      await tx.update(chatConversations).set({
        sideChatState: "completed",
        sideChatCompletedAt: now,
        sideChatExpiresAt: null,
        updatedAt: now,
      }).where(eq(chatConversations.id, conversation.id));
      await ensureSideChatRetentionClaim(txRetention, {
        id: conversation.id,
        orgId: conversation.orgId,
        sideChatState: "completed",
        sideChatExpiresAt: null,
      }, input.userId);
      await promoteRuntimeRetentionClaimsInTransaction(txRetention, {
        orgId: conversation.orgId,
        purpose: sideChatRetentionPurpose(conversation.id),
        principalScopeRef: sideChatRetentionPrincipal(input.userId),
      });
      return intent;
    });
  }

  async function destroy(input: {
    conversationId: string;
    userId: string;
    closeClaim?: { id: string; owner: string; epoch: number };
  }) {
    return db.transaction(async (tx) => {
      const [seed] = await tx
        .select({ orgId: chatConversations.orgId })
        .from(chatConversations)
        .where(eq(chatConversations.id, input.conversationId))
        .limit(1);
      if (!seed) throw notFound("Side Chat not found");
      const txRetention = tx as unknown as RuntimeRetentionDb;
      await lockRuntimeRetentionScope(txRetention, seed.orgId);
      // Serialize deletion with new generation/run FK references. Checking only
      // in the route allows a send to be admitted between the check and delete.
      const conversation = await tx.select().from(chatConversations)
        .where(eq(chatConversations.id, input.conversationId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!conversation || conversation.conversationKind !== "side_chat") throw notFound("Side Chat not found");
      assertOwner(conversation, input.userId);
      if (conversation.sideChatState === "kept" || conversation.messengerVisible) {
        throw conflict("A kept Side Chat is a normal Messenger chat");
      }
      if (hasActiveChatGeneration(conversation.id)) {
        throw conflict("Side Chat has an active response; stop it before closing");
      }
      const [generation] = await tx.select({ id: chatGenerations.id }).from(chatGenerations)
        .where(and(
          eq(chatGenerations.conversationId, conversation.id),
          inArray(chatGenerations.status, ACTIVE_CHAT_GENERATION_STATUSES),
        )).limit(1);
      const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.orgId, conversation.orgId),
          sideChatRunReference(conversation.id),
          or(inArray(heartbeatRuns.status, ["queued", "running"]),
            eq(heartbeatRuns.terminalEffectsPending, true)),
      )).limit(1);
      if (generation || run) throw conflict("Side Chat has an active response; stop it before closing");
      const [unverified] = await tx.select({ id: chatGenerations.id }).from(chatGenerations)
        .where(and(
          eq(chatGenerations.conversationId, conversation.id),
          or(
            isNull(chatGenerations.runtimeTerminalAt),
            inArray(chatGenerations.status, ["interrupted_unverified", "control_lost"]),
            eq(chatGenerations.controlState, "control_lost"),
          ),
        )).limit(1);
      if (unverified) throw conflict("Side Chat runtime termination is not verified");
      const [pendingClose] = await tx.select({ id: sideChatCloseIntents.id })
        .from(sideChatCloseIntents).where(and(
          eq(sideChatCloseIntents.orgId, conversation.orgId),
          eq(sideChatCloseIntents.conversationId, conversation.id),
        )).limit(1);
      if (pendingClose && pendingClose.id !== input.closeClaim?.id) {
        throw conflict("Side Chat has a pending close intent");
      }
      if (input.closeClaim) {
        const [intent] = await tx.select().from(sideChatCloseIntents).where(and(
          eq(sideChatCloseIntents.id, input.closeClaim.id),
          eq(sideChatCloseIntents.orgId, conversation.orgId),
          eq(sideChatCloseIntents.conversationId, conversation.id),
          eq(sideChatCloseIntents.ownerUserId, input.userId),
          eq(sideChatCloseIntents.state, "claimed"),
          eq(sideChatCloseIntents.leaseOwner, input.closeClaim.owner),
          eq(sideChatCloseIntents.leaseEpoch, input.closeClaim.epoch),
          gt(sideChatCloseIntents.leaseExpiresAt, new Date()),
        )).for("update").limit(1);
        if (!intent) throw conflict("Side Chat close claim is no longer current");
        const attachmentRows = await tx.select({
          orgId: chatAttachments.orgId,
          assetId: chatAttachments.assetId,
          assetOrgId: assets.orgId,
          objectKey: assets.objectKey,
          provider: assets.provider,
        }).from(chatAttachments).leftJoin(assets, and(
          eq(chatAttachments.assetId, assets.id),
          eq(assets.orgId, conversation.orgId),
        ))
          .where(eq(chatAttachments.conversationId, conversation.id));
        const attachmentsByAssetId = new Map<string, {
          orgId: string; assetId: string; objectKey: string; provider: string;
        }>();
        for (const row of attachmentRows) {
          if (row.orgId !== conversation.orgId || row.assetOrgId !== conversation.orgId
            || !row.objectKey || !row.provider) {
            throw conflict("Side Chat attachment identity is missing or outside its organization");
          }
          attachmentsByAssetId.set(row.assetId, {
            orgId: conversation.orgId,
            assetId: row.assetId,
            objectKey: row.objectKey,
            provider: row.provider,
          });
        }
        const queuedRows = await tx.select({ orgId: chatQueuedMessages.orgId, payload: chatQueuedMessages.payload })
          .from(chatQueuedMessages).where(eq(chatQueuedMessages.conversationId, conversation.id));
        const queuedAssetIds = new Set<string>();
        for (const row of queuedRows) {
          if (row.orgId !== conversation.orgId) {
            throw conflict("Side Chat queued attachment is outside its organization");
          }
          const state = queuedAnnotationAssetState(row.payload);
          if (Object.hasOwn(row.payload, QUEUED_ANNOTATION_ASSETS_KEY) && !state) {
            throw conflict("Side Chat queued attachment metadata is invalid");
          }
          for (const attachment of state?.attachments ?? []) queuedAssetIds.add(attachment.assetId);
        }
        if (queuedAssetIds.size > 0) {
          const queuedAssets = await tx.select({
            id: assets.id, orgId: assets.orgId, objectKey: assets.objectKey, provider: assets.provider,
          }).from(assets).where(inArray(assets.id, [...queuedAssetIds]));
          const queuedAssetById = new Map(queuedAssets.map((asset) => [asset.id, asset]));
          for (const assetId of queuedAssetIds) {
            const asset = queuedAssetById.get(assetId);
            if (!asset || asset.orgId !== conversation.orgId) {
              throw conflict("Side Chat queued attachment asset is missing or outside its organization");
            }
            attachmentsByAssetId.set(assetId, {
              orgId: conversation.orgId,
              assetId,
              objectKey: asset.objectKey,
              provider: asset.provider,
            });
          }
        }
        const attachments = [...attachmentsByAssetId.values()];
        await tx.update(sideChatCloseIntents).set({ attachmentsJson: attachments, updatedAt: new Date() })
          .where(eq(sideChatCloseIntents.id, intent.id));
      }
      const sideChatBindings = await tx.select({ id: runtimeBindings.id })
        .from(runtimeBindings)
        .where(and(
          eq(runtimeBindings.orgId, conversation.orgId),
          eq(runtimeBindings.conversationId, conversation.id),
        ))
        .for("update");
      const bindingIds = sideChatBindings.map(({ id }) => id);
      if (bindingIds.length > 0) {
        const [descendantBinding] = await tx.select({ id: runtimeBindings.id })
          .from(runtimeBindings)
          .where(and(
            eq(runtimeBindings.orgId, conversation.orgId),
            inArray(runtimeBindings.parentBindingId, bindingIds),
          ))
          .limit(1);
        if (descendantBinding) {
          throw conflict("Side Chat has native runtime descendants; keep it or resolve the descendant references first");
        }
      }
      await persistSideChatProviderCleanupIntents(tx as unknown as Db, {
        id: conversation.id,
        orgId: conversation.orgId,
        createdByUserId: conversation.createdByUserId,
        sideChatState: conversation.sideChatState,
        messengerVisible: conversation.messengerVisible,
      }, new Date());
      await releaseRuntimeRetentionClaimsInTransaction(txRetention, {
        orgId: conversation.orgId,
        purpose: sideChatRetentionPurpose(conversation.id),
        principalScopeRef: sideChatRetentionPrincipal(input.userId),
      });
      await deleteReleasedRuntimeRetentionClaimsInTransaction(txRetention, {
        orgId: conversation.orgId,
        purpose: sideChatRetentionPurpose(conversation.id),
        principalScopeRef: sideChatRetentionPrincipal(input.userId),
      });
      const deleted = await tx
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
    });
  }

  async function keepInMessenger(input: { conversationId: string; userId: string }) {
    const conversation = await getOwnedSideChat(input.conversationId, input.userId);

    const outcome = await db.transaction(async (tx) => {
      const txRetention = tx as unknown as RuntimeRetentionDb;
      await lockRuntimeRetentionScope(txRetention, conversation.orgId);
      const current = await tx
        .select()
        .from(chatConversations)
        .where(and(
          eq(chatConversations.id, conversation.id),
          eq(chatConversations.orgId, conversation.orgId),
          eq(chatConversations.conversationKind, "side_chat"),
          eq(chatConversations.createdByUserId, input.userId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!current) throw notFound("Side Chat not found");
      if (current.sideChatState === "kept" && current.messengerVisible) return "kept" as const;
      if (current.sideChatState !== "active") {
        throw conflict("Only an active Side Chat can be kept in Messenger");
      }
      const now = new Date();
      const expired = await tx
        .update(chatConversations)
        .set({
          sideChatState: "expired",
          sideChatExpiresAt: null,
          updatedAt: now,
        })
        .where(and(
          eq(chatConversations.id, current.id),
          eq(chatConversations.sideChatState, "active"),
          eq(chatConversations.messengerVisible, false),
          or(
            isNull(chatConversations.sideChatExpiresAt),
            lte(chatConversations.sideChatExpiresAt, now),
          ),
        ))
        .returning({ id: chatConversations.id });
      if (expired.length > 0) {
        await expireRuntimeRetentionClaimsInTransaction(txRetention, {
          orgId: current.orgId,
          purpose: sideChatRetentionPurpose(current.id),
          principalScopeRef: sideChatRetentionPrincipal(input.userId),
          now,
          force: true,
        });
        return "expired" as const;
      }

      await ensureSideChatRetentionClaim(txRetention, current, input.userId);

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
          eq(chatConversations.id, current.id),
          eq(chatConversations.sideChatState, "active"),
          eq(chatConversations.messengerVisible, false),
          gt(chatConversations.sideChatExpiresAt, now),
        ))
        .returning({ id: chatConversations.id });
      if (transitioned.length === 0) {
        const latest = await tx
          .select({ sideChatState: chatConversations.sideChatState, messengerVisible: chatConversations.messengerVisible })
          .from(chatConversations)
          .where(eq(chatConversations.id, current.id))
          .then((rows) => rows[0] ?? null);
        if (latest?.sideChatState === "kept" && latest.messengerVisible) return "kept" as const;
        throw conflict("Only an active Side Chat can be kept in Messenger");
      }

      const sourceConversationId = current.forkedFromConversationId;
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
        childConversationId: current.id,
        groupName: source.title,
      });
      await promoteRuntimeRetentionClaimsInTransaction(txRetention, {
        orgId: current.orgId,
        purpose: sideChatRetentionPurpose(current.id),
        principalScopeRef: sideChatRetentionPrincipal(input.userId),
      });
      return "kept" as const;
    });

    if (outcome === "expired") throw conflict("Side Chat expired");

    return hydrated(conversation.id, input.userId);
  }

  return {
    create,
    findExistingForCreate,
    requestClose,
    destroy,
    keepInMessenger,
    assertAccessible,
    assertMutable,
    touch,
  };
}
