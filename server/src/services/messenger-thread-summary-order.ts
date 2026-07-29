import type { MessengerThreadSummary } from "@rudderhq/shared";

export type ThreadSummaryCursor = {
  activityAt: string;
  title: string;
  threadKey: string;
  isPinned: boolean;
};

type OrderableThreadSummary = Pick<
  MessengerThreadSummary,
  "latestActivityAt" | "title"
> & { threadKey?: string; isPinned?: boolean };

export function comparePinnedThenLatest(
  a: OrderableThreadSummary,
  b: OrderableThreadSummary,
) {
  const pinnedDiff = Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned));
  if (pinnedDiff !== 0) return pinnedDiff;
  const aTime = a.latestActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bTime = b.latestActivityAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aTime !== bTime) return bTime - aTime;
  const titleDiff = a.title.localeCompare(b.title);
  return titleDiff || (a.threadKey ?? "").localeCompare(b.threadKey ?? "");
}

export function encodeThreadSummaryCursor(summary: MessengerThreadSummary) {
  const activityAt = summary.latestActivityAt
    ? new Date(summary.latestActivityAt)
    : new Date(0);
  const payload: ThreadSummaryCursor = {
    activityAt: (Number.isNaN(activityAt.getTime()) ? new Date(0) : activityAt).toISOString(),
    title: summary.title,
    threadKey: summary.threadKey,
    isPinned: summary.isPinned,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeThreadSummaryCursor(
  cursor: string | null | undefined,
): ThreadSummaryCursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<ThreadSummaryCursor>;
    if (
      typeof decoded.activityAt !== "string"
      || Number.isNaN(new Date(decoded.activityAt).getTime())
      || typeof decoded.title !== "string"
      || typeof decoded.threadKey !== "string"
      || decoded.threadKey.length === 0
    ) return null;
    return {
      activityAt: decoded.activityAt,
      title: decoded.title,
      threadKey: decoded.threadKey,
      isPinned: decoded.isPinned === true,
    };
  } catch {
    return null;
  }
}

export function threadSummaryIsAfterCursor(
  summary: MessengerThreadSummary,
  cursor: ThreadSummaryCursor | null,
) {
  if (!cursor) return true;
  return comparePinnedThenLatest(summary, {
    latestActivityAt: new Date(cursor.activityAt),
    title: cursor.title,
    threadKey: cursor.threadKey,
    isPinned: cursor.isPinned,
  }) > 0;
}
