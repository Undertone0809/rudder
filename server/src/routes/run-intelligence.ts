import { Router } from "express";
import type { Db } from "@rudder/db";
import { notFound } from "../errors.js";
import {
  getObservedRun,
  getObservedRunEvents,
  getObservedRunLog,
  listObservedRuns,
} from "../services/run-intelligence.js";
import { assertCompanyAccess } from "./authz.js";

function asDateOrNull(value: unknown) {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function asString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function runIntelligenceRoutes(db: Db) {
  const router = Router();

  router.get("/run-intelligence/orgs/:orgId/runs", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    const rows = await listObservedRuns(db, {
      orgId,
      updatedAfter: asDateOrNull(req.query.updatedAfter),
      runIdPrefix: asString(req.query.runIdPrefix),
      agentId: asString(req.query.agentId),
      status: asString(req.query.status),
      runtime: asString(req.query.runtime),
      issueId: asString(req.query.issueId),
      createdBefore: asDateOrNull(req.query.createdBefore),
      limit: Math.max(1, Math.min(1000, Number(req.query.limit ?? 200) || 200)),
    });

    res.json(rows);
  });

  router.get("/run-intelligence/runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const row = await getObservedRun(db, runId);
    if (!row) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, row.run.orgId);
    res.json(row);
  });

  router.get("/run-intelligence/runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await getObservedRun(db, runId);
    if (!run) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, run.run.orgId);
    res.json(await getObservedRunEvents(db, runId));
  });

  router.get("/run-intelligence/runs/:runId/log", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await getObservedRun(db, runId);
    if (!run) throw notFound("Heartbeat run not found");
    assertCompanyAccess(req, run.run.orgId);
    res.json(await getObservedRunLog(db, runId));
  });

  return router;
}
