import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "@/lib/router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Import, List, Columns3, Check, ArrowUpDown, Filter, FolderKanban, UserRound } from "lucide-react";
import { pluginsApi, type PluginUiContribution } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/context/ToastContext";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { StatusIcon } from "@/components/StatusIcon";
import type { Issue, Project } from "@rudderhq/shared";

const LINEAR_PLUGIN_KEY = "rudder.linear";
const DATA_KEY_PAGE_BOOTSTRAP = "page-bootstrap";
const DATA_KEY_CATALOG = "linear-catalog";
const DATA_KEY_ISSUES = "linear-issues";
const ACTION_KEY_IMPORT_ISSUES = "import-linear-issues";
const LINEAR_PAGE_SIZE = 50;

type IssueStatus = Issue["status"];

const boardStatuses: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

const laneSurfaceClasses: Record<IssueStatus, string> = {
  backlog: "border-[color:color-mix(in_oklab,var(--border-soft)_88%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-inset)_88%,transparent)]",
  todo: "border-blue-200/75 bg-blue-50/70 dark:border-blue-900/55 dark:bg-blue-950/24",
  in_progress: "border-amber-200/75 bg-amber-50/70 dark:border-amber-900/55 dark:bg-amber-950/24",
  in_review: "border-violet-200/75 bg-violet-50/70 dark:border-violet-900/55 dark:bg-violet-950/24",
  blocked: "border-red-200/75 bg-red-50/70 dark:border-red-900/55 dark:bg-red-950/24",
  done: "border-emerald-200/75 bg-emerald-50/70 dark:border-emerald-900/55 dark:bg-emerald-950/24",
  cancelled: "border-neutral-200/75 bg-neutral-50/70 dark:border-neutral-800/60 dark:bg-neutral-900/26",
};

type LinearStateSummary = {
  id: string;
  name: string;
  type?: string | null;
};

type LinearTeamSummary = {
  id: string;
  key?: string;
  name: string;
  states: LinearStateSummary[];
};

type LinearProjectSummary = {
  id: string;
  name: string;
  teamIds?: string[];
  teams?: Array<Pick<LinearTeamSummary, "id" | "key" | "name">>;
};

type LinearUserSummary = {
  id: string;
  name: string;
  email?: string | null;
};

type LinearIssueRow = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  createdAt?: string | null;
  team: LinearTeamSummary;
  state: LinearStateSummary;
  project: LinearProjectSummary | null;
  assignee: LinearUserSummary | null;
  imported: boolean;
  importedRudderIssueId: string | null;
  importedRudderIssueIdentifier: string | null;
  importedOrgId: string | null;
};

type LinearCatalogData = {
  orgId: string;
  teams: LinearTeamSummary[];
  projects: LinearProjectSummary[];
  users: LinearUserSummary[];
};

type LinearTeamMapping = {
  teamId: string;
  teamName?: string;
  stateMappings: Array<{
    linearStateId: string;
    linearStateName?: string;
    rudderStatus: IssueStatus;
  }>;
};

type PageBootstrapData = {
  configured: boolean;
  message: string | null;
  projects: Array<Pick<Project, "id" | "name">>;
  teamMappings: LinearTeamMapping[];
};

type LinearIssuesData = {
  rows: LinearIssueRow[];
  endCursor: string | null;
  hasNextPage: boolean;
  totalShown: number;
};

type ImportLinearIssuesActionResult = {
  importedCount: number;
  duplicateCount: number;
  fallbackCount: number;
  adjustedCount: number;
};

type LinearIssueSourceBoardProps = {
  orgId: string;
  orgName?: string;
  projects?: Array<Pick<Project, "id" | "name" | "archivedAt">>;
  linearTeamId?: string;
  linearProjectId?: string;
  initialSearch?: string;
};

type LinearViewMode = "list" | "board";
type LinearSortField = "updated" | "created" | "identifier";
type LinearSortDir = "asc" | "desc";

