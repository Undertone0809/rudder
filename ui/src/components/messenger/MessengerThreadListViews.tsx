import { AgentIcon } from "@/components/AgentAvatar";
import { CustomGroupIcon } from "@/components/messenger/MessengerCustomGroupVisuals";
import { StatusIcon } from "@/components/StatusIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useActivitySummary } from "@/context/ActivityCoordinatorContext";
import { useChatGenerationActive } from "@/context/ChatGenerationContext";
import { displayChatTitle, isDefaultChatTitle } from "@/lib/chat-title";
import type { MessengerThreadDensity } from "@/lib/messenger-preferences";
import { messengerThreadKindLabel } from "@/lib/messenger-thread-labels";
import { Link } from "@/lib/router";
import type { SourceBadge } from "@/lib/source-badge";
import { cn, relativeTime } from "@/lib/utils";
import type { ActivityKey } from "@/runtime/activity-coordinator";
import type { useSortable } from "@dnd-kit/sortable";
import { formatMessengerPreview, formatMessengerTitle, type Agent, type ChatConversation, type MessengerCustomGroupWithEntries, type MessengerThreadSummary } from "@rudderhq/shared";
import {
  AlertTriangle,
  Archive,
  CircleCheckBig,
  Copy,
  DollarSign,
  EyeOff,
  FolderInput,
  FolderPlus,
  GitFork,
  GripVertical,
  Loader2,
  Mail,
  MailOpen,
  MessageSquare,
  MoreHorizontal,
  PencilLine,
  Pin,
  PinOff,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserPlus,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

export type SortableDragHandleProps = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;

const MESSENGER_THREAD_PREVIEW_HOVER_DELAY_MS = 1_000;
const MESSENGER_THREAD_PREVIEW_CLOSE_DELAY_MS = 120;

export function MessengerDragHandle({
  dragHandleProps,
  label,
  compact = false,
}: {
  dragHandleProps?: SortableDragHandleProps;
  label: string;
  compact?: boolean;
}) {
  if (!dragHandleProps) return null;
  return (
    <button
      type="button"
      {...dragHandleProps.attributes}
      {...dragHandleProps.listeners}
      aria-label={label}
      title={label}
      className={cn(
        "shrink-0 cursor-grab touch-none rounded-[calc(var(--radius-sm)-2px)] text-muted-foreground/55 opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 active:cursor-grabbing group-hover:opacity-100 group-focus-within:opacity-100",
        compact ? "mt-0 flex h-5 w-4 items-center justify-center" : "mt-0.5 flex h-6 w-4 items-center justify-center",
      )}
    >
      <GripVertical className="h-3.5 w-3.5" aria-hidden />
    </button>
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

export function sanitizeThreadKey(threadKey: string) {
  return threadKey.replace(/[^a-zA-Z0-9_-]/g, "-");
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

export function conversationDisplayTitle(conversation: Pick<ChatConversation, "title" | "summary" | "latestUserMessagePreview" | "latestReplyPreview">) {
  return displayChatTitle(conversation);
}

export function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function threadDisplayTitle(title: string) {
  return formatMessengerTitle(title, { max: 80 }) ?? title;
}

function MessengerThreadPreview({
  threadKey,
  eyebrow,
  title,
  description,
  metadata,
  suppressed = false,
  children,
}: {
  threadKey: string;
  eyebrow: string;
  title: string;
  description: string | null;
  metadata?: Array<string | null | undefined>;
  suppressed?: boolean;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressedRef = useRef(suppressed);
  const reentryRequiredRef = useRef(false);
  const pointerLeftRef = useRef(false);
  const pointerMovedDuringSuppressionRef = useRef(false);
  const keyboardBlurredRef = useRef(false);
  const detailLines = metadata?.filter((value): value is string => Boolean(value?.trim())) ?? [];

  suppressedRef.current = suppressed;

  const clearTimer = (ref: typeof hoverTimerRef) => {
    if (ref.current) clearTimeout(ref.current);
    ref.current = null;
  };
  const showNow = () => {
    clearTimer(hoverTimerRef);
    clearTimer(closeTimerRef);
    if (suppressedRef.current || reentryRequiredRef.current) return;
    setOpen(true);
  };
  const scheduleOpen = () => {
    clearTimer(hoverTimerRef);
    clearTimer(closeTimerRef);
    if (suppressedRef.current || reentryRequiredRef.current) return;
    hoverTimerRef.current = setTimeout(showNow, MESSENGER_THREAD_PREVIEW_HOVER_DELAY_MS);
  };
  const handleMouseEnter = () => {
    scheduleOpen();
  };
  const handleMouseMove = () => {
    if (suppressedRef.current) {
      pointerMovedDuringSuppressionRef.current = true;
      return;
    }
    if (!reentryRequiredRef.current || !pointerLeftRef.current) return;
    reentryRequiredRef.current = false;
    pointerLeftRef.current = false;
    scheduleOpen();
  };
  const scheduleClose = () => {
    clearTimer(hoverTimerRef);
    clearTimer(closeTimerRef);
    closeTimerRef.current = setTimeout(() => setOpen(false), MESSENGER_THREAD_PREVIEW_CLOSE_DELAY_MS);
  };

  const handleMouseLeave = () => {
    if (
      reentryRequiredRef.current
      && (!suppressedRef.current || pointerMovedDuringSuppressionRef.current)
    ) {
      pointerLeftRef.current = true;
    }
    scheduleClose();
  };

  const handleBlur = () => {
    if (!suppressedRef.current && reentryRequiredRef.current) keyboardBlurredRef.current = true;
    scheduleClose();
  };

  const handleFocus = () => {
    if (!suppressedRef.current && keyboardBlurredRef.current) {
      reentryRequiredRef.current = false;
      keyboardBlurredRef.current = false;
    }
    showNow();
  };

  useEffect(() => {
    if (!suppressed) return;
    reentryRequiredRef.current = true;
    pointerLeftRef.current = false;
    pointerMovedDuringSuppressionRef.current = false;
    keyboardBlurredRef.current = false;
    clearTimer(hoverTimerRef);
    clearTimer(closeTimerRef);
    setOpen(false);
  }, [suppressed]);

  useEffect(() => () => {
    clearTimer(hoverTimerRef);
    clearTimer(closeTimerRef);
  }, []);

  return (
    <TooltipProvider delayDuration={MESSENGER_THREAD_PREVIEW_HOVER_DELAY_MS} skipDelayDuration={0}>
      <Tooltip open={open && !suppressed}>
        <TooltipTrigger
          asChild
          onMouseEnter={handleMouseEnter}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onFocusCapture={handleFocus}
          onBlurCapture={handleBlur}
        >
          {children}
        </TooltipTrigger>
        <TooltipContent
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          data-testid={`messenger-thread-preview-${sanitizeThreadKey(threadKey)}`}
          className="motion-entity-preview-pop z-[70] w-[min(22rem,calc(100vw-2rem))] space-y-2 rounded-[var(--radius-md)] border border-border/80 bg-[color:var(--surface-overlay)] px-3.5 py-3 text-left text-foreground shadow-[var(--shadow-lg)]"
          onMouseEnter={showNow}
          onMouseLeave={scheduleClose}
        >
          <div className="text-[11px] font-medium text-muted-foreground">{eyebrow}</div>
          <div className="break-words text-[13px] font-semibold leading-5 text-foreground">{title}</div>
          {description ? (
            <div className="line-clamp-6 whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground/78">
              {description}
            </div>
          ) : null}
          {detailLines.length > 0 ? (
            <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
              {detailLines.map((line) => <span key={line}>{line}</span>)}
            </div>
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
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
        <span
          data-testid={testId}
          className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-[color:var(--surface-elevated)] bg-red-500"
        />
      ) : null}
    </span>
  );
}

function ChatAgentThreadAvatar({
  agent,
  agentId,
  unreadCount,
  needsAttention,
  density,
  testId,
}: {
  agent: Agent | null;
  agentId: string | null;
  unreadCount: number;
  needsAttention: boolean;
  density: MessengerThreadDensity;
  testId: string;
}) {
  if (!agent && !agentId) {
    return (
      <ThreadAvatar
        icon={MessageSquare}
        unreadCount={unreadCount}
        needsAttention={needsAttention}
        density={density}
        shape="rounded"
        testId={`${testId}-unread-badge`}
      />
    );
  }

  const compact = density === "compact";
  return (
    <span
      data-testid={testId}
      title={agent?.name ? `Chat agent: ${agent.name}` : "Chat agent"}
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-visible rounded-full border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_78%,transparent)]",
        compact ? "h-7 w-7" : "mt-0.5 h-10 w-10",
      )}
    >
      <AgentIcon
        icon={agent?.icon}
        role={agent?.role}
        fallbackSeed={agent?.id ?? agentId}
        className="h-full w-full rounded-full"
      />
      {unreadCount > 0 ? (
        <span
          data-testid={`${testId}-unread-badge`}
          className="absolute -right-1.5 -top-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-[color:var(--surface-elevated)] bg-red-500 px-1 text-[10px] font-semibold leading-none text-white shadow-[0_4px_12px_-6px_rgba(220,38,38,0.85)]"
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : needsAttention ? (
        <span
          data-testid={`${testId}-unread-badge`}
          className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-[color:var(--surface-elevated)] bg-red-500"
        />
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
        <span
          data-testid={testId}
          className="absolute -right-0.5 -top-0.5 h-3.5 w-3.5 rounded-full border-2 border-[color:var(--surface-elevated)] bg-red-500"
        />
      ) : null}
    </span>
  );
}

export function ChatThreadRow({
  conversation,
  agent,
  agentId,
  sourceBadge,
  href,
  active,
  generating: generatingOverride,
  density,
  renaming,
  renameDraft,
  onRenameDraftChange,
  onCommitRename,
  onCancelRename,
  onStartRename,
  onRegenerateTitle,
  titleGenerating = false,
  onFork,
  onArchive,
  onDelete,
  archiveDeleteAllowed = true,
  onTogglePin,
  onToggleUnread,
  onCopyConversationLink,
  customGroups,
  customGroupId,
  customGroupPending,
  onMoveToCustomGroup,
  onRemoveFromCustomGroup,
  onCreateCustomGroup,
  dragHandleProps,
  dragging,
  onSelect,
}: {
  conversation: ChatConversation;
  agent: Agent | null;
  agentId: string | null;
  sourceBadge?: SourceBadge | null;
  href: string;
  active: boolean;
  generating?: boolean;
  density: MessengerThreadDensity;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onStartRename?: () => void;
  onRegenerateTitle?: () => void;
  titleGenerating?: boolean;
  onFork: () => void;
  onArchive: () => void;
  onDelete: () => void;
  archiveDeleteAllowed?: boolean;
  onTogglePin: () => void;
  onToggleUnread: () => void;
  onCopyConversationLink: () => void;
  customGroups?: MessengerCustomGroupWithEntries[];
  customGroupId?: string | null;
  customGroupPending?: boolean;
  onMoveToCustomGroup?: (groupId: string) => void;
  onRemoveFromCustomGroup?: () => void;
  onCreateCustomGroup?: (anchor: HTMLElement, invoker: HTMLButtonElement) => void;
  dragHandleProps?: SortableDragHandleProps;
  dragging?: boolean;
  onSelect: (href: string) => void;
}) {
  const coordinatedGenerating = useChatGenerationActive(conversation.id);
  const generating = generatingOverride ?? coordinatedGenerating;
  const timeLabel = relativeTime(conversation.lastMessageAt ?? conversation.updatedAt, { compactDate: true });
  const [actionsOpen, setActionsOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const customGroupHandoffRef = useRef(false);
  const compact = density === "compact";
  const rightActionClass = compact ? "right-1.5" : "right-2";
  const secondaryActionClass = compact ? "right-7" : "right-8";

  useEffect(() => {
    if (generating || titleGenerating) setActionsOpen(false);
  }, [generating, titleGenerating]);

  return (
    <MessengerThreadPreview
      threadKey={`chat:${conversation.id}`}
      eyebrow="Chat"
      title={isDefaultChatTitle(conversation.title) ? conversationDisplayTitle(conversation) : conversation.title}
      description={conversationSubtitle(conversation)}
      metadata={[
        agent?.name ? `Agent: ${agent.name}` : null,
        timeLabel,
      ]}
      suppressed={actionsOpen}
    >
    <div
      ref={rowRef}
      data-testid={`messenger-thread-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
      data-messenger-thread-key={`chat:${conversation.id}`}
      className={cn(
        "group relative flex [contain-intrinsic-size:auto_44px] [content-visibility:auto] rounded-[calc(var(--radius-md)-2px)] border transition-[background-color,border-color,color]",
        customGroupId ? "mx-0" : "mx-1.5",
        compact
          ? cn("items-center gap-2 py-1.5", customGroupId ? "px-1.5" : "px-2")
          : cn("items-start gap-3 py-2.5", customGroupId ? "px-2" : "px-3"),
        active
          ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))]"
          : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
        customGroupId && "text-[color:var(--messenger-group-entry-text)] dark:text-[color:var(--messenger-group-entry-text-dark)]",
        dragging && "shadow-sm ring-1 ring-border/70",
      )}
    >
      <MessengerDragHandle
        dragHandleProps={dragHandleProps}
        label={`Drag ${conversationDisplayTitle(conversation)}`}
        compact={compact}
      />
      <ChatAgentThreadAvatar
        agent={agent}
        agentId={agentId}
        unreadCount={conversation.unreadCount}
        needsAttention={conversation.needsAttention}
        density={density}
        testId={`messenger-thread-${sanitizeThreadKey(`chat:${conversation.id}`)}-agent-avatar`}
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
                onCancelRename();
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
                    customGroupId
                      ? conversation.isUnread ? "font-semibold text-current" : "font-medium text-current/88"
                      : conversation.isUnread ? "font-semibold text-foreground" : "font-medium text-foreground/92",
                  )}
                >
                  <span className="truncate">{conversationDisplayTitle(conversation)}</span>
                  {sourceBadge ? (
                    <span
                      data-testid={`messenger-source-badge-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
                      className="inline-flex shrink-0 items-center rounded-[calc(var(--radius-sm)-2px)] border border-sky-500/35 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-sky-700 dark:text-sky-300"
                    >
                      {sourceBadge.label}
                    </span>
                  ) : null}
                  {titleGenerating ? (
                    <span
                      data-testid={`messenger-title-generating-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[color:color-mix(in_oklab,var(--surface-active)_76%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground"
                      aria-label="Generating chat title"
                    >
                      <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />
                      Naming
                    </span>
                  ) : null}
                </div>
                {!compact ? (
                  <div
                    className={cn(
                      "mt-0.5 truncate text-[12px]",
                      customGroupId
                        ? conversation.isUnread ? "text-current/78" : "text-current/62"
                        : conversation.isUnread ? "text-foreground/76" : "text-muted-foreground",
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
                  (actionsOpen || generating || titleGenerating) && "opacity-0",
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

          {titleGenerating ? (
            <span
              data-testid={`messenger-title-spinner-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
              aria-label="Generating chat title"
              className={cn(
                "pointer-events-none absolute top-1/2 z-10 inline-flex -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-150",
                compact ? "right-1.5 h-5 w-5" : "right-2 h-6 w-6",
              )}
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.25} aria-hidden />
            </span>
          ) : null}

          {conversation.isPinned ? (
            <button
              type="button"
              data-testid={`messenger-pin-toggle-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
              className={cn(
                "absolute top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-[color:var(--accent-strong)] opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-[color:var(--accent-strong)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
                rightActionClass,
                (actionsOpen || generating || titleGenerating) && "pointer-events-none opacity-0",
              )}
              aria-label="Unpin chat"
              title="Unpin chat"
              onClick={onTogglePin}
            >
              <Pin className="h-3.5 w-3.5" strokeWidth={2.25} />
            </button>
          ) : null}

          <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
            <DropdownMenuTrigger asChild>
              <button
                ref={actionsTriggerRef}
                type="button"
                className={cn(
                  "absolute top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
                  conversation.isPinned ? secondaryActionClass : rightActionClass,
                  actionsOpen ? "opacity-100" : "opacity-0",
                  titleGenerating && "pointer-events-none opacity-0",
                )}
                aria-label="Chat actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="messenger-thread-actions-menu morph-popover morph-popover--from-right surface-overlay text-foreground"
              onCloseAutoFocus={(event) => {
                if (!customGroupHandoffRef.current) return;
                event.preventDefault();
                customGroupHandoffRef.current = false;
              }}
            >
              {onStartRename ? (
                <DropdownMenuItem onClick={onStartRename}>
                  <PencilLine className="h-4 w-4" />
                  Rename
                </DropdownMenuItem>
              ) : null}
              {onRegenerateTitle ? (
                <DropdownMenuItem disabled={titleGenerating} onClick={onRegenerateTitle}>
                  {titleGenerating ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Regenerate title
                </DropdownMenuItem>
              ) : null}
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
              <DropdownMenuItem disabled={generating} onClick={onFork}>
                <GitFork className="h-4 w-4" />
                Fork
              </DropdownMenuItem>
              {customGroups && !customGroupPending ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => {
                    if (!rowRef.current || !actionsTriggerRef.current) return;
                    customGroupHandoffRef.current = true;
                    onCreateCustomGroup?.(rowRef.current, actionsTriggerRef.current);
                  }}>
                    <FolderPlus className="h-4 w-4" />
                    New group
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <FolderInput className="h-4 w-4" />
                      Move to group
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="morph-popover morph-popover--from-left surface-overlay text-foreground">
                      {customGroupId ? (
                        <DropdownMenuItem onClick={onRemoveFromCustomGroup}>
                          Move out of group
                        </DropdownMenuItem>
                      ) : null}
                      {customGroups.length > 0 ? (
                        customGroups.map((group) => (
                          <DropdownMenuItem
                            key={group.id}
                            disabled={group.id === customGroupId}
                            onClick={() => onMoveToCustomGroup?.(group.id)}
                          >
                            <CustomGroupIcon icon={group.icon} />
                            {group.name}
                          </DropdownMenuItem>
                        ))
                      ) : (
                        <DropdownMenuItem disabled>No groups</DropdownMenuItem>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </>
              ) : null}
              {archiveDeleteAllowed ? (
                <>
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
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
    </MessengerThreadPreview>
  );
}

export function ThreadRow({
  thread,
  active,
  density,
  preserveUnreadEmphasis = false,
  onTogglePin,
  onHideIssue,
  customGroups,
  customGroupId,
  customGroupPending,
  onMoveToCustomGroup,
  onRemoveFromCustomGroup,
  onCreateCustomGroup,
  dragHandleProps,
  dragging,
  onSelect,
}: {
  thread: MessengerThreadSummary;
  active: boolean;
  density: MessengerThreadDensity;
  preserveUnreadEmphasis?: boolean;
  onTogglePin: () => void;
  onHideIssue?: () => void;
  customGroups?: MessengerCustomGroupWithEntries[];
  customGroupId?: string | null;
  customGroupPending?: boolean;
  onMoveToCustomGroup?: (groupId: string) => void;
  onRemoveFromCustomGroup?: () => void;
  onCreateCustomGroup?: (anchor: HTMLElement, invoker: HTMLButtonElement) => void;
  dragHandleProps?: SortableDragHandleProps;
  dragging?: boolean;
  onSelect: (thread: MessengerThreadSummary) => void;
}) {
  const activityKey = /^(issue|run):/.test(thread.threadKey)
    ? thread.threadKey as ActivityKey
    : null;
  const liveSummary = useActivitySummary(activityKey);
  const Icon = threadIcon(thread.kind);
  const preview = formatMessengerPreview(thread.preview) || formatMessengerPreview(thread.subtitle) || messengerThreadKindLabel(thread.kind);
  const compact = density === "compact";
  const [actionsOpen, setActionsOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const customGroupHandoffRef = useRef(false);
  const rightActionClass = compact ? "right-1.5" : "right-2";
  const secondaryActionClass = compact ? "right-7" : "right-8";
  const canTogglePin = thread.metadata?.splitIssue === true;
  const canHideIssue = thread.metadata?.splitIssue === true && Boolean(onHideIssue);
  const showActions = canTogglePin || canHideIssue || Boolean(customGroups);
  const issueStatus =
    thread.metadata?.splitIssue === true && typeof thread.metadata.status === "string"
      ? liveSummary?.status ?? thread.metadata.status
      : null;
  const unreadCount = liveSummary?.unreadCount ?? thread.unreadCount;
  const needsAttention = liveSummary?.needsAttention ?? thread.needsAttention;
  const latestActivityAt = liveSummary?.latestActivityAt ?? thread.latestActivityAt;
  const emphasizeUnread = active || preserveUnreadEmphasis || unreadCount > 0;
  const activeExecutionRunId =
    thread.metadata?.splitIssue === true && typeof thread.metadata.activeExecutionRunId === "string"
      ? thread.metadata.activeExecutionRunId
      : null;

  useEffect(() => {
    if (activeExecutionRunId) setActionsOpen(false);
  }, [activeExecutionRunId]);

  return (
    <MessengerThreadPreview
      threadKey={thread.threadKey}
      eyebrow={thread.metadata?.splitIssue === true
        ? typeof thread.metadata.issueIdentifier === "string" ? thread.metadata.issueIdentifier : "Issue"
        : messengerThreadKindLabel(thread.kind)}
      title={thread.title}
      description={thread.metadata?.splitIssue === true && typeof thread.metadata.description === "string"
        ? thread.metadata.description
        : preview}
      metadata={thread.metadata?.splitIssue === true ? [
        issueStatus ? `Status: ${issueStatus.replace(/_/g, " ")}` : null,
        typeof thread.metadata.priority === "string" ? `Priority: ${thread.metadata.priority}` : null,
        latestActivityAt ? relativeTime(new Date(latestActivityAt), { compactDate: true }) : null,
      ] : [latestActivityAt ? relativeTime(new Date(latestActivityAt), { compactDate: true }) : null]}
      suppressed={actionsOpen}
    >
    <div
      ref={rowRef}
      data-testid={`messenger-thread-${sanitizeThreadKey(thread.threadKey)}`}
      data-messenger-thread-key={thread.threadKey}
      className={cn(
        "group relative flex [contain-intrinsic-size:auto_44px] [content-visibility:auto] rounded-[calc(var(--radius-md)-2px)] border transition-[background-color,border-color,color]",
        customGroupId ? "mx-0" : "mx-1.5",
        compact
          ? cn("items-center gap-2 py-1.5", customGroupId ? "px-1.5" : "px-2")
          : cn("items-start gap-3 py-2.5", customGroupId ? "px-2" : "px-3"),
        active
          ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))]"
          : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
        customGroupId && "text-[color:var(--messenger-group-entry-text)] dark:text-[color:var(--messenger-group-entry-text-dark)]",
        dragging && "opacity-80 shadow-sm ring-1 ring-border/70",
      )}
    >
      <MessengerDragHandle
        dragHandleProps={dragHandleProps}
        label={`Drag ${threadDisplayTitle(thread.title)}`}
        compact={compact}
      />
      <Link
        to={thread.href}
        onClick={() => onSelect(thread)}
        className={cn("flex min-w-0 flex-1", compact ? "items-center gap-2" : "items-start gap-3")}
      >
        {issueStatus ? (
          <IssueStatusThreadAvatar
            status={issueStatus}
            unreadCount={unreadCount}
            needsAttention={needsAttention}
            density={density}
            testId={`${sanitizeThreadKey(thread.threadKey)}-unread-badge`}
          />
        ) : (
          <ThreadAvatar
            icon={Icon}
            unreadCount={unreadCount}
            needsAttention={needsAttention}
            density={density}
            testId={`${sanitizeThreadKey(thread.threadKey)}-unread-badge`}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className={cn(
            "grid min-w-0 gap-x-2",
            compact ? "grid-cols-[minmax(0,1fr)_2.75rem] items-center" : "grid-cols-[minmax(0,1fr)_3rem] items-start",
          )}>
            <span
              className={cn(
                "flex min-w-0 items-center gap-2 text-[13px] leading-tight",
                emphasizeUnread ? "font-semibold text-foreground" : "font-medium text-foreground/92",
              )}
            >
              <span className="truncate">{threadDisplayTitle(thread.title)}</span>
            </span>
            <span
              data-testid={`messenger-time-${sanitizeThreadKey(thread.threadKey)}`}
              className={cn(
                "block shrink-0 whitespace-nowrap text-right text-[10px] leading-none tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0",
                compact ? "w-11" : "mt-0.5 w-12",
                (actionsOpen || activeExecutionRunId) && "opacity-0",
              )}
            >
              {latestActivityAt ? relativeTime(new Date(latestActivityAt), { compactDate: true }) : "No activity"}
            </span>
          </span>
          {!compact ? (
            <span
              className={cn(
                "mt-0.5 block truncate text-[12px]",
                emphasizeUnread ? "text-foreground/76" : "text-muted-foreground",
              )}
            >
              {preview}
            </span>
          ) : null}
        </span>
      </Link>

      {activeExecutionRunId ? (
        <span
          data-testid={`messenger-active-run-${sanitizeThreadKey(thread.threadKey)}`}
          aria-label="Issue run in progress"
          title="Issue run in progress"
          className={cn(
            "pointer-events-none absolute top-1/2 z-10 inline-flex -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0",
            compact ? "right-1.5 h-5 w-5" : "right-2 h-6 w-6",
            actionsOpen && "opacity-0",
          )}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2.25} aria-hidden />
        </span>
      ) : null}

      {canTogglePin && thread.isPinned ? (
        <button
          type="button"
          data-testid={`messenger-pin-toggle-${sanitizeThreadKey(thread.threadKey)}`}
          className={cn(
            "absolute top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-[color:var(--accent-strong)] opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-[color:var(--accent-strong)] focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
            rightActionClass,
            (actionsOpen || activeExecutionRunId) && "pointer-events-none opacity-0",
          )}
          aria-label="Unpin thread"
          title="Unpin thread"
          onClick={onTogglePin}
        >
          <Pin className="h-3.5 w-3.5" strokeWidth={2.25} />
        </button>
      ) : null}

      {showActions ? (
        <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
          <DropdownMenuTrigger asChild>
            <button
              ref={actionsTriggerRef}
              type="button"
              className={cn(
                "absolute top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
                canTogglePin && thread.isPinned ? secondaryActionClass : rightActionClass,
                actionsOpen ? "opacity-100" : "opacity-0",
              )}
              aria-label="Thread actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="messenger-thread-actions-menu morph-popover morph-popover--from-right surface-overlay text-foreground"
            onCloseAutoFocus={(event) => {
              if (!customGroupHandoffRef.current) return;
              event.preventDefault();
              customGroupHandoffRef.current = false;
            }}
          >
            {canTogglePin ? (
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
            ) : null}
            {canHideIssue ? (
              <DropdownMenuItem onClick={onHideIssue}>
                <EyeOff className="h-4 w-4" />
                Hide
              </DropdownMenuItem>
            ) : null}
            {customGroups && !customGroupPending ? (
              <>
                {(canTogglePin || canHideIssue) ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onClick={() => {
                  if (!rowRef.current || !actionsTriggerRef.current) return;
                  customGroupHandoffRef.current = true;
                  onCreateCustomGroup?.(rowRef.current, actionsTriggerRef.current);
                }}>
                  <FolderPlus className="h-4 w-4" />
                  New group
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <FolderInput className="h-4 w-4" />
                    Move to group
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="morph-popover morph-popover--from-left surface-overlay text-foreground">
                    {customGroupId ? (
                      <DropdownMenuItem onClick={onRemoveFromCustomGroup}>
                        Move out of group
                      </DropdownMenuItem>
                    ) : null}
                    {customGroups.length > 0 ? (
                      customGroups.map((group) => (
                        <DropdownMenuItem
                          key={group.id}
                          disabled={group.id === customGroupId}
                          onClick={() => onMoveToCustomGroup?.(group.id)}
                        >
                          <CustomGroupIcon icon={group.icon} />
                          {group.name}
                        </DropdownMenuItem>
                      ))
                    ) : (
                      <DropdownMenuItem disabled>No groups</DropdownMenuItem>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
    </MessengerThreadPreview>
  );
}
