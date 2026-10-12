import type { Db } from "@rudderhq/db";
import type { AgentSkillAnalytics } from "@rudderhq/shared";
import { Router, type Request } from "express";
import { sendOverviewRead } from "../services/overview-read-bridge.js";
import { heartbeatService } from "../services/runtime-kernel/heartbeat.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import { assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db, rustFoundation?: RustFoundationBridge) {
  const router = Router();
  const heartbeat = heartbeatService(db);

  function readSkillAnalyticsQuery(req: Request) {
    const rawWindowDays = typeof req.query.windowDays === "string"
      ? Number.parseInt(req.query.windowDays, 10)
      : undefined;
    const startDate = typeof req.query.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.startDate)
      ? req.query.startDate
      : undefined;
    const endDate = typeof req.query.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.endDate)
      ? req.query.endDate
      : undefined;

    return {
      windowDays: Number.isFinite(rawWindowDays) ? rawWindowDays : undefined,
      startDate,
      endDate,
    };
  }

  router.get("/orgs/:orgId/dashboard", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    await sendOverviewRead(db, res, rustFoundation, req.actor, orgId, { operation: "dashboard-summary" });
  });

  router.get("/orgs/:orgId/dashboard/skills/analytics", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    const analytics: AgentSkillAnalytics = await heartbeat.getOrganizationSkillAnalytics(
      orgId,
      readSkillAnalyticsQuery(req),
    );
    res.json(analytics);
  });

  return router;
}
