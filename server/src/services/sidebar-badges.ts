import { and, desc, eq, inArray, isNull, ne, not, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  agents,
  approvals,
  chatConversationUserStates,
  chatConversations,
  chatMessages,
  heartbeatRuns,
  issues,
} from "@rudderhq/db";
import type { SidebarBadges } from "@rudderhq/shared";
import {
  touchedByUserCondition,
  unreadForUserCondition,
} from "./issues.helpers.js";
import { visibleIncomingMessageSql } from "./chats.helpers.js";

const ACTIONABLE_APPROVAL_STATUSES = ["pending"];
const FAILED_HEARTBEAT_STATUSES = ["failed", "timed_out"];
const INBOX_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done"];

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
    const latestRunByAgent = await db
      .selectDistinctOn([heartbeatRuns.agentId], {
        runStatus: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.orgId, orgId),
          eq(agents.orgId, orgId),
          not(eq(agents.status, "terminated")),
        ),
      )
      .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt));

    return latestRunByAgent.filter((row) =>
      FAILED_HEARTBEAT_STATUSES.includes(row.runStatus),
    ).length;
  }

  async function ensureActiveChatUserStates(orgId: string, userId: string) {
    const activeConversations = await db
      .select({
        orgId: chatConversations.orgId,
        conversationId: chatConversations.id,
        lastMessageAt: chatConversations.lastMessageAt,
        updatedAt: chatConversations.updatedAt,
        createdAt: chatConversations.createdAt,
      })
      .from(chatConversations)
      .where(and(eq(chatConversations.orgId, orgId), eq(chatConversations.status, "active")));

    if (activeConversations.length === 0) return;

    await db
      .insert(chatConversationUserStates)
      .values(
        activeConversations.map((row) => ({
          orgId: row.orgId,
          conversationId: row.conversationId,
          userId,
          lastReadAt: row.lastMessageAt ?? row.updatedAt ?? row.createdAt,
          updatedAt: new Date(),
        })),
      )
      .onConflictDoNothing();
  }

  return {
    countUnreadTouchedIssues: async (orgId: string, userId: string) => {
      return db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(
          and(
            eq(issues.orgId, orgId),
            inArray(issues.status, INBOX_ISSUE_STATUSES),
            touchedByUserCondition(orgId, userId),
            unreadForUserCondition(orgId, userId),
            ne(issues.originKind, "automation_execution"),
            isNull(issues.hiddenAt),
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0));
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
    constants: {
      inboxIssueStatuses: INBOX_ISSUE_STATUSES,
    },
  };
}
