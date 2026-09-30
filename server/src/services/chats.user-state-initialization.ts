import { chatConversations, chatConversationUserStates, type Db } from "@rudderhq/db";
import { and, asc, eq, or } from "drizzle-orm";

type ConversationRow = typeof chatConversations.$inferSelect;

export function createConversationUserStateInitializer(db: Db) {
  return async (rows: ConversationRow[], userId: string) => {
    if (rows.length === 0) return;
    const now = new Date();
    await db.transaction(async (tx) => {
      // A listing snapshot can outlive a concurrent deletion. Keep surviving
      // parent rows locked through initialization instead of swallowing FK errors.
      const parents = await tx.select({ id: chatConversations.id, orgId: chatConversations.orgId }).from(chatConversations)
        .where(or(...rows.map((row) => and(
          eq(chatConversations.orgId, row.orgId), eq(chatConversations.id, row.id),
        )))).orderBy(asc(chatConversations.id)).for("key share");
      const parentIds = new Set(parents.map((row) => `${row.orgId}:${row.id}`));
      const survivingRows = rows.filter((row) => parentIds.has(`${row.orgId}:${row.id}`));
      if (!survivingRows.length) return;
      await tx.insert(chatConversationUserStates).values(survivingRows.map((row) => ({
        orgId: row.orgId,
        conversationId: row.id,
        userId,
        lastReadAt: row.lastMessageAt ?? row.updatedAt ?? row.createdAt,
        updatedAt: now,
      }))).onConflictDoNothing();
    });
  };
}
