const BOARD_ROUTE_ROOTS = new Set([
  "dashboard",
  "organizations",
  "organization",
  "heartbeats",
  "resources",
  "workspaces",
  "skills",
  "org",
  "agents",
  "projects",
  "issues",
  "chat",
  "messenger",
  "automations",
  "goals",
  "costs",
  "usage",
  "activity",
  "inbox",
  "design-guide",
]);

const GLOBAL_ROUTE_ROOTS = new Set(["auth", "invite", "board-claim", "cli-auth", "docs", "instance"]);

export function normalizeOrganizationPrefix(prefix: string): string {
  return prefix.trim().toUpperCase();
}

function normalizeOrganizationRouteKey(value: string): string {
  return value.trim().toLowerCase();
}

export function findOrganizationByPrefix<T extends { issuePrefix: string; urlKey?: string | null }>(params: {
  organizations: T[];
  organizationPrefix: string | null | undefined;
}): T | null {
  if (!params.organizationPrefix) return null;
  const normalizedPrefix = normalizeOrganizationRouteKey(params.organizationPrefix);
  return params.organizations.find((organization) => {
    if (normalizeOrganizationRouteKey(organization.issuePrefix) === normalizedPrefix) return true;
    if (typeof organization.urlKey === "string" && normalizeOrganizationRouteKey(organization.urlKey) === normalizedPrefix) {
      return true;
    }
    return false;
  }) ?? null;
}

function splitPath(path: string): { pathname: string; search: string; hash: string } {
  const match = path.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    pathname: match?.[1] ?? path,
    search: match?.[2] ?? "",
    hash: match?.[3] ?? "",
  };
}

function getRootSegment(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment ?? null;
}

export function isGlobalPath(pathname: string): boolean {
  if (pathname === "/") return true;
  const root = getRootSegment(pathname);
  if (!root) return true;
  return GLOBAL_ROUTE_ROOTS.has(root.toLowerCase());
}

export function isBoardPathWithoutPrefix(pathname: string): boolean {
  const root = getRootSegment(pathname);
  if (!root) return false;
  return BOARD_ROUTE_ROOTS.has(root.toLowerCase());
}

export function extractOrganizationPrefixFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const first = segments[0]!.toLowerCase();
  if (GLOBAL_ROUTE_ROOTS.has(first) || BOARD_ROUTE_ROOTS.has(first)) {
    return null;
  }
  return normalizeOrganizationPrefix(segments[0]!);
}

export function applyOrganizationPrefix(path: string, organizationPrefix: string | null | undefined): string {
  const { pathname, search, hash } = splitPath(path);
  if (!pathname.startsWith("/")) return path;
  if (isGlobalPath(pathname)) return path;
  if (!organizationPrefix) return path;

  const prefix = normalizeOrganizationPrefix(organizationPrefix);
  const activePrefix = extractOrganizationPrefixFromPath(pathname);
  if (activePrefix) return path;

  return `/${prefix}${pathname}${search}${hash}`;
}

export function toOrganizationRelativePath(path: string): string {
  const { pathname, search, hash } = splitPath(path);
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length >= 2) {
    const second = segments[1]!.toLowerCase();
    if (!GLOBAL_ROUTE_ROOTS.has(segments[0]!.toLowerCase()) && BOARD_ROUTE_ROOTS.has(second)) {
      return `/${segments.slice(1).join("/")}${search}${hash}`;
    }
  }

  return `${pathname}${search}${hash}`;
}
