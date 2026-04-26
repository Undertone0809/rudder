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

const AGENT_AVATAR_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
const AGENT_AVATAR_SIZE_PX = 256;
const AGENT_AVATAR_WEBP_QUALITY = 82;
const AGENT_AVATAR_ASSET_RE =
  /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

type UploadedMemoryFile = {
  mimetype: string;
  buffer: Buffer;
  originalname: string;
};

function extractAgentAvatarAssetId(icon: unknown): string | null {
  if (typeof icon !== "string") return null;
  const match = icon.trim().match(AGENT_AVATAR_ASSET_RE);
  return match?.[1] ?? null;
}

async function runSingleFileUpload(
  upload: ReturnType<typeof multer>,
  req: Request,
  res: Response,
) {
  await new Promise<void>((resolve, reject) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function compressAgentAvatar(file: UploadedMemoryFile): Promise<Buffer> {
  try {
    const output = await sharp(file.buffer, {
      animated: false,
      limitInputPixels: 24_000_000,
    })
      .rotate()
      .resize(AGENT_AVATAR_SIZE_PX, AGENT_AVATAR_SIZE_PX, {
        fit: "cover",
        position: "center",
        withoutEnlargement: true,
      })
      .webp({ quality: AGENT_AVATAR_WEBP_QUALITY, effort: 4 })
      .toBuffer();
    if (output.length <= 0) {
      throw new Error("empty avatar output");
    }
    return output;
  } catch {
    throw unprocessable("Avatar image could not be processed");
  }
}

export function agentRoutes(db: Db, storage?: StorageService) {
  function stripPersistedSkillSyncConfig(config: Record<string, unknown>) {
    const next = { ...config };
    delete next.rudderSkillSync;
    delete next.paperclipSkillSync;
    delete next.rudderRuntimeSkills;
    delete next.paperclipRuntimeSkills;
    return next;
  }

  function withRuntimeSkillEntries(
    config: Record<string, unknown>,
    runtimeSkillEntries: unknown[],
    desiredSkills: string[],
  ) {
    return {
      ...config,
      rudderSkillSync: { desiredSkills },
      paperclipSkillSync: { desiredSkills },
      rudderRuntimeSkills: runtimeSkillEntries,
      paperclipRuntimeSkills: runtimeSkillEntries,
    };
  }

  const DEFAULT_INSTRUCTIONS_PATH_KEYS: Record<string, string> = {
    claude_local: "instructionsFilePath",
    codex_local: "instructionsFilePath",
    gemini_local: "instructionsFilePath",
    opencode_local: "instructionsFilePath",
    cursor: "instructionsFilePath",
    pi_local: "instructionsFilePath",
  };
  const DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES = new Set(Object.keys(DEFAULT_INSTRUCTIONS_PATH_KEYS));
  const KNOWN_INSTRUCTIONS_PATH_KEYS = new Set(["instructionsFilePath", "agentsMdPath"]);
  const KNOWN_INSTRUCTIONS_BUNDLE_KEYS = [
    "instructionsBundleMode",
    "instructionsRootPath",
    "instructionsEntryFile",
    "instructionsFilePath",
    "agentsMdPath",
  ] as const;

  const router = Router();
  const svc = agentService(db);
  const assets = assetService(db);
  const access = accessService(db);
  const approvalsSvc = approvalService(db);
  const budgets = budgetService(db);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const instructions = agentInstructionsService();
  const organizationSkills = organizationSkillService(db);
  const workspaceOperations = workspaceOperationService(db);
  const instanceSettings = instanceSettingsService(db);
  const strictSecretsMode = process.env.RUDDER_SECRETS_STRICT_MODE === "true";
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  async function persistReconciledInstructionsBundle(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getInternalById>>>,
    result: { agentRuntimeConfig: Record<string, unknown>; changed: boolean },
  ) {
    if (!result.changed) return agent;
    const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
      agent.orgId,
      result.agentRuntimeConfig,
      { strictMode: strictSecretsMode },
    );
    const updated = await svc.update(agent.id, { agentRuntimeConfig: normalizedAdapterConfig });
    return updated ?? { ...agent, agentRuntimeConfig: normalizedAdapterConfig };
  }

  async function getCurrentUserRedactionOptions() {
    return {
      enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
    };
  }

  function canCreateAgents(agent: { role: string; permissions: Record<string, unknown> | null | undefined }) {
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  async function buildAgentAccessState(agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    const membership = await access.getMembership(agent.orgId, "agent", agent.id);
    const grants = membership
      ? await access.listPrincipalGrants(agent.orgId, "agent", agent.id)
      : [];
    const hasExplicitTaskAssignGrant = grants.some((grant) => grant.permissionKey === "tasks:assign");

    if (agent.role === "ceo") {
      return {
        canAssignTasks: true,
        taskAssignSource: "ceo_role" as const,
        membership,
        grants,
      };
    }

    if (canCreateAgents(agent)) {
      return {
        canAssignTasks: true,
        taskAssignSource: "agent_creator" as const,
        membership,
        grants,
      };
    }

    if (hasExplicitTaskAssignGrant) {
      return {
        canAssignTasks: true,
        taskAssignSource: "explicit_grant" as const,
        membership,
        grants,
      };
    }

    return {
      canAssignTasks: false,
      taskAssignSource: "none" as const,
      membership,
      grants,
    };
  }

  async function buildAgentDetail(
    agent: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
    options?: { restricted?: boolean },
  ) {
    const [chainOfCommand, accessState] = await Promise.all([
      svc.getChainOfCommand(agent.id),
      buildAgentAccessState(agent),
    ]);

    return {
      ...(options?.restricted ? redactForRestrictedAgentView(agent) : agent),
      chainOfCommand,
      access: accessState,
    };
  }

  async function applyDefaultAgentTaskAssignGrant(
    orgId: string,
    agentId: string,
    grantedByUserId: string | null,
  ) {
    await access.ensureMembership(orgId, "agent", agentId, "member", "active");
    await access.setPrincipalPermission(
      orgId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      grantedByUserId,
    );
  }

  async function assertCanCreateAgentsForCompany(req: Request, orgId: string) {
    assertCompanyAccess(req, orgId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return null;
      const allowed = await access.canUser(orgId, req.actor.userId, "agents:create");
      if (!allowed) {
        throw forbidden("Missing permission: agents:create");
      }
      return null;
    }
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.orgId !== orgId) {
      throw forbidden("Agent key cannot access another organization");
    }
    const allowedByGrant = await access.hasPermission(orgId, "agent", actorAgent.id, "agents:create");
    if (!allowedByGrant && !canCreateAgents(actorAgent)) {
      throw forbidden("Missing permission: can create agents");
    }
    return actorAgent;
  }

  async function assertCanReadConfigurations(req: Request, orgId: string) {
    return assertCanCreateAgentsForCompany(req, orgId);
  }

  async function actorCanReadConfigurationsForCompany(req: Request, orgId: string) {
    assertCompanyAccess(req, orgId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
      return access.canUser(orgId, req.actor.userId, "agents:create");
    }
    if (!req.actor.agentId) return false;
    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.orgId !== orgId) return false;
    const allowedByGrant = await access.hasPermission(orgId, "agent", actorAgent.id, "agents:create");
    return allowedByGrant || canCreateAgents(actorAgent);
  }

  async function assertAgentAvatarAssetBelongsToOrg(orgId: string, icon: unknown) {
    const assetId = extractAgentAvatarAssetId(icon);
    if (!assetId) return;

    const asset = await assets.getById(assetId);
    if (!asset) {
      throw unprocessable("Avatar asset not found");
    }
    if (asset.orgId !== orgId) {
      throw forbidden("Avatar asset belongs to another organization");
    }
    if (!asset.contentType.toLowerCase().startsWith("image/")) {
      throw unprocessable("Avatar asset must be an image");
    }
  }

  async function assertCanUpdateAgent(req: Request, targetAgent: { id: string; orgId: string }) {
    assertCompanyAccess(req, targetAgent.orgId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.orgId !== targetAgent.orgId) {
      throw forbidden("Agent key cannot access another organization");
    }

    if (actorAgent.id === targetAgent.id) return;
    if (actorAgent.role === "ceo") return;
    const allowedByGrant = await access.hasPermission(
      targetAgent.orgId,
      "agent",
      actorAgent.id,
      "agents:create",
    );
    if (allowedByGrant || canCreateAgents(actorAgent)) return;
    throw forbidden("Only CEO or agent creators can modify other agents");
  }

  async function assertCanReadAgent(req: Request, targetAgent: { orgId: string }) {
    assertCompanyAccess(req, targetAgent.orgId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.orgId !== targetAgent.orgId) {
      throw forbidden("Agent key cannot access another organization");
    }
  }

  async function resolveOrgIdForAgentReference(req: Request): Promise<string | null> {
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

  async function normalizeAgentReference(req: Request, rawId: string): Promise<string> {
    const raw = rawId.trim();
    if (isUuidLike(raw)) return raw;

    const orgId = await resolveOrgIdForAgentReference(req);
    if (!orgId) {
      throw unprocessable("Agent shortname lookup requires orgId query parameter");
    }

    const resolved = await svc.resolveByReference(orgId, raw);
    if (resolved.ambiguous) {
      throw conflict("Agent shortname is ambiguous in this organization. Use the agent ID.");
    }
    if (!resolved.agent) {
      throw notFound("Agent not found");
    }
    return resolved.agent.id;
  }

  function parseSourceIssueIds(input: {
    sourceIssueId?: string | null;
    sourceIssueIds?: string[];
  }): string[] {
    const values: string[] = [];
    if (Array.isArray(input.sourceIssueIds)) values.push(...input.sourceIssueIds);
    if (typeof input.sourceIssueId === "string" && input.sourceIssueId.length > 0) {
      values.push(input.sourceIssueId);
    }
    return Array.from(new Set(values));
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  function preserveInstructionsBundleConfig(
    existingAdapterConfig: Record<string, unknown>,
    nextAdapterConfig: Record<string, unknown>,
  ) {
    const nextKeys = new Set(Object.keys(nextAdapterConfig));
    if (KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) => nextKeys.has(key))) {
      return nextAdapterConfig;
    }

    const merged = { ...nextAdapterConfig };
    for (const key of KNOWN_INSTRUCTIONS_BUNDLE_KEYS) {
      if (merged[key] === undefined && existingAdapterConfig[key] !== undefined) {
        merged[key] = existingAdapterConfig[key];
      }
    }
    return merged;
  }

  function parseBooleanLike(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      return null;
    }
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
      return false;
    }
    return null;
  }

  function parseNumberLike(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseSchedulerHeartbeatPolicy(runtimeConfig: unknown) {
    const heartbeat = asRecord(asRecord(runtimeConfig)?.heartbeat) ?? {};
    return {
      enabled: parseBooleanLike(heartbeat.enabled) ?? true,
      intervalSec: Math.max(0, parseNumberLike(heartbeat.intervalSec) ?? 0),
    };
  }

  function isHiddenSystemAgentMetadata(metadata: unknown) {
    const parsed = asRecord(metadata);
    return parsed?.hidden === true || parsed?.systemManaged === "rudder_copilot";
  }

  function generateEd25519PrivateKeyPem(): string {
    const { privateKey } = generateKeyPairSync("ed25519");
    return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }

  function ensureGatewayDeviceKey(
    agentRuntimeType: string | null | undefined,
    agentRuntimeConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    if (agentRuntimeType !== "openclaw_gateway") return agentRuntimeConfig;
    const disableDeviceAuth = parseBooleanLike(agentRuntimeConfig.disableDeviceAuth) === true;
    if (disableDeviceAuth) return agentRuntimeConfig;
    if (asNonEmptyString(agentRuntimeConfig.devicePrivateKeyPem)) return agentRuntimeConfig;
    return { ...agentRuntimeConfig, devicePrivateKeyPem: generateEd25519PrivateKeyPem() };
  }

  function applyCreateDefaultsByAdapterType(
    agentRuntimeType: string | null | undefined,
    agentRuntimeConfig: Record<string, unknown>,
  ): Record<string, unknown> {
    const next = { ...agentRuntimeConfig };
    if (agentRuntimeType === "codex_local") {
      if (!asNonEmptyString(next.model)) {
        next.model = DEFAULT_CODEX_LOCAL_MODEL;
      }
      const hasBypassFlag =
        typeof next.dangerouslyBypassApprovalsAndSandbox === "boolean" ||
        typeof next.dangerouslyBypassSandbox === "boolean";
      if (!hasBypassFlag) {
        next.dangerouslyBypassApprovalsAndSandbox = DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX;
      }
      if (typeof next.search !== "boolean") {
        next.search = DEFAULT_CODEX_LOCAL_SEARCH;
      }
      return ensureGatewayDeviceKey(agentRuntimeType, next);
    }
    if (agentRuntimeType === "gemini_local" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_GEMINI_LOCAL_MODEL;
      return ensureGatewayDeviceKey(agentRuntimeType, next);
    }
    // OpenCode requires explicit model selection — no default
    if (agentRuntimeType === "cursor" && !asNonEmptyString(next.model)) {
      next.model = DEFAULT_CURSOR_LOCAL_MODEL;
    }
    return ensureGatewayDeviceKey(agentRuntimeType, next);
  }

  async function assertAdapterConfigConstraints(
    orgId: string,
    agentRuntimeType: string | null | undefined,
    agentRuntimeConfig: Record<string, unknown>,
  ) {
    if (agentRuntimeType !== "opencode_local") return;
    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(orgId, agentRuntimeConfig);
    const runtimeEnv = asRecord(runtimeConfig.env) ?? {};
    try {
      await ensureOpenCodeModelConfiguredAndAvailable({
        model: runtimeConfig.model,
        command: runtimeConfig.command,
        cwd: runtimeConfig.cwd,
        env: runtimeEnv,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw unprocessable(`Invalid opencode_local agentRuntimeConfig: ${reason}`);
    }
  }

  function resolveInstructionsFilePath(candidatePath: string, agentRuntimeConfig: Record<string, unknown>) {
    const trimmed = candidatePath.trim();
    if (path.isAbsolute(trimmed)) return trimmed;

    const cwd = asNonEmptyString(agentRuntimeConfig.cwd);
    if (!cwd) {
      throw unprocessable(
        "Relative instructions path requires agentRuntimeConfig.cwd to be set to an absolute path",
      );
    }
    if (!path.isAbsolute(cwd)) {
      throw unprocessable("agentRuntimeConfig.cwd must be an absolute path to resolve relative instructions path");
    }
    return path.resolve(cwd, trimmed);
  }

  async function materializeDefaultInstructionsBundleForNewAgent<T extends {
    id: string;
    orgId: string;
    name: string;
    role: string;
    agentRuntimeType: string;
    agentRuntimeConfig: unknown;
  }>(agent: T): Promise<T> {
    if (!DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES.has(agent.agentRuntimeType)) {
      return agent;
    }

    const agentRuntimeConfig = asRecord(agent.agentRuntimeConfig) ?? {};
    const hasExplicitInstructionsBundle =
      Boolean(asNonEmptyString(agentRuntimeConfig.instructionsBundleMode))
      || Boolean(asNonEmptyString(agentRuntimeConfig.instructionsRootPath))
      || Boolean(asNonEmptyString(agentRuntimeConfig.instructionsEntryFile))
      || Boolean(asNonEmptyString(agentRuntimeConfig.instructionsFilePath))
      || Boolean(asNonEmptyString(agentRuntimeConfig.agentsMdPath));
    if (hasExplicitInstructionsBundle) {
      return agent;
    }

    const promptTemplate = typeof agentRuntimeConfig.promptTemplate === "string"
      ? agentRuntimeConfig.promptTemplate
      : "";
    // Always load the full default bundle, then override AGENTS.md with promptTemplate if provided
    const defaultFiles = await loadDefaultAgentInstructionsBundle(resolveDefaultAgentInstructionsBundleRole(agent.role));
    const files = promptTemplate.trim().length === 0
      ? defaultFiles
      : { ...defaultFiles, "AGENTS.md": promptTemplate };
    const materialized = await instructions.materializeManagedBundle(
      agent,
      files,
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
    const nextAdapterConfig = { ...materialized.agentRuntimeConfig };
    delete nextAdapterConfig.promptTemplate;

    const updated = await svc.update(agent.id, { agentRuntimeConfig: nextAdapterConfig });
    return (updated as T | null) ?? { ...agent, agentRuntimeConfig: nextAdapterConfig };
  }

  async function assertCanManageInstructionsPath(req: Request, targetAgent: { id: string; orgId: string }) {
    assertCompanyAccess(req, targetAgent.orgId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await svc.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.orgId !== targetAgent.orgId) {
      throw forbidden("Agent key cannot access another organization");
    }
    if (actorAgent.id === targetAgent.id) return;

    const chainOfCommand = await svc.getChainOfCommand(targetAgent.id);
    if (chainOfCommand.some((manager) => manager.id === actorAgent.id)) return;

    throw forbidden("Only the target agent or an ancestor manager can update instructions path");
  }

  function summarizeAgentUpdateDetails(patch: Record<string, unknown>) {
    const changedTopLevelKeys = Object.keys(patch).sort();
    const details: Record<string, unknown> = { changedTopLevelKeys };

    const agentRuntimeConfigPatch = asRecord(patch.agentRuntimeConfig);
    if (agentRuntimeConfigPatch) {
      details.changedAdapterConfigKeys = Object.keys(agentRuntimeConfigPatch).sort();
    }

    const runtimeConfigPatch = asRecord(patch.runtimeConfig);
    if (runtimeConfigPatch) {
      details.changedRuntimeConfigKeys = Object.keys(runtimeConfigPatch).sort();
    }

    return details;
  }

  function buildUnsupportedSkillSnapshot(
    agentRuntimeType: string,
    desiredSkills: string[] = [],
  ): AgentSkillSnapshot {
    return {
      agentRuntimeType,
      supported: false,
      mode: "unsupported",
      desiredSkills,
      entries: [],
      warnings: ["This adapter does not implement skill sync yet."],
    };
  }

  async function resolveDesiredSkillAssignment(
    orgId: string,
    agentRuntimeType: string,
    runtimeConfig: Record<string, unknown>,
    requestedDesiredSkills: string[] | undefined,
  ) {
    return organizationSkills.resolveDesiredSkillSelectionForAgent(
      {
        id: null,
        orgId,
        agentRuntimeConfig: {},
        agentRuntimeType,
      },
      runtimeConfig,
      requestedDesiredSkills,
    );
  }

  async function resolveDesiredSkillAssignmentForAgent(
    agent: Awaited<ReturnType<typeof svc.getById>>,
    runtimeConfig: Record<string, unknown>,
    requestedDesiredSkills: string[] | undefined,
  ) {
    if (!agent) {
      return {
        desiredSkills: [] as string[],
        warnings: [] as string[],
      };
    }
    return organizationSkills.resolveDesiredSkillSelectionForAgent(
      agent,
      runtimeConfig,
      requestedDesiredSkills,
    );
  }

  async function buildAgentSkillSnapshot(
    agent: Awaited<ReturnType<typeof svc.getById>>,
    runtimeConfig: Record<string, unknown>,
  ) {
    if (!agent) {
      return buildUnsupportedSkillSnapshot("", []);
    }
    const snapshot = await organizationSkills.buildAgentSkillSnapshot(agent, runtimeConfig);
    if (!snapshot.supported) {
      return buildUnsupportedSkillSnapshot(agent.agentRuntimeType, snapshot.desiredSkills);
    }
    return snapshot;
  }

  function redactForRestrictedAgentView(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      ...agent,
      agentRuntimeConfig: {},
      runtimeConfig: {},
    };
  }

  function redactAgentConfiguration(agent: Awaited<ReturnType<typeof svc.getById>>) {
    if (!agent) return null;
    return {
      id: agent.id,
      orgId: agent.orgId,
      name: agent.name,
      role: agent.role,
      title: agent.title,
      status: agent.status,
      reportsTo: agent.reportsTo,
      agentRuntimeType: agent.agentRuntimeType,
      agentRuntimeConfig: redactEventPayload(agent.agentRuntimeConfig),
      runtimeConfig: redactEventPayload(agent.runtimeConfig),
      permissions: agent.permissions,
      updatedAt: agent.updatedAt,
    };
  }

  function redactRevisionSnapshot(snapshot: unknown): Record<string, unknown> {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return {};
    const record = snapshot as Record<string, unknown>;
    return {
      ...record,
      agentRuntimeConfig: redactEventPayload(
        typeof record.agentRuntimeConfig === "object" && record.agentRuntimeConfig !== null
          ? (record.agentRuntimeConfig as Record<string, unknown>)
          : {},
      ),
      runtimeConfig: redactEventPayload(
        typeof record.runtimeConfig === "object" && record.runtimeConfig !== null
          ? (record.runtimeConfig as Record<string, unknown>)
          : {},
      ),
      metadata:
        typeof record.metadata === "object" && record.metadata !== null
          ? redactEventPayload(record.metadata as Record<string, unknown>)
          : record.metadata ?? null,
    };
  }

  function redactConfigRevision(
    revision: Record<string, unknown> & { beforeConfig: unknown; afterConfig: unknown },
  ) {
    return {
      ...revision,
      beforeConfig: redactRevisionSnapshot(revision.beforeConfig),
      afterConfig: redactRevisionSnapshot(revision.afterConfig),
    };
  }

  function toLeanOrgNode(node: Record<string, unknown>): Record<string, unknown> {
    const reports = Array.isArray(node.reports)
      ? (node.reports as Array<Record<string, unknown>>).map((report) => toLeanOrgNode(report))
      : [];
    return {
      id: String(node.id),
      name: String(node.name),
      role: String(node.role),
      status: String(node.status),
      reports,
    };
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeAgentReference(req, String(rawId));
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/orgs/:orgId/adapters/:type/models", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const type = req.params.type as string;
    const models = await listAgentRuntimeModels(type);
    res.json(models);
  });

  router.post(
    "/orgs/:orgId/adapters/:type/test-environment",
    validate(testAgentRuntimeEnvironmentSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const type = req.params.type as string;
      await assertCanReadConfigurations(req, orgId);

      const adapter = findServerAdapter(type);
      if (!adapter) {
        res.status(404).json({ error: `Unknown adapter type: ${type}` });
        return;
      }

      const inputAdapterConfig =
        (req.body?.agentRuntimeConfig ?? {}) as Record<string, unknown>;
      const normalizedAdapterConfig = await secretsSvc.normalizeAdapterConfigForPersistence(
        orgId,
        inputAdapterConfig,
        { strictMode: strictSecretsMode },
      );
      const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        orgId,
        normalizedAdapterConfig,
      );

      const result = await adapter.testEnvironment({
        orgId,
        agentRuntimeType: type,
        config: runtimeAdapterConfig,
      });

      res.json(result);
    },
  );

  router.get("/agents/:id/skills", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, agent);

    const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.orgId,
      agent.agentRuntimeConfig,
    );
    const snapshot = await buildAgentSkillSnapshot(agent, runtimeConfig);
    res.json(snapshot);
  });

  router.get("/agents/:id/skills/analytics", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadAgent(req, agent);

    const rawWindowDays = typeof req.query.windowDays === "string"
      ? Number.parseInt(req.query.windowDays, 10)
      : undefined;
    const startDate = typeof req.query.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.startDate)
      ? req.query.startDate
      : undefined;
    const endDate = typeof req.query.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.endDate)
      ? req.query.endDate
      : undefined;

    const analytics: AgentSkillAnalytics = await heartbeat.getAgentSkillAnalytics(agent.id, {
      windowDays: Number.isFinite(rawWindowDays) ? rawWindowDays : undefined,
      startDate,
      endDate,
    });
    res.json(analytics);
  });

  router.post(
    "/agents/:id/skills/private",
    validate(organizationSkillCreateSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const agent = await svc.getById(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      await assertCanUpdateAgent(req, agent);

      const entry = await organizationSkills.createAgentPrivateSkill(agent.orgId, agent.id, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: agent.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "agent.private_skill_created",
        entityType: "agent",
        entityId: agent.id,
        details: {
          slug: entry.key,
          selectionKey: entry.selectionKey,
          sourcePath: entry.sourcePath ?? null,
        },
      });

      res.status(201).json(entry);
    },
  );

  router.post(
    "/agents/:id/skills/sync",
    validate(agentSkillSyncSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const agent = await svc.getById(id);
      if (!agent) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      await assertCanUpdateAgent(req, agent);

      const requestedSkills = Array.from(
        new Set(
          (req.body.desiredSkills as string[])
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      );
      const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        agent.orgId,
        agent.agentRuntimeConfig,
      );
      const { desiredSkills } = await resolveDesiredSkillAssignmentForAgent(
        agent,
        runtimeConfig,
        requestedSkills,
      );
      const actor = getActorInfo(req);
      await organizationSkills.replaceEnabledSkillKeysForAgent(agent.orgId, agent.id, desiredSkills);
      const sanitizedAdapterConfig = stripPersistedSkillSyncConfig(
        (agent.agentRuntimeConfig as Record<string, unknown>) ?? {},
      );
      let updatedAgent = agent;
      if (JSON.stringify(sanitizedAdapterConfig) !== JSON.stringify(agent.agentRuntimeConfig ?? {})) {
        updatedAgent = await svc.update(agent.id, {
          agentRuntimeConfig: sanitizedAdapterConfig,
        }, {
          recordRevision: {
            createdByAgentId: actor.agentId,
            createdByUserId: actor.actorType === "user" ? actor.actorId : null,
            source: "skill-sync",
          },
        }) ?? agent;
      }

      const updated = updatedAgent;
      const { config: updatedRuntimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        updated.orgId,
        updated.agentRuntimeConfig,
      );
      const snapshot = await buildAgentSkillSnapshot(updated, updatedRuntimeConfig);

      await logActivity(db, {
        orgId: updated.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "agent.skills_synced",
        entityType: "agent",
        entityId: updated.id,
        agentId: actor.agentId,
        runId: actor.runId,
        details: {
          agentRuntimeType: updated.agentRuntimeType,
          desiredSkills,
          mode: snapshot.mode,
          supported: snapshot.supported,
          entryCount: snapshot.entries.length,
          warningCount: snapshot.warnings.length,
        },
      });

      res.json(snapshot);
    },
  );

  router.get("/orgs/:orgId/agents", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const result = await svc.list(orgId);
    const canReadConfigs = await actorCanReadConfigurationsForCompany(req, orgId);
    if (canReadConfigs || req.actor.type === "board") {
      res.json(result);
      return;
    }
    res.json(result.map((agent) => redactForRestrictedAgentView(agent)));
  });

  router.get("/orgs/:orgId/agents/name-suggestion", async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanCreateAgentsForCompany(req, orgId);
    const name = await svc.suggestName(orgId);
    res.json({ name });
  });

  router.get("/instance/scheduler-heartbeats", async (req, res) => {
    assertInstanceAdmin(req);

    const rows = await db
      .select({
        id: agentsTable.id,
        orgId: agentsTable.orgId,
        agentName: agentsTable.name,
        role: agentsTable.role,
        title: agentsTable.title,
        status: agentsTable.status,
        agentRuntimeType: agentsTable.agentRuntimeType,
        runtimeConfig: agentsTable.runtimeConfig,
        lastHeartbeatAt: agentsTable.lastHeartbeatAt,
        metadata: agentsTable.metadata,
        organizationName: organizations.name,
        organizationIssuePrefix: organizations.issuePrefix,
      })
      .from(agentsTable)
      .innerJoin(organizations, eq(agentsTable.orgId, organizations.id))
      .orderBy(organizations.name, agentsTable.name);

    const items: InstanceSchedulerHeartbeatAgent[] = rows
      .filter((row) => !isHiddenSystemAgentMetadata(row.metadata))
      .map((row) => {
        const policy = parseSchedulerHeartbeatPolicy(row.runtimeConfig);
        const statusEligible =
          row.status !== "paused" &&
          row.status !== "terminated" &&
          row.status !== "pending_approval";

        return {
          id: row.id,
          orgId: row.orgId,
          organizationName: row.organizationName,
          organizationIssuePrefix: row.organizationIssuePrefix,
          agentName: row.agentName,
          agentUrlKey: deriveAgentUrlKey(row.agentName, row.id),
          role: row.role as InstanceSchedulerHeartbeatAgent["role"],
          title: row.title,
          status: row.status as InstanceSchedulerHeartbeatAgent["status"],
          agentRuntimeType: row.agentRuntimeType,
          intervalSec: policy.intervalSec,
          heartbeatEnabled: policy.enabled,
          schedulerActive: statusEligible && policy.enabled && policy.intervalSec > 0,
          lastHeartbeatAt: row.lastHeartbeatAt,
        };
      })
      .filter((item) =>
        item.status !== "paused" &&
        item.status !== "terminated" &&
        item.status !== "pending_approval",
      )
      .sort((left, right) => {
        if (left.schedulerActive !== right.schedulerActive) {
          return left.schedulerActive ? -1 : 1;
        }
        const organizationOrder = left.organizationName.localeCompare(right.organizationName);
        if (organizationOrder !== 0) return organizationOrder;
        return left.agentName.localeCompare(right.agentName);
      });

    res.json(items);
  });

  router.get("/orgs/:orgId/org", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const tree = await svc.orgForCompany(orgId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    res.json(leanTree);
  });

  router.get("/orgs/:orgId/org.svg", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const style = (ORG_CHART_STYLES.includes(req.query.style as OrgChartStyle) ? req.query.style : "warmth") as OrgChartStyle;
    const tree = await svc.orgForCompany(orgId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const svg = renderOrgChartSvg(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "no-cache");
    res.send(svg);
  });

  router.get("/orgs/:orgId/org.png", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const style = (ORG_CHART_STYLES.includes(req.query.style as OrgChartStyle) ? req.query.style : "warmth") as OrgChartStyle;
    const tree = await svc.orgForCompany(orgId);
    const leanTree = tree.map((node) => toLeanOrgNode(node as Record<string, unknown>));
    const png = await renderOrgChartPng(leanTree as unknown as OrgNode[], style);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.send(png);
  });

  router.get("/orgs/:orgId/agent-configurations", async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanReadConfigurations(req, orgId);
    const rows = await svc.list(orgId);
    res.json(rows.map((row) => redactAgentConfiguration(row)));
  });

  router.get("/agents/me", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    const agent = await svc.getById(req.actor.agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    res.json(await buildAgentDetail(agent));
  });

  router.get("/agents/me/inbox-lite", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.orgId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }

    const issuesSvc = issueService(db);
    const rows = await issuesSvc.list(req.actor.orgId, {
      assigneeAgentId: req.actor.agentId,
      status: "todo,in_progress,blocked",
    });

    res.json(
      rows.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        projectId: issue.projectId,
        goalId: issue.goalId,
        parentId: issue.parentId,
        updatedAt: issue.updatedAt,
        activeRun: issue.activeRun,
      })),
    );
  });

  router.get("/agents/:id", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.orgId);
    if (req.actor.type === "agent" && req.actor.agentId !== id) {
      const canRead = await actorCanReadConfigurationsForCompany(req, agent.orgId);
      if (!canRead) {
        res.json(await buildAgentDetail(agent, { restricted: true }));
        return;
      }
    }
    res.json(await buildAgentDetail(agent));
  });

  router.get("/agents/:id/configuration", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.orgId);
    res.json(redactAgentConfiguration(agent));
  });

  router.get("/agents/:id/config-revisions", async (req, res) => {
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.orgId);
    const revisions = await svc.listConfigRevisions(id);
    res.json(revisions.map((revision) => redactConfigRevision(revision)));
  });

  router.get("/agents/:id/config-revisions/:revisionId", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanReadConfigurations(req, agent.orgId);
    const revision = await svc.getConfigRevision(id, revisionId);
    if (!revision) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }
    res.json(redactConfigRevision(revision));
  });

  router.post("/agents/:id/config-revisions/:revisionId/rollback", async (req, res) => {
    const id = req.params.id as string;
    const revisionId = req.params.revisionId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    await assertCanUpdateAgent(req, existing);

    const actor = getActorInfo(req);
    const updated = await svc.rollbackConfigRevision(id, revisionId, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });
    if (!updated) {
      res.status(404).json({ error: "Revision not found" });
      return;
    }

    await logActivity(db, {
      orgId: updated.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "agent.config_rolled_back",
      entityType: "agent",
      entityId: updated.id,
      details: { revisionId },
    });

    res.json(updated);
  });

  router.get("/agents/:id/runtime-state", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.orgId);

    const state = await heartbeat.getRuntimeState(id);
    res.json(state);
  });

  router.get("/agents/:id/task-sessions", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.orgId);

    const sessions = await heartbeat.listTaskSessions(id);
    res.json(
      sessions.map((session) => ({
        ...session,
        sessionParamsJson: redactEventPayload(session.sessionParamsJson ?? null),
      })),
    );
  });

  router.post("/agents/:id/runtime-state/reset-session", validate(resetAgentSessionSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const agent = await svc.getById(id);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    assertCompanyAccess(req, agent.orgId);

    const taskKey =
      typeof req.body.taskKey === "string" && req.body.taskKey.trim().length > 0
        ? req.body.taskKey.trim()
        : null;
    const state = await heartbeat.resetRuntimeSession(id, { taskKey });

    await logActivity(db, {
      orgId: agent.orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "agent.runtime_session_reset",
      entityType: "agent",
      entityId: id,
      details: { taskKey: taskKey ?? null },
    });

    res.json(state);
  });

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
          icon: normalizedHireInput.icon ?? null,
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
        await issueApprovalsSvc.linkManyForApproval(approval.id, sourceIssueIds, {
          agentId: actor.actorType === "agent" ? actor.actorId : null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        });
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

    const file = (req as Request & { file?: UploadedMemoryFile }).file;
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
        && KNOWN_INSTRUCTIONS_BUNDLE_KEYS.some((key) =>
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
      const activeIds = liveRuns.map((r) => r.id);
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
    const redactedEvents = events.map((event) =>
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

  return router;
}
