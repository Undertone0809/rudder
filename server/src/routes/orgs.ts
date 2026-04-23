import { Router, type Request } from "express";
import type { Db } from "@rudder/db";
import { normalizeAgentUrlKey } from "@rudder/shared";
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
} from "@rudder/shared";
import { z } from "zod";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  budgetService,
  resourceCatalogService,
  organizationPortabilityService,
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
  const linearImportSourceSchema = z.object({
    apiKey: z.string().min(1),
    teamIdOrKey: z.string().trim().min(1).optional(),
    projectIds: z.array(z.string().trim().min(1)).optional(),
    issueLimit: z.number().int().min(1).max(500).optional(),
    projectLimit: z.number().int().min(1).max(200).optional(),
  });

  function buildMarkdown(frontmatter: Record<string, unknown>, body: string) {
    const yaml = Object.entries(frontmatter)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n");
    return `---\n${yaml}\n---\n\n${body}`.trimEnd();
  }

  function uniqueSlug(base: string, used: Set<string>) {
    const normalized = normalizeAgentUrlKey(base) ?? "item";
    if (!used.has(normalized)) {
      used.add(normalized);
      return normalized;
    }
    let idx = 2;
    while (used.has(`${normalized}-${idx}`)) idx += 1;
    const slug = `${normalized}-${idx}`;
    used.add(slug);
    return slug;
  }

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

  router.post("/import/linear-source", async (req, res) => {
    assertBoard(req);
    const parsed = linearImportSourceSchema.parse(req.body ?? {});
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: parsed.apiKey,
      },
      body: JSON.stringify({
        query: `
          query RudderLinearImport($projectLimit: Int!, $issueLimit: Int!) {
            viewer { id name }
            projects(first: $projectLimit, includeArchived: false) {
              nodes {
                id
                name
                description
                targetDate
                url
                teams { nodes { id key name } }
              }
            }
            issues(first: $issueLimit, includeArchived: false) {
              nodes {
                id
                identifier
                title
                description
                url
                priority
                state { name }
                project { id }
                team { id key name }
              }
            }
          }
        `,
        variables: {
          issueLimit: parsed.issueLimit ?? 250,
          projectLimit: parsed.projectLimit ?? 100,
        },
      }),
    });
    const payload = await response.json() as {
      data?: {
        viewer?: { name?: string | null } | null;
        projects?: { nodes?: Array<{
          id: string;
          name: string;
          description?: string | null;
          targetDate?: string | null;
          url?: string | null;
          teams?: { nodes?: Array<{ id: string; key?: string | null; name?: string | null }> } | null;
        }> } | null;
        issues?: { nodes?: Array<{
          id: string;
          identifier?: string | null;
          title: string;
          description?: string | null;
          url?: string | null;
          priority?: number | null;
          state?: { name?: string | null } | null;
          project?: { id: string } | null;
          team?: { id: string; key?: string | null; name?: string | null } | null;
        }> } | null;
      };
      errors?: Array<{ message?: string }>;
    };
    if (!response.ok || (payload.errors && payload.errors.length > 0)) {
      const message = payload.errors?.map((item) => item.message).filter(Boolean).join("; ")
        || `Linear API request failed with status ${response.status}`;
      res.status(422).json({ error: message });
      return;
    }

    const selectedProjectIds = new Set(parsed.projectIds ?? []);
    const normalizedTeamSelector = parsed.teamIdOrKey?.trim().toLowerCase() ?? null;
    const allProjects = payload.data?.projects?.nodes ?? [];
    const projectMatchesTeam = (project: (typeof allProjects)[number]) => {
      if (!normalizedTeamSelector) return true;
      const teams = project.teams?.nodes ?? [];
      return teams.some((team) =>
        team.id.toLowerCase() === normalizedTeamSelector || (team.key ?? "").toLowerCase() === normalizedTeamSelector
      );
    };
    const projects = allProjects.filter((project) => {
      if (selectedProjectIds.size > 0 && !selectedProjectIds.has(project.id)) return false;
      return projectMatchesTeam(project);
    });
    const projectIdToSlug = new Map<string, string>();
    const usedProjectSlugs = new Set<string>();
    const files: Record<string, string> = {};

    const sourceLabel = parsed.teamIdOrKey ? `Linear ${parsed.teamIdOrKey}` : "Linear";
    files["ORGANIZATION.md"] = buildMarkdown(
      { name: sourceLabel, description: "Imported from Linear projects and issues." },
      `Imported from Linear by ${payload.data?.viewer?.name ?? "unknown user"}.`,
    );

    for (const project of projects) {
      const slug = uniqueSlug(project.name, usedProjectSlugs);
      projectIdToSlug.set(project.id, slug);
      files[`projects/${slug}/PROJECT.md`] = buildMarkdown(
        {
          name: project.name,
          targetDate: project.targetDate ?? undefined,
        },
        `${project.description?.trim() || ""}\n\n${project.url ? `Source: ${project.url}` : ""}`.trim(),
      );
    }

    const issues = (payload.data?.issues?.nodes ?? []).filter((issue) => {
      if (normalizedTeamSelector && issue.team) {
        const byId = issue.team.id.toLowerCase() === normalizedTeamSelector;
        const byKey = (issue.team.key ?? "").toLowerCase() === normalizedTeamSelector;
        if (!byId && !byKey) return false;
      } else if (normalizedTeamSelector && !issue.team) {
        return false;
      }
      if (selectedProjectIds.size > 0 && issue.project?.id && !selectedProjectIds.has(issue.project.id)) return false;
      if (selectedProjectIds.size > 0 && !issue.project?.id) return false;
      return true;
    });

    const usedTaskSlugs = new Set<string>();
    for (const issue of issues) {
      const slug = uniqueSlug(issue.identifier || issue.title, usedTaskSlugs);
      files[`tasks/${slug}/TASK.md`] = buildMarkdown(
        {
          name: issue.title,
          project: issue.project?.id ? projectIdToSlug.get(issue.project.id) ?? undefined : undefined,
          identifier: issue.identifier ?? undefined,
          status: issue.state?.name ?? undefined,
          priority: issue.priority ?? undefined,
        },
        `${issue.description?.trim() || ""}\n\n${issue.url ? `Source: ${issue.url}` : ""}`.trim(),
      );
    }

    res.json({
      rootPath: normalizeAgentUrlKey(sourceLabel) ?? "linear-import",
      files,
      summary: {
        projectCount: projects.length,
        issueCount: issues.length,
      },
    });
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
