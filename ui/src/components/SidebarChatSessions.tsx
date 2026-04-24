import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, MoreHorizontal, PencilLine, Pin, PinOff, Plus } from "lucide-react";
import type { ChatConversation } from "@rudderhq/shared";
import { useLocation, useNavigate } from "@/lib/router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Collapsible,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { ExactTimestampTooltip } from "@/components/HoverTimestamp";
import { useOrganization } from "@/context/OrganizationContext";
import { useSidebar } from "@/context/SidebarContext";
import { chatsApi } from "@/api/chats";
import { prefetchChatConversation } from "@/lib/chat-prefetch";
import { queryKeys } from "@/lib/queryKeys";
import { cn, relativeTime } from "@/lib/utils";
import { SidebarSectionActionButton, SidebarSectionHeader } from "@/components/SidebarSectionHeader";
import { sidebarItemVariants } from "@/components/sidebarItemStyles";

function conversationSubtitle(conversation: ChatConversation): string {
  if (conversation.primaryIssue) {
    return `${conversation.primaryIssue.identifier ?? conversation.primaryIssue.id} · ${conversation.primaryIssue.title}`;
  }
  if (conversation.chatRuntime.model) {
    return `${conversation.chatRuntime.sourceLabel} · ${conversation.chatRuntime.model}`;
  }
  return conversation.summary || "Clarify, route, or convert to issue";
}

function ConversationRow({
  conversation,
  active,
  renaming,
  renameDraft,
  onRenameDraftChange,
  onSelect,
  onPrefetch,
  onStartRename,
  onCommitRename,
  onArchive,
  onTogglePin,
}: {
  conversation: ChatConversation;
  active: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onSelect: () => void;
  onPrefetch: () => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onArchive: () => void;
  onTogglePin: () => void;
}) {
  const subtitle = conversationSubtitle(conversation);
  const timeLabel = conversation.lastMessageAt
    ? relativeTime(conversation.lastMessageAt)
    : relativeTime(conversation.updatedAt);
  const [actionsOpen, setActionsOpen] = useState(false);

  return (
    <ExactTimestampTooltip date={conversation.lastMessageAt ?? conversation.updatedAt}>
      <div
        className={cn(
          sidebarItemVariants({ variant: "compact", active }),
          "group transition-[background-color,color,border-color] duration-150",
        )}
      >
      {renaming ? (
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
          }}
          className="min-h-0 w-full min-w-0 flex-1 rounded-[var(--radius-sm)] border border-border bg-background px-2 py-1 text-[13px] leading-tight outline-none"
        />
      ) : (
        <>
          <button
            type="button"
            onClick={onSelect}
            onPointerDown={onPrefetch}
            onMouseEnter={onPrefetch}
            onFocus={onPrefetch}
            className="min-w-0 flex-1 truncate text-left text-[13px] font-medium leading-tight text-foreground/90"
            title={subtitle}
          >
            <span className="flex items-center gap-2">
              <span className="truncate">{conversation.title}</span>
              {conversation.isUnread ? (
                <span className="inline-flex h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="Unread chat" />
              ) : null}
            </span>
          </button>
          <div className="relative ml-auto h-5 w-12 shrink-0">
            <span
              className={cn(
                "pointer-events-none absolute inset-y-0 right-0 flex items-center whitespace-nowrap text-[11px] tabular-nums text-muted-foreground transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0",
                actionsOpen && "opacity-0",
              )}
            >
              {timeLabel}
            </span>
            <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "absolute inset-y-0 right-0 z-10 flex items-center justify-end rounded p-0.5 text-muted-foreground transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
                    actionsOpen ? "opacity-100" : "opacity-0",
                  )}
                  aria-label="Chat actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="surface-overlay text-foreground">
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
                <DropdownMenuItem onClick={onArchive}>
                  <Archive className="h-4 w-4" />
                  Archive
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}
      </div>
    </ExactTimestampTooltip>
  );
}

function activeConversationIdFromPath(pathname: string): string | null {
  const m = pathname.match(/\/chat\/([^/]+)\/?/);
  return m?.[1] ?? null;
}

