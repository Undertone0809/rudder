import { useState, useEffect, useMemo } from "react";
import { Link, useNavigate, useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentsApi, type OrgNode } from "../api/agents";
import { chatsApi } from "../api/chats";
import { heartbeatsApi } from "../api/heartbeats";
import { useOrganization } from "../context/OrganizationContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { relativeTime, cn, agentRouteRef, agentUrl } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import {
  Bot,
  Copy,
  GitBranch,
  HeartPulse,
  List,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AGENT_ROLE_LABELS, type Agent } from "@rudderhq/shared";

const adapterLabels: Record<string, string> = {
  claude_local: "Claude",
  codex_local: "Codex",
  gemini_local: "Gemini",
  opencode_local: "OpenCode",
  cursor: "Cursor",
  openclaw_gateway: "OpenClaw Gateway",
  process: "Process",
  http: "HTTP",
};

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

type FilterTab = "all" | "active" | "paused" | "error";

function matchesFilter(status: string, tab: FilterTab, showTerminated: boolean): boolean {
  if (status === "terminated") return showTerminated;
  if (tab === "all") return true;
  if (tab === "active") return status === "active" || status === "running" || status === "idle";
  if (tab === "paused") return status === "paused";
  if (tab === "error") return status === "error";
  return true;
}

