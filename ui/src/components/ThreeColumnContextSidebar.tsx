import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Boxes,
  Circle,
  Clock3,
  Copy,
  DollarSign,
  FolderTree,
  History,
  MessageSquare,
  MoreHorizontal,
  Network,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  Star,
  Target,
  UserRound,
} from "lucide-react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { cn, agentUrl, projectRouteRef } from "@/lib/utils";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { useOrganization } from "@/context/OrganizationContext";
import { useSidebar } from "@/context/SidebarContext";
import { useToast } from "@/context/ToastContext";
import { useDialog } from "@/context/DialogContext";
import { useIssueFollows } from "@/hooks/useIssueFollows";
import { issuesApi } from "@/api/issues";
import { authApi } from "@/api/auth";
import { projectsApi } from "@/api/projects";
import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { heartbeatsApi } from "@/api/heartbeats";
import { formatSidebarAgentLabel } from "@/lib/agent-labels";
import { projectColorAccent, projectColorBackgroundStyle } from "@/lib/project-colors";
import { queryKeys } from "@/lib/queryKeys";
import { relativeTime } from "@/lib/utils";
import { readRecentIssueIds, resolveRecentIssues } from "@/lib/recent-issues";
import { isFollowingIssue } from "@/lib/issue-scope-filters";
import {
  ISSUE_DRAFT_CHANGED_EVENT,
  summarizeIssueDrafts,
} from "@/lib/new-issue-dialog";
import { AgentIcon } from "@/components/AgentIconPicker";
import { AgentActionsMenu } from "@/components/AgentActionsMenu";
import { MessengerContextSidebar } from "@/components/MessengerContextSidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ExactTimestampTooltip } from "@/components/HoverTimestamp";

function SectionLabel({
  children,
  action,
  testId,
}: {
  children: string;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="group flex items-center justify-between px-3.5 pt-3.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/72"
    >
      <span>{children}</span>
      {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
    </div>
  );
}

function ContextColumnHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <header
      data-testid="workspace-context-header"
      className="workspace-card-header workspace-context-header desktop-chrome flex shrink-0 items-center px-4 py-3"
    >
      <div className="min-w-0">
        <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{description}</p>
      </div>
    </header>
  );
}

function resolveContextColumnHeader(relativePath: string): { title: string; description: string } {
  if (/^\/issues(?:\/|$)/.test(relativePath)) {
    return { title: "Issues", description: "Views and project slices" };
  }
  if (/^\/chat(?:\/|$)/.test(relativePath)) {
    return { title: "Chats", description: "Recent conversations" };
  }
  if (/^\/(?:org|projects|resources|heartbeats|workspaces|goals|skills|costs|activity)(?:\/|$)/.test(relativePath)) {
    return { title: "Org", description: "Organization surfaces" };
  }
  return { title: "Agents", description: "" };
}

function activeConversationIdFromPath(pathname: string): string | null {
  const match = pathname.match(/\/(?:messenger\/chat|chat)\/([^/]+)\/?/);
  return match?.[1] ?? null;
}

