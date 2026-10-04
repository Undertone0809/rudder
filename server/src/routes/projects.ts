import type { Db } from "@rudderhq/db";
import {
  createProjectSchema,
  isUuidLike,
  projectResourceAttachmentInputSchema,
  updateProjectResourceAttachmentSchema,
  updateProjectSchema,
} from "@rudderhq/shared";
import { sql } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { badRequest, conflict } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity, projectService, resourceCatalogService } from "../services/index.js";
import type { ProjectCreateContext } from "../services/projects.js";
import type { RustFoundationBridge, RustFoundationResponse } from "../services/rust-foundation-bridge.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

type ProjectResourceAttachmentReceiptResponse = {
  status: 200 | 201;
  body: Record<string, unknown>;
};

function parseProjectResourceAttachmentReceiptResponse(
  value: unknown,
): ProjectResourceAttachmentReceiptResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Rust Project resource attachment receipt is invalid");
  }
  const response = value as Record<string, unknown>;
  if ((response.status !== 200 && response.status !== 201)
    || !response.body
    || typeof response.body !== "object"
    || Array.isArray(response.body)) {
    throw new Error("Rust Project resource attachment receipt is invalid");
  }
  return {
    status: response.status,
    body: response.body as Record<string, unknown>,
  };
}

function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

async function readProjectDeleteReceiptOrganizationScope(
  db: Db,
  projectId: string,
  idempotencyKey: string,
): Promise<string | null> {
  const result = await db.execute(sql<{ org_id: string }>`
    SELECT org_id::text AS org_id
    FROM organization_mutation_receipts
    WHERE command_kind = 'project_delete'
      AND idempotency_key = ${idempotencyKey}
      AND result->'result'->>'project_id' = ${projectId}
    LIMIT 2
  `);
  const organizationIds = [...new Set(queryRows<{ org_id: string }>(result).map((row) => row.org_id))];
  if (organizationIds.length > 1) {
    throw conflict("Project deletion receipt scope is ambiguous");
  }
  return organizationIds[0] ?? null;
}

