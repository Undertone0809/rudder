import { Router, type Request } from "express";
import type { Db } from "@rudder/db";
import {
  createAutomationSchema,
  createAutomationTriggerSchema,
  rotateAutomationTriggerSecretSchema,
  runAutomationSchema,
  updateAutomationSchema,
  updateAutomationTriggerSchema,
} from "@rudder/shared";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity, automationService } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, unauthorized } from "../errors.js";

export function automationRoutes(db: Db) {
  const router = Router();
  const svc = automationService(db);
  const access = accessService(db);

  async function assertBoardCanAssignTasks(req: Request, orgId: string) {
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "board") return;
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const allowed = await access.canUser(orgId, req.actor.userId, "tasks:assign");
    if (!allowed) {
      throw forbidden("Missing permission: tasks:assign");
    }
  }

  function assertCanManageCompanyAutomation(req: Request, orgId: string, assigneeAgentId?: string | null) {
    assertCompanyAccess(req, orgId);
    if (req.actor.type === "board") return;
    if (req.actor.type !== "agent" || !req.actor.agentId) throw unauthorized();
    if (assigneeAgentId && assigneeAgentId !== req.actor.agentId) {
      throw forbidden("Agents can only manage automations assigned to themselves");
    }
  }

  async function assertCanManageExistingAutomation(req: Request, automationId: string) {
    const automation = await svc.get(automationId);
    if (!automation) return null;
    assertCompanyAccess(req, automation.orgId);
    if (req.actor.type === "board") return automation;
    if (req.actor.type !== "agent" || !req.actor.agentId) throw unauthorized();
    if (automation.assigneeAgentId !== req.actor.agentId) {
      throw forbidden("Agents can only manage automations assigned to themselves");
    }
    return automation;
  }

  router.get("/orgs/:orgId/automations", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const result = await svc.list(orgId);
    res.json(result);
  });

  router.post("/orgs/:orgId/automations", validate(createAutomationSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertBoardCanAssignTasks(req, orgId);
    assertCanManageCompanyAutomation(req, orgId, req.body.assigneeAgentId);
    const created = await svc.create(orgId, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "automation.created",
      entityType: "automation",
      entityId: created.id,
      details: { title: created.title, assigneeAgentId: created.assigneeAgentId },
    });
    res.status(201).json(created);
  });

  router.get("/automations/:id", async (req, res) => {
    const detail = await svc.getDetail(req.params.id as string);
    if (!detail) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    assertCompanyAccess(req, detail.orgId);
    res.json(detail);
  });

  router.patch("/automations/:id", validate(updateAutomationSchema), async (req, res) => {
    const automation = await assertCanManageExistingAutomation(req, req.params.id as string);
    if (!automation) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    const assigneeWillChange =
      req.body.assigneeAgentId !== undefined &&
      req.body.assigneeAgentId !== automation.assigneeAgentId;
    if (assigneeWillChange) {
      await assertBoardCanAssignTasks(req, automation.orgId);
    }
    const statusWillActivate =
      req.body.status !== undefined &&
      req.body.status === "active" &&
      automation.status !== "active";
    if (statusWillActivate) {
      await assertBoardCanAssignTasks(req, automation.orgId);
    }
    if (req.actor.type === "agent" && req.body.assigneeAgentId && req.body.assigneeAgentId !== req.actor.agentId) {
      throw forbidden("Agents can only assign automations to themselves");
    }
    const updated = await svc.update(automation.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: automation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "automation.updated",
      entityType: "automation",
      entityId: automation.id,
      details: { title: updated?.title ?? automation.title },
    });
    res.json(updated);
  });

  router.get("/automations/:id/runs", async (req, res) => {
    const automation = await svc.get(req.params.id as string);
    if (!automation) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    assertCompanyAccess(req, automation.orgId);
    const limit = Number(req.query.limit ?? 50);
    const result = await svc.listRuns(automation.id, Number.isFinite(limit) ? limit : 50);
    res.json(result);
  });

  router.post("/automations/:id/triggers", validate(createAutomationTriggerSchema), async (req, res) => {
    const automation = await assertCanManageExistingAutomation(req, req.params.id as string);
    if (!automation) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    await assertBoardCanAssignTasks(req, automation.orgId);
    const created = await svc.createTrigger(automation.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: automation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "automation.trigger_created",
      entityType: "automation_trigger",
      entityId: created.trigger.id,
      details: { automationId: automation.id, kind: created.trigger.kind },
    });
    res.status(201).json(created);
  });

  router.patch("/automation-triggers/:id", validate(updateAutomationTriggerSchema), async (req, res) => {
    const trigger = await svc.getTrigger(req.params.id as string);
    if (!trigger) {
      res.status(404).json({ error: "Automation trigger not found" });
      return;
    }
    const automation = await assertCanManageExistingAutomation(req, trigger.automationId);
    if (!automation) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    await assertBoardCanAssignTasks(req, automation.orgId);
    const updated = await svc.updateTrigger(trigger.id, req.body, {
      agentId: req.actor.type === "agent" ? req.actor.agentId : null,
      userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: automation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "automation.trigger_updated",
      entityType: "automation_trigger",
      entityId: trigger.id,
      details: { automationId: automation.id, kind: updated?.kind ?? trigger.kind },
    });
    res.json(updated);
  });

  router.delete("/automation-triggers/:id", async (req, res) => {
    const trigger = await svc.getTrigger(req.params.id as string);
    if (!trigger) {
      res.status(404).json({ error: "Automation trigger not found" });
      return;
    }
    const automation = await assertCanManageExistingAutomation(req, trigger.automationId);
    if (!automation) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    await svc.deleteTrigger(trigger.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: automation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "automation.trigger_deleted",
      entityType: "automation_trigger",
      entityId: trigger.id,
      details: { automationId: automation.id, kind: trigger.kind },
    });
    res.status(204).end();
  });

  router.post(
    "/automation-triggers/:id/rotate-secret",
    validate(rotateAutomationTriggerSecretSchema),
    async (req, res) => {
      const trigger = await svc.getTrigger(req.params.id as string);
      if (!trigger) {
        res.status(404).json({ error: "Automation trigger not found" });
        return;
      }
      const automation = await assertCanManageExistingAutomation(req, trigger.automationId);
      if (!automation) {
        res.status(404).json({ error: "Automation not found" });
        return;
      }
      const rotated = await svc.rotateTriggerSecret(trigger.id, {
        agentId: req.actor.type === "agent" ? req.actor.agentId : null,
        userId: req.actor.type === "board" ? req.actor.userId ?? "board" : null,
      });
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: automation.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "automation.trigger_secret_rotated",
        entityType: "automation_trigger",
        entityId: trigger.id,
        details: { automationId: automation.id },
      });
      res.json(rotated);
    },
  );

  router.post("/automations/:id/run", validate(runAutomationSchema), async (req, res) => {
    const automation = await assertCanManageExistingAutomation(req, req.params.id as string);
    if (!automation) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    await assertBoardCanAssignTasks(req, automation.orgId);
    const run = await svc.runAutomation(automation.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: automation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "automation.run_triggered",
      entityType: "automation_run",
      entityId: run.id,
      details: { automationId: automation.id, source: run.source, status: run.status },
    });
    res.status(202).json(run);
  });

  router.post("/automation-triggers/public/:publicId/fire", async (req, res) => {
    const result = await svc.firePublicTrigger(req.params.publicId as string, {
      authorizationHeader: req.header("authorization"),
      signatureHeader: req.header("x-rudder-signature"),
      timestampHeader: req.header("x-rudder-timestamp"),
      idempotencyKey: req.header("idempotency-key"),
      rawBody: (req as { rawBody?: Buffer }).rawBody ?? null,
      payload: typeof req.body === "object" && req.body !== null ? req.body as Record<string, unknown> : null,
    });
    res.status(202).json(result);
  });

  return router;
}
