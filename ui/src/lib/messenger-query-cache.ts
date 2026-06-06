import type { QueryClient } from "@tanstack/react-query";
import type { MessengerThreadSummary } from "@rudderhq/shared";
import { queryKeys } from "@/lib/queryKeys";

interface MessengerThreadPageData {
  pages: Array<{
    items: MessengerThreadSummary[];
    pageInfo: { limit?: number; nextCursor?: string | null; hasMore?: boolean };
  }>;
  pageParams: unknown[];
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

export function invalidateMessengerThreadSummaryQueries(queryClient: QueryClient, orgId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(orgId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threadPages(orgId) }),
  ]);
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
