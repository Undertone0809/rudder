import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  CircleCheckBig,
  Copy,
  DollarSign,
  ListFilter,
  Loader2,
  Mail,
  MailOpen,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  ShieldCheck,
  Trash2,
  UserPlus,
  XCircle,
} from "lucide-react";
import { buildChatMentionHref, formatMessengerPreview, formatMessengerTitle, type ChatConversation } from "@rudderhq/shared";
import { ApiError } from "@/api/client";
import { chatsApi } from "@/api/chats";
import { messengerApi } from "@/api/messenger";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { displayChatTitle } from "@/lib/chat-title";
import { cn, relativeTime } from "@/lib/utils";
import { useSidebar } from "@/context/SidebarContext";
import { useChatGenerations } from "@/context/ChatGenerationContext";
import { useDialog } from "@/context/DialogContext";
import { useOrganization } from "@/context/OrganizationContext";
import { messengerThreadKindLabel, resolveMessengerRoute, useMessengerModel } from "@/hooks/useMessenger";
import { rememberMessengerPath } from "@/lib/messenger-memory";
import { invalidateMessengerThreadSummaryQueries } from "@/lib/messenger-query-cache";
import { getMessengerUnreadScrollRequestId, MESSENGER_SCROLL_TO_UNREAD_EVENT } from "@/lib/messenger-unread-scroll";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { queryKeys } from "@/lib/queryKeys";
import { StatusIcon } from "@/components/StatusIcon";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";

type ThreadOrganizationRule = "latest" | "project" | "kind" | "attention";
type MessengerThreadDensity = "comfortable" | "compact";

const THREAD_ORGANIZATION_STORAGE_KEY = "rudder.messengerThreadOrganizationByOrg";
const THREAD_DENSITY_STORAGE_KEY = "rudder.messengerThreadDensityByOrg";
const SPLIT_ISSUE_NOTIFICATIONS_STORAGE_KEY = "rudder.messengerSplitIssueNotificationsByOrg";
const DEFAULT_THREAD_ORGANIZATION_RULE: ThreadOrganizationRule = "latest";
const DEFAULT_THREAD_DENSITY: MessengerThreadDensity = "compact";
const DEFAULT_SPLIT_ISSUE_NOTIFICATIONS = true;
const DELETE_AFTER_STOP_RETRY_DELAYS_MS = [120, 300, 700] as const;
const THREAD_ORGANIZATION_OPTIONS: Array<{ value: ThreadOrganizationRule; label: string }> = [
  { value: "latest", label: "Latest activity" },
  { value: "project", label: "Project" },
  { value: "kind", label: "Thread type" },
  { value: "attention", label: "Needs attention" },
];

function sleep(ms: number) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function escapeMarkdownLinkLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/]/g, "\\]");
}

function chatReferenceMarkdown(conversation: Pick<ChatConversation, "id" | "title" | "summary">) {
  const label = escapeMarkdownLinkLabel(displayChatTitle(conversation).trim() || "Chat");
  return `[${label}](${buildChatMentionHref(conversation.id)})`;
}

function ContextColumnHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const { isMobile, setSidebarOpen } = useSidebar();

  return (
    <header
      data-testid="workspace-context-header"
      className="workspace-card-header workspace-context-header desktop-chrome desktop-window-drag flex shrink-0 items-center justify-between gap-3 px-4 py-3"
    >
      <div className="min-w-0">
        <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{description}</p>
      </div>
      {!isMobile ? (
        <button
          type="button"
          aria-label="Collapse workspace sidebar"
          title="Collapse workspace sidebar"
          className="desktop-window-no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground"
          onClick={() => setSidebarOpen(false)}
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      ) : null}
    </header>
  );
}

function threadIcon(kind: string) {
  switch (kind) {
    case "chat":
      return MessageSquare;
    case "issues":
      return CircleCheckBig;
    case "approvals":
      return ShieldCheck;
    case "failed-runs":
      return XCircle;
    case "budget-alerts":
      return DollarSign;
    case "join-requests":
      return UserPlus;
    default:
      return AlertTriangle;
  }
}

