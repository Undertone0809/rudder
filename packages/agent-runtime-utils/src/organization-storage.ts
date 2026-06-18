const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_UUID_LENGTH = 12;

export function normalizeOrganizationStoragePathSegment(value: string, label = "organization id"): string {
  const trimmed = value.trim();
  if (!PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid ${label} for workspace path '${value}'.`);
  }
  return trimmed;
}

export function resolveOrganizationLegacyStorageKey(orgId: string): string {
  return normalizeOrganizationStoragePathSegment(orgId);
}

export function resolveOrganizationStorageKey(orgId: string): string {
  const normalized = normalizeOrganizationStoragePathSegment(orgId);
  if (!UUID_RE.test(normalized)) return normalized;
  return normalized.replace(/-/g, "").slice(0, SHORT_UUID_LENGTH).toLowerCase();
}

export function assertUniqueOrganizationStorageKeys(orgIds: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const orgId of orgIds) {
    const key = resolveOrganizationStorageKey(orgId);
    const existing = seen.get(key);
    if (existing && existing !== orgId) {
      throw new Error(
        `Organization storage key collision for '${key}' between '${existing}' and '${orgId}'.`,
      );
    }
    seen.set(key, orgId);
  }
}
