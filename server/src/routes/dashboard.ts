import { Router } from "express";
import type { Db } from "@rudderhq/db";
import { dashboardService } from "../services/dashboard.js";
import { assertCompanyAccess } from "./authz.js";

export function dashboardRoutes(db: Db) {
  const router = Router();
  const svc = dashboardService(db);

  router.get("/orgs/:orgId/dashboard", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const summary = await svc.summary(orgId);
    res.json(summary);
  });

  return router;
}
