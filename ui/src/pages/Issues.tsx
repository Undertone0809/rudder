import { useEffect, useMemo, useCallback, useRef, useState, type ReactElement } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Agent, Project, ReorderIssue } from "@rudderhq/shared";
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
import { formatPriorityLabel } from "../lib/priorities";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { LinearIssueSourceBoard } from "../components/LinearIssueSourceBoard";
import { MarkdownBody } from "../components/MarkdownBody";
import { PriorityBarsIcon } from "../components/PriorityIcon";
import { CircleDot, Clock3, FolderKanban, PencilLine, Trash2, UserRound } from "lucide-react";
import { useIssueFollows } from "@/hooks/useIssueFollows";

type DraftMetadataItem = {
  key: string;
  icon: ReactElement;
  label: string;
};

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

const DRAFT_ISSUE_DELETE_EXIT_MS = 220;

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

function DraftDescriptionPreview({ description }: { description: string }) {
  if (!description) {
    return (
      <p className="mt-5 text-sm leading-6 text-muted-foreground">
        Add description...
      </p>
    );
  }

  return (
    <div data-testid="issue-draft-description-preview" className="mt-5 max-h-[4.5rem] w-full min-w-0 overflow-hidden">
      <MarkdownBody className="text-sm leading-6 text-muted-foreground [&_blockquote]:my-0 [&_h1]:my-0 [&_h1]:text-sm [&_h1]:leading-6 [&_h2]:my-0 [&_h2]:text-sm [&_h2]:leading-6 [&_h3]:my-0 [&_h3]:text-sm [&_h3]:leading-6 [&_img]:my-0 [&_img]:max-h-[4.5rem] [&_img]:w-full [&_img]:rounded-[calc(var(--radius-sm)-2px)] [&_img]:object-cover [&_ol]:my-0 [&_p]:my-0 [&_pre]:my-0 [&_ul]:my-0">
        {description}
      </MarkdownBody>
    </div>
  );
}

