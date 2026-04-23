import type { QueryClient } from "@tanstack/react-query";
import { chatsApi } from "@/api/chats";
import { queryKeys } from "@/lib/queryKeys";

export function prefetchChatConversation(queryClient: QueryClient, chatId: string) {
  return Promise.all([
    queryClient.prefetchQuery({
      queryKey: queryKeys.chats.detail(chatId),
      queryFn: () => chatsApi.get(chatId),
    }),
    queryClient.prefetchQuery({
      queryKey: queryKeys.chats.messages(chatId),
      queryFn: () => chatsApi.listMessages(chatId),
    }),
  ]);
}
