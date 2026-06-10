// @vitest-environment node

import { QueryClient } from "@tanstack/react-query";
import type { ChatConversation, MessengerThreadSummary, SidebarBadges } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { markMessengerChatReadInCache, markMessengerThreadReadInCache, upsertMessengerThreadSummaryQueries } from "./messenger-query-cache";

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

describe("markMessengerThreadReadInCache", () => {
  it("clears unread state from every Messenger thread cache variant immediately", () => {
    const queryClient = new QueryClient();
    const orgId = "org-1";
    const unreadIssue = thread({
      threadKey: "issue:issue-1",
      kind: "issues",
      title: "ISS-1 · Needs attention",
      latestActivityAt: new Date("2026-05-03T08:00:00.000Z"),
      unreadCount: 2,
      needsAttention: true,
    });
    const older = thread({
      threadKey: "chat:older",
      title: "Older chat",
      latestActivityAt: new Date("2026-05-01T08:00:00.000Z"),
    });
    const pageData = {
      pages: [{ items: [unreadIssue, older], pageInfo: { limit: 40, nextCursor: null, hasMore: false } }],
      pageParams: [null],
    };

    queryClient.setQueryData(queryKeys.messenger.threads(orgId), [unreadIssue, older]);
    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, false), pageData);
    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, true), pageData);
    queryClient.setQueryData(queryKeys.messenger.threadPreview(orgId), {
      items: [unreadIssue, older],
      pageInfo: { limit: 10, nextCursor: null, hasMore: false },
    });

    markMessengerThreadReadInCache(queryClient, orgId, "issue:issue-1", "2026-05-03T08:00:00.000Z");

    const flatThread = queryClient.getQueryData<MessengerThreadSummary[]>(queryKeys.messenger.threads(orgId))?.[0];
    expect(flatThread).toMatchObject({
      threadKey: "issue:issue-1",
      unreadCount: 0,
      needsAttention: false,
    });
    expect(flatThread?.lastReadAt?.toISOString()).toBe("2026-05-03T08:00:00.000Z");
    for (const splitIssues of [false, true]) {
      const pageThread = queryClient.getQueryData<typeof pageData>(queryKeys.messenger.threadPages(orgId, splitIssues))
        ?.pages[0]?.items[0];
      expect(pageThread).toMatchObject({
        threadKey: "issue:issue-1",
        unreadCount: 0,
        needsAttention: false,
      });
      expect(pageThread?.lastReadAt?.toISOString()).toBe("2026-05-03T08:00:00.000Z");
    }
    expect(queryClient.getQueryData<{
      items: MessengerThreadSummary[];
    }>(queryKeys.messenger.threadPreview(orgId))?.items[0]).toMatchObject({
      threadKey: "issue:issue-1",
      unreadCount: 0,
      needsAttention: false,
    });
  });

  it("optimistically clears a chat conversation and decrements the cached rail badge once", () => {
    const queryClient = new QueryClient();
    const orgId = "org-1";
    const unreadChat = thread({
      threadKey: "chat:chat-1",
      title: "Unread chat",
      unreadCount: 3,
      needsAttention: true,
      latestActivityAt: new Date("2026-05-03T08:00:00.000Z"),
    });
    const conversation: ChatConversation = {
      id: "chat-1",
      orgId,
      status: "active",
      title: "Unread chat",
      summary: null,
      latestReplyPreview: null,
      latestUserMessagePreview: null,
      userMessageCount: 0,
      preferredAgentId: null,
      routedAgentId: null,
      primaryIssueId: null,
      primaryIssue: null,
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: null,
      lastMessageAt: new Date("2026-05-03T08:00:00.000Z"),
      lastReadAt: null,
      isPinned: false,
      isUnread: true,
      unreadCount: 3,
      needsAttention: true,
      resolvedAt: null,
      contextLinks: [],
      chatRuntime: { sourceType: "unconfigured", sourceLabel: "", runtimeAgentId: null, agentRuntimeType: null, model: null, available: false, error: null },
      createdAt: new Date("2026-05-01T08:00:00.000Z"),
      updatedAt: new Date("2026-05-03T08:00:00.000Z"),
    };
    const badges: SidebarBadges = {
      inbox: 4,
      approvals: 1,
      failedRuns: 0,
      joinRequests: 0,
      unreadTouchedIssues: 1,
      chatAttention: 2,
      alerts: 0,
    };

    queryClient.setQueryData(queryKeys.chats.detail("chat-1"), conversation);
    queryClient.setQueryData(queryKeys.chats.list(orgId, "active"), [conversation]);
    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, true), {
      pages: [{ items: [unreadChat], pageInfo: { limit: 40, nextCursor: null, hasMore: false } }],
      pageParams: [null],
    });
    queryClient.setQueryData(queryKeys.sidebarBadges(orgId), badges);

    markMessengerChatReadInCache(queryClient, orgId, conversation, { decrementSidebarBadge: true });

    expect(queryClient.getQueryData<typeof conversation>(queryKeys.chats.detail("chat-1"))).toMatchObject({
      isUnread: false,
      unreadCount: 0,
      needsAttention: false,
    });
    expect(queryClient.getQueryData<SidebarBadges>(queryKeys.sidebarBadges(orgId))).toMatchObject({
      inbox: 3,
      chatAttention: 1,
    });
    expect(queryClient.getQueryData<{
      pages: Array<{ items: MessengerThreadSummary[] }>;
    }>(queryKeys.messenger.threadPages(orgId, true))?.pages[0]?.items[0]).toMatchObject({
      unreadCount: 0,
      needsAttention: false,
    });
  });
});
