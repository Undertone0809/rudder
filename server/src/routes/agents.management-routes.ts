import { Router, type Request, type Response } from "express";
import multer from "multer";
import sharp from "sharp";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import path from "node:path";
import type { Db } from "@rudderhq/db";
import { agents as agentsTable, organizations, heartbeatRuns } from "@rudderhq/db";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import {
  agentSkillSyncSchema,
  agentSkillEnableSchema,
  createAgentKeySchema,
  createAgentHireSchema,
  createAgentSchema,
  deriveAgentUrlKey,
  isUuidLike,
  organizationSkillCreateSchema,
  resetAgentSessionSchema,
  testAgentRuntimeEnvironmentSchema,
  type AgentSkillAnalytics,
  type AgentSkillSnapshot,
  type InstanceSchedulerHeartbeatAgent,
  upsertAgentInstructionsFileSchema,
  updateAgentInstructionsBundleSchema,
  updateAgentPermissionsSchema,
  updateAgentInstructionsPathSchema,
  wakeAgentSchema,
  updateAgentSchema,
} from "@rudderhq/shared";
import { validate } from "../middleware/validate.js";
import {
  agentService,
  agentInstructionsService,
  accessService,
  approvalService,
  organizationSkillService,
  budgetService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
  secretService,
  syncInstructionsBundleConfigFromFilePath,
  workspaceOperationService,
} from "../services/index.js";
import { normalizeCreatedAgentAvatarIcon } from "../services/agents.js";
import { assetService } from "../services/assets.js";
import type { StorageService } from "../storage/types.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";
import { findServerAdapter, listAgentRuntimeModels } from "../agent-runtimes/index.js";
import { redactEventPayload } from "../redaction.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { renderOrgChartSvg, renderOrgChartPng, type OrgNode, type OrgChartStyle, ORG_CHART_STYLES } from "./org-chart-svg.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { runClaudeLogin } from "@rudderhq/agent-runtime-claude-local/server";
import {
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX,
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_SEARCH,
} from "@rudderhq/agent-runtime-codex-local";
import { DEFAULT_CURSOR_LOCAL_MODEL } from "@rudderhq/agent-runtime-cursor-local";
import { DEFAULT_GEMINI_LOCAL_MODEL } from "@rudderhq/agent-runtime-gemini-local";
import { ensureOpenCodeModelConfiguredAndAvailable } from "@rudderhq/agent-runtime-opencode-local/server";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

type AgentManagementRouteContext = {
  router: Router;
  db: Db;
  storage?: StorageService;
  [key: string]: any;
};

