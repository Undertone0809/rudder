import { useMemo } from "react";
import { useParams } from "@/lib/router";
import { useOrganization } from "@/context/OrganizationContext";
import {
  findOrganizationByPrefix,
  normalizeOrganizationPrefix,
} from "@/lib/organization-routes";

export function useViewedOrganization() {
  const { orgPrefix } = useParams<{ orgPrefix?: string }>();
  const { organizations } = useOrganization();

  const normalizedOrgPrefix = useMemo(
    () => (orgPrefix ? normalizeOrganizationPrefix(orgPrefix) : null),
    [orgPrefix],
  );
  const viewedOrganization = useMemo(
    () =>
      findOrganizationByPrefix({
        organizations,
        organizationPrefix: normalizedOrgPrefix,
      }),
    [normalizedOrgPrefix, organizations],
  );

  return {
    viewedOrganization,
    viewedOrganizationId: viewedOrganization?.id ?? null,
    viewedOrganizationPrefix: normalizedOrgPrefix,
  };
}
