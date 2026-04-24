import { Router } from "express";
import type { Db } from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import { joinRequests } from "@rudderhq/db";
import { sidebarBadgeService } from "../services/sidebar-badges.js";
import { accessService } from "../services/access.js";
import { chatService } from "../services/chats.js";
import { dashboardService } from "../services/dashboard.js";
import { issueService } from "../services/issues.js";
import { assertCompanyAccess } from "./authz.js";

export function sidebarBadgeRoutes(db: Db) {
  const router = Router();
  const svc = sidebarBadgeService(db);
  const access = accessService(db);
  const chats = chatService(db);
  const dashboard = dashboardService(db);
  const issues = issueService(db);
  const inboxIssueStatuses = "backlog,todo,in_progress,in_review,blocked,done";

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

    const summary = await dashboard.summary(orgId);
    const boardUserId = req.actor.type === "board" ? (req.actor.userId ?? "local-board") : null;
    const [touchedIssues, activeChats] = boardUserId
      ? await Promise.all([
        issues.list(orgId, {
          touchedByUserId: boardUserId,
          unreadForUserId: boardUserId,
          status: inboxIssueStatuses,
        }),
        chats.list(orgId, { status: "active" }, boardUserId),
      ])
      : [[], []];
    const unreadTouchedIssues = touchedIssues.length;
    const chatAttention = activeChats.filter((conversation) => conversation.needsAttention).length;

    const provisionalBadges = await svc.get(orgId, {
      joinRequests: joinRequestCount,
      unreadTouchedIssues,
      chatAttention,
    });
    const hasFailedRuns = provisionalBadges.failedRuns > 0;
    const alertsCount =
      (summary.agents.error > 0 && !hasFailedRuns ? 1 : 0) +
      (summary.costs.monthBudgetCents > 0 && summary.costs.monthUtilizationPercent >= 80 ? 1 : 0);
    const badges = await svc.get(orgId, {
      joinRequests: joinRequestCount,
      unreadTouchedIssues,
      chatAttention,
      alerts: alertsCount,
    });

    res.json(badges);
  });

  return router;
}
