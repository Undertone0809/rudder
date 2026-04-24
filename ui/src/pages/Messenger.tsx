import { type ReactNode, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CircleAlert,
  MessageSquare,
  RefreshCcw,
  Send,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import type { MessengerApprovalThreadItem, MessengerEvent, MessengerIssueThreadItem } from "@rudderhq/shared";
import { accessApi } from "@/api/access";
import { approvalsApi } from "@/api/approvals";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { ApprovalCard } from "@/components/ApprovalCard";
import { ApprovalDetailDialog } from "@/components/ApprovalDetailDialog";
import { Button } from "@/components/ui/button";
import { HoverTimestampLabel } from "@/components/HoverTimestamp";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/StatusBadge";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import {
  messengerThreadKindLabel,
  resolveMessengerRoute,
  useMessengerModel,
} from "@/hooks/useMessenger";
import { queryKeys } from "@/lib/queryKeys";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { getRememberedMessengerPath, rememberMessengerPath, resolveRememberedMessengerEntry } from "@/lib/messenger-memory";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { relativeTime } from "@/lib/utils";

function firstNonEmptyLine(value: string | null | undefined): string | null {
  if (!value) return null;
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

function invalidateMessengerQueries(queryClient: ReturnType<typeof useQueryClient>, orgId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(orgId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.messenger.issues(orgId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.messenger.approvals(orgId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.messenger.system(orgId, "failed-runs") }),
    queryClient.invalidateQueries({ queryKey: queryKeys.messenger.system(orgId, "budget-alerts") }),
    queryClient.invalidateQueries({ queryKey: queryKeys.messenger.system(orgId, "join-requests") }),
  ]);
}

function formatThreadDate(date: Date) {
  const normalized = new Date(date);
  const today = new Date();
  if (today.toDateString() === normalized.toDateString()) return "Today";

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (yesterday.toDateString() === normalized.toDateString()) return "Yesterday";

  return normalized.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function messengerScrollContainer(): HTMLElement | Window | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const mainContent = document.getElementById("main-content");
  if (!mainContent) return window;

  const overflowY = window.getComputedStyle(mainContent).overflowY;
  const isScrollable = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
  return isScrollable ? mainContent : window;
}

function scrollMessengerThreadToBottom() {
  const container = messengerScrollContainer();
  if (!container) return;
  if (container === window) {
    const pageHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
    );
    window.scrollTo({ top: pageHeight, behavior: "auto" });
    return;
  }

  const element = container as HTMLElement;
  element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
}

function issueDisplayTitle(item: MessengerIssueThreadItem) {
  if (!item.issueIdentifier) return item.title;
  const prefix = `${item.issueIdentifier} · `;
  return item.title.startsWith(prefix) ? item.title.slice(prefix.length) : item.title;
}

function issueContextLabel(item: MessengerIssueThreadItem) {
  const metadata = item.metadata as { followed?: boolean; createdByMe?: boolean; assignedToMe?: boolean };
  const labels: string[] = [];
  if (metadata.followed) labels.push("followed");
  if (metadata.createdByMe) labels.push("created by me");
  if (metadata.assignedToMe && !metadata.createdByMe) labels.push("assigned to me");
  return labels.join(" · ");
}

function failedRunIssueTitle(metadata: Record<string, unknown>) {
  if (!metadata.contextSnapshot || typeof metadata.contextSnapshot !== "object") return null;
  const snapshot = metadata.contextSnapshot as Record<string, unknown>;
  if (!snapshot.issue || typeof snapshot.issue !== "object") return null;
  const issue = snapshot.issue as Record<string, unknown>;
  return typeof issue.title === "string" && issue.title.trim().length > 0 ? issue.title.trim() : null;
}

function TimelineDivider({ date }: { date: Date }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-border/70" />
      <span className="text-[11px] font-medium text-muted-foreground">
        {formatThreadDate(date)}
      </span>
      <div className="h-px flex-1 bg-border/70" />
    </div>
  );
}

