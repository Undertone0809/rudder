import type { Db } from "@rudderhq/db";
import {
  configureRudderPluginMarketplaceSchema,
  configureRudderPluginMcpSchema,
  configureRudderPluginSkillsSchema,
  customizeRudderPluginSkillSchema,
  inspectRudderPluginArchiveSchema,
  inspectRudderPluginSchema,
  installRudderPluginSchema,
  previewRudderPluginSourceSchema,
  updateRudderPluginEnablementSchema,
} from "@rudderhq/shared";
import { Router, type Request } from "express";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService, logActivity } from "../services/index.js";
import type { ManagedMcpConnectionServiceOptions } from "../services/mcp/managed-connections.js";
import { rudderPluginCatalogService } from "../services/rudder-plugin-catalog.js";
import { rudderPluginService } from "../services/rudder-plugins.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function rudderPluginRoutes(db: Db, mcpOptions: ManagedMcpConnectionServiceOptions) {
  const router = Router();
  const plugins = rudderPluginService(db, mcpOptions);
  const catalog = rudderPluginCatalogService(db, mcpOptions);
  const access = accessService(db);

  function assertCanRead(req: Request, orgId: string) {
    assertBoard(req);
    assertCompanyAccess(req, orgId);
  }

  async function assertCanManage(req: Request, orgId: string) {
    assertCanRead(req, orgId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (!userId) throw forbidden("Organization owner access required");
    const membership = await access.getMembership(orgId, "user", userId);
    if (!membership || membership.status !== "active" || membership.membershipRole !== "owner") {
      throw forbidden("Organization owner access required");
    }
  }

  async function record(req: Request, orgId: string, action: string, entityId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "installed_plugin",
      entityId,
      details,
    });
  }

  router.get("/orgs/:orgId/plugins", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCanRead(req, orgId);
    res.json(await plugins.directory(orgId));
  });

  router.get("/orgs/:orgId/plugins/catalog", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCanRead(req, orgId);
    res.json(await catalog.catalog(orgId));
  });

  router.post("/orgs/:orgId/plugins/catalog/:slug/preview", async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanManage(req, orgId);
    const detail = await catalog.previewCatalog(orgId, req.params.slug as string);
    await record(req, orgId, "plugin.catalog_previewed", detail.previewId ?? detail.installedPluginId ?? detail.packageId, {
      slug: detail.slug,
      sourceKind: detail.sourceKind,
      commitSha: detail.resolution.commitSha,
      version: detail.resolution.version,
      componentCount: detail.components.length,
    });
    res.status(201).json(detail);
  });

  router.post(
    "/orgs/:orgId/plugins/imports/preview-source",
    validate(previewRudderPluginSourceSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanManage(req, orgId);
      const detail = await catalog.previewSource(orgId, req.body.source, req.body.subdirectory);
      await record(req, orgId, "plugin.source_previewed", detail.previewId ?? detail.installedPluginId ?? detail.packageId, {
        source: detail.resolution.source,
        subdirectory: detail.resolution.subdirectory,
        commitSha: detail.resolution.commitSha,
        componentCount: detail.components.length,
      });
      res.status(201).json(detail);
    },
  );

  router.get("/plugins/catalog/:slug/icon", async (req, res) => {
    const result = await catalog.icon(req.params.slug as string, req.query.theme === "dark");
    res.setHeader("content-type", "image/png");
    res.setHeader("cache-control", "public, max-age=3600, stale-while-revalidate=86400");
    if (result.etag) res.setHeader("etag", result.etag);
    if (result.freshness === "stale") res.setHeader("warning", '110 - "Plugin catalog response is stale"');
    res.send(result.content);
  });

  router.get("/orgs/:orgId/plugins/previews/:previewId", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCanRead(req, orgId);
    res.json(await catalog.previewDetail(orgId, req.params.previewId as string));
  });

  router.get("/orgs/:orgId/plugins/:pluginId", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCanRead(req, orgId);
    const plugin = await plugins.getInstalled(orgId, req.params.pluginId as string);
    if (!plugin) {
      res.status(404).json({ error: "Installed Plugin not found" });
      return;
    }
    res.json(plugin);
  });

  router.post(
    "/orgs/:orgId/plugins/imports/inspect",
    validate(inspectRudderPluginSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanManage(req, orgId);
      const report = await plugins.inspect(orgId, req.body);
      await record(req, orgId, "plugin.import_inspected", report.id, {
        packageId: report.packageId,
        sourceType: report.sourceType,
        status: report.status,
        digest: report.digest,
        componentCount: report.components.length,
        errorCount: report.errors.length,
      });
      res.status(201).json(report);
    },
  );

  router.post(
    "/orgs/:orgId/plugins/imports/inspect-archive",
    validate(inspectRudderPluginArchiveSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanManage(req, orgId);
      const report = await plugins.inspectArchive(orgId, req.body);
      await record(req, orgId, "plugin.archive_inspected", report.id, {
        filename: req.body.filename,
        packageId: report.packageId,
        status: report.status,
        digest: report.digest,
      });
      res.status(201).json(report);
    },
  );

  router.post(
    "/orgs/:orgId/plugins/marketplaces",
    validate(configureRudderPluginMarketplaceSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanManage(req, orgId);
      const reports = await plugins.configureMarketplace(orgId, req.body);
      await record(req, orgId, "plugin.marketplace_configured", reports[0]!.id, {
        sourceLabel: req.body.sourceLabel,
        sourceType: req.body.github ? "git" : "marketplace",
        reportIds: reports.map((report) => report.id),
      });
      res.status(201).json(reports);
    },
  );

  router.get("/orgs/:orgId/plugins/imports/:reportId", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCanRead(req, orgId);
    const report = await plugins.getImportReport(orgId, req.params.reportId as string);
    if (!report) {
      res.status(404).json({ error: "Plugin import report not found" });
      return;
    }
    res.json(report);
  });

  router.post(
    "/orgs/:orgId/plugins/imports/:reportId/install",
    validate(installRudderPluginSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanManage(req, orgId);
      const plugin = await plugins.install(
        orgId,
        req.params.reportId as string,
        req.body.enabled,
        req.body.confirmAccessExpansion,
        req.body.skillConflictStrategy,
      );
      await record(req, orgId, "plugin.installed", plugin.id, {
        packageId: plugin.packageId,
        digest: plugin.digest,
        setupState: plugin.setupState,
        componentCount: plugin.components.length,
      });
      res.status(201).json(plugin);
    },
  );

  router.patch(
    "/orgs/:orgId/plugins/:pluginId/enablement",
    validate(updateRudderPluginEnablementSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanManage(req, orgId);
      const plugin = await plugins.setEnabled(orgId, req.params.pluginId as string, req.body.enabled);
      await record(req, orgId, req.body.enabled ? "plugin.enabled" : "plugin.disabled", plugin.id, {
        enabled: plugin.enabled,
      });
      res.json(plugin);
    },
  );

  router.post(
    "/orgs/:orgId/plugins/:pluginId/skills/agents",
    validate(configureRudderPluginSkillsSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanManage(req, orgId);
      const plugin = await plugins.configureSkills(orgId, req.params.pluginId as string, req.body.agentIds);
      await record(req, orgId, "plugin.skills_assigned", req.params.pluginId as string, {
        agentIds: req.body.agentIds,
      });
      res.json(plugin);
    },
  );

  router.post(
    "/orgs/:orgId/plugins/:pluginId/mcp/setup",
    validate(configureRudderPluginMcpSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanManage(req, orgId);
      const actor = getActorInfo(req);
      const component = await plugins.configureMcp(orgId, req.params.pluginId as string, req.body.componentId, {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.agentId,
      });
      await record(req, orgId, "plugin.mcp_setup_prepared", req.params.pluginId as string, {
        componentId: component.id,
        connectionId: component.targetId,
      });
      res.json(component);
    },
  );

  router.get("/orgs/:orgId/plugins/:pluginId/mcp/:componentId/resources", async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanManage(req, orgId);
    res.json(await plugins.listMcpUiResources(
      orgId,
      req.params.pluginId as string,
      req.params.componentId as string,
    ));
  });

  router.get("/orgs/:orgId/plugins/:pluginId/mcp/:componentId/resource", async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanManage(req, orgId);
    const uri = typeof req.query.uri === "string" ? req.query.uri : "";
    if (!uri || uri.length > 2_048) {
      res.status(400).json({ error: "A bounded MCP resource URI is required" });
      return;
    }
    res.json(await plugins.readMcpUiResource(
      orgId,
      req.params.pluginId as string,
      req.params.componentId as string,
      uri,
    ));
  });

  router.post(
    "/orgs/:orgId/plugins/:pluginId/skills/customize",
    validate(customizeRudderPluginSkillSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanManage(req, orgId);
      const skill = await plugins.customizeSkill(orgId, req.params.pluginId as string, req.body.componentId);
      await record(req, orgId, "plugin.skill_customized", req.params.pluginId as string, {
        componentId: req.body.componentId,
        forkSkillId: skill.id,
      });
      res.status(201).json(skill);
    },
  );

  router.delete("/orgs/:orgId/plugins/:pluginId", async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanManage(req, orgId);
    const result = await plugins.uninstall(orgId, req.params.pluginId as string);
    await record(req, orgId, "plugin.uninstalled", result.id, { preservedExternalData: true });
    res.json(result);
  });

  router.post("/orgs/:orgId/plugins/:pluginId/rollback", async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanManage(req, orgId);
    const plugin = await plugins.rollback(orgId, req.params.pluginId as string);
    await record(req, orgId, "plugin.rolled_back", plugin.id, {
      packageId: plugin.packageId,
      version: plugin.version,
    });
    res.json(plugin);
  });

  router.post("/orgs/:orgId/plugins/:pluginId/local-app-update/apply", async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanManage(req, orgId);
    const plugin = await plugins.applyPendingLocalAppUpdate(orgId, req.params.pluginId as string);
    await record(req, orgId, "plugin.local_app_update_applied", plugin.id, {
      packageId: plugin.packageId,
      version: plugin.version,
      digest: plugin.digest,
    });
    res.json(plugin);
  });

  return router;
}
