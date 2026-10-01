import {
  DEFAULT_CODEX_LOCAL_REASONING_EFFORT,
} from "@rudderhq/agent-runtime-codex-local";
import type { OrganizationIntelligenceProfile } from "@rudderhq/shared";
import { DEFAULT_ORGANIZATION_INTELLIGENCE_CODEX_MODEL } from "@rudderhq/shared";

export const DEFAULT_INTELLIGENCE_PROFILE_PURPOSE = "default" as const;
const LEGACY_CODEX_DEFAULT_MODELS = new Set(["gpt-5.5", "gpt-5.4-mini"]);
const PREVIOUS_ORGANIZATION_CODEX_DEFAULT_MODEL = "gpt-5.6-luna";

function timestamp(value: Date | string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareLegacyProfiles(left: OrganizationIntelligenceProfile, right: OrganizationIntelligenceProfile): number {
  const enabled = Number(right.status === "configured") - Number(left.status === "configured");
  if (enabled !== 0) return enabled;
  const updated = timestamp(right.updatedAt) - timestamp(left.updatedAt);
  if (updated !== 0) return updated;
  return Number(right.purpose === "reasoning") - Number(left.purpose === "reasoning");
}

export function resolveDefaultIntelligenceProfile(
  orgId: string,
  profiles: readonly OrganizationIntelligenceProfile[],
): OrganizationIntelligenceProfile | null {
  const scoped = profiles.filter((profile) => profile.orgId === orgId);
  const canonical = scoped.find((profile) => profile.purpose === DEFAULT_INTELLIGENCE_PROFILE_PURPOSE);
  if (canonical) return migrateLegacyCodexDefault(canonical);

  const legacy = scoped
    .filter((profile) => profile.purpose === "lightweight" || profile.purpose === "reasoning")
    .sort(compareLegacyProfiles)[0];
  if (!legacy) return null;

  const migrated: OrganizationIntelligenceProfile = {
    ...legacy,
    purpose: DEFAULT_INTELLIGENCE_PROFILE_PURPOSE,
    agentRuntimeConfig: { ...legacy.agentRuntimeConfig },
  };
  return migrateLegacyCodexDefault(migrated);
}

/**
 * Upgrade only known organization defaults, preserve their chosen effort, and
 * require a fresh probe because readiness was verified against another model.
 */
function migrateLegacyCodexDefault(profile: OrganizationIntelligenceProfile): OrganizationIntelligenceProfile {
  if (profile.agentRuntimeType !== "codex_local") return profile;

  const config = profile.agentRuntimeConfig;
  const model = typeof config.model === "string" ? config.model.trim() : "";
  const modelEffort = [config.modelReasoningEffort, config.reasoningEffort]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
  const previousOrgDefault = model === PREVIOUS_ORGANIZATION_CODEX_DEFAULT_MODEL;
  const replaceLegacyDefault = !model || LEGACY_CODEX_DEFAULT_MODELS.has(model) || previousOrgDefault;
  if (!replaceLegacyDefault) return profile;

  const migrated: OrganizationIntelligenceProfile = {
    ...profile,
    agentRuntimeConfig: {
      ...config,
      model: DEFAULT_ORGANIZATION_INTELLIGENCE_CODEX_MODEL,
      modelReasoningEffort: modelEffort ?? DEFAULT_CODEX_LOCAL_REASONING_EFFORT,
    },
    status: "disabled",
    lastVerifiedAt: null,
    lastError: "Model defaults changed. Test the runtime chain before enabling.",
  };
  delete migrated.agentRuntimeConfig.reasoningEffort;
  return migrated;
}
