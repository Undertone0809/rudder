import {
  DEFAULT_CODEX_LOCAL_MODEL,
  DEFAULT_CODEX_LOCAL_REASONING_EFFORT,
} from "@rudderhq/agent-runtime-codex-local";
import type { OrganizationIntelligenceProfile } from "@rudderhq/shared";

export const DEFAULT_INTELLIGENCE_PROFILE_PURPOSE = "default" as const;
const LEGACY_CODEX_DEFAULT_MODELS = new Set(["gpt-5.5", "gpt-5.4-mini"]);

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
  if (canonical) return canonical;

  const legacy = scoped
    .filter((profile) => profile.purpose === "lightweight" || profile.purpose === "reasoning")
    .sort(compareLegacyProfiles)[0];
  if (!legacy) return null;

  const migrated: OrganizationIntelligenceProfile = {
    ...legacy,
    purpose: DEFAULT_INTELLIGENCE_PROFILE_PURPOSE,
    agentRuntimeConfig: { ...legacy.agentRuntimeConfig },
  };
  if (legacy.agentRuntimeType !== "codex_local") return migrated;

  const config = migrated.agentRuntimeConfig;
  const model = typeof config.model === "string" ? config.model.trim() : "";
  const replaceLegacyDefault = !model || LEGACY_CODEX_DEFAULT_MODELS.has(model);
  const hasEffort = [config.modelReasoningEffort, config.reasoningEffort]
    .some((value) => typeof value === "string" && value.trim().length > 0);
  if (!replaceLegacyDefault && (model !== DEFAULT_CODEX_LOCAL_MODEL || hasEffort)) return migrated;

  config.model = DEFAULT_CODEX_LOCAL_MODEL;
  config.modelReasoningEffort = DEFAULT_CODEX_LOCAL_REASONING_EFFORT;
  delete config.reasoningEffort;
  migrated.status = "disabled";
  migrated.lastVerifiedAt = null;
  migrated.lastError = "Model defaults changed. Test the runtime chain before enabling.";
  return migrated;
}
