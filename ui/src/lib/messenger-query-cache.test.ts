// @vitest-environment node

import { queryKeys } from "@/lib/queryKeys";
import type { ChatConversation, MessengerCustomGroupsResponse, MessengerThreadSummary, SidebarBadges } from "@rudderhq/shared";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  archiveMessengerChatInCache,
  cancelMessengerChatRenameQueries,
  markMessengerChatPinnedInCache,
  markMessengerChatReadInCache,
  markMessengerThreadPinnedInCache,
  markMessengerThreadReadInCache,
  renameMessengerChatInCache,
  upsertMessengerThreadSummaryQueries,
} from "./messenger-query-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

function conversation(overrides: Partial<ChatConversation> & Pick<ChatConversation, "id" | "orgId" | "title">): ChatConversation {
  return {
    status: "active",
    mutability: "native_chat",
    summary: null,
    latestReplyPreview: null,
    latestUserMessagePreview: null,
    userMessageCount: 0,
    preferredAgentId: null,
    routedAgentId: null,
    primaryIssueId: null,
    forkedFromConversationId: null,
    forkedFromMessageId: null,
    forkRootConversationId: null,
    primaryIssue: null,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: null,
    lastMessageAt: new Date("2026-05-03T08:00:00.000Z"),
    lastReadAt: null,
    isPinned: false,
    isUnread: false,
    unreadCount: 0,
    needsAttention: false,
    resolvedAt: null,
    contextLinks: [],
    chatRuntime: { sourceType: "unconfigured", sourceLabel: "", runtimeAgentId: null, agentRuntimeType: null, model: null, available: false, error: null },
    createdAt: new Date("2026-05-01T08:00:00.000Z"),
    updatedAt: new Date("2026-05-03T08:00:00.000Z"),
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

describe("Messenger optimistic action cache helpers", () => {
  it("pins a chat across conversation and Messenger thread caches immediately", () => {
    const queryClient = new QueryClient();
    const orgId = "org-1";
    const chat = conversation({ id: "chat-1", orgId, title: "Planning" });
    const chatThread = thread({ threadKey: "chat:chat-1", title: "Planning" });

    queryClient.setQueryData(queryKeys.chats.detail(orgId, "chat-1"), chat);
    queryClient.setQueryData(queryKeys.chats.list(orgId, "active"), [chat]);
    queryClient.setQueryData(queryKeys.chats.list(orgId, "all"), [chat]);
    queryClient.setQueryData(queryKeys.messenger.threads(orgId), [chatThread]);
    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, true), {
      pages: [{ items: [chatThread], pageInfo: { limit: 40, nextCursor: null, hasMore: false } }],
      pageParams: [null],
    });
    queryClient.setQueryData(queryKeys.messenger.threadPreview(orgId), {
      items: [chatThread],
      pageInfo: { limit: 10, nextCursor: null, hasMore: false },
    });

    markMessengerChatPinnedInCache(queryClient, orgId, "chat-1", true);

    expect(queryClient.getQueryData<ChatConversation>(queryKeys.chats.detail(orgId, "chat-1"))?.isPinned).toBe(true);
    expect(queryClient.getQueryData<ChatConversation[]>(queryKeys.chats.list(orgId, "active"))?.[0]?.isPinned).toBe(true);
    expect(queryClient.getQueryData<MessengerThreadSummary[]>(queryKeys.messenger.threads(orgId))?.[0]?.isPinned).toBe(true);
    expect(queryClient.getQueryData<{
      pages: Array<{ items: MessengerThreadSummary[] }>;
    }>(queryKeys.messenger.threadPages(orgId, true))?.pages[0]?.items[0]?.isPinned).toBe(true);
    expect(queryClient.getQueryData<{
      items: MessengerThreadSummary[];
    }>(queryKeys.messenger.threadPreview(orgId))?.items[0]?.isPinned).toBe(true);
  });

  it("pins a non-chat Messenger thread across summary caches immediately", () => {
    const queryClient = new QueryClient();
    const orgId = "org-1";
    const issueThread = thread({ threadKey: "issue:issue-1", kind: "issues", title: "ISS-1" });

    queryClient.setQueryData(queryKeys.messenger.threads(orgId), [issueThread]);
    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, false), {
      pages: [{ items: [issueThread], pageInfo: { limit: 40, nextCursor: null, hasMore: false } }],
      pageParams: [null],
    });

    markMessengerThreadPinnedInCache(queryClient, orgId, "issue:issue-1", true);

    expect(queryClient.getQueryData<MessengerThreadSummary[]>(queryKeys.messenger.threads(orgId))?.[0]?.isPinned).toBe(true);
    expect(queryClient.getQueryData<{
      pages: Array<{ items: MessengerThreadSummary[] }>;
    }>(queryKeys.messenger.threadPages(orgId, false))?.pages[0]?.items[0]?.isPinned).toBe(true);
  });

  it("renames a chat across conversation and Messenger thread caches immediately", () => {
    const queryClient = new QueryClient();
    const orgId = "org-1";
    const chat = conversation({ id: "chat-1", orgId, title: "Old planning title" });
    const chatThread = thread({ threadKey: "chat:chat-1", title: "Old planning title" });
    const otherThread = thread({ threadKey: "chat:chat-2", title: "Other chat" });

    queryClient.setQueryData(queryKeys.chats.detail(orgId, "chat-1"), chat);
    queryClient.setQueryData(queryKeys.chats.list(orgId, "active"), [chat]);
    queryClient.setQueryData(queryKeys.chats.list(orgId, "all"), [chat]);
    queryClient.setQueryData(queryKeys.messenger.threads(orgId), [chatThread, otherThread]);
    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, true), {
      pages: [{ items: [chatThread, otherThread], pageInfo: { limit: 40, nextCursor: null, hasMore: false } }],
      pageParams: [null],
    });
    queryClient.setQueryData(queryKeys.messenger.threadPreview(orgId), {
      items: [chatThread],
      pageInfo: { limit: 10, nextCursor: null, hasMore: false },
    });

    renameMessengerChatInCache(queryClient, orgId, "chat-1", "New planning title");

    expect(queryClient.getQueryData<ChatConversation>(queryKeys.chats.detail(orgId, "chat-1"))?.title).toBe("New planning title");
    expect(queryClient.getQueryData<ChatConversation[]>(queryKeys.chats.list(orgId, "active"))?.[0]?.title).toBe("New planning title");
    expect(queryClient.getQueryData<ChatConversation[]>(queryKeys.chats.list(orgId, "all"))?.[0]?.title).toBe("New planning title");
    expect(queryClient.getQueryData<MessengerThreadSummary[]>(queryKeys.messenger.threads(orgId))?.map((item) => item.title))
      .toEqual(["New planning title", "Other chat"]);
    expect(queryClient.getQueryData<{
      pages: Array<{ items: MessengerThreadSummary[] }>;
    }>(queryKeys.messenger.threadPages(orgId, true))?.pages[0]?.items.map((item) => item.title))
      .toEqual(["New planning title", "Other chat"]);
    expect(queryClient.getQueryData<{
      items: MessengerThreadSummary[];
    }>(queryKeys.messenger.threadPreview(orgId))?.items[0]?.title).toBe("New planning title");
  });

  it("keeps an optimistic chat rename when stale in-flight title queries resolve later", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const orgId = "org-1";
    const oldChat = conversation({ id: "chat-1", orgId, title: "Old planning title" });
    const oldThread = thread({ threadKey: "chat:chat-1", title: "Old planning title" });
    const staleList = deferred<ChatConversation[]>();
    const stalePage = deferred<{
      pages: Array<{ items: MessengerThreadSummary[]; pageInfo: { limit: number; nextCursor: string | null; hasMore: boolean } }>;
      pageParams: unknown[];
    }>();
    queryClient.setQueryData(queryKeys.chats.list(orgId, "active"), [oldChat]);
    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, true), {
      pages: [{ items: [oldThread], pageInfo: { limit: 40, nextCursor: null, hasMore: false } }],
      pageParams: [null],
    });

    const staleListFetch = queryClient.fetchQuery({
      queryKey: queryKeys.chats.list(orgId, "active"),
      queryFn: () => staleList.promise,
    }).catch(() => undefined);
    const stalePageFetch = queryClient.fetchQuery({
      queryKey: queryKeys.messenger.threadPages(orgId, true),
      queryFn: () => stalePage.promise,
    }).catch(() => undefined);

    await cancelMessengerChatRenameQueries(queryClient, orgId);
    renameMessengerChatInCache(queryClient, orgId, "chat-1", "New planning title");

    staleList.resolve([oldChat]);
    stalePage.resolve({
      pages: [{ items: [oldThread], pageInfo: { limit: 40, nextCursor: null, hasMore: false } }],
      pageParams: [null],
    });
    await Promise.allSettled([staleListFetch, stalePageFetch]);

    expect(queryClient.getQueryData<ChatConversation[]>(queryKeys.chats.list(orgId, "active"))?.[0]?.title)
      .toBe("New planning title");
    expect(queryClient.getQueryData<{
      pages: Array<{ items: MessengerThreadSummary[] }>;
    }>(queryKeys.messenger.threadPages(orgId, true))?.pages[0]?.items[0]?.title)
      .toBe("New planning title");
  });

  it("archives a chat by removing it from active Messenger caches while preserving all-chat history", () => {
    const queryClient = new QueryClient();
    const orgId = "org-1";
    const chat = conversation({ id: "chat-1", orgId, title: "Planning" });
    const other = conversation({ id: "chat-2", orgId, title: "Other" });
    const chatThread = thread({ threadKey: "chat:chat-1", title: "Planning" });
    const otherThread = thread({ threadKey: "chat:chat-2", title: "Other" });

    queryClient.setQueryData(queryKeys.chats.detail(orgId, "chat-1"), chat);
    queryClient.setQueryData(queryKeys.chats.list(orgId, "active"), [chat, other]);
    queryClient.setQueryData(queryKeys.chats.list(orgId, "all"), [chat, other]);
    queryClient.setQueryData(queryKeys.messenger.threads(orgId), [chatThread, otherThread]);
    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, true), {
      pages: [{ items: [chatThread, otherThread], pageInfo: { limit: 40, nextCursor: null, hasMore: false } }],
      pageParams: [null],
    });
    queryClient.setQueryData(queryKeys.messenger.threadPreview(orgId), {
      items: [chatThread, otherThread],
      pageInfo: { limit: 10, nextCursor: null, hasMore: false },
    });

    archiveMessengerChatInCache(queryClient, orgId, "chat-1");

    expect(queryClient.getQueryData<ChatConversation>(queryKeys.chats.detail(orgId, "chat-1"))?.status).toBe("archived");
    expect(queryClient.getQueryData<ChatConversation[]>(queryKeys.chats.list(orgId, "active"))?.map((item) => item.id)).toEqual(["chat-2"]);
    expect(queryClient.getQueryData<ChatConversation[]>(queryKeys.chats.list(orgId, "all"))?.find((item) => item.id === "chat-1")?.status).toBe("archived");
    expect(queryClient.getQueryData<MessengerThreadSummary[]>(queryKeys.messenger.threads(orgId))?.map((item) => item.threadKey)).toEqual(["chat:chat-2"]);
    expect(queryClient.getQueryData<{
      pages: Array<{ items: MessengerThreadSummary[] }>;
    }>(queryKeys.messenger.threadPages(orgId, true))?.pages[0]?.items.map((item) => item.threadKey)).toEqual(["chat:chat-2"]);
    expect(queryClient.getQueryData<{
      items: MessengerThreadSummary[];
    }>(queryKeys.messenger.threadPreview(orgId))?.items.map((item) => item.threadKey)).toEqual(["chat:chat-2"]);
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

  it("optimistically decrements the cached rail badge when a split issue thread is read", () => {
    const queryClient = new QueryClient();
    const orgId = "org-1";
    const unreadIssue = thread({
      threadKey: "issue:issue-1",
      kind: "issues",
      title: "ISS-1 · Needs attention",
      latestActivityAt: new Date("2026-05-03T08:00:00.000Z"),
      unreadCount: 1,
      needsAttention: true,
    });
    const older = thread({
      threadKey: "chat:older",
      title: "Older chat",
      latestActivityAt: new Date("2026-05-01T08:00:00.000Z"),
    });
    const badges: SidebarBadges = {
      inbox: 58,
      approvals: 0,
      failedRuns: 0,
      joinRequests: 0,
      unreadTouchedIssues: 58,
      chatAttention: 0,
      alerts: 0,
    };

    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, true), {
      pages: [{ items: [unreadIssue, older], pageInfo: { limit: 40, nextCursor: null, hasMore: false } }],
      pageParams: [null],
    });
    queryClient.setQueryData(queryKeys.sidebarBadges(orgId), badges);

    markMessengerThreadReadInCache(queryClient, orgId, "issue:issue-1", "2026-05-03T08:00:00.000Z");

    expect(queryClient.getQueryData<SidebarBadges>(queryKeys.sidebarBadges(orgId))).toMatchObject({
      inbox: 57,
      unreadTouchedIssues: 57,
    });
  });

  it("optimistically clears the cached rail issue badge when the aggregate issue thread is read", () => {
    const queryClient = new QueryClient();
    const orgId = "org-1";
    const unreadIssues = thread({
      threadKey: "issues",
      kind: "issues",
      title: "Issues",
      latestActivityAt: new Date("2026-05-03T08:00:00.000Z"),
      unreadCount: 12,
      needsAttention: true,
    });
    const badges: SidebarBadges = {
      inbox: 15,
      approvals: 1,
      failedRuns: 0,
      joinRequests: 0,
      unreadTouchedIssues: 12,
      chatAttention: 2,
      alerts: 0,
    };

    queryClient.setQueryData(queryKeys.messenger.threadPreview(orgId), {
      items: [unreadIssues],
      pageInfo: { limit: 10, nextCursor: null, hasMore: false },
    });
    queryClient.setQueryData(queryKeys.sidebarBadges(orgId), badges);

    markMessengerThreadReadInCache(queryClient, orgId, "issues", "2026-05-03T08:00:00.000Z");

    expect(queryClient.getQueryData<SidebarBadges>(queryKeys.sidebarBadges(orgId))).toMatchObject({
      inbox: 3,
      unreadTouchedIssues: 0,
      approvals: 1,
      chatAttention: 2,
    });
  });

  it("clears unread state from custom group entries immediately", () => {
    const queryClient = new QueryClient();
    const orgId = "org-1";
    const unreadIssue = thread({
      threadKey: "issue:issue-1",
      kind: "issues",
      title: "ISS-1 · Grouped issue",
      latestActivityAt: new Date("2026-05-03T08:00:00.000Z"),
      unreadCount: 1,
      needsAttention: true,
    });
    const groups: MessengerCustomGroupsResponse = {
      groups: [
        {
          id: "group-1",
          orgId,
          userId: "local-board",
          name: "Issue group",
          icon: "folder::amber",
          sortOrder: 0,
          collapsed: false,
          pinnedAt: null,
          createdAt: new Date("2026-05-01T08:00:00.000Z"),
          updatedAt: new Date("2026-05-01T08:00:00.000Z"),
          entries: [
            {
              id: "entry-1",
              orgId,
              userId: "local-board",
              groupId: "group-1",
              threadKey: "issue:issue-1",
              sortOrder: 0,
              createdAt: new Date("2026-05-01T08:00:00.000Z"),
              updatedAt: new Date("2026-05-01T08:00:00.000Z"),
              thread: unreadIssue,
            },
          ],
        },
      ],
    };

    queryClient.setQueryData(queryKeys.messenger.customGroups(orgId), groups);

    markMessengerThreadReadInCache(queryClient, orgId, "issue:issue-1", "2026-05-03T08:00:00.000Z");

    const groupedThread = queryClient.getQueryData<MessengerCustomGroupsResponse>(
      queryKeys.messenger.customGroups(orgId),
    )?.groups[0]?.entries[0]?.thread;
    expect(groupedThread).toMatchObject({
      threadKey: "issue:issue-1",
      unreadCount: 0,
      needsAttention: false,
    });
    expect(groupedThread?.lastReadAt?.toISOString()).toBe("2026-05-03T08:00:00.000Z");
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
    const unreadConversation = conversation({
      id: "chat-1",
      orgId,
      title: "Unread chat",
      lastMessageAt: new Date("2026-05-03T08:00:00.000Z"),
      isUnread: true,
      unreadCount: 3,
      needsAttention: true,
    });
    const badges: SidebarBadges = {
      inbox: 4,
      approvals: 1,
      failedRuns: 0,
      joinRequests: 0,
      unreadTouchedIssues: 1,
      chatAttention: 2,
      alerts: 0,
    };

    queryClient.setQueryData(queryKeys.chats.detail(orgId, "chat-1"), unreadConversation);
    queryClient.setQueryData(queryKeys.chats.list(orgId, "active"), [unreadConversation]);
    queryClient.setQueryData(queryKeys.messenger.threadPages(orgId, true), {
      pages: [{ items: [unreadChat], pageInfo: { limit: 40, nextCursor: null, hasMore: false } }],
      pageParams: [null],
    });
    queryClient.setQueryData(queryKeys.sidebarBadges(orgId), badges);

    markMessengerChatReadInCache(queryClient, orgId, unreadConversation, { decrementSidebarBadge: true });

    expect(queryClient.getQueryData<typeof unreadConversation>(queryKeys.chats.detail(orgId, "chat-1"))).toMatchObject({
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
