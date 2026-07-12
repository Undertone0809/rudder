import type { Db } from "@rudderhq/db";
import { organizationIntelligenceProfiles } from "@rudderhq/db";
import {
  ORGANIZATION_INTELLIGENCE_PROFILE_PURPOSES,
  type AgentRuntimeType,
  type OrganizationIntelligenceProfile,
  type OrganizationIntelligenceProfilePurpose,
  type OrganizationIntelligenceProfileStatus,
} from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";

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

const DEFAULT_CODEX_INTELLIGENCE_MODEL = "gpt-5.4-mini";

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
        return {
          ...fallback,
          ...(fallbackConfig ? { config: fallbackConfig } : {}),
        };
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
    delete config.modelReasoningEffort;
    delete config.reasoningEffort;
    return {
      ...config,
      model: DEFAULT_CODEX_INTELLIGENCE_MODEL,
    };
  }

  return {
    ...base,
    model: typeof base.model === "string" && base.model.trim().length > 0 ? base.model : undefined,
  };
}

export function organizationIntelligenceProfileService(db: Db) {
  async function getByPurpose(orgId: string, purpose: OrganizationIntelligenceProfilePurpose) {
    return db
      .select()
      .from(organizationIntelligenceProfiles)
      .where(and(
        eq(organizationIntelligenceProfiles.orgId, orgId),
        eq(organizationIntelligenceProfiles.purpose, purpose),
      ))
      .then((rows) => rows[0] ? toProfile(rows[0]) : null);
  }

  async function list(orgId: string) {
    const rows = await db
      .select()
      .from(organizationIntelligenceProfiles)
      .where(eq(organizationIntelligenceProfiles.orgId, orgId));
    const byPurpose = new Map(rows.map((row) => [row.purpose, toProfile(row)]));
    return ORGANIZATION_INTELLIGENCE_PROFILE_PURPOSES.map((purpose) => byPurpose.get(purpose) ?? null);
  }

  async function upsert(
    orgId: string,
    purpose: OrganizationIntelligenceProfilePurpose,
    data: {
      agentRuntimeType: AgentRuntimeType;
      agentRuntimeConfig: Record<string, unknown>;
      status?: OrganizationIntelligenceProfileStatus;
      lastError?: string | null;
      lastVerifiedAt?: Date | null;
    },
  ) {
    const sanitizedConfig = sanitizeConfigForProductIntelligence(data.agentRuntimeConfig);
    const [row] = await db
      .insert(organizationIntelligenceProfiles)
      .values({
        orgId,
        purpose,
        agentRuntimeType: data.agentRuntimeType,
        agentRuntimeConfig: sanitizedConfig,
        status: data.status ?? "disabled",
        lastError: data.lastError ?? null,
        lastVerifiedAt: data.lastVerifiedAt ?? null,
      })
      .onConflictDoUpdate({
        target: [organizationIntelligenceProfiles.orgId, organizationIntelligenceProfiles.purpose],
        set: {
          agentRuntimeType: data.agentRuntimeType,
          agentRuntimeConfig: sanitizedConfig,
          status: data.status ?? "disabled",
          lastError: data.lastError ?? null,
          lastVerifiedAt: data.lastVerifiedAt ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return toProfile(row!);
  }

  async function createDefaultIfAbsent(
    orgId: string,
    purpose: OrganizationIntelligenceProfilePurpose,
    data: {
      agentRuntimeType: AgentRuntimeType;
      agentRuntimeConfig: Record<string, unknown>;
      status?: OrganizationIntelligenceProfileStatus;
      lastError?: string | null;
      lastVerifiedAt?: Date | null;
    },
  ) {
    const sanitizedConfig = sanitizeConfigForProductIntelligence(data.agentRuntimeConfig);
    const [row] = await db
      .insert(organizationIntelligenceProfiles)
      .values({
        orgId,
        purpose,
        agentRuntimeType: data.agentRuntimeType,
        agentRuntimeConfig: sanitizedConfig,
        status: data.status ?? "disabled",
        lastError: data.lastError ?? null,
        lastVerifiedAt: data.lastVerifiedAt ?? null,
      })
      .onConflictDoNothing({
        target: [organizationIntelligenceProfiles.orgId, organizationIntelligenceProfiles.purpose],
      })
      .returning();
    if (row) return toProfile(row);
    return getByPurpose(orgId, purpose);
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
    const existing = await list(input.orgId);
    const existingPurposes = new Set(existing.filter(Boolean).map((profile) => profile!.purpose));
    const created: OrganizationIntelligenceProfile[] = [];
    for (const purpose of ORGANIZATION_INTELLIGENCE_PROFILE_PURPOSES) {
      if (existingPurposes.has(purpose)) continue;
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
          await input.testRuntimeChain({
            purpose,
            agentRuntimeType: input.agentRuntimeType,
            agentRuntimeConfig,
          });
          status = "configured";
          lastVerifiedAt = new Date();
        } catch (error) {
          status = "invalid";
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      const profile = await createDefaultIfAbsent(input.orgId, purpose, {
        agentRuntimeType: input.agentRuntimeType,
        agentRuntimeConfig,
        status,
        lastError,
        lastVerifiedAt,
      });
      if (profile) created.push(profile);
    }
    return created;
  }

  return {
    getByPurpose,
    list,
    upsert,
    ensureDefaultsFromRuntime,
    sanitizeConfigForProductIntelligence,
  };
}
