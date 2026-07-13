export const ORGANIZATION_ISSUE_KEY_MAX_LENGTH = 12;
export const ORGANIZATION_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*$/;

export function normalizeOrganizationIssueKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (!normalized || normalized.length > ORGANIZATION_ISSUE_KEY_MAX_LENGTH) return null;
  return ORGANIZATION_ISSUE_KEY_PATTERN.test(normalized) ? normalized : null;
}

export function deriveOrganizationIssueKey(name: string | null | undefined): string {
  const normalized = typeof name === "string"
    ? name.toUpperCase().replace(/[^A-Z0-9]/g, "")
    : "";
  const candidate = normalized.slice(0, 3);
  if (/^[A-Z]/.test(candidate)) return candidate;
  return "CMP";
}
