import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { ChatSideChatHistoryMenu } from "./Chat.side-chat-history";

export function ChatSidePanelActions({
  organizationId,
  sourceConversationId,
  onOpenSideChat,
}: {
  organizationId: string | null;
  sourceConversationId: string | null;
  onOpenSideChat: (target: SidePanelTarget) => void;
}) {
  if (!organizationId || !sourceConversationId) return null;

  return (
    <ChatSideChatHistoryMenu
      organizationId={organizationId}
      sourceConversationId={sourceConversationId}
      onOpen={onOpenSideChat}
    />
  );
}
