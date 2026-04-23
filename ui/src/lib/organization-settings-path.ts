import { normalizeOrganizationPrefix } from "./organization-routes";

export function getOrganizationSettingsPath(issuePrefix: string): string {
  return `/${normalizeOrganizationPrefix(issuePrefix)}/organization/settings`;
}
