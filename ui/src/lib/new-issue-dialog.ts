import { toOrganizationRelativePath } from "./organization-routes";
import { projectRouteRef } from "./utils";

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
