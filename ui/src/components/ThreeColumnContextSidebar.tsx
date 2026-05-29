import { type CSSProperties, type ReactNode, type RefCallback, useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Boxes,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Clock3,
  Copy,
  DollarSign,
  Eye,
  EyeOff,
  FolderTree,
  History,
  MessageSquare,
  MoreHorizontal,
  Network,
  PanelLeftClose,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Target,
  UserRound,
} from "lucide-react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { cn, agentUrl, issueUrl, projectRouteRef } from "@/lib/utils";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { useOrganization } from "@/context/OrganizationContext";
import { useSidebar } from "@/context/SidebarContext";
import { useToast } from "@/context/ToastContext";
import { useDialog } from "@/context/DialogContext";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { issuesApi } from "@/api/issues";
import { authApi } from "@/api/auth";
import { projectsApi } from "@/api/projects";
import { agentsApi } from "@/api/agents";
import { calendarApi } from "@/api/calendar";
import { chatsApi } from "@/api/chats";
import { heartbeatsApi } from "@/api/heartbeats";
import { displayChatTitle } from "@/lib/chat-title";
import { pluginsApi, type PluginUiContribution } from "@/api/plugins";
import { formatSidebarAgentLabel } from "@/lib/agent-labels";
import { projectColorAccent, projectColorBackgroundStyle } from "@/lib/project-colors";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";
import {
  RECENT_ISSUES_CHANGED_EVENT,
  readRecentIssueIds,
  recordRecentIssue,
  resolveRecentIssues,
} from "@/lib/recent-issues";
import { isFollowingIssue } from "@/lib/issue-scope-filters";
import {
  ISSUE_DRAFT_CHANGED_EVENT,
  summarizeIssueDrafts,
} from "@/lib/new-issue-dialog";
import { useIssueFollows } from "@/hooks/useIssueFollows";
import { AgentIcon } from "@/components/AgentIconPicker";
import { AgentActionsMenu } from "@/components/AgentActionsMenu";
import { DashboardCalendarSwitcher } from "@/components/DashboardCalendarSwitcher";
import { MessengerContextSidebar } from "@/components/MessengerContextSidebar";
import { StatusIcon } from "@/components/StatusIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExactTimestampTooltip } from "@/components/HoverTimestamp";
import { Checkbox } from "@/components/ui/checkbox";
import { CALENDAR_EVENT_STATUS_OPTIONS, useCalendarWorkspace } from "@/context/CalendarWorkspaceContext";
import { buildChatMentionHref, type Agent, type CalendarEventStatus, type CalendarSource, type Issue } from "@rudderhq/shared";
import { RECENT_ISSUES_COLLAPSED_LIMIT, LINEAR_PLUGIN_KEY, LINEAR_CATALOG_DATA_KEY, LINEAR_PLUGIN_ROUTE_PATH, SidebarIssue, LinearSidebarItem, LinearSidebarCatalog, resolveLinearPageContribution, linearIssueSourceHref, SectionLabel, ContextColumnHeader, resolveContextColumnHeader, calendarStatusLabel, CALENDAR_LAYER_COLORS, CALENDAR_WEEKDAY_LABELS, calendarStartOfDay, calendarAddDays, calendarDateKey, calendarStartOfMonthGrid, calendarMonthTitle, calendarHeatClass, setStringSetValue, CalendarMiniMonth, VisibilityLayerRow, activeConversationIdFromPath, ContextItem, activeContextStyle, SlidingContextNav, SidebarLiveCount, ProjectListSection, SidebarIssueListSection } from "./ThreeColumnContextSidebar.parts";

function escapeChatMarkdownLinkLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

function chatReferenceMarkdown(conversation: { id: string; title: string; summary?: string | null; latestReplyPreview?: string | null }) {
  const label = escapeChatMarkdownLinkLabel(displayChatTitle(conversation).trim() || "Chat");
  return `[${label}](${buildChatMentionHref(conversation.id)})`;
}