function ThreadMessage({
  icon,
  label,
  timestamp,
  children,
  testId,
}: {
  icon: ReactNode;
  label: string;
  timestamp?: Date | string | null;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="group flex items-start gap-3">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_84%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_88%,transparent)] text-[color:var(--accent-strong)] shadow-[var(--shadow-sm)]">
        {icon}
      </div>
      <div className="min-w-0 max-w-4xl flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {timestamp ? (
            <HoverTimestampLabel
              date={timestamp}
              label={relativeTime(new Date(timestamp))}
              className="text-[11px] leading-none text-muted-foreground"
              testId={testId ? `${testId}-timestamp` : undefined}
            />
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}

function ObjectMessageCard({
  eyebrow,
  title,
  description,
  status,
  children,
  footer,
  testId,
}: {
  eyebrow: string;
  title: string;
  description: string | null;
  status?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="overflow-hidden rounded-[var(--radius-md)] border border-border/70 bg-background shadow-[var(--shadow-sm)]"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-[color:color-mix(in_oklab,var(--surface-inset)_78%,white)] px-4 py-2">
        <span className="rounded-[calc(var(--radius-sm)-1px)] bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          {eyebrow}
        </span>
        {status}
      </div>
      <div className="space-y-3 px-4 py-3.5">
        <div className="space-y-1">
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h2>
          {description ? <p className="text-sm leading-5 text-muted-foreground">{description}</p> : null}
        </div>
        {children}
      </div>
      {footer ? <div className="border-t border-border/60 px-4 py-2.5">{footer}</div> : null}
    </div>
  );
}

function TimelineStream<T extends { id: string; latestActivityAt: Date | string }>({
  items,
  renderItem,
}: {
  items: T[];
  renderItem: (item: T) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      {items.map((item, index) => {
        const previous = items[index - 1];
        const showDivider =
          index === 0 || new Date(previous.latestActivityAt).toDateString() !== new Date(item.latestActivityAt).toDateString();
        return (
          <div key={item.id} className="space-y-5">
            {showDivider ? <TimelineDivider date={new Date(item.latestActivityAt)} /> : null}
            {renderItem(item)}
          </div>
        );
      })}
    </div>
  );
}

export function MessengerPanelHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div data-testid="messenger-panel-header" className="flex flex-col gap-2 border-b border-border/70 pb-3.5">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold tracking-tight text-foreground">{title}</h1>
        <p data-testid="messenger-panel-description" className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function ThreadEmptyStateMessage({
  icon,
  assistantLabel,
  eyebrow,
  title,
  description,
}: {
  icon: ReactNode;
  assistantLabel: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <ThreadMessage icon={icon} label={assistantLabel}>
      <ObjectMessageCard eyebrow={eyebrow} title={title} description={description}>
        <div className="rounded-[calc(var(--radius-sm)-1px)] border border-dashed border-border/70 bg-[color:color-mix(in_oklab,var(--surface-inset)_74%,white)] px-3 py-2.5 text-sm text-muted-foreground">
          Nothing here yet.
        </div>
      </ObjectMessageCard>
    </ThreadMessage>
  );
}

