export const ISSUE_UPDATE_ACTIVITY_METADATA_KEYS = [
  "identifier",
  "issueIdentifier",
  "_previous",
  "_references",
  "source",
  "reopened",
  "reopenedFrom",
  "normalizedFromStatus",
  "normalizedReason",
] as const;

export const LOW_SIGNAL_ISSUE_UPDATE_ACTIVITY_FIELDS = ["description", "title"] as const;

const ISSUE_UPDATE_ACTIVITY_METADATA_KEY_SET = new Set<string>(ISSUE_UPDATE_ACTIVITY_METADATA_KEYS);
const LOW_SIGNAL_ISSUE_UPDATE_ACTIVITY_FIELD_SET = new Set<string>(LOW_SIGNAL_ISSUE_UPDATE_ACTIVITY_FIELDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function issueUpdatedChangedKeys(details: unknown): string[] {
  if (!isRecord(details)) return [];
  return Object.keys(details).filter((key) => !ISSUE_UPDATE_ACTIVITY_METADATA_KEY_SET.has(key));
}

export function hasMaterialIssueUpdateFields(details: unknown): boolean {
  return issueUpdatedChangedKeys(details).some((key) => !LOW_SIGNAL_ISSUE_UPDATE_ACTIVITY_FIELD_SET.has(key));
}

export function isLowSignalIssueContentOnlyUpdate(action: string, details: unknown): boolean {
  if (action !== "issue.updated") return false;
  const changedKeys = issueUpdatedChangedKeys(details);
  return changedKeys.length > 0 && changedKeys.every((key) => LOW_SIGNAL_ISSUE_UPDATE_ACTIVITY_FIELD_SET.has(key));
}
