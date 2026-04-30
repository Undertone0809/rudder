import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDialog, type NewIssueDefaults } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { AgentIcon } from "./AgentIconPicker";
import { queryKeys } from "../lib/queryKeys";
import { formatChatAgentLabel } from "../lib/agent-labels";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { groupBy } from "../lib/groupBy";
import { formatDate, cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { AssigneeLabel } from "./AssigneeLabel";
import { EmptyState } from "./EmptyState";
import { IssueLabelChip } from "./IssueLabelChip";
import { IssueRow } from "./IssueRow";
import { PageSkeleton } from "./PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { CircleDot, Plus, Filter, ArrowUpDown, Layers, Check, X, ChevronRight, List, Columns3, User, Search, Star, SlidersHorizontal } from "lucide-react";
import { KanbanBoard, type IssueDisplayProperty } from "./KanbanBoard";
import type { AgentRole, Issue } from "@rudderhq/shared";

/* ── Helpers ── */

const statusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
const priorityOrder = ["critical", "high", "medium", "low"];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ── View state ── */

export type IssueViewState = {
  statuses: string[];
  priorities: string[];
  assignees: string[];
  labels: string[];
  projects: string[];
  displayProperties: IssueDisplayProperty[];
  sortField: "status" | "priority" | "title" | "created" | "updated";
  sortDir: "asc" | "desc";
  groupBy: "status" | "priority" | "assignee" | "project" | "none";
  viewMode: "list" | "board";
  collapsedGroups: string[];
};

const displayPropertyOptions: Array<{ value: IssueDisplayProperty; label: string }> = [
  { value: "identifier", label: "Identifier" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "labels", label: "Labels" },
  { value: "project", label: "Project" },
  { value: "updated", label: "Updated" },
  { value: "created", label: "Created" },
];

const displayPropertyValues = new Set<IssueDisplayProperty>(
  displayPropertyOptions.map((option) => option.value),
);

const defaultDisplayProperties: IssueDisplayProperty[] = ["identifier", "priority", "assignee"];

const defaultViewState: IssueViewState = {
  statuses: [],
  priorities: [],
  assignees: [],
  labels: [],
  projects: [],
  displayProperties: defaultDisplayProperties,
  sortField: "updated",
  sortDir: "desc",
  groupBy: "none",
  viewMode: "list",
  collapsedGroups: [],
};

const quickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  { label: "Active", statuses: ["todo", "in_progress", "in_review", "blocked"] },
  { label: "Backlog", statuses: ["backlog"] },
  { label: "Done", statuses: ["done", "cancelled"] },
];

function getViewState(key: string): IssueViewState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<IssueViewState>;
      return {
        ...defaultViewState,
        ...parsed,
        displayProperties: normalizeDisplayProperties(parsed.displayProperties),
      };
    }
  } catch { /* ignore */ }
  return { ...defaultViewState };
}

function saveViewState(key: string, state: IssueViewState) {
  localStorage.setItem(key, JSON.stringify(state));
}

function normalizeDisplayProperties(value: unknown): IssueDisplayProperty[] {
  if (!Array.isArray(value)) return [...defaultDisplayProperties];
  const seen = new Set<IssueDisplayProperty>();
  const properties: IssueDisplayProperty[] = [];
  for (const item of value) {
    if (!displayPropertyValues.has(item as IssueDisplayProperty)) continue;
    const property = item as IssueDisplayProperty;
    if (seen.has(property)) continue;
    seen.add(property);
    properties.push(property);
  }
  return properties;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function toggleInArray(arr: string[], value: string): string[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

function applyFilters(issues: Issue[], state: IssueViewState, currentUserId?: string | null): Issue[] {
  let result = issues;
  if (state.statuses.length > 0) result = result.filter((i) => state.statuses.includes(i.status));
  if (state.priorities.length > 0) result = result.filter((i) => state.priorities.includes(i.priority));
  if (state.assignees.length > 0) {
    result = result.filter((issue) => {
      for (const assignee of state.assignees) {
        if (assignee === "__unassigned" && !issue.assigneeAgentId && !issue.assigneeUserId) return true;
        if (assignee === "__me" && currentUserId && issue.assigneeUserId === currentUserId) return true;
        if (issue.assigneeAgentId === assignee) return true;
      }
      return false;
    });
  }
  if (state.labels.length > 0) result = result.filter((i) => (i.labelIds ?? []).some((id) => state.labels.includes(id)));
  if (state.projects.length > 0) result = result.filter((i) => i.projectId != null && state.projects.includes(i.projectId));
  return result;
}

function sortIssues(issues: Issue[], state: IssueViewState): Issue[] {
  const sorted = [...issues];
  const dir = state.sortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    switch (state.sortField) {
      case "status":
        return dir * (statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
      case "priority":
        return dir * (priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority));
      case "title":
        return dir * a.title.localeCompare(b.title);
      case "created":
        return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case "updated":
        return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
      default:
        return 0;
    }
  });
  return sorted;
}