export function projectRoutes(db: Db, rustFoundationBridge?: RustFoundationBridge) {
  const router = Router();
  const svc = projectService(db, rustFoundationBridge);
  const resources = resourceCatalogService(db);

  async function readResourceAttachmentReceiptResponse(
    req: Request,
    orgId: string,
  ): Promise<ProjectResourceAttachmentReceiptResponse> {
    const idempotencyKey = req.header("x-rudder-idempotency-key")?.trim();
    if (!idempotencyKey) {
      throw badRequest("x-rudder-idempotency-key is required for Rust Project updates");
    }
    const result = await db.execute(sql<{ resource_attachment_response: unknown }>`
      SELECT result->'resource_attachment_response' AS resource_attachment_response
      FROM organization_mutation_receipts
      WHERE org_id = ${orgId}::uuid
        AND idempotency_key = ${idempotencyKey}
        AND command_kind = 'project_goal_set_replacement'
      LIMIT 1
    `);
    const row = queryRows<{ resource_attachment_response: unknown }>(result)[0];
    return parseProjectResourceAttachmentReceiptResponse(row?.resource_attachment_response);
  }

  async function forwardRustProjectDelete(
    req: Request,
    res: Response,
    orgId: string,
    projectId: string,
    idempotencyKey: string,
  ): Promise<void> {
    if (rustFoundationBridge?.projectGoalSetMode !== "required") {
      res.status(503).json({
        error: "Rust Project deletion is not enabled",
        code: "rust_foundation_project_delete_disabled",
      });
      return;
    }
    const requestPath = `/api/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`;
    let response: RustFoundationResponse;
    try {
      response = await rustFoundationBridge.projectDelete(
        req,
        orgId,
        projectId,
        Buffer.from(JSON.stringify({ runId: req.actor.runId ?? null }), "utf8"),
        idempotencyKey,
        requestPath,
      );
    } catch (error) {
      res.status(503).json({
        error: "Rust Project deletion is unavailable",
        code: `rust_foundation_project_delete_${error instanceof Error ? "request_failed" : "unavailable"}`,
      });
      return;
    }
    res.status(response.status).set("content-type", response.contentType).send(response.body);
  }

  type ProjectPatchForward =
    | { kind: "node" }
    | { kind: "missing_idempotency_key" }
    | { kind: "unavailable"; code: string }
    | { kind: "rust"; response: RustFoundationResponse };

  async function forwardRustOwnedProjectPatch(
    req: Request,
    orgId: string,
    projectId: string,
    patch: Record<string, unknown>,
    forceRust: boolean,
  ): Promise<ProjectPatchForward> {
    const owner = await svc.getMutationOwner(orgId, projectId);
    if (forceRust && owner !== "rust") {
      return { kind: "unavailable", code: "rust_foundation_project_goal_set_not_owned" };
    }
    if (owner !== "rust") return { kind: "node" };
    if (rustFoundationBridge?.projectGoalSetMode !== "required") {
      return { kind: "unavailable", code: "rust_foundation_project_goal_set_disabled" };
    }
    if (!req.header("x-rudder-idempotency-key")?.trim()) {
      return { kind: "missing_idempotency_key" };
    }
    const requestPath = `/api/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/goal-set`;
    try {
      const response = await rustFoundationBridge.projectGoalSet(
        req,
        orgId,
        projectId,
        Buffer.from(JSON.stringify({
          projectPatch: patch,
          runId: req.actor.runId ?? null,
        }), "utf8"),
        requestPath,
      );
      return { kind: "rust", response };
    } catch (error) {
      return {
        kind: "unavailable",
        code: `rust_foundation_project_goal_set_${error instanceof Error ? "request_failed" : "unavailable"}`,
      };
    }
  }

  function sendProjectPatchForwardError(
    result: Exclude<ProjectPatchForward, { kind: "node" } | { kind: "rust" }>,
    res: Response,
  ) {
    if (result.kind === "missing_idempotency_key") {
      throw badRequest("x-rudder-idempotency-key is required for Rust Project updates");
    }
    res.status(503).json({
      error: result.code === "rust_foundation_project_goal_set_disabled"
        ? "Rust Project-Goal authority is not enabled"
        : result.code === "rust_foundation_project_goal_set_not_owned"
          ? "Rust does not own this Project-Goal authority"
          : "Rust Project-Goal authority is unavailable",
      code: result.code,
    });
  }

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
    // Legacy project workspace creation used a nested `workspace` body. Current
    // project creation ignores that old shape; workspaces are resolved through
    // organization Library/codebase and run workspace paths.
    const { workspace: _ignoredWorkspace, ...projectData } = req.body as Parameters<typeof svc.create>[1] & {
      workspace?: unknown;
    };
    const context: ProjectCreateContext = {
      lane: "rust",
      caller: "public",
      actor: req.actor,
      idempotencyKey: req.header("x-rudder-idempotency-key"),
    };
    const project = await svc.create(orgId, projectData, context);
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
    const hasGoalMutation = Object.prototype.hasOwnProperty.call(body, "goalIds")
      || Object.prototype.hasOwnProperty.call(body, "goalId");
    const nonGoalKeys = Object.keys(body).filter((key) => key !== "goalIds" && key !== "goalId");
    const goalSetOnly = hasGoalMutation && nonGoalKeys.length === 0;
    const rustRequiredHeader = req.header("x-rudder-required-authority")?.trim().toLowerCase() === "rust";
    const mutationOwner = await svc.getMutationOwner(existing.orgId, id);
    const rustOwnsProject = mutationOwner === "rust";

    if (rustRequiredHeader && !rustOwnsProject) {
      res.status(503).json({
        error: "Rust does not own this Project-Goal authority",
        code: "rust_foundation_project_goal_set_not_owned",
      });
      return;
    }

    if (rustOwnsProject || rustRequiredHeader) {
      if (rustFoundationBridge?.projectGoalSetMode !== "required") {
        res.status(503).json({
          error: "Rust Project-Goal authority is not enabled",
          code: "rust_foundation_project_goal_set_disabled",
        });
        return;
      }
      if (!req.header("x-rudder-idempotency-key")?.trim()) {
        throw badRequest("x-rudder-idempotency-key is required for Rust Project updates");
      }
      const goalIds = body.goalIds !== undefined ? body.goalIds : body.goalId ? [body.goalId] : [];
      const rustBody = goalSetOnly
        ? {
          goalIds,
          primaryGoalId: goalIds[0] ?? null,
          runId: req.actor.runId ?? null,
        }
        : {
          projectPatch: body,
          runId: req.actor.runId ?? null,
        };
      const requestPath = `/api/orgs/${encodeURIComponent(existing.orgId)}/projects/${encodeURIComponent(id)}/goal-set`;
      let response;
      try {
        response = await rustFoundationBridge.projectGoalSet(
          req,
          existing.orgId,
          id,
          Buffer.from(JSON.stringify(rustBody), "utf8"),
          requestPath,
        );
      } catch (error) {
        res.status(503).json({
          error: "Rust Project-Goal authority is unavailable",
          code: `rust_foundation_project_goal_set_${error instanceof Error ? "request_failed" : "unavailable"}`,
        });
        return;
      }
      if (response.status < 200 || response.status >= 300) {
        res.status(response.status).set("content-type", response.contentType).send(response.body);
        return;
      }
      const project = await svc.getById(id);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      res.json(project);
      return;
    }
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
      runId: actor.runId,
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

    const rustRequiredHeader = req.header("x-rudder-required-authority")?.trim().toLowerCase() === "rust";
    const forwarded = await forwardRustOwnedProjectPatch(
      req,
      project.orgId,
      id,
      { resourceAttachmentOperation: { kind: "attach", ...req.body } },
      rustRequiredHeader,
    );
    if (forwarded.kind === "missing_idempotency_key" || forwarded.kind === "unavailable") {
      sendProjectPatchForwardError(forwarded, res);
      return;
    }
    if (forwarded.kind === "rust") {
      if (forwarded.response.status < 200 || forwarded.response.status >= 300) {
        res.status(forwarded.response.status)
          .set("content-type", forwarded.response.contentType)
          .send(forwarded.response.body);
        return;
      }
      const stored = await readResourceAttachmentReceiptResponse(req, project.orgId);
      res.status(stored.status).json(stored.body);
      return;
    }

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
      runId: actor.runId,
      action: "project.resource.attached",
      entityType: "project_resource_attachment",
      entityId: attachment.id,
      details: {
        projectId: project.id,
        resourceId: attachment.resourceId,
        role: attachment.role,
        isPrimary: attachment.isPrimary,
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

      const existingAttachment = project.resources.find((resource) => resource.id === attachmentId);
      const rustRequiredHeader = req.header("x-rudder-required-authority")?.trim().toLowerCase() === "rust";
      const forwarded = await forwardRustOwnedProjectPatch(
        req,
        project.orgId,
        id,
        { resourceAttachmentOperation: { kind: "update", attachmentId, ...req.body } },
        rustRequiredHeader,
      );
      if (forwarded.kind === "missing_idempotency_key" || forwarded.kind === "unavailable") {
        sendProjectPatchForwardError(forwarded, res);
        return;
      }
      if (forwarded.kind === "rust") {
        if (forwarded.response.status < 200 || forwarded.response.status >= 300) {
          res.status(forwarded.response.status)
            .set("content-type", forwarded.response.contentType)
            .send(forwarded.response.body);
          return;
        }
        const stored = await readResourceAttachmentReceiptResponse(req, project.orgId);
        res.status(stored.status).json(stored.body);
        return;
      }

      if (!existingAttachment) {
        res.status(404).json({ error: "Project resource attachment not found" });
        return;
      }
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
        runId: actor.runId,
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

    const existingAttachment = project.resources.find((resource) => resource.id === attachmentId);
    const rustRequiredHeader = req.header("x-rudder-required-authority")?.trim().toLowerCase() === "rust";
    const forwarded = await forwardRustOwnedProjectPatch(
      req,
      project.orgId,
      id,
      { resourceAttachmentOperation: { kind: "remove", attachmentId } },
      rustRequiredHeader,
    );
    if (forwarded.kind === "missing_idempotency_key" || forwarded.kind === "unavailable") {
      sendProjectPatchForwardError(forwarded, res);
      return;
    }
    if (forwarded.kind === "rust") {
      if (forwarded.response.status < 200 || forwarded.response.status >= 300) {
        res.status(forwarded.response.status)
          .set("content-type", forwarded.response.contentType)
          .send(forwarded.response.body);
        return;
      }
      const stored = await readResourceAttachmentReceiptResponse(req, project.orgId);
      res.status(stored.status).json(stored.body);
      return;
    }

    if (!existingAttachment) {
      res.status(404).json({ error: "Project resource attachment not found" });
      return;
    }
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
      runId: actor.runId,
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
    const explicitIdempotencyKey = req.header("x-rudder-idempotency-key")?.trim();
    if (explicitIdempotencyKey) {
      const receiptOrgId = await readProjectDeleteReceiptOrganizationScope(
        db,
        id,
        explicitIdempotencyKey,
      );
      if (receiptOrgId) {
        assertCompanyAccess(req, receiptOrgId);
        await forwardRustProjectDelete(req, res, receiptOrgId, id, explicitIdempotencyKey);
        return;
      }
    }

    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);

    const mutationOwner = await svc.getMutationOwner(existing.orgId, id);
    const rustRequiredHeader = req.header("x-rudder-required-authority")?.trim().toLowerCase() === "rust";
    if (rustRequiredHeader && mutationOwner !== "rust") {
      res.status(503).json({
        error: "Rust does not own this Project deletion authority",
        code: "rust_foundation_project_delete_not_owned",
      });
      return;
    }
    if (mutationOwner === "rust") {
      await forwardRustProjectDelete(
        req,
        res,
        existing.orgId,
        id,
        explicitIdempotencyKey ?? randomUUID(),
      );
      return;
    }

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
      runId: actor.runId,
      action: "project.deleted",
      entityType: "project",
      entityId: project.id,
    });

    res.json(project);
  });

  return router;
}
