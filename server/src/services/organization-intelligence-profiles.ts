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
  "rudderSkillSync",
  "paperclipSkillSync",
  "rudderRuntimeSkills",
  "paperclipRuntimeSkills",
  "workspaceStrategy",
  "workspaceRuntime",
  "cwd",
]);

const DEFAULT_CODEX_FAST_MODEL = "gpt-5.4-mini";
const DEFAULT_CODEX_SMART_MODEL = "gpt-5.4";

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
  purpose: OrganizationIntelligenceProfilePurpose,
  agentRuntimeType: string,
  sourceConfig: Record<string, unknown>,
): Record<string, unknown> {
  const base = sanitizeConfigForProductIntelligence(sourceConfig);
  if (agentRuntimeType === "codex_local") {
    return {
      ...base,
      model: purpose === "lightweight" ? DEFAULT_CODEX_FAST_MODEL : DEFAULT_CODEX_SMART_MODEL,
      modelReasoningEffort: purpose === "lightweight" ? "low" : "medium",
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
        status: data.status ?? "configured",
        lastError: data.lastError ?? null,
        lastVerifiedAt: data.lastVerifiedAt ?? null,
      })
      .onConflictDoUpdate({
        target: [organizationIntelligenceProfiles.orgId, organizationIntelligenceProfiles.purpose],
        set: {
          agentRuntimeType: data.agentRuntimeType,
          agentRuntimeConfig: sanitizedConfig,
          status: data.status ?? "configured",
          lastError: data.lastError ?? null,
          lastVerifiedAt: data.lastVerifiedAt ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return toProfile(row!);
  }

  async function ensureDefaultsFromRuntime(input: {
    orgId: string;
    agentRuntimeType: AgentRuntimeType;
    agentRuntimeConfig: Record<string, unknown>;
  }) {
    const existing = await list(input.orgId);
    const existingPurposes = new Set(existing.filter(Boolean).map((profile) => profile!.purpose));
    const created: OrganizationIntelligenceProfile[] = [];
    for (const purpose of ORGANIZATION_INTELLIGENCE_PROFILE_PURPOSES) {
      if (existingPurposes.has(purpose)) continue;
      created.push(await upsert(input.orgId, purpose, {
        agentRuntimeType: input.agentRuntimeType,
        agentRuntimeConfig: buildIntelligenceProfileConfigWithPurposeDefaults(
          purpose,
          input.agentRuntimeType,
          input.agentRuntimeConfig,
        ),
        status: "configured",
      }));
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