function DraftIssuesView({
  drafts,
  agents,
  projects,
  currentUserId,
  deletingDraftIds,
  onOpenDraft,
  onDeleteDraft,
}: {
  drafts: IssueDraftSummary[];
  agents?: Agent[];
  projects?: Project[];
  currentUserId?: string | null;
  deletingDraftIds?: Set<string>;
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
          const isDeleting = deletingDraftIds?.has(draft.id) ?? false;
          const projectName = resolveDraftProjectName(draft, projects);
          const assigneeLabel = resolveDraftAssigneeLabel(draft, agents, currentUserId);
          const metadataItems = [
            draft.status
              ? { key: "status", icon: <CircleDot className="h-3 w-3 shrink-0" />, label: formatDraftMetadataValue(draft.status) }
              : null,
            draft.priority
              ? {
                  key: "priority",
                  icon: <PriorityBarsIcon priority={draft.priority} className="h-3.5 w-4 shrink-0" />,
                  label: formatPriorityLabel(draft.priority),
                }
              : null,
            projectName ? { key: "project", icon: <FolderKanban className="h-3 w-3 shrink-0" />, label: projectName } : null,
            assigneeLabel ? { key: "assignee", icon: <UserRound className="h-3 w-3 shrink-0" />, label: assigneeLabel } : null,
            { key: "updated", icon: <Clock3 className="h-3 w-3 shrink-0" />, label: relativeTime(draft.updatedAt) },
          ].filter((item): item is DraftMetadataItem => Boolean(item));

          return (
            <article
              key={draft.id}
              data-testid="issue-draft-card"
              data-deleting={isDeleting ? "true" : undefined}
              aria-busy={isDeleting ? "true" : undefined}
              className="motion-draft-issue-card group relative min-h-36 rounded-[var(--radius-sm)] border border-[color:var(--border-soft)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_88%,transparent)] hover:border-[color:var(--border-strong)] hover:bg-[color:var(--surface-elevated)]"
            >
              <button
                type="button"
                disabled={isDeleting}
                aria-label={`Open draft ${draft.title}`}
                className="absolute inset-0 z-10 rounded-[var(--radius-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onClick={() => onOpenDraft(draft)}
              />
              <div className="pointer-events-none flex h-full min-h-36 w-full flex-col items-start px-4 py-3 text-left">
                <div className="flex w-full min-w-0 items-start gap-2 pr-9">
                  <PencilLine className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-foreground">{draft.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {metadataItems.map((item) => {
                        return (
                          <span key={`${draft.id}-${item.key}`} className="inline-flex min-w-0 items-center gap-1">
                            {item.icon}
                            <span className="max-w-[11rem] truncate">{item.label}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <DraftDescriptionPreview description={draft.description} />
              </div>
              <button
                type="button"
                data-testid="issue-draft-delete-button"
                disabled={isDeleting}
                aria-label={`Delete draft ${draft.title}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onDeleteDraft(draft);
                }}
                className="absolute right-3 top-3 z-20 inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground opacity-100 transition-colors hover:bg-[color:color-mix(in_oklab,var(--destructive)_16%,transparent)] hover:text-destructive"
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
  const { selectedOrganizationId, selectedOrganization } = useOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { openNewIssue, confirm } = useDialog();
  const { pushToast } = useToast();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const initialSearch = searchParams.get("q") ?? "";
  const issueSource = searchParams.get("source") ?? "";
  const issueScope = searchParams.get("scope") ?? "";
  const effectiveIssueScope = issueScope === "recent" ? "" : issueScope;
  const isDraftScope = effectiveIssueScope === "drafts";
  const isLinearSource = issueSource === "linear" && !isDraftScope;
  const linearTeamId = searchParams.get("linearTeamId") ?? undefined;
  const linearProjectId = searchParams.get("linearProjectId") ?? undefined;
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

  useEffect(() => {
    if (!searchParams.has("view") || typeof window === "undefined") return;

    const params = new URLSearchParams(location.search);
    params.delete("view");
    const search = params.toString();
    const nextUrl = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, [location.hash, location.pathname, location.search, searchParams]);

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
  const [deletingDraftIds, setDeletingDraftIds] = useState<Set<string>>(() => new Set());
  const deletingDraftIdsRef = useRef<Set<string>>(new Set());
  const { followedIssueIds, toggleFollowIssue } = useIssueFollows(selectedOrganizationId);

  const setDraftDeleting = useCallback((draftId: string, isDeleting: boolean) => {
    const nextDeletingDraftIds = new Set(deletingDraftIdsRef.current);
    if (isDeleting) {
      nextDeletingDraftIds.add(draftId);
    } else {
      nextDeletingDraftIds.delete(draftId);
    }
    deletingDraftIdsRef.current = nextDeletingDraftIds;
    setDeletingDraftIds(nextDeletingDraftIds);
  }, []);

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
    setBreadcrumbs([{ label: isDraftScope ? "Draft Issues" : isLinearSource ? "Linear Issues" : "Issue Tracker" }]);
  }, [isDraftScope, isLinearSource, setBreadcrumbs]);

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
    if (!selectedOrganizationId || participantAgentId || isDraftScope || isLinearSource) return;
    rememberIssueNavigation(selectedOrganizationId, {
      scope: effectiveIssueScope || undefined,
      projectId,
    });
  }, [effectiveIssueScope, isDraftScope, isLinearSource, participantAgentId, projectId, selectedOrganizationId]);

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
    enabled: !!selectedOrganizationId && !isDraftScope && !isLinearSource,
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

  const reorderIssue = useMutation({
    mutationFn: (data: ReorderIssue) =>
      issuesApi.reorder(selectedOrganizationId!, data),
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
        deletingDraftIds={deletingDraftIds}
        onOpenDraft={(draft) => {
          openNewIssue({ draftId: draft.id });
        }}
        onDeleteDraft={async (draft) => {
          const confirmed = await confirm({
            title: `Delete draft issue "${draft.title}"?`,
            description: "This cannot be undone.",
            confirmLabel: "Delete",
            tone: "destructive",
          });
          if (!confirmed) return;
          if (deletingDraftIdsRef.current.has(draft.id)) return;
          setDraftDeleting(draft.id, true);

          const completeDeletion = () => {
            deleteIssueDraft(draft.id);
            setDraftDeleting(draft.id, false);
            pushToast({ title: "Draft issue deleted", tone: "success" });
          };

          if (prefersReducedMotion()) {
            completeDeletion();
            return;
          }

          window.setTimeout(completeDeletion, DRAFT_ISSUE_DELETE_EXIT_MS);
        }}
      />
    );
  }

  if (isLinearSource) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <LinearIssueSourceBoard
          orgId={selectedOrganizationId}
          orgName={selectedOrganization?.name}
          projects={projects}
          linearTeamId={linearTeamId}
          linearProjectId={linearProjectId}
          initialSearch={initialSearch}
        />
      </div>
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
        onReorderIssue={(data) => reorderIssue.mutate(data)}
        searchFilters={participantAgentId ? { participantAgentId } : undefined}
      />
    </div>
  );
}
