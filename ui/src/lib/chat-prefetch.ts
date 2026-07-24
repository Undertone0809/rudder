import { chatsApi } from "@/api/chats";
import { queryKeys } from "@/lib/queryKeys";
import type { QueryClient } from "@tanstack/react-query";

export function prefetchChatConversation(queryClient: QueryClient, orgId: string, chatId: string) {
  return Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.chats.detail(orgId, chatId),
      queryFn: () => chatsApi.get(chatId),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.chats.messages(orgId, chatId),
      queryFn: () => chatsApi.listMessages(orgId, chatId, { includeTranscript: false }),
    }),
  ]);
}
