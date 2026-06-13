import type { Db } from "@rudderhq/db";
import { joinRequests } from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import { Router } from "express";
import { accessService } from "../services/access.js";
import { dashboardService } from "../services/dashboard.js";
import { sidebarBadgeService } from "../services/sidebar-badges.js";
import { assertCompanyAccess } from "./authz.js";

export function sidebarBadgeRoutes(db: Db) {
  const router = Router();
  const svc = sidebarBadgeService(db);
  const access = accessService(db);
  const dashboard = dashboardService(db);

  router.get("/orgs/:orgId/sidebar-badges", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    let canApproveJoins = false;
    if (req.actor.type === "board") {
      canApproveJoins =
        req.actor.source === "local_implicit" ||
        Boolean(req.actor.isInstanceAdmin) ||
        (await access.canUser(orgId, req.actor.userId, "joins:approve"));
    } else if (req.actor.type === "agent" && req.actor.agentId) {
      canApproveJoins = await access.hasPermission(orgId, "agent", req.actor.agentId, "joins:approve");
    }

    const joinRequestCount = canApproveJoins
      ? await db
        .select({ count: sql<number>`count(*)` })
        .from(joinRequests)
        .where(and(eq(joinRequests.orgId, orgId), eq(joinRequests.status, "pending_approval")))
        .then((rows) => Number(rows[0]?.count ?? 0))
      : 0;

    const boardUserId = req.actor.type === "board" ? (req.actor.userId ?? "local-board") : null;
    const [
      summary,
      baseCounts,
      unreadTouchedIssues,
      chatAttention,
    ] = await Promise.all([
      dashboard.summary(orgId),
      svc.getBaseCounts(orgId),
      boardUserId
        ? svc.countUnreadTouchedIssues(orgId, boardUserId)
        : Promise.resolve(0),
      boardUserId
        ? svc.countActiveChatAttention(orgId, boardUserId)
        : Promise.resolve(0),
    ]);
    const hasFailedRuns = baseCounts.failedRuns > 0;
    const alertsCount =
      (summary.agents.error > 0 && !hasFailedRuns ? 1 : 0) +
      (summary.costs.monthBudgetCents > 0 && summary.costs.monthUtilizationPercent >= 80 ? 1 : 0);
    const badges = svc.fromCounts(baseCounts, {
      joinRequests: joinRequestCount,
      unreadTouchedIssues,
      chatAttention,
      alerts: alertsCount,
    });

    res.json(badges);
  });

  return router;
}