export function registerAgentManagementRoutes(ctx: AgentManagementRouteContext) {
  const {
    router,
    db,
    storage,
    svc,
    assets,
    access,
    approvalsSvc,
    budgets,
    heartbeat,
    issueApprovalsSvc,
    secretsSvc,
    instructions,
    organizationSkills,
    intelligenceProfiles,
    workspaceOperations,
    instanceSettings,
    avatarUpload,
    strictSecretsMode,
    persistReconciledInstructionsBundle,
    getCurrentUserRedactionOptions,
    canCreateAgents,
    buildAgentAccessState,
    assertCanCreateAgentsForCompany,
    parseSourceIssueIds,
    applyCreateDefaultsByAdapterType,
    resolveDesiredSkillAssignment,
    assertAdapterConfigConstraints,
    assertAgentAvatarAssetBelongsToOrg,
    materializeDefaultInstructionsBundleForNewAgent,
    applyDefaultAgentTaskAssignGrant,
    buildAgentDetail,
    assertCanUpdateAgent,
    runSingleFileUpload,
    AGENT_AVATAR_CONTENT_TYPES,
    compressAgentAvatar,
    assertCanManageInstructionsPath,
    asRecord,
    asNonEmptyString,
    resolveInstructionsFilePath,
    assertCanReadAgent,
    preserveInstructionsBundleConfig,
    summarizeAgentUpdateDetails,
    redactAgentConfiguration,
    stripPersistedSkillSyncConfig,
    withRuntimeSkillEntries,
    DEFAULT_INSTRUCTIONS_PATH_KEYS,
    DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES,
    KNOWN_INSTRUCTIONS_PATH_KEYS,
    KNOWN_INSTRUCTIONS_BUNDLE_KEYS,
  } = ctx;
  router.post("/orgs/:orgId/agent-hires", validate(createAgentHireSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanCreateAgentsForCompany(req, orgId);
    const sourceIssueIds = parseSourceIssueIds(req.body);
    const {
      desiredSkills: requestedDesiredSkills,
      sourceIssueId: _sourceIssueId,
      sourceIssueIds: _sourceIssueIds,
      ...hireInput
    } = req.body;
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      hireInput.agentRuntimeType,
      ((hireInput.agentRuntimeConfig ?? {}) as Record<string, unknown>),
    );
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      orgId,
      stripPersistedSkillSyncConfig(requestedAdapterConfig),
      { strictMode: strictSecretsMode },
    );
    const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
      orgId,
      normalizedAdapterConfig,
    );
    const desiredSkillAssignment = await resolveDesiredSkillAssignment(
      orgId,
      hireInput.agentRuntimeType,
      runtimeAdapterConfig,
      Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined,
    );
    await assertAdapterConfigConstraints(
      orgId,
      hireInput.agentRuntimeType,
      normalizedAdapterConfig,
    );
    const normalizedHireInput = {
      ...hireInput,
      icon: normalizeCreatedAgentAvatarIcon(hireInput.icon),
      agentRuntimeConfig: normalizedAdapterConfig,
    };
    await assertAgentAvatarAssetBelongsToOrg(orgId, normalizedHireInput.icon);

    const organization = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .then((rows) => rows[0] ?? null);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    const requiresApproval = organization.requireBoardApprovalForNewAgents;
    const status = requiresApproval ? "pending_approval" : "idle";
    const createdAgent = await svc.create(orgId, {
      ...normalizedHireInput,
      status,
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await organizationSkills.replaceEnabledSkillKeysForAgent(
      orgId,
      createdAgent.id,
      desiredSkillAssignment.desiredSkills,
    );
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent);
    if (!requiresApproval) {
      await intelligenceProfiles.ensureDefaultsFromRuntime({
        orgId,
        agentRuntimeType: agent.agentRuntimeType,
        agentRuntimeConfig: (agent.agentRuntimeConfig ?? {}) as Record<string, unknown>,
      });
    }

    let approval: Awaited<ReturnType<typeof approvalsSvc.getById>> | null = null;
    const actor = getActorInfo(req);

    if (requiresApproval) {
      const requestedAdapterType = normalizedHireInput.agentRuntimeType ?? agent.agentRuntimeType;
      const requestedAdapterConfig =
        redactEventPayload(
          (agent.agentRuntimeConfig ?? normalizedHireInput.agentRuntimeConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedRuntimeConfig =
        redactEventPayload(
          (normalizedHireInput.runtimeConfig ?? agent.runtimeConfig) as Record<string, unknown>,
        ) ?? {};
      const requestedMetadata =
        redactEventPayload(
          ((normalizedHireInput.metadata ?? agent.metadata ?? {}) as Record<string, unknown>),
        ) ?? {};
      approval = await approvalsSvc.create(orgId, {
        type: "hire_agent",
        requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        status: "pending",
        payload: {
          name: agent.name,
          role: normalizedHireInput.role,
          title: normalizedHireInput.title ?? null,
          icon: agent.icon ?? normalizedHireInput.icon ?? null,
          reportsTo: normalizedHireInput.reportsTo ?? null,
          capabilities: normalizedHireInput.capabilities ?? null,
          agentRuntimeType: requestedAdapterType,
          agentRuntimeConfig: requestedAdapterConfig,
          runtimeConfig: requestedRuntimeConfig,
          budgetMonthlyCents:
            typeof normalizedHireInput.budgetMonthlyCents === "number"
              ? normalizedHireInput.budgetMonthlyCents
              : agent.budgetMonthlyCents,
          desiredSkills: desiredSkillAssignment.desiredSkills,
          metadata: requestedMetadata,
          agentId: agent.id,
          requestedByAgentId: actor.actorType === "agent" ? actor.actorId : null,
          requestedConfigurationSnapshot: {
            agentRuntimeType: requestedAdapterType,
            agentRuntimeConfig: requestedAdapterConfig,
            runtimeConfig: requestedRuntimeConfig,
            desiredSkills: desiredSkillAssignment.desiredSkills,
          },
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });

      if (sourceIssueIds.length > 0) {
        const links = await issueApprovalsSvc.linkManyForApproval(approval.id, sourceIssueIds, {
          agentId: actor.actorType === "agent" ? actor.actorId : null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
        for (const link of links) {
          await logActivity(db, {
            orgId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "issue.approval_linked",
            entityType: "issue",
            entityId: link.issueId,
            details: {
              approvalId: approval.id,
              linkCreatedAt: link.createdAt.toISOString(),
            },
          });
        }
      }
    }

    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.hire_created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        requiresApproval,
        approvalId: approval?.id ?? null,
        issueIds: sourceIssueIds,
        desiredSkills: desiredSkillAssignment.desiredSkills,
      },
    });

    await applyDefaultAgentTaskAssignGrant(
      orgId,
      agent.id,
      actor.actorType === "user" ? actor.actorId : null,
    );

    if (approval) {
      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type, linkedAgentId: agent.id },
      });
    }

    res.status(201).json({ agent, approval });
  });

  router.post("/orgs/:orgId/agents", validate(createAgentSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    if (req.actor.type === "agent") {
      assertBoard(req);
    }

    const {
      desiredSkills: requestedDesiredSkills,
      ...createInput
    } = req.body;
    const requestedAdapterConfig = applyCreateDefaultsByAdapterType(
      createInput.agentRuntimeType,
      ((createInput.agentRuntimeConfig ?? {}) as Record<string, unknown>),
    );
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      orgId,
      stripPersistedSkillSyncConfig(requestedAdapterConfig),
      { strictMode: strictSecretsMode },
    );
    const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
      orgId,
      normalizedAdapterConfig,
    );
    const desiredSkillAssignment = await resolveDesiredSkillAssignment(
      orgId,
      createInput.agentRuntimeType,
      runtimeAdapterConfig,
      Array.isArray(requestedDesiredSkills) ? requestedDesiredSkills : undefined,
    );
    await assertAdapterConfigConstraints(
      orgId,
      createInput.agentRuntimeType,
      normalizedAdapterConfig,
    );
    await assertAgentAvatarAssetBelongsToOrg(orgId, createInput.icon);

    const createdAgent = await svc.create(orgId, {
      ...createInput,
      icon: normalizeCreatedAgentAvatarIcon(createInput.icon),
      agentRuntimeConfig: normalizedAdapterConfig,
      status: "idle",
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    });
    await organizationSkills.replaceEnabledSkillKeysForAgent(
      orgId,
      createdAgent.id,
      desiredSkillAssignment.desiredSkills,
    );
    const agent = await materializeDefaultInstructionsBundleForNewAgent(createdAgent);
    await intelligenceProfiles.ensureDefaultsFromRuntime({
      orgId,
      agentRuntimeType: agent.agentRuntimeType,
      agentRuntimeConfig: (agent.agentRuntimeConfig ?? {}) as Record<string, unknown>,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.created",
      entityType: "agent",
      entityId: agent.id,
      details: {
        name: agent.name,
        role: agent.role,
        desiredSkills: desiredSkillAssignment.desiredSkills,
      },
    });

    await applyDefaultAgentTaskAssignGrant(
      orgId,
      agent.id,
      req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    );

    if (agent.budgetMonthlyCents > 0) {
      await budgets.upsertPolicy(
        orgId,
        {
          scopeType: "agent",
          scopeId: agent.id,
          amount: agent.budgetMonthlyCents,
          windowKind: "calendar_month_utc",
        },
        actor.actorType === "user" ? actor.actorId : null,
      );
    }

    res.status(201).json(agent);
  });

  router.patch("/agents/:id/permissions", validate(updateAgentPermissionsSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);

    if (req.actor.type === "agent") {
      const actorAgent = req.actor.agentId ? await svc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.orgId !== existing.orgId) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (actorAgent.role !== "ceo") {
        res.status(403).json({ error: "Only CEO can manage permissions" });
        return;
      }
    }

    const agent = await svc.updatePermissions(id, req.body);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const effectiveCanAssignTasks =
      agent.role === "ceo" || Boolean(agent.permissions?.canCreateAgents) || req.body.canAssignTasks;
    await access.ensureMembership(agent.orgId, "agent", agent.id, "member", "active");
    await access.setPrincipalPermission(
      agent.orgId,
      "agent",
      agent.id,
      "tasks:assign",
      effectiveCanAssignTasks,
      req.actor.type === "board" ? (req.actor.userId ?? null) : null,
    );

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: agent.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.permissions_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        canCreateAgents: agent.permissions?.canCreateAgents ?? false,
        canManageSkills: agent.permissions?.canManageSkills ?? true,
        canAssignTasks: effectiveCanAssignTasks,
      },
    });

    res.json(await buildAgentDetail(agent));
  });

  router.post("/agents/:id/avatar", async (req, res) => {
    if (!storage) {
      res.status(500).json({ error: "Storage service unavailable" });
      return;
    }

    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);

    try {
      await runSingleFileUpload(avatarUpload, req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Image exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: any }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }

    const inputContentType = (file.mimetype || "").toLowerCase();
    if (!AGENT_AVATAR_CONTENT_TYPES.has(inputContentType)) {
      res.status(422).json({ error: `Unsupported avatar image type: ${inputContentType || "unknown"}` });
      return;
    }

    const compressed = await compressAgentAvatar(file);
    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      orgId: existing.orgId,
      namespace: `assets/agents/${existing.id}/avatars`,
      originalFilename: file.originalname || "avatar.webp",
      contentType: "image/webp",
      body: compressed,
    });
    const asset = await assets.create(existing.orgId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    const avatarIcon = `asset:${asset.id}`;
    const agent = await svc.update(existing.id, { icon: avatarIcon });
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      orgId: agent.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.avatar_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        assetId: asset.id,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
        originalFilename: asset.originalFilename,
      },
    });

    res.status(201).json(agent);
  });

  router.patch("/agents/:id/instructions-path", validate(updateAgentInstructionsPathSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getInternalById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await assertCanManageInstructionsPath(req, existing);

    const existingAdapterConfig = asRecord(existing.agentRuntimeConfig) ?? {};
    const explicitKey = asNonEmptyString(req.body.agentRuntimeConfigKey);
    const defaultKey = DEFAULT_INSTRUCTIONS_PATH_KEYS[existing.agentRuntimeType] ?? null;
    const agentRuntimeConfigKey = explicitKey ?? defaultKey;
    if (!agentRuntimeConfigKey) {
      res.status(422).json({
        error: `No default instructions path key for adapter type '${existing.agentRuntimeType}'. Provide agentRuntimeConfigKey.`,
      });
      return;
    }

    const nextAdapterConfig: Record<string, unknown> = { ...existingAdapterConfig };
    if (req.body.path === null) {
      delete nextAdapterConfig[agentRuntimeConfigKey];
    } else {
      nextAdapterConfig[agentRuntimeConfigKey] = resolveInstructionsFilePath(req.body.path, existingAdapterConfig);
    }

    const syncedAdapterConfig = syncInstructionsBundleConfigFromFilePath(existing, nextAdapterConfig);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.orgId,
      syncedAdapterConfig,
      { strictMode: strictSecretsMode },
    );
    const actor = getActorInfo(req);
    const agent = await svc.update(
      id,
      { agentRuntimeConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_path_patch",
        },
      },
    );
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    const updatedAdapterConfig = asRecord(agent.agentRuntimeConfig) ?? {};
    const pathValue = asNonEmptyString(updatedAdapterConfig[agentRuntimeConfigKey]);

    await logActivity(db, {
      orgId: agent.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_path_updated",
      entityType: "agent",
      entityId: agent.id,
      details: {
        agentRuntimeConfigKey,
        path: pathValue,
        cleared: req.body.path === null,
      },
    });

    res.json({
      agentId: agent.id,
      agentRuntimeType: agent.agentRuntimeType,
      agentRuntimeConfigKey,
      path: pathValue,
    });
  });

  router.get("/agents/:id/instructions-bundle", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getInternalById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, existing);
    const result = await instructions.reconcileBundle(existing);
    await persistReconciledInstructionsBundle(existing, result);
    res.json(result.bundle);
  });

  router.patch("/agents/:id/instructions-bundle", validate(updateAgentInstructionsBundleSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getInternalById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);

    const actor = getActorInfo(req);
    const { bundle, agentRuntimeConfig } = await instructions.updateBundle(existing, req.body);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.orgId,
      agentRuntimeConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { agentRuntimeConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_patch",
        },
      },
    );

    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_bundle_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        mode: bundle.mode,
        rootPath: bundle.rootPath,
        entryFile: bundle.entryFile,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
      },
    });

    res.json(bundle);
  });

  router.get("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getInternalById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, existing);

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }
    const result = await instructions.reconcileBundle(existing);
    const effectiveAgent = await persistReconciledInstructionsBundle(existing, result);
    res.json(await instructions.readFile(effectiveAgent, relativePath));
  });

  router.put("/agents/:id/instructions-bundle/file", validate(upsertAgentInstructionsFileSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getInternalById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);

    const actor = getActorInfo(req);
    const result = await instructions.writeFile(existing, req.body.path, req.body.content, {
      clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate,
    });
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.orgId,
      result.agentRuntimeConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { agentRuntimeConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_file_put",
        },
      },
    );

    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_updated",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: result.file.path,
        size: result.file.size,
        clearLegacyPromptTemplate: req.body.clearLegacyPromptTemplate === true,
      },
    });

    res.json(result.file);
  });

  router.delete("/agents/:id/instructions-bundle/file", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getInternalById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanManageInstructionsPath(req, existing);

    const relativePath = typeof req.query.path === "string" ? req.query.path : "";
    if (!relativePath.trim()) {
      res.status(422).json({ error: "Query parameter 'path' is required" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await instructions.deleteFile(existing, relativePath);
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      existing.orgId,
      result.agentRuntimeConfig,
      { strictMode: strictSecretsMode },
    );
    await svc.update(
      id,
      { agentRuntimeConfig: normalizedAdapterConfig },
      {
        recordRevision: {
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          source: "instructions_bundle_file_delete",
        },
      },
    );
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.instructions_file_deleted",
      entityType: "agent",
      entityId: existing.id,
      details: {
        path: relativePath,
      },
    });

    res.json(result.bundle);
  });

  router.patch("/agents/:id", validate(updateAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getInternalById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);

    if (Object.prototype.hasOwnProperty.call(req.body, "permissions")) {
      res.status(422).json({ error: "Use /api/agents/:id/permissions for permission changes" });
      return;
    }

    const patchData = { ...(req.body as Record<string, unknown>) };
    const replaceAgentRuntimeConfig = patchData.replaceAgentRuntimeConfig === true;
    delete patchData.replaceAgentRuntimeConfig;
    if (Object.prototype.hasOwnProperty.call(patchData, "agentRuntimeConfig")) {
      const agentRuntimeConfig = asRecord(patchData.agentRuntimeConfig);
      if (!agentRuntimeConfig) {
        res.status(422).json({ error: "agentRuntimeConfig must be an object" });
        return;
      }
      const changingInstructionsPath = Object.keys(agentRuntimeConfig).some((key) =>
        KNOWN_INSTRUCTIONS_PATH_KEYS.has(key),
      );
      if (changingInstructionsPath) {
        await assertCanManageInstructionsPath(req, existing);
      }
      patchData.agentRuntimeConfig = agentRuntimeConfig;
    }

    const requestedAdapterType =
      typeof patchData.agentRuntimeType === "string" ? patchData.agentRuntimeType : existing.agentRuntimeType;
    const touchesAdapterConfiguration =
      Object.prototype.hasOwnProperty.call(patchData, "agentRuntimeType") ||
      Object.prototype.hasOwnProperty.call(patchData, "agentRuntimeConfig");
    if (touchesAdapterConfiguration) {
      const existingAdapterConfig = asRecord(existing.agentRuntimeConfig) ?? {};
      const changingAdapterType =
        typeof patchData.agentRuntimeType === "string" && patchData.agentRuntimeType !== existing.agentRuntimeType;
      const requestedAdapterConfig = Object.prototype.hasOwnProperty.call(patchData, "agentRuntimeConfig")
        ? (asRecord(patchData.agentRuntimeConfig) ?? {})
        : null;
      if (
        requestedAdapterConfig
        && replaceAgentRuntimeConfig
        && KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key: string) =>
          existingAdapterConfig[key] !== undefined && requestedAdapterConfig[key] === undefined,
        )
      ) {
        await assertCanManageInstructionsPath(req, existing);
      }
      let rawEffectiveAdapterConfig = requestedAdapterConfig ?? existingAdapterConfig;
      if (requestedAdapterConfig && !changingAdapterType && !replaceAgentRuntimeConfig) {
        rawEffectiveAdapterConfig = { ...existingAdapterConfig, ...requestedAdapterConfig };
      }
      if (changingAdapterType) {
        rawEffectiveAdapterConfig = preserveInstructionsBundleConfig(
          existingAdapterConfig,
          rawEffectiveAdapterConfig,
        );
      }
      const effectiveAdapterConfig = applyCreateDefaultsByAdapterType(
        requestedAdapterType,
        rawEffectiveAdapterConfig,
      );
      const normalizedEffectiveAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        existing.orgId,
        effectiveAdapterConfig,
        { strictMode: strictSecretsMode },
      );
      patchData.agentRuntimeConfig = syncInstructionsBundleConfigFromFilePath(existing, normalizedEffectiveAdapterConfig);
    }
    if (touchesAdapterConfiguration && requestedAdapterType === "opencode_local") {
      const effectiveAdapterConfig = asRecord(patchData.agentRuntimeConfig) ?? {};
      await assertAdapterConfigConstraints(
        existing.orgId,
        requestedAdapterType,
        effectiveAdapterConfig,
      );
    }
    if (Object.prototype.hasOwnProperty.call(patchData, "icon")) {
      await assertAgentAvatarAssetBelongsToOrg(existing.orgId, patchData.icon);
    }

    const actor = getActorInfo(req);
    const agent = await svc.update(id, patchData, {
      recordRevision: {
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
        source: "patch",
      },
    });
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      orgId: agent.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.updated",
      entityType: "agent",
      entityId: agent.id,
      details: summarizeAgentUpdateDetails(patchData),
    });

    res.json(agent);
  });

  router.post("/agents/:id/pause", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.pause(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      orgId: agent.orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.paused",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/resume", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.resume(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.resumeDeferredWakeupsForAgent(id);

    await logActivity(db, {
      orgId: agent.orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.resumed",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.post("/agents/:id/terminate", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.terminate(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await heartbeat.cancelActiveForAgent(id);

    await logActivity(db, {
      orgId: agent.orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.terminated",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json(agent);
  });

  router.delete("/agents/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.remove(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }

    await logActivity(db, {
      orgId: agent.orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.deleted",
      entityType: "agent",
      entityId: agent.id,
    });

    res.json({ ok: true });
  });

  router.get("/agents/:id/keys", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const keys = await svc.listKeys(id);
    res.json(keys);
  });

  router.post("/agents/:id/keys", validate(createAgentKeySchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const key = await svc.createApiKey(id, req.body.name);

    const agent = await svc.getById(id);
    if (agent) {
      await logActivity(db, {
        orgId: agent.orgId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "agent.key_created",
        entityType: "agent",
        entityId: agent.id,
        details: { keyId: key.id, name: key.name },
      });
    }

    res.status(201).json(key);
  });

  router.delete("/agents/:id/keys/:keyId", async (req, res) => {
    assertBoard(req);
    const keyId = req.params.keyId as string;
    const revoked = await svc.revokeKey(keyId);
    if (!revoked) {
      res.status(404).json({ error: "Key not found" });
      return;
    }
    res.json({ ok: true });
  });

  router.post("/agents/:id/wakeup", validate(wakeAgentSchema), async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.orgId);

    if (req.actor.type === "agent" && req.actor.agentId !== id) {
      res.status(403).json({ error: "Agent can only invoke itself" });
      return;
    }

    const run = await heartbeat.wakeup(id, {
      source: req.body.source,
      triggerDetail: req.body.triggerDetail ?? "manual",
      reason: req.body.reason ?? null,
      payload: req.body.payload ?? null,
      idempotencyKey: req.body.idempotencyKey ?? null,
      requestedByActorType: req.actor.type === "agent" ? "agent" : "user",
      requestedByActorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      contextSnapshot: {
        triggeredBy: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
        forceFreshSession: req.body.forceFreshSession === true,
      },
    });

    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: agent.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    res.status(202).json(run);
  });

  router.post("/agents/:id/heartbeat/invoke", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.orgId);

    if (req.actor.type === "agent" && req.actor.agentId !== id) {
      res.status(403).json({ error: "Agent can only invoke itself" });
      return;
    }

    const run = await heartbeat.invoke(
      id,
      "on_demand",
      {
        triggeredBy: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId : req.actor.userId,
      },
      "manual",
      {
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId: req.actor.type === "agent" ? req.actor.agentId ?? null : req.actor.userId ?? null,
      },
    );

    if (!run) {
      res.status(202).json({ status: "skipped" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: agent.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "heartbeat.invoked",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: { agentId: id },
    });

    res.status(202).json(run);
  });

  router.post("/agents/:id/claude-login", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.orgId);
    if (agent.agentRuntimeType !== "claude_local") {
      res.status(400).json({ error: "Login is only supported for claude_local agents" });
      return;
    }

    const config = asRecord(agent.agentRuntimeConfig) ?? {};
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(agent.orgId, config);
    const result = await runClaudeLogin({
      runId: `claude-login-${randomUUID()}`,
      agent: {
        id: agent.id,
        orgId: agent.orgId,
        name: agent.name,
        agentRuntimeType: agent.agentRuntimeType,
        agentRuntimeConfig: agent.agentRuntimeConfig,
      },
      config: runtimeConfig,
    });

    res.json(result);
  });

  router.get("/orgs/:orgId/heartbeat-runs", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const agentId = req.query.agentId as string | undefined;
    const limitParam = req.query.limit as string | undefined;
    const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 200)) : undefined;
    const runs = await heartbeat.list(orgId, agentId, limit);
    res.json(runs);
  });

  router.get("/orgs/:orgId/live-runs", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    const minCountParam = req.query.minCount as string | undefined;
    const minCount = minCountParam ? Math.max(0, Math.min(20, parseInt(minCountParam, 10) || 0)) : 0;

    const columns = {
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
      stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
      resultJson: heartbeatRuns.resultJson,
      agentId: heartbeatRuns.agentId,
      agentName: agentsTable.name,
      agentRuntimeType: agentsTable.agentRuntimeType,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
    };

    const liveRuns = await db
      .select(columns)
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.orgId, orgId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    if (minCount > 0 && liveRuns.length < minCount) {
      const activeIds = liveRuns.map((r: any) => r.id);
      const recentRuns = await db
        .select(columns)
        .from(heartbeatRuns)
        .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
        .where(
          and(
            eq(heartbeatRuns.orgId, orgId),
            not(inArray(heartbeatRuns.status, ["queued", "running"])),
            ...(activeIds.length > 0 ? [not(inArray(heartbeatRuns.id, activeIds))] : []),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(minCount - liveRuns.length);

      res.json([...liveRuns, ...recentRuns]);
      return;
    }

    res.json(liveRuns);
  });

  router.get("/heartbeat-runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.orgId);
    res.json(redactCurrentUserValue(run, await getCurrentUserRedactionOptions()));
  });

  router.post("/heartbeat-runs/:runId/cancel", async (req, res) => {
    assertBoard(req);
    const runId = req.params.runId as string;
    const run = await heartbeat.cancelRun(runId);

    if (run) {
      await logActivity(db, {
        orgId: run.orgId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "heartbeat.cancelled",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: { agentId: run.agentId },
      });
    }

    res.json(run);
  });

  router.post("/heartbeat-runs/:runId/retry", async (req, res) => {
    assertBoard(req);
    const runId = req.params.runId as string;
    const originalRun = await heartbeat.getRun(runId);
    if (!originalRun) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, originalRun.orgId);

    const actor = getActorInfo(req);
    const run = await heartbeat.retryRun(runId, {
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });

    await logActivity(db, {
      orgId: run.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "heartbeat.retried",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: {
        agentId: run.agentId,
        originalRunId: originalRun.id,
        recoveryTrigger: "manual",
      },
    });

    res.json(redactCurrentUserValue(run, await getCurrentUserRedactionOptions()));
  });

  router.get("/heartbeat-runs/:runId/events", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.orgId);

    const afterSeq = Number(req.query.afterSeq ?? 0);
    const limit = Number(req.query.limit ?? 200);
    const events = await heartbeat.listEvents(runId, Number.isFinite(afterSeq) ? afterSeq : 0, Number.isFinite(limit) ? limit : 200);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const redactedEvents = events.map((event: any) =>
      redactCurrentUserValue({
        ...event,
        payload: redactEventPayload(event.payload),
      }, currentUserRedactionOptions),
    );
    res.json(redactedEvents);
  });

  router.get("/heartbeat-runs/:runId/log", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.orgId);

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = Number(req.query.limitBytes ?? 256000);
    const result = await heartbeat.readLog(runId, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes: Number.isFinite(limitBytes) ? limitBytes : 256000,
    });

    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.json(result);
  });

  router.get("/heartbeat-runs/:runId/workspace-operations", async (req, res) => {
    const runId = req.params.runId as string;
    const run = await heartbeat.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Heartbeat run not found" });
      return;
    }
    assertCompanyAccess(req, run.orgId);

    const context = asRecord(run.contextSnapshot);
    const executionWorkspaceId = asNonEmptyString(context?.executionWorkspaceId);
    const operations = await workspaceOperations.listForRun(runId, executionWorkspaceId);
    res.json(redactCurrentUserValue(operations, await getCurrentUserRedactionOptions()));
  });

  router.get("/workspace-operations/:operationId/log", async (req, res) => {
    const operationId = req.params.operationId as string;
    const operation = await workspaceOperations.getById(operationId);
    if (!operation) {
      res.status(404).json({ error: "Workspace operation not found" });
      return;
    }
    assertCompanyAccess(req, operation.orgId);

    const offset = Number(req.query.offset ?? 0);
    const limitBytes = Number(req.query.limitBytes ?? 256000);
    const result = await workspaceOperations.readLog(operationId, {
      offset: Number.isFinite(offset) ? offset : 0,
      limitBytes: Number.isFinite(limitBytes) ? limitBytes : 256000,
    });

    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.json(result);
  });

  router.get("/issues/:issueId/live-runs", async (req, res) => {
    const rawId = req.params.issueId as string;
    const issueSvc = issueService(db);
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier ? await issueSvc.getByIdentifier(rawId) : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);

    const liveRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
        resultJson: heartbeatRuns.resultJson,
        agentId: heartbeatRuns.agentId,
        agentName: agentsTable.name,
        agentRuntimeType: agentsTable.agentRuntimeType,
      })
      .from(heartbeatRuns)
      .innerJoin(agentsTable, eq(heartbeatRuns.agentId, agentsTable.id))
      .where(
        and(
          eq(heartbeatRuns.orgId, issue.orgId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    res.json(liveRuns);
  });

  router.get("/issues/:issueId/active-run", async (req, res) => {
    const rawId = req.params.issueId as string;
    const issueSvc = issueService(db);
    const isIdentifier = /^[A-Z]+-\d+$/i.test(rawId);
    const issue = isIdentifier ? await issueSvc.getByIdentifier(rawId) : await issueSvc.getById(rawId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.orgId);

    let run = issue.executionRunId ? await heartbeat.getRun(issue.executionRunId) : null;
    if (run && run.status !== "queued" && run.status !== "running") {
      run = null;
    }

    if (!run && issue.assigneeAgentId && issue.status === "in_progress") {
      const candidateRun = await heartbeat.getActiveRunForAgent(issue.assigneeAgentId);
      const candidateContext = asRecord(candidateRun?.contextSnapshot);
      const candidateIssueId = asNonEmptyString(candidateContext?.issueId);
      if (candidateRun && candidateIssueId === issue.id) {
        run = candidateRun;
      }
    }
    if (!run) {
      res.json(null);
      return;
    }

    const agent = await svc.getById(run.agentId);
    if (!agent) {
      res.json(null);
      return;
    }

    res.json({
      ...redactCurrentUserValue(run, await getCurrentUserRedactionOptions()),
      agentId: agent.id,
      agentName: agent.name,
      agentRuntimeType: agent.agentRuntimeType,
    });
  });
}
