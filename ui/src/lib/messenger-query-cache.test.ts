// @vitest-environment node

import { QueryClient } from "@tanstack/react-query";
import type { MessengerThreadSummary } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { upsertMessengerThreadSummaryQueries } from "./messenger-query-cache";

function thread(overrides: Partial<MessengerThreadSummary> & Pick<MessengerThreadSummary, "threadKey" | "title">): MessengerThreadSummary {
  return {
    kind: "chat",
    subtitle: null,
    preview: null,
    latestActivityAt: new Date("2026-05-01T10:00:00.000Z"),
    lastReadAt: null,
    unreadCount: 0,
    needsAttention: false,
    isPinned: false,
    href: `/messenger/${overrides.threadKey}`,
    ...overrides,
  };
}

describe("upsertMessengerThreadSummaryQueries", () => {
  it("updates every paged Messenger thread cache variant used by the sidebar", () => {
    const queryClient = new QueryClient();
    const orgId = "org-1";
    const older = thread({
      threadKey: "chat:older",
      title: "Older chat",
      latestActivityAt: new Date("2026-05-01T08:00:00.000Z"),
    });
    const incoming = thread({
      threadKey: "chat:incoming",
      title: "Incoming chat",
      preview: "Just sent",
      latestActivityAt: new Date("2026-05-03T08:00:00.000Z"),
    });
    const pageData = {
      pages: [{ items: [older], pageInfo: { limit: 40, nextCursor: null, hasMore: false } }],
      pageParams: [null],
    };

    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, false), pageData);
    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, true), pageData);

    upsertMessengerThreadSummaryQueries(queryClient, orgId, incoming);

    expect(queryClient.getQueryData<MessengerThreadSummary[]>(queryKeys.messenger.threads(orgId))?.map((item) => item.threadKey))
      .toEqual(["chat:incoming"]);
    expect(queryClient.getQueryData<typeof pageData>(queryKeys.messenger.threadPages(orgId, false))?.pages[0]?.items.map((item) => item.threadKey))
      .toEqual(["chat:incoming", "chat:older"]);
    expect(queryClient.getQueryData<typeof pageData>(queryKeys.messenger.threadPages(orgId, true))?.pages[0]?.items.map((item) => item.threadKey))
      .toEqual(["chat:incoming", "chat:older"]);
  });

  it("removes the incoming thread from later pages when it is promoted to the first page", () => {
    const queryClient = new QueryClient();
    const orgId = "org-1";
    const older = thread({
      threadKey: "chat:older",
      title: "Older chat",
      latestActivityAt: new Date("2026-05-01T08:00:00.000Z"),
    });
    const incoming = thread({
      threadKey: "chat:incoming",
      title: "Incoming chat",
      latestActivityAt: new Date("2026-05-03T08:00:00.000Z"),
    });

    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, true), {
      pages: [
        { items: [older], pageInfo: { limit: 40, nextCursor: null, hasMore: true } },
        { items: [incoming], pageInfo: { limit: 40, nextCursor: null, hasMore: false } },
      ],
      pageParams: [null, "cursor-1"],
    });

    upsertMessengerThreadSummaryQueries(queryClient, orgId, incoming);

    const pages = queryClient.getQueryData<{
      pages: Array<{ items: MessengerThreadSummary[] }>;
    }>(queryKeys.messenger.threadPages(orgId, true))?.pages;
    expect(pages?.[0]?.items.map((item) => item.threadKey)).toEqual(["chat:incoming", "chat:older"]);
    expect(pages?.[1]?.items.map((item) => item.threadKey)).toEqual([]);
  });
});