function sanitizeThreadKey(threadKey: string) {
  return threadKey.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function threadConversationId(threadKey: string) {
  return threadKey.startsWith("chat:") ? threadKey.slice("chat:".length) : null;
}

function readThreadOrganizationRule(orgId: string | null | undefined): ThreadOrganizationRule {
  if (!orgId || typeof window === "undefined") return DEFAULT_THREAD_ORGANIZATION_RULE;
  try {
    const raw = window.localStorage.getItem(THREAD_ORGANIZATION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const value = parsed[orgId];
    if (value === "latest" || value === "project" || value === "kind" || value === "attention") return value;
  } catch {
    // Ignore storage failures; the default latest-activity list remains usable.
  }
  return DEFAULT_THREAD_ORGANIZATION_RULE;
}

function readThreadDensity(orgId: string | null | undefined): MessengerThreadDensity {
  if (!orgId || typeof window === "undefined") return DEFAULT_THREAD_DENSITY;
  try {
    const raw = window.localStorage.getItem(THREAD_DENSITY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const value = parsed[orgId];
    if (value === "comfortable" || value === "compact") return value;
  } catch {
    // Ignore storage failures; the default comfortable list remains usable.
  }
  return DEFAULT_THREAD_DENSITY;
}

function readSplitIssueNotifications(orgId: string | null | undefined): boolean {
  if (!orgId || typeof window === "undefined") return DEFAULT_SPLIT_ISSUE_NOTIFICATIONS;
  try {
    const raw = window.localStorage.getItem(SPLIT_ISSUE_NOTIFICATIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const value = parsed[orgId];
    if (typeof value === "boolean") return value;
  } catch {
    // Ignore storage failures; split issue notifications remain the default.
  }
  return DEFAULT_SPLIT_ISSUE_NOTIFICATIONS;
}

function writeThreadOrganizationRule(orgId: string, rule: ThreadOrganizationRule) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(THREAD_ORGANIZATION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    window.localStorage.setItem(THREAD_ORGANIZATION_STORAGE_KEY, JSON.stringify({ ...parsed, [orgId]: rule }));
  } catch {
    // Ignore storage failures; the in-memory selection still applies for this view.
  }
}

function writeThreadDensity(orgId: string, density: MessengerThreadDensity) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(THREAD_DENSITY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    window.localStorage.setItem(THREAD_DENSITY_STORAGE_KEY, JSON.stringify({ ...parsed, [orgId]: density }));
  } catch {
    // Ignore storage failures; the in-memory density still applies for this view.
  }
}

function writeSplitIssueNotifications(orgId: string, enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(SPLIT_ISSUE_NOTIFICATIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    window.localStorage.setItem(SPLIT_ISSUE_NOTIFICATIONS_STORAGE_KEY, JSON.stringify({ ...parsed, [orgId]: enabled }));
  } catch {
    // Ignore storage failures; the in-memory toggle still applies for this view.
  }
}

function threadOrganizationLabel(rule: ThreadOrganizationRule) {
  return THREAD_ORGANIZATION_OPTIONS.find((option) => option.value === rule)?.label ?? "Latest activity";
}

function conversationSubtitle(conversation: ChatConversation) {
  return (
    formatMessengerPreview(conversation.latestReplyPreview) ||
    formatMessengerPreview(conversation.summary) ||
    (conversation.primaryIssue
      ? `${conversation.primaryIssue.identifier ?? conversation.primaryIssue.id} · ${conversation.primaryIssue.title}`
      : null) ||
    "Start the conversation"
  );
}

function conversationDisplayTitle(conversation: Pick<ChatConversation, "title" | "summary" | "latestReplyPreview">) {
  return displayChatTitle(conversation);
}

function threadDisplayTitle(title: string) {
  return formatMessengerTitle(title, { max: 80 }) ?? title;
}

function chatProjectGroupLabel(conversation: ChatConversation | null) {
  const projectLink = conversation?.contextLinks?.find((link) => link.entityType === "project") ?? null;
  return projectLink?.entity?.label || projectLink?.entity?.identifier || (projectLink ? "Unknown project" : "No project");
}

function ThreadAvatar({
  icon: Icon,
  unreadCount,
  needsAttention,
  density = "comfortable",
  shape = "circle",
  testId,
}: {
  icon: typeof MessageSquare;
  unreadCount: number;
  needsAttention: boolean;
  density?: MessengerThreadDensity;
  shape?: "circle" | "rounded";
  testId?: string;
}) {
  const compact = density === "compact";
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_78%,transparent)] text-[color:var(--accent-strong)]",
        compact ? "h-7 w-7" : "mt-0.5 h-10 w-10",
        shape === "rounded" ? "rounded-[calc(var(--radius-sm)+1px)]" : "rounded-full",
      )}
    >
      <Icon className={cn(compact ? "h-3.5 w-3.5" : "h-4.5 w-4.5")} />
      {unreadCount > 0 ? (
        <span
          data-testid={testId}
          className="absolute -right-1.5 -top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-[color:var(--surface-elevated)] bg-red-500 px-1 text-[10px] font-semibold leading-none text-white shadow-[0_4px_12px_-6px_rgba(220,38,38,0.85)]"
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : needsAttention ? (
        <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-[color:var(--surface-elevated)] bg-red-500" />
      ) : null}
    </span>
  );
}

function IssueStatusThreadAvatar({
  status,
  unreadCount,
  needsAttention,
  density = "comfortable",
  testId,
}: {
  status: string;
  unreadCount: number;
  needsAttention: boolean;
  density?: MessengerThreadDensity;
  testId?: string;
}) {
  const compact = density === "compact";
  return (
    <span
      title={`Issue status: ${status.replace(/_/g, " ")}`}
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_78%,transparent)]",
        compact ? "h-7 w-7" : "mt-0.5 h-10 w-10",
      )}
    >
      <StatusIcon status={status} className={cn(compact ? "h-3.5 w-3.5" : "h-4.5 w-4.5")} />
      {unreadCount > 0 ? (
        <span
          data-testid={testId}
          className="absolute -right-1.5 -top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-[color:var(--surface-elevated)] bg-red-500 px-1 text-[10px] font-semibold leading-none text-white shadow-[0_4px_12px_-6px_rgba(220,38,38,0.85)]"
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : needsAttention ? (
        <span className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-[color:var(--surface-elevated)] bg-red-500" />
      ) : null}
    </span>
  );
}

