import { Router, type Request } from "express";
import type { Db } from "@rudder/db";
import {
  createProjectSchema,
  isUuidLike,
  projectResourceAttachmentInputSchema,
  updateProjectResourceAttachmentSchema,
  updateProjectSchema,
} from "@rudder/shared";
import { validate } from "../middleware/validate.js";
import { projectService, resourceCatalogService, logActivity } from "../services/index.js";
import { conflict } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function projectRoutes(db: Db) {
  const router = Router();
  const svc = projectService(db);
  const resources = resourceCatalogService(db);

  async function resolveOrgIdForProjectReference(req: Request) {
    const orgIdQuery = req.query.orgId;
    const requestedOrgId =
      typeof orgIdQuery === "string" && orgIdQuery.trim().length > 0
        ? orgIdQuery.trim()
        : null;
    if (requestedOrgId) {
      assertCompanyAccess(req, requestedOrgId);
      return requestedOrgId;
    }
    if (req.actor.type === "agent" && req.actor.orgId) {
      return req.actor.orgId;
    }
    return null;
  }

  async function normalizeProjectReference(req: Request, rawId: string) {
    if (isUuidLike(rawId)) return rawId;
    const orgId = await resolveOrgIdForProjectReference(req);
    if (!orgId) return rawId;
    const resolved = await svc.resolveByReference(orgId, rawId);
    if (resolved.ambiguous) {
      throw conflict("Project shortname is ambiguous in this organization. Use the project ID.");
    }
    return resolved.project?.id ?? rawId;
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeProjectReference(req, rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/orgs/:orgId/projects", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const result = await svc.list(orgId);
    res.json(result);
  });

  router.get("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.orgId);
    res.json(project);
  });

  router.get("/projects/:id/resources", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.orgId);
    res.json(project.resources);
  });

  router.post("/orgs/:orgId/projects", validate(createProjectSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const { workspace: _ignoredWorkspace, ...projectData } = req.body as Parameters<typeof svc.create>[1] & {
      workspace?: unknown;
    };
    const project = await svc.create(orgId, projectData);

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.created",
      entityType: "project",
      entityId: project.id,
      details: {
        name: project.name,
      },
    });
    res.status(201).json(project);
  });

  router.patch("/projects/:id", validate(updateProjectSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    const body = { ...req.body };
    if (typeof body.archivedAt === "string") {
      body.archivedAt = new Date(body.archivedAt);
    }
    const project = await svc.update(id, body);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: project.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.updated",
      entityType: "project",
      entityId: project.id,
      details: req.body,
    });

    res.json(project);
  });

  router.post("/projects/:id/resources", validate(projectResourceAttachmentInputSchema), async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.orgId);
    const attachment = await resources.createProjectResourceAttachment(id, req.body);
    if (!attachment) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: project.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.resource.attached",
      entityType: "project_resource_attachment",
      entityId: attachment.id,
      details: {
        projectId: project.id,
        resourceId: attachment.resourceId,
        role: attachment.role,
      },
    });

    res.status(201).json(attachment);
  });

  router.patch(
    "/projects/:id/resources/:attachmentId",
    validate(updateProjectResourceAttachmentSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const attachmentId = req.params.attachmentId as string;
      const project = await svc.getById(id);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      assertCompanyAccess(req, project.orgId);
      const attachment = await resources.updateProjectResourceAttachment(id, attachmentId, req.body);
      if (!attachment) {
        res.status(404).json({ error: "Project resource attachment not found" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: project.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "project.resource.updated",
        entityType: "project_resource_attachment",
        entityId: attachment.id,
        details: req.body,
      });

      res.json(attachment);
    },
  );

  router.delete("/projects/:id/resources/:attachmentId", async (req, res) => {
    const id = req.params.id as string;
    const attachmentId = req.params.attachmentId as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.orgId);
    const attachment = await resources.removeProjectResourceAttachment(id, attachmentId);
    if (!attachment) {
      res.status(404).json({ error: "Project resource attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: project.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.resource.detached",
      entityType: "project_resource_attachment",
      entityId: attachment.id,
      details: {
        resourceId: attachment.resourceId,
      },
    });

    res.json(attachment);
  });

  router.delete("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    const project = await svc.remove(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: project.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.deleted",
      entityType: "project",
      entityId: project.id,
    });

    res.json(project);
  });

  return router;
}
