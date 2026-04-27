import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useOrganization } from "../context/OrganizationContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { rememberIssueNavigation } from "../lib/issue-navigation";
import { getIssueScopeFilters, isFollowingIssue } from "../lib/issue-scope-filters";
import { readRecentIssueIds, recordRecentIssue, resolveRecentIssues } from "../lib/recent-issues";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { CircleDot } from "lucide-react";
import { useIssueFollows } from "@/hooks/useIssueFollows";

export function Issues() {
  const { selectedOrganizationId } = useOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const initialSearch = searchParams.get("q") ?? "";
  const issueScope = searchParams.get("scope") ?? "";
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
  const [recentIssueIds, setRecentIssueIds] = useState<string[]>(() =>
    readRecentIssueIds(selectedOrganizationId),
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
    setBreadcrumbs([{ label: "Issue Tracker" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setRecentIssueIds(readRecentIssueIds(selectedOrganizationId));
  }, [location.key, selectedOrganizationId]);

  useEffect(() => {
    if (!selectedOrganizationId || participantAgentId) return;
    rememberIssueNavigation(selectedOrganizationId, {
      scope: issueScope || undefined,
      projectId,
    });
  }, [issueScope, participantAgentId, projectId, selectedOrganizationId]);

  const issueFilters = useMemo(
    () => getIssueScopeFilters(issueScope, currentUserId),
    [currentUserId, issueScope],
  );

  const { data: issues, isLoading, error } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedOrganizationId!),
      "participant-agent",
      participantAgentId ?? "__all__",
      "scope",
      issueScope || "__default__",
      "user",
      currentUserId ?? "__none__",
      "project",
      projectId ?? "__all__",
    ],
    queryFn: () => issuesApi.list(selectedOrganizationId!, { participantAgentId, projectId, ...issueFilters }),
    enabled: !!selectedOrganizationId,
  });
  const visibleIssues = useMemo(() => {
    const allIssues = issues ?? [];
    if (issueScope === "starred") {
      return allIssues.filter((issue) => followedIssueIds.has(issue.id));
    }
    if (issueScope === "recent") {
      return resolveRecentIssues(recentIssueIds, allIssues);
    }
    if (issueScope === "following" && currentUserId) {
      return allIssues.filter((issue) => isFollowingIssue(issue, currentUserId));
    }
    return allIssues;
  }, [currentUserId, followedIssueIds, issues, issueScope, recentIssueIds]);

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
          setRecentIssueIds(recordRecentIssue(selectedOrganizationId, issue.id, recentIssueIds));
        }}
        onSearchChange={handleSearchChange}
        onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
        searchFilters={participantAgentId ? { participantAgentId } : undefined}
      />
    </div>
  );
}