function resolveLinearContribution(contributions: PluginUiContribution[] | undefined): PluginUiContribution | null {
  return contributions?.find((entry) => entry.pluginKey === LINEAR_PLUGIN_KEY) ?? null;
}

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function summarizeImportResult(result: ImportLinearIssuesActionResult): string {
  const parts = [`Imported ${result.importedCount}`];
  if (result.duplicateCount > 0) parts.push(`${result.duplicateCount} duplicate`);
  if (result.fallbackCount > 0) parts.push(`${result.fallbackCount} fallback`);
  if (result.adjustedCount > 0) parts.push(`${result.adjustedCount} adjusted`);
  return parts.join(" / ");
}

function selectClassName(className?: string): string {
  return cn(
    "h-9 min-w-0 rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] px-2.5 text-sm text-foreground outline-none transition-[border-color,box-shadow] focus:border-ring focus:ring-[3px] focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
    className,
  );
}

function getStoredViewMode(): LinearViewMode {
  if (typeof window === "undefined") return "board";
  const value = window.localStorage.getItem("rudder:linear-source-view-mode");
  return value === "list" || value === "board" ? value : "board";
}

function resolveMappedStatus(row: LinearIssueRow, teamMappings: LinearTeamMapping[] | undefined): IssueStatus {
  const teamMapping = teamMappings?.find((mapping) => mapping.teamId === row.team.id);
  return teamMapping?.stateMappings.find((mapping) => mapping.linearStateId === row.state.id)?.rudderStatus ?? "backlog";
}

function compareNullableIso(left: string | null | undefined, right: string | null | undefined): number {
  const leftValue = left ? Date.parse(left) : 0;
  const rightValue = right ? Date.parse(right) : 0;
  return leftValue - rightValue;
}

function issueRudderHref(row: LinearIssueRow): string | null {
  const ref = row.importedRudderIssueIdentifier ?? row.importedRudderIssueId;
  return ref ? `/issues/${ref}` : null;
}

function ToolbarField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function ImportedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-[calc(var(--radius-sm)-2px)] border border-emerald-300/60 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/28 dark:text-emerald-300">
      <Check className="h-3 w-3" />
      Imported
    </span>
  );
}

function LinearIssueMeta({ row }: { row: LinearIssueRow }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-1">
        <StatusIcon status={resolveLinearTypeStatus(row.state.type)} />
        <span className="truncate">{row.state.name}</span>
      </span>
      <span className="inline-flex min-w-0 items-center gap-1">
        <FolderKanban className="h-3 w-3 shrink-0" />
        <span className="truncate">{row.project?.name ?? "No Linear project"}</span>
      </span>
      <span className="inline-flex min-w-0 items-center gap-1">
        <UserRound className="h-3 w-3 shrink-0" />
        <span className="truncate">{row.assignee?.name ?? "Unassigned"}</span>
      </span>
      <span>Updated {timeAgo(row.updatedAt)}</span>
    </div>
  );
}

function resolveLinearTypeStatus(type: string | null | undefined): IssueStatus {
  if (type === "started") return "in_progress";
  if (type === "completed") return "done";
  if (type === "canceled") return "cancelled";
  if (type === "backlog") return "backlog";
  return "todo";
}

function LinearImportedAction({
  row,
  orgId,
}: {
  row: LinearIssueRow;
  orgId: string;
}) {
  if (!row.imported) return null;

  const href = issueRudderHref(row);
  const sameOrgLink = !row.importedOrgId || row.importedOrgId === orgId;
  if (href && sameOrgLink) {
    return (
      <Button asChild variant="ghost" size="sm">
        <Link to={href}>Open issue</Link>
      </Button>
    );
  }

  return <span className="text-xs text-muted-foreground">Imported elsewhere</span>;
}

