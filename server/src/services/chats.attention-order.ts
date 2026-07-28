import type { Db } from "@rudderhq/db";
import {
  agentIntegrationChatBindings,
  approvals,
  chatConversations,
  chatConversationUserStates,
  chatGenerations,
  chatMessages,
} from "@rudderhq/db";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { ACTIVE_CHAT_GENERATION_STATUSES } from "./chats.constants.js";
import { visibleIncomingMessageSql } from "./chats.helpers.js";

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

export function chatSummaryAttentionSql(orgId: string, userId?: string | null) {
  const activityAtSql =
    sql<Date>`coalesce(${chatConversations.lastMessageAt}, ${chatConversations.updatedAt})`;
  const threadKeySql = sql<string>`'chat:' || ${chatConversations.id}`;
  const hasActiveGenerationSql = sql<boolean>`exists (
    select 1
    from ${chatGenerations}
    where ${chatGenerations.orgId} = ${orgId}
      and ${chatGenerations.conversationId} = ${chatConversations.id}
      and ${inArray(chatGenerations.status, ACTIVE_CHAT_GENERATION_STATUSES)}
  )`;
  const needsAttentionSql = userId
    ? sql<boolean>`not exists (
        select 1
        from ${agentIntegrationChatBindings}
        where ${agentIntegrationChatBindings.orgId} = ${orgId}
          and ${agentIntegrationChatBindings.conversationId} = ${chatConversations.id}
      ) and (
        exists (
          select 1
          from ${chatMessages}
          inner join ${chatConversationUserStates}
            on ${chatConversationUserStates.orgId} = ${orgId}
           and ${chatConversationUserStates.userId} = ${userId}
           and ${chatConversationUserStates.conversationId} = ${chatMessages.conversationId}
          where ${chatMessages.orgId} = ${orgId}
            and ${chatMessages.conversationId} = ${chatConversations.id}
            and ${isNull(chatMessages.supersededAt)}
            and ${visibleIncomingMessageSql()}
            and ${gt(chatMessages.createdAt, chatConversationUserStates.lastReadAt)}
        )
        or exists (
          select 1
          from ${chatMessages}
          inner join ${approvals} on ${approvals.id} = ${chatMessages.approvalId}
          where ${chatMessages.orgId} = ${orgId}
            and ${chatMessages.conversationId} = ${chatConversations.id}
            and ${isNull(chatMessages.supersededAt)}
            and ${approvals.status} = 'pending'
        )
      )`
    : sql<boolean>`false`;
  const attentionRankSql = sql<number>`case
    when ${needsAttentionSql} then 0
    when ${hasActiveGenerationSql} then 1
    else 2
  end`;
  return { activityAtSql, attentionRankSql, threadKeySql };
}
