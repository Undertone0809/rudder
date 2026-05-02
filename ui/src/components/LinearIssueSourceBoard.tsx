import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Import, List, Search, Columns3, Check, ArrowUpDown, Filter, FolderKanban, UserRound } from "lucide-react";
import { pluginsApi, type PluginUiContribution } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { useToast } from "@/context/ToastContext";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  projects?: Array<Pick<Project, "id" | "name" | "archivedAt">>;
  linearTeamId?: string;
  linearProjectId?: string;
  initialSearch?: string;
  onSearchChange?: (search: string) => void;
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

function SourceBadge({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[calc(var(--radius-sm)-2px)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      <ExternalLink className="h-3 w-3" />
      {children}
    </span>
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

function LinearRowAction({
  row,
  orgId,
  targetProjectId,
  importing,
  onImport,
}: {
  row: LinearIssueRow;
  orgId: string;
  targetProjectId: string;
  importing: boolean;
  onImport: (row: LinearIssueRow) => void;
}) {
  if (row.imported) {
    const href = issueRudderHref(row);
    const sameOrgLink = !row.importedOrgId || row.importedOrgId === orgId;
    if (href && sameOrgLink) {
      return (
        <Button asChild variant="ghost" size="sm">
          <Link to={href}>Open Rudder issue</Link>
        </Button>
      );
    }
    return <span className="text-xs text-muted-foreground">Imported elsewhere</span>;
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!targetProjectId || importing}
      onClick={() => onImport(row)}
    >
      <Import className="h-3.5 w-3.5" />
      Import
    </Button>
  );
}

function LinearListView({
  rows,
  selectedIssueIds,
  orgId,
  targetProjectId,
  importing,
  onToggleSelected,
  onImport,
}: {
  rows: LinearIssueRow[];
  selectedIssueIds: string[];
  orgId: string;
  targetProjectId: string;
  importing: boolean;
  onToggleSelected: (issueId: string) => void;
  onImport: (row: LinearIssueRow) => void;
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
                <SourceBadge>External</SourceBadge>
                {row.imported ? <ImportedBadge /> : null}
              </div>
              <LinearIssueMeta row={row} />
            </div>
            <div className="flex shrink-0 items-center">
              <LinearRowAction
                row={row}
                orgId={orgId}
                targetProjectId={targetProjectId}
                importing={importing}
                onImport={onImport}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function LinearBoardView({
  rows,
  teamMappings,
  selectedIssueIds,
  orgId,
  targetProjectId,
  importing,
  onToggleSelected,
  onImport,
}: {
  rows: LinearIssueRow[];
  teamMappings: LinearTeamMapping[] | undefined;
  selectedIssueIds: string[];
  orgId: string;
  targetProjectId: string;
  importing: boolean;
  onToggleSelected: (issueId: string) => void;
  onImport: (row: LinearIssueRow) => void;
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

  return (
    <div className="scrollbar-auto-hide min-h-0 flex-1 overflow-x-auto overflow-y-hidden pb-3">
      <div className="flex h-full min-h-[440px] min-w-max items-stretch gap-3 pr-2">
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
                      {row.imported ? <ImportedBadge /> : <SourceBadge>External</SourceBadge>}
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
                    <div className="mt-3 flex justify-end">
                      <LinearRowAction
                        row={row}
                        orgId={orgId}
                        targetProjectId={targetProjectId}
                        importing={importing}
                        onImport={onImport}
                      />
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function LinearIssueSourceBoard({
  orgId,
  projects,
  linearTeamId = "",
  linearProjectId = "",
  initialSearch = "",
  onSearchChange,
}: LinearIssueSourceBoardProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [viewMode, setViewMode] = useState<LinearViewMode>(() => getStoredViewMode());
  const [targetProjectId, setTargetProjectId] = useState("");
  const [stateId, setStateId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [sortField, setSortField] = useState<LinearSortField>("updated");
  const [sortDir, setSortDir] = useState<LinearSortDir>("desc");
  const [search, setSearch] = useState(initialSearch);
  const [debouncedSearch, setDebouncedSearch] = useState(initialSearch);
  const [afterCursor, setAfterCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [selectedIssueIds, setSelectedIssueIds] = useState<string[]>([]);

  useEffect(() => {
    setSearch(initialSearch);
    setDebouncedSearch(initialSearch);
  }, [initialSearch]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [search]);

  useEffect(() => {
    setAfterCursor(null);
    setCursorHistory([]);
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
    afterCursor ?? "__first__",
  ] as const;

  const { data: issueData, isLoading: issuesLoading, error: issuesError } = useQuery({
    queryKey: issuesQueryKey,
    queryFn: async () => {
      const response = await pluginsApi.bridgeGetData(
        pluginId,
        DATA_KEY_ISSUES,
        {
          orgId,
          limit: LINEAR_PAGE_SIZE,
          after: afterCursor ?? undefined,
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
    enabled: !!orgId && !!pluginId && bootstrap?.configured === true,
  });

  const importMutation = useMutation({
    mutationFn: async ({ mode, issueIds }: { mode: "single" | "selected" | "allMatching"; issueIds?: string[] }) => {
      if (!targetProjectId) throw new Error("Choose a target Rudder project before importing.");
      const response = await pluginsApi.bridgePerformAction(
        pluginId,
        ACTION_KEY_IMPORT_ISSUES,
        {
          orgId,
          targetProjectId,
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
    const sourceRows = [...(issueData?.rows ?? [])];
    sourceRows.sort((left, right) => {
      let delta = 0;
      if (sortField === "updated") delta = compareNullableIso(left.updatedAt, right.updatedAt);
      else if (sortField === "created") delta = compareNullableIso(left.createdAt, right.createdAt);
      else delta = left.identifier.localeCompare(right.identifier);
      return sortDir === "asc" ? delta : -delta;
    });
    return sourceRows;
  }, [issueData?.rows, sortDir, sortField]);

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

  const toggleSelected = useCallback((issueId: string) => {
    setSelectedIssueIds((current) =>
      current.includes(issueId) ? current.filter((id) => id !== issueId) : [...current, issueId],
    );
  }, []);

  const importRow = useCallback((row: LinearIssueRow) => {
    importMutation.mutate({ mode: "single", issueIds: [row.id] });
  }, [importMutation]);

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
      <div className="surface-panel flex flex-col gap-3 rounded-[calc(var(--radius-sm)+1px)] px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="shrink-0 text-base font-semibold text-foreground">Linear Issues</h1>
            <SourceBadge>External</SourceBadge>
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="truncate">{sourceLabel}</span>
            <span>{rows.length} shown</span>
            {importedCount > 0 ? <span>{importedCount} imported</span> : null}
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="relative w-full min-w-44 sm:w-64">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                onSearchChange?.(event.target.value);
              }}
              placeholder="Search Linear issues..."
              className="pl-7 text-xs sm:text-sm"
              aria-label="Search Linear issues"
            />
          </div>
          <select
            className={selectClassName("w-40")}
            value={stateId}
            aria-label="Filter by Linear state"
            onChange={(event) => setStateId(event.target.value)}
          >
            <option value="">All states</option>
            {stateOptions.map((state) => (
              <option key={state.id} value={state.id}>{state.name}</option>
            ))}
          </select>
          <select
            className={selectClassName("w-40")}
            value={assigneeId}
            aria-label="Filter by Linear assignee"
            onChange={(event) => setAssigneeId(event.target.value)}
          >
            <option value="">Anyone</option>
            {(catalog?.users ?? []).map((user) => (
              <option key={user.id} value={user.id}>{user.name}</option>
            ))}
          </select>
          <select
            className={selectClassName("w-36")}
            value={sortField}
            aria-label="Sort Linear issues"
            onChange={(event) => setSortField(event.target.value as LinearSortField)}
          >
            <option value="updated">Updated</option>
            <option value="created">Created</option>
            <option value="identifier">Identifier</option>
          </select>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title={`Sort ${sortDir === "asc" ? "ascending" : "descending"}`}
            onClick={() => setSortDir((current) => (current === "asc" ? "desc" : "asc"))}
          >
            <ArrowUpDown className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{sortDir === "asc" ? "Asc" : "Desc"}</span>
          </Button>
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
        </div>
      </div>

      <div className="surface-panel flex flex-col gap-3 rounded-[calc(var(--radius-sm)+1px)] px-3 py-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <select
            data-testid="linear-source-target-project"
            className={selectClassName("w-60 max-w-full")}
            value={targetProjectId}
            aria-label="Target Rudder project"
            onChange={(event) => setTargetProjectId(event.target.value)}
          >
            <option value="">Choose target Rudder project</option>
            {targetProjects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={selectableRows.length === 0 || importing}
            onClick={() => setSelectedIssueIds(selectableRows.map((row) => row.id))}
          >
            <Filter className="h-3.5 w-3.5" />
            Select page
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
          <span className="text-xs text-muted-foreground">{selectedIssueIds.length} selected</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="linear-source-import-selected"
            disabled={!targetProjectId || selectedIssueIds.length === 0 || importing}
            onClick={() => importMutation.mutate({ mode: "selected", issueIds: selectedIssueIds })}
          >
            <Import className="h-3.5 w-3.5" />
            Import selected
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!targetProjectId || importing}
            onClick={() => importMutation.mutate({ mode: "allMatching" })}
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
          targetProjectId={targetProjectId}
          importing={importing}
          onToggleSelected={toggleSelected}
          onImport={importRow}
        />
      ) : null}

      {!loading && !error && rows.length > 0 && viewMode === "board" ? (
        <LinearBoardView
          rows={rows}
          teamMappings={bootstrap?.teamMappings}
          selectedIssueIds={selectedIssueIds}
          orgId={orgId}
          targetProjectId={targetProjectId}
          importing={importing}
          onToggleSelected={toggleSelected}
          onImport={importRow}
        />
      ) : null}

      {!loading && !error && rows.length > 0 ? (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>Showing {issueData?.totalShown ?? rows.length} issue(s).</span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={cursorHistory.length === 0 || importing}
              onClick={() => {
                setCursorHistory((current) => {
                  const nextHistory = [...current];
                  const previousCursor = nextHistory.pop() ?? null;
                  setAfterCursor(previousCursor);
                  return nextHistory;
                });
              }}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!issueData?.hasNextPage || importing}
              onClick={() => {
                if (!issueData?.endCursor) return;
                setCursorHistory((current) => [...current, afterCursor ?? ""]);
                setAfterCursor(issueData.endCursor);
              }}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
