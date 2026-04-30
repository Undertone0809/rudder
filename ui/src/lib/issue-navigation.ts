const ISSUE_NAVIGATION_KEY = "rudder:issue-navigation";

const SUPPORTED_SCOPES = new Set(["assigned", "starred"]);

type StoredIssueNavigationState = {
  scope?: string;
  projectId?: string;
};

function getIssueNavigationStorageKey(selectedOrganizationId?: string | null): string {
  return selectedOrganizationId ? `${ISSUE_NAVIGATION_KEY}:${selectedOrganizationId}` : ISSUE_NAVIGATION_KEY;
}

function normalizeStoredIssueNavigationState(
  value: StoredIssueNavigationState | null | undefined,
): StoredIssueNavigationState {
  const scope = typeof value?.scope === "string" && SUPPORTED_SCOPES.has(value.scope) ? value.scope : undefined;
  const projectId = typeof value?.projectId === "string" && value.projectId.trim().length > 0
    ? value.projectId
    : undefined;
  return { scope, projectId };
}

export function buildIssueNavigationPath(value: StoredIssueNavigationState | null | undefined): string {
  const normalized = normalizeStoredIssueNavigationState(value);
  const searchParams = new URLSearchParams();
  if (normalized.projectId) {
    searchParams.set("projectId", normalized.projectId);
  } else if (normalized.scope) {
    searchParams.set("scope", normalized.scope);
  }
  const search = searchParams.toString();
  return search ? `/issues?${search}` : "/issues";
}

export function readRememberedIssueNavigationPath(selectedOrganizationId?: string | null): string {
  if (typeof window === "undefined") return "/issues";
  try {
    const raw = window.localStorage.getItem(getIssueNavigationStorageKey(selectedOrganizationId));
    if (!raw) return "/issues";
    const parsed = JSON.parse(raw) as StoredIssueNavigationState;
    return buildIssueNavigationPath(parsed);
  } catch {
    return "/issues";
  }
}

export function rememberIssueNavigation(
  selectedOrganizationId: string | null | undefined,
  value: StoredIssueNavigationState,
): void {
  if (typeof window === "undefined") return;
  try {
    const normalized = normalizeStoredIssueNavigationState(value);
    window.localStorage.setItem(
      getIssueNavigationStorageKey(selectedOrganizationId),
      JSON.stringify(normalized),
    );
  } catch {
    // ignore local storage failures
  }
}
