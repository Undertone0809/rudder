import { Router } from "express";
import type { Db } from "@rudderhq/db";
import type { RunDiagnosticFindingStatus } from "@rudderhq/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { runDiagnosticsService } from "../services/run-diagnostics.js";
import { getObservedRun } from "../services/run-intelligence.js";
import { notFound } from "../errors.js";

function asPositiveLimit(value: unknown) {
  return Math.max(1, Math.min(200, Number(value ?? 50) || 50));
}

function asStatus(value: unknown): RunDiagnosticFindingStatus | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  if (!["open", "acknowledged", "resolved", "ignored", "needs_human", "converted_to_issue"].includes(value)) {
    return null;
  }
  return value as RunDiagnosticFindingStatus;
}

export function runDiagnosticRoutes(db: Db) {
  const router = Router();
  const svc = runDiagnosticsService(db);

  router.get("/orgs/:orgId/run-diagnostics", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    res.json(await svc.list({
      orgId,
      status: asStatus(req.query.status),
      runId: typeof req.query.runId === "string" ? req.query.runId : null,
      limit: asPositiveLimit(req.query.limit),
    }));
  });

  router.get("/orgs/:orgId/run-diagnostics/summary", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    res.json(await svc.summary(orgId));
  });

  router.patch("/orgs/:orgId/run-diagnostics/:findingId", async (req, res) => {
    const orgId = req.params.orgId as string;
    const findingId = req.params.findingId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    res.json(await svc.update(orgId, findingId, req.body));
  });

  router.post("/run-intelligence/runs/:runId/diagnostics/recompute", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await getObservedRun(db, runId);
    if (!run) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, run.run.orgId);
    assertBoard(req);
    res.json(await svc.analyzeRun(runId));
  });

  return router;
}
