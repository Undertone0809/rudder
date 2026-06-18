import { normalizeModelFallbacks } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  createLibraryDocumentSchema,
  createOrganizationResourceSchema,
  createOrganizationSchema,
  createOrganizationWorkspaceDirectorySchema,
  createOrganizationWorkspaceFileSchema,
  createWorkspaceBackupSchema,
  moveOrganizationWorkspaceEntrySchema,
  organizationIntelligenceProfilePurposeSchema,
  organizationPortabilityExportSchema,
  organizationPortabilityImportSchema,
  organizationPortabilityPreviewSchema,
  renameOrganizationWorkspaceEntrySchema,
  restoreLibraryDocumentRevisionSchema,
  restoreWorkspaceBackupSchema,
  updateLibraryDocumentSchema,
  updateOrganizationBrandingSchema,
  updateOrganizationResourceSchema,
  updateOrganizationSchema,
  updateOrganizationWorkspaceFileSchema,
  upsertOrganizationIntelligenceProfileSchema,
} from "@rudderhq/shared";
import { Router, type Request } from "express";
import path from "node:path";
import { findServerAdapter } from "../agent-runtimes/index.js";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  budgetService,
  documentService,
  logActivity,
  organizationExportJobService,
  organizationIntelligenceProfileService,
  organizationPortabilityService,
  organizationService,
  organizationSkillService,
  resourceCatalogService,
  secretService,
  workspaceBackupService,
} from "../services/index.js";
import { libraryEntryService } from "../services/library-entries.js";
import { organizationWorkspaceBrowserService } from "../services/organization-workspace-browser.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const EMBEDDED_IMAGE_DATA_URL_RE = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+_-]+(?:=[a-z0-9.+_-]+)?)*,/i;
const EMBEDDED_IMAGE_DATA_URL_ERROR =
  "Embedded image data URLs are not allowed in Library files. Upload images as attachments or assets and reference their content URL instead.";

type RuntimeChainTestTarget = {
  label: string;
  runtimeType: string;
  config: Record<string, unknown>;
};

function assertNoEmbeddedImageDataUrls(content: string) {
  if (EMBEDDED_IMAGE_DATA_URL_RE.test(content)) {
    throw unprocessable(EMBEDDED_IMAGE_DATA_URL_ERROR);
  }
}

function buildRuntimeChainTestTargets(
  agentRuntimeType: string,
  agentRuntimeConfig: Record<string, unknown>,
): RuntimeChainTestTarget[] {
  const primaryConfig = { ...agentRuntimeConfig };
  delete primaryConfig.modelFallbacks;
  const primaryModel = typeof primaryConfig.model === "string" ? primaryConfig.model : null;
  const fallbacks = normalizeModelFallbacks(agentRuntimeConfig.modelFallbacks, {
    agentRuntimeType,
    model: primaryModel,
  });
  return [
    {
      label: "Primary",
      runtimeType: agentRuntimeType,
      config: primaryConfig,
    },
    ...fallbacks.map((fallback, index) => ({
      label: `Fallback ${index + 1}`,
      runtimeType: fallback.agentRuntimeType,
      config: {
        ...(fallback.config ?? {}),
        model: fallback.model,
      },
    })),
  ];
}

function blockingEnvironmentMessage(result: {
  status?: string;
  checks?: Array<{ level?: string; message?: string }>;
}) {
  if (result.status === "pass") return null;
  const errorCheck = result.checks?.find((check) => check.level === "error");
  return errorCheck?.message ?? `Runtime environment returned ${result.status ?? "unknown"} status.`;
}