function MessengerIssueCard({
  item,
  orgId,
}: {
  item: MessengerIssueThreadItem;
  orgId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [quickCommentOpen, setQuickCommentOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const metadata = item.metadata as {
    status?: string;
    priority?: string;
  };
  const contextLabel = issueContextLabel(item);

  const invalidateIssueViews = async () => {
    await Promise.all([
      invalidateMessengerQueries(queryClient, orgId),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(item.issueId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(item.issueId) }),
    ]);
  };

  const commentMutation = useMutation({
    mutationFn: async () => issuesApi.addComment(item.issueId, draft.trim()),
    onSuccess: async () => {
      setDraft("");
      setQuickCommentOpen(false);
      await invalidateIssueViews();
    },
    onError: (error) => {
      pushToast({
        title: "Failed to post comment",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  return (
    <ThreadMessage
      icon={<MessageSquare className="h-5 w-5" />}
      label="Issues assistant"
      timestamp={new Date(item.latestActivityAt)}
      testId={`messenger-issue-message-${item.issueId}`}
    >
      <ObjectMessageCard
        eyebrow="Issue update"
        title={issueDisplayTitle(item)}
        description={firstNonEmptyLine(item.body) ?? firstNonEmptyLine(item.preview) ?? "New issue activity in your watched scope."}
        status={typeof metadata.status === "string" ? <StatusBadge status={metadata.status} /> : undefined}
        testId={`messenger-issue-card-${item.issueId}`}
        footer={
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <Link to={item.href ?? `/issues/${item.issueIdentifier ?? item.issueId}`}>Open issue</Link>
              </Button>
              <Button
                size="sm"
                onClick={() => setQuickCommentOpen((open) => !open)}
                data-testid={`messenger-quick-comment-toggle-${item.issueId}`}
              >
                Quick comment
              </Button>
            </div>
            {quickCommentOpen ? (
              <div className="space-y-2 rounded-[calc(var(--radius-sm)-1px)] border border-border/70 bg-muted/20 p-3">
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Add a quick comment"
                  rows={4}
                  data-testid={`messenger-quick-comment-input-${item.issueId}`}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => commentMutation.mutate()}
                    disabled={draft.trim().length === 0 || commentMutation.isPending}
                    data-testid={`messenger-quick-comment-submit-${item.issueId}`}
                  >
                    <Send className="h-4 w-4" />
                    {commentMutation.isPending ? "Posting…" : "Comment"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setQuickCommentOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        }
      >
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-[calc(var(--radius-sm)-1px)] bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            {item.issueIdentifier ?? item.issueId.slice(0, 8)}
          </span>
          {typeof metadata.priority === "string" ? (
            <span className="rounded-[calc(var(--radius-sm)-1px)] bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {metadata.priority.replaceAll("_", " ")}
            </span>
          ) : null}
          {contextLabel ? (
            <span className="rounded-[calc(var(--radius-sm)-1px)] bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
              {contextLabel}
            </span>
          ) : null}
        </div>
      </ObjectMessageCard>
    </ThreadMessage>
  );
}

export function MessengerIssuesView() {
  const { selectedOrganizationId, issueThreadDetail } = useMessengerModel();

  if (!selectedOrganizationId) return null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <MessengerPanelHeader
        title="Issues"
        description={issueThreadDetail?.description ?? "Followed issues, issues I created, and issues assigned to me."}
      />
      <TimelineStream
        items={issueThreadDetail?.items ?? []}
        renderItem={(item) => <MessengerIssueCard key={item.id} item={item} orgId={selectedOrganizationId} />}
      />
      {!issueThreadDetail?.items.length ? (
        <ThreadEmptyStateMessage
          icon={<MessageSquare className="h-5 w-5" />}
          assistantLabel="Issues assistant"
          eyebrow="Issues"
          title="No tracked issues"
          description="Once you create an issue, follow it, or it gets assigned to you, it will show up here as an object thread."
        />
      ) : null}
    </div>
  );
}

function MessengerApprovalCard({
  item,
  orgId,
}: {
  item: MessengerApprovalThreadItem;
  orgId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const pending = item.approval.status === "pending" || item.approval.status === "revision_requested";

  const invalidateApprovalViews = async () => {
    await Promise.all([
      invalidateMessengerQueries(queryClient, orgId),
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(item.approval.id) }),
    ]);
  };

  const decisionMutation = useMutation({
    mutationFn: async (decision: "approve" | "reject" | "requestRevision") => {
      if (decision === "approve") return approvalsApi.approve(item.approval.id);
      if (decision === "reject") return approvalsApi.reject(item.approval.id);
      return approvalsApi.requestRevision(item.approval.id);
    },
    onSuccess: invalidateApprovalViews,
    onError: (error) => {
      pushToast({
        title: "Failed to update approval",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  return (
    <ThreadMessage
      icon={<ShieldCheck className="h-5 w-5" />}
      label="Approvals assistant"
      timestamp={new Date(item.latestActivityAt)}
      testId={`messenger-approval-message-${item.id}`}
    >
      <div data-testid={`messenger-approval-card-${item.id}`}>
        <ApprovalCard
          approval={item.approval}
          requesterAgent={null}
          onApprove={() => decisionMutation.mutate("approve")}
          onReject={() => decisionMutation.mutate("reject")}
          onRequestRevision={pending ? () => decisionMutation.mutate("requestRevision") : undefined}
          detailLink={`/messenger/approvals/${item.approval.id}`}
          detailLabel="Open full approval"
          supportingText={item.subtitle ?? "Approval update"}
          allowBudgetActions
          isPending={decisionMutation.isPending}
        />
      </div>
    </ThreadMessage>
  );
}

export function MessengerApprovalsView() {
  const { selectedOrganizationId, approvalThreadDetail } = useMessengerModel();
  const { approvalId } = useParams<{ approvalId?: string }>();
  const navigate = useNavigate();

  if (!selectedOrganizationId) return null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <MessengerPanelHeader
        title="Approvals"
        description="Approval objects stay inside the thread so decisions happen without losing context."
      />
      <TimelineStream
        items={approvalThreadDetail?.items ?? []}
        renderItem={(item) => <MessengerApprovalCard key={item.id} item={item} orgId={selectedOrganizationId} />}
      />
      {!approvalThreadDetail?.items.length ? (
        <ThreadEmptyStateMessage
          icon={<ShieldCheck className="h-5 w-5" />}
          assistantLabel="Approvals assistant"
          eyebrow="Approvals"
          title="No approvals waiting here"
          description="Pending or recently updated approvals will appear in this thread as soon as they need operator attention."
        />
      ) : null}
      <ApprovalDetailDialog
        approvalId={approvalId ?? null}
        open={Boolean(approvalId)}
        onOpenChange={(nextOpen) => {
          if (nextOpen) return;
          navigate("/messenger/approvals", { replace: true });
        }}
      />
    </div>
  );
}

async function runSystemAction(action: MessengerEvent["actions"][number]) {
  if (!action.href || action.method !== "POST") {
    throw new Error("Unsupported Messenger action.");
  }

  const retryMatch = action.href.match(/^\/heartbeat-runs\/([^/]+)\/retry$/);
  if (retryMatch) {
    await heartbeatsApi.retry(retryMatch[1] ?? "");
    return;
  }

  const joinRequestMatch = action.href.match(/^\/orgs\/([^/]+)\/join-requests\/([^/]+)\/(approve|reject)$/);
  if (joinRequestMatch) {
    const [, orgId, requestId, decision] = joinRequestMatch;
    if (!orgId || !requestId || !decision) return;
    if (decision === "approve") {
      await accessApi.approveJoinRequest(orgId, requestId);
      return;
    }
    await accessApi.rejectJoinRequest(orgId, requestId);
    return;
  }

  throw new Error(`Unsupported Messenger action: ${action.label}`);
}

function systemThreadIcon(kind: MessengerEvent["kind"]) {
  switch (kind) {
    case "failed-runs":
      return <AlertTriangle className="h-5 w-5" />;
    case "join-requests":
      return <UserPlus className="h-5 w-5" />;
    case "budget-alerts":
      return <CircleAlert className="h-5 w-5" />;
    default:
      return <RefreshCcw className="h-5 w-5" />;
  }
}

function systemAssistantLabel(kind: MessengerEvent["kind"]) {
  switch (kind) {
    case "failed-runs":
      return "Runs assistant";
    case "join-requests":
      return "Access assistant";
    case "budget-alerts":
      return "Budget assistant";
    default:
      return "System assistant";
  }
}

function MessengerSystemCard({
  item,
  orgId,
}: {
  item: MessengerEvent;
  orgId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const metadata = item.metadata as Record<string, unknown>;
  const relatedIssueId =
    item.kind === "failed-runs" &&
    metadata.contextSnapshot &&
    typeof metadata.contextSnapshot === "object" &&
    typeof (metadata.contextSnapshot as Record<string, unknown>).issueId === "string"
      ? ((metadata.contextSnapshot as Record<string, unknown>).issueId as string)
      : null;
  const relatedIssueTitle = item.kind === "failed-runs" ? failedRunIssueTitle(metadata) : null;

  const actionMutation = useMutation({
    mutationFn: async (action: MessengerEvent["actions"][number]) => runSystemAction(action),
    onSuccess: async (_data, action) => {
      await invalidateMessengerQueries(queryClient, orgId);
      if (item.kind === "join-requests") {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.access.joinRequests(orgId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(orgId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(orgId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.organizations.all }),
        ]);
      }
      if (item.kind === "failed-runs") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(orgId) });
      }
      pushToast({ title: action.label, body: "Completed.", tone: "success" });
    },
    onError: (error, action) => {
      pushToast({
        title: `Failed to ${action.label.toLowerCase()}`,
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });

  return (
    <ThreadMessage
      icon={systemThreadIcon(item.kind)}
      label={systemAssistantLabel(item.kind)}
      timestamp={new Date(item.latestActivityAt)}
      testId={`messenger-system-message-${item.kind}-${item.id}`}
    >
      <ObjectMessageCard
        eyebrow={messengerThreadKindLabel(item.kind)}
        title={item.title}
        description={item.body ?? item.preview ?? "No details available."}
        status={typeof metadata.status === "string" ? <StatusBadge status={metadata.status} /> : undefined}
        testId={`messenger-system-card-${item.kind}-${item.id}`}
        footer={
          <div className="flex flex-wrap items-center gap-2">
            {item.actions.map((action) => {
              if (action.method === "GET" && action.href) {
                return (
                  <Button key={`${item.id}-${action.label}`} asChild size="sm" variant="outline">
                    <Link to={action.href}>{action.label}</Link>
                  </Button>
                );
              }

              return (
                <Button
                  key={`${item.id}-${action.label}`}
                  size="sm"
                  variant="outline"
                  onClick={() => actionMutation.mutate(action)}
                  disabled={actionMutation.isPending}
                >
                  {action.label}
                </Button>
              );
            })}
          </div>
        }
      >
        <div className="flex flex-col gap-2 text-xs">
          {relatedIssueTitle && relatedIssueId ? (
            <div className="text-xs text-muted-foreground">
              Issue{" "}
              <Link
                to={`/issues/${relatedIssueId}`}
                className="font-medium text-blue-700 underline-offset-4 hover:text-blue-800 hover:underline dark:text-blue-300 dark:hover:text-blue-200"
                data-testid={`messenger-failed-run-issue-title-${item.id}`}
              >
                {relatedIssueTitle}
              </Link>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {typeof metadata.requestType === "string" ? (
              <span className="rounded-[calc(var(--radius-sm)-1px)] bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {metadata.requestType.replaceAll("_", " ")}
              </span>
            ) : null}
            {typeof metadata.pauseReason === "string" ? (
              <span className="rounded-[calc(var(--radius-sm)-1px)] bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {metadata.pauseReason.replaceAll("_", " ")}
              </span>
            ) : null}
          </div>
        </div>
      </ObjectMessageCard>
    </ThreadMessage>
  );
}

export function MessengerSystemView({ threadKind }: { threadKind: string }) {
  const { selectedOrganizationId, systemThreadDetail } = useMessengerModel();

  if (!selectedOrganizationId || !systemThreadDetail) return null;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <MessengerPanelHeader
        title={systemThreadDetail.title}
        description={systemThreadDetail.description ?? ""}
      />
      <TimelineStream
        items={systemThreadDetail.items}
        renderItem={(item) => <MessengerSystemCard key={item.id} item={item} orgId={selectedOrganizationId} />}
      />
      {!systemThreadDetail.items.length ? (
        <ThreadEmptyStateMessage
          icon={systemThreadIcon(threadKind as MessengerEvent["kind"])}
          assistantLabel={systemAssistantLabel(threadKind as MessengerEvent["kind"])}
          eyebrow={systemThreadDetail.title}
          title={`No ${systemThreadDetail.title.toLowerCase()} yet`}
          description={systemThreadDetail.description ?? "This thread will populate when the system has something real to surface."}
        />
      ) : null}
    </div>
  );
}

export function Messenger() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const relativePath = toOrganizationRelativePath(location.pathname);
  const route = resolveMessengerRoute(relativePath);
  const { setBreadcrumbs } = useBreadcrumbs();
  const {
    isLoading,
    error,
    selectedOrganizationId,
    threadSummaries,
    issueThreadDetail,
    approvalThreadDetail,
    systemThreadDetail,
  } = useMessengerModel();
  const pendingAutoScrollThreadRef = useRef<string | null>(null);
  const completedAutoScrollThreadRef = useRef<string | null>(null);
  const activeThreadKey =
    route.kind === "issues"
      ? "issues"
      : route.kind === "approvals"
        ? "approvals"
        : route.kind === "system"
          ? `system:${route.threadKind}`
          : null;
  const activeThreadReady =
    route.kind === "issues"
      ? issueThreadDetail !== null
      : route.kind === "approvals"
        ? approvalThreadDetail !== null
        : route.kind === "system"
          ? systemThreadDetail !== null
          : false;

  useEffect(() => {
    if (!selectedOrganizationId) return;
    if (route.kind === "root") return;
    rememberMessengerPath(
      selectedOrganizationId,
      route.kind === "approvals" ? "/messenger/approvals" : relativePath,
    );
  }, [relativePath, route.kind, selectedOrganizationId]);

  useEffect(() => {
    if (route.kind !== "root") return;
    if (!selectedOrganizationId || isLoading || error) return;

    const requestedPrefill = searchParams.get("prefill")?.trim();
    const nextPath = requestedPrefill
      ? "/messenger/chat"
      : resolveRememberedMessengerEntry({
          orgId: selectedOrganizationId,
          threadSummaries,
        });
    const rememberedPath = getRememberedMessengerPath(selectedOrganizationId);
    const preserveSearchAndHash = requestedPrefill || nextPath === rememberedPath;

    navigate(
      {
        pathname: nextPath,
        search: preserveSearchAndHash ? location.search : "",
        hash: preserveSearchAndHash ? location.hash : "",
      },
      { replace: true },
    );
  }, [error, isLoading, location.hash, location.search, navigate, route.kind, searchParams, selectedOrganizationId, threadSummaries]);

  useEffect(() => {
    pendingAutoScrollThreadRef.current = activeThreadKey;
    completedAutoScrollThreadRef.current = null;
  }, [activeThreadKey]);

  useEffect(() => {
    if (!activeThreadKey || !activeThreadReady || isLoading || error) return;
    if (pendingAutoScrollThreadRef.current !== activeThreadKey) return;
    if (completedAutoScrollThreadRef.current === activeThreadKey) return;

    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        scrollMessengerThreadToBottom();
        completedAutoScrollThreadRef.current = activeThreadKey;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [activeThreadKey, activeThreadReady, error, isLoading]);

  useEffect(() => {
    if (route.kind === "issues") {
      setBreadcrumbs([{ label: "Issues" }]);
      return;
    }
    if (route.kind === "approvals") {
      setBreadcrumbs([{ label: "Approvals" }]);
      return;
    }
    if (route.kind === "system") {
      setBreadcrumbs([{ label: messengerThreadKindLabel(route.threadKind) }]);
      return;
    }
    setBreadcrumbs([{ label: "Messenger" }]);
  }, [route.kind, route.kind === "system" ? route.threadKind : null, setBreadcrumbs]);

  if (isLoading) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Loading Messenger…</div>;
  }

  if (error) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-destructive">{error.message}</div>;
  }

  if (route.kind === "issues") return <MessengerIssuesView />;
  if (route.kind === "approvals") return <MessengerApprovalsView />;
  if (route.kind === "system") return <MessengerSystemView threadKind={route.threadKind} />;
  return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">Opening Messenger…</div>;
}
