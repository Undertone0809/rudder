import type { MessengerCustomGroupWithEntries } from "@rudderhq/shared";

export const MESSENGER_GROUP_MENU_THRESHOLD = 10;
export const MESSENGER_GROUP_MENU_RECENT_DAYS = 7;

const RECENT_WINDOW_MS = MESSENGER_GROUP_MENU_RECENT_DAYS * 24 * 60 * 60 * 1_000;

type DateLike = Date | string | number | null | undefined;

function timestamp(value: DateLike) {
  if (value === null || value === undefined) return Number.NEGATIVE_INFINITY;
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : Number.NEGATIVE_INFINITY;
}

export function latestMessengerGroupActivityAt(
  group: Pick<MessengerCustomGroupWithEntries, "updatedAt" | "entries">,
) {
  const activityTimes = [timestamp(group.updatedAt)];
  for (const entry of group.entries) {
    activityTimes.push(timestamp(entry.createdAt), timestamp(entry.updatedAt));
    if ("thread" in entry && entry.thread) activityTimes.push(timestamp(entry.thread.latestActivityAt));
  }
  return Math.max(...activityTimes);
}

export function getMessengerGroupMenuOptions<
  T extends Pick<MessengerCustomGroupWithEntries, "updatedAt" | "entries">,
>(groups: readonly T[], now = new Date()): T[] {
  if (groups.length <= MESSENGER_GROUP_MENU_THRESHOLD) return [...groups];

  const nowAt = timestamp(now);
  if (!Number.isFinite(nowAt)) return [];
  const cutoffAt = nowAt - RECENT_WINDOW_MS;

  return groups
    .map((group, index) => ({
      group,
      index,
      activityAt: latestMessengerGroupActivityAt(group),
    }))
    .filter(({ activityAt }) => activityAt >= cutoffAt)
    .sort((left, right) => right.activityAt - left.activityAt || left.index - right.index)
    .map(({ group }) => group);
}
