const LEGACY_RECENT_ISSUES_KEY = "rudder:recent-issues";
const RECENT_ISSUES_LIMIT = 50;

function dedupeIssueIds(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function readStoredIssueRefs(
  key: string,
): { exists: boolean; values: string[] } {
  if (typeof window === "undefined") {
    return { exists: false, values: [] };
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return { exists: false, values: [] };
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { exists: true, values: [] };
    }
    return { exists: true, values: dedupeIssueIds(parsed) };
  } catch {
    return { exists: false, values: [] };
  }
}

export function recentIssuesStorageKey(orgId: string): string {
  return `${LEGACY_RECENT_ISSUES_KEY}:${orgId}`;
}

export function readRecentIssueIds(orgId?: string | null): string[] {
  if (!orgId) return [];

  const scoped = readStoredIssueRefs(recentIssuesStorageKey(orgId));
  if (scoped.exists) {
    return scoped.values;
  }

  return readStoredIssueRefs(LEGACY_RECENT_ISSUES_KEY).values;
}

export function writeRecentIssueIds(orgId: string, values: string[]): string[] {
  const next = dedupeIssueIds(values).slice(0, RECENT_ISSUES_LIMIT);

  if (typeof window === "undefined") {
    return next;
  }

  try {
    window.localStorage.setItem(recentIssuesStorageKey(orgId), JSON.stringify(next));
  } catch {
    // ignore local storage failures
  }

  return next;
}

export function recordRecentIssue(
  orgId: string,
  issueId: string,
  currentIssueIds: string[],
): string[] {
  return writeRecentIssueIds(orgId, [issueId, ...currentIssueIds]);
}

export function resolveRecentIssues<T extends { id: string }>(
  recentIssueIds: string[],
  issues: T[],
): T[] {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  return dedupeIssueIds(recentIssueIds)
    .map((issueId) => byId.get(issueId))
    .filter((issue): issue is T => Boolean(issue));
}
