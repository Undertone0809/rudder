const STORAGE_KEY = "rudder.primaryRailLastPaths";

export type PrimaryRailSection =
  | "messenger"
  | "dashboard"
  | "issues"
  | "agents"
  | "library"
  | "organization"
  | "automations";

type StoredPrimaryRailPaths = Record<string, Partial<Record<PrimaryRailSection, string>>>;

function splitPath(path: string): { pathname: string; search: string; hash: string } {
  const match = path.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  return {
    pathname: match?.[1] ?? path,
    search: match?.[2] ?? "",
    hash: match?.[3] ?? "",
  };
}

function readStoredPrimaryRailPaths(): StoredPrimaryRailPaths {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as StoredPrimaryRailPaths : {};
  } catch {
    return {};
  }
}

function writeStoredPrimaryRailPaths(paths: StoredPrimaryRailPaths) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
  } catch {
    // Ignore storage failures so navigation still works without persistence.
  }
}

export function resolvePrimaryRailSection(path: string): PrimaryRailSection | null {
  const { pathname } = splitPath(path);

  if (/^\/(?:messenger|chat)(?:\/|$)/.test(pathname)) return "messenger";
  if (/^\/(?:dashboard|calendar)(?:\/|$)/.test(pathname)) return "dashboard";
  if (/^\/issues(?:\/|$)/.test(pathname)) return "issues";
  if (/^\/agents(?:\/|$)/.test(pathname)) return "agents";
  if (/^\/(?:library|resources|workspaces)(?:\/|$)/.test(pathname)) return "library";
  if (/^\/(?:org|projects|heartbeats|goals|skills|costs|activity)(?:\/|$)/.test(pathname)) return "organization";
  if (/^\/automations(?:\/|$)/.test(pathname)) return "automations";

  return null;
}

export function sanitizePrimaryRailPath(section: PrimaryRailSection, path: string | null | undefined): string | null {
  if (!path?.startsWith("/")) return null;
  const { pathname, search, hash } = splitPath(path);
  if (resolvePrimaryRailSection(pathname) !== section) return null;
  return `${pathname}${search}${hash}`;
}

export function rememberPrimaryRailPath(orgId: string | null | undefined, path: string) {
  if (!orgId) return;
  const section = resolvePrimaryRailSection(path);
  if (!section) return;
  const sanitizedPath = sanitizePrimaryRailPath(section, path);
  if (!sanitizedPath) return;

  const paths = readStoredPrimaryRailPaths();
  paths[orgId] = {
    ...(paths[orgId] ?? {}),
    [section]: sanitizedPath,
  };
  writeStoredPrimaryRailPaths(paths);
}

export function readRememberedPrimaryRailPath(
  orgId: string | null | undefined,
  section: PrimaryRailSection,
  fallbackPath: string,
): string {
  if (!orgId) return fallbackPath;
  const rememberedPath = sanitizePrimaryRailPath(section, readStoredPrimaryRailPaths()[orgId]?.[section]);
  return rememberedPath ?? fallbackPath;
}
