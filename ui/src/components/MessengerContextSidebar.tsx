import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  CircleDot,
  Copy,
  DollarSign,
  MessageSquare,
  MoreHorizontal,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  ShieldCheck,
  UserPlus,
  XCircle,
} from "lucide-react";
import type { ChatConversation } from "@rudder/shared";
import { chatsApi } from "@/api/chats";
import { messengerApi } from "@/api/messenger";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { cn, relativeTime } from "@/lib/utils";
import { useSidebar } from "@/context/SidebarContext";
import { messengerThreadKindLabel, resolveMessengerRoute, useMessengerModel } from "@/hooks/useMessenger";
import { rememberMessengerPath } from "@/lib/messenger-memory";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { queryKeys } from "@/lib/queryKeys";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";

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
      className="workspace-card-header workspace-context-header desktop-chrome desktop-window-drag flex shrink-0 items-center px-4 py-3"
    >
      <div className="min-w-0">
        <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{description}</p>
      </div>
    </header>
  );
}

function threadIcon(kind: string) {
  switch (kind) {
    case "chat":
      return MessageSquare;
    case "issues":
      return CircleDot;
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

function conversationSubtitle(conversation: ChatConversation) {
  return (
    conversation.latestReplyPreview ||
    conversation.summary ||
    (conversation.primaryIssue
      ? `${conversation.primaryIssue.identifier ?? conversation.primaryIssue.id} · ${conversation.primaryIssue.title}`
      : null) ||
    "Start the conversation"
  );
}

function ThreadAvatar({
  icon: Icon,
  unreadCount,
  needsAttention,
  shape = "circle",
  testId,
}: {
  icon: typeof MessageSquare;
  unreadCount: number;
  needsAttention: boolean;
  shape?: "circle" | "rounded";
  testId?: string;
}) {
  return (
    <span
      className={cn(
        "relative mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_78%,transparent)] text-[color:var(--accent-strong)]",
        shape === "rounded" ? "rounded-[calc(var(--radius-sm)+1px)]" : "rounded-full",
      )}
    >
      <Icon className="h-4.5 w-4.5" />
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

function ChatThreadRow({
  conversation,
  href,
  active,
  renaming,
  renameDraft,
  onRenameDraftChange,
  onCommitRename,
  onStartRename,
  onArchive,
  onTogglePin,
  onCopyConversationId,
  onSelect,
}: {
  conversation: ChatConversation;
  href: string;
  active: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onCommitRename: () => void;
  onStartRename: () => void;
  onArchive: () => void;
  onTogglePin: () => void;
  onCopyConversationId: () => void;
  onSelect: (href: string) => void;
}) {
  const timeLabel = relativeTime(conversation.lastMessageAt ?? conversation.updatedAt);
  const [actionsOpen, setActionsOpen] = useState(false);

  return (
    <div
      data-testid={`messenger-thread-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
      className={cn(
        "group relative mx-1.5 flex items-start gap-3 rounded-[calc(var(--radius-md)-2px)] border px-3 py-2.5 transition-[background-color,border-color,color]",
        active
          ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))]"
          : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
      )}
    >
      <ThreadAvatar
        icon={MessageSquare}
        unreadCount={conversation.unreadCount}
        needsAttention={conversation.needsAttention}
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
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_3rem] items-start gap-x-2">
              <div className="min-w-0">
                <div
                  className={cn(
                    "flex items-center gap-2 text-[13px] leading-tight",
                    conversation.isUnread ? "font-semibold text-foreground" : "font-medium text-foreground/92",
                  )}
                >
                  <span className="truncate">{conversation.title}</span>
                  {conversation.isPinned ? (
                    <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />
                  ) : null}
                </div>
                <div
                  className={cn(
                    "mt-0.5 truncate text-[12px]",
                    conversation.isUnread ? "text-foreground/76" : "text-muted-foreground",
                  )}
                >
                  {conversationSubtitle(conversation)}
                </div>
              </div>
              <span
                data-testid={`messenger-time-${sanitizeThreadKey(`chat:${conversation.id}`)}`}
                className={cn(
                  "mt-0.5 block w-12 shrink-0 whitespace-nowrap text-right text-[10px] leading-none tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0",
                  actionsOpen && "opacity-0",
                )}
              >
                {timeLabel}
              </span>
            </div>
          </Link>

          <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-page)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
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
              <DropdownMenuItem onClick={onCopyConversationId}>
                <Copy className="h-4 w-4" />
                Copy chat ID
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onArchive}>
                <Archive className="h-4 w-4" />
                Archive
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
  onSelect,
}: {
  thread: ReturnType<typeof useMessengerModel>["threadSummaries"][number];
  active: boolean;
  onSelect: (href: string) => void;
}) {
  const Icon = threadIcon(thread.kind);
  const row = (
    <Link
      to={thread.href}
      onClick={() => onSelect(thread.href)}
      data-testid={`messenger-thread-${sanitizeThreadKey(thread.threadKey)}`}
      className={cn(
        "mx-1.5 flex items-start gap-3 rounded-[calc(var(--radius-md)-2px)] border px-3 py-2.5 transition-[background-color,border-color,color]",
        active
          ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))]"
          : "border-transparent hover:border-[color:color-mix(in_oklab,var(--border-soft)_70%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-active)_62%,transparent)]",
      )}
    >
      <ThreadAvatar
        icon={Icon}
        unreadCount={thread.unreadCount}
        needsAttention={thread.needsAttention}
        testId={`${sanitizeThreadKey(thread.threadKey)}-unread-badge`}
      />
      <span className="min-w-0 flex-1">
        <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_3rem] items-start gap-x-2">
          <span
            className={cn(
              "min-w-0 truncate text-[13px] leading-tight",
              thread.unreadCount > 0 ? "font-semibold text-foreground" : "font-medium text-foreground/92",
            )}
          >
            {thread.title}
          </span>
          <span
            data-testid={`messenger-time-${sanitizeThreadKey(thread.threadKey)}`}
            className="mt-0.5 block w-12 shrink-0 whitespace-nowrap text-right text-[10px] leading-none tabular-nums text-muted-foreground"
          >
            {thread.latestActivityAt ? relativeTime(new Date(thread.latestActivityAt)) : "No activity"}
          </span>
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate text-[12px]",
            thread.unreadCount > 0 ? "text-foreground/76" : "text-muted-foreground",
          )}
        >
          {thread.preview || thread.subtitle || messengerThreadKindLabel(thread.kind)}
        </span>
      </span>
    </Link>
  );

  return row;
}

export function MessengerContextSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const relativePath = toOrganizationRelativePath(location.pathname);
  const model = useMessengerModel();
  const { isMobile, setSidebarOpen } = useSidebar();
  const queryClient = useQueryClient();
  const route = resolveMessengerRoute(relativePath);
  const markedThreadRef = useRef<string | null>(null);
  const sidebarScrollRef = useScrollbarActivityRef("rudder:sidebar-scroll:messenger");
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const chatsQuery = useQuery({
    queryKey: queryKeys.chats.list(model.selectedOrganizationId ?? "__none__", "all"),
    queryFn: () => chatsApi.list(model.selectedOrganizationId!, "all"),
    enabled: !!model.selectedOrganizationId,
  });

  const conversationsById = useMemo(() => {
    const map = new Map<string, ChatConversation>();
    for (const conversation of chatsQuery.data ?? []) {
      map.set(conversation.id, conversation);
    }
    return map;
  }, [chatsQuery.data]);

  const activeThreadKey = useMemo(() => {
    if (route.kind === "chat" && route.conversationId) return `chat:${route.conversationId}`;
    if (route.kind === "issues") return "issues";
    if (route.kind === "approvals") return "approvals";
    if (route.kind === "system") return route.threadKind;
    return null;
  }, [route]);
  const activeThread = useMemo(
    () => model.threadSummaries.find((thread) => thread.threadKey === activeThreadKey) ?? null,
    [activeThreadKey, model.threadSummaries],
  );
  const activeThreadDetailReady = useMemo(() => {
    if (route.kind === "issues") return !!model.issueThreadDetail;
    if (route.kind === "approvals") return !!model.approvalThreadDetail;
    if (route.kind === "system") return !!model.systemThreadDetail;
    return false;
  }, [model.approvalThreadDetail, model.issueThreadDetail, model.systemThreadDetail, route]);
  const activeThreadReadAt = useMemo(() => {
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

  const refreshChatViews = async (chatId?: string) => {
    if (!model.selectedOrganizationId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(model.selectedOrganizationId) }),
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

  const updateConversationUserStateMutation = useMutation({
    mutationFn: ({ chatId, pinned }: { chatId: string; pinned: boolean }) =>
      chatsApi.updateUserState(chatId, { pinned }),
    onSuccess: async (conversation) => {
      await refreshChatViews(conversation.id);
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
      await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(orgId) });
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

  if (!model.selectedOrganizationId) return null;

  return (
    <aside
      data-testid="workspace-sidebar"
      className="workspace-context-sidebar flex min-h-0 w-full min-w-0 shrink-0 flex-col"
    >
      <ContextColumnHeader title="Messenger" description="Threads sorted by latest activity" />
      <div className="px-3.5 pt-3.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/72">Threads</div>
      <nav
        ref={sidebarScrollRef}
        className="scrollbar-auto-hide mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 pb-3.5"
      >
        <Link
          to="/messenger/chat"
          onClick={() => handleMessengerEntrySelect("/messenger/chat")}
          className={cn(
            "mx-1.5 flex items-center gap-3 rounded-[calc(var(--radius-md)-2px)] border border-transparent px-3 py-2.5 text-sm transition-[background-color,border-color,color]",
            route.kind === "chat" && !route.conversationId
              ? "chat-conversation-active border-[color:var(--border-strong)] bg-[color:color-mix(in_oklab,var(--surface-active)_90%,var(--surface-elevated))] font-medium text-foreground"
              : "text-foreground/78 hover:border-[color:color-mix(in_oklab,var(--border-soft)_52%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_68%,transparent)] hover:text-foreground",
          )}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)+1px)] border border-[color:color-mix(in_oklab,var(--border-soft)_88%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-active)_82%,transparent)] text-[color:var(--accent-strong)]">
            <Plus className="h-4.5 w-4.5" />
          </span>
          <span className="truncate text-[13px] font-medium leading-tight">New chat</span>
        </Link>
        {model.isLoading && model.threadSummaries.length === 0 ? (
          <div className="space-y-1 px-1.5">
            {Array.from({ length: 5 }).map((_, index) => (
              <div
                key={index}
                className="h-[72px] animate-pulse rounded-[calc(var(--radius-md)-2px)] border border-transparent bg-[color:color-mix(in_oklab,var(--surface-elevated)_60%,transparent)]"
              />
            ))}
          </div>
        ) : null}
        {model.threadSummaries.map((thread) => {
          const active = activeThreadKey === thread.threadKey;
          const conversationId = threadConversationId(thread.threadKey);
          const conversation = conversationId ? conversationsById.get(conversationId) ?? null : null;
          if (thread.kind === "chat" && conversation) {
            return (
              <ChatThreadRow
                key={thread.threadKey}
                conversation={conversation}
                href={thread.href}
                active={active}
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
                onTogglePin={() => {
                  updateConversationUserStateMutation.mutate({
                    chatId: conversation.id,
                    pinned: !conversation.isPinned,
                  });
                }}
                onCopyConversationId={() => void copyConversationId(conversation.id)}
                onSelect={handleMessengerEntrySelect}
              />
            );
          }

          return <ThreadRow key={thread.threadKey} thread={thread} active={active} onSelect={handleMessengerEntrySelect} />;
        })}
      </nav>
    </aside>
  );
}