function countActiveFilters(state: IssueViewState): number {
  let count = 0;
  if (state.statuses.length > 0) count++;
  if (state.priorities.length > 0) count++;
  if (state.assignees.length > 0) count++;
  if (state.labels.length > 0) count++;
  if (state.projects.length > 0) count++;
  return count;
}

/* ── Component ── */

interface Agent {
  id: string;
  name: string;
  icon?: string | null;
  role: AgentRole;
  title: string | null;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface IssuesListProps {
  issues: Issue[];
  isLoading?: boolean;
  error?: Error | null;
  agents?: Agent[];
  projects?: ProjectOption[];
  liveIssueIds?: Set<string>;
  projectId?: string;
  viewStateKey: string;
  issueLinkState?: unknown;
  initialAssignees?: string[];
  initialSearch?: string;
  initialGroupBy?: IssueViewState["groupBy"];
  toolbarMode?: "full" | "controls-only" | "hidden";
  starredIssueIds?: string[];
  onToggleStarredIssue?: (issueId: string) => void;
  onOpenIssue?: (issue: Issue) => void;
  searchFilters?: {
    participantAgentId?: string;
  };
  onSearchChange?: (search: string) => void;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

export function IssuesList({
  issues,
  isLoading,
  error,
  agents,
  projects,
  liveIssueIds,
  projectId,
  viewStateKey,
  issueLinkState,
  initialAssignees,
  initialSearch,
  initialGroupBy,
  toolbarMode = "full",
  starredIssueIds = [],
  onToggleStarredIssue,
  onOpenIssue,
  searchFilters,
  onSearchChange,
  onUpdateIssue,
}: IssuesListProps) {
  const { selectedOrganizationId } = useOrganization();
  const { openNewIssue } = useDialog();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  // Scope the storage key per organization so folding/view state is independent across organizations.
  const scopedKey = selectedOrganizationId ? `${viewStateKey}:${selectedOrganizationId}` : viewStateKey;

  const getInitialViewState = useCallback((): IssueViewState => {
    const baseState = initialAssignees
      ? { ...defaultViewState, assignees: initialAssignees, statuses: [] }
      : getViewState(scopedKey);
    return initialGroupBy ? { ...baseState, groupBy: initialGroupBy } : baseState;
  }, [initialAssignees, initialGroupBy, scopedKey]);

  const [viewState, setViewState] = useState<IssueViewState>(() => getInitialViewState());
  const [assigneePickerIssueId, setAssigneePickerIssueId] = useState<string | null>(null);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [issueSearch, setIssueSearch] = useState(initialSearch ?? "");
  const [debouncedIssueSearch, setDebouncedIssueSearch] = useState(issueSearch);
  const normalizedIssueSearch = debouncedIssueSearch.trim();

  useEffect(() => {
    setIssueSearch(initialSearch ?? "");
  }, [initialSearch]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedIssueSearch(issueSearch);
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [issueSearch]);

  // Reload view state from localStorage when organization changes (scopedKey changes).
  const prevScopedKey = useRef(scopedKey);
  useEffect(() => {
    if (prevScopedKey.current !== scopedKey) {
      prevScopedKey.current = scopedKey;
      setViewState(getInitialViewState());
    }
  }, [getInitialViewState, scopedKey]);

  const updateView = useCallback((patch: Partial<IssueViewState>) => {
    setViewState((prev) => {
      const next = { ...prev, ...patch };
      saveViewState(scopedKey, next);
      return next;
    });
  }, [scopedKey]);

  const { data: searchedIssues = [] } = useQuery({
    queryKey: [
      ...queryKeys.issues.search(selectedOrganizationId!, normalizedIssueSearch, projectId),
      searchFilters ?? {},
    ],
    queryFn: () => issuesApi.list(selectedOrganizationId!, { q: normalizedIssueSearch, projectId, ...searchFilters }),
    enabled: !!selectedOrganizationId && normalizedIssueSearch.length > 0,
  });

  const agentById = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);
  const agentLabel = useCallback((id: string | null) => {
    if (!id) return null;
    const agent = agentById.get(id);
    return agent ? formatChatAgentLabel(agent) : null;
  }, [agentById]);

  const filtered = useMemo(() => {
    const sourceIssues = normalizedIssueSearch.length > 0 ? searchedIssues : issues;
    const filteredByControls = applyFilters(sourceIssues, viewState, currentUserId);
    return sortIssues(filteredByControls, viewState);
  }, [issues, searchedIssues, viewState, normalizedIssueSearch, currentUserId]);

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(selectedOrganizationId!),
    queryFn: () => issuesApi.listLabels(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const activeFilterCount = countActiveFilters(viewState);
  const selectedProjectName = useMemo(
    () => projects?.find((project) => project.id === projectId)?.name ?? null,
    [projectId, projects],
  );
  const emptyStateMessage = useMemo(() => {
    if (normalizedIssueSearch.length > 0) {
      return `No issues match “${normalizedIssueSearch}”. Try a different search or clear some filters.`;
    }
    if (activeFilterCount > 0) {
      return "No issues match the current filters. Adjust the filters or clear them to see more work.";
    }
    if (selectedProjectName) {
      return `${selectedProjectName} does not have any issues yet. Create the first issue for this project.`;
    }
    return "There are no issues yet. Create one to start tracking work here.";
  }, [activeFilterCount, normalizedIssueSearch, selectedProjectName]);
  const emptyStateAction = normalizedIssueSearch.length === 0 && activeFilterCount === 0
    ? "New Issue"
    : undefined;
  const boardEmptyMessage = useMemo(() => {
    if (selectedProjectName && normalizedIssueSearch.length === 0 && activeFilterCount === 0) {
      return `${selectedProjectName} does not have any issues yet. Use a lane + button to create the first one in the right status.`;
    }
    if (normalizedIssueSearch.length > 0 || activeFilterCount > 0) {
      return "No issues match the current board. Use a lane + button to create a new issue in the right status. Clear search or filters if it does not appear.";
    }
    return "No issues match the current board. Use a lane + button to create a new issue in the right status.";
  }, [activeFilterCount, normalizedIssueSearch, selectedProjectName]);

  const groupedContent = useMemo(() => {
    if (viewState.groupBy === "none") {
      return [{ key: "__all", label: null as string | null, items: filtered }];
    }
    if (viewState.groupBy === "status") {
      const groups = groupBy(filtered, (i) => i.status);
      return statusOrder
        .filter((s) => groups[s]?.length)
        .map((s) => ({ key: s, label: statusLabel(s), items: groups[s]! }));
    }
    if (viewState.groupBy === "priority") {
      const groups = groupBy(filtered, (i) => i.priority);
      return priorityOrder
        .filter((p) => groups[p]?.length)
        .map((p) => ({ key: p, label: statusLabel(p), items: groups[p]! }));
    }
    if (viewState.groupBy === "project") {
      const groups = groupBy(filtered, (issue) => issue.projectId ?? "__no_project");
      const orderedProjectGroups = (projects ?? [])
        .filter((project) => groups[project.id]?.length)
        .map((project) => ({
          key: project.id,
          label: project.name,
          items: groups[project.id]!,
        }));
      if (groups.__no_project?.length) {
        orderedProjectGroups.push({
          key: "__no_project",
          label: "Unscoped",
          items: groups.__no_project,
        });
      }
      return orderedProjectGroups;
    }
    // assignee
    const groups = groupBy(
      filtered,
      (issue) => issue.assigneeAgentId ?? (issue.assigneeUserId ? `__user:${issue.assigneeUserId}` : "__unassigned"),
    );
    return Object.keys(groups).map((key) => ({
      key,
      label:
        key === "__unassigned"
          ? "Unassigned"
            : key.startsWith("__user:")
            ? (formatAssigneeUserLabel(key.slice("__user:".length), currentUserId) ?? "User")
            : (agentLabel(key) ?? key.slice(0, 8)),
      items: groups[key]!,
    }));
  }, [agentLabel, currentUserId, filtered, projects, viewState.groupBy]);

  const contextNewIssueDefaults = useMemo<NewIssueDefaults>(() => {
    const defaults: NewIssueDefaults = {};
    if (projectId) {
      defaults.projectId = projectId;
    } else if (viewState.projects.length === 1) {
      defaults.projectId = viewState.projects[0]!;
    }
    if (viewState.priorities.length === 1) {
      defaults.priority = viewState.priorities[0]!;
    }
    if (viewState.labels.length > 0) {
      defaults.labelIds = [...viewState.labels];
    }
    if (viewState.assignees.length === 1) {
      const assignee = viewState.assignees[0]!;
      if (assignee === "__me" && currentUserId) {
        defaults.assigneeUserId = currentUserId;
      } else if (assignee !== "__unassigned") {
        defaults.assigneeAgentId = assignee;
      }
    }
    return defaults;
  }, [currentUserId, projectId, viewState.assignees, viewState.labels, viewState.priorities, viewState.projects]);

  const newIssueDefaults = (groupKey?: string): NewIssueDefaults => {
    const defaults: NewIssueDefaults = { ...contextNewIssueDefaults };
    if (groupKey) {
      if (viewState.groupBy === "status") defaults.status = groupKey;
      else if (viewState.groupBy === "priority") defaults.priority = groupKey;
      else if (viewState.groupBy === "project" && groupKey !== "__no_project") defaults.projectId = groupKey;
      else if (viewState.groupBy === "assignee" && groupKey !== "__unassigned") {
        if (groupKey.startsWith("__user:")) defaults.assigneeUserId = groupKey.slice("__user:".length);
        else defaults.assigneeAgentId = groupKey;
      }
    }
    return defaults;
  };

  const assignIssue = (issueId: string, assigneeAgentId: string | null, assigneeUserId: string | null = null) => {
    onUpdateIssue(issueId, { assigneeAgentId, assigneeUserId });
    setAssigneePickerIssueId(null);
    setAssigneeSearch("");
  };

  const toggleAssigneePicker = (issueId: string) => {
    setAssigneePickerIssueId((current) => (current === issueId ? null : issueId));
    setAssigneeSearch("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {toolbarMode !== "hidden" && (
      <div
        data-testid="issues-view-toolbar"
        className="surface-panel flex items-center justify-between gap-2 rounded-[calc(var(--radius-sm)+1px)] px-3 py-3 sm:gap-3"
      >
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {toolbarMode === "full" ? (
            <>
              <Button size="sm" variant="outline" onClick={() => openNewIssue(newIssueDefaults())}>
                <Plus className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">New Issue</span>
              </Button>
              <div className="relative w-48 sm:w-64 md:w-80">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={issueSearch}
                  onChange={(e) => {
                    setIssueSearch(e.target.value);
                    onSearchChange?.(e.target.value);
                  }}
                  placeholder="Search issues..."
                  className="pl-7 text-xs sm:text-sm"
                  aria-label="Search issues"
                />
              </div>
            </>
          ) : (
            <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Issue views
            </div>
          )}
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
          <div className="mr-1 flex items-center overflow-hidden rounded-[var(--radius-sm)] border border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-inset)_82%,transparent)]">
            <button
              className={`p-1.5 transition-colors ${viewState.viewMode === "list" ? "bg-[color:var(--surface-active)] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateView({ viewMode: "list" })}
              title="List view"
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              className={`p-1.5 transition-colors ${viewState.viewMode === "board" ? "bg-[color:var(--surface-active)] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateView({ viewMode: "board" })}
              title="Board view"
            >
              <Columns3 className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Filter */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className={`text-xs ${activeFilterCount > 0 ? "text-[color:var(--accent-strong)]" : ""}`}>
                <Filter className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                <span className="hidden sm:inline">{activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}</span>
                {activeFilterCount > 0 && (
                  <span className="sm:hidden text-[10px] font-medium ml-0.5">{activeFilterCount}</span>
                )}
                {activeFilterCount > 0 && (
                  <X
                    className="h-3 w-3 ml-1 hidden sm:block"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateView({ statuses: [], priorities: [], assignees: [], labels: [], projects: [] });
                    }}
                  />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(480px,calc(100vw-2rem))] p-0">
              <div className="p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Filters</span>
                  {activeFilterCount > 0 && (
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => updateView({ statuses: [], priorities: [], assignees: [], labels: [], projects: [] })}
                    >
                      Clear
                    </button>
                  )}
                </div>

                {/* Quick filters */}
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Quick filters</span>
                  <div className="flex flex-wrap gap-1.5">
                    {quickFilterPresets.map((preset) => {
                      const isActive = arraysEqual(viewState.statuses, preset.statuses);
                      return (
                        <button
                          key={preset.label}
                          className={`px-2.5 py-1 text-xs rounded-[calc(var(--radius-sm)-1px)] border transition-colors ${
                            isActive
                              ? "bg-primary text-primary-foreground border-primary"
                              : "border-[color:var(--border-base)] text-muted-foreground hover:text-foreground hover:border-[color:var(--border-strong)]"
                          }`}
                          onClick={() => updateView({ statuses: isActive ? [] : [...preset.statuses] })}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t panel-divider" />

                {/* Multi-column filter sections */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                  {/* Status */}
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Status</span>
                    <div className="space-y-0.5">
                      {statusOrder.map((s) => (
                        <label key={s} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                          <Checkbox
                            checked={viewState.statuses.includes(s)}
                            onCheckedChange={() => updateView({ statuses: toggleInArray(viewState.statuses, s) })}
                          />
                          <StatusIcon status={s} />
                          <span className="text-sm">{statusLabel(s)}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Priority + Assignee stacked in right column */}
                  <div className="space-y-3">
                    {/* Priority */}
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Priority</span>
                      <div className="space-y-0.5">
                        {priorityOrder.map((p) => (
                          <label key={p} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                            <Checkbox
                              checked={viewState.priorities.includes(p)}
                              onCheckedChange={() => updateView({ priorities: toggleInArray(viewState.priorities, p) })}
                            />
                            <PriorityIcon priority={p} />
                            <span className="text-sm">{statusLabel(p)}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Assignee */}
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Assignee</span>
                      <div className="space-y-0.5 max-h-32 overflow-y-auto">
                        <label className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                          <Checkbox
                            checked={viewState.assignees.includes("__unassigned")}
                            onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, "__unassigned") })}
                          />
                          <span className="text-sm">No assignee</span>
                        </label>
                        {currentUserId && (
                          <label className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                            <Checkbox
                              checked={viewState.assignees.includes("__me")}
                              onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, "__me") })}
                            />
                            <User className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-sm">Me</span>
                          </label>
                        )}
                        {(agents ?? []).map((agent) => (
                          <label key={agent.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                            <Checkbox
                              checked={viewState.assignees.includes(agent.id)}
                              onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, agent.id) })}
                            />
                            <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="text-sm">{formatChatAgentLabel(agent)}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {labels && labels.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">Labels</span>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {labels.map((label) => (
                            <label key={label.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                              <Checkbox
                                checked={viewState.labels.includes(label.id)}
                                onCheckedChange={() => updateView({ labels: toggleInArray(viewState.labels, label.id) })}
                              />
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: label.color }} />
                              <span className="text-sm">{label.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {projects && projects.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">Project</span>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {projects.map((project) => (
                            <label key={project.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                              <Checkbox
                                checked={viewState.projects.includes(project.id)}
                                onCheckedChange={() => updateView({ projects: toggleInArray(viewState.projects, project.id) })}
                              />
                              <span className="text-sm">{project.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {viewState.viewMode === "board" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs">
                  <SlidersHorizontal className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Display</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-52 p-0">
                <div className="p-2 space-y-0.5">
                  {displayPropertyOptions.map((option) => (
                    <label
                      key={option.value}
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/50"
                    >
                      <Checkbox
                        checked={viewState.displayProperties.includes(option.value)}
                        onCheckedChange={() => updateView({
                          displayProperties: toggleInArray(
                            viewState.displayProperties,
                            option.value,
                          ) as IssueDisplayProperty[],
                        })}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {/* Sort (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs">
                  <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Sort</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-48 p-0">
                <div className="p-2 space-y-0.5">
                  {([
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["title", "Title"],
                    ["created", "Created"],
                    ["updated", "Updated"],
                  ] as const).map(([field, label]) => (
                    <button
                      key={field}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.sortField === field ? "bg-accent/50 text-foreground" : "hover:bg-accent/50 text-muted-foreground"
                      }`}
                      onClick={() => {
                        if (viewState.sortField === field) {
                          updateView({ sortDir: viewState.sortDir === "asc" ? "desc" : "asc" });
                        } else {
                          updateView({ sortField: field, sortDir: "asc" });
                        }
                      }}
                    >
                      <span>{label}</span>
                      {viewState.sortField === field && (
                        <span className="text-xs text-muted-foreground">
                          {viewState.sortDir === "asc" ? "\u2191" : "\u2193"}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {/* Group (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs">
                  <Layers className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Group</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-0">
                <div className="p-2 space-y-0.5">
                  {([
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["assignee", "Assignee"],
                    ["project", "Project"],
                    ["none", "None"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.groupBy === value ? "bg-accent/50 text-foreground" : "hover:bg-accent/50 text-muted-foreground"
                      }`}
                      onClick={() => updateView({ groupBy: value })}
                    >
                      <span>{label}</span>
                      {viewState.groupBy === value && <Check className="h-3.5 w-3.5" />}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>
      )}

      {isLoading && <PageSkeleton variant="issues-list" />}
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && filtered.length === 0 && viewState.viewMode !== "board" && (
        <div className="flex min-h-[58vh] items-center justify-center">
          <EmptyState
            icon={CircleDot}
            message={emptyStateMessage}
            action={emptyStateAction}
            onAction={emptyStateAction ? () => openNewIssue(newIssueDefaults()) : undefined}
          />
        </div>
      )}

      {!isLoading && viewState.viewMode === "board" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {filtered.length === 0 ? (
            <div className="mb-3 rounded-[calc(var(--radius-sm)+1px)] border border-dashed border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-inset)_82%,transparent)] px-4 py-3 text-sm text-muted-foreground">
              {boardEmptyMessage}
            </div>
          ) : null}
          <KanbanBoard
            issues={filtered}
            agents={agents}
            currentUserId={currentUserId}
            displayProperties={viewState.displayProperties}
            liveIssueIds={liveIssueIds}
            projects={projects}
            onCreateIssue={(status) => openNewIssue({ ...contextNewIssueDefaults, status })}
            onOpenIssue={onOpenIssue}
            onUpdateIssue={onUpdateIssue}
          />
        </div>
      )}

      {!isLoading && filtered.length > 0 && viewState.viewMode !== "board" && (
        groupedContent.map((group) => (
          <Collapsible
            key={group.key}
            open={!viewState.collapsedGroups.includes(group.key)}
            onOpenChange={(open) => {
              updateView({
                collapsedGroups: open
                  ? viewState.collapsedGroups.filter((k) => k !== group.key)
                  : [...viewState.collapsedGroups, group.key],
              });
            }}
          >
            {group.label && (
              <div className="flex items-center py-1.5 pl-1 pr-3">
                <CollapsibleTrigger className="flex items-center gap-1.5">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
                  <span className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    {group.label}
                  </span>
                </CollapsibleTrigger>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto text-muted-foreground"
                  onClick={() => openNewIssue(newIssueDefaults(group.key))}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
            )}
            <CollapsibleContent>
              {group.items.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  issueLinkState={issueLinkState}
                  desktopLeadingSpacer
                  mobileLeading={(
                    <span
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    >
                      <StatusIcon
                        status={issue.status}
                        onChange={(s) => onUpdateIssue(issue.id, { status: s })}
                      />
                    </span>
                  )}
                  desktopMetaLeading={(
                    <>
                      <span
                        className="hidden shrink-0 sm:inline-flex"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                      >
                        <StatusIcon
                          status={issue.status}
                          onChange={(s) => onUpdateIssue(issue.id, { status: s })}
                        />
                      </span>
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {issue.identifier ?? issue.id.slice(0, 8)}
                      </span>
                      {liveIssueIds?.has(issue.id) && (
                        <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-proposal)_80%,transparent)] px-1.5 py-0.5 sm:gap-1.5 sm:px-2">
                          <span className="relative flex h-2 w-2">
                            <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-[color:var(--accent-base)] opacity-75" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--accent-strong)]" />
                          </span>
                          <span className="hidden text-[11px] font-medium text-[color:var(--accent-strong)] sm:inline">
                            Live
                          </span>
                        </span>
                      )}
                    </>
                  )}
                  mobileMeta={timeAgo(issue.updatedAt)}
                  desktopTrailing={(
                    <>
                      {onToggleStarredIssue ? (
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            onToggleStarredIssue(issue.id);
                          }}
                          title={starredIssueIds.includes(issue.id) ? "Unstar issue" : "Star issue"}
                        >
                          <Star
                            className={cn(
                              "h-3.5 w-3.5",
                              starredIssueIds.includes(issue.id) && "fill-current text-amber-500",
                            )}
                          />
                        </button>
                      ) : null}
                      {(issue.labels ?? []).length > 0 && (
                        <span className="hidden items-center gap-1 overflow-hidden md:flex md:max-w-[240px]">
                          {(issue.labels ?? []).slice(0, 3).map((label) => (
                            <IssueLabelChip key={label.id} label={label} />
                          ))}
                          {(issue.labels ?? []).length > 3 && (
                            <span className="text-[10px] text-muted-foreground">
                              +{(issue.labels ?? []).length - 3}
                            </span>
                          )}
                        </span>
                      )}
                      <Popover
                        open={assigneePickerIssueId === issue.id}
                        onOpenChange={(open) => {
                          setAssigneePickerIssueId(open ? issue.id : null);
                          if (!open) setAssigneeSearch("");
                        }}
                      >
                        <PopoverAnchor asChild>
                          <button
                            type="button"
                            className="flex w-[180px] shrink-0 items-center rounded-md px-2 py-1 transition-colors hover:bg-accent/50"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              toggleAssigneePicker(issue.id);
                            }}
                          >
                            {issue.assigneeAgentId && agentById.get(issue.assigneeAgentId) ? (
                              <AssigneeLabel
                                kind="agent"
                                label={formatChatAgentLabel(agentById.get(issue.assigneeAgentId)!)}
                                agentIcon={agentById.get(issue.assigneeAgentId)?.icon}
                              />
                            ) : issue.assigneeUserId ? (
                              <AssigneeLabel
                                kind="user"
                                label={formatAssigneeUserLabel(issue.assigneeUserId, currentUserId) ?? "User"}
                              />
                            ) : (
                              <AssigneeLabel kind="unassigned" label="Assignee" muted />
                            )}
                          </button>
                        </PopoverAnchor>
                        <PopoverContent
                          className="w-56 p-1"
                          align="end"
                          onClick={(e) => e.stopPropagation()}
                          onPointerDownOutside={() => setAssigneeSearch("")}
                        >
                          <input
                            className="mb-1 w-full border-b border-border bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50"
                            placeholder="Search assignees..."
                            value={assigneeSearch}
                            onChange={(e) => setAssigneeSearch(e.target.value)}
                            autoFocus
                          />
                          <div className="max-h-48 overflow-y-auto overscroll-contain">
                            <button
                              className={cn(
                                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                                !issue.assigneeAgentId && !issue.assigneeUserId && "bg-accent",
                              )}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                assignIssue(issue.id, null, null);
                              }}
                            >
                              <AssigneeLabel kind="unassigned" label="No assignee" />
                            </button>
                            {currentUserId && (
                              <button
                                className={cn(
                                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                                  issue.assigneeUserId === currentUserId && "bg-accent",
                                )}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  assignIssue(issue.id, null, currentUserId);
                                }}
                              >
                                <AssigneeLabel kind="user" label="Me" />
                              </button>
                            )}
                            {(agents ?? [])
                              .filter((agent) => {
                                if (!assigneeSearch.trim()) return true;
                                return `${formatChatAgentLabel(agent)} ${agent.name} ${agent.role} ${agent.title ?? ""}`
                                  .toLowerCase()
                                  .includes(assigneeSearch.toLowerCase());
                              })
                              .map((agent) => (
                                <button
                                  key={agent.id}
                                  className={cn(
                                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                                    issue.assigneeAgentId === agent.id && "bg-accent",
                                  )}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    assignIssue(issue.id, agent.id, null);
                                  }}
                                >
                                  <AssigneeLabel
                                    kind="agent"
                                    label={formatChatAgentLabel(agent)}
                                    agentIcon={agent.icon}
                                    className="min-w-0"
                                  />
                                </button>
                              ))}
                          </div>
                        </PopoverContent>
                      </Popover>
                    </>
                  )}
                  trailingMeta={formatDate(issue.createdAt)}
                  onOpen={() => onOpenIssue?.(issue)}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        ))
      )}
    </div>
  );
}
