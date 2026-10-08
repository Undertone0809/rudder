import type { Db } from "@rudderhq/db";
import {
  createCostEventSchema,
  createFinanceEventSchema,
  resolveBudgetIncidentSchema,
  updateBudgetSchema,
  upsertBudgetPolicySchema,
} from "@rudderhq/shared";
import { sql } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  agentService,
  budgetService,
  costService,
  financeService,
  heartbeatService,
  logActivity,
  organizationService,
} from "../services/index.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import type { CostReadInput, RustFoundationBridge, RustFoundationResponse } from "../services/rust-foundation-bridge.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function costRoutes(db: Db, rustFoundationBridge?: RustFoundationBridge) {
  const router = Router();
  const heartbeat = heartbeatService(db);
  const budgetHooks = {
    cancelWorkForScope: heartbeat.cancelBudgetScopeWork,
  };
  const costs = costService(db, budgetHooks);
  const finance = financeService(db);
  const budgets = budgetService(db, budgetHooks);
  const organizations = organizationService(db);
  const agents = agentService(db);

  async function forwardCostRead(req: Request, res: Response, orgId: string, input: CostReadInput) {
    if (!rustFoundationBridge) {
      res.status(503).json({ error: "Rust Cost reads are unavailable", code: "rust_foundation_cost_read_unavailable" });
      return;
    }
    let response: RustFoundationResponse;
    try {
      if (input.operation === "finance-events") {
        // Date-parsing context only: SQLx defaults to UTC while this legacy
        // connection may use a database/role/connection-specific timezone.
        // Rust still owns finance table reads, filtering, sorting and projection.
        const [context] = await db.execute(sql<{ timezone: string }>`SELECT current_setting('TimeZone') AS timezone`);
        if (typeof context?.timezone !== "string") throw new Error("Missing database date context");
        input = { ...input, legacyDateTimezone: context.timezone };
      }
      response = await rustFoundationBridge.costRead(req.actor, orgId, input);
    } catch {
      res.status(503).json({ error: "Rust Cost reads are unavailable", code: "rust_foundation_cost_read_request_failed" });
      return;
    }
    res.status(response.status).set("content-type", response.contentType).send(response.body);
  }

  function rangeInput(range: ReturnType<typeof parseDateRange>) {
    return { fromMs: range?.from?.getTime(), toMs: range?.to?.getTime() };
  }

  router.post("/orgs/:orgId/cost-events", validate(createCostEventSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only report its own costs" });
      return;
    }

    const event = await costs.createEvent(orgId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "cost.reported",
      entityType: "cost_event",
      entityId: event.id,
      details: { costCents: event.costCents, model: event.model },
    });

    res.status(201).json(event);
  });

  router.post("/orgs/:orgId/finance-events", validate(createFinanceEventSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);

    const event = await finance.createEvent(orgId, {
      ...req.body,
      occurredAt: new Date(req.body.occurredAt),
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "finance_event.reported",
      entityType: "finance_event",
      entityId: event.id,
      details: {
        amountCents: event.amountCents,
        biller: event.biller,
        eventKind: event.eventKind,
        direction: event.direction,
      },
    });

    res.status(201).json(event);
  });

  function parseDateRange(query: Record<string, unknown>) {
    const fromRaw = query.from as string | undefined;
    const toRaw = query.to as string | undefined;
    const from = fromRaw ? new Date(fromRaw) : undefined;
    const to = toRaw ? new Date(toRaw) : undefined;
    if (from && isNaN(from.getTime())) throw badRequest("invalid 'from' date");
    if (to && isNaN(to.getTime())) throw badRequest("invalid 'to' date");
    if (from && to && from > to) throw badRequest("'from' date must not be later than 'to' date");
    return (from || to) ? { from, to } : undefined;
  }

  function parseTrendGranularity(query: Record<string, unknown>) {
    const granularity = firstQueryValue(query.granularity) ?? "day";
    if (granularity !== "hour" && granularity !== "day") {
      throw badRequest("invalid 'granularity' value");
    }
    return granularity;
  }

  function parseLimit(query: Record<string, unknown>) {
    const raw = Array.isArray(query.limit) ? query.limit[0] : query.limit;
    if (raw == null || raw === "") return 100;
    const limit = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
      throw badRequest("invalid 'limit' value");
    }
    return limit;
  }

  function firstQueryValue(value: unknown): string | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== "string") return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  function parseTrendFilter(query: Record<string, unknown>) {
    const agentId = firstQueryValue(query.agentId);
    const projectId = firstQueryValue(query.projectId);
    return agentId || projectId ? { agentId, projectId } : undefined;
  }

  router.get("/orgs/:orgId/costs/summary", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    await forwardCostRead(req, res, orgId, { operation: "summary", ...rangeInput(range) });
  });

  router.get("/orgs/:orgId/costs/by-agent", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    await forwardCostRead(req, res, orgId, { operation: "by-agent", ...rangeInput(range) });
  });

  router.get("/orgs/:orgId/costs/trend", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    const granularity = parseTrendGranularity(req.query);
    const filter = parseTrendFilter(req.query);
    await forwardCostRead(req, res, orgId, { operation: "trend", ...rangeInput(range), granularity, ...filter });
  });

  router.get("/orgs/:orgId/costs/by-agent-model", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    await forwardCostRead(req, res, orgId, { operation: "by-agent-model", ...rangeInput(range) });
  });

  router.get("/orgs/:orgId/costs/by-provider", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    await forwardCostRead(req, res, orgId, { operation: "by-provider", ...rangeInput(range) });
  });

  router.get("/orgs/:orgId/costs/by-biller", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    await forwardCostRead(req, res, orgId, { operation: "by-biller", ...rangeInput(range) });
  });

  router.get("/orgs/:orgId/costs/finance-summary", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    await forwardCostRead(req, res, orgId, { operation: "finance-summary", ...rangeInput(range) });
  });

  router.get("/orgs/:orgId/costs/finance-by-biller", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    await forwardCostRead(req, res, orgId, { operation: "finance-by-biller", ...rangeInput(range) });
  });

  router.get("/orgs/:orgId/costs/finance-by-kind", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    await forwardCostRead(req, res, orgId, { operation: "finance-by-kind", ...rangeInput(range) });
  });

  router.get("/orgs/:orgId/costs/finance-events", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    const limit = parseLimit(req.query);
    await forwardCostRead(req, res, orgId, { operation: "finance-events", ...rangeInput(range), limit });
  });

  router.get("/orgs/:orgId/costs/window-spend", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    await forwardCostRead(req, res, orgId, { operation: "window-spend" });
  });

  router.get("/orgs/:orgId/costs/quota-windows", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    // validate orgId resolves to a real organization so the "__none__" sentinel
    // and any forged ids are rejected before we touch provider credentials
    const organization = await organizations.getById(orgId);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const results = await fetchAllQuotaWindows();
    res.json(results);
  });

  router.get("/orgs/:orgId/budgets/overview", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const overview = await budgets.overview(orgId);
    res.json(overview);
  });

  router.post(
    "/orgs/:orgId/budgets/policies",
    validate(upsertBudgetPolicySchema),
    async (req, res) => {
      assertBoard(req);
      const orgId = req.params.orgId as string;
      assertCompanyAccess(req, orgId);
      const summary = await budgets.upsertPolicy(orgId, req.body, req.actor.userId ?? "board");
      res.json(summary);
    },
  );

  router.delete("/orgs/:orgId/budgets/policies/:policyId", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    const policyId = req.params.policyId as string;
    assertCompanyAccess(req, orgId);
    const result = await budgets.deletePolicy(orgId, policyId, req.actor.userId ?? "board");
    res.json(result);
  });

  router.post(
    "/orgs/:orgId/budget-incidents/:incidentId/resolve",
    validate(resolveBudgetIncidentSchema),
    async (req, res) => {
      assertBoard(req);
      const orgId = req.params.orgId as string;
      const incidentId = req.params.incidentId as string;
      assertCompanyAccess(req, orgId);
      const incident = await budgets.resolveIncident(orgId, incidentId, req.body, req.actor.userId ?? "board");
      res.json(incident);
    },
  );

  router.get("/orgs/:orgId/costs/by-project", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    await forwardCostRead(req, res, orgId, { operation: "by-project", ...rangeInput(range) });
  });

  router.patch("/orgs/:orgId/budgets", validate(updateBudgetSchema), async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const organization = await organizations.update(orgId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    await logActivity(db, {
      orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "organization.budget_updated",
      entityType: "organization",
      entityId: orgId,
      details: { budgetMonthlyCents: req.body.budgetMonthlyCents },
    });

    await budgets.upsertPolicy(
      orgId,
      {
        scopeType: "organization",
        scopeId: orgId,
        amount: req.body.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      req.actor.userId ?? "board",
    );

    res.json(organization);
  });

  router.patch("/agents/:agentId/budgets", validate(updateBudgetSchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await agents.getById(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    assertCompanyAccess(req, agent.orgId);

    if (req.actor.type === "agent") {
      if (req.actor.agentId !== agentId) {
        res.status(403).json({ error: "Agent can only change its own budget" });
        return;
      }
    }

    const updated = await agents.update(agentId, { budgetMonthlyCents: req.body.budgetMonthlyCents });
    if (!updated) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: updated.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "agent.budget_updated",
      entityType: "agent",
      entityId: updated.id,
      details: { budgetMonthlyCents: updated.budgetMonthlyCents },
    });

    await budgets.upsertPolicy(
      updated.orgId,
      {
        scopeType: "agent",
        scopeId: updated.id,
        amount: updated.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    );

    res.json(updated);
  });

  return router;
}
