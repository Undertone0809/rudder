import type { Db } from "@rudderhq/db";
import {
  agentIntegrationChatBindings,
  agents,
  approvals,
  chatConversationUserStates,
  chatConversations,
  chatMessages,
  heartbeatRuns,
} from "@rudderhq/db";
import type { SidebarBadges } from "@rudderhq/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { visibleIncomingMessageSql } from "./chats.helpers.js";
import { messengerService } from "./messenger.js";

const ACTIONABLE_APPROVAL_STATUSES = ["pending"];

type SidebarBadgeBaseCounts = {
  approvals: number;
  failedRuns: number;
};

type SidebarBadgeExtraCounts = {
  joinRequests?: number;
  unreadTouchedIssues?: number;
  chatAttention?: number;
  alerts?: number;
};

function buildBadges(
  base: SidebarBadgeBaseCounts,
  extra?: SidebarBadgeExtraCounts,
): SidebarBadges {
  const joinRequests = extra?.joinRequests ?? 0;
  const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;
  const chatAttention = extra?.chatAttention ?? 0;
  const alerts = extra?.alerts ?? 0;
  return {
    inbox:
      base.approvals +
      base.failedRuns +
      joinRequests +
      unreadTouchedIssues +
      chatAttention +
      alerts,
    approvals: base.approvals,
    failedRuns: base.failedRuns,
    joinRequests,
    unreadTouchedIssues,
    chatAttention,
    alerts,
  };
}

export function sidebarBadgeService(db: Db) {
  const messengerSvc = messengerService(db);

  async function countActionableApprovals(orgId: string) {
    return db
      .select({ count: sql<number>`count(*)` })
      .from(approvals)
      .where(
        and(
          eq(approvals.orgId, orgId),
          inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));
  }

  async function countFailedLatestRuns(orgId: string) {
    const rows = await db.execute(sql<{ count: number }>`
      select count(*)::int as count
      from (
        select
          ${heartbeatRuns.status} as run_status,
          row_number() over (
            partition by ${heartbeatRuns.agentId}
            order by ${heartbeatRuns.createdAt} desc
          ) as run_rank
        from ${heartbeatRuns}
        inner join ${agents}
          on ${heartbeatRuns.agentId} = ${agents.id}
          and ${agents.orgId} = ${orgId}
        where ${heartbeatRuns.orgId} = ${orgId}
          and ${agents.status} <> 'terminated'
      ) latest_agent_runs
      where latest_agent_runs.run_rank = 1
        and latest_agent_runs.run_status in ('failed', 'timed_out')
    `);

    return Number(rows[0]?.count ?? 0);
  }

  async function ensureActiveChatUserStates(orgId: string, userId: string) {
    await db.execute(sql`
      insert into chat_conversation_user_states (
        org_id,
        conversation_id,
        user_id,
        last_read_at,
        updated_at
      )
      select
        ${chatConversations.orgId},
        ${chatConversations.id},
        ${userId},
        coalesce(${chatConversations.lastMessageAt}, ${chatConversations.updatedAt}, ${chatConversations.createdAt}),
        now()
      from ${chatConversations}
      where ${chatConversations.orgId} = ${orgId}
        and ${chatConversations.status} = 'active'
      on conflict (org_id, conversation_id, user_id) do nothing
    `);
  }

  return {
    countUnreadTouchedIssues: async (orgId: string, userId: string) => {
      return messengerSvc.countUnreadIssueThreadEntries(orgId, userId);
    },

    countActiveChatAttention: async (orgId: string, userId: string) => {
      await ensureActiveChatUserStates(orgId, userId);

      return db
        .select({ count: sql<number>`count(*)` })
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.orgId, orgId),
            eq(chatConversations.status, "active"),
            sql<boolean>`(
              exists (
                select 1
                from ${chatMessages}
                inner join ${chatConversationUserStates}
                  on ${chatConversationUserStates.orgId} = ${orgId}
                  and ${chatConversationUserStates.userId} = ${userId}
                  and ${chatConversationUserStates.conversationId} = ${chatMessages.conversationId}
                where ${chatMessages.orgId} = ${orgId}
                  and ${chatMessages.conversationId} = ${chatConversations.id}
                  and ${chatMessages.supersededAt} is null
                  and ${visibleIncomingMessageSql()}
                  and ${chatMessages.createdAt} > ${chatConversationUserStates.lastReadAt}
                  and not exists (
                    select 1
                    from ${agentIntegrationChatBindings}
                    where ${agentIntegrationChatBindings.orgId} = ${orgId}
                      and ${agentIntegrationChatBindings.conversationId} = ${chatMessages.conversationId}
                  )
              )
              or exists (
                select 1
                from ${chatMessages}
                inner join ${approvals} on ${chatMessages.approvalId} = ${approvals.id}
                where ${chatMessages.orgId} = ${orgId}
                  and ${chatMessages.conversationId} = ${chatConversations.id}
                  and ${chatMessages.supersededAt} is null
                  and ${approvals.orgId} = ${orgId}
                  and ${approvals.status} = 'pending'
                  and not exists (
                    select 1
                    from ${agentIntegrationChatBindings}
                    where ${agentIntegrationChatBindings.orgId} = ${orgId}
                      and ${agentIntegrationChatBindings.conversationId} = ${chatMessages.conversationId}
                  )
              )
            )`,
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0));
    },

    getBaseCounts: async (orgId: string): Promise<SidebarBadgeBaseCounts> => {
      const [approvals, failedRuns] = await Promise.all([
        countActionableApprovals(orgId),
        countFailedLatestRuns(orgId),
      ]);
      return { approvals, failedRuns };
    },

    get: async (
      orgId: string,
      extra?: SidebarBadgeExtraCounts,
    ): Promise<SidebarBadges> => {
      const [approvals, failedRuns] = await Promise.all([
        countActionableApprovals(orgId),
        countFailedLatestRuns(orgId),
      ]);
      return buildBadges({ approvals, failedRuns }, extra);
    },

    fromCounts: buildBadges,
  };
}
