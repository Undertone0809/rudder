export type DesktopLocalEnvName = "dev" | "prod_local" | "e2e";

export function defaultDesktopAppName(profileName: DesktopLocalEnvName): string {
  switch (profileName) {
    case "dev":
      return "Rudder-dev";
    case "e2e":
      return "Rudder-e2e";
    case "prod_local":
    default:
      return "Rudder";
  }
}

export function resolveDesktopAppName(
  profileName: DesktopLocalEnvName,
  explicitAppName: string | null | undefined = process.env.RUDDER_DESKTOP_APP_NAME,
): string {
  const normalizedOverride = explicitAppName?.trim();
  if (normalizedOverride) {
    return normalizedOverride;
  }
  return defaultDesktopAppName(profileName);
}
