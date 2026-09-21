import type {
  OrganizationIntelligenceProfile,
  OrganizationIntelligenceProfilePurpose,
} from "@rudderhq/shared";

type IntelligenceProfileLike = Pick<OrganizationIntelligenceProfile, "purpose" | "status"> | null | undefined;

export function isOrganizationIntelligenceEnabled(
  profiles: readonly IntelligenceProfileLike[] | null | undefined,
  legacyPurpose?: Extract<OrganizationIntelligenceProfilePurpose, "lightweight" | "reasoning">,
): boolean {
  return (profiles ?? []).some((profile) => {
    if (!profile || profile.status !== "configured") return false;
    return profile.purpose === "default" || profile.purpose === legacyPurpose;
  });
}
