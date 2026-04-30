import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, Project } from "@rudderhq/shared";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useOrganization } from "../context/OrganizationContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { rememberIssueNavigation } from "../lib/issue-navigation";
import { getIssueScopeFilters, isFollowingIssue } from "../lib/issue-scope-filters";
import { readRecentIssueIds, recordRecentIssue } from "../lib/recent-issues";
import { formatAssigneeUserLabel, parseAssigneeValue } from "../lib/assignees";
import {
  deleteIssueDraft,
  ISSUE_DRAFT_CHANGED_EVENT,
  type IssueDraftSummary,
  summarizeIssueDrafts,
} from "../lib/new-issue-dialog";
import { relativeTime } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { CircleDot, Clock3, Flag, FolderKanban, PencilLine, Trash2, UserRound } from "lucide-react";
import { useIssueFollows } from "@/hooks/useIssueFollows";

function formatDraftMetadataValue(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function resolveDraftProjectName(draft: IssueDraftSummary, projects: Project[] | undefined) {
  if (!draft.projectId) return null;
  return projects?.find((project) => project.id === draft.projectId)?.name ?? null;
}

function resolveDraftAssigneeLabel(
  draft: IssueDraftSummary,
  agents: Agent[] | undefined,
  currentUserId: string | null | undefined,
) {
  const assignee = parseAssigneeValue(draft.assigneeValue || draft.assigneeId || "");
  if (assignee.assigneeAgentId) {
    return agents?.find((agent) => agent.id === assignee.assigneeAgentId)?.name ?? null;
  }
  if (assignee.assigneeUserId) {
    return formatAssigneeUserLabel(assignee.assigneeUserId, currentUserId);
  }
  return null;
}

function DraftIssuesView({
  drafts,
  agents,
  projects,
  currentUserId,
  onOpenDraft,
  onDeleteDraft,
}: {
  drafts: IssueDraftSummary[];
  agents?: Agent[];
  projects?: Project[];
  currentUserId?: string | null;
  onOpenDraft: (draft: IssueDraftSummary) => void;
  onDeleteDraft: (draft: IssueDraftSummary) => void;
}) {
  if (drafts.length === 0) {
    return (
      <div data-testid="issue-drafts-view" className="flex h-full min-h-0 flex-col">
        <EmptyState icon={PencilLine} message="No draft issues." />
      </div>
    );
  }

  return (
    <div data-testid="issue-drafts-view" className="flex h-full min-h-0 flex-col overflow-y-auto px-6 py-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-foreground">Draft Issues</h1>
          <p className="mt-1 text-sm text-muted-foreground">{drafts.length} saved draft{drafts.length === 1 ? "" : "s"}</p>
        </div>
      </div>

      <section aria-label="Draft issues" className="grid max-w-5xl grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {drafts.map((draft) => {
          const projectName = resolveDraftProjectName(draft, projects);
          const assigneeLabel = resolveDraftAssigneeLabel(draft, agents, currentUserId);
          const metadataItems = [
            draft.status ? { icon: CircleDot, label: formatDraftMetadataValue(draft.status) } : null,
            draft.priority ? { icon: Flag, label: formatDraftMetadataValue(draft.priority) } : null,
            projectName ? { icon: FolderKanban, label: projectName } : null,
            assigneeLabel ? { icon: UserRound, label: assigneeLabel } : null,
            { icon: Clock3, label: relativeTime(draft.updatedAt) },
          ].filter((item): item is { icon: typeof CircleDot; label: string } => Boolean(item));

          return (
            <article
              key={draft.id}
              data-testid="issue-draft-card"
              className="group relative min-h-36 rounded-[var(--radius-sm)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_88%,transparent)] transition-[background-color,border-color] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--surface-elevated)]"
            >
              <button
                type="button"
                className="flex h-full min-h-36 w-full flex-col items-start px-4 py-3 text-left"
                onClick={() => onOpenDraft(draft)}
              >
                <div className="flex w-full min-w-0 items-start gap-2 pr-9">
                  <PencilLine className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-foreground">{draft.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {metadataItems.map((item) => {
                        const Icon = item.icon;
                        return (
                          <span key={`${draft.id}-${item.label}`} className="inline-flex min-w-0 items-center gap-1">
                            <Icon className="h-3 w-3 shrink-0" />
                            <span className="max-w-[11rem] truncate">{item.label}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <p className="mt-5 line-clamp-3 text-sm leading-6 text-muted-foreground">
                  {draft.description || "Add description..."}
                </p>
              </button>
              <button
                type="button"
                data-testid="issue-draft-delete-button"
                aria-label={`Delete draft ${draft.title}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDeleteDraft(draft);
                }}
                className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground opacity-100 transition-colors hover:bg-[color:color-mix(in_oklab,var(--destructive)_16%,transparent)] hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </article>
          );
        })}
      </section>
    </div>
  );
}

export function Issues() {
  const { selectedOrganizationId } = useOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue } = useDialog();
  const { pushToast } = useToast();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const initialSearch = searchParams.get("q") ?? "";
  const issueScope = searchParams.get("scope") ?? "";
  const effectiveIssueScope = issueScope === "recent" ? "" : issueScope;
  const isDraftScope = effectiveIssueScope === "drafts";
  const projectId = searchParams.get("projectId") ?? undefined;
  const participantAgentId = searchParams.get("participantAgentId") ?? undefined;
  const requestedGroupBy = searchParams.get("groupBy");
  const initialGroupBy = requestedGroupBy === "status"
    || requestedGroupBy === "priority"
    || requestedGroupBy === "assignee"
    || requestedGroupBy === "project"
    || requestedGroupBy === "none"
    ? requestedGroupBy
    : undefined;
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleSearchChange = useCallback((search: string) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const trimmedSearch = search.trim();
      const currentSearch = new URLSearchParams(window.location.search).get("q") ?? "";
      if (currentSearch === trimmedSearch) return;

      const url = new URL(window.location.href);
      if (trimmedSearch) {
        url.searchParams.set("q", trimmedSearch);
      } else {
        url.searchParams.delete("q");
      }

      const nextUrl = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState(window.history.state, "", nextUrl);
    }, 300);
  }, []);

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  useEffect(() => {
    if (issueScope !== "recent" || typeof window === "undefined") return;

    const params = new URLSearchParams(location.search);
    params.delete("scope");
    const search = params.toString();
    const nextUrl = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [issueScope, location.hash, location.pathname, location.search]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const [issueDraftSummaries, setIssueDraftSummaries] = useState<IssueDraftSummary[]>(() =>
    summarizeIssueDrafts(selectedOrganizationId),
  );
  const { followedIssueIds, toggleFollowIssue } = useIssueFollows(selectedOrganizationId);

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId!),
    queryFn: () => projectsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedOrganizationId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Issues",
        `${location.pathname}${location.search}${location.hash}`,
      ),
    [location.pathname, location.search, location.hash],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: isDraftScope ? "Draft Issues" : "Issue Tracker" }]);
  }, [isDraftScope, setBreadcrumbs]);

  useEffect(() => {
    const refreshIssueDraftSummaries = () => {
      setIssueDraftSummaries(summarizeIssueDrafts(selectedOrganizationId));
    };
    refreshIssueDraftSummaries();
    if (typeof window === "undefined") return;
    window.addEventListener(ISSUE_DRAFT_CHANGED_EVENT, refreshIssueDraftSummaries);
    window.addEventListener("storage", refreshIssueDraftSummaries);
    return () => {
      window.removeEventListener(ISSUE_DRAFT_CHANGED_EVENT, refreshIssueDraftSummaries);
      window.removeEventListener("storage", refreshIssueDraftSummaries);
    };
  }, [selectedOrganizationId]);

  useEffect(() => {
    if (!selectedOrganizationId || participantAgentId || isDraftScope) return;
    rememberIssueNavigation(selectedOrganizationId, {
      scope: effectiveIssueScope || undefined,
      projectId,
    });
  }, [effectiveIssueScope, isDraftScope, participantAgentId, projectId, selectedOrganizationId]);

  const issueFilters = useMemo(
    () => getIssueScopeFilters(effectiveIssueScope, currentUserId),
    [currentUserId, effectiveIssueScope],
  );

  const { data: issues, isLoading, error } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedOrganizationId!),
      "participant-agent",
      participantAgentId ?? "__all__",
      "scope",
      effectiveIssueScope || "__default__",
      "user",
      currentUserId ?? "__none__",
      "project",
      projectId ?? "__all__",
    ],
    queryFn: () => issuesApi.list(selectedOrganizationId!, { participantAgentId, projectId, ...issueFilters }),
    enabled: !!selectedOrganizationId && !isDraftScope,
  });
  const visibleIssues = useMemo(() => {
    const allIssues = issues ?? [];
    if (effectiveIssueScope === "starred") {
      return allIssues.filter((issue) => followedIssueIds.has(issue.id));
    }
    if (effectiveIssueScope === "following" && currentUserId) {
      return allIssues.filter((issue) => isFollowingIssue(issue, currentUserId));
    }
    return allIssues;
  }, [currentUserId, effectiveIssueScope, followedIssueIds, issues]);

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedOrganizationId!) });
    },
  });

  if (!selectedOrganizationId) {
    return <EmptyState icon={CircleDot} message="Select a organization to view issues." />;
  }

  if (isDraftScope) {
    return (
      <DraftIssuesView
        drafts={issueDraftSummaries}
        agents={agents}
        projects={projects}
        currentUserId={currentUserId}
        onOpenDraft={(draft) => {
          openNewIssue({ draftId: draft.id });
        }}
        onDeleteDraft={(draft) => {
          const confirmed = window.confirm(`Delete draft issue "${draft.title}"? This cannot be undone.`);
          if (!confirmed) return;
          deleteIssueDraft(draft.id);
          pushToast({ title: "Draft issue deleted", tone: "success" });
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <IssuesList
        issues={visibleIssues}
        isLoading={isLoading}
        error={error as Error | null}
        agents={agents}
        projects={projects}
        liveIssueIds={liveIssueIds}
        projectId={projectId}
        viewStateKey="rudder:issues-view"
        issueLinkState={issueLinkState}
        initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
        initialSearch={initialSearch}
        initialGroupBy={initialGroupBy}
        toolbarMode="controls-only"
        starredIssueIds={[...followedIssueIds]}
        onToggleStarredIssue={(issueId) => {
          void toggleFollowIssue(issueId);
        }}
        onOpenIssue={(issue) => {
          if (!selectedOrganizationId) return;
          recordRecentIssue(selectedOrganizationId, issue.id, readRecentIssueIds(selectedOrganizationId));
        }}
        onSearchChange={handleSearchChange}
        onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
        searchFilters={participantAgentId ? { participantAgentId } : undefined}
      />
    </div>
  );
}
