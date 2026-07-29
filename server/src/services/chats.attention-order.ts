import type { Db } from "@rudderhq/db";
import {
  approvals,
  chatGenerations,
  chatMessages,
} from "@rudderhq/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { ACTIVE_CHAT_GENERATION_STATUSES } from "./chats.constants.js";

export async function listActiveChatGenerationIds(
  db: Db,
  orgId: string,
  conversationIds: string[],
) {
  if (conversationIds.length === 0) return new Map<string, string>();
  const rows = await db
    .select({
      conversationId: chatGenerations.conversationId,
      generationId: chatGenerations.id,
    })
    .from(chatGenerations)
    .where(and(
      eq(chatGenerations.orgId, orgId),
      inArray(chatGenerations.conversationId, conversationIds),
      inArray(chatGenerations.status, ACTIVE_CHAT_GENERATION_STATUSES),
    ))
    .orderBy(desc(chatGenerations.startedAt), desc(chatGenerations.createdAt));
  const idsByConversation = new Map<string, string>();
  for (const row of rows) {
    if (!idsByConversation.has(row.conversationId)) {
      idsByConversation.set(row.conversationId, row.generationId);
    }
  }
  return idsByConversation;
}

export async function listPendingChatProposalConversationIds(
  db: Db,
  orgId: string,
  conversationIds: string[],
) {
  if (conversationIds.length === 0) return new Set<string>();
  const rows = await db
    .select({ conversationId: chatMessages.conversationId })
    .from(chatMessages)
    .innerJoin(approvals, eq(chatMessages.approvalId, approvals.id))
    .where(and(
      eq(chatMessages.orgId, orgId),
      inArray(chatMessages.conversationId, conversationIds),
      isNull(chatMessages.supersededAt),
      eq(approvals.status, "pending"),
    ))
    .groupBy(chatMessages.conversationId);
  return new Set(rows.map((row) => row.conversationId));
}
