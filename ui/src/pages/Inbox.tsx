import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { dashboardApi } from "../api/dashboard";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { chatsApi } from "../api/chats";
import { useOrganization } from "../context/OrganizationContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { retryHeartbeatRun } from "../lib/heartbeat-retry";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";

import { StatusIcon } from "../components/StatusIcon";
import { StatusBadge } from "../components/StatusBadge";
import { approvalLabel, defaultTypeIcon, typeIcon } from "../components/ApprovalPayload";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Inbox as InboxIcon,
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  ListFilter,
  MessageSquare,
  ShieldCheck,
  UserPlus,
  XCircle,
  X,
  RotateCcw,
} from "lucide-react";
import { PageTabBar } from "../components/PageTabBar";
import type { Approval, ChatConversation, HeartbeatRun, Issue, JoinRequest } from "@rudder/shared";
import {
  ACTIONABLE_APPROVAL_STATUSES,
  getApprovalsForTab,
  getInboxWorkItems,
  getLatestFailedRunsByAgent,
  getRecentTouchedIssues,
  InboxApprovalFilter,
  saveLastInboxTab,
  shouldShowInboxSection,
  type InboxTab,
} from "../lib/inbox";
import { useDismissedInboxItems } from "../hooks/useInboxBadge";

type InboxCategoryFilter =
  | "everything"
  | "issues_i_touched"
  | "chat_attention"
  | "join_requests"
  | "approvals"
  | "failed_runs"
  | "alerts";
type SectionKey =
  | "work_items"
  | "join_requests"
  | "alerts";

const CATEGORY_FILTER_OPTIONS = [
  { value: "everything", label: "All categories", icon: ListFilter },
  { value: "issues_i_touched", label: "My recent issues", icon: CircleDot },
  { value: "chat_attention", label: "Chats needing attention", icon: MessageSquare },
  { value: "join_requests", label: "Join requests", icon: UserPlus },
  { value: "approvals", label: "Approvals", icon: ShieldCheck },
  { value: "failed_runs", label: "Failed runs", icon: XCircle },
  { value: "alerts", label: "Alerts", icon: AlertTriangle },
] as const satisfies ReadonlyArray<{
  value: InboxCategoryFilter;
  label: string;
  icon: typeof ListFilter;
}>;

const APPROVAL_FILTER_OPTIONS = [
  { value: "all", label: "All approvals", icon: ShieldCheck },
  { value: "actionable", label: "Needs action", icon: CircleAlert },
  { value: "resolved", label: "Resolved", icon: CheckCircle2 },
] as const satisfies ReadonlyArray<{
  value: InboxApprovalFilter;
  label: string;
  icon: typeof ShieldCheck;
}>;

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const line = value.split("\n").map((chunk) => chunk.trim()).find(Boolean);
  return line ?? null;
}

function runFailureMessage(run: HeartbeatRun): string {
  return firstNonEmptyLine(run.error) ?? firstNonEmptyLine(run.stderrExcerpt) ?? "Run exited with an error.";
}

function approvalStatusLabel(status: Approval["status"]): string {
  return status.replaceAll("_", " ");
}

function readIssueIdFromRun(run: HeartbeatRun): string | null {
  const context = run.contextSnapshot;
  if (!context) return null;

  const issueId = context["issueId"];
  if (typeof issueId === "string" && issueId.length > 0) return issueId;

  const taskId = context["taskId"];
  if (typeof taskId === "string" && taskId.length > 0) return taskId;

  return null;
}

function InboxRowLeading({
  children,
}: {
  children: ReactNode;
}) {
  return <span className="flex h-5 w-6 shrink-0 items-center justify-center text-muted-foreground">{children}</span>;
}