function filterAgents(agents: Agent[], tab: FilterTab, showTerminated: boolean): Agent[] {
  return agents
    .filter((a) => matchesFilter(a.status, tab, showTerminated))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function filterOrgTree(nodes: OrgNode[], tab: FilterTab, showTerminated: boolean): OrgNode[] {
  return nodes
    .reduce<OrgNode[]>((acc, node) => {
      const filteredReports = filterOrgTree(node.reports, tab, showTerminated);
      if (matchesFilter(node.status, tab, showTerminated) || filteredReports.length > 0) {
        acc.push({ ...node, reports: filteredReports });
      }
      return acc;
    }, [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function Agents() {
  const { selectedOrganizationId } = useOrganization();
  const { openNewAgent, openNewIssue } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useSidebar();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const pathSegment = location.pathname.split("/").pop() ?? "all";
  const tab: FilterTab = (pathSegment === "all" || pathSegment === "active" || pathSegment === "paused" || pathSegment === "error") ? pathSegment : "all";
  const [view, setView] = useState<"list" | "org">("org");
  const forceListView = isMobile;
  const effectiveView: "list" | "org" = forceListView ? "list" : view;
  const [showTerminated, setShowTerminated] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const { data: agents, isLoading, error } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: orgTree } = useQuery({
    queryKey: queryKeys.org(selectedOrganizationId!),
    queryFn: () => agentsApi.org(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && effectiveView === "org",
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.heartbeats(selectedOrganizationId!),
    queryFn: () => heartbeatsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
    refetchInterval: 15_000,
  });

  // Map agentId -> first live run + live run count
  const liveRunByAgent = useMemo(() => {
    const map = new Map<string, { runId: string; liveCount: number }>();
    for (const r of runs ?? []) {
      if (r.status !== "running" && r.status !== "queued") continue;
      const existing = map.get(r.agentId);
      if (existing) {
        existing.liveCount += 1;
        continue;
      }
      map.set(r.agentId, { runId: r.id, liveCount: 1 });
    }
    return map;
  }, [runs]);

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Agents" }]);
  }, [setBreadcrumbs]);

  if (!selectedOrganizationId) {
    return <EmptyState icon={Bot} message="Select a organization to view agents." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const filtered = filterAgents(agents ?? [], tab, showTerminated);
  const filteredOrg = filterOrgTree(orgTree ?? [], tab, showTerminated);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={tab} onValueChange={(v) => navigate(`/agents/${v}`)}>
          <PageTabBar
            items={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "paused", label: "Paused" },
              { value: "error", label: "Error" },
            ]}
            value={tab}
            onValueChange={(v) => navigate(`/agents/${v}`)}
          />
        </Tabs>
        <div className="flex items-center gap-2">
          {/* Filters */}
          <div className="relative">
            <button
              className={cn(
                "flex items-center gap-1.5 px-2 py-1.5 text-xs transition-colors border border-border",
                filtersOpen || showTerminated ? "text-foreground bg-accent" : "text-muted-foreground hover:bg-accent/50"
              )}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <SlidersHorizontal className="h-3 w-3" />
              Filters
              {showTerminated && <span className="ml-0.5 px-1 bg-foreground/10 rounded text-[10px]">1</span>}
            </button>
            {filtersOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-48 border border-border bg-popover shadow-md p-1">
                <button
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-xs text-left hover:bg-accent/50 transition-colors"
                  onClick={() => setShowTerminated(!showTerminated)}
                >
                  <span className={cn(
                    "flex items-center justify-center h-3.5 w-3.5 border border-border rounded-sm",
                    showTerminated && "bg-foreground"
                  )}>
                    {showTerminated && <span className="text-background text-[10px] leading-none">&#10003;</span>}
                  </span>
                  Show terminated
                </button>
              </div>
            )}
          </div>
          {/* View toggle */}
          {!forceListView && (
            <div className="flex items-center border border-border">
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("list")}
              >
                <List className="h-3.5 w-3.5" />
              </button>
              <button
                className={cn(
                  "p-1.5 transition-colors",
                  effectiveView === "org" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"
                )}
                onClick={() => setView("org")}
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground">{filtered.length} agent{filtered.length !== 1 ? "s" : ""}</p>
      )}

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {agents && agents.length === 0 && (
        <EmptyState
          icon={Bot}
          message="Create your first agent to get started."
          action="New Agent"
          onAction={openNewAgent}
        />
      )}

      {/* List view */}
      {effectiveView === "list" && filtered.length > 0 && (
        <div className="border border-border">
          {filtered.map((agent) => {
            return (
              <AgentListRow
                key={agent.id}
                agent={agent}
                liveRun={liveRunByAgent.get(agent.id) ?? null}
                orgId={selectedOrganizationId}
                onCreateTask={() => openNewIssue({ assigneeAgentId: agent.id })}
                queryClient={queryClient}
                navigate={navigate}
                pushToast={pushToast}
              />
            );
          })}
        </div>
      )}

      {effectiveView === "list" && agents && agents.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {/* Org chart view */}
      {effectiveView === "org" && filteredOrg.length > 0 && (
        <div className="border border-border py-1">
          {filteredOrg.map((node) => (
            <OrgTreeNode
              key={node.id}
              node={node}
              depth={0}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              orgId={selectedOrganizationId}
              onCreateTask={(agentId) => openNewIssue({ assigneeAgentId: agentId })}
              queryClient={queryClient}
              navigate={navigate}
              pushToast={pushToast}
            />
          ))}
        </div>
      )}

      {effectiveView === "org" && orgTree && orgTree.length > 0 && filteredOrg.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No agents match the selected filter.
        </p>
      )}

      {effectiveView === "org" && orgTree && orgTree.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          No Organization Structure defined.
        </p>
      )}
    </div>
  );
}

function AgentListRow({
  agent,
  liveRun,
  orgId,
  onCreateTask,
  queryClient,
  navigate,
  pushToast,
}: {
  agent: Agent;
  liveRun: { runId: string; liveCount: number } | null;
  orgId: string;
  onCreateTask: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
  navigate: ReturnType<typeof useNavigate>;
  pushToast: ReturnType<typeof useToast>["pushToast"];
}) {
  return (
    <div
      data-testid={`agent-row-${agent.id}`}
      className="group/agent-row flex items-center gap-3 border-b panel-divider px-4 py-3 text-sm transition-[background-color,border-color,box-shadow] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_58%,transparent)]"
    >
      <Link
        to={agentUrl(agent)}
        className="flex min-w-0 flex-1 items-center gap-3 no-underline text-inherit"
      >
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span
            className={`absolute inline-flex h-full w-full rounded-full ${agentStatusDot[agent.status] ?? agentStatusDotDefault}`}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-foreground">{agent.name}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {roleLabels[agent.role] ?? agent.role}
            {agent.title ? ` - ${agent.title}` : ""}
          </p>
        </div>
      </Link>
      <AgentRowMetadata agent={agent} liveRun={liveRun} />
      <AgentRowActionsMenu
        agent={agent}
        orgId={orgId}
        onCreateTask={onCreateTask}
        queryClient={queryClient}
        navigate={navigate}
        pushToast={pushToast}
      />
    </div>
  );
}