export function organizationRoutes(db: Db, storage?: StorageService) {
  const router = Router();
  const svc = organizationService(db);
  const agents = agentService(db);
  const portability = organizationPortabilityService(db, storage);
  const organizationSkills = organizationSkillService(db);
  const intelligenceProfiles = organizationIntelligenceProfileService(db);
  const access = accessService(db);
  const budgets = budgetService(db);
  const resources = resourceCatalogService(db);
  const documents = documentService(db);
  const libraryEntries = libraryEntryService(db);
  const workspaceBrowser = organizationWorkspaceBrowserService(db);
  const workspaceBackups = workspaceBackupService(db);
  const exportJobs = organizationExportJobService();
  const secrets = secretService(db);
  const strictSecretsMode = process.env.RUDDER_SECRETS_STRICT_MODE === "true";

  async function assertRuntimeChainUsable(
    orgId: string,
    agentRuntimeType: string,
    agentRuntimeConfig: Record<string, unknown>,
  ) {
    const targets = buildRuntimeChainTestTargets(agentRuntimeType, agentRuntimeConfig);
    for (const target of targets) {
      const adapter = findServerAdapter(target.runtimeType);
      if (!adapter) {
        throw unprocessable(`Unknown adapter type in ${target.label}: ${target.runtimeType}`);
      }
      const normalizedAdapterConfig = await secrets.normalizeAdapterConfigForPersistence(
        orgId,
        target.config,
        { strictMode: strictSecretsMode },
      );
      const { config: runtimeAdapterConfig } = await secrets.resolveAdapterConfigForRuntime(
        orgId,
        normalizedAdapterConfig,
      );
      const result = await adapter.testEnvironment({
        orgId,
        agentRuntimeType: target.runtimeType,
        config: runtimeAdapterConfig,
      });
      const blockingMessage = blockingEnvironmentMessage(result);
      if (blockingMessage) {
        throw unprocessable(`Runtime chain test failed for ${target.label}: ${blockingMessage}`, {
          runtimeType: target.runtimeType,
          result,
        });
      }
    }
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

  async function assertCanWriteWorkspaceFile(req: Request, orgId: string) {
    assertCompanyAccess(req, orgId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.orgId !== orgId) {
      throw forbidden("Agent key cannot access another organization");
    }
  }

  function assertAgentLibraryProjectPath(req: Request, requestedPath: string, mode: "directory" | "file") {
    if (req.actor.type !== "agent") return;
    const rawPath = requestedPath.trim().replaceAll("\\", "/").replace(/^\/+/, "");
    const rawParts = rawPath.split("/");
    const hasUnsafeSegment = rawParts.some((part) => part === "." || part === "..");
    const normalizedPath = path.posix.normalize(rawPath);
    const safePath = normalizedPath === "." ? "" : normalizedPath;
    const parts = safePath.split("/").filter(Boolean);
    const allowed = mode === "directory"
      ? safePath === "projects" || (parts[0] === "projects" && parts.length >= 2)
      : parts[0] === "projects" && parts.length >= 3;
    if (hasUnsafeSegment || !allowed) {
      throw forbidden("Agent Library file access is limited to `library:projects/<project-key>/...`");
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

  router.get("/:orgId/library/documents", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const result = await documents.listLibraryDocuments(orgId);
    res.json(result);
  });

  router.post("/:orgId/library/documents", validate(createLibraryDocumentSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const actor = getActorInfo(req);
    const document = await documents.createLibraryDocument({
      orgId,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body ?? "",
      changeSummary: req.body.changeSummary ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "library.document.created",
      entityType: "document",
      entityId: document.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        title: document.title,
        revisionNumber: document.latestRevisionNumber,
      },
    });
    res.status(201).json(document);
  });

  router.get("/:orgId/library/documents/:documentId", async (req, res) => {
    const orgId = req.params.orgId as string;
    const documentId = req.params.documentId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const document = await documents.getLibraryDocumentById(orgId, documentId);
    if (!document) {
      res.status(404).json({ error: "Library document not found" });
      return;
    }
    res.json(document);
  });

  router.get("/:orgId/library/entries/:entryId", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const entry = await libraryEntries.getById(orgId, req.params.entryId as string);
    if (!entry) {
      res.status(404).json({ error: "Library entry not found" });
      return;
    }
    res.json(entry);
  });

  router.patch("/:orgId/library/documents/:documentId", validate(updateLibraryDocumentSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    const documentId = req.params.documentId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const actor = getActorInfo(req);
    const document = await documents.updateLibraryDocument({
      orgId,
      documentId,
      title: req.body.title ?? null,
      format: req.body.format,
      body: req.body.body,
      changeSummary: req.body.changeSummary ?? null,
      baseRevisionId: req.body.baseRevisionId ?? null,
      createdByAgentId: actor.agentId ?? null,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!document) {
      res.status(404).json({ error: "Library document not found" });
      return;
    }
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "library.document.updated",
      entityType: "document",
      entityId: document.id,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        title: document.title,
        revisionNumber: document.latestRevisionNumber,
      },
    });
    res.json(document);
  });

  router.get("/:orgId/library/documents/:documentId/revisions", async (req, res) => {
    const orgId = req.params.orgId as string;
    const documentId = req.params.documentId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const document = await documents.getLibraryDocumentById(orgId, documentId);
    if (!document) {
      res.status(404).json({ error: "Library document not found" });
      return;
    }
    const revisions = await documents.listLibraryDocumentRevisions(orgId, documentId);
    res.json(revisions);
  });

  router.post(
    "/:orgId/library/documents/:documentId/revisions/:revisionId/restore",
    validate(restoreLibraryDocumentRevisionSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const documentId = req.params.documentId as string;
      const revisionId = req.params.revisionId as string;
      assertCompanyAccess(req, orgId);
      assertBoard(req);
      const actor = getActorInfo(req);
      const document = await documents.restoreLibraryDocumentRevision({
        orgId,
        documentId,
        revisionId,
        changeSummary: req.body.changeSummary ?? null,
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      if (!document) {
        res.status(404).json({ error: "Library document revision not found" });
        return;
      }
      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "library.document.restored",
        entityType: "document",
        entityId: document.id,
        agentId: actor.agentId,
        runId: actor.runId,
        details: {
          title: document.title,
          revisionNumber: document.latestRevisionNumber,
          restoredRevisionId: revisionId,
        },
      });
      res.json(document);
    },
  );

  router.get("/:orgId/resources", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const catalog = await resources.listOrganizationResources(orgId);
    res.json(catalog);
  });

  router.get("/:orgId/intelligence-profiles", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    res.json(await intelligenceProfiles.list(orgId));
  });

  router.put(
    "/:orgId/intelligence-profiles/:purpose",
    validate(upsertOrganizationIntelligenceProfileSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCompanyAccess(req, orgId);
      assertBoard(req);
      const purpose = organizationIntelligenceProfilePurposeSchema.safeParse(req.params.purpose);
      if (!purpose.success) {
        res.status(404).json({ error: "Unknown intelligence profile purpose" });
        return;
      }

      const input = { ...req.body };
      if (input.status === "configured") {
        await assertRuntimeChainUsable(
          orgId,
          input.agentRuntimeType,
          input.agentRuntimeConfig ?? {},
        );
        input.lastVerifiedAt = new Date();
        input.lastError = null;
      }
      const profile = await intelligenceProfiles.upsert(orgId, purpose.data, input);
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "organization.intelligence_profile.updated",
        entityType: "organization_intelligence_profile",
        entityId: profile.id,
        details: {
          purpose: profile.purpose,
          agentRuntimeType: profile.agentRuntimeType,
          status: profile.status,
        },
      });
      res.json(profile);
    },
  );

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
    assertAgentLibraryProjectPath(req, directoryPath, "directory");
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
    assertAgentLibraryProjectPath(req, filePath, "file");
    const result = await workspaceBrowser.readFile(orgId, filePath);
    res.json(result);
  });

  router.get("/:orgId/workspace/file/content", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    if (req.actor.type !== "agent") {
      assertBoard(req);
    }
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    assertAgentLibraryProjectPath(req, filePath, "file");
    const workspaceFile = await workspaceBrowser.readAttachmentFile(orgId, filePath);
    const normalizedContentType = workspaceFile.contentType.toLowerCase();
    if (!normalizedContentType.startsWith("image/") && normalizedContentType !== "application/pdf") {
      res.status(415).json({ error: "Workspace file is not an inline preview" });
      return;
    }

    res.setHeader("Content-Type", workspaceFile.contentType);
    res.setHeader("Content-Length", String(workspaceFile.buffer.length));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (workspaceFile.contentType === "image/svg+xml") {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    res.setHeader("Content-Disposition", `inline; filename="${workspaceFile.originalFilename.replaceAll("\"", "")}"`);
    res.send(workspaceFile.buffer);
  });

  router.get("/:orgId/workspace/mention-files", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const query = typeof req.query.q === "string" ? req.query.q : "";
    const rawLimit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : null;
    const entries = await workspaceBrowser.listMentionableFiles(orgId, {
      query,
      limit: Number.isFinite(rawLimit) ? rawLimit : null,
    });
    res.json({ entries });
  });

  router.post("/:orgId/workspace/file", validate(createOrganizationWorkspaceFileSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanWriteWorkspaceFile(req, orgId);
    assertAgentLibraryProjectPath(req, req.body.filePath, "file");
    const content = req.body.content ?? "";
    assertNoEmbeddedImageDataUrls(content);
    const result = await workspaceBrowser.createFile(orgId, req.body.filePath, content);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.workspace_file.created",
      entityType: "organization",
      entityId: orgId,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        path: result.filePath,
      },
    });
    res.status(201).json(result);
  });

  router.post("/:orgId/workspace/directory", validate(createOrganizationWorkspaceDirectorySchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const result = await workspaceBrowser.createDirectory(orgId, req.body.directoryPath);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.workspace_directory.created",
      entityType: "organization",
      entityId: orgId,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        path: result.path,
      },
    });
    res.status(201).json(result);
  });

  router.patch("/:orgId/workspace/file", validate(updateOrganizationWorkspaceFileSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanWriteWorkspaceFile(req, orgId);
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    assertAgentLibraryProjectPath(req, filePath, "file");
    assertNoEmbeddedImageDataUrls(req.body.content);
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

  router.patch("/:orgId/workspace/entry", validate(renameOrganizationWorkspaceEntrySchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const entryPath = typeof req.query.path === "string" ? req.query.path : "";
    const result = await workspaceBrowser.renameEntry(orgId, entryPath, req.body.name);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.workspace_entry.renamed",
      entityType: "organization",
      entityId: orgId,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        previousPath: result.previousPath,
        path: result.path,
        isDirectory: result.isDirectory,
      },
    });
    res.json(result);
  });

  router.patch("/:orgId/workspace/entry/move", validate(moveOrganizationWorkspaceEntrySchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const entryPath = typeof req.query.path === "string" ? req.query.path : "";
    const result = await workspaceBrowser.moveEntry(orgId, entryPath, req.body.destinationDirectoryPath);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.workspace_entry.moved",
      entityType: "organization",
      entityId: orgId,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        previousPath: result.previousPath,
        path: result.path,
        destinationDirectoryPath: req.body.destinationDirectoryPath,
        isDirectory: result.isDirectory,
      },
    });
    res.json(result);
  });

  router.delete("/:orgId/workspace/entry", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const entryPath = typeof req.query.path === "string" ? req.query.path : "";
    const result = await workspaceBrowser.deleteEntry(orgId, entryPath);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.workspace_entry.deleted",
      entityType: "organization",
      entityId: orgId,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        path: result.path,
        isDirectory: result.isDirectory,
      },
    });
    res.json(result);
  });

  router.delete("/:orgId/workspace/legacy-heartbeat-instructions", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);
    const result = await workspaceBrowser.deleteLegacyHeartbeatInstructions(orgId);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "organization.legacy_heartbeat_instructions.deleted",
      entityType: "organization",
      entityId: orgId,
      agentId: actor.agentId,
      runId: actor.runId,
      details: {
        deletedPaths: result.deleted.map((entry) => entry.path),
        deletedCount: result.deleted.length,
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

  router.post("/:orgId/exports/jobs", validate(organizationPortabilityExportSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanManagePortability(req, orgId, "exports");
    const job = exportJobs.create(orgId, ({ signal, onProgress }) =>
      portability.exportBundle(orgId, req.body, { signal, onProgress })
    );
    res.status(202).json({ job });
  });

  router.get("/:orgId/exports/jobs/:jobId", async (req, res) => {
    const orgId = req.params.orgId as string;
    const jobId = req.params.jobId as string;
    await assertCanManagePortability(req, orgId, "exports");
    const job = exportJobs.get(jobId);
    if (!job || job.orgId !== orgId) {
      res.status(404).json({ error: "Export job not found" });
      return;
    }
    res.json(job);
  });

  router.delete("/:orgId/exports/jobs/:jobId", async (req, res) => {
    const orgId = req.params.orgId as string;
    const jobId = req.params.jobId as string;
    await assertCanManagePortability(req, orgId, "exports");
    const existing = exportJobs.get(jobId);
    if (!existing || existing.orgId !== orgId) {
      res.status(404).json({ error: "Export job not found" });
      return;
    }
    const job = exportJobs.cancel(jobId);
    res.json(job);
  });

  router.get("/:orgId/exports/jobs/:jobId/result", async (req, res) => {
    const orgId = req.params.orgId as string;
    const jobId = req.params.jobId as string;
    await assertCanManagePortability(req, orgId, "exports");
    const job = exportJobs.get(jobId);
    if (!job || job.orgId !== orgId) {
      res.status(404).json({ error: "Export job not found" });
      return;
    }
    if (job.status !== "succeeded") {
      res.status(409).json({ error: "Export job is not ready" });
      return;
    }
    const result = exportJobs.getResult(jobId);
    if (!result) {
      res.status(404).json({ error: "Export result expired" });
      return;
    }
    res.json(result);
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
