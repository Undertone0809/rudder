export const ISSUE_CUSTOM_VIEWS_CHANGED_EVENT = "rudder:issue-custom-views-changed";

const ISSUE_CUSTOM_VIEWS_STORAGE_KEY = "rudder:issue-custom-views";
const MAX_CUSTOM_VIEWS = 30;

export type IssueCustomViewState = {
  statuses: string[];
  priorities: string[];
  assignees: string[];
  labels: string[];
  projects: string[];
  displayProperties: string[];
  sortField: "status" | "priority" | "title" | "created" | "updated";
  sortDir: "asc" | "desc";
  groupBy: "status" | "priority" | "assignee" | "project" | "none";
  viewMode: "list" | "board";
  collapsedGroups: string[];
};

export type IssueCustomView = {
  id: string;
  orgId: string;
  name: string;
  state: IssueCustomViewState;
  createdAt: string;
  updatedAt: string;
};

function storageKey(orgId: string): string {
  return `${ISSUE_CUSTOM_VIEWS_STORAGE_KEY}:${orgId}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normalizeState(value: unknown): IssueCustomViewState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<IssueCustomViewState>;
  const sortField = ["status", "priority", "title", "created", "updated"].includes(candidate.sortField ?? "")
    ? candidate.sortField!
    : "updated";
  const sortDir = candidate.sortDir === "asc" || candidate.sortDir === "desc" ? candidate.sortDir : "desc";
  const groupBy = ["status", "priority", "assignee", "project", "none"].includes(candidate.groupBy ?? "")
    ? candidate.groupBy!
    : "none";
  const viewMode = candidate.viewMode === "board" ? "board" : "list";

  return {
    statuses: normalizeStringArray(candidate.statuses),
    priorities: normalizeStringArray(candidate.priorities),
    assignees: normalizeStringArray(candidate.assignees),
    labels: normalizeStringArray(candidate.labels),
    projects: normalizeStringArray(candidate.projects),
    displayProperties: normalizeStringArray(candidate.displayProperties),
    sortField,
    sortDir,
    groupBy,
    viewMode,
    collapsedGroups: normalizeStringArray(candidate.collapsedGroups),
  };
}

function normalizeView(value: unknown, orgId: string): IssueCustomView | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<IssueCustomView>;
  const state = normalizeState(candidate.state);
  if (!state || typeof candidate.id !== "string" || typeof candidate.name !== "string") return null;

  const now = new Date().toISOString();
  return {
    id: candidate.id,
    orgId,
    name: candidate.name.trim() || "Custom board",
    state,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : now,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : now,
  };
}

function dispatchChanged(orgId: string, views: IssueCustomView[]) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(ISSUE_CUSTOM_VIEWS_CHANGED_EVENT, { detail: { orgId, views } }));
  } catch {
    // ignore event dispatch failures
  }
}

function writeIssueCustomViews(orgId: string, views: IssueCustomView[]): IssueCustomView[] {
  const next = views.slice(0, MAX_CUSTOM_VIEWS);
  if (typeof window === "undefined") return next;

  try {
    window.localStorage.setItem(storageKey(orgId), JSON.stringify(next));
  } catch {
    // ignore local storage failures
  }
  dispatchChanged(orgId, next);
  return next;
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function readIssueCustomViews(orgId?: string | null): IssueCustomView[] {
  if (!orgId || typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(storageKey(orgId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizeView(entry, orgId))
      .filter((entry): entry is IssueCustomView => Boolean(entry))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

export function findIssueCustomView(orgId: string | null | undefined, viewId: string | null | undefined): IssueCustomView | null {
  if (!orgId || !viewId) return null;
  return readIssueCustomViews(orgId).find((view) => view.id === viewId) ?? null;
}

export function createIssueCustomView(
  orgId: string,
  name: string,
  state: IssueCustomViewState,
): IssueCustomView {
  const now = new Date().toISOString();
  const nextView: IssueCustomView = {
    id: createId(),
    orgId,
    name: name.trim() || "Custom board",
    state: normalizeState(state) ?? state,
    createdAt: now,
    updatedAt: now,
  };
  writeIssueCustomViews(orgId, [...readIssueCustomViews(orgId), nextView]);
  return nextView;
}

export function updateIssueCustomViewState(
  orgId: string,
  viewId: string,
  state: IssueCustomViewState,
): IssueCustomView | null {
  const views = readIssueCustomViews(orgId);
  const index = views.findIndex((view) => view.id === viewId);
  if (index === -1) return null;

  const updated: IssueCustomView = {
    ...views[index]!,
    state: normalizeState(state) ?? state,
    updatedAt: new Date().toISOString(),
  };
  const next = [...views];
  next[index] = updated;
  writeIssueCustomViews(orgId, next);
  return updated;
}

export function deleteIssueCustomView(orgId: string, viewId: string): IssueCustomView[] {
  const next = readIssueCustomViews(orgId).filter((view) => view.id !== viewId);
  return writeIssueCustomViews(orgId, next);
}