function AgentRowMetadata({
  agent,
  liveRun,
}: {
  agent: Agent;
  liveRun: { runId: string; liveCount: number } | null;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3">
      <span className="sm:hidden">
        {liveRun ? (
          <LiveRunIndicator
            agentRef={agentRouteRef(agent)}
            runId={liveRun.runId}
            liveCount={liveRun.liveCount}
          />
        ) : (
          <StatusBadge status={agent.status} />
        )}
      </span>
      <div className="hidden sm:flex items-center gap-3">
        {liveRun && (
          <LiveRunIndicator
            agentRef={agentRouteRef(agent)}
            runId={liveRun.runId}
            liveCount={liveRun.liveCount}
          />
        )}
        <span className="text-xs text-muted-foreground font-mono w-14 text-right">
          {adapterLabels[agent.agentRuntimeType] ?? agent.agentRuntimeType}
        </span>
        <span className="text-xs text-muted-foreground w-16 text-right">
          {agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "—"}
        </span>
        <span className="w-20 flex justify-end">
          <StatusBadge status={agent.status} />
        </span>
      </div>
    </div>
  );
}

function AgentRowActionsMenu({
  agent,
  orgId,
  onCreateTask,
  queryClient,
  navigate,
  pushToast,
}: {
  agent: Agent;
  orgId: string;
  onCreateTask: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
  navigate: ReturnType<typeof useNavigate>;
  pushToast: ReturnType<typeof useToast>["pushToast"];
}) {
  const [open, setOpen] = useState(false);
  const isTerminated = agent.status === "terminated";
  const isPaused = agent.status === "paused";

  const invalidateAgentData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.org(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(orgId) }),
    ]);
  };

  const chatMutation = useMutation({
    mutationFn: () =>
      chatsApi.create(orgId, {
        title: `Chat with ${agent.name}`,
        preferredAgentId: agent.id,
        contextLinks: [{ entityType: "agent", entityId: agent.id }],
      }),
    onSuccess: async (conversation) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(orgId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(orgId) }),
      ]);
      navigate(`/messenger/chat/${conversation.id}`);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to open chat",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const heartbeatMutation = useMutation({
    mutationFn: () => agentsApi.invoke(agent.id, orgId),
    onSuccess: async (run) => {
      await invalidateAgentData();
      pushToast({
        title: "Heartbeat started",
        tone: "success",
        action: {
          label: "Open run",
          href: `/agents/${agentRouteRef(agent)}/runs/${run.id}`,
        },
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to run heartbeat",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const pauseResumeMutation = useMutation({
    mutationFn: () => isPaused ? agentsApi.resume(agent.id, orgId) : agentsApi.pause(agent.id, orgId),
    onSuccess: async () => {
      await invalidateAgentData();
      pushToast({
        title: isPaused ? "Agent resumed" : "Agent paused",
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: isPaused ? "Failed to resume agent" : "Failed to pause agent",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const handleCopyName = async () => {
    try {
      await navigator.clipboard.writeText(agent.name);
      pushToast({ title: "Copied agent name", tone: "success" });
    } catch (error) {
      pushToast({
        title: "Failed to copy agent name",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    }
  };

  const isBusy = chatMutation.isPending || heartbeatMutation.isPending || pauseResumeMutation.isPending;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`More actions for ${agent.name}`}
          data-testid={`agent-row-actions-${agent.id}`}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            open || isBusy
              ? "opacity-100"
              : "opacity-100 md:opacity-0 md:group-hover/agent-row:opacity-100 md:group-focus-within/agent-row:opacity-100",
          )}
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-3.5 w-3.5" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="surface-overlay w-48 text-foreground">
        <DropdownMenuItem onSelect={onCreateTask}>
          <Plus className="h-4 w-4" />
          Create task
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => chatMutation.mutate()} disabled={chatMutation.isPending || isTerminated}>
          <MessageSquare className="h-4 w-4" />
          Chat with agent
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => heartbeatMutation.mutate()} disabled={heartbeatMutation.isPending || isTerminated}>
          <HeartPulse className="h-4 w-4" />
          Run heartbeat
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => pauseResumeMutation.mutate()}
          disabled={pauseResumeMutation.isPending || isTerminated}
        >
          {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          {isPaused ? "Resume agent" : "Pause agent"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleCopyName()}>
          <Copy className="h-4 w-4" />
          Copy agent name
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OrgTreeNode({
  node,
  depth,
  agentMap,
  liveRunByAgent,
  orgId,
  onCreateTask,
  queryClient,
  navigate,
  pushToast,
}: {
  node: OrgNode;
  depth: number;
  agentMap: Map<string, Agent>;
  liveRunByAgent: Map<string, { runId: string; liveCount: number }>;
  orgId: string;
  onCreateTask: (agentId: string) => void;
  queryClient: ReturnType<typeof useQueryClient>;
  navigate: ReturnType<typeof useNavigate>;
  pushToast: ReturnType<typeof useToast>["pushToast"];
}) {
  const agent = agentMap.get(node.id);

  const statusColor = agentStatusDot[node.status] ?? agentStatusDotDefault;
  const liveRun = liveRunByAgent.get(node.id) ?? null;

  return (
    <div style={{ paddingLeft: depth * 24 }}>
      <div
        data-testid={`agent-row-${node.id}`}
        className="group/agent-row flex items-center gap-3 px-3 py-2 hover:bg-accent/30 transition-colors w-full text-left"
      >
        <Link
          to={agent ? agentUrl(agent) : `/agents/${node.id}`}
          className="flex min-w-0 flex-1 items-center gap-3 no-underline text-inherit"
        >
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className={`absolute inline-flex h-full w-full rounded-full ${statusColor}`} />
          </span>
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium">{node.name}</span>
            <span className="text-xs text-muted-foreground ml-2">
              {roleLabels[node.role] ?? node.role}
              {agent?.title ? ` - ${agent.title}` : ""}
            </span>
          </div>
        </Link>
        {agent ? (
          <AgentRowMetadata agent={agent} liveRun={liveRun} />
        ) : (
          <span className="w-20 flex shrink-0 justify-end">
            <StatusBadge status={node.status} />
          </span>
        )}
        {agent && (
          <AgentRowActionsMenu
            agent={agent}
            orgId={orgId}
            onCreateTask={() => onCreateTask(agent.id)}
            queryClient={queryClient}
            navigate={navigate}
            pushToast={pushToast}
          />
        )}
      </div>
      {node.reports && node.reports.length > 0 && (
        <div className="border-l border-border/50 ml-4">
          {node.reports.map((child) => (
            <OrgTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              agentMap={agentMap}
              liveRunByAgent={liveRunByAgent}
              orgId={orgId}
              onCreateTask={onCreateTask}
              queryClient={queryClient}
              navigate={navigate}
              pushToast={pushToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LiveRunIndicator({
  agentRef,
  runId,
  liveCount,
}: {
  agentRef: string;
  runId: string;
  liveCount: number;
}) {
  return (
    <Link
      to={`/agents/${agentRef}/runs/${runId}`}
      className="flex items-center gap-1.5 rounded-[calc(var(--radius-sm)-1px)] bg-blue-500/10 px-2 py-0.5 transition-colors no-underline hover:bg-blue-500/20"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="relative flex h-2 w-2">
        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
      </span>
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
        Live{liveCount > 1 ? ` (${liveCount})` : ""}
      </span>
    </Link>
  );
}
