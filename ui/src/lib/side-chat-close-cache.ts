import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { invalidateSideChatHistoryForTarget } from "@/lib/side-chat-history-cache";

type SideChatCloseTarget = { sourceConversationId: string };

export function reconcileSideChatCloseCache(
  queryClient: QueryClient,
  options: {
    organizationId: string;
    messengerOrganizationId: string | null;
    conversationId: string;
    target: SideChatCloseTarget;
    principalId: string | null;
    status?: 404 | 409 | 410;
    refreshHistory: boolean;
  },
) {
  const detailKey = queryKeys.chats.detail(options.organizationId, options.conversationId);
  if (options.status === undefined || options.status === 404 || options.status === 410) {
    queryClient.removeQueries({ queryKey: detailKey });
    queryClient.removeQueries({
      queryKey: queryKeys.chats.messages(options.organizationId, options.conversationId),
    });
  } else {
    void queryClient.invalidateQueries({ queryKey: detailKey });
    void queryClient.invalidateQueries({ queryKey: ["messenger", options.messengerOrganizationId] });
  }
  if (options.refreshHistory) {
    void invalidateSideChatHistoryForTarget(
      queryClient,
      options.organizationId,
      options.target,
      options.principalId,
    );
  }
}
