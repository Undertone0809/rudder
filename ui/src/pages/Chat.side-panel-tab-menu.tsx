import { chatsApi } from "@/api/chats";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { sideChatIsReadOnly } from "@/lib/side-chat";
import { sidePanelTargetSupportsSavedView, type SidePanelTarget } from "@/lib/side-panel-targets";
import { useQuery } from "@tanstack/react-query";
import { CopyPlus, MessageSquare, X } from "lucide-react";
import { useRef, useState, type ReactElement } from "react";

export type SideChatTarget = Extract<SidePanelTarget, { kind: "side_chat" }>;

export function ChatSidePanelTabContextMenu({
  children,
  closeDisabled,
  isMobile,
  moveInProgress,
  organizationId,
  tab,
  onClose,
  onOpenInNewTab,
  onMoveSideChat,
}: {
  children: ReactElement;
  closeDisabled: boolean;
  isMobile: boolean;
  moveInProgress: boolean;
  organizationId: string | null | undefined;
  tab: SidePanelTarget;
  onClose: (tab: SidePanelTarget) => void;
  onOpenInNewTab: (tab: SidePanelTarget) => void;
  onMoveSideChat: (tab: SideChatTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerTabRef = useRef<HTMLButtonElement | null>(null);
  const restoreTriggerTabFocusRef = useRef(false);
  const sideChat = tab.kind === "side_chat" ? tab : null;
  const conversationQuery = useQuery({
    queryKey: queryKeys.chats.detail(organizationId ?? "__none__", sideChat?.conversationId ?? "__side-chat-draft__"),
    queryFn: () => chatsApi.get(sideChat!.conversationId!),
    enabled: open && Boolean(organizationId && sideChat?.conversationId),
  });
  const conversation = conversationQuery.data ?? null;
  const conversationStatusLoading = Boolean(
    sideChat?.conversationId && (conversationQuery.isPending || conversationQuery.isFetching),
  );
  const canMoveSideChat = Boolean(
    sideChat?.conversationId
    && !moveInProgress
    && !conversationStatusLoading
    && !conversationQuery.isError
    && conversation?.sideChatState === "active"
    && !sideChatIsReadOnly(conversation),
  );
  const moveTooltip = !sideChat?.conversationId
    ? "Send a message first to create this Side Chat."
    : moveInProgress || conversationStatusLoading
      ? "Checking whether this Side Chat can be moved…"
      : canMoveSideChat
        ? "Make this Side Chat a regular Messenger chat. This tab will close."
        : "This Side Chat can no longer be moved. End and delete it instead.";
  const closeLabel = sideChat
    ? sideChat.conversationId
      ? "End and delete Side Chat"
      : "Discard Side Chat Draft"
    : "Close";

  return (
    <ContextMenu
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen && sideChat?.conversationId) void conversationQuery.refetch();
      }}
    >
      <ContextMenuTrigger
        asChild
        onContextMenu={(event) => {
          triggerTabRef.current = event.currentTarget.querySelector<HTMLButtonElement>('[role="tab"]');
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        data-testid="chat-side-panel-tab-context-menu"
        className="surface-overlay z-[70] w-48 text-foreground"
        onContextMenu={(event) => event.preventDefault()}
        onEscapeKeyDown={() => {
          restoreTriggerTabFocusRef.current = true;
        }}
        onCloseAutoFocus={(event) => {
          if (!restoreTriggerTabFocusRef.current) return;
          restoreTriggerTabFocusRef.current = false;
          if (!triggerTabRef.current?.isConnected) return;
          event.preventDefault();
          triggerTabRef.current.focus();
        }}
      >
        {sideChat ? (
          <>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <ContextMenuItem
                    aria-disabled={canMoveSideChat ? undefined : "true"}
                    data-disabled={canMoveSideChat ? undefined : ""}
                    onSelect={(event) => {
                      if (!canMoveSideChat) {
                        event.preventDefault();
                        return;
                      }
                      onMoveSideChat(sideChat);
                    }}
                  >
                    <MessageSquare />
                    Move to Messenger
                  </ContextMenuItem>
                </TooltipTrigger>
                <TooltipContent
                  side={isMobile ? "bottom" : "left"}
                  align={isMobile ? "start" : "center"}
                  collisionPadding={8}
                  className="z-[80] max-w-[calc(100vw-1rem)] whitespace-normal sm:max-w-xs"
                >
                  {moveTooltip}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <ContextMenuSeparator />
          </>
        ) : null}
        {sidePanelTargetSupportsSavedView(tab) ? (
          <>
            <ContextMenuItem onSelect={() => onOpenInNewTab(tab)}>
              <CopyPlus />
              Open in new tab
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem
          aria-disabled={closeDisabled ? "true" : undefined}
          data-disabled={closeDisabled ? "" : undefined}
          onSelect={(event) => {
            if (closeDisabled) {
              event.preventDefault();
              return;
            }
            onClose(tab);
          }}
        >
          <X />
          {closeLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
