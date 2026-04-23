import {
  extractOrganizationPrefixFromPath,
  findOrganizationByPrefix,
  normalizeOrganizationPrefix,
  toOrganizationRelativePath,
} from "./organization-routes";

const GLOBAL_SEGMENTS = new Set(["auth", "invite", "board-claim", "cli-auth", "docs"]);

export function isRememberableOrganizationPath(path: string): boolean {
  const pathname = path.split("?")[0] ?? "";
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const [root] = segments;
  if (GLOBAL_SEGMENTS.has(root!)) return false;
  return true;
}

export function getRememberedPathOwnerOrganizationId<T extends { id: string; issuePrefix: string }>(params: {
  organizations: T[];
  pathname: string;
  fallbackOrganizationId: string | null;
}): string | null {
  const routeOrganizationPrefix = extractOrganizationPrefixFromPath(params.pathname);
  if (!routeOrganizationPrefix) {
    return params.fallbackOrganizationId;
  }

  return findOrganizationByPrefix({
    organizations: params.organizations,
    organizationPrefix: routeOrganizationPrefix,
  })?.id ?? null;
}

export function sanitizeRememberedPathForOrganization(params: {
  path: string | null | undefined;
  organizationPrefix: string;
}): string {
  const relativePath = params.path ? toOrganizationRelativePath(params.path) : "/dashboard";
  if (!isRememberableOrganizationPath(relativePath)) {
    return "/dashboard";
  }

  const pathname = relativePath.split("?")[0] ?? "";
  const segments = pathname.split("/").filter(Boolean);
  const [root, entityId] = segments;
  if (root === "issues" && entityId) {
    const identifierMatch = /^([A-Za-z]+)-\d+$/.exec(entityId);
    if (
      identifierMatch &&
      normalizeOrganizationPrefix(identifierMatch[1] ?? "") !== normalizeOrganizationPrefix(params.organizationPrefix)
    ) {
      return "/dashboard";
    }
  }

  return relativePath;
}
