import { Loader2 } from "lucide-react";
import type { ComponentProps } from "react";
import { OptimisticUserDraftItem } from "./Chat.messages";

/** Presentation only: operation ownership belongs to FirstChatTurnStore. */
export function ChatPendingFirstTurn(props: ComponentProps<typeof OptimisticUserDraftItem>) {
  return (
    <div
      data-testid="chat-pending-first-turn"
      className="flex w-full max-w-3xl flex-col items-end gap-1 px-1"
    >
      <OptimisticUserDraftItem {...props} />
      <div
        data-testid="chat-pending-first-turn-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        <span>Sending message...</span>
      </div>
    </div>
  );
}

export function firstChatTurnRecoveryToast(
  sourcePath: string,
  recovery: { conversationId: string | null } | null,
) {
  if (!recovery) return {};
  return {
    persistent: true,
    action: {
      label: "Open recovered draft",
      href: recovery.conversationId?.startsWith("first-turn-recovery:")
        ? `${sourcePath}?firstTurnRecovery=${encodeURIComponent(recovery.conversationId.slice("first-turn-recovery:".length))}`
        : recovery.conversationId?.startsWith("local-app-recovery:")
          ? `${sourcePath}?localAppRecoveryDraft=${encodeURIComponent(recovery.conversationId.slice("local-app-recovery:".length))}`
          : sourcePath,
    },
  };
}
