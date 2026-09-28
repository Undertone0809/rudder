import { PanelRight } from "lucide-react";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { ChatSideChatHistoryMenu } from "./Chat.side-chat-history";

export function ChatSidePanelActions({
  isMobile,
  sidePanelOpen,
  hasSideChatTargets,
  organizationId,
  sourceConversationId,
  onOpenPanel,
  onOpenSideChat,
}: {
  isMobile: boolean;
  sidePanelOpen: boolean;
  hasSideChatTargets: boolean;
  organizationId: string | null;
  sourceConversationId: string | null;
  onOpenPanel: () => void;
  onOpenSideChat: (target: SidePanelTarget) => void;
}) {
  const showPanelTrigger = (!isMobile && !sidePanelOpen)
    || (isMobile && !sidePanelOpen && hasSideChatTargets);

  return (
    <>
      {showPanelTrigger ? (
        <button
          type="button"
          data-testid="chat-side-panel-trigger"
          aria-label={hasSideChatTargets ? "Reopen Side Chat" : "Open Side Panel"}
          aria-pressed={false}
          title={hasSideChatTargets ? "Reopen Side Chat" : "Open Side Panel"}
          className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          onClick={onOpenPanel}
        >
          <PanelRight className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
      {organizationId && sourceConversationId ? (
        <ChatSideChatHistoryMenu
          organizationId={organizationId}
          sourceConversationId={sourceConversationId}
          onOpen={onOpenSideChat}
        />
      ) : null}
    </>
  );
}
