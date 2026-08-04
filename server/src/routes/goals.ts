import type { Db } from "@rudderhq/db";
import {
  activateGoalSchema,
  assignGoalOwnerSchema,
  createGoalActivitySchema,
  createGoalSchema,
  evaluateGoalSchema,
  setGoalFocusSchema,
  updateGoalPlanSchema,
  updateGoalSchema,
} from "@rudderhq/shared";
import { Router } from "express";
import { validate } from "../middleware/validate.js";
import { goalService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function goalRoutes(db: Db) {
  const router = Router();
  const svc = goalService(db);

  async function loadAuthorizedGoal(req: Parameters<typeof assertCompanyAccess>[0], id: string) {
    const goal = await svc.getById(id);
    if (!goal) return null;
    assertCompanyAccess(req, goal.orgId);
    return goal;
  }

  router.get("/orgs/:orgId/goals", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    res.json(await svc.list(orgId));
  });

  router.get("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const goal = await loadAuthorizedGoal(req, id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    res.json(await svc.detail(id));
  });

  router.get("/goals/:id/dependencies", async (req, res) => {
    const id = req.params.id as string;
    const goal = await loadAuthorizedGoal(req, id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    res.json(await svc.dependencies(goal));
  });

  router.get("/goals/:id/activities", async (req, res) => {
    const id = req.params.id as string;
    if (!await loadAuthorizedGoal(req, id)) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    res.json(await svc.listActivities(id));
  });

  router.post("/orgs/:orgId/goals", validate(createGoalSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const goal = await svc.create(orgId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.created",
      entityType: "goal",
      entityId: goal.id,
      details: { lifecycle: goal.lifecycle, title: goal.title },
    });
    res.status(201).json(goal);
  });

  router.patch("/goals/:id", validate(updateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const goal = await svc.update(id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: goal!.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.updated",
      entityType: "goal",
      entityId: id,
      details: req.body,
    });
    res.json(goal);
  });

  router.post("/goals/:id/activate", validate(activateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const goal = await svc.activate(id, req.body, actor.agentId);
    await logActivity(db, {
      orgId: goal.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.activated",
      entityType: "goal",
      entityId: id,
      details: { ownerAgentId: goal.ownerAgentId, objectiveMode: goal.objectiveMode },
    });
    res.json(await svc.detail(id));
  });

  router.post("/goals/:id/plan", validate(updateGoalPlanSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const plan = await svc.updatePlan(id, req.body, actor.agentId);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.plan_updated",
      entityType: "goal",
      entityId: id,
      details: { revision: plan.revision },
    });
    res.status(201).json(plan);
  });

  router.post("/goals/:id/activities", validate(createGoalActivitySchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const activity = await svc.createActivity(id, req.body, actor.agentId);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.activity_added",
      entityType: "goal",
      entityId: id,
      details: { activityId: activity?.id, activityKind: activity?.activityKind },
      idempotencyKey: req.body.idempotencyKey ?? null,
    });
    res.status(201).json(activity);
  });

  router.post("/goals/:id/owner", validate(assignGoalOwnerSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const assignment = await svc.assignOwner(id, req.body, actor.agentId);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.owner_reassigned",
      entityType: "goal",
      entityId: id,
      details: { agentId: assignment.agentId, assignmentRevision: assignment.assignmentRevision },
    });
    res.json(assignment);
  });

  router.post("/goals/:id/focus", validate(setGoalFocusSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const goal = await svc.setFocus(id, req.body.focus, actor.agentId);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.focus_changed",
      entityType: "goal",
      entityId: id,
      details: { focus: goal?.focus ?? false },
    });
    res.json(goal);
  });

  router.post("/goals/:id/evaluate", validate(evaluateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const goal = await svc.evaluate(id, req.body, actor.agentId);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.evaluated",
      entityType: "goal",
      entityId: id,
      details: { result: goal.evaluationResult, lifecycle: goal.lifecycle },
    });
    res.json(goal);
  });

  router.delete("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const goal = await svc.remove(id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: goal!.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.deleted",
      entityType: "goal",
      entityId: id,
    });
    res.json(goal);
  });

  return router;
}
