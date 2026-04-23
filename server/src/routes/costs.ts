import { Router } from "express";
import type { Db } from "@rudder/db";
import {
  createCostEventSchema,
  createFinanceEventSchema,
  resolveBudgetIncidentSchema,
  updateBudgetSchema,
  upsertBudgetPolicySchema,
} from "@rudder/shared";
import { validate } from "../middleware/validate.js";
import {
  budgetService,
  costService,
  financeService,
  organizationService,
  agentService,
  heartbeatService,
  logActivity,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import { badRequest } from "../errors.js";

export function costRoutes(db: Db) {
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
    return (from || to) ? { from, to } : undefined;
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

  router.get("/orgs/:orgId/costs/summary", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    const summary = await costs.summary(orgId, range);
    res.json(summary);
  });

  router.get("/orgs/:orgId/costs/by-agent", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    const rows = await costs.byAgent(orgId, range);
    res.json(rows);
  });

  router.get("/orgs/:orgId/costs/by-agent-model", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    const rows = await costs.byAgentModel(orgId, range);
    res.json(rows);
  });

  router.get("/orgs/:orgId/costs/by-provider", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    const rows = await costs.byProvider(orgId, range);
    res.json(rows);
  });

  router.get("/orgs/:orgId/costs/by-biller", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    const rows = await costs.byBiller(orgId, range);
    res.json(rows);
  });

  router.get("/orgs/:orgId/costs/finance-summary", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    const summary = await finance.summary(orgId, range);
    res.json(summary);
  });

  router.get("/orgs/:orgId/costs/finance-by-biller", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    const rows = await finance.byBiller(orgId, range);
    res.json(rows);
  });

  router.get("/orgs/:orgId/costs/finance-by-kind", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    const rows = await finance.byKind(orgId, range);
    res.json(rows);
  });

  router.get("/orgs/:orgId/costs/finance-events", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const range = parseDateRange(req.query);
    const limit = parseLimit(req.query);
    const rows = await finance.list(orgId, range, limit);
    res.json(rows);
  });

  router.get("/orgs/:orgId/costs/window-spend", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const rows = await costs.windowSpend(orgId);
    res.json(rows);
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
    const rows = await costs.byProject(orgId, range);
    res.json(rows);
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
