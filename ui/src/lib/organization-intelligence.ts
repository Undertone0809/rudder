import type {
  OrganizationIntelligenceProfile,
  OrganizationIntelligenceProfilePurpose,
} from "@rudderhq/shared";

type IntelligenceProfileLike = Pick<OrganizationIntelligenceProfile, "purpose" | "status"> | null | undefined;

export function isOrganizationIntelligenceEnabled(
  profiles: readonly IntelligenceProfileLike[] | null | undefined,
  legacyPurpose?: Extract<OrganizationIntelligenceProfilePurpose, "lightweight" | "reasoning">,
): boolean {
  const canonical = profiles?.find((profile) => profile?.purpose === "default");
  if (canonical) return canonical.status === "configured";
  return (profiles ?? []).some((profile) =>
    profile?.purpose === legacyPurpose && profile?.status === "configured",
  );
}
