import { toOrganizationRelativePath } from "./organization-routes";
import { projectRouteRef } from "./utils";

export const LEGACY_ISSUE_DRAFT_STORAGE_KEY = "rudder:issue-draft";
export const ISSUE_AUTOSAVE_STORAGE_KEY = "rudder:issue-autosave";
export const ISSUE_DRAFTS_STORAGE_KEY = "rudder:issue-drafts";
export const ISSUE_DRAFT_CHANGED_EVENT = "rudder:issue-draft-changed";

export interface IssueDraft {
  orgId?: string | null;
  title: string;
  description: string;
  status: string;
  priority: string;
  labelIds?: string[];
  assigneeValue: string;
  assigneeId?: string;
  projectId: string;
  projectWorkspaceId?: string;
  assigneeModelOverride: string;
  assigneeThinkingEffort: string;
  assigneeChrome: boolean;
  executionWorkspaceMode?: string;
  selectedExecutionWorkspaceId?: string;
  useIsolatedExecutionWorkspace?: boolean;
}

export interface IssueDraftSummary {
  id: string;
  title: string;
  description: string;
  projectId: string;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedIssueDraft extends IssueDraft {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface BuildNewIssueCreateRequestInput {
  title: string;
  description: string;
  parentId?: string;
  status: string;
  priority: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  projectId: string;
  labelIds: string[];
  projectWorkspaceId: string;
  assigneeAgentRuntimeOverrides?: Record<string, unknown> | null;
  executionWorkspacePolicyEnabled: boolean;
  executionWorkspaceMode: string;
  selectedExecutionWorkspaceId: string;
  executionWorkspaceSettings?: { mode: string } | null;
}

type NewIssueDialogProjectContext = {
  id: string;
  urlKey?: string | null;
  name?: string | null;
};

export interface ResolvedNewIssueDraftInput {
  status?: string;
  priority?: string;
  projectId: string;
  labelIds?: string[];
  assigneeValue?: string;
  assigneeId?: string;
}

function issueDraftStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function emitIssueDraftChanged() {
  try {
    globalThis.dispatchEvent?.(new Event(ISSUE_DRAFT_CHANGED_EVENT));
  } catch {
    // Some SSR/test environments do not expose Event.
  }
}

function safeTrim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function hasMeaningfulIssueDraft(draft: Partial<IssueDraft> | null | undefined): boolean {
  if (!draft) return false;
  return Boolean(
    safeTrim(draft.title) ||
      safeTrim(draft.description) ||
      safeTrim(draft.projectId) ||
      safeTrim(draft.assigneeValue) ||
      safeTrim(draft.assigneeId) ||
      (safeTrim(draft.priority) && safeTrim(draft.priority) !== "medium") ||
      (safeTrim(draft.status) && safeTrim(draft.status) !== "todo") ||
      (Array.isArray(draft.labelIds) && draft.labelIds.length > 0) ||
      safeTrim(draft.projectWorkspaceId) ||
      safeTrim(draft.assigneeModelOverride) ||
      safeTrim(draft.assigneeThinkingEffort) ||
      Boolean(draft.assigneeChrome) ||
      safeTrim(draft.selectedExecutionWorkspaceId) ||
      (safeTrim(draft.executionWorkspaceMode) && safeTrim(draft.executionWorkspaceMode) !== "shared_workspace"),
  );
}

function issueDraftId() {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  } catch {
    return `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

export function readIssueAutosave(orgId?: string | null): IssueDraft | null {
  try {
    const storage = issueDraftStorage();
    const raw = storage?.getItem(ISSUE_AUTOSAVE_STORAGE_KEY)
      ?? storage?.getItem(LEGACY_ISSUE_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as IssueDraft;
    if (orgId && draft.orgId && draft.orgId !== orgId) return null;
    return hasMeaningfulIssueDraft(draft) ? draft : null;
  } catch {
    return null;
  }
}

export function saveIssueAutosave(draft: IssueDraft) {
  if (!hasMeaningfulIssueDraft(draft)) return;
  const storage = issueDraftStorage();
  storage?.setItem(ISSUE_AUTOSAVE_STORAGE_KEY, JSON.stringify(draft));
  storage?.removeItem(LEGACY_ISSUE_DRAFT_STORAGE_KEY);
  emitIssueDraftChanged();
}

export function clearIssueAutosave() {
  const storage = issueDraftStorage();
  storage?.removeItem(ISSUE_AUTOSAVE_STORAGE_KEY);
  storage?.removeItem(LEGACY_ISSUE_DRAFT_STORAGE_KEY);
  emitIssueDraftChanged();
}

function readAllIssueDrafts(): SavedIssueDraft[] {
  try {
    const raw = issueDraftStorage()?.getItem(ISSUE_DRAFTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(hasMeaningfulIssueDraft) as SavedIssueDraft[] : [];
  } catch {
    return [];
  }
}

function writeAllIssueDrafts(drafts: SavedIssueDraft[]) {
  issueDraftStorage()?.setItem(ISSUE_DRAFTS_STORAGE_KEY, JSON.stringify(drafts));
  emitIssueDraftChanged();
}

export function listIssueDrafts(orgId?: string | null): SavedIssueDraft[] {
  return readAllIssueDrafts()
    .filter((draft) => !orgId || !draft.orgId || draft.orgId === orgId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function readSavedIssueDraft(id: string | null | undefined, orgId?: string | null): SavedIssueDraft | null {
  if (!id) return null;
  return listIssueDrafts(orgId).find((draft) => draft.id === id) ?? null;
}

export function createIssueDraft(draft: IssueDraft): SavedIssueDraft | null {
  if (!hasMeaningfulIssueDraft(draft)) return null;
  const now = new Date().toISOString();
  const savedDraft: SavedIssueDraft = {
    ...draft,
    id: issueDraftId(),
    createdAt: now,
    updatedAt: now,
  };
  writeAllIssueDrafts([savedDraft, ...readAllIssueDrafts()]);
  return savedDraft;
}

export function deleteIssueDraft(id: string | null | undefined) {
  if (!id) return;
  writeAllIssueDrafts(readAllIssueDrafts().filter((draft) => draft.id !== id));
}

export function summarizeIssueDraft(draft: SavedIssueDraft): IssueDraftSummary {
  const title = draft.title.trim() || "Untitled issue draft";
  return {
    id: draft.id,
    title,
    description: draft.description.trim(),
    projectId: draft.projectId,
    status: draft.status || "todo",
    priority: draft.priority,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

export function summarizeIssueDrafts(orgId?: string | null): IssueDraftSummary[] {
  return listIssueDrafts(orgId).map(summarizeIssueDraft);
}

export interface ResolvedNewIssueDefaultsInput {
  status?: string;
  priority?: string;
  projectId?: string;
  labelIds?: string[];
  assigneeAgentId?: string;
  assigneeUserId?: string;
}

export function resolveDraftBackedNewIssueValues(input: {
  defaults: ResolvedNewIssueDefaultsInput;
  draft: ResolvedNewIssueDraftInput;
  defaultProjectId: string;
  defaultAssigneeValue: string;
}): {
  status: string;
  priority: string;
  projectId: string;
  labelIds: string[];
  assigneeValue: string;
} {
  const hasExplicitAssignee = Boolean(input.defaults.assigneeAgentId || input.defaults.assigneeUserId);
  return {
    status: input.defaults.status ?? input.draft.status ?? "todo",
    priority: input.defaults.priority ?? input.draft.priority ?? "",
    projectId: input.defaultProjectId || input.draft.projectId,
    labelIds: input.defaults.labelIds ?? input.draft.labelIds ?? [],
    assigneeValue: hasExplicitAssignee
      ? input.defaultAssigneeValue
      : (input.draft.assigneeValue ?? input.draft.assigneeId ?? ""),
  };
}

export function resolveDefaultNewIssueProjectId(input: {
  explicitProjectId?: string | null;
  pathname: string;
  search?: string;
  projects: NewIssueDialogProjectContext[];
}): string {
  const explicitProjectId = input.explicitProjectId?.trim();
  if (explicitProjectId) return explicitProjectId;

  const searchProjectId = new URLSearchParams(input.search ?? "").get("projectId")?.trim();
  if (searchProjectId && input.projects.some((project) => project.id === searchProjectId)) {
    return searchProjectId;
  }

  const relativePath = toOrganizationRelativePath(input.pathname);
  const projectMatch = relativePath.match(/^\/projects\/([^/?#]+)/);
  if (!projectMatch?.[1]) return "";

  const routeRef = decodeURIComponent(projectMatch[1]).trim();
  if (!routeRef) return "";

  return input.projects.find((project) => project.id === routeRef || projectRouteRef(project) === routeRef)?.id ?? "";
}

export function buildNewIssueCreateRequest(input: BuildNewIssueCreateRequestInput): Record<string, unknown> {
  return {
    title: input.title.trim(),
    description: input.description.trim() || undefined,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    status: input.status,
    priority: input.priority || "medium",
    ...(input.assigneeAgentId ? { assigneeAgentId: input.assigneeAgentId } : {}),
    ...(input.assigneeUserId ? { assigneeUserId: input.assigneeUserId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.labelIds.length > 0 ? { labelIds: input.labelIds } : {}),
    ...(input.projectWorkspaceId ? { projectWorkspaceId: input.projectWorkspaceId } : {}),
    ...(input.assigneeAgentRuntimeOverrides ? { assigneeAgentRuntimeOverrides: input.assigneeAgentRuntimeOverrides } : {}),
    ...(input.executionWorkspacePolicyEnabled ? { executionWorkspacePreference: input.executionWorkspaceMode } : {}),
    ...(input.executionWorkspaceMode === "reuse_existing" && input.selectedExecutionWorkspaceId
      ? { executionWorkspaceId: input.selectedExecutionWorkspaceId }
      : {}),
    ...(input.executionWorkspaceSettings ? { executionWorkspaceSettings: input.executionWorkspaceSettings } : {}),
  };
}
