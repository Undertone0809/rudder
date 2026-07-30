import type { Db } from "@rudderhq/db";
import {
  appBuilderOpaqueBindingSchema,
  attachAppBuilderConversationSchema,
  createAppBuilderAppSchema,
  updateAppBuilderBuildSchema,
  type AppBuilderBuildStatus,
  type UpdateAppBuilderBuild,
} from "@rudderhq/shared";
import { Router, type Request } from "express";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  appBuilderService,
  instanceSettingsService,
  logActivity,
  projectService,
} from "../services/index.js";
import {
  assertBoard,
  assertCompanyAccess,
  getActorInfo,
} from "./authz.js";

const BUILD_ACTIVITY_ACTIONS: Record<AppBuilderBuildStatus, string> = {
  preparing: "app_builder.build_preparing",
  building: "app_builder.build_started",
  verifying: "app_builder.build_verifying",
  ready: "app_builder.build_ready",
  failed: "app_builder.build_failed",
};

export function appBuilderRoutes(db: Db) {
  const router = Router();
  const projects = projectService(db);
  const apps = appBuilderService(db);
  const settings = instanceSettingsService(db);

  router.use(
    [
      "/orgs/:orgId/app-builder",
      "/projects/:projectId/app-builder",
      "/app-builder/:appId",
    ],
    async (_req, _res, next) => {
      const general = await settings.getGeneral();
      if (!general.experimentalSitesEnabled) {
        throw forbidden("Sites is disabled in Experimental settings");
      }
      next();
    },
  );

  async function loadAuthorizedProject(req: Request) {
    const projectId = req.params.projectId as string;
    const project = await projects.getById(projectId);
    if (!project) return null;
    assertCompanyAccess(req, project.orgId);
    return project;
  }

  async function loadAuthorizedApp(req: Request) {
    const appId = req.params.appId as string;
    const orgId = typeof req.query.orgId === "string" ? req.query.orgId : "";
    if (!orgId) return null;
    assertCompanyAccess(req, orgId);
    return apps.getById(orgId, appId);
  }

  router.get("/orgs/:orgId/app-builder", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    res.json(await apps.listForOrganization(orgId));
  });

  router.post(
    "/orgs/:orgId/app-builder",
    validate(createAppBuilderAppSchema),
    async (req, res) => {
      assertBoard(req);
      const orgId = req.params.orgId as string;
      assertCompanyAccess(req, orgId);
      const app = await apps.create(orgId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "app_builder.created",
        entityType: "app_builder_app",
        entityId: app.id,
        details: {
          projectId: app.projectId,
          sourceRoot: app.sourceRoot,
          scaffoldVersion: app.scaffoldVersion,
        },
      });
      res.status(201).json(app);
    },
  );

  router.get("/projects/:projectId/app-builder", async (req, res) => {
    const project = await loadAuthorizedProject(req);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const app = await apps.getForProject(project.orgId, project.id);
    if (!app) {
      res.status(404).json({ error: "App Builder app not found" });
      return;
    }
    res.json(app);
  });

  router.post(
    "/projects/:projectId/app-builder",
    validate(createAppBuilderAppSchema),
    async (req, res) => {
      assertBoard(req);
      const project = await loadAuthorizedProject(req);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const app = await apps.create(project.orgId, {
        ...req.body,
        projectId: project.id,
      });
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: project.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "app_builder.created",
        entityType: "app_builder_app",
        entityId: app.id,
        details: {
          projectId: project.id,
          sourceRoot: app.sourceRoot,
          scaffoldVersion: app.scaffoldVersion,
        },
      });
      res.status(201).json(app);
    },
  );

  router.patch(
    "/app-builder/:appId/build",
    validate(updateAppBuilderBuildSchema),
    async (req, res) => {
      const app = await loadAuthorizedApp(req);
      if (!app) {
        res.status(404).json({ error: "App Builder app not found" });
        return;
      }
      const body = req.body as UpdateAppBuilderBuild;
      if (
        req.actor.type === "agent"
        && (!body.runId || !req.actor.runId || body.runId !== req.actor.runId)
      ) {
        throw forbidden(
          "Agent App Builder updates require the authenticated run ID",
        );
      }
      const updated = await apps.updateBuild(app.orgId, app.id, body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: app.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: BUILD_ACTIVITY_ACTIONS[body.status],
        entityType: "app_builder_app",
        entityId: app.id,
        details: {
          projectId: app.projectId,
          status: body.status,
          runKind: body.runKind,
          runId: body.runId ?? null,
        },
      });
      res.json(updated);
    },
  );

  router.patch(
    "/app-builder/:appId/conversation",
    validate(attachAppBuilderConversationSchema),
    async (req, res) => {
      assertBoard(req);
      const app = await loadAuthorizedApp(req);
      if (!app) {
        res.status(404).json({ error: "App Builder app not found" });
        return;
      }
      const updated = await apps.attachConversation(app.orgId, app.id, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: app.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "app_builder.conversation_attached",
        entityType: "app_builder_app",
        entityId: app.id,
        details: { conversationId: updated.conversationId },
      });
      res.json(updated);
    },
  );

  router.patch(
    "/projects/:projectId/app-builder/build",
    validate(updateAppBuilderBuildSchema),
    async (req, res) => {
      const project = await loadAuthorizedProject(req);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const body = req.body as UpdateAppBuilderBuild;
      if (
        req.actor.type === "agent" &&
        (!body.runId || !req.actor.runId || body.runId !== req.actor.runId)
      ) {
        throw forbidden(
          "Agent App Builder updates require the authenticated run ID",
        );
      }
      const existing = await apps.getForProject(project.orgId, project.id);
      if (!existing) {
        res.status(404).json({ error: "App Builder app not found" });
        return;
      }
      const app = await apps.updateBuild(project.orgId, existing.id, body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: project.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: BUILD_ACTIVITY_ACTIONS[body.status],
        entityType: "app_builder_app",
        entityId: app.id,
        details: {
          projectId: project.id,
          status: body.status,
          runKind: body.runKind,
          runId: body.runId ?? null,
        },
      });
      res.json(app);
    },
  );

  router.put(
    "/app-builder/:appId/local-binding",
    validate(appBuilderOpaqueBindingSchema),
    async (req, res) => {
      assertBoard(req);
      const app = await loadAuthorizedApp(req);
      if (!app) {
        res.status(404).json({ error: "App Builder app not found" });
        return;
      }
      const updated = await apps.bindLocalRuntime(app.orgId, app.id, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: app.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "app_builder.local_binding_attached",
        entityType: "app_builder_app",
        entityId: app.id,
        details: { projectId: app.projectId },
      });
      res.json(updated);
    },
  );

  router.put(
    "/projects/:projectId/app-builder/local-binding",
    validate(appBuilderOpaqueBindingSchema),
    async (req, res) => {
      assertBoard(req);
      const project = await loadAuthorizedProject(req);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const existing = await apps.getForProject(project.orgId, project.id);
      if (!existing) {
        res.status(404).json({ error: "App Builder app not found" });
        return;
      }
      const app = await apps.bindLocalRuntime(project.orgId, existing.id, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: project.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "app_builder.local_binding_attached",
        entityType: "app_builder_app",
        entityId: app.id,
        details: { projectId: project.id },
      });
      res.json(app);
    },
  );

  router.delete(
    "/app-builder/:appId/local-binding",
    async (req, res) => {
      assertBoard(req);
      const app = await loadAuthorizedApp(req);
      if (!app) {
        res.status(404).json({ error: "App Builder app not found" });
        return;
      }
      const updated = await apps.clearLocalBinding(app.orgId, app.id);
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: app.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "app_builder.local_binding_removed",
        entityType: "app_builder_app",
        entityId: app.id,
        details: { projectId: app.projectId },
      });
      res.json(updated);
    },
  );

  router.delete(
    "/projects/:projectId/app-builder/local-binding",
    async (req, res) => {
      assertBoard(req);
      const project = await loadAuthorizedProject(req);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const existing = await apps.getForProject(project.orgId, project.id);
      if (!existing) {
        res.status(404).json({ error: "App Builder app not found" });
        return;
      }
      const app = await apps.clearLocalBinding(project.orgId, existing.id);
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: project.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "app_builder.local_binding_removed",
        entityType: "app_builder_app",
        entityId: app.id,
        details: { projectId: project.id },
      });
      res.json(app);
    },
  );

  return router;
}
