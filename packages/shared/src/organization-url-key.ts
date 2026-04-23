const ORGANIZATION_URL_KEY_DELIM_RE = /[^a-z0-9]+/g;
const ORGANIZATION_URL_KEY_TRIM_RE = /^-+|-+$/g;

export function normalizeOrganizationUrlKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(ORGANIZATION_URL_KEY_DELIM_RE, "-")
    .replace(ORGANIZATION_URL_KEY_TRIM_RE, "");
  return normalized.length > 0 ? normalized : null;
}

export function deriveOrganizationUrlKey(name: string | null | undefined, fallback?: string | null): string {
  return normalizeOrganizationUrlKey(name) ?? normalizeOrganizationUrlKey(fallback) ?? "organization";
}