export function SidebarChatSessions() {
  const [open, setOpen] = useState(true);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const { selectedOrganizationId } = useOrganization();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const activeConversationId = activeConversationIdFromPath(location.pathname);

  const conversationsQuery = useQuery({
    queryKey: queryKeys.chats.list(selectedOrganizationId ?? "__none__", "active"),
    queryFn: () => chatsApi.list(selectedOrganizationId!, "active"),
    enabled: !!selectedOrganizationId,
  });

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
        navigate("/chat");
      }
      setRenamingConversationId((current) => (current === conversation.id ? null : current));
      await refreshChatList(conversation.id);
    },
  });

  const updateUserStateMutation = useMutation({
    mutationFn: ({ chatId, pinned }: { chatId: string; pinned: boolean }) =>
      chatsApi.updateUserState(chatId, { pinned }),
    onSuccess: async (conversation) => {
      await refreshChatList(conversation.id);
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

  if (!selectedOrganizationId) {
    return null;
  }

  const conversations = conversationsQuery.data ?? [];
  const pinnedConversations = conversations.filter((conversation) => conversation.isPinned);
  const recentConversations = conversations.filter((conversation) => !conversation.isPinned);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <SidebarSectionHeader
        label="Chats"
        collapsible
        open={open}
        onToggle={() => setOpen((current) => !current)}
        action={(
          <SidebarSectionActionButton
            aria-label="New chat"
            onClick={(e) => {
              e.stopPropagation();
              navigate("/chat");
              if (isMobile) setSidebarOpen(false);
            }}
          >
            <Plus className="h-3 w-3" />
          </SidebarSectionActionButton>
        )}
      />

      <CollapsibleContent>
        <div className="mt-0.5 flex flex-col gap-0.5">
          {conversations.length === 0 ? (
            <div className="surface-inset rounded-[var(--radius-md)] border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              No active conversations yet.
            </div>
          ) : (
            <>
              {pinnedConversations.length > 0 ? (
                <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                  Pinned
                </div>
              ) : null}
              {pinnedConversations.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeConversationId}
                  renaming={renamingConversationId === conversation.id}
                  renameDraft={renameDraft}
                  onRenameDraftChange={setRenameDraft}
                  onSelect={() => {
                    void prefetchChatConversation(queryClient, conversation.id);
                    navigate(`/chat/${conversation.id}`);
                    if (isMobile) setSidebarOpen(false);
                  }}
                  onPrefetch={() => {
                    if (conversation.id !== activeConversationId) {
                      void prefetchChatConversation(queryClient, conversation.id);
                    }
                  }}
                  onStartRename={() => {
                    setRenamingConversationId(conversation.id);
                    setRenameDraft(conversation.title);
                  }}
                  onCommitRename={submitRename}
                  onTogglePin={() => {
                    updateUserStateMutation.mutate({
                      chatId: conversation.id,
                      pinned: !conversation.isPinned,
                    });
                  }}
                  onArchive={() => {
                    updateConversationMutation.mutate({
                      chatId: conversation.id,
                      data: { status: "archived" },
                    });
                  }}
                />
              ))}
              {recentConversations.length > 0 ? (
                <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                  Recent
                </div>
              ) : null}
              {recentConversations.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeConversationId}
                  renaming={renamingConversationId === conversation.id}
                  renameDraft={renameDraft}
                  onRenameDraftChange={setRenameDraft}
                  onSelect={() => {
                    void prefetchChatConversation(queryClient, conversation.id);
                    navigate(`/chat/${conversation.id}`);
                    if (isMobile) setSidebarOpen(false);
                  }}
                  onPrefetch={() => {
                    if (conversation.id !== activeConversationId) {
                      void prefetchChatConversation(queryClient, conversation.id);
                    }
                  }}
                  onStartRename={() => {
                    setRenamingConversationId(conversation.id);
                    setRenameDraft(conversation.title);
                  }}
                  onCommitRename={submitRename}
                  onTogglePin={() => {
                    updateUserStateMutation.mutate({
                      chatId: conversation.id,
                      pinned: !conversation.isPinned,
                    });
                  }}
                  onArchive={() => {
                    updateConversationMutation.mutate({
                      chatId: conversation.id,
                      data: { status: "archived" },
                    });
                  }}
                />
              ))}
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