function MessengerThreadSectionHeader({
  rule,
  density,
  splitIssueNotifications,
  onRuleChange,
  onDensityChange,
  onSplitIssueNotificationsChange,
}: {
  rule: ThreadOrganizationRule;
  density: MessengerThreadDensity;
  splitIssueNotifications: boolean;
  onRuleChange: (rule: ThreadOrganizationRule) => void;
  onDensityChange: (density: MessengerThreadDensity) => void;
  onSplitIssueNotificationsChange: (enabled: boolean) => void;
}) {
  const activeRule = rule !== DEFAULT_THREAD_ORGANIZATION_RULE;
  const compact = density === "compact";
  const statusLabels = [
    activeRule ? threadOrganizationLabel(rule) : null,
  ].filter(Boolean);
  return (
    <div className="group/section flex items-center justify-between px-3.5 pt-3.5">
      <div className="min-w-0 truncate text-[11px] font-semibold text-muted-foreground/72">
        Threads{statusLabels.length > 0 ? (
          <span className="text-muted-foreground">
            {" · "}
            {statusLabels.join(" · ")}
          </span>
        ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="messenger-thread-organization-trigger"
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              activeRule ? "opacity-100" : "opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100",
            )}
            aria-label="Organize threads"
          >
            <ListFilter className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="surface-overlay w-48 text-foreground">
          <DropdownMenuLabel className="text-xs text-muted-foreground">View</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={compact}
            onCheckedChange={(checked) => onDensityChange(checked ? "compact" : "comfortable")}
          >
            Compact mode
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={splitIssueNotifications}
            onCheckedChange={(checked) => onSplitIssueNotificationsChange(Boolean(checked))}
          >
            Split issue notifications
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs text-muted-foreground">Organize by</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={rule} onValueChange={(value) => onRuleChange(value as ThreadOrganizationRule)}>
            {THREAD_ORGANIZATION_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ChatThreadRow({
  conversation,
  href,
  active,
  generating,
  density,
  renaming,
  renameDraft,
  onRenameDraftChange,
  onCommitRename,
  onStartRename,
  onArchive,
  onDelete,
  onTogglePin,
  onToggleUnread,
  onCopyConversationLink,
  onSelect,
}: {
  conversation: ChatConversation;
  href: string;
  active: boolean;
  generating: boolean;
  density: MessengerThreadDensity;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onStartRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onToggleUnread: () => void;
  onCopyConversationLink: () => void;
  onSelect: (href: string) => void;
}) {
  const timeLabel = relativeTime(conversation.lastMessageAt ?? conversation.updatedAt);
  const [actionsOpen, setActionsOpen] = useState(false);
  const compact = density === "compact";

  useEffect(() => {
    if (generating) setActionsOpen(false);
  }, [generating]);

  return (
    <div
      data-testid={`messenger-thread-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
      data-messenger-thread-key={`chat:${conversation.id}`}
      className={cn(
        "group relative mx-1.5 flex rounded-[calc(var(--radius-md)-2px)] border transition-[background-color,border-color,color]",
        compact ? "items-center gap-2 px-2 py-1.5" : "items-start gap-3 px-3 py-2.5",
        active
          ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))]"
          : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
      )}
    >
      <ThreadAvatar
        icon={MessageSquare}
        unreadCount={conversation.unreadCount}
        needsAttention={conversation.needsAttention}
        density={density}
        shape="rounded"
        testId={`${sanitizeThreadKey(`chat:${conversation.id}`)}-unread-badge`}
      />
      {renaming ? (
        <div className="min-w-0 flex-1">
          <input
            autoFocus
            value={renameDraft}
            onChange={(event) => onRenameDraftChange(event.target.value)}
            onBlur={onCommitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onCommitRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onRenameDraftChange(conversation.title);
                onCommitRename();
              }
            }}
            className="min-h-0 w-full rounded-[calc(var(--radius-sm)-1px)] border border-[color:var(--border-base)] bg-[color:var(--surface-elevated)] px-3 py-2 text-sm outline-none"
          />
        </div>
      ) : (
        <>
          <Link to={href} onClick={() => onSelect(href)} className="block min-w-0 flex-1">
            <div className={cn(
              "grid min-w-0 gap-x-2",
              compact ? "grid-cols-[minmax(0,1fr)_2.75rem] items-center" : "grid-cols-[minmax(0,1fr)_3rem] items-start",
            )}>
              <div className="min-w-0">
                <div
                  className={cn(
                    "flex items-center gap-2 text-[13px] leading-tight",
                    conversation.isUnread ? "font-semibold text-foreground" : "font-medium text-foreground/92",
                  )}
                >
                  <span className="truncate">{conversationDisplayTitle(conversation)}</span>
                  {conversation.isPinned ? (
                    <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />
                  ) : null}
                </div>
                {!compact ? (
                  <div
                    className={cn(
                      "mt-0.5 truncate text-[12px]",
                      conversation.isUnread ? "text-foreground/76" : "text-muted-foreground",
                    )}
                  >
                    {conversationSubtitle(conversation)}
                  </div>
                ) : null}
              </div>
              <span
                data-testid={`messenger-time-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
                className={cn(
                  "block shrink-0 whitespace-nowrap text-right text-[10px] leading-none tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0",
                  compact ? "w-11" : "mt-0.5 w-12",
                  (actionsOpen || generating) && "opacity-0",
                )}
              >
                {timeLabel}
              </span>
            </div>
          </Link>

          {generating ? (
            <span
              data-testid={`messenger-generating-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
              aria-label="Chat reply in progress"
              className={cn(
                "pointer-events-none absolute top-1/2 z-10 inline-flex -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0",
                compact ? "right-1.5 h-5 w-5" : "right-2 h-6 w-6",
                actionsOpen && "opacity-0",
              )}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.25} aria-hidden />
            </span>
          ) : null}

          <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "absolute top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
                  compact ? "right-1.5" : "right-2",
                  actionsOpen ? "opacity-100" : "opacity-0",
                )}
                aria-label="Chat actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="surface-overlay text-foreground">
              <DropdownMenuItem onClick={onStartRename}>
                <PencilLine className="h-4 w-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onTogglePin}>
                {conversation.isPinned ? (
                  <>
                    <PinOff className="h-4 w-4" />
                    Unpin
                  </>
                ) : (
                  <>
                    <Pin className="h-4 w-4" />
                    Pin
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onToggleUnread}>
                {conversation.isUnread ? (
                  <>
                    <MailOpen className="h-4 w-4" />
                    Mark as Read
                  </>
                ) : (
                  <>
                    <Mail className="h-4 w-4" />
                    Mark as Unread
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onCopyConversationLink}>
                <Copy className="h-4 w-4" />
                Copy Chat Link
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onArchive}>
                <Archive className="h-4 w-4" />
                Archive
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={onDelete}
                title={generating ? "Stops the active reply before deleting this chat." : undefined}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}

function ThreadRow({
  thread,
  active,
  density,
  onTogglePin,
  onSelect,
}: {
  thread: ReturnType<typeof useMessengerModel>["threadSummaries"][number];
  active: boolean;
  density: MessengerThreadDensity;
  onTogglePin: () => void;
  onSelect: (href: string) => void;
}) {
  const Icon = threadIcon(thread.kind);
  const preview = formatMessengerPreview(thread.preview) || formatMessengerPreview(thread.subtitle) || messengerThreadKindLabel(thread.kind);
  const compact = density === "compact";
  const [actionsOpen, setActionsOpen] = useState(false);
  const canTogglePin = thread.metadata?.splitIssue === true;
  const issueStatus =
    thread.metadata?.splitIssue === true && typeof thread.metadata.status === "string"
      ? thread.metadata.status
      : null;

  return (
    <div
      data-testid={`messenger-thread-${sanitizeThreadKey(thread.threadKey)}`}
      data-messenger-thread-key={thread.threadKey}
      className={cn(
        "group relative mx-1.5 flex rounded-[calc(var(--radius-md)-2px)] border transition-[background-color,border-color,color]",
        compact ? "items-center gap-2 px-2 py-1.5" : "items-start gap-3 px-3 py-2.5",
        active
          ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))]"
          : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
      )}
    >
      {issueStatus ? (
        <IssueStatusThreadAvatar
          status={issueStatus}
          unreadCount={thread.unreadCount}
          needsAttention={thread.needsAttention}
          density={density}
          testId={`${sanitizeThreadKey(thread.threadKey)}-unread-badge`}
        />
      ) : (
        <ThreadAvatar
          icon={Icon}
          unreadCount={thread.unreadCount}
          needsAttention={thread.needsAttention}
          density={density}
          testId={`${sanitizeThreadKey(thread.threadKey)}-unread-badge`}
        />
      )}
      <Link to={thread.href} onClick={() => onSelect(thread.href)} className="block min-w-0 flex-1">
        <span className="min-w-0">
          <span className={cn(
            "grid min-w-0 gap-x-2",
            compact ? "grid-cols-[minmax(0,1fr)_2.75rem] items-center" : "grid-cols-[minmax(0,1fr)_3rem] items-start",
          )}>
            <span
              className={cn(
                "flex min-w-0 items-center gap-2 text-[13px] leading-tight",
                thread.unreadCount > 0 ? "font-semibold text-foreground" : "font-medium text-foreground/92",
              )}
            >
              <span className="truncate">{threadDisplayTitle(thread.title)}</span>
              {canTogglePin && thread.isPinned ? (
                <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />
              ) : null}
            </span>
            <span
              data-testid={`messenger-time-${sanitizeThreadKey(thread.threadKey)}`}
              className={cn(
                "block shrink-0 whitespace-nowrap text-right text-[10px] leading-none tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0",
                compact ? "w-11" : "mt-0.5 w-12",
                actionsOpen && "opacity-0",
              )}
            >
              {thread.latestActivityAt ? relativeTime(new Date(thread.latestActivityAt)) : "No activity"}
            </span>
          </span>
          {!compact ? (
            <span
              className={cn(
                "mt-0.5 block truncate text-[12px]",
                thread.unreadCount > 0 ? "text-foreground/76" : "text-muted-foreground",
              )}
            >
              {preview}
            </span>
          ) : null}
        </span>
      </Link>

      {canTogglePin ? (
        <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "absolute top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
                compact ? "right-1.5" : "right-2",
                actionsOpen ? "opacity-100" : "opacity-0",
              )}
              aria-label="Thread actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="surface-overlay text-foreground">
            <DropdownMenuItem onClick={onTogglePin}>
              {thread.isPinned ? (
                <>
                  <PinOff className="h-4 w-4" />
                  Unpin
                </>
              ) : (
                <>
                  <Pin className="h-4 w-4" />
                  Pin
                </>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

type MessengerThreadSummaryItem = ReturnType<typeof useMessengerModel>["threadSummaries"][number];

function chatConversationForThreadSummary(
  thread: MessengerThreadSummaryItem,
  orgId: string,
  conversation: ChatConversation | null | undefined,
): ChatConversation | null {
  if (thread.kind !== "chat") return null;
  const conversationId = threadConversationId(thread.threadKey);
  if (!conversationId) return null;

  const isPinned = typeof thread.isPinned === "boolean" ? thread.isPinned : Boolean(conversation?.isPinned);
  if (conversation) {
    return {
      ...conversation,
      lastReadAt: thread.lastReadAt ?? conversation.lastReadAt,
      unreadCount: thread.unreadCount,
      isUnread: thread.unreadCount > 0,
      needsAttention: thread.needsAttention,
      isPinned,
    };
  }

  const activityAt = thread.latestActivityAt ? new Date(thread.latestActivityAt) : new Date();
  const preview = thread.preview ?? thread.subtitle ?? null;
  return {
    id: conversationId,
    orgId,
    status: "active",
    title: thread.title,
    summary: preview,
    latestReplyPreview: preview,
    preferredAgentId: null,
    routedAgentId: null,
    primaryIssueId: null,
    primaryIssue: null,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: null,
    lastMessageAt: activityAt,
    lastReadAt: thread.lastReadAt,
    isPinned,
    isUnread: thread.unreadCount > 0,
    unreadCount: thread.unreadCount,
    needsAttention: thread.needsAttention,
    resolvedAt: null,
    contextLinks: [],
    chatRuntime: {
      sourceType: "unconfigured",
      sourceLabel: "No agent selected",
      runtimeAgentId: null,
      agentRuntimeType: null,
      model: null,
      available: false,
      error: null,
    },
    createdAt: activityAt,
    updatedAt: activityAt,
  };
}

interface OrganizedThreadEntry {
  thread: MessengerThreadSummaryItem;
  conversation: ChatConversation | null;
}

interface OrganizedThreadSection {
  key: string;
  label: string | null;
  entries: OrganizedThreadEntry[];
}

function isPinnedEntry(entry: OrganizedThreadEntry) {
  return typeof entry.thread.isPinned === "boolean" ? entry.thread.isPinned : Boolean(entry.conversation?.isPinned);
}

function threadMatchesMessengerIssueRoute(thread: MessengerThreadSummaryItem, issueRef: string) {
  if (thread.metadata?.splitIssue !== true) return false;
  const metadata = thread.metadata as Record<string, unknown>;
  if (metadata.issueId === issueRef || metadata.issueIdentifier === issueRef) return true;
  const normalizedHref = thread.href.split("?")[0]?.split("#")[0] ?? thread.href;
  return normalizedHref === `/messenger/issues/${issueRef}`;
}

function entryActivityTime(entry: OrganizedThreadEntry) {
  const value = entry.thread.latestActivityAt ?? (entry.conversation?.lastMessageAt ?? entry.conversation?.updatedAt ?? null);
  return value ? new Date(value).getTime() : Number.NEGATIVE_INFINITY;
}

function compareThreadEntries(a: OrganizedThreadEntry, b: OrganizedThreadEntry) {
  if (isPinnedEntry(a) !== isPinnedEntry(b)) return isPinnedEntry(a) ? -1 : 1;
  const timeDiff = entryActivityTime(b) - entryActivityTime(a);
  if (timeDiff !== 0) return timeDiff;
  return a.thread.title.localeCompare(b.thread.title);
}

function groupEntries(
  entries: OrganizedThreadEntry[],
  labelForEntry: (entry: OrganizedThreadEntry) => string,
) {
  const sections = new Map<string, OrganizedThreadEntry[]>();
  for (const entry of entries) {
    const label = labelForEntry(entry);
    sections.set(label, [...(sections.get(label) ?? []), entry]);
  }
  return Array.from(sections.entries())
    .sort(([a], [b]) => {
      if (a === "Needs attention") return -1;
      if (b === "Needs attention") return 1;
      if (a === "No project") return 1;
      if (b === "No project") return -1;
      if (a === "System") return 1;
      if (b === "System") return -1;
      return a.localeCompare(b);
    })
    .map(([label, sectionEntries]) => ({
      key: label,
      label,
      entries: [...sectionEntries].sort(compareThreadEntries),
    }));
}

function organizeThreadEntries(entries: OrganizedThreadEntry[], rule: ThreadOrganizationRule): OrganizedThreadSection[] {
  const sorted = [...entries].sort(compareThreadEntries);
  if (rule === "latest") {
    const pinned = sorted.filter(isPinnedEntry);
    const recent = sorted.filter((entry) => !isPinnedEntry(entry));
    if (pinned.length === 0) return [{ key: "latest", label: null, entries: recent }];
    return [
      { key: "pinned", label: "Pinned", entries: pinned },
      { key: "recent", label: "Recent", entries: recent },
    ].filter((section) => section.entries.length > 0);
  }
  if (rule === "project") {
    return groupEntries(sorted, (entry) => {
      if (entry.thread.kind !== "chat") return "System";
      return chatProjectGroupLabel(entry.conversation);
    });
  }
  if (rule === "kind") {
    return groupEntries(sorted, (entry) => messengerThreadKindLabel(entry.thread.kind));
  }
  return groupEntries(sorted, (entry) => entry.thread.unreadCount > 0 || entry.thread.needsAttention ? "Needs attention" : "Other threads");
}

export function MessengerContextSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const relativePath = toOrganizationRelativePath(location.pathname);
  const { selectedOrganizationId } = useOrganization();
  const [splitIssueNotifications, setSplitIssueNotifications] = useState(() =>
    readSplitIssueNotifications(selectedOrganizationId),
  );
  const model = useMessengerModel({ splitIssues: splitIssueNotifications });
  const { isMobile, setSidebarOpen } = useSidebar();
  const { confirm } = useDialog();
  const {
    abortChatStream,
    isChatGenerationActive,
    setChatSendInFlight,
    setStreamDraftForChat,
  } = useChatGenerations();
  const queryClient = useQueryClient();
  const route = resolveMessengerRoute(relativePath);
  const markedThreadRef = useRef<string | null>(null);
  const sidebarScrollbarActivityRef = useScrollbarActivityRef("rudder:sidebar-scroll:messenger");
  const sidebarScrollElementRef = useRef<HTMLElement | null>(null);
  const loadMoreThreadSummariesRef = useRef<HTMLDivElement | null>(null);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [unreadScrollRequestId, setUnreadScrollRequestId] = useState(() => getMessengerUnreadScrollRequestId());
  const [threadOrganizationRule, setThreadOrganizationRule] = useState<ThreadOrganizationRule>(() =>
    readThreadOrganizationRule(model.selectedOrganizationId),
  );
  const [threadDensity, setThreadDensity] = useState<MessengerThreadDensity>(() =>
    readThreadDensity(model.selectedOrganizationId),
  );

  useEffect(() => {
    setThreadOrganizationRule(readThreadOrganizationRule(model.selectedOrganizationId));
    setThreadDensity(readThreadDensity(model.selectedOrganizationId));
    setSplitIssueNotifications(readSplitIssueNotifications(model.selectedOrganizationId));
  }, [model.selectedOrganizationId]);

  useEffect(() => {
    if (!model.selectedOrganizationId) return;
    void invalidateMessengerThreadSummaryQueries(queryClient, model.selectedOrganizationId);
  }, [model.selectedOrganizationId, queryClient, splitIssueNotifications]);

  const shouldLoadSidebarConversations = threadOrganizationRule === "project";

  const chatsQuery = useQuery({
    queryKey: queryKeys.chats.list(model.selectedOrganizationId ?? "__none__", "all"),
    queryFn: () => chatsApi.list(model.selectedOrganizationId!, "all"),
    enabled: !!model.selectedOrganizationId && shouldLoadSidebarConversations,
  });

  const conversationsById = useMemo(() => {
    const map = new Map<string, ChatConversation>();
    for (const conversation of chatsQuery.data ?? []) {
      map.set(conversation.id, conversation);
    }
    return map;
  }, [chatsQuery.data]);

  const organizedThreadSections = useMemo(() => {
    const threadSummaries = splitIssueNotifications
      ? model.threadSummaries.filter((thread) => thread.threadKey !== "issues")
      : model.threadSummaries;
    const entries = threadSummaries.map((thread) => {
      const conversationId = threadConversationId(thread.threadKey);
      const loadedConversation = conversationId ? conversationsById.get(conversationId) ?? null : null;
      return {
        thread,
        conversation: model.selectedOrganizationId
          ? chatConversationForThreadSummary(thread, model.selectedOrganizationId, loadedConversation)
          : null,
      };
    });
    return organizeThreadEntries(entries, threadOrganizationRule);
  }, [conversationsById, model.selectedOrganizationId, model.threadSummaries, splitIssueNotifications, threadOrganizationRule]);
  const firstUnreadThreadKey = useMemo(() => {
    for (const section of organizedThreadSections) {
      for (const entry of section.entries) {
        if (entry.thread.unreadCount > 0) return entry.thread.threadKey;
      }
    }
    return null;
  }, [organizedThreadSections]);
  const setSidebarScrollRef = useCallback((element: HTMLElement | null) => {
    sidebarScrollElementRef.current = element;
    sidebarScrollbarActivityRef(element);
  }, [sidebarScrollbarActivityRef]);

  const activeThreadKey = useMemo(() => {
    if (route.kind === "chat" && route.conversationId) return `chat:${route.conversationId}`;
    if (route.kind === "issue") {
      return model.threadSummaries.find((thread) => threadMatchesMessengerIssueRoute(thread, route.issueId))?.threadKey ?? `issue:${route.issueId}`;
    }
    if (route.kind === "issues") return "issues";
    if (route.kind === "approvals") return "approvals";
    if (route.kind === "system") return route.threadKind;
    return null;
  }, [model.threadSummaries, route]);
  const activeThread = useMemo(
    () => model.threadSummaries.find((thread) => thread.threadKey === activeThreadKey) ?? null,
    [activeThreadKey, model.threadSummaries],
  );
  const activeThreadDetailReady = useMemo(() => {
    if (route.kind === "issue") return !!activeThread;
    if (route.kind === "issues") return !!model.issueThreadDetail;
    if (route.kind === "approvals") return !!model.approvalThreadDetail;
    if (route.kind === "system") return !!model.systemThreadDetail;
    return false;
  }, [activeThread, model.approvalThreadDetail, model.issueThreadDetail, model.systemThreadDetail, route]);
  const activeThreadReadAt = useMemo(() => {
    if (route.kind === "issue") return activeThread?.latestActivityAt ?? null;
    if (route.kind === "issues") return model.issueThreadDetail?.latestActivityAt ?? null;
    if (route.kind === "approvals") return model.approvalThreadDetail?.latestActivityAt ?? null;
    if (route.kind === "system") return model.systemThreadDetail?.latestActivityAt ?? null;
    return activeThread?.latestActivityAt ?? null;
  }, [
    activeThread?.latestActivityAt,
    model.approvalThreadDetail?.latestActivityAt,
    model.issueThreadDetail?.latestActivityAt,
    model.systemThreadDetail?.latestActivityAt,
    route,
  ]);

  const closeMobileSidebar = () => {
    if (isMobile) setSidebarOpen(false);
  };

  const handleMessengerEntrySelect = (href: string) => {
    if (model.selectedOrganizationId) {
      rememberMessengerPath(model.selectedOrganizationId, href);
    }
    closeMobileSidebar();
  };

  const handleThreadOrganizationRuleChange = (rule: ThreadOrganizationRule) => {
    setThreadOrganizationRule(rule);
    if (model.selectedOrganizationId) {
      writeThreadOrganizationRule(model.selectedOrganizationId, rule);
    }
  };

  const handleThreadDensityChange = (density: MessengerThreadDensity) => {
    setThreadDensity(density);
    if (model.selectedOrganizationId) {
      writeThreadDensity(model.selectedOrganizationId, density);
    }
  };

  const handleSplitIssueNotificationsChange = (enabled: boolean) => {
    setSplitIssueNotifications(enabled);
    if (model.selectedOrganizationId) {
      writeSplitIssueNotifications(model.selectedOrganizationId, enabled);
    }
  };

  const refreshChatViews = async (chatId?: string) => {
    if (!model.selectedOrganizationId) return;
    await Promise.all([
      invalidateMessengerThreadSummaryQueries(queryClient, model.selectedOrganizationId),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(model.selectedOrganizationId, "all") }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats.list(model.selectedOrganizationId, "active") }),
    ]);
    if (chatId) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.detail(chatId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.chats.messages(chatId) }),
      ]);
    }
  };

  const updateConversationMutation = useMutation({
    mutationFn: ({ chatId, data }: { chatId: string; data: Parameters<typeof chatsApi.update>[1] }) =>
      chatsApi.update(chatId, data),
    onSuccess: async (conversation) => {
      if (conversation.status === "archived" && route.kind === "chat" && route.conversationId === conversation.id) {
        navigate("/messenger");
      }
      setRenamingConversationId((current) => (current === conversation.id ? null : current));
      await refreshChatViews(conversation.id);
    },
  });

  const deleteConversationMutation = useMutation({
    mutationFn: async ({ chatId, generating }: { chatId: string; generating: boolean }) => {
      if (generating) {
        abortChatStream(chatId);
        await chatsApi.stopMessageStream(chatId).catch(() => undefined);
        setStreamDraftForChat(chatId, null);
        setChatSendInFlight(chatId, false);
      }

      let lastError: unknown = null;
      for (let attempt = 0; attempt <= DELETE_AFTER_STOP_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          return generating
            ? await chatsApi.remove(chatId, { cancelActive: true })
            : await chatsApi.remove(chatId);
        } catch (error) {
          lastError = error;
          const shouldRetry = generating && error instanceof ApiError && error.status === 409;
          if (!shouldRetry || attempt >= DELETE_AFTER_STOP_RETRY_DELAYS_MS.length) {
            throw error;
          }
          await sleep(DELETE_AFTER_STOP_RETRY_DELAYS_MS[attempt]!);
        }
      }

      throw lastError;
    },
    onSuccess: async (conversation) => {
      if (route.kind === "chat" && route.conversationId === conversation.id) {
        navigate("/messenger/chat");
      }
      await refreshChatViews(conversation.id);
    },
  });

  const updateConversationUserStateMutation = useMutation({
    mutationFn: ({
      chatId,
      pinned,
      unread,
    }: {
      chatId: string;
      pinned?: boolean;
      unread?: boolean;
    }) =>
      chatsApi.updateUserState(chatId, { pinned, unread }),
    onSuccess: async (conversation) => {
      await refreshChatViews(conversation.id);
    },
  });

  const updateThreadUserStateMutation = useMutation({
    mutationFn: ({
      threadKey,
      pinned,
    }: {
      threadKey: string;
      pinned?: boolean;
    }) => {
      if (!model.selectedOrganizationId) throw new Error("Organization is required to update Messenger thread state");
      return messengerApi.updateThreadUserState(model.selectedOrganizationId, threadKey, { pinned });
    },
    onSuccess: async () => {
      await refreshChatViews();
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

  const copyConversationLink = async (conversation: ChatConversation) => {
    try {
      await navigator.clipboard.writeText(chatReferenceMarkdown(conversation));
    } catch {
      // Ignore clipboard failures in restricted environments.
    }
  };

  useEffect(() => {
    if (!model.selectedOrganizationId) return;
    if (!activeThreadKey) return;
    if (route.kind === "chat") return;
    if (!activeThread || activeThread.unreadCount === 0) return;
    if (!activeThreadDetailReady) return;

    const orgId = model.selectedOrganizationId;
    const watermark = activeThreadReadAt ?? activeThread.latestActivityAt ?? "none";
    const marker = `${orgId}:${activeThreadKey}:${watermark}`;
    if (markedThreadRef.current === marker) return;
    markedThreadRef.current = marker;

    void messengerApi.markThreadRead(
      orgId,
      activeThreadKey,
      activeThreadReadAt ? new Date(activeThreadReadAt).toISOString() : null,
    ).then(async () => {
      await invalidateMessengerThreadSummaryQueries(queryClient, orgId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(orgId) });
      if (route.kind === "issues") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.issues(orgId) });
      }
      if (route.kind === "approvals") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.approvals(orgId) });
      }
      if (route.kind === "system") {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.messenger.system(orgId, route.threadKind),
        });
      }
    }).catch(() => {
      markedThreadRef.current = null;
    });
  }, [activeThread, activeThreadDetailReady, activeThreadKey, activeThreadReadAt, model.selectedOrganizationId, queryClient, route]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const handleUnreadScrollRequest = () => {
      setUnreadScrollRequestId(getMessengerUnreadScrollRequestId());
    };

    document.addEventListener(MESSENGER_SCROLL_TO_UNREAD_EVENT, handleUnreadScrollRequest);
    return () => {
      document.removeEventListener(MESSENGER_SCROLL_TO_UNREAD_EVENT, handleUnreadScrollRequest);
    };
  }, []);

  useEffect(() => {
    if (!firstUnreadThreadKey) return;
    if (unreadScrollRequestId <= 0) return;

    const scrollFirstUnreadThreadIntoView = () => {
      const container = sidebarScrollElementRef.current;
      if (!container) return;

      const unreadRow = Array.from(container.querySelectorAll<HTMLElement>("[data-messenger-thread-key]"))
        .find((row) => row.dataset.messengerThreadKey === firstUnreadThreadKey);

      unreadRow?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };

    const frame = requestAnimationFrame(scrollFirstUnreadThreadIntoView);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [firstUnreadThreadKey, unreadScrollRequestId]);

  useEffect(() => {
    const sentinel = loadMoreThreadSummariesRef.current;
    const root = sidebarScrollElementRef.current;
    if (!sentinel || !root) return;
    if (!model.hasMoreThreadSummaries || model.isFetchingMoreThreadSummaries || model.isLoading) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (!visible || !model.hasMoreThreadSummaries || model.isFetchingMoreThreadSummaries) return;
      void model.loadMoreThreadSummaries();
    }, { root, rootMargin: "240px 0px" });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    model.hasMoreThreadSummaries,
    model.isFetchingMoreThreadSummaries,
    model.isLoading,
    model.loadMoreThreadSummaries,
    model.threadSummaries.length,
  ]);

  if (!model.selectedOrganizationId) return null;

  return (
    <aside
      data-testid="workspace-sidebar"
      className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
    >
      <ContextColumnHeader
        title="Messenger"
        description={threadOrganizationRule === "latest"
          ? "Threads sorted by latest activity"
          : `Threads organized by ${threadOrganizationLabel(threadOrganizationRule).toLowerCase()}`}
      />
      <MessengerThreadSectionHeader
        rule={threadOrganizationRule}
        density={threadDensity}
        splitIssueNotifications={splitIssueNotifications}
        onRuleChange={handleThreadOrganizationRuleChange}
        onDensityChange={handleThreadDensityChange}
        onSplitIssueNotificationsChange={handleSplitIssueNotificationsChange}
      />
      <nav
        ref={setSidebarScrollRef}
        className="scrollbar-auto-hide mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 pb-3.5"
      >
        <Link
          to="/messenger/chat"
          onClick={() => handleMessengerEntrySelect("/messenger/chat")}
          className={cn(
            "mx-1.5 flex items-center rounded-[calc(var(--radius-md)-2px)] border border-transparent text-sm transition-[background-color,border-color,color]",
            threadDensity === "compact" ? "gap-2 px-2 py-1.5" : "gap-3 px-3 py-2.5",
            route.kind === "chat" && !route.conversationId
              ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))] font-medium text-foreground"
              : "text-foreground/78 hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground",
          )}
        >
          <span className={cn(
            "flex shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)+1px)] border border-[color:color-mix(in_oklab,var(--border-soft)_88%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_82%,transparent)] text-[color:var(--accent-strong)]",
            threadDensity === "compact" ? "h-7 w-7" : "h-10 w-10",
          )}>
            <Plus className={cn(threadDensity === "compact" ? "h-3.5 w-3.5" : "h-4.5 w-4.5")} />
          </span>
          <span className="truncate text-[13px] font-medium leading-tight">New chat</span>
        </Link>
        {model.isLoading && model.threadSummaries.length === 0 ? (
          <div className="space-y-1 px-1.5">
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                key={index}
                className={cn(
                  "animate-pulse rounded-[calc(var(--radius-md)-2px)] border border-transparent bg-[color:color-mix(in_oklab,var(--surface-elevated)_60%,transparent)]",
                  threadDensity === "compact" ? "h-10" : "h-[72px]",
                )}
              />
            ))}
          </div>
        ) : null}
        {organizedThreadSections.map((section) => (
          <div key={section.key} className="flex flex-col gap-1">
            {section.label ? (
              <div
                data-testid={`messenger-thread-section-${sanitizeThreadKey(section.key)}`}
                className="px-3 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground/72"
              >
                {section.label}
              </div>
            ) : null}
            {section.entries.map(({ thread, conversation }) => {
              const active = activeThreadKey === thread.threadKey;
              if (thread.kind === "chat" && conversation) {
                return (
                  <ChatThreadRow
                    key={thread.threadKey}
                    conversation={conversation}
                    href={thread.href}
                    active={active}
                    generating={isChatGenerationActive(conversation.id)}
                    density={threadDensity}
                    renaming={renamingConversationId === conversation.id}
                    renameDraft={renameDraft}
                    onRenameDraftChange={setRenameDraft}
                    onCommitRename={submitRename}
                    onStartRename={() => {
                      setRenamingConversationId(conversation.id);
                      setRenameDraft(conversation.title);
                    }}
                    onArchive={() => {
                      updateConversationMutation.mutate({
                        chatId: conversation.id,
                        data: { status: "archived" },
                      });
                    }}
                    onDelete={async () => {
                      const confirmed = await confirm({
                        title: "Delete chat",
                        description: `Delete "${conversationDisplayTitle(conversation)}"? This cannot be undone.`,
                        confirmLabel: "Delete",
                        tone: "destructive",
                      });
                      if (!confirmed) return;
                      deleteConversationMutation.mutate({
                        chatId: conversation.id,
                        generating: isChatGenerationActive(conversation.id),
                      });
                    }}
                    onTogglePin={() => {
                      updateConversationUserStateMutation.mutate({
                        chatId: conversation.id,
                        pinned: !conversation.isPinned,
                      });
                    }}
                    onToggleUnread={() => {
                      updateConversationUserStateMutation.mutate({
                        chatId: conversation.id,
                        unread: !conversation.isUnread,
                      });
                    }}
                    onCopyConversationLink={() => void copyConversationLink(conversation)}
                    onSelect={handleMessengerEntrySelect}
                  />
                );
              }

              return (
                <ThreadRow
                  key={thread.threadKey}
                  thread={thread}
                  active={active}
                  density={threadDensity}
                  onTogglePin={() => {
                    updateThreadUserStateMutation.mutate({
                      threadKey: thread.threadKey,
                      pinned: !thread.isPinned,
                    });
                  }}
                  onSelect={handleMessengerEntrySelect}
                />
              );
            })}
          </div>
        ))}
        {model.hasMoreThreadSummaries || model.isFetchingMoreThreadSummaries ? (
          <div
            ref={loadMoreThreadSummariesRef}
            data-testid="messenger-thread-page-sentinel"
            className="flex min-h-10 items-center justify-center px-3 py-2 text-[12px] text-muted-foreground"
          >
            {model.isFetchingMoreThreadSummaries ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Loading more threads
              </span>
            ) : null}
          </div>
        ) : null}
      </nav>
    </aside>
  );
}