function FailedRunInboxRow({
  run,
  issueById,
  agentName: linkedAgentName,
  issueLinkState,
  onDismiss,
  onRetry,
  isRetrying,
}: {
  run: HeartbeatRun;
  issueById: Map<string, Issue>;
  agentName: string | null;
  issueLinkState: unknown;
  onDismiss: () => void;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  const issueId = readIssueIdFromRun(run);
  const issue = issueId ? issueById.get(issueId) ?? null : null;
  const displayError = runFailureMessage(run);

  return (
    <div className="group border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2">
      <div className="flex items-start gap-2 sm:items-center">
        <Link
          to={`/agents/${run.agentId}/runs/${run.id}`}
          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-1 py-1 no-underline text-inherit transition-colors hover:bg-accent/50"
        >
          <InboxRowLeading>
            <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
          </InboxRowLeading>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">
                {issue ? (
                  <>
                    <span className="font-mono text-muted-foreground mr-1.5">
                      {issue.identifier ?? issue.id.slice(0, 8)}
                    </span>
                    {issue.title}
                  </>
                ) : (
                  <>Failed run{linkedAgentName ? ` — ${linkedAgentName}` : ""}</>
                )}
              </span>
              <span className="hidden min-w-0 truncate text-xs text-muted-foreground lg:inline">
                {displayError}
              </span>
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:mt-0">
              <StatusBadge status={run.status} />
              {linkedAgentName && issue ? <span>{linkedAgentName}</span> : null}
              <span>{timeAgo(run.createdAt)}</span>
            </span>
          </span>
        </Link>
        <div className="hidden shrink-0 items-center gap-2 sm:flex">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-2.5"
            onClick={onRetry}
            disabled={isRetrying}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {isRetrying ? "Retrying…" : "Retry"}
          </Button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="mt-3 flex gap-2 sm:hidden">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 px-2.5"
          onClick={onRetry}
          disabled={isRetrying}
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {isRetrying ? "Retrying…" : "Retry"}
        </Button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function ApprovalInboxRow({
  approval,
  requesterName,
  onApprove,
  onReject,
  isPending,
}: {
  approval: Approval;
  requesterName: string | null;
  onApprove: () => void;
  onReject: () => void;
  isPending: boolean;
}) {
  const Icon = typeIcon[approval.type] ?? defaultTypeIcon;
  const label = approvalLabel(approval.type, approval.payload as Record<string, unknown> | null);
  const showResolutionButtons =
    approval.type !== "budget_override_required" &&
    ACTIONABLE_APPROVAL_STATUSES.has(approval.status);

  return (
    <div className="border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2">
      <div className="flex items-start gap-2 sm:items-center">
        <Link
          to={`/messenger/approvals/${approval.id}`}
          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-1 py-1 no-underline text-inherit transition-colors hover:bg-accent/50"
        >
          <InboxRowLeading>
            <Icon className="h-4 w-4 text-muted-foreground" />
          </InboxRowLeading>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium">{label}</span>
            <span className="hidden min-w-0 items-center gap-2 text-xs text-muted-foreground sm:flex">
              <span className="capitalize">{approvalStatusLabel(approval.status)}</span>
              {requesterName ? <span className="truncate">requested by {requesterName}</span> : null}
            </span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">updated {timeAgo(approval.updatedAt)}</span>
        </Link>
        {showResolutionButtons ? (
          <div className="hidden shrink-0 items-center gap-2 sm:flex">
            <Button
              size="sm"
              className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
              onClick={onApprove}
              disabled={isPending}
            >
              Approve
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 px-3"
              onClick={onReject}
              disabled={isPending}
            >
              Reject
            </Button>
          </div>
        ) : null}
      </div>
      {showResolutionButtons ? (
        <div className="mt-3 flex gap-2 sm:hidden">
          <Button
            size="sm"
            className="h-8 bg-green-700 px-3 text-white hover:bg-green-600"
            onClick={onApprove}
            disabled={isPending}
          >
            Approve
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="h-8 px-3"
            onClick={onReject}
            disabled={isPending}
          >
            Reject
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ChatInboxRow({
  conversation,
}: {
  conversation: ChatConversation;
}) {
  const attentionLabel = conversation.isUnread
    ? conversation.unreadCount > 1
      ? `${conversation.unreadCount} new replies`
      : "New reply"
    : "Needs review";

  return (
    <div className="border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2">
      <Link
        to={`/chat/${conversation.id}`}
        className="flex min-w-0 items-center gap-2.5 rounded-md px-1 py-1 no-underline text-inherit transition-colors hover:bg-accent/50"
      >
        <InboxRowLeading>
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
        </InboxRowLeading>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium">{conversation.title}</span>
          {conversation.isUnread ? (
            <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Unread chat" />
          ) : null}
          <span className="hidden rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground/80 sm:inline-flex">
            {attentionLabel}
          </span>
          {conversation.isPinned ? <span className="hidden text-xs text-muted-foreground sm:inline">Pinned</span> : null}
          {conversation.primaryIssue ? (
            <span className="hidden truncate text-xs text-muted-foreground md:inline">
              {conversation.primaryIssue.identifier ?? conversation.primaryIssue.id}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">updated {timeAgo(conversation.lastMessageAt ?? conversation.updatedAt)}</span>
      </Link>
    </div>
  );
}

function IssueInboxRow({
  issue,
  issueLinkState,
  isLive,
  unreadState,
  onMarkRead,
  trailingMeta,
}: {
  issue: Issue;
  issueLinkState: unknown;
  isLive: boolean;
  unreadState: "hidden" | "visible" | "fading";
  onMarkRead: () => void;
  trailingMeta: string;
}) {
  const identifier = issue.identifier ?? issue.id.slice(0, 8);
  const showUnreadDot = unreadState === "visible" || unreadState === "fading";

  return (
    <div className="border-b border-border px-2 py-2.5 last:border-b-0 sm:px-1 sm:pr-3 sm:py-2">
      <div className="flex items-center gap-2">
        <Link
          to={`/issues/${issue.identifier ?? issue.id}`}
          state={issueLinkState}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 no-underline text-inherit transition-colors hover:bg-accent/50"
        >
          <InboxRowLeading>
            <StatusIcon status={issue.status} />
          </InboxRowLeading>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium">
              <span className="mr-1.5 font-mono text-xs font-normal text-muted-foreground">
                {identifier}
              </span>
              {issue.title}
            </span>
            {isLive ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 sm:gap-1.5 sm:px-2">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                </span>
                <span className="hidden text-[11px] font-medium text-blue-600 dark:text-blue-400 sm:inline">
                  Live
                </span>
              </span>
            ) : null}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{trailingMeta}</span>
        </Link>
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center self-center">
          {showUnreadDot ? (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMarkRead();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onMarkRead();
                }
              }}
              className="inline-flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-blue-500/20"
              aria-label="Mark as read"
            >
              <span
                className={
                  unreadState === "fading"
                    ? "block h-2 w-2 rounded-full bg-blue-600 opacity-0 transition-opacity duration-300 dark:bg-blue-400"
                    : "block h-2 w-2 rounded-full bg-blue-600 transition-opacity duration-300 dark:bg-blue-400"
                }
              />
            </button>
          ) : (
            <span className="inline-flex h-4 w-4" aria-hidden="true" />
          )}
        </span>
      </div>
    </div>
  );
}

export function Inbox() {
  const { selectedOrganizationId } = useOrganization();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);
  const [allCategoryFilter, setAllCategoryFilter] = useState<InboxCategoryFilter>("everything");
  const [allApprovalFilter, setAllApprovalFilter] = useState<InboxApprovalFilter>("all");
  const { dismissed, dismiss } = useDismissedInboxItems();

  const pathSegment = location.pathname.split("/").pop() ?? "recent";
  const tab: InboxTab =
    pathSegment === "all" || pathSegment === "unread" ? pathSegment : "recent";
  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Inbox",
        `${location.pathname}${location.search}${location.hash}`,
      ),
    [location.pathname, location.search, location.hash],
  );

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedOrganizationId!),
    queryFn: () => agentsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Inbox" }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    saveLastInboxTab(tab);
  }, [tab]);

  const {
    data: approvals,
    isLoading: isApprovalsLoading,
    error: approvalsError,
  } = useQuery({
    queryKey: queryKeys.approvals.list(selectedOrganizationId!),
    queryFn: () => approvalsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const {
    data: joinRequests = [],
    isLoading: isJoinRequestsLoading,
  } = useQuery({
    queryKey: queryKeys.access.joinRequests(selectedOrganizationId!),
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(selectedOrganizationId!, "pending_approval");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
          return [];
        }
        throw err;
      }
    },
    enabled: !!selectedOrganizationId,
    retry: false,
  });

  const { data: dashboard, isLoading: isDashboardLoading } = useQuery({
    queryKey: queryKeys.dashboard(selectedOrganizationId!),
    queryFn: () => dashboardApi.summary(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: issues, isLoading: isIssuesLoading } = useQuery({
    queryKey: queryKeys.issues.list(selectedOrganizationId!),
    queryFn: () => issuesApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });
  const {
    data: touchedIssuesRaw = [],
    isLoading: isTouchedIssuesLoading,
  } = useQuery({
    queryKey: queryKeys.issues.listTouchedByMe(selectedOrganizationId!),
    queryFn: () =>
      issuesApi.list(selectedOrganizationId!, {
        touchedByUserId: "me",
        status: "backlog,todo,in_progress,in_review,blocked,done",
      }),
    enabled: !!selectedOrganizationId,
  });

  const { data: heartbeatRuns, isLoading: isRunsLoading } = useQuery({
    queryKey: queryKeys.heartbeats(selectedOrganizationId!),
    queryFn: () => heartbeatsApi.list(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const { data: chats = [], isLoading: isChatsLoading } = useQuery({
    queryKey: queryKeys.chats.list(selectedOrganizationId!, "active"),
    queryFn: () => chatsApi.list(selectedOrganizationId!, "active"),
    enabled: !!selectedOrganizationId,
  });

  const touchedIssues = useMemo(() => getRecentTouchedIssues(touchedIssuesRaw), [touchedIssuesRaw]);
  const unreadTouchedIssues = useMemo(
    () => touchedIssues.filter((issue) => issue.isUnreadForMe),
    [touchedIssues],
  );
  const issuesToRender = useMemo(
    () => (tab === "unread" ? unreadTouchedIssues : touchedIssues),
    [tab, touchedIssues, unreadTouchedIssues],
  );

  const agentById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const issue of issues ?? []) map.set(issue.id, issue);
    return map;
  }, [issues]);

  const failedRuns = useMemo(
    () => getLatestFailedRunsByAgent(heartbeatRuns ?? []).filter((r) => !dismissed.has(`run:${r.id}`)),
    [heartbeatRuns, dismissed],
  );
  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of heartbeatRuns ?? []) {
      if (run.status !== "running" && run.status !== "queued") continue;
      const issueId = readIssueIdFromRun(run);
      if (issueId) ids.add(issueId);
    }
    return ids;
  }, [heartbeatRuns]);

  const approvalsToRender = useMemo(
    () => getApprovalsForTab(approvals ?? [], tab, allApprovalFilter),
    [approvals, tab, allApprovalFilter],
  );
  const showJoinRequestsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "join_requests";
  const showTouchedCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "issues_i_touched";
  const showChatsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "chat_attention";
  const showApprovalsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "approvals";
  const showFailedRunsCategory =
    allCategoryFilter === "everything" || allCategoryFilter === "failed_runs";
  const showAlertsCategory = allCategoryFilter === "everything" || allCategoryFilter === "alerts";
  const failedRunsForTab = useMemo(() => {
    if (tab === "all" && !showFailedRunsCategory) return [];
    return failedRuns;
  }, [failedRuns, tab, showFailedRunsCategory]);

  const attentionChats = useMemo(
    () => chats.filter((conversation) => conversation.needsAttention),
    [chats],
  );

  const workItemsToRender = useMemo(
    () =>
      getInboxWorkItems({
        issues: tab === "all" && !showTouchedCategory ? [] : issuesToRender,
        chats: tab === "all" && !showChatsCategory ? [] : attentionChats,
        approvals: tab === "all" && !showApprovalsCategory ? [] : approvalsToRender,
        failedRuns: failedRunsForTab,
      }),
    [
      approvalsToRender,
      issuesToRender,
      attentionChats,
      showApprovalsCategory,
      showChatsCategory,
      showTouchedCategory,
      tab,
      failedRunsForTab,
    ],
  );

  const agentName = (id: string | null) => {
    if (!id) return null;
    return agentById.get(id) ?? null;
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedOrganizationId!) });
      navigate(`/messenger/approvals/${id}?resolved=approved`);
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedOrganizationId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
    },
  });

  const approveJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) =>
      accessApi.approveJoinRequest(selectedOrganizationId!, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedOrganizationId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedOrganizationId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedOrganizationId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve join request");
    },
  });

  const rejectJoinMutation = useMutation({
    mutationFn: (joinRequest: JoinRequest) =>
      accessApi.rejectJoinRequest(selectedOrganizationId!, joinRequest.id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(selectedOrganizationId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedOrganizationId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject join request");
    },
  });

  const [retryingRunIds, setRetryingRunIds] = useState<Set<string>>(new Set());

  const retryRunMutation = useMutation({
    mutationFn: async (run: HeartbeatRun) => ({
      newRun: await retryHeartbeatRun(run),
      originalRun: run,
    }),
    onMutate: (run) => {
      setRetryingRunIds((prev) => new Set(prev).add(run.id));
    },
    onSuccess: ({ newRun, originalRun }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(originalRun.orgId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(originalRun.orgId, originalRun.agentId) });
      navigate(`/agents/${originalRun.agentId}/runs/${newRun.id}`);
    },
    onSettled: (_data, _error, run) => {
      if (!run) return;
      setRetryingRunIds((prev) => {
        const next = new Set(prev);
        next.delete(run.id);
        return next;
      });
    },
  });

  const [fadingOutIssues, setFadingOutIssues] = useState<Set<string>>(new Set());

  const invalidateInboxIssueQueries = () => {
    if (!selectedOrganizationId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedOrganizationId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedOrganizationId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedOrganizationId) });
  };

  const markReadMutation = useMutation({
    mutationFn: (id: string) => issuesApi.markRead(id),
    onMutate: (id) => {
      setFadingOutIssues((prev) => new Set(prev).add(id));
    },
    onSuccess: () => {
      invalidateInboxIssueQueries();
    },
    onSettled: (_data, _error, id) => {
      setTimeout(() => {
        setFadingOutIssues((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, 300);
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: async (issueIds: string[]) => {
      await Promise.all(issueIds.map((issueId) => issuesApi.markRead(issueId)));
    },
    onMutate: (issueIds) => {
      setFadingOutIssues((prev) => {
        const next = new Set(prev);
        for (const issueId of issueIds) next.add(issueId);
        return next;
      });
    },
    onSuccess: () => {
      invalidateInboxIssueQueries();
    },
    onSettled: (_data, _error, issueIds) => {
      setTimeout(() => {
        setFadingOutIssues((prev) => {
          const next = new Set(prev);
          for (const issueId of issueIds) next.delete(issueId);
          return next;
        });
      }, 300);
    },
  });

  if (!selectedOrganizationId) {
    return <EmptyState icon={InboxIcon} message="Select a organization to view inbox." />;
  }

  const hasRunFailures = failedRuns.length > 0;
  const showAggregateAgentError = !!dashboard && dashboard.agents.error > 0 && !hasRunFailures && !dismissed.has("alert:agent-errors");
  const showBudgetAlert =
    !!dashboard &&
    dashboard.costs.monthBudgetCents > 0 &&
    dashboard.costs.monthUtilizationPercent >= 80 &&
    !dismissed.has("alert:budget");
  const hasAlerts = showAggregateAgentError || showBudgetAlert;
  const hasJoinRequests = joinRequests.length > 0;
  const showWorkItemsSection = workItemsToRender.length > 0;
  const showJoinRequestsSection =
    tab === "all" ? showJoinRequestsCategory && hasJoinRequests : tab === "unread" && hasJoinRequests;
  const showAlertsSection = shouldShowInboxSection({
    tab,
    hasItems: hasAlerts,
    showOnRecent: hasAlerts,
    showOnUnread: hasAlerts,
    showOnAll: showAlertsCategory && hasAlerts,
  });

  const visibleSections = [
    showAlertsSection ? "alerts" : null,
    showJoinRequestsSection ? "join_requests" : null,
    showWorkItemsSection ? "work_items" : null,
  ].filter((key): key is SectionKey => key !== null);

  const allLoaded =
    !isJoinRequestsLoading &&
    !isApprovalsLoading &&
    !isDashboardLoading &&
    !isIssuesLoading &&
    !isTouchedIssuesLoading &&
    !isRunsLoading &&
    !isChatsLoading;

  const showSeparatorBefore = (key: SectionKey) => visibleSections.indexOf(key) > 0;
  const unreadIssueIds = unreadTouchedIssues
    .filter((issue) => !fadingOutIssues.has(issue.id))
    .map((issue) => issue.id);
  const canMarkAllRead = unreadIssueIds.length > 0;
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={tab} onValueChange={(value) => navigate(`/inbox/${value}`)}>
            <PageTabBar
              items={[
                {
                  value: "recent",
                  label: "Recent",
                },
                { value: "unread", label: "Unread" },
                { value: "all", label: "All" },
              ]}
            />
          </Tabs>

          {canMarkAllRead && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => markAllReadMutation.mutate(unreadIssueIds)}
              disabled={markAllReadMutation.isPending}
            >
              {markAllReadMutation.isPending ? "Marking…" : "Mark all as read"}
            </Button>
          )}
        </div>

        {tab === "all" && (
          <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
            <Select
              value={allCategoryFilter}
              onValueChange={(value) => setAllCategoryFilter(value as InboxCategoryFilter)}
            >
              <SelectTrigger size="sm" className="w-[180px] text-xs">
                <ListFilter className="h-3.5 w-3.5 text-muted-foreground" />
                <SelectValue placeholder="All categories" />
              </SelectTrigger>
              <SelectContent className="min-w-[220px]">
                {CATEGORY_FILTER_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    icon={<option.icon className="h-4 w-4" />}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {showApprovalsCategory && (
              <Select
                value={allApprovalFilter}
                onValueChange={(value) => setAllApprovalFilter(value as InboxApprovalFilter)}
              >
                <SelectTrigger size="sm" className="w-[180px] text-xs">
                  <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
                  <SelectValue placeholder="All approvals" />
                </SelectTrigger>
                <SelectContent className="min-w-[220px]">
                  {APPROVAL_FILTER_OPTIONS.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      icon={<option.icon className="h-4 w-4" />}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
      </div>

      {approvalsError && <p className="text-sm text-destructive">{approvalsError.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {!allLoaded && visibleSections.length === 0 && (
        <PageSkeleton variant="inbox" />
      )}

      {allLoaded && visibleSections.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          message={
            tab === "unread"
              ? "No new inbox items."
              : tab === "recent"
                ? "No recent inbox items."
                : "No inbox items match these filters."
          }
        />
      )}

      {showWorkItemsSection && (
        <>
          {showSeparatorBefore("work_items") && <Separator />}
          <div>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {workItemsToRender.map((item) => {
                if (item.kind === "approval") {
                  return (
                    <ApprovalInboxRow
                      key={`approval:${item.approval.id}`}
                      approval={item.approval}
                      requesterName={agentName(item.approval.requestedByAgentId)}
                      onApprove={() => approveMutation.mutate(item.approval.id)}
                      onReject={() => rejectMutation.mutate(item.approval.id)}
                      isPending={approveMutation.isPending || rejectMutation.isPending}
                    />
                  );
                }

                if (item.kind === "failed_run") {
                  return (
                    <FailedRunInboxRow
                      key={`run:${item.run.id}`}
                      run={item.run}
                      issueById={issueById}
                      agentName={agentName(item.run.agentId)}
                      issueLinkState={issueLinkState}
                      onDismiss={() => dismiss(`run:${item.run.id}`)}
                      onRetry={() => retryRunMutation.mutate(item.run)}
                      isRetrying={retryingRunIds.has(item.run.id)}
                    />
                  );
                }

                if (item.kind === "chat") {
                  return (
                    <ChatInboxRow
                      key={`chat:${item.conversation.id}`}
                      conversation={item.conversation}
                    />
                  );
                }

                const issue = item.issue;
                const isUnread = issue.isUnreadForMe && !fadingOutIssues.has(issue.id);
                const isFading = fadingOutIssues.has(issue.id);
                return (
                  <IssueInboxRow
                    key={`issue:${issue.id}`}
                    issue={issue}
                    issueLinkState={issueLinkState}
                    isLive={liveIssueIds.has(issue.id)}
                    unreadState={isUnread ? "visible" : isFading ? "fading" : "hidden"}
                    onMarkRead={() => markReadMutation.mutate(issue.id)}
                    trailingMeta={
                      issue.lastExternalCommentAt
                        ? `commented ${timeAgo(issue.lastExternalCommentAt)}`
                        : `updated ${timeAgo(issue.updatedAt)}`
                    }
                  />
                );
              })}
            </div>
          </div>
        </>
      )}

      {showJoinRequestsSection && (
        <>
          {showSeparatorBefore("join_requests") && <Separator />}
          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
              Join Requests
            </h3>
            <div className="grid gap-3">
              {joinRequests.map((joinRequest) => (
                <div key={joinRequest.id} className="rounded-xl border border-border bg-card p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        {joinRequest.requestType === "human"
                          ? "Human join request"
                          : `Agent join request${joinRequest.agentName ? `: ${joinRequest.agentName}` : ""}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        requested {timeAgo(joinRequest.createdAt)} from IP {joinRequest.requestIp}
                      </p>
                      {joinRequest.requestEmailSnapshot && (
                        <p className="text-xs text-muted-foreground">
                          email: {joinRequest.requestEmailSnapshot}
                        </p>
                      )}
                      {joinRequest.agentRuntimeType && (
                        <p className="text-xs text-muted-foreground">adapter: {joinRequest.agentRuntimeType}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={approveJoinMutation.isPending || rejectJoinMutation.isPending}
                        onClick={() => rejectJoinMutation.mutate(joinRequest)}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        disabled={approveJoinMutation.isPending || rejectJoinMutation.isPending}
                        onClick={() => approveJoinMutation.mutate(joinRequest)}
                      >
                        Approve
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}


      {showAlertsSection && (
        <>
          {showSeparatorBefore("alerts") && <Separator />}
          <div>
            <h3 className="mb-3 text-sm font-semibold text-muted-foreground">
              Alerts
            </h3>
            <div className="divide-y divide-border border border-border">
              {showAggregateAgentError && (
                <div className="group/alert relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Link
                    to="/agents"
                    className="flex flex-1 cursor-pointer items-center gap-3 no-underline text-inherit"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                    <span className="text-sm">
                      <span className="font-medium">{dashboard!.agents.error}</span>{" "}
                      {dashboard!.agents.error === 1 ? "agent has" : "agents have"} errors
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismiss("alert:agent-errors")}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/alert:opacity-100"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
              {showBudgetAlert && (
                <div className="group/alert relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50">
                  <Link
                    to="/costs"
                    className="flex flex-1 cursor-pointer items-center gap-3 no-underline text-inherit"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-400" />
                    <span className="text-sm">
                      Budget at{" "}
                      <span className="font-medium">{dashboard!.costs.monthUtilizationPercent}%</span>{" "}
                      utilization this month
                    </span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => dismiss("alert:budget")}
                    className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/alert:opacity-100"
                    aria-label="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}

    </div>
  );
}
