import type { MessengerThreadSummary } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  comparePinnedThenLatest,
  decodeThreadSummaryCursor,
  encodeThreadSummaryCursor,
  threadSummaryIsAfterCursor,
} from "./messenger-thread-summary-order.js";

function summary(
  threadKey: string,
  latestActivityAt: string,
  overrides: Partial<MessengerThreadSummary> = {},
) {
  return {
    threadKey,
    kind: "chat",
    title: threadKey,
    preview: null,
    subtitle: null,
    href: `/messenger/${threadKey}`,
    latestActivityAt: new Date(latestActivityAt),
    lastReadAt: null,
    unreadCount: 0,
    needsAttention: false,
    isPinned: false,
    metadata: {},
    ...overrides,
  } as MessengerThreadSummary;
}

describe("Messenger thread summary ordering", () => {
  it("keeps pinning first and otherwise ignores unread and processing state", () => {
    const pinnedRead = summary("chat:pinned", "2026-07-29T08:00:00.000Z", {
      isPinned: true,
    });
    const newestRead = summary("chat:newest", "2026-07-29T12:00:00.000Z");
    const processing = summary("chat:processing", "2026-07-29T11:00:00.000Z", {
      metadata: { activeGenerationId: "generation-1" },
    });
    const oldestUnread = summary("chat:unread", "2026-07-29T10:00:00.000Z", {
      unreadCount: 1,
      needsAttention: true,
    });

    expect(
      [oldestUnread, processing, newestRead, pinnedRead]
        .sort(comparePinnedThenLatest)
        .map((item) => item.threadKey),
    ).toEqual([
      "chat:pinned",
      "chat:newest",
      "chat:processing",
      "chat:unread",
    ]);
  });

  it("uses latest activity cursor position regardless of attention state", () => {
    const middleProcessing = summary("chat:processing", "2026-07-29T11:00:00.000Z", {
      metadata: { activeGenerationId: "generation-1" },
    });
    const cursor = decodeThreadSummaryCursor(
      encodeThreadSummaryCursor(middleProcessing),
    );
    const newerRead = summary("chat:newer", "2026-07-29T12:00:00.000Z");
    const olderUnread = summary("chat:older", "2026-07-29T10:00:00.000Z", {
      unreadCount: 1,
      needsAttention: true,
    });

    expect(cursor).toEqual({
      activityAt: "2026-07-29T11:00:00.000Z",
      title: "chat:processing",
      threadKey: "chat:processing",
      isPinned: false,
    });
    expect(threadSummaryIsAfterCursor(newerRead, cursor)).toBe(false);
    expect(threadSummaryIsAfterCursor(olderUnread, cursor)).toBe(true);
  });
});
