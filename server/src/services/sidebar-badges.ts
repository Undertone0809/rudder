import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import type { Db } from "@rudder/db";
import { agents, approvals, heartbeatRuns } from "@rudder/db";
import type { SidebarBadges } from "@rudder/shared";

const ACTIONABLE_APPROVAL_STATUSES = ["pending", "revision_requested"];
const FAILED_HEARTBEAT_STATUSES = ["failed", "timed_out"];

export function sidebarBadgeService(db: Db) {
  return {
    get: async (
      orgId: string,
      extra?: {
        joinRequests?: number;
        unreadTouchedIssues?: number;
        chatAttention?: number;
        alerts?: number;
      },
    ): Promise<SidebarBadges> => {
      const actionableApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(
          and(
            eq(approvals.orgId, orgId),
            inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0));

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

      const failedRuns = latestRunByAgent.filter((row) =>
        FAILED_HEARTBEAT_STATUSES.includes(row.runStatus),
      ).length;

      const joinRequests = extra?.joinRequests ?? 0;
      const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;
      const chatAttention = extra?.chatAttention ?? 0;
      const alerts = extra?.alerts ?? 0;
      return {
        inbox:
          actionableApprovals +
          failedRuns +
          joinRequests +
          unreadTouchedIssues +
          chatAttention +
          alerts,
        approvals: actionableApprovals,
        failedRuns,
        joinRequests,
        unreadTouchedIssues,
        chatAttention,
        alerts,
      };
    },
  };
}
