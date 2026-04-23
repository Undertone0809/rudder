export const INSTANCE_SETTINGS_PROFILE_PATH = "/instance/settings/profile";
export const INSTANCE_SETTINGS_GENERAL_PATH = "/instance/settings/general";
export const INSTANCE_SETTINGS_NOTIFICATIONS_PATH = "/instance/settings/notifications";
export const INSTANCE_SETTINGS_ORGANIZATIONS_PATH = "/instance/settings/organizations";
export const INSTANCE_SETTINGS_LANGFUSE_PATH = "/instance/settings/langfuse";
export const INSTANCE_SETTINGS_ABOUT_PATH = "/instance/settings/about";
export const ORGANIZATION_SETTINGS_GENERAL_PATH = "/organization/settings";
export const DEFAULT_INSTANCE_SETTINGS_PATH = INSTANCE_SETTINGS_GENERAL_PATH;
export const DEFAULT_SETTINGS_PATH = ORGANIZATION_SETTINGS_GENERAL_PATH;

export function resolveDefaultInstanceSettingsPath(canManageAdminSettings: boolean): string {
  return canManageAdminSettings ? INSTANCE_SETTINGS_GENERAL_PATH : INSTANCE_SETTINGS_PROFILE_PATH;
}

export function resolveDefaultSettingsPath(_canManageAdminSettings: boolean): string {
  return DEFAULT_SETTINGS_PATH;
}

export function normalizeRememberedInstanceSettingsPath(
  rawPath: string | null,
  canManageAdminSettings: boolean = true,
): string {
  const defaultPath = resolveDefaultInstanceSettingsPath(canManageAdminSettings);
  if (!rawPath) return defaultPath;

  const match = rawPath.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const pathname = match?.[1] ?? rawPath;
  const search = match?.[2] ?? "";
  const hash = match?.[3] ?? "";

  if (pathname === INSTANCE_SETTINGS_PROFILE_PATH) {
    return `${pathname}${search}${hash}`;
  }

  if (
    canManageAdminSettings &&
    (
      pathname === INSTANCE_SETTINGS_GENERAL_PATH ||
      pathname === INSTANCE_SETTINGS_NOTIFICATIONS_PATH ||
      pathname === INSTANCE_SETTINGS_ORGANIZATIONS_PATH ||
      pathname === INSTANCE_SETTINGS_LANGFUSE_PATH ||
      pathname === INSTANCE_SETTINGS_ABOUT_PATH ||
      pathname === "/instance/settings/heartbeats" ||
      pathname === "/instance/settings/plugins" ||
      pathname === "/instance/settings/experimental"
    )
  ) {
    return `${pathname}${search}${hash}`;
  }

  if (canManageAdminSettings && /^\/instance\/settings\/plugins\/[^/?#]+$/.test(pathname)) {
    return `${pathname}${search}${hash}`;
  }

  return defaultPath;
}

export function normalizeRememberedSettingsPath(
  rawPath: string | null,
  canManageAdminSettings: boolean = true,
): string {
  if (!rawPath) return DEFAULT_SETTINGS_PATH;

  const match = rawPath.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const pathname = match?.[1] ?? rawPath;
  const search = match?.[2] ?? "";
  const hash = match?.[3] ?? "";

  if (
    pathname === ORGANIZATION_SETTINGS_GENERAL_PATH ||
    pathname === "/org" ||
    pathname === "/heartbeats" ||
    pathname === "/skills" ||
    pathname === "/costs" ||
    pathname === "/activity"
  ) {
    return `${pathname}${search}${hash}`;
  }

  if (pathname === INSTANCE_SETTINGS_PROFILE_PATH) {
    return `${pathname}${search}${hash}`;
  }

  if (
    canManageAdminSettings &&
    (
      pathname === INSTANCE_SETTINGS_GENERAL_PATH ||
      pathname === INSTANCE_SETTINGS_NOTIFICATIONS_PATH ||
      pathname === INSTANCE_SETTINGS_ORGANIZATIONS_PATH ||
      pathname === INSTANCE_SETTINGS_LANGFUSE_PATH ||
      pathname === INSTANCE_SETTINGS_ABOUT_PATH ||
      pathname === "/instance/settings/heartbeats" ||
      pathname === "/instance/settings/plugins" ||
      pathname === "/instance/settings/experimental" ||
      /^\/instance\/settings\/plugins\/[^/?#]+$/.test(pathname)
    )
  ) {
    return `${pathname}${search}${hash}`;
  }

  if (!canManageAdminSettings && pathname.startsWith("/instance/settings/")) {
    return INSTANCE_SETTINGS_PROFILE_PATH;
  }

  const normalizedInstancePath = normalizeRememberedInstanceSettingsPath(rawPath, canManageAdminSettings);
  if (normalizedInstancePath !== resolveDefaultInstanceSettingsPath(canManageAdminSettings)) {
    return normalizedInstancePath;
  }

  return DEFAULT_SETTINGS_PATH;
}
