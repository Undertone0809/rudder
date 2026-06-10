import type { QueryClient } from "@tanstack/react-query";
import type { ChatConversation, MessengerThreadSummary, SidebarBadges } from "@rudderhq/shared";
import { queryKeys } from "@/lib/queryKeys";

interface MessengerThreadPageData {
  pages: Array<{
    items: MessengerThreadSummary[];
    pageInfo: { limit?: number; nextCursor?: string | null; hasMore?: boolean };
  }>;
  pageParams: unknown[];
}

interface MessengerThreadPreviewData {
  items: MessengerThreadSummary[];
  pageInfo: { limit?: number; nextCursor?: string | null; hasMore?: boolean };
}

function encodeMessengerThreadSummaryCursor(summary: MessengerThreadSummary) {
  const payload = {
    activityAt: new Date(summary.latestActivityAt ?? 0).toISOString(),
    title: summary.title,
    threadKey: summary.threadKey,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function mergeMessengerThreadSummaries(current: MessengerThreadSummary[], incoming: MessengerThreadSummary) {
  const withoutCurrent = current.filter((thread) => thread.threadKey !== incoming.threadKey);
  return [incoming, ...withoutCurrent].sort((a, b) => {
    const aPinned = Boolean(a.isPinned);
    const bPinned = Boolean(b.isPinned);
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    const aTime = a.latestActivityAt ? new Date(a.latestActivityAt).getTime() : Number.NEGATIVE_INFINITY;
    const bTime = b.latestActivityAt ? new Date(b.latestActivityAt).getTime() : Number.NEGATIVE_INFINITY;
    if (aTime !== bTime) return bTime - aTime;
    return a.title.localeCompare(b.title);
  });
}

function upsertMessengerThreadPageData(current: MessengerThreadPageData | undefined, incoming: MessengerThreadSummary) {
  if (!current) return current;
  return {
    ...current,
    pages: current.pages.map((page, index) => {
      const nextItems = index === 0
        ? mergeMessengerThreadSummaries(page.items, incoming)
        : page.items.filter((thread) => thread.threadKey !== incoming.threadKey);
      const pageLimit = typeof page.pageInfo.limit === "number" ? page.pageInfo.limit : null;
      const items = index === 0 && pageLimit !== null
        ? nextItems.slice(0, pageLimit)
        : nextItems;
      const lastItem = items.at(-1);
      const hasMore = page.pageInfo.hasMore === true || nextItems.length > items.length;
      return {
        ...page,
        items,
        pageInfo: index === 0 && hasMore && lastItem
          ? { ...page.pageInfo, hasMore: true, nextCursor: encodeMessengerThreadSummaryCursor(lastItem) }
          : page.pageInfo,
      };
    }),
  };
}

function readAtDate(readAt?: MessengerThreadSummary["lastReadAt"] | string | null) {
  if (!readAt) return new Date();
  const date = new Date(readAt);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function markThreadRead(summary: MessengerThreadSummary, threadKey: string, readAt: Date) {
  if (summary.threadKey !== threadKey) return summary;
  return {
    ...summary,
    lastReadAt: readAt,
    unreadCount: 0,
    needsAttention: false,
  };
}

function markThreadPageDataRead(
  current: MessengerThreadPageData | undefined,
  threadKey: string,
  readAt: Date,
) {
  if (!current) return current;
  return {
    ...current,
    pages: current.pages.map((page) => ({
      ...page,
      items: page.items.map((item) => markThreadRead(item, threadKey, readAt)),
    })),
  };
}

function markThreadPreviewDataRead(
  current: MessengerThreadPreviewData | undefined,
  threadKey: string,
  readAt: Date,
) {
  if (!current) return current;
  return {
    ...current,
    items: current.items.map((item) => markThreadRead(item, threadKey, readAt)),
  };
}

function markChatConversationRead(conversation: ChatConversation, readAt: Date): ChatConversation {
  return {
    ...conversation,
    lastReadAt: readAt,
    isUnread: false,
    unreadCount: 0,
    needsAttention: false,
  };
}

function decrementUnreadChatSidebarBadge(current: SidebarBadges | undefined) {
  if (!current) return current;
  const chatAttention = Math.max(0, current.chatAttention - 1);
  return {
    ...current,
    inbox: Math.max(0, current.inbox - (current.chatAttention > chatAttention ? 1 : 0)),
    chatAttention,
  };
}

export function invalidateMessengerThreadSummaryQueries(queryClient: QueryClient, orgId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(orgId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threadPages(orgId) }),
  ]);
}

export function markMessengerThreadReadInCache(
  queryClient: QueryClient,
  orgId: string,
  threadKey: string,
  readAt?: MessengerThreadSummary["lastReadAt"] | string | null,
) {
  const nextReadAt = readAtDate(readAt);
  queryClient.setQueryData<MessengerThreadSummary[]>(
    queryKeys.messenger.threads(orgId),
    (current) => current?.map((summary) => markThreadRead(summary, threadKey, nextReadAt)) ?? current,
  );
  queryClient.setQueriesData<MessengerThreadPageData>(
    { queryKey: queryKeys.messenger.threadPages(orgId) },
    (current) => markThreadPageDataRead(current, threadKey, nextReadAt),
  );
  queryClient.setQueryData<MessengerThreadPreviewData>(
    queryKeys.messenger.threadPreview(orgId),
    (current) => markThreadPreviewDataRead(current, threadKey, nextReadAt),
  );
}

export function markMessengerChatReadInCache(
  queryClient: QueryClient,
  orgId: string,
  conversation: ChatConversation,
  options: { decrementSidebarBadge?: boolean; readAt?: ChatConversation["lastReadAt"] | string | null } = {},
) {
  const nextReadAt = readAtDate(options.readAt ?? conversation.lastMessageAt ?? conversation.updatedAt);
  const nextConversation = markChatConversationRead(conversation, nextReadAt);

  queryClient.setQueryData<ChatConversation>(
    queryKeys.chats.detail(conversation.id),
    (current) => current ? markChatConversationRead(current, nextReadAt) : nextConversation,
  );
  for (const status of ["active", "all"] as const) {
    queryClient.setQueryData<ChatConversation[]>(
      queryKeys.chats.list(orgId, status),
      (current) => current?.map((item) =>
        item.id === conversation.id ? markChatConversationRead(item, nextReadAt) : item,
      ) ?? current,
    );
  }

  markMessengerThreadReadInCache(queryClient, orgId, `chat:${conversation.id}`, nextReadAt);

  if (options.decrementSidebarBadge) {
    queryClient.setQueryData<SidebarBadges>(
      queryKeys.sidebarBadges(orgId),
      decrementUnreadChatSidebarBadge,
    );
  }
}

export function upsertMessengerThreadSummaryQueries(
  queryClient: QueryClient,
  orgId: string,
  summary: MessengerThreadSummary,
) {
  queryClient.setQueryData<MessengerThreadSummary[]>(
    queryKeys.messenger.threads(orgId),
    (current) => mergeMessengerThreadSummaries(current ?? [], summary),
  );
  queryClient.setQueriesData<MessengerThreadPageData>(
    { queryKey: queryKeys.messenger.threadPages(orgId) },
    (current) => upsertMessengerThreadPageData(current, summary),
  );
}
