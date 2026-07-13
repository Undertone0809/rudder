export function getOrganizationSettingsPath(organizationRouteKey: string): string {
  return `/${organizationRouteKey.trim()}/organization/settings`;
}