function LinearListView({
  rows,
  selectedIssueIds,
  orgId,
  importing,
  onToggleSelected,
}: {
  rows: LinearIssueRow[];
  selectedIssueIds: string[];
  orgId: string;
  importing: boolean;
  onToggleSelected: (issueId: string) => void;
}) {
  return (
    <div className="min-h-0 overflow-hidden rounded-[calc(var(--radius-sm)+1px)] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)]">
      {rows.map((row) => {
        const checked = selectedIssueIds.includes(row.id);
        return (
          <article
            key={row.id}
            data-testid={`linear-source-row-${row.id}`}
            className="grid min-h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-[color:var(--border-soft)] px-3 py-3 last:border-b-0"
          >
            <input
              type="checkbox"
              data-testid={`linear-source-row-checkbox-${row.id}`}
              className="h-4 w-4 rounded border-[color:var(--border-base)]"
              checked={checked}
              disabled={row.imported || importing}
              aria-label={`Select ${row.identifier}`}
              onChange={() => onToggleSelected(row.id)}
            />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 truncate text-sm font-medium text-foreground no-underline hover:underline"
                >
                  <span className="font-mono text-xs text-muted-foreground">{row.identifier}</span>
                  {" "}
                  {row.title}
                </a>
                {row.imported ? <ImportedBadge /> : null}
              </div>
              <LinearIssueMeta row={row} />
            </div>
            <div className="flex shrink-0 items-center">
              <LinearImportedAction row={row} orgId={orgId} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function LinearHiddenBoardStatus({
  status,
  issueCount,
}: {
  status: IssueStatus;
  issueCount: number;
}) {
  return (
    <div
      data-testid={`linear-source-hidden-column-${status}`}
      className={cn(
        "flex items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] border px-2 py-2",
        laneSurfaceClasses[status],
      )}
    >
      <StatusIcon status={status} />
      <span className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {statusLabel(status)}
      </span>
      <span className="text-xs text-muted-foreground/60 tabular-nums">
        {issueCount}
      </span>
    </div>
  );
}

function LinearBoardView({
  rows,
  teamMappings,
  selectedIssueIds,
  orgId,
  importing,
  onToggleSelected,
}: {
  rows: LinearIssueRow[];
  teamMappings: LinearTeamMapping[] | undefined;
  selectedIssueIds: string[];
  orgId: string;
  importing: boolean;
  onToggleSelected: (issueId: string) => void;
}) {
  const grouped = useMemo(() => {
    const next = new Map<IssueStatus, LinearIssueRow[]>();
    for (const status of boardStatuses) next.set(status, []);
    for (const row of rows) {
      const status = resolveMappedStatus(row, teamMappings);
      next.get(status)?.push(row);
    }
    return next;
  }, [rows, teamMappings]);

  const visibleStatuses = boardStatuses.filter((status) => (grouped.get(status)?.length ?? 0) > 0);
  const hiddenStatuses = boardStatuses.filter((status) => (grouped.get(status)?.length ?? 0) === 0);

  return (
    <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-x-auto overflow-y-hidden pb-3">
      <div className="flex h-full min-h-full min-w-max items-stretch gap-3 pr-2">
        {visibleStatuses.map((status) => {
          const laneRows = grouped.get(status) ?? [];
          return (
            <section key={status} className="flex h-full min-h-0 w-[272px] min-w-[272px] shrink-0 flex-col">
              <div className="mb-1 flex items-center gap-2 px-2 py-2">
                <StatusIcon status={status} />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {statusLabel(status)}
                </span>
                <span className="ml-auto text-xs text-muted-foreground/60 tabular-nums">
                  {laneRows.length}
                </span>
              </div>
              <div
                data-testid={`linear-source-kanban-column-${status}`}
                className={cn(
                  "scrollbar-auto-hide flex-1 space-y-1.5 overflow-y-auto rounded-[calc(var(--radius-sm)-1px)] border p-1.5",
                  laneSurfaceClasses[status],
                )}
              >
                {laneRows.map((row) => (
                  <article
                    key={row.id}
                    data-testid={`linear-source-board-card-${row.id}`}
                    className="overflow-hidden rounded-[calc(var(--radius-sm)-1px)] border bg-card p-2.5"
                  >
                    <div className="mb-1.5 flex min-w-0 items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 rounded border-[color:var(--border-base)]"
                        checked={selectedIssueIds.includes(row.id)}
                        disabled={row.imported || importing}
                        aria-label={`Select ${row.identifier}`}
                        onChange={() => onToggleSelected(row.id)}
                      />
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground no-underline hover:underline"
                      >
                        {row.identifier}
                      </a>
                      {row.imported ? <ImportedBadge /> : null}
                    </div>
                    <p className="mb-2 line-clamp-2 text-sm leading-snug">{row.title}</p>
                    <div className="space-y-1.5 text-xs text-muted-foreground">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <StatusIcon status={resolveLinearTypeStatus(row.state.type)} />
                        <span className="truncate">{row.state.name}</span>
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <FolderKanban className="h-3 w-3 shrink-0" />
                        <span className="truncate">{row.project?.name ?? "No Linear project"}</span>
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <UserRound className="h-3 w-3 shrink-0" />
                        <span className="truncate">{row.assignee?.name ?? "Unassigned"}</span>
                      </span>
                      <span>Updated {timeAgo(row.updatedAt)}</span>
                    </div>
                    {row.imported ? (
                      <div className="mt-3 flex justify-end">
                        <LinearImportedAction row={row} orgId={orgId} />
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
        {hiddenStatuses.length > 0 ? (
          <div
            data-testid="linear-source-hidden-columns"
            className="flex h-full min-h-0 w-[228px] min-w-[228px] shrink-0 flex-col rounded-[calc(var(--radius-sm)+1px)] border border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-inset)_78%,transparent)] p-2"
          >
            <div className="mb-2 flex items-center gap-2 px-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Hidden columns
              </span>
              <span className="ml-auto text-xs text-muted-foreground/60 tabular-nums">
                {hiddenStatuses.length}
              </span>
            </div>
            <div className="space-y-2">
              {hiddenStatuses.map((status) => (
                <LinearHiddenBoardStatus
                  key={status}
                  status={status}
                  issueCount={grouped.get(status)?.length ?? 0}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function LinearIssueSourceBoard({
  orgId,
  orgName,
  projects,
  linearTeamId = "",
  linearProjectId = "",
  initialSearch = "",
}: LinearIssueSourceBoardProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [viewMode, setViewMode] = useState<LinearViewMode>(() => getStoredViewMode());
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [pendingImportMode, setPendingImportMode] = useState<"selected" | "allMatching">("selected");
  const [importTargetProjectId, setImportTargetProjectId] = useState("");
  const [stateId, setStateId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [sortField, setSortField] = useState<LinearSortField>("updated");
  const [sortDir, setSortDir] = useState<LinearSortDir>("desc");
  const [search, setSearch] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);
  const [selectedIssueIds, setSelectedIssueIds] = useState<string[]>([]);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const orgDisplayName = orgName?.trim() || "this organization";

  useEffect(() => {
    setSearch(initialSearch);
    setDebouncedSearch(initialSearch);
  }, [initialSearch]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    setSelectedIssueIds([]);
  }, [linearTeamId, linearProjectId, stateId, assigneeId, debouncedSearch]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("rudder:linear-source-view-mode", viewMode);
    }
  }, [viewMode]);

  const { data: contributions, isLoading: contributionsLoading } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
  });
  const contribution = useMemo(() => resolveLinearContribution(contributions), [contributions]);
  const pluginId = contribution?.pluginId ?? "";

  const { data: bootstrap, isLoading: bootstrapLoading, error: bootstrapError } = useQuery({
    queryKey: ["plugins", LINEAR_PLUGIN_KEY, DATA_KEY_PAGE_BOOTSTRAP, orgId, pluginId] as const,
    queryFn: async () => {
      const response = await pluginsApi.bridgeGetData(pluginId, DATA_KEY_PAGE_BOOTSTRAP, { orgId }, orgId);
      return response.data as PageBootstrapData;
    },
    enabled: !!orgId && !!pluginId,
  });

  const { data: catalog, isLoading: catalogLoading } = useQuery({
    queryKey: ["plugins", LINEAR_PLUGIN_KEY, DATA_KEY_CATALOG, orgId, pluginId] as const,
    queryFn: async () => {
      const response = await pluginsApi.bridgeGetData(pluginId, DATA_KEY_CATALOG, { orgId }, orgId);
      return response.data as LinearCatalogData;
    },
    enabled: !!orgId && !!pluginId && bootstrap?.configured !== false,
  });

  const issuesQueryKey = [
    "plugins",
    LINEAR_PLUGIN_KEY,
    DATA_KEY_ISSUES,
    orgId,
    pluginId,
    linearTeamId || "__all__",
    linearProjectId || "__all__",
    stateId || "__all__",
    assigneeId || "__all__",
    debouncedSearch || "__none__",
  ] as const;

  const {
    data: issuePages,
    isLoading: issuesLoading,
    error: issuesError,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: issuesQueryKey,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const after = typeof pageParam === "string" && pageParam ? pageParam : undefined;
      const response = await pluginsApi.bridgeGetData(
        pluginId,
        DATA_KEY_ISSUES,
        {
          orgId,
          limit: LINEAR_PAGE_SIZE,
          after,
          teamId: linearTeamId || undefined,
          projectId: linearProjectId || undefined,
          stateId: stateId || undefined,
          assigneeId: assigneeId || undefined,
          query: debouncedSearch || undefined,
        },
        orgId,
      );
      return response.data as LinearIssuesData;
    },
    getNextPageParam: (lastPage) => lastPage.hasNextPage && lastPage.endCursor ? lastPage.endCursor : undefined,
    enabled: !!orgId && !!pluginId && bootstrap?.configured === true,
  });

  const importMutation = useMutation({
    mutationFn: async ({ mode, issueIds }: { mode: "selected" | "allMatching"; issueIds?: string[] }) => {
      if (!importTargetProjectId) throw new Error(`Choose a project in ${orgDisplayName} before importing.`);
      const response = await pluginsApi.bridgePerformAction(
        pluginId,
        ACTION_KEY_IMPORT_ISSUES,
        {
          orgId,
          targetProjectId: importTargetProjectId,
          mode,
          issueIds,
          filters: {
            teamId: linearTeamId || undefined,
            stateId: stateId || undefined,
            projectId: linearProjectId || undefined,
            assigneeId: assigneeId || undefined,
            query: debouncedSearch || undefined,
          },
        },
        orgId,
      );
      return response.data as ImportLinearIssuesActionResult;
    },
    onSuccess: async (result) => {
      pushToast({
        title: "Linear import complete",
        body: summarizeImportResult(result),
        tone: "success",
      });
      setSelectedIssueIds([]);
      setImportDialogOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["plugins", LINEAR_PLUGIN_KEY, DATA_KEY_ISSUES, orgId] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(orgId) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Linear import failed",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const rows = useMemo(() => {
    const sourceRows = [...(issuePages?.pages.flatMap((page) => page.rows) ?? [])];
    sourceRows.sort((left, right) => {
      let delta = 0;
      if (sortField === "updated") delta = compareNullableIso(left.updatedAt, right.updatedAt);
      else if (sortField === "created") delta = compareNullableIso(left.createdAt, right.createdAt);
      else delta = left.identifier.localeCompare(right.identifier);
      return sortDir === "asc" ? delta : -delta;
    });
    return sourceRows;
  }, [issuePages?.pages, sortDir, sortField]);

  useEffect(() => {
    const visibleIds = new Set(rows.map((row) => row.id));
    setSelectedIssueIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [rows]);

  const team = useMemo(
    () => catalog?.teams.find((candidate) => candidate.id === linearTeamId) ?? null,
    [catalog?.teams, linearTeamId],
  );
  const linearProject = useMemo(
    () => catalog?.projects.find((candidate) => candidate.id === linearProjectId) ?? null,
    [catalog?.projects, linearProjectId],
  );
  const sourceLabel = linearProject
    ? `${linearProject.name}${team ? ` / ${team.name}` : ""}`
    : team?.name ?? "All Linear teams";
  const targetProjects = useMemo(() => {
    const source = bootstrap?.projects?.length ? bootstrap.projects : (projects ?? []);
    return source.filter((project) => !("archivedAt" in project) || !project.archivedAt);
  }, [bootstrap?.projects, projects]);
  useEffect(() => {
    if (targetProjects.length === 0) {
      if (importTargetProjectId) setImportTargetProjectId("");
      return;
    }
    if (targetProjects.some((project) => project.id === importTargetProjectId)) return;
    setImportTargetProjectId(targetProjects.length === 1 ? targetProjects[0]!.id : "");
  }, [importTargetProjectId, targetProjects]);
  const stateOptions = useMemo(() => {
    const sourceTeams = linearTeamId
      ? (catalog?.teams ?? []).filter((candidate) => candidate.id === linearTeamId)
      : catalog?.teams ?? [];
    const deduped = new Map<string, string>();
    for (const sourceTeam of sourceTeams) {
      for (const state of sourceTeam.states ?? []) {
        deduped.set(state.id, state.name);
      }
    }
    return [...deduped.entries()].map(([id, name]) => ({ id, name }));
  }, [catalog?.teams, linearTeamId]);
  const importedCount = rows.filter((row) => row.imported).length;
  const selectableRows = rows.filter((row) => !row.imported);
  const importing = importMutation.isPending;
  const loading = contributionsLoading || bootstrapLoading || catalogLoading || issuesLoading;
  const error = bootstrapError ?? issuesError;
  const selectedImportCount = selectedIssueIds.length;
  const selectedTargetProject = targetProjects.find((project) => project.id === importTargetProjectId) ?? null;
  const totalLoaded = rows.length;
  const activeFilterCount = Number(Boolean(stateId)) + Number(Boolean(assigneeId));
  const selectedStateLabel = stateOptions.find((state) => state.id === stateId)?.name ?? "All states";
  const selectedAssigneeLabel = catalog?.users.find((user) => user.id === assigneeId)?.name ?? "Anyone";

  const toggleSelected = useCallback((issueId: string) => {
    setSelectedIssueIds((current) =>
      current.includes(issueId) ? current.filter((id) => id !== issueId) : [...current, issueId],
    );
  }, []);

  const openImportDialog = useCallback((mode: "selected" | "allMatching") => {
    setPendingImportMode(mode);
    setImportDialogOpen(true);
  }, []);

  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !hasNextPage || loading || importing || isFetchingNextPage) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (!visible || !hasNextPage || isFetchingNextPage || importing) return;
      void fetchNextPage();
    }, { root: null, rootMargin: "280px 0px" });

    observer.observe(node);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, importing, isFetchingNextPage, loading, totalLoaded]);

  if (!contributionsLoading && !contribution) {
    return (
      <div className="flex min-h-[58vh] items-center justify-center" data-testid="linear-source-board">
        <EmptyState icon={ExternalLink} message="Linear is not installed or ready." />
      </div>
    );
  }

  if (!bootstrapLoading && bootstrap?.configured === false) {
    return (
      <div className="flex h-full min-h-0 flex-col px-1" data-testid="linear-source-board">
        <div className="rounded-[calc(var(--radius-sm)+1px)] border border-dashed border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-inset)_82%,transparent)] px-4 py-4 text-sm text-muted-foreground">
          <div className="font-medium text-foreground">Linear is not configured for this organization.</div>
          <div className="mt-1">{bootstrap.message ?? "Connect Linear and choose teams in plugin settings."}</div>
          <Button asChild variant="outline" size="sm" className="mt-3">
            <Link to="/instance/settings/plugins">Open plugin settings</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="linear-source-board" className="flex h-full min-h-0 flex-col gap-4">
      <div
        data-testid="linear-source-toolbar"
        className="surface-panel flex items-center justify-between gap-2 rounded-[calc(var(--radius-sm)+1px)] px-3 py-3 sm:gap-3"
      >
        <div className="flex min-w-0 items-baseline gap-3">
          <div className="truncate text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            {sourceLabel}
          </div>
          <div className="hidden min-w-0 items-center gap-2 text-xs text-muted-foreground md:flex">
            <span>{totalLoaded} loaded</span>
            {importedCount > 0 ? <span>{importedCount} imported</span> : null}
            {hasNextPage ? <span>Loads as you scroll</span> : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          <div className="flex items-center overflow-hidden rounded-[var(--radius-sm)] border border-[color:var(--border-base)] bg-[color:color-mix(in_oklab,var(--surface-inset)_82%,transparent)]">
            <button
              className={cn(
                "p-1.5 transition-colors",
                viewMode === "list" ? "bg-[color:var(--surface-active)] text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setViewMode("list")}
              title="List view"
              data-testid="linear-source-view-list"
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              className={cn(
                "p-1.5 transition-colors",
                viewMode === "board" ? "bg-[color:var(--surface-active)] text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setViewMode("board")}
              title="Board view"
              data-testid="linear-source-view-board"
            >
              <Columns3 className="h-3.5 w-3.5" />
            </button>
          </div>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className={cn("text-xs", activeFilterCount > 0 && "text-[color:var(--accent-strong)]")}>
                <Filter className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                <span className="hidden sm:inline">{activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-3">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Filters</span>
                  {activeFilterCount > 0 ? (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setStateId("");
                        setAssigneeId("");
                      }}
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
                <ToolbarField label="State">
                  <select
                    className={selectClassName("h-8 w-full")}
                    value={stateId}
                    aria-label="Filter by Linear state"
                    onChange={(event) => setStateId(event.target.value)}
                  >
                    <option value="">All states</option>
                    {stateOptions.map((state) => (
                      <option key={state.id} value={state.id}>{state.name}</option>
                    ))}
                  </select>
                </ToolbarField>
                <ToolbarField label="Assignee">
                  <select
                    className={selectClassName("h-8 w-full")}
                    value={assigneeId}
                    aria-label="Filter by Linear assignee"
                    onChange={(event) => setAssigneeId(event.target.value)}
                  >
                    <option value="">Anyone</option>
                    {(catalog?.users ?? []).map((user) => (
                      <option key={user.id} value={user.id}>{user.name}</option>
                    ))}
                  </select>
                </ToolbarField>
                <div className="rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] px-2.5 py-2 text-xs text-muted-foreground">
                  {selectedStateLabel} / {selectedAssigneeLabel}
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="text-xs">
                <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                <span className="hidden sm:inline">Sort</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-3">
              <div className="space-y-3">
                <ToolbarField label="Sort by">
                  <select
                    className={selectClassName("h-8 w-full")}
                    value={sortField}
                    aria-label="Sort Linear issues"
                    onChange={(event) => setSortField(event.target.value as LinearSortField)}
                  >
                    <option value="updated">Updated</option>
                    <option value="created">Created</option>
                    <option value="identifier">Identifier</option>
                  </select>
                </ToolbarField>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-full justify-start"
                  title={`Sort ${sortDir === "asc" ? "ascending" : "descending"}`}
                  onClick={() => setSortDir((current) => (current === "asc" ? "desc" : "asc"))}
                >
                  <ArrowUpDown className="h-3.5 w-3.5" />
                  <span>{sortDir === "asc" ? "Ascending" : "Descending"}</span>
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <div className="surface-panel flex flex-col gap-3 rounded-[calc(var(--radius-sm)+1px)] px-3 py-2.5 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={selectableRows.length === 0 || importing}
            onClick={() => setSelectedIssueIds(selectableRows.map((row) => row.id))}
          >
            <Filter className="h-3.5 w-3.5" />
            Select loaded
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={selectedIssueIds.length === 0 || importing}
            onClick={() => setSelectedIssueIds([])}
          >
            Clear
          </Button>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-muted-foreground">{selectedImportCount} selected</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="linear-source-import-selected"
            disabled={selectedImportCount === 0 || importing}
            onClick={() => openImportDialog("selected")}
          >
            <Import className="h-3.5 w-3.5" />
            Import selected
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={totalLoaded === 0 || importing}
            onClick={() => openImportDialog("allMatching")}
          >
            Import matching
          </Button>
        </div>
      </div>

      {loading ? <PageSkeleton variant="issues-list" /> : null}
      {error ? <p className="text-sm text-destructive">{error instanceof Error ? error.message : String(error)}</p> : null}

      {!loading && !error && rows.length === 0 ? (
        <div className="flex min-h-[48vh] items-center justify-center">
          <EmptyState icon={ExternalLink} message="No Linear issues match this source." />
        </div>
      ) : null}

      {!loading && !error && rows.length > 0 && viewMode === "list" ? (
        <LinearListView
          rows={rows}
          selectedIssueIds={selectedIssueIds}
          orgId={orgId}
          importing={importing}
          onToggleSelected={toggleSelected}
        />
      ) : null}

      {!loading && !error && rows.length > 0 && viewMode === "board" ? (
        <LinearBoardView
          rows={rows}
          teamMappings={bootstrap?.teamMappings}
          selectedIssueIds={selectedIssueIds}
          orgId={orgId}
          importing={importing}
          onToggleSelected={toggleSelected}
        />
      ) : null}

      {!loading && !error && rows.length > 0 ? (
        <div
          ref={loadMoreRef}
          data-testid="linear-source-load-more-sentinel"
          className="flex min-h-8 items-center justify-between gap-3 text-xs text-muted-foreground"
        >
          <span>
            Loaded {totalLoaded} issue{totalLoaded === 1 ? "" : "s"}
            {isFetchingNextPage ? " - loading more" : hasNextPage ? " - more load as you scroll" : " - all matching issues loaded"}
          </span>
        </div>
      ) : null}

      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pendingImportMode === "selected" ? "Import selected Linear issues" : "Import matching Linear issues"}
            </DialogTitle>
            <DialogDescription>
              Choose the project in {orgDisplayName} where these issues should land.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Project in {orgDisplayName}</span>
              <select
                data-testid="linear-source-import-project"
                className={selectClassName("w-full")}
                value={importTargetProjectId}
                aria-label={`Project in ${orgDisplayName}`}
                onChange={(event) => setImportTargetProjectId(event.target.value)}
              >
                <option value="">Choose a project in {orgDisplayName}</option>
                {targetProjects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            <div className="rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] px-3 py-2 text-xs text-muted-foreground">
              {pendingImportMode === "selected"
                ? `${selectedImportCount} selected Linear issue${selectedImportCount === 1 ? "" : "s"}`
                : `All matching Linear issues from ${sourceLabel}`}
              {selectedTargetProject ? ` -> ${selectedTargetProject.name}` : ""}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setImportDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="linear-source-confirm-import"
              disabled={!importTargetProjectId || importing || (pendingImportMode === "selected" && selectedImportCount === 0)}
              onClick={() => {
                importMutation.mutate({
                  mode: pendingImportMode,
                  issueIds: pendingImportMode === "selected" ? selectedIssueIds : undefined,
                });
              }}
            >
              <Import className="h-3.5 w-3.5" />
              {importing ? "Importing" : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