function ContextItem({
  to,
  icon: Icon,
  label,
  active,
  slidingActiveIndicator = false,
  testId,
}: {
  to: string;
  icon: typeof UserRound;
  label: string;
  active?: boolean;
  slidingActiveIndicator?: boolean;
  testId?: string;
}) {
  return (
    <Link
      to={to}
      data-testid={testId}
      className={cn(
        "relative z-10 mx-1.5 flex items-center gap-3 rounded-[calc(var(--radius-sm)-1px)] border border-transparent px-3 py-2 text-sm transition-[background-color,border-color,color]",
        slidingActiveIndicator && "min-h-[var(--motion-context-item-height)]",
        slidingActiveIndicator
          ? active
            ? "font-medium text-foreground"
            : "text-foreground/78 hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_58%,transparent)] hover:text-foreground"
          : active
            ? "border-[color:color-mix(in_oklab,var(--border-soft)_72%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_92%,var(--surface-active))] font-medium text-foreground"
            : "text-foreground/78 hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function activeContextStyle(activeIndex: number): CSSProperties | undefined {
  return activeIndex >= 0
    ? ({ "--motion-context-active-index": activeIndex } as CSSProperties)
    : undefined;
}

function SlidingContextNav({
  activeIndex,
  ariaLabel,
  className,
  indicatorTestId,
  children,
}: {
  activeIndex: number;
  ariaLabel: string;
  className?: string;
  indicatorTestId?: string;
  children: ReactNode;
}) {
  return (
    <nav
      className={cn("motion-context-nav", className)}
      style={activeContextStyle(activeIndex)}
      data-active-index={activeIndex >= 0 ? activeIndex : undefined}
      aria-label={ariaLabel}
    >
      {activeIndex >= 0 ? (
        <span
          data-testid={indicatorTestId}
          className="motion-context-active-indicator"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </nav>
  );
}

function SidebarLiveCount({ count }: { count: number }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
      </span>
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">{count} live</span>
    </span>
  );
}

function ProjectListSection({
  visibleProjects,
  activeProjectRef,
  closeMobileSidebar,
  onNewProject,
}: {
  visibleProjects: Array<{ id: string; name: string; description: string | null; color?: string | null; urlKey?: string | null }>;
  activeProjectRef: string | null;
  closeMobileSidebar: () => void;
  onNewProject: () => void;
}) {
  const activeProjectIndex = visibleProjects.findIndex((project) => activeProjectRef === projectRouteRef(project));

  return (
    <>
      <SectionLabel
        testId="workspace-projects-section"
        action={(
          <button
            type="button"
            onClick={onNewProject}
            aria-label="New project"
            title="Create project"
            className={cn(
              "inline-flex h-5 w-5 items-center justify-center rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground/72 transition-[opacity,background-color,color]",
              "hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_82%,transparent)] hover:text-foreground",
              "opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      >
        Projects
      </SectionLabel>
      <SlidingContextNav
        activeIndex={activeProjectIndex}
        ariaLabel="Project workspaces"
        className="motion-context-nav--project-card-list mt-2 min-h-0 flex-1 overflow-y-auto pb-3.5"
        indicatorTestId="project-sidebar-active-indicator"
      >
        {visibleProjects.map((project) => {
          const routeRef = projectRouteRef(project);
          const active = activeProjectRef === routeRef;
          return (
            <Link
              key={project.id}
              to={`/projects/${routeRef}/configuration`}
              onClick={closeMobileSidebar}
              className={cn(
                "relative z-10 mx-1.5 min-h-[var(--motion-context-item-height)] rounded-[calc(var(--radius-sm)-1px)] px-3.5 py-2.5 transition-colors",
                active
                  ? "font-medium text-foreground"
                  : "text-foreground/88 hover:bg-[color:color-mix(in_oklab,var(--surface-active)_54%,transparent)]",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  data-testid={`workspace-project-color-${project.id}`}
                  className="h-4 w-4 shrink-0 rounded-[calc(var(--radius-sm)-3px)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,white_20%,transparent),0_0_0_1px_color-mix(in_oklab,var(--border-base)_72%,transparent)]"
                  style={projectColorBackgroundStyle(project.color)}
                />
                <span className="truncate text-sm font-medium text-foreground">{project.name}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {project.description || "Project workspace"}
              </div>
            </Link>
          );
        })}
      </SlidingContextNav>
    </>
  );
}

export function ThreeColumnContextSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const relativePath = toOrganizationRelativePath(location.pathname);
  const contextHeader = useMemo(() => resolveContextColumnHeader(relativePath), [relativePath]);
  const isMessengerRoute = /^\/messenger(?:\/|$)/.test(relativePath);
  const isIssuesRoute = /^\/issues(?:\/|$)/.test(relativePath);
  const isOrgWorkspaceRoute = /^\/(?:org|projects|resources|heartbeats|workspaces|goals|skills|costs|activity)(?:\/|$)/.test(relativePath);
  const isChatRoute = /^\/chat(?:\/|$)/.test(relativePath);
  const isAgentRoute = !isMessengerRoute && !isIssuesRoute && !isOrgWorkspaceRoute && !isChatRoute;
  const { selectedOrganizationId } = useOrganization();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { pushToast } = useToast();
  const { openNewAgent, openNewProject } = useDialog();
  const queryClient = useQueryClient();

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
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedOrganizationId ?? "__none__"),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && isAgentRoute,
    refetchInterval: 10_000,
  });
  const { data: allIssues } = useQuery({
    queryKey: queryKeys.issues.list(selectedOrganizationId ?? "__none__"),
    queryFn: () => issuesApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && isIssuesRoute,
  });
  const { followedIssueIds } = useIssueFollows(selectedOrganizationId);

  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const scope = new URLSearchParams(location.search).get("scope") ?? "";
  const selectedProjectId = new URLSearchParams(location.search).get("projectId") ?? "";
  const activeConversationId = activeConversationIdFromPath(location.pathname);
  const activeAgentRef = location.pathname.match(/\/agents\/([^/]+)/)?.[1] ?? null;
  const activeProjectRef = location.pathname.match(/\/projects\/([^/]+)/)?.[1] ?? null;

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((project) => !project.archivedAt),
    [projects],
  );
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
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [issueDraftSummaries, setIssueDraftSummaries] = useState(() => summarizeIssueDrafts(selectedOrganizationId));
  const [recentIssueIds, setRecentIssueIds] = useState<string[]>(() => readRecentIssueIds(selectedOrganizationId));
  const starredIssueRefs = useMemo(() => [...followedIssueIds], [followedIssueIds]);
  const recentIssueRefs = useMemo(
    () => resolveRecentIssues(recentIssueIds, allIssues ?? []),
    [allIssues, recentIssueIds],
  );
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
      active: scope === "" && !selectedProjectId,
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
    {
      key: "starred",
      to: "/issues?scope=starred",
      icon: Star,
      label: `Starred${starredIssueRefs.length > 0 ? ` (${starredIssueRefs.length})` : ""}`,
      active: scope === "starred",
    },
    {
      key: "recent",
      to: `/issues${currentUserId ? "?scope=recent" : ""}`,
      icon: Clock3,
      label: `Recently Viewed${recentIssueRefs.length > 0 ? ` (${recentIssueRefs.length})` : ""}`,
      active: scope === "recent",
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

  useEffect(() => {
    setRecentIssueIds(readRecentIssueIds(selectedOrganizationId));
  }, [location.key, selectedOrganizationId]);

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

  const copyConversationId = async (conversationId: string) => {
    try {
      await navigator.clipboard.writeText(conversationId);
      pushToast({ title: "Chat ID copied", tone: "success" });
    } catch {
      pushToast({ title: "Could not copy chat ID", tone: "error" });
    }
  };

  if (isMessengerRoute) {
    return <MessengerContextSidebar />;
  }

  if (isIssuesRoute) {
    return (
      <aside
        data-testid="workspace-sidebar"
        className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
      >
        <ContextColumnHeader title={contextHeader.title} description={contextHeader.description} />
        <SectionLabel>Issues</SectionLabel>
        <SlidingContextNav
          activeIndex={activeIssueContextIndex}
          ariaLabel="Issue views"
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

        <SectionLabel>Projects</SectionLabel>
        <SlidingContextNav
          activeIndex={issueProjectActiveIndex}
          ariaLabel="Issue project slices"
          className="mt-2 min-h-0 flex-1 overflow-y-auto pb-3.5"
          indicatorTestId="issue-project-sidebar-active-indicator"
        >
          {visibleProjects.map((project) => {
            const routeRef = projectRouteRef(project);
            const active = selectedProjectId === project.id || activeProjectRef === routeRef;
            return (
              <Link
                key={project.id}
                to={`/issues?projectId=${project.id}`}
                onClick={closeMobileSidebar}
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
                <span className="truncate">{project.name}</span>
              </Link>
            );
          })}
        </SlidingContextNav>
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
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 py-2.5">
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
                          <span className="truncate">{conversation.title}</span>
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
                      <DropdownMenuItem onClick={() => void copyConversationId(conversation.id)}>
                        <Copy className="h-4 w-4" />
                        Copy chat ID
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
                          <span className="truncate">{conversation.title}</span>
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
                      <DropdownMenuItem onClick={() => void copyConversationId(conversation.id)}>
                        <Copy className="h-4 w-4" />
                        Copy chat ID
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
        className="motion-context-nav--agent-list mt-2 min-h-0 flex-1 overflow-y-auto pb-3.5"
        indicatorTestId="agent-sidebar-active-indicator"
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
                <AgentIcon icon={agent.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
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
