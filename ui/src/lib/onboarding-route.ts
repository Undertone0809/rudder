type OnboardingRouteOrganization = {
  id: string;
  issuePrefix: string;
};

export function isOnboardingPath(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 1) {
    return segments[0]?.toLowerCase() === "onboarding";
  }

  if (segments.length === 2) {
    return segments[1]?.toLowerCase() === "onboarding";
  }

  return false;
}

export function resolveRouteOnboardingOptions(params: {
  pathname: string;
  orgPrefix?: string;
  organizations: OnboardingRouteOrganization[];
}): { initialStep: 1 | 2; orgId?: string } | null {
  const { pathname, orgPrefix, organizations } = params;

  if (!isOnboardingPath(pathname)) return null;

  if (!orgPrefix) {
    return { initialStep: 1 };
  }

  const matchedOrganization =
    organizations.find(
      (organization) =>
        organization.issuePrefix.toUpperCase() === orgPrefix.toUpperCase(),
    ) ?? null;

  if (!matchedOrganization) {
    return { initialStep: 1 };
  }

  return { initialStep: 2, orgId: matchedOrganization.id };
}

export function shouldRedirectOrganizationlessRouteToOnboarding(params: {
  pathname: string;
  hasOrganizations: boolean;
}): boolean {
  return !params.hasOrganizations && !isOnboardingPath(params.pathname);
}
