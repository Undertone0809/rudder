import { chatsApi } from "@/api/chats";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, LoaderCircle, MessageSquare } from "lucide-react";
import type { ChatConversation } from "@rudderhq/shared";
import { queryKeys } from "@/lib/queryKeys";
import { sideChatIsReadOnly } from "@/lib/side-chat";
import { sideChatTargetFromConversation, type SidePanelTarget } from "@/lib/side-panel-targets";
import { useOptionalSidePanel } from "@/context/SidePanelContext";

export function ChatSideChatHistoryMenu({
  organizationId,
  sourceConversationId,
  onOpen,
}: {
  organizationId: string;
  sourceConversationId: string;
  onOpen: (target: SidePanelTarget) => void;
}) {
  const principalId = useOptionalSidePanel()?.principalId ?? null;
  const query = useInfiniteQuery({
    queryKey: queryKeys.chats.sideChats(organizationId, sourceConversationId, principalId),
    queryFn: ({ pageParam }) => chatsApi.listSideChats(sourceConversationId, { cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const conversations = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (!query.isError && (query.isPending || conversations.length === 0)) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="side-chat-history-trigger"
          aria-label="Browse Side Chats"
          title="Browse Side Chats"
          className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <MessageSquare className="h-4 w-4" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="surface-overlay w-80 max-w-[calc(100vw-24px)] text-foreground">
        <DropdownMenuLabel>Side Chats</DropdownMenuLabel>
        {query.isError && conversations.length === 0 ? (
          <>
            <div className="px-2 py-1 text-sm" role="alert">Could not load Side Chats.</div>
            <DropdownMenuItem onSelect={(event) => {
              event.preventDefault();
              void query.refetch();
            }}>
              Retry
            </DropdownMenuItem>
          </>
        ) : conversations.map((conversation: ChatConversation) => {
          const readOnly = sideChatIsReadOnly(conversation);
          return (
            <DropdownMenuItem
              key={conversation.id}
              data-testid="side-chat-history-item"
              aria-label={`Open Side Chat ${conversation.title}`}
              onSelect={() => onOpen(sideChatTargetFromConversation(sourceConversationId, conversation))}
            >
              <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {readOnly ? "Expired · read-only" : "Active"}
              </span>
            </DropdownMenuItem>
          );
        })}
        {query.hasNextPage ? (
          <div className="border-t border-border/60 px-2 py-2">
            {query.isFetchNextPageError ? (
              <>
                <div className="px-2 py-1 text-sm" role="alert">Could not load more Side Chats.</div>
                <DropdownMenuItem onSelect={(event) => {
                  event.preventDefault();
                  void query.fetchNextPage();
                }}>
                  Retry
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem
                data-testid="side-chat-history-load-more"
                disabled={query.isFetchingNextPage}
                className="justify-center text-muted-foreground"
                onSelect={(event) => {
                  event.preventDefault();
                  void query.fetchNextPage();
                }}
              >
                {query.isFetchingNextPage ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <ChevronDown className="h-4 w-4" aria-hidden />
                )}
                {query.isFetchingNextPage ? "Loading Side Chats" : "Load more Side Chats"}
              </DropdownMenuItem>
            )}
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
