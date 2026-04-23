import { Router, type Request } from "express";
import type { Db } from "@rudder/db";
import {
  organizationSkillCreateSchema,
  organizationSkillFileUpdateSchema,
  organizationSkillImportSchema,
  organizationSkillLocalScanRequestSchema,
  organizationSkillProjectScanRequestSchema,
} from "@rudder/shared";
import { validate } from "../middleware/validate.js";
import { accessService, agentService, organizationSkillService, logActivity } from "../services/index.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function organizationSkillRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const access = accessService(db);
  const svc = organizationSkillService(db);

  function canCreateAgents(agent: { permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function assertCanMutateOrganizationSkills(req: Request, orgId: string) {
    assertCompanyAccess(req, orgId);

    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(orgId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return;
    }

    if (!req.actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.orgId !== orgId) {
      throw forbidden("Agent key cannot access another organization");
    }

    const allowedByGrant = await access.hasPermission(orgId, "agent", actorAgent.id, "agents:create");
    if (allowedByGrant || canCreateAgents(actorAgent)) {
      return;
    }

    throw forbidden("Missing permission: can create agents");
  }

  router.get("/orgs/:orgId/skills", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const result = await svc.list(orgId);
    res.json(result);
  });

  router.get("/orgs/:orgId/skills/:skillId", async (req, res) => {
    const orgId = req.params.orgId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, orgId);
    const result = await svc.detail(orgId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.get("/orgs/:orgId/skills/:skillId/update-status", async (req, res) => {
    const orgId = req.params.orgId as string;
    const skillId = req.params.skillId as string;
    assertCompanyAccess(req, orgId);
    const result = await svc.updateStatus(orgId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.get("/orgs/:orgId/skills/:skillId/files", async (req, res) => {
    const orgId = req.params.orgId as string;
    const skillId = req.params.skillId as string;
    const relativePath = String(req.query.path ?? "SKILL.md");
    assertCompanyAccess(req, orgId);
    const result = await svc.readFile(orgId, skillId, relativePath);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    res.json(result);
  });

  router.post(
    "/orgs/:orgId/skills",
    validate(organizationSkillCreateSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanMutateOrganizationSkills(req, orgId);
      const result = await svc.createLocalSkill(orgId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "organization.skill_created",
        entityType: "organization_skill",
        entityId: result.id,
        details: {
          slug: result.slug,
          name: result.name,
        },
      });

      res.status(201).json(result);
    },
  );

  router.patch(
    "/orgs/:orgId/skills/:skillId/files",
    validate(organizationSkillFileUpdateSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const skillId = req.params.skillId as string;
      await assertCanMutateOrganizationSkills(req, orgId);
      const result = await svc.updateFile(
        orgId,
        skillId,
        String(req.body.path ?? ""),
        String(req.body.content ?? ""),
      );

      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "organization.skill_file_updated",
        entityType: "organization_skill",
        entityId: skillId,
        details: {
          path: result.path,
          markdown: result.markdown,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/orgs/:orgId/skills/import",
    validate(organizationSkillImportSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanMutateOrganizationSkills(req, orgId);
      const source = String(req.body.source ?? "");
      const result = await svc.importFromSource(orgId, source);

      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "organization.skills_imported",
        entityType: "organization",
        entityId: orgId,
        details: {
          source,
          importedCount: result.imported.length,
          importedSlugs: result.imported.map((skill) => skill.slug),
          warningCount: result.warnings.length,
        },
      });

      res.status(201).json(result);
    },
  );

  router.post(
    "/orgs/:orgId/skills/scan-projects",
    validate(organizationSkillProjectScanRequestSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanMutateOrganizationSkills(req, orgId);
      const result = await svc.scanProjectWorkspaces(orgId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "organization.skills_scanned",
        entityType: "organization",
        entityId: orgId,
        details: {
          scannedProjects: result.scannedProjects,
          scannedWorkspaces: result.scannedWorkspaces,
          discovered: result.discovered,
          importedCount: result.imported.length,
          updatedCount: result.updated.length,
          conflictCount: result.conflicts.length,
          warningCount: result.warnings.length,
        },
      });

      res.json(result);
    },
  );

  router.post(
    "/orgs/:orgId/skills/scan-local",
    validate(organizationSkillLocalScanRequestSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanMutateOrganizationSkills(req, orgId);
      const result = await svc.scanLocalSkillRoots(orgId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "organization.skills_scanned",
        entityType: "organization",
        entityId: orgId,
        details: {
          scannedRoots: result.scannedRoots,
          discovered: result.discovered,
          importedCount: result.imported.length,
          updatedCount: result.updated.length,
          conflictCount: result.conflicts.length,
          warningCount: result.warnings.length,
        },
      });

      res.json(result);
    },
  );

  router.delete("/orgs/:orgId/skills/:skillId", async (req, res) => {
    const orgId = req.params.orgId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateOrganizationSkills(req, orgId);
    const result = await svc.deleteSkill(orgId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "organization.skill_deleted",
      entityType: "organization_skill",
      entityId: result.id,
      details: {
        slug: result.slug,
        name: result.name,
      },
    });

    res.json(result);
  });

  router.post("/orgs/:orgId/skills/:skillId/install-update", async (req, res) => {
    const orgId = req.params.orgId as string;
    const skillId = req.params.skillId as string;
    await assertCanMutateOrganizationSkills(req, orgId);
    const result = await svc.installUpdate(orgId, skillId);
    if (!result) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "organization.skill_update_installed",
      entityType: "organization_skill",
      entityId: result.id,
      details: {
        slug: result.slug,
        sourceRef: result.sourceRef,
      },
    });

    res.json(result);
  });

  return router;
}
