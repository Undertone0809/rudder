import type { Db } from "@rudderhq/db";
import { assets, chatAttachments, chatConversations, chatMessages } from "@rudderhq/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { notFound, unprocessable } from "../errors.js";
import { contentPath } from "./chats.helpers.js";
import { removeMessengerCustomGroupEntriesForItem } from "./messenger-saved-views.js";
import { lockNodeMutationAuthority } from "./organization-mutation-fence.js";

type ChatMutationContext = {
  db: Db;
  getConversationOrThrow: (id: string) => Promise<{ orgId: string }>;
};

export function createChatMutationMethods(context: ChatMutationContext) {
  const { db, getConversationOrThrow } = context;

  async function remove(id: string) {
    return db.transaction(async (tx) => {
      const conversation = await tx
        .select({ orgId: chatConversations.orgId })
        .from(chatConversations)
        .where(eq(chatConversations.id, id))
        .then((rows) => rows[0] ?? null);
      if (!conversation) return null;
      await lockNodeMutationAuthority(tx, conversation.orgId);
      const attachmentRows = await tx
        .select({ assetId: chatAttachments.assetId })
        .from(chatAttachments)
        .where(eq(chatAttachments.conversationId, id));
      const [deleted] = await tx
        .delete(chatConversations)
        .where(eq(chatConversations.id, id))
        .returning();
      if (!deleted) return null;
      await removeMessengerCustomGroupEntriesForItem(tx, deleted.orgId, `chat:${deleted.id}`);
      const assetIds = [...new Set(attachmentRows.map((row) => row.assetId))];
      if (assetIds.length > 0) {
        await tx.delete(assets).where(and(
          inArray(assets.id, assetIds),
          sql<boolean>`not exists (
            select 1 from ${chatAttachments}
            where ${chatAttachments.assetId} = ${assets.id}
          )`,
        ));
      }
      return deleted;
    });
  }

  async function createAttachment(input: {
    orgId: string;
    conversationId: string;
    messageId: string;
    provider: string;
    objectKey: string;
    contentType: string;
    byteSize: number;
    sha256: string;
    originalFilename: string | null;
    createdByAgentId: string | null;
    createdByUserId: string | null;
  }) {
    const conversation = await getConversationOrThrow(input.conversationId);
    if (conversation.orgId !== input.orgId) {
      throw unprocessable("Chat conversation does not belong to organization");
    }
    const message = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.id, input.messageId), eq(chatMessages.conversationId, input.conversationId)))
      .then((rows) => rows[0] ?? null);
    if (!message) throw notFound("Chat message not found");

    return db.transaction(async (tx) => {
      await lockNodeMutationAuthority(tx, input.orgId);
      const [asset] = await tx
        .insert(assets)
        .values({
          orgId: input.orgId,
          provider: input.provider,
          objectKey: input.objectKey,
          contentType: input.contentType,
          byteSize: input.byteSize,
          sha256: input.sha256,
          originalFilename: input.originalFilename,
          createdByAgentId: input.createdByAgentId,
          createdByUserId: input.createdByUserId,
        })
        .returning();
      if (!asset) throw new Error("Failed to create asset");

      const [attachment] = await tx
        .insert(chatAttachments)
        .values({
          orgId: input.orgId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          assetId: asset.id,
        })
        .returning();
      if (!attachment) throw new Error("Failed to create chat attachment");

      return {
        ...attachment,
        provider: asset.provider,
        objectKey: asset.objectKey,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
        sha256: asset.sha256,
        originalFilename: asset.originalFilename,
        createdByAgentId: asset.createdByAgentId,
        createdByUserId: asset.createdByUserId,
        contentPath: contentPath(asset.id),
      };
    });
  }

  async function removeAttachment(attachmentId: string) {
    return db.transaction(async (tx) => {
      const existing = await tx
        .select({
          id: chatAttachments.id,
          orgId: chatAttachments.orgId,
          assetId: chatAttachments.assetId,
          objectKey: assets.objectKey,
        })
        .from(chatAttachments)
        .innerJoin(assets, eq(chatAttachments.assetId, assets.id))
        .where(eq(chatAttachments.id, attachmentId))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      await lockNodeMutationAuthority(tx, existing.orgId);
      await tx.delete(chatAttachments).where(eq(chatAttachments.id, attachmentId));
      const hasRemainingAttachment = await tx
        .select({ id: chatAttachments.id })
        .from(chatAttachments)
        .where(eq(chatAttachments.assetId, existing.assetId))
        .limit(1)
        .then((rows) => rows.length > 0);
      if (!hasRemainingAttachment) {
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
      }
      return {
        orgId: existing.orgId,
        objectKey: existing.objectKey,
        assetDeleted: !hasRemainingAttachment,
      };
    });
  }

  return { createAttachment, remove, removeAttachment };
}
