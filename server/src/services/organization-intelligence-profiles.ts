import {
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_REASONING_EFFORT,
} from "@rudderhq/agent-runtime-codex-local";
import type { Db } from "@rudderhq/db";
import { organizationIntelligenceProfiles } from "@rudderhq/db";
import type {
  AgentRuntimeType,
  OrganizationIntelligenceProfile,
  OrganizationIntelligenceProfilePurpose,
  OrganizationIntelligenceProfileStatus,
} from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import {
  DEFAULT_INTELLIGENCE_PROFILE_PURPOSE,
  resolveDefaultIntelligenceProfile,
} from "./organization-intelligence-profile-defaults.js";

const AGENT_ONLY_CONFIG_KEYS = new Set([
  "promptTemplate",
  "bootstrapPromptTemplate",
  "instructionsFilePath",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsBundleMode",
  "agentsMdPath",
  "rudderBrowserEnabled",
  "rudderBrowserCapability",
  "rudderSkillSync",
  "paperclipSkillSync",
  "rudderRuntimeSkills",
  "paperclipRuntimeSkills",
  "workspaceStrategy",
  "workspaceRuntime",
  "cwd",
]);

function toProfile(row: typeof organizationIntelligenceProfiles.$inferSelect): OrganizationIntelligenceProfile {
  return {
    id: row.id,
    orgId: row.orgId,
    purpose: row.purpose as OrganizationIntelligenceProfilePurpose,
    agentRuntimeType: row.agentRuntimeType as AgentRuntimeType,
    agentRuntimeConfig: row.agentRuntimeConfig ?? {},
    status: row.status as OrganizationIntelligenceProfileStatus,
    lastError: row.lastError ?? null,
    lastVerifiedAt: row.lastVerifiedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeConfigForProductIntelligence(config: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (AGENT_ONLY_CONFIG_KEYS.has(key)) continue;
    if (key === "modelFallbacks" && Array.isArray(value)) {
      next.modelFallbacks = value.map((fallback) => {
        if (!isRecord(fallback)) return fallback;
        const fallbackConfig = isRecord(fallback.config)
          ? sanitizeConfigForProductIntelligence(fallback.config)
          : undefined;
        return { ...fallback, ...(fallbackConfig ? { config: fallbackConfig } : {}) };
      });
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function buildIntelligenceProfileConfigWithPurposeDefaults(
  _purpose: OrganizationIntelligenceProfilePurpose,
  agentRuntimeType: string,
  sourceConfig: Record<string, unknown>,
): Record<string, unknown> {
  const base = sanitizeConfigForProductIntelligence(sourceConfig);
  if (agentRuntimeType === "codex_local") {
    const config = { ...base };
    delete config.reasoningEffort;
    return {
      ...config,
      model: DEFAULT_CODEX_LOCAL_MODEL,
      modelReasoningEffort: DEFAULT_CODEX_LOCAL_REASONING_EFFORT,
    };
  }
  return {
    ...base,
    model: typeof base.model === "string" && base.model.trim().length > 0 ? base.model : undefined,
  };
}

type ProfileWrite = {
  agentRuntimeType: AgentRuntimeType;
  agentRuntimeConfig: Record<string, unknown>;
  status?: OrganizationIntelligenceProfileStatus;
  lastError?: string | null;
  lastVerifiedAt?: Date | null;
};

export function organizationIntelligenceProfileService(db: Db) {
  async function getDefault(orgId: string) {
    const rows = await db.select().from(organizationIntelligenceProfiles)
      .where(eq(organizationIntelligenceProfiles.orgId, orgId));
    return resolveDefaultIntelligenceProfile(orgId, rows.map(toProfile));
  }

  async function getByPurpose(orgId: string, _purpose: OrganizationIntelligenceProfilePurpose) {
    return getDefault(orgId);
  }

  async function list(orgId: string) {
    return [await getDefault(orgId)];
  }

  async function upsert(orgId: string, _purpose: OrganizationIntelligenceProfilePurpose, data: ProfileWrite) {
    const sanitizedConfig = sanitizeConfigForProductIntelligence(data.agentRuntimeConfig);
    const [row] = await db.insert(organizationIntelligenceProfiles).values({
      orgId,
      purpose: DEFAULT_INTELLIGENCE_PROFILE_PURPOSE,
      agentRuntimeType: data.agentRuntimeType,
      agentRuntimeConfig: sanitizedConfig,
      status: data.status ?? "disabled",
      lastError: data.lastError ?? null,
      lastVerifiedAt: data.lastVerifiedAt ?? null,
    }).onConflictDoUpdate({
      target: [organizationIntelligenceProfiles.orgId, organizationIntelligenceProfiles.purpose],
      set: {
        agentRuntimeType: data.agentRuntimeType,
        agentRuntimeConfig: sanitizedConfig,
        status: data.status ?? "disabled",
        lastError: data.lastError ?? null,
        lastVerifiedAt: data.lastVerifiedAt ?? null,
        updatedAt: new Date(),
      },
    }).returning();
    return toProfile(row!);
  }

  async function createDefaultIfAbsent(orgId: string, data: ProfileWrite) {
    const sanitizedConfig = sanitizeConfigForProductIntelligence(data.agentRuntimeConfig);
    const [row] = await db.insert(organizationIntelligenceProfiles).values({
      orgId,
      purpose: DEFAULT_INTELLIGENCE_PROFILE_PURPOSE,
      agentRuntimeType: data.agentRuntimeType,
      agentRuntimeConfig: sanitizedConfig,
      status: data.status ?? "disabled",
      lastError: data.lastError ?? null,
      lastVerifiedAt: data.lastVerifiedAt ?? null,
    }).onConflictDoNothing({
      target: [organizationIntelligenceProfiles.orgId, organizationIntelligenceProfiles.purpose],
    }).returning();
    if (row) return toProfile(row);
    return getDefault(orgId);
  }

  async function ensureDefaultsFromRuntime(input: {
    orgId: string;
    agentRuntimeType: AgentRuntimeType;
    agentRuntimeConfig: Record<string, unknown>;
    testRuntimeChain?: (input: {
      purpose: OrganizationIntelligenceProfilePurpose;
      agentRuntimeType: AgentRuntimeType;
      agentRuntimeConfig: Record<string, unknown>;
    }) => Promise<void>;
  }) {
    if (await getDefault(input.orgId)) return [];
    const purpose = DEFAULT_INTELLIGENCE_PROFILE_PURPOSE;
    const agentRuntimeConfig = buildIntelligenceProfileConfigWithPurposeDefaults(
      purpose,
      input.agentRuntimeType,
      input.agentRuntimeConfig,
    );
    let status: OrganizationIntelligenceProfileStatus = "disabled";
    let lastError: string | null = null;
    let lastVerifiedAt: Date | null = null;
    if (input.agentRuntimeType === "codex_local" && input.testRuntimeChain) {
      try {
        await input.testRuntimeChain({ purpose, agentRuntimeType: input.agentRuntimeType, agentRuntimeConfig });
        status = "configured";
        lastVerifiedAt = new Date();
      } catch (error) {
        status = "invalid";
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    const profile = await createDefaultIfAbsent(input.orgId, {
      agentRuntimeType: input.agentRuntimeType,
      agentRuntimeConfig,
      status,
      lastError,
      lastVerifiedAt,
    });
    return profile ? [profile] : [];
  }

  return { getByPurpose, list, upsert, ensureDefaultsFromRuntime, sanitizeConfigForProductIntelligence };
}
