import { Router, type Request } from "express";
import type { Db } from "@rudderhq/db";
import {
  organizationPortabilityExportSchema,
  organizationPortabilityImportSchema,
  organizationPortabilityPreviewSchema,
  createOrganizationResourceSchema,
  createOrganizationSchema,
  updateOrganizationResourceSchema,
  updateOrganizationBrandingSchema,
  updateOrganizationSchema,
  updateOrganizationWorkspaceFileSchema,
  createWorkspaceBackupSchema,
  restoreWorkspaceBackupSchema,
} from "@rudderhq/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  budgetService,
  resourceCatalogService,
  organizationPortabilityService,
  workspaceBackupService,
  organizationSkillService,
  organizationService,
  logActivity,
} from "../services/index.js";
import { organizationWorkspaceBrowserService } from "../services/organization-workspace-browser.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function organizationRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const svc = organizationService(db);
  const agents = agentService(db);
  const portability = organizationPortabilityService(db, storage);
  const organizationSkills = organizationSkillService(db);
  const access = accessService(db);
  const budgets = budgetService(db);
  const resources = resourceCatalogService(db);
  const workspaceBrowser = organizationWorkspaceBrowserService(db);
  const workspaceBackups = workspaceBackupService(db);

  async function assertCanUpdateBranding(req: Request, orgId: string) {
    assertCompanyAccess(req, orgId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.orgId !== orgId) {
      throw forbidden("Agent key cannot access another organization");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden("Only CEO agents can update organization branding");
    }
  }

  async function assertCanManagePortability(req: Request, orgId: string, capability: "imports" | "exports") {
    assertCompanyAccess(req, orgId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.orgId !== orgId) {
      throw forbidden("Agent key cannot access another organization");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden(`Only CEO agents can manage organization ${capability}`);
    }
  }

  router.get("/", async (req, res) => {
    assertBoard(req);
    const result = await svc.list();
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      res.json(result);
      return;
    }
    const allowed = new Set(req.actor.orgIds ?? []);
    res.json(result.filter((organization) => allowed.has(organization.id)));
  });

  router.get("/stats", async (req, res) => {
    assertBoard(req);
    const allowed = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin
      ? null
      : new Set(req.actor.orgIds ?? []);
    const stats = await svc.stats();
    if (!allowed) {
      res.json(stats);
      return;
    }
    const filtered = Object.fromEntries(Object.entries(stats).filter(([orgId]) => allowed.has(orgId)));
    res.json(filtered);
  });

  // Common malformed path when orgId is empty in "/api/orgs/{orgId}/issues".
  router.get("/issues", (_req, res) => {
    res.status(400).json({
      error: "Missing orgId in path. Use /api/orgs/{orgId}/issues.",
    });
  });

  router.get("/:orgId", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    // Allow agents (CEO) to read their own organization; board always allowed
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const organization = await svc.getById(orgId);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    res.json(organization);
  });

  router.get("/:orgId/resources", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const catalog = await resources.listOrganizationResources(orgId);
    res.json(catalog);
  });

  router.post("/:orgId/resources", validate(createOrganizationResourceSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const resource = await resources.createOrganizationResource(orgId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.resource.created",
      entityType: "organization_resource",
      entityId: resource.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        name: resource.name,
        kind: resource.kind,
        locator: resource.locator,
      },
    });
    res.status(201).json(resource);
  });

  router.patch("/:orgId/resources/:resourceId", validate(updateOrganizationResourceSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    const resourceId = req.params.resourceId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const resource = await resources.updateOrganizationResource(orgId, resourceId, req.body);
    if (!resource) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.resource.updated",
      entityType: "organization_resource",
      entityId: resource.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: req.body,
    });
    res.json(resource);
  });

  router.delete("/:orgId/resources/:resourceId", async (req, res) => {
    const orgId = req.params.orgId as string;
    const resourceId = req.params.resourceId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const resource = await resources.removeOrganizationResource(orgId, resourceId);
    if (!resource) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.resource.deleted",
      entityType: "organization_resource",
      entityId: resource.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        name: resource.name,
      },
    });
    res.json(resource);
  });

  router.get("/:orgId/workspace/files", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const directoryPath = typeof req.query.path === "string" ? req.query.path : "";
    const result = await workspaceBrowser.listFiles(orgId, directoryPath);
    res.json(result);
  });

  router.get("/:orgId/workspace/file", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    const result = await workspaceBrowser.readFile(orgId, filePath);
    res.json(result);
  });

  router.patch("/:orgId/workspace/file", validate(updateOrganizationWorkspaceFileSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    const result = await workspaceBrowser.writeFile(orgId, filePath, req.body.content);
    await organizationSkills.syncWorkspaceFileChange(orgId, result.filePath, req.body.content);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.workspace_file.updated",
      entityType: "organization",
      entityId: orgId,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        path: result.filePath,
      },
    });
    res.json(result);
  });

  router.get("/:orgId/workspace/backups", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const backups = await workspaceBackups.list(orgId);
    res.json({ backups });
  });

  router.post("/:orgId/workspace/backups", validate(createWorkspaceBackupSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const result = await workspaceBackups.create({
      orgId,
      triggerSource: req.body.triggerSource,
      createdByUserId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: result.status === "succeeded" ? "organization.workspace_backup.created" : "organization.workspace_backup.failed",
      entityType: "workspace_backup",
      entityId: result.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        status: result.status,
        fileCount: result.fileCount,
        byteSize: result.byteSize,
        warnings: result.warnings,
        error: result.error,
        expiresAt: result.expiresAt,
      },
    });
    if (result.status === "failed") {
      res.status(500).json({ error: result.error ?? "Workspace backup failed", backup: result });
      return;
    }
    res.status(201).json(result);
  });

  router.get("/:orgId/workspace/backups/:backupId/files", async (req, res) => {
    const orgId = req.params.orgId as string;
    const backupId = req.params.backupId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const directoryPath = typeof req.query.path === "string" ? req.query.path : "";
    const result = await workspaceBackups.listFiles(orgId, backupId, directoryPath);
    res.json(result);
  });

  router.get("/:orgId/workspace/backups/:backupId/file", async (req, res) => {
    const orgId = req.params.orgId as string;
    const backupId = req.params.backupId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    const result = await workspaceBackups.readFile(orgId, backupId, filePath);
    res.json(result);
  });

  router.post("/:orgId/workspace/backups/:backupId/restore", validate(restoreWorkspaceBackupSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    const backupId = req.params.backupId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const result = await workspaceBackups.restore(orgId, backupId, {
      createdByUserId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.workspace_backup.restored",
      entityType: "workspace_backup",
      entityId: result.restoredBackup.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        preRestoreBackupId: result.preRestoreBackup.id,
        fileCount: result.restoredBackup.fileCount,
        byteSize: result.restoredBackup.byteSize,
      },
    });
    res.json(result);
  });

  router.delete("/:orgId/workspace/backups/:backupId", async (req, res) => {
    const orgId = req.params.orgId as string;
    const backupId = req.params.backupId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const result = await workspaceBackups.remove(orgId, backupId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.workspace_backup.deleted",
      entityType: "workspace_backup",
      entityId: result.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        fileCount: result.fileCount,
        byteSize: result.byteSize,
      },
    });
    res.json(result);
  });

  router.post("/:orgId/export", validate(organizationPortabilityExportSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const result = await portability.exportBundle(orgId, req.body);
    res.json(result);
  });

  router.post("/import/preview", validate(organizationPortabilityPreviewSchema), async (req, res) => {
    assertBoard(req);
    if (req.body.target.mode === "existing_organization") {
      assertCompanyAccess(req, req.body.target.orgId);
    }
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });

  router.post("/import", validate(organizationPortabilityImportSchema), async (req, res) => {
    assertBoard(req);
    if (req.body.target.mode === "existing_organization") {
      assertCompanyAccess(req, req.body.target.orgId);
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null);
    await logActivity(db, {
      orgId: result.organization.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.imported",
      entityType: "organization",
      entityId: result.organization.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        organizationAction: result.organization.action,
      },
    });
    res.json(result);
  });

  router.post("/:orgId/exports/preview", validate(organizationPortabilityExportSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanManagePortability(req, orgId, "exports");
    const preview = await portability.previewExport(orgId, req.body);
    res.json(preview);
  });

  router.post("/:orgId/exports", validate(organizationPortabilityExportSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanManagePortability(req, orgId, "exports");
    const result = await portability.exportBundle(orgId, req.body);
    res.json(result);
  });

  router.post("/:orgId/imports/preview", validate(organizationPortabilityPreviewSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanManagePortability(req, orgId, "imports");
    if (req.body.target.mode === "existing_organization" && req.body.target.orgId !== orgId) {
      throw forbidden("Safe import route can only target the route organization");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const preview = await portability.previewImport(req.body, {
      mode: "agent_safe",
      sourceOrganizationId: orgId,
    });
    res.json(preview);
  });

  router.post("/:orgId/imports/apply", validate(organizationPortabilityImportSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanManagePortability(req, orgId, "imports");
    if (req.body.target.mode === "existing_organization" && req.body.target.orgId !== orgId) {
      throw forbidden("Safe import route can only target the route organization");
    }
    if (req.body.collisionStrategy === "replace") {
      throw forbidden("Safe import route does not allow replace collision strategy");
    }
    const actor = getActorInfo(req);
    const result = await portability.importBundle(req.body, req.actor.type === "board" ? req.actor.userId : null, {
      mode: "agent_safe",
      sourceOrganizationId: orgId,
    });
    await logActivity(db, {
      orgId: result.organization.id,
      actorType: actor.actorType,
      actorId: actor.actorId,
      entityType: "organization",
      entityId: result.organization.id,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "organization.imported",
      details: {
        include: req.body.include ?? null,
        agentCount: result.agents.length,
        warningCount: result.warnings.length,
        organizationAction: result.organization.action,
        importMode: "agent_safe",
      },
    });
    res.json(result);
  });

  router.post("/", validate(createOrganizationSchema), async (req, res) => {
    assertBoard(req);
    if (!(req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)) {
      throw forbidden("Instance admin required");
    }
    const organization = await svc.create(req.body);
    await access.ensureMembership(organization.id, "user", req.actor.userId ?? "local-board", "owner", "active");
    await logActivity(db, {
      orgId: organization.id,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "organization.created",
      entityType: "organization",
      entityId: organization.id,
      details: { name: organization.name },
    });
    if (organization.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        organization.id,
        {
          scopeType: "organization",
          scopeId: organization.id,
          amount: organization.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        req.actor.userId ?? "board",
      );
    }
    res.status(201).json(organization);
  });

  router.patch("/:orgId", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    const actor = getActorInfo(req);
    let body: Record<string, unknown>;

    if (req.actor.type === "agent") {
      // Only CEO agents may update organization branding fields
      const agentSvc = agentService(db);
      const actorAgent = req.actor.agentId ? await agentSvc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.role !== "ceo") {
        throw forbidden("Only CEO agents or board users may update organization settings");
      }
      if (actorAgent.orgId !== orgId) {
        throw forbidden("Agent key cannot access another organization");
      }
      body = updateOrganizationBrandingSchema.parse(req.body);
    } else {
      assertBoard(req);
      body = updateOrganizationSchema.parse(req.body);
    }

    const organization = await svc.update(orgId, body);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "organization.updated",
      entityType: "organization",
      entityId: orgId,
      details: body,
    });
    res.json(organization);
  });

  router.patch("/:orgId/branding", validate(updateOrganizationBrandingSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanUpdateBranding(req, orgId);
    const organization = await svc.update(orgId, req.body);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "organization.branding_updated",
      entityType: "organization",
      entityId: orgId,
      details: req.body,
    });
    res.json(organization);
  });

  router.post("/:orgId/archive", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const organization = await svc.archive(orgId);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await logActivity(db, {
      orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "organization.archived",
      entityType: "organization",
      entityId: orgId,
    });
    res.json(organization);
  });

  router.delete("/:orgId", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const organization = await svc.remove(orgId);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