export function ThreeColumnContextSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const relativePath = toOrganizationRelativePath(location.pathname);
  const contextHeader = useMemo(() => resolveContextColumnHeader(relativePath), [relativePath]);
  const isMessengerRoute = /^\/messenger(?:\/|$)/.test(relativePath);
  const isCalendarRoute = /^\/(?:dashboard\/calendar|calendar)(?:\/|$)/.test(relativePath);
  const isLinearPluginRoute = /^\/linear(?:\/|$)/.test(relativePath);
  const isIssuesRoute = /^\/issues(?:\/|$)/.test(relativePath) || isLinearPluginRoute;
  const isOrgWorkspaceRoute = /^\/(?:org|projects|resources|heartbeats|workspaces|goals|skills|costs|activity)(?:\/|$)/.test(relativePath);
  const isChatRoute = /^\/chat(?:\/|$)/.test(relativePath);
  const isAgentRoute = !isMessengerRoute && !isIssuesRoute && !isCalendarRoute && !isOrgWorkspaceRoute && !isChatRoute;
  const { selectedOrganizationId } = useOrganization();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { pushToast } = useToast();
  const { openNewAgent, openNewProject } = useDialog();
  const queryClient = useQueryClient();
  const [collapsedIssueSections, setCollapsedIssueSections] = useState<Record<string, boolean>>({});
  const isIssueSectionCollapsed = useCallback(
    (key: string) => collapsedIssueSections[key] === true,
    [collapsedIssueSections],
  );
  const toggleIssueSection = useCallback((key: string) => {
    setCollapsedIssueSections((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }, []);
  const calendarSidebarScrollRef = useScrollbarActivityRef("rudder:sidebar-scroll:calendar");
  const issueSidebarScrollRef = useScrollbarActivityRef("rudder:sidebar-scroll:issues");
  const workspaceProjectsScrollRef = useScrollbarActivityRef("rudder:sidebar-scroll:workspace-projects");
  const chatSidebarScrollRef = useScrollbarActivityRef("rudder:sidebar-scroll:chat");
  const agentSidebarScrollRef = useScrollbarActivityRef("rudder:sidebar-scroll:agents");
  const {
    cursor,
    setCursor,
    hiddenAgentIds,
    setHiddenAgentIds,
    hiddenSourceIds,
    setHiddenSourceIds,
    myCalendarVisible,
    setMyCalendarVisible,
    visibleStatuses,
    setVisibleStatuses,
    setGoogleCalendarModalOpen,
  } = useCalendarWorkspace();

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => projectsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const { data: chats } = useQuery({
    queryKey: queryKeys.chats.list(selectedOrganizationId ?? "__none__", "active"),
    queryFn: () => chatsApi.list(selectedOrganizationId!, "active"),
    enabled: !!selectedOrganizationId,
  });
  const { data: calendarSources } = useQuery({
    queryKey: queryKeys.calendar.sources(selectedOrganizationId ?? "__none__"),
    queryFn: () => calendarApi.sources(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && isCalendarRoute,
  });
  const updateCalendarSourceMutation = useMutation({
    mutationFn: ({ sourceId, status }: { sourceId: string; status: CalendarSource["status"] }) =>
      calendarApi.updateSource(selectedOrganizationId!, sourceId, { status }),
    onSuccess: async () => {
      if (!selectedOrganizationId) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.calendar.sources(selectedOrganizationId) }),
        queryClient.invalidateQueries({ queryKey: ["calendar", selectedOrganizationId] }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update calendar source",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedOrganizationId ?? "__none__"),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && (isAgentRoute || isIssuesRoute),
    refetchInterval: 10_000,
  });
  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => issuesApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && isIssuesRoute,
  });
  const { follows: issueFollows } = useIssueFollows(
    selectedOrganizationId && isIssuesRoute ? selectedOrganizationId : null,
  );
  const { data: pluginContributions } = useQuery({
    queryKey: queryKeys.plugins.uiContributions,
    queryFn: () => pluginsApi.listUiContributions(),
    enabled: !!selectedOrganizationId && isIssuesRoute,
  });
  const { data: calendarCompletedIssues } = useQuery({
    queryKey: ["calendar", selectedOrganizationId ?? "__none__", "completed-issue-heatmap"],
    queryFn: () => issuesApi.list(selectedOrganizationId!, { status: "done" }),
    enabled: !!selectedOrganizationId && isCalendarRoute,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const rawScope = new URLSearchParams(location.search).get("scope") ?? "";
  const scope = rawScope === "recent" ? "" : rawScope;
  const selectedIssueSource = new URLSearchParams(location.search).get("source") ?? "";
  const selectedProjectId = new URLSearchParams(location.search).get("projectId") ?? "";
  const selectedLinearProjectId = new URLSearchParams(location.search).get("linearProjectId") ?? "";
  const selectedLinearTeamId = new URLSearchParams(location.search).get("linearTeamId") ?? "";
  const activeConversationId = activeConversationIdFromPath(location.pathname);
  const activeAgentRef = location.pathname.match(/\/agents\/([^/]+)/)?.[1] ?? null;
  const activeProjectRef = location.pathname.match(/\/projects\/([^/]+)/)?.[1] ?? null;
  const activeIssueRef = location.pathname.match(/\/issues\/([^/]+)/)?.[1] ?? null;

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project) => !project.archivedAt),
    [projects],
  );
  const linearPageContribution = useMemo(
    () => resolveLinearPageContribution(pluginContributions),
    [pluginContributions],
  );
  const { data: linearCatalog } = useQuery({
    queryKey: [
      "plugins",
      LINEAR_PLUGIN_KEY,
      "catalog",
      selectedOrganizationId ?? "__none__",
      linearPageContribution?.pluginId ?? "__none__",
    ] as const,
    queryFn: async () => {
      const response = await pluginsApi.bridgeGetData(
        linearPageContribution!.pluginId,
        LINEAR_CATALOG_DATA_KEY,
        { orgId: selectedOrganizationId! },
        selectedOrganizationId,
      );
      return response.data as LinearSidebarCatalog;
    },
    enabled: !!selectedOrganizationId && !!linearPageContribution?.pluginId && isIssuesRoute,
  });
  const linearSidebarItems = useMemo<LinearSidebarItem[]>(() => {
    const projects = [...(linearCatalog?.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const teams = [...(linearCatalog?.teams ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    if (teams.length === 0) {
      return projects.map((project) => ({ ...project, kind: "project" as const }));
    }

    const items: LinearSidebarItem[] = [];
    const groupedProjectIds = new Set<string>();
    for (const team of teams) {
      items.push({ ...team, kind: "team" });
      for (const project of projects) {
        const teamIds = project.teamIds ?? [];
        if (!teamIds.includes(team.id)) continue;
        groupedProjectIds.add(project.id);
        items.push({
          id: project.id,
          name: project.name,
          kind: "project",
          teamId: team.id,
        });
      }
    }

    for (const project of projects) {
      if (groupedProjectIds.has(project.id)) continue;
      items.push({ ...project, kind: "project" });
    }

    return items;
  }, [linearCatalog?.projects, linearCatalog?.teams]);
  const visibleAgents = useMemo(
    () => (agents ?? []).filter((agent) => agent.status !== "terminated").sort((a, b) => a.name.localeCompare(b.name)),
    [agents],
  );
  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [liveRuns]);
  const liveCountByProject = useMemo(() => {
    const issueProjectIds = new Map<string, string>();
    for (const issue of allIssues ?? []) {
      if (issue.projectId) issueProjectIds.set(issue.id, issue.projectId);
    }

    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      if (!run.issueId) continue;
      const projectId = issueProjectIds.get(run.issueId);
      if (!projectId) continue;
      counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
    }
    return counts;
  }, [allIssues, liveRuns]);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [googleExpanded, setGoogleExpanded] = useState(true);
  const [issueDraftSummaries, setIssueDraftSummaries] = useState(() => summarizeIssueDrafts(selectedOrganizationId));
  const [recentIssueIds, setRecentIssueIds] = useState<string[]>(() => readRecentIssueIds(selectedOrganizationId));
  const recentIssueRefs = useMemo(
    () => resolveRecentIssues(recentIssueIds, allIssues ?? []),
    [allIssues, recentIssueIds],
  );
  const starredIssueRefs = useMemo<SidebarIssue[]>(() => {
    const issuesById = new Map((allIssues ?? []).map((issue) => [issue.id, issue]));
    return issueFollows.map((follow) => issuesById.get(follow.issueId) ?? follow.issue);
  }, [allIssues, issueFollows]);
  const followingIssueCount = useMemo(() => {
    if (!currentUserId) return 0;
    return (allIssues ?? []).filter((issue) => isFollowingIssue(issue, currentUserId)).length;
  }, [allIssues, currentUserId]);
  const issueContextItems = [
    {
      key: "all",
      to: "/issues",
      icon: Circle,
      label: "All Issues",
      active: selectedIssueSource !== "linear" && scope === "" && !selectedProjectId,
    },
    ...(issueDraftSummaries.length > 0
      ? [{
        key: "drafts",
        to: "/issues?scope=drafts",
        icon: PencilLine,
        label: `Draft Issues (${issueDraftSummaries.length})`,
        active: scope === "drafts",
        testId: "issue-draft-sidebar-entry",
      }]
      : []),
    {
      key: "following",
      to: `/issues${currentUserId ? "?scope=following" : ""}`,
      icon: UserRound,
      label: `Following${followingIssueCount > 0 ? ` (${followingIssueCount})` : ""}`,
      active: scope === "following",
    },
  ];
  const activeIssueContextIndex = issueContextItems.findIndex((item) => item.active);
  const issueProjectActiveIndex = visibleProjects.findIndex((project) => {
    const routeRef = projectRouteRef(project);
    return selectedProjectId === project.id || activeProjectRef === routeRef;
  });
  const orgContextItems = [
    { key: "structure", to: "/org", icon: Network, label: "Structure", active: /^\/org(?:\/|$)/.test(relativePath) },
    { key: "resources", to: "/resources", icon: Boxes, label: "Resources", active: /^\/resources(?:\/|$)/.test(relativePath) },
    { key: "heartbeats", to: "/heartbeats", icon: Clock3, label: "Heartbeats", active: /^\/heartbeats(?:\/|$)/.test(relativePath) },
    { key: "workspaces", to: "/workspaces", icon: FolderTree, label: "Workspaces", active: /^\/workspaces(?:\/|$)/.test(relativePath) },
    { key: "goals", to: "/goals", icon: Target, label: "Goals", active: /^\/goals(?:\/|$)/.test(relativePath) },
    { key: "skills", to: "/skills", icon: Boxes, label: "Skills", active: /^\/skills(?:\/|$)/.test(relativePath) },
    { key: "costs", to: "/costs", icon: DollarSign, label: "Costs", active: /^\/costs(?:\/|$)/.test(relativePath) },
    { key: "activity", to: "/activity", icon: History, label: "Activity", active: /^\/activity(?:\/|$)/.test(relativePath) },
  ];
  const activeOrgContextIndex = orgContextItems.findIndex((item) => item.active);
  const activeAgentIndex = visibleAgents.findIndex((agent) => activeAgentRef === agent.urlKey || activeAgentRef === agent.id);
  const googleSources = (calendarSources ?? [])
    .filter((source) => source.type === "google_calendar")
    .sort((a, b) => {
      const primaryDelta = (a.externalCalendarId === "primary" ? 0 : 1) - (b.externalCalendarId === "primary" ? 0 : 1);
      return primaryDelta !== 0 ? primaryDelta : a.name.localeCompare(b.name);
    });
  const activeGoogleSources = googleSources.filter((source) => source.status === "active");
  const googleVisible = googleSources.some((source) => source.status === "active" && !hiddenSourceIds.has(source.id));
  const completedIssueCountByDay = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of calendarCompletedIssues ?? []) {
      if (!issue.completedAt || !issue.assigneeAgentId) continue;
      const key = calendarDateKey(issue.completedAt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [calendarCompletedIssues]);

  useEffect(() => {
    setRecentIssueIds(readRecentIssueIds(selectedOrganizationId));
  }, [location.key, selectedOrganizationId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const refreshRecentIssueIds = () => {
      setRecentIssueIds(readRecentIssueIds(selectedOrganizationId));
    };
    window.addEventListener(RECENT_ISSUES_CHANGED_EVENT, refreshRecentIssueIds);
    window.addEventListener("storage", refreshRecentIssueIds);
    return () => {
      window.removeEventListener(RECENT_ISSUES_CHANGED_EVENT, refreshRecentIssueIds);
      window.removeEventListener("storage", refreshRecentIssueIds);
    };
  }, [selectedOrganizationId]);

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

  const closeMobileSidebar = () => {
    if (isMobile) setSidebarOpen(false);
  };

  const recordRecentIssueOpen = (issue: SidebarIssue) => {
    if (!selectedOrganizationId) return;
    setRecentIssueIds(recordRecentIssue(selectedOrganizationId, issue.id, readRecentIssueIds(selectedOrganizationId)));
  };

  const refreshChatList = async (chatId?: string) => {
    if (!selectedOrganizationId) return;
    await queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(selectedOrganizationId, "active") });
    if (chatId) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(chatId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(chatId) });
    }
  };

  const updateConversationMutation = useMutation({
    mutationFn: ({ chatId, data }: { chatId: string; data: Parameters<typeof chatsApi.update>[1] }) =>
      chatsApi.update(chatId, data),
    onSuccess: async (conversation) => {
      if (conversation.status === "archived" && conversation.id === activeConversationId) {
        navigate("/messenger");
      }
      setRenamingConversationId((current) => (current === conversation.id ? null : current));
      await refreshChatList(conversation.id);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update chat",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const updateConversationUserStateMutation = useMutation({
    mutationFn: ({ chatId, pinned }: { chatId: string; pinned: boolean }) =>
      chatsApi.updateUserState(chatId, { pinned }),
    onSuccess: async (conversation) => {
      await refreshChatList(conversation.id);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update chat state",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const submitRename = () => {
    const trimmed = renameDraft.trim();
    if (!renamingConversationId || !trimmed) {
      setRenamingConversationId(null);
      return;
    }
    updateConversationMutation.mutate({
      chatId: renamingConversationId,
      data: { title: trimmed },
    });
  };

  const copyConversationLink = async (conversation: { id: string; title: string; summary?: string | null; latestReplyPreview?: string | null }) => {
    try {
      await navigator.clipboard.writeText(chatReferenceMarkdown(conversation));
      pushToast({ title: "Chat link copied", tone: "success" });
    } catch {
      pushToast({ title: "Could not copy chat link", tone: "error" });
    }
  };

  const toggleGoogleVisibility = () => {
    const nextVisible = !googleVisible;
    const targetSources = nextVisible ? googleSources : activeGoogleSources;
    setHiddenSourceIds((current) => {
      const next = new Set(current);
      for (const source of targetSources) {
        if (nextVisible) next.delete(source.id);
        else next.add(source.id);
      }
      return next;
    });
    for (const source of targetSources) {
      updateCalendarSourceMutation.mutate({
        sourceId: source.id,
        status: nextVisible ? "active" : "paused",
      });
    }
  };

  const toggleGoogleSourceVisibility = (source: CalendarSource) => {
    const nextVisible = !(source.status === "active" && !hiddenSourceIds.has(source.id));
    setStringSetValue(setHiddenSourceIds, source.id, nextVisible);
    updateCalendarSourceMutation.mutate({
      sourceId: source.id,
      status: nextVisible ? "active" : "paused",
    });
  };

  if (isMessengerRoute) {
    return <MessengerContextSidebar />;
  }

  if (isCalendarRoute) {
    return (
      <aside
        data-testid="workspace-sidebar"
        className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
      >
        <ContextColumnHeader title={contextHeader.title} description={contextHeader.description}>
          <DashboardCalendarSwitcher compact className="w-full" />
        </ContextColumnHeader>
        <div ref={calendarSidebarScrollRef} className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto pb-3.5">
          <CalendarMiniMonth
            cursor={cursor}
            setCursor={setCursor}
            completedIssueCountByDay={completedIssueCountByDay}
          />

          <SectionLabel
            action={(
              <button
                type="button"
                aria-label="Import Google Calendar"
                className="inline-flex h-6 w-6 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                onClick={() => setGoogleCalendarModalOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
          >
            Calendars
          </SectionLabel>
          <div className="mt-2 space-y-0.5">
            <VisibilityLayerRow
              label="My Calendar"
              visible={myCalendarVisible}
              onToggle={() => setMyCalendarVisible((current) => !current)}
              icon={UserRound}
            />
            <div
              className="group mx-1.5 flex min-h-9 items-center gap-1 rounded-[calc(var(--radius-sm)-1px)] px-1.5 py-1 text-sm text-foreground/88 transition-[background-color,color] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)]"
            >
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground hover:bg-[color:var(--surface-page)] hover:text-foreground"
                aria-label={googleExpanded ? "Collapse Google Calendar calendars" : "Expand Google Calendar calendars"}
                onClick={() => setGoogleExpanded((current) => !current)}
              >
                {googleExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                data-testid="calendar-google-row"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-[calc(var(--radius-sm)-2px)] px-1.5 py-1 text-left"
                onClick={() => setGoogleCalendarModalOpen(true)}
              >
                <CalendarDays className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">Google Calendar</span>
              </button>
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-[color:var(--surface-page)] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 disabled:cursor-not-allowed disabled:opacity-30"
                aria-label={`${googleVisible ? "Hide" : "Show"} Google Calendar`}
                disabled={googleSources.length === 0 || updateCalendarSourceMutation.isPending}
                onClick={toggleGoogleVisibility}
              >
                {googleVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-[color:var(--surface-page)] hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
                aria-label="Google Calendar settings"
                onClick={() => setGoogleCalendarModalOpen(true)}
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {googleExpanded && googleSources.length > 0 ? (
              <div className="ml-9 mr-2 space-y-0.5" data-testid="calendar-google-source-list">
                {googleSources.map((source, index) => {
                  const visible = source.status === "active" && !hiddenSourceIds.has(source.id);
                  const EyeIcon = visible ? Eye : EyeOff;
                  return (
                    <button
                      type="button"
                      key={source.id}
                      data-testid={`calendar-google-source-row-${source.id}`}
                      disabled={updateCalendarSourceMutation.isPending}
                      aria-label={`${visible ? "Disable" : "Enable"} ${source.name}`}
                      className={cn(
                        "group/source flex min-h-7 w-full items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] px-2 py-1 text-left text-xs text-foreground/82 hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] disabled:cursor-not-allowed disabled:opacity-60",
                        !visible && "text-muted-foreground",
                      )}
                      onClick={() => toggleGoogleSourceVisibility(source)}
                    >
                      <span className={cn("h-2 w-2 shrink-0 rounded-sm border", CALENDAR_LAYER_COLORS[index % CALENDAR_LAYER_COLORS.length], !visible && "opacity-35 grayscale")} />
                      <span className="min-w-0 flex-1 truncate" title={source.name}>{source.name}</span>
                      {source.status !== "active" ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">Off</span>
                      ) : null}
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-[color:var(--surface-page)] hover:text-foreground group-hover/source:opacity-100 group-focus-visible/source:opacity-100">
                        <EyeIcon className="h-3 w-3" />
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

          <SectionLabel>Agents</SectionLabel>
          <div className="mt-2 space-y-0.5">
            {visibleAgents.map((agent, index) => (
              <VisibilityLayerRow
                key={agent.id}
                label={formatSidebarAgentLabel(agent)}
                visible={!hiddenAgentIds.has(agent.id)}
                onToggle={() => setStringSetValue(setHiddenAgentIds, agent.id, hiddenAgentIds.has(agent.id))}
                colorClass={CALENDAR_LAYER_COLORS[index % CALENDAR_LAYER_COLORS.length]}
                agent={agent}
              />
            ))}
          </div>

          <SectionLabel>Timeline</SectionLabel>
          <div className="mt-2 space-y-0.5" data-testid="calendar-status-filters">
            {CALENDAR_EVENT_STATUS_OPTIONS.map((status) => (
              <label
                key={status}
                className="mx-1.5 flex min-h-8 items-center gap-2 rounded-[calc(var(--radius-sm)-1px)] px-3 py-1.5 text-sm text-foreground/88 hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)]"
              >
                <Checkbox
                  checked={visibleStatuses.has(status)}
                  onCheckedChange={(checked) => {
                    setVisibleStatuses((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(status);
                      else next.delete(status);
                      return next;
                    });
                  }}
                  aria-label={`Show ${calendarStatusLabel(status)} events`}
                />
                <span className="truncate">{calendarStatusLabel(status)}</span>
              </label>
            ))}
          </div>
        </div>
      </aside>
    );
  }

  if (isIssuesRoute) {
    return (
      <aside
        data-testid="workspace-sidebar"
        className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
      >
        <ContextColumnHeader title={contextHeader.title} description={contextHeader.description} />
        <SectionLabel
          collapsed={isIssueSectionCollapsed("issues")}
          onToggle={() => toggleIssueSection("issues")}
        >
          Issues
        </SectionLabel>
        {isIssueSectionCollapsed("issues") ? null : (
          <SlidingContextNav
            activeIndex={activeIssueContextIndex}
            ariaLabel="Issue navigation"
            className="mt-2"
            indicatorTestId="issue-sidebar-active-indicator"
          >
            {issueContextItems.map((item) => (
              <ContextItem
                key={item.key}
                to={item.to}
                icon={item.icon}
                label={item.label}
                active={item.active}
                testId={item.testId}
                slidingActiveIndicator
              />
            ))}
          </SlidingContextNav>
        )}

        <div
          ref={issueSidebarScrollRef}
          data-testid="issue-sidebar-scroll"
          className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto pb-3.5"
        >
          <SidebarIssueListSection
            issues={starredIssueRefs}
            activeIssueRef={activeIssueRef}
            closeMobileSidebar={closeMobileSidebar}
            collapsed={isIssueSectionCollapsed("starred")}
            onToggleCollapsed={() => toggleIssueSection("starred")}
            sectionLabel={`Starred (${starredIssueRefs.length})`}
            ariaLabel="Starred issues"
            sectionTestId="issue-starred-section"
            listTestId="issue-starred-list"
            rowTestIdPrefix="issue-starred-row"
            toggleTestId="issue-starred-toggle"
            scrollActivityKey="rudder:sidebar-scroll:starred-issues"
          />
          <SidebarIssueListSection
            issues={recentIssueRefs}
            activeIssueRef={activeIssueRef}
            closeMobileSidebar={closeMobileSidebar}
            onOpenIssue={recordRecentIssueOpen}
            collapsed={isIssueSectionCollapsed("recent")}
            onToggleCollapsed={() => toggleIssueSection("recent")}
            sectionLabel={`Recently Viewed (${recentIssueRefs.length})`}
            ariaLabel="Recently viewed issues"
            sectionTestId="issue-recent-section"
            listTestId="issue-recent-list"
            rowTestIdPrefix="issue-recent-row"
            toggleTestId="issue-recent-toggle"
            scrollActivityKey="rudder:sidebar-scroll:recent-issues"
          />
          <SectionLabel
            testId="workspace-projects-section"
            collapsed={isIssueSectionCollapsed("projects")}
            onToggle={() => toggleIssueSection("projects")}
          >
            Projects
          </SectionLabel>
          {isIssueSectionCollapsed("projects") ? null : (
            <SlidingContextNav
              activeIndex={issueProjectActiveIndex}
              ariaLabel="Issue project slices"
              className="mt-2"
              indicatorTestId="issue-project-sidebar-active-indicator"
            >
              {visibleProjects.map((project) => {
                const routeRef = projectRouteRef(project);
                const active = selectedProjectId === project.id || activeProjectRef === routeRef;
                const liveCount = liveCountByProject.get(project.id) ?? 0;
                return (
                  <Link
                    key={project.id}
                    to={`/issues?projectId=${project.id}`}
                    onClick={closeMobileSidebar}
                    data-testid={`issue-project-row-${project.id}`}
                    className={cn(
                      "relative z-10 mx-1.5 flex min-h-[var(--motion-context-item-height)] items-center gap-3 rounded-[calc(var(--radius-sm)-1px)] border border-transparent px-3 py-2 text-sm transition-[background-color,border-color,color]",
                      active
                        ? "font-medium text-foreground"
                        : "text-muted-foreground hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] hover:text-foreground",
                    )}
                  >
                    <Circle
                      data-testid={`issue-project-color-${project.id}`}
                      className="h-2.5 w-2.5 shrink-0 fill-current"
                      style={{ color: projectColorAccent(project.color) }}
                    />
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                    {liveCount > 0 ? <SidebarLiveCount count={liveCount} /> : null}
                  </Link>
                );
              })}
            </SlidingContextNav>
          )}
          {linearSidebarItems.length > 0 ? (
            <>
              <SectionLabel
                testId="issue-linear-section"
                collapsed={isIssueSectionCollapsed("linear")}
                onToggle={() => toggleIssueSection("linear")}
              >
                Linear
              </SectionLabel>
              {isIssueSectionCollapsed("linear") ? null : (
                <SlidingContextNav
                  activeIndex={-1}
                  ariaLabel="Linear issue source slices"
                  className="mt-2"
                >
                  {linearSidebarItems.map((item) => {
                    const active = item.kind === "project"
                      ? selectedLinearProjectId === item.id && (!item.teamId || selectedLinearTeamId === item.teamId)
                      : selectedIssueSource === "linear" && selectedLinearTeamId === item.id && !selectedLinearProjectId;
                    return (
                      <Link
                        key={`${item.kind}-${item.id}`}
                        to={linearIssueSourceHref(item)}
                        onClick={closeMobileSidebar}
                        data-testid={`issue-linear-${item.kind}-${item.id}`}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "relative z-10 mx-1.5 flex min-h-[var(--motion-context-item-height)] items-center gap-3 rounded-[calc(var(--radius-sm)-1px)] border border-transparent px-3 py-2 text-sm transition-[background-color,border-color,color]",
                          item.kind === "project" && item.teamId ? "ml-6 min-h-8 py-1.5 text-xs" : "",
                          active
                            ? "border-[color:color-mix(in_oklab,var(--border-soft)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_92%,var(--surface-active))] font-medium text-foreground"
                            : "text-muted-foreground hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] hover:text-foreground",
                        )}
                      >
                        <span className="h-2.5 w-2.5 shrink-0 rounded-[calc(var(--radius-sm)-4px)] border border-[color:color-mix(in_oklab,var(--muted-foreground)_54%,transparent)] bg-[color:color-mix(in_oklab,var(--muted-foreground)_18%,transparent)]" />
                        <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      </Link>
                    );
                  })}
                </SlidingContextNav>
              )}
            </>
          ) : null}
        </div>
      </aside>
    );
  }

  if (isOrgWorkspaceRoute) {
    return (
      <aside
        data-testid="workspace-sidebar"
        className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
      >
        <ContextColumnHeader title={contextHeader.title} description={contextHeader.description} />
        <div className="flex min-h-0 flex-1 flex-col">
          <SectionLabel>Org</SectionLabel>
          <SlidingContextNav
            activeIndex={activeOrgContextIndex}
            ariaLabel="Organization workspaces"
            className="mt-2"
            indicatorTestId="org-sidebar-active-indicator"
          >
            {orgContextItems.map((item) => (
              <ContextItem
                key={item.key}
                to={item.to}
                icon={item.icon}
                label={item.label}
                active={item.active}
                slidingActiveIndicator
              />
            ))}
          </SlidingContextNav>
          <ProjectListSection
            visibleProjects={visibleProjects}
            activeProjectRef={activeProjectRef}
            closeMobileSidebar={closeMobileSidebar}
            onNewProject={openNewProject}
            scrollRef={workspaceProjectsScrollRef}
          />
        </div>
      </aside>
    );
  }

  if (isChatRoute) {
    if (!activeConversationId && (chats?.length ?? 0) === 0) {
      return null;
    }

    const pinnedChats = (chats ?? []).filter((conversation) => conversation.isPinned);
    const recentChats = (chats ?? []).filter((conversation) => !conversation.isPinned);

    return (
      <aside
        data-testid="workspace-sidebar"
        className="workspace-context-sidebar chat-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
      >
        <ContextColumnHeader title={contextHeader.title} description={contextHeader.description} />
        <nav
          ref={chatSidebarScrollRef}
          data-testid="chat-sidebar-scroll"
          className="scrollbar-auto-hide flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 py-2.5"
        >
          <Link
            to="/messenger/chat"
            onClick={closeMobileSidebar}
            className={cn(
              "flex items-center gap-3 rounded-[calc(var(--radius-sm)-1px)] border px-3 py-2.5 text-sm transition-[background-color,border-color,color]",
              !activeConversationId
                ? "surface-active border-[color:var(--border-strong)] text-[color:var(--accent-strong)]"
                : "border-transparent text-foreground/88 hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)] hover:text-foreground",
            )}
          >
            <MessageSquare className="h-4 w-4 shrink-0" />
            <div className="truncate font-medium">New Chat</div>
          </Link>

          {pinnedChats.length > 0 ? (
            <div className="px-2 pb-1 pt-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/72">
              Pinned
            </div>
          ) : null}
          {pinnedChats.map((conversation) => (
            <ExactTimestampTooltip key={conversation.id} date={conversation.lastMessageAt ?? conversation.updatedAt}>
              <div
                data-testid={`chat-sidebar-conversation-${conversation.id}`}
                className={cn(
                  "group relative rounded-[calc(var(--radius-sm)-1px)] border px-3 py-1.5 transition-[background-color,border-color,color]",
                  activeConversationId === conversation.id
                    ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_86%,var(--surface-elevated))]"
                    : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
                )}
              >
              {renamingConversationId === conversation.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={submitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitRename();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingConversationId(null);
                    }
                  }}
                  className="min-h-0 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] px-3 py-2 text-sm outline-none"
                />
              ) : (
                <>
                  <Link
                    to={`/messenger/chat/${conversation.id}`}
                    onClick={closeMobileSidebar}
                    className="block min-w-0 pr-12"
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[13px] font-medium leading-tight text-foreground">
                          <span className="truncate">{displayChatTitle(conversation)}</span>
                          {conversation.isUnread ? (
                            <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Unread chat" />
                          ) : null}
                        </div>
                      </div>
                      <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0">
                        {relativeTime(conversation.lastMessageAt ?? conversation.updatedAt)}
                      </span>
                    </div>
                  </Link>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        aria-label="Chat actions"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="surface-overlay text-foreground">
                      <DropdownMenuItem
                        onClick={() => {
                          setRenamingConversationId(conversation.id);
                          setRenameDraft(conversation.title);
                        }}
                      >
                        <PencilLine className="h-4 w-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          updateConversationUserStateMutation.mutate({
                            chatId: conversation.id,
                            pinned: false,
                          });
                        }}
                      >
                        <PinOff className="h-4 w-4" />
                        Unpin
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void copyConversationLink(conversation)}>
                        <Copy className="h-4 w-4" />
                        Copy Chat Link
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          updateConversationMutation.mutate({
                            chatId: conversation.id,
                            data: { status: "archived" },
                          });
                        }}
                      >
                        <Archive className="h-4 w-4" />
                        Archive
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
              </div>
            </ExactTimestampTooltip>
          ))}
          {recentChats.length > 0 ? (
            <div className="px-2 pb-1 pt-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/72">
              Recent
            </div>
          ) : null}
          {recentChats.map((conversation) => (
            <ExactTimestampTooltip key={conversation.id} date={conversation.lastMessageAt ?? conversation.updatedAt}>
              <div
                data-testid={`chat-sidebar-conversation-${conversation.id}`}
                className={cn(
                  "group relative rounded-[calc(var(--radius-sm)-1px)] border px-3 py-1.5 transition-[background-color,border-color,color]",
                  activeConversationId === conversation.id
                    ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_86%,var(--surface-elevated))]"
                    : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
                )}
              >
              {renamingConversationId === conversation.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={submitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitRename();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingConversationId(null);
                    }
                  }}
                  className="min-h-0 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] px-3 py-2 text-sm outline-none"
                />
              ) : (
                <>
                  <Link
                    to={`/messenger/chat/${conversation.id}`}
                    onClick={closeMobileSidebar}
                    className="block min-w-0 pr-12"
                  >
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[13px] font-medium leading-tight text-foreground">
                          <span className="truncate">{displayChatTitle(conversation)}</span>
                          {conversation.isUnread ? (
                            <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Unread chat" />
                          ) : null}
                        </div>
                      </div>
                      <span className="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0">
                        {relativeTime(conversation.lastMessageAt ?? conversation.updatedAt)}
                      </span>
                    </div>
                  </Link>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        aria-label="Chat actions"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="surface-overlay text-foreground">
                      <DropdownMenuItem
                        onClick={() => {
                          setRenamingConversationId(conversation.id);
                          setRenameDraft(conversation.title);
                        }}
                      >
                        <PencilLine className="h-4 w-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          updateConversationUserStateMutation.mutate({
                            chatId: conversation.id,
                            pinned: true,
                          });
                        }}
                      >
                        <Pin className="h-4 w-4" />
                        Pin
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void copyConversationLink(conversation)}>
                        <Copy className="h-4 w-4" />
                        Copy Chat Link
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          updateConversationMutation.mutate({
                            chatId: conversation.id,
                            data: { status: "archived" },
                          });
                        }}
                      >
                        <Archive className="h-4 w-4" />
                        Archive
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
              </div>
            </ExactTimestampTooltip>
          ))}
        </nav>
      </aside>
    );
  }

  return (
    <aside
      data-testid="workspace-sidebar"
      className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
    >
      <ContextColumnHeader title={contextHeader.title} description={contextHeader.description} />
      <SectionLabel
        testId="agents-team-section"
        action={(
          <div className="flex items-center">
            <button
              type="button"
              onClick={openNewAgent}
              aria-label="New agent"
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground/72 transition-[opacity,background-color,color]",
                "hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_82%,transparent)] hover:text-foreground",
                "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
              )}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      >
        Team
      </SectionLabel>
      <SlidingContextNav
        activeIndex={activeAgentIndex}
        ariaLabel="Agent team"
        className="motion-context-nav--agent-list scrollbar-auto-hide mt-2 min-h-0 flex-1 overflow-y-auto pb-3.5"
        scrollRef={agentSidebarScrollRef}
        indicatorTestId="agent-sidebar-active-indicator"
        testId="agent-sidebar-scroll"
      >
        {visibleAgents.map((agent) => {
          const liveCount = liveCountByAgent.get(agent.id) ?? 0;
          const active = activeAgentRef === agent.urlKey || activeAgentRef === agent.id;
          return (
            <div
              key={agent.id}
              data-testid={`agent-sidebar-row-${agent.id}`}
              className={cn(
                "group/agent-sidebar-row relative z-10 mx-1.5 flex min-h-[var(--motion-context-item-height)] items-center rounded-[calc(var(--radius-sm)-1px)] text-sm transition-colors",
                active
                  ? "font-medium text-foreground"
                  : "text-foreground/80 hover:bg-[color:color-mix(in_oklab,var(--surface-active)_54%,transparent)]",
              )}
            >
              <Link
                to={agentUrl(agent)}
                onClick={closeMobileSidebar}
                className="flex min-w-0 flex-1 items-center gap-3 self-stretch py-2.5 pl-3.5 pr-1 no-underline text-inherit"
              >
                <AgentIcon icon={agent.icon} role={agent.role} className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate" title={formatSidebarAgentLabel(agent)}>
                  {formatSidebarAgentLabel(agent)}
                </span>
                {liveCount > 0 ? <SidebarLiveCount count={liveCount} /> : null}
              </Link>
              <AgentActionsMenu
                agent={agent}
                orgId={selectedOrganizationId ?? agent.orgId}
                triggerTestId={`agent-sidebar-actions-${agent.id}`}
                triggerClassName="mr-2 h-6 w-6"
                visibilityClassName="opacity-100 md:opacity-0 md:group-hover/agent-sidebar-row:opacity-100 md:group-focus-within/agent-sidebar-row:opacity-100"
                onActionComplete={closeMobileSidebar}
              />
            </div>
          );
        })}
      </SlidingContextNav>
    </aside>
  );
}
