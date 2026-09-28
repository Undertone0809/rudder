import { queryKeys } from "@/lib/queryKeys";
import type { QueryClient } from "@tanstack/react-query";

export function invalidateSideChatHistory(
  queryClient: QueryClient,
  organizationId: string,
  parentConversationId: string,
  principalId: string | null,
) {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.chats.sideChats(organizationId, parentConversationId, principalId),
  });
}

export function invalidateSideChatHistoryForTarget<T extends { sourceConversationId: string }>(
  queryClient: QueryClient,
  organizationId: string,
  target: T,
  principalId: string | null,
) {
  return invalidateSideChatHistory(queryClient, organizationId, target.sourceConversationId, principalId);
}

export function cacheKeptSideChat<T extends { id: string }>(
  queryClient: QueryClient,
  conversation: T,
  organizationId: string,
  parentConversationId: string,
  principalId: string | null,
) {
  queryClient.setQueryData(queryKeys.chats.detail(organizationId, conversation.id), conversation);
  return invalidateSideChatHistory(queryClient, organizationId, parentConversationId, principalId);
}
