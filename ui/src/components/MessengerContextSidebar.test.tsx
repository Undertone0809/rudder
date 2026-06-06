// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatExactTimestamp } from "@/components/HoverTimestamp";
import { MessengerContextSidebar } from "./MessengerContextSidebar";

const invalidateQueries = vi.fn();

let messengerModel: any;
let messengerRoute: any;
let messengerModelOptions: any[];
let chatList: any[];
let agentList: any[];
let queryOptions: Array<{ queryKey?: unknown; enabled?: boolean }>;
let localStorageValues: Record<string, string>;
let activeGeneratingChatIds: Set<string>;

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries }),
  useQuery: (options: { queryKey?: unknown; enabled?: boolean }) => {
    queryOptions.push(options);
    if (options.enabled === false) return { data: undefined };
    const queryKey = Array.isArray(options.queryKey) ? options.queryKey : [];
    if (queryKey[0] === "agents") return { data: agentList };
    return { data: chatList };
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/messenger" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("@/context/ChatGenerationContext", () => ({
  useChatGenerations: () => ({
    isChatGenerationActive: (chatId: string | null | undefined) => Boolean(chatId && activeGeneratingChatIds.has(chatId)),
    setChatGenerationActive: vi.fn(),
    activeChatIds: activeGeneratingChatIds,
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: "org-1" }),
}));

vi.mock("@/hooks/useMessenger", () => ({
  useMessengerModel: (options?: unknown) => {
    messengerModelOptions.push(options);
    return messengerModel;
  },
  messengerThreadKindLabel: (kind: string) => kind,
  resolveMessengerRoute: () => messengerRoute,
}));

function baseModel() {
  return {
    selectedOrganizationId: "org-1",
    threadSummaries: [
      {
        threadKey: "chat:chat-1",
        kind: "chat",
        title: "hi",
        preview: "Hello Zee!",
        subtitle: null,
        href: "/messenger/chat/chat-1",
        latestActivityAt: "2026-04-11T09:40:00.000Z",
        lastReadAt: null,
        unreadCount: 0,
        needsAttention: false,
        isPinned: false,
        metadata: { preferredAgentId: "agent-1" },
      },
      {
        threadKey: "issues",
        kind: "issues",
        title: "Issues",
        preview: "Followed issues",
        subtitle: null,
        href: "/messenger/issues",
        latestActivityAt: "2026-04-11T09:40:00.000Z",
        lastReadAt: null,
        unreadCount: 0,
        needsAttention: false,
        isPinned: false,
      },
    ],
    issueThreadDetail: null,
    approvalThreadDetail: null,
    systemThreadDetail: null,
    isLoading: false,
    error: null,
  };
}

describe("MessengerContextSidebar", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-11T10:00:00.000Z"));
    queryOptions = [];
    messengerModelOptions = [];
    localStorageValues = {};
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => localStorageValues[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          localStorageValues[key] = value;
        }),
      },
    });
    chatList = [
      {
        id: "chat-1",
        title: "hi",
        summary: "Hello Zee!",
        latestReplyPreview: "Hello Zee!",
        updatedAt: "2026-04-11T09:40:00.000Z",
        lastMessageAt: "2026-04-11T09:40:00.000Z",
        unreadCount: 0,
        needsAttention: false,
        isUnread: false,
        isPinned: false,
        primaryIssue: null,
        contextLinks: [],
      },
    ];
    agentList = [
      {
        id: "agent-1",
        orgId: "org-1",
        name: "Asher",
        urlKey: "asher",
        role: "general",
        title: null,
        icon: "dicebear:notionists:asher",
        status: "active",
      },
    ];
    activeGeneratingChatIds = new Set();
    messengerModel = baseModel();
    messengerRoute = { kind: "root" };
    invalidateQueries.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders relative thread times without exact timestamp hover labels", () => {
    const html = renderToStaticMarkup(<MessengerContextSidebar />);
    const exactLabel = formatExactTimestamp("2026-04-11T09:40:00.000Z");

    expect(html).toContain("20m ago");
    expect(html).not.toContain(`title="${exactLabel}"`);
    expect(html).not.toContain(`aria-label="${exactLabel}"`);
  });

  it("keeps Messenger thread selection on the static active-row treatment", () => {
    messengerRoute = { kind: "chat", conversationId: "chat-1" };

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).not.toContain("motion-context-nav--messenger-thread-list");
    expect(html).not.toContain('data-testid="messenger-sidebar-active-indicator"');
    expect(html).toContain("chat-conversation-active");
  });

  it("formats markdown heading previews as readable sidebar summaries", () => {
    localStorageValues["rudder.messengerThreadDensityByOrg"] = JSON.stringify({ "org-1": "comfortable" });
    chatList = [];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [{
        threadKey: "chat:chat-1",
        kind: "chat",
        title: "规定 Agent 的处理流程",
        preview: "需求: 把 Agent 的处理流程规范化",
        subtitle: "需求: 把 Agent 的处理流程规范化",
        href: "/messenger/chat/chat-1",
        latestActivityAt: "2026-04-11T09:40:00.000Z",
        lastReadAt: null,
        unreadCount: 0,
        needsAttention: false,
        isPinned: false,
      }],
    };

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain("需求: 把 Agent 的处理流程规范化");
    expect(html).not.toContain("## 需求");
  });

  it("renders URL-heavy chat titles as readable compact titles", () => {
    const rawTitle = "&#x20;[https://gingiris.github.io/growth-tools/blog/2026/04/02/github-readme-template-guide/] 看一下这个 总结下。";
    chatList = [
      {
        id: "chat-1",
        title: rawTitle,
        summary: "Start conversation",
        latestReplyPreview: null,
        updatedAt: "2026-04-11T09:40:00.000Z",
        lastMessageAt: "2026-04-11T09:40:00.000Z",
        unreadCount: 0,
        needsAttention: false,
        isUnread: false,
        isPinned: false,
        primaryIssue: null,
        contextLinks: [],
      },
    ];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [{
        threadKey: "chat:chat-1",
        kind: "chat",
        title: rawTitle,
        preview: "Start conversation",
        subtitle: null,
        href: "/messenger/chat/chat-1",
        latestActivityAt: "2026-04-11T09:40:00.000Z",
        lastReadAt: null,
        unreadCount: 0,
        needsAttention: false,
        isPinned: false,
      }],
    };

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain("看一下这个 总结下。");
    expect(html).not.toContain("&#x20;");
    expect(html).not.toContain("github-readme-template-guide");
  });

  it("renders the thread organization control", () => {
    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain('data-testid="messenger-thread-organization-trigger"');
    expect(html).toContain('aria-label="Organize threads"');
  });

  it("defaults Messenger threads to compact density and split issue notifications without status labels", () => {
    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain("Threads");
    expect(html).not.toContain("Compact");
    expect(html).not.toContain("Split issues");
    expect(html).toContain("hi");
    expect(html).not.toContain("Hello Zee!");
    expect(html).not.toContain("Followed issues");
    expect(html).not.toContain('data-testid="messenger-thread-issues"');
    expect(html).toContain('data-testid="messenger-thread-chat-chat-1-agent-avatar"');
    expect(html).toMatch(/data-testid="messenger-thread-chat-chat-1-agent-avatar"[\s\S]*?<img/);
    expect(html).toContain('title="Chat agent: Asher"');
    expect(html).toContain("items-center gap-2 px-2 py-1.5");
    expect(html).toContain("h-7 w-7");
    expect(html).toContain("grid-cols-[minmax(0,1fr)_2.75rem] items-center");
    expect(messengerModelOptions).toContainEqual({ splitIssues: true });
  });

  it("respects stored comfortable density and aggregate issue notification preferences", () => {
    localStorageValues["rudder.messengerThreadDensityByOrg"] = JSON.stringify({ "org-1": "comfortable" });
    localStorageValues["rudder.messengerSplitIssueNotificationsByOrg"] = JSON.stringify({ "org-1": false });

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain("Threads");
    expect(html).not.toContain("Compact");
    expect(html).not.toContain("Split issues");
    expect(html).toContain("Issues");
    expect(html).toContain("Hello Zee!");
    expect(html).toContain("Followed issues");
    expect(html).toContain("gap-3 px-3 py-2.5");
    expect(html).toContain("h-10 w-10");
    expect(messengerModelOptions).toContainEqual({ splitIssues: false });
  });

  it("keeps the aggregate Issues row free of thread pin actions when split issue notifications are off", () => {
    localStorageValues["rudder.messengerSplitIssueNotificationsByOrg"] = JSON.stringify({ "org-1": false });

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain("Issues");
    expect(html).not.toContain('aria-label="Thread actions"');
  });

  it("restores the split issue notifications preference for the current organization", () => {
    localStorageValues["rudder.messengerSplitIssueNotificationsByOrg"] = JSON.stringify({ "org-1": false });

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).not.toContain("Split issues");
    expect(messengerModelOptions).toContainEqual({ splitIssues: false });
  });

  it("hides stale aggregate Issues rows while split issue notifications are active", () => {
    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).not.toContain('data-testid="messenger-thread-issues"');
    expect(html).not.toContain("Followed issues");
    expect(messengerModelOptions).toContainEqual({ splitIssues: true });
  });

  it("promotes pinned Messenger chats from thread summaries before chat list hydration", () => {
    localStorageValues["rudder.messengerSplitIssueNotificationsByOrg"] = JSON.stringify({ "org-1": false });
    chatList = [];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:chat-2",
          kind: "chat",
          title: "Recent unpinned chat",
          preview: "Recent but not pinned.",
          subtitle: null,
          href: "/messenger/chat/chat-2",
          latestActivityAt: "2026-04-11T09:55:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
        {
          threadKey: "issues",
          kind: "issues",
          title: "Issues",
          preview: "Followed issues",
          subtitle: null,
          href: "/messenger/issues",
          latestActivityAt: "2026-04-11T09:50:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
        {
          threadKey: "chat:chat-1",
          kind: "chat",
          title: "Pinned older chat",
          preview: "Pinned should stay visible.",
          subtitle: null,
          href: "/messenger/chat/chat-1",
          latestActivityAt: "2026-04-11T08:40:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: true,
        },
      ],
    };

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html.indexOf("Pinned older chat")).toBeLessThan(html.indexOf("Recent unpinned chat"));
    expect(html.indexOf("Pinned older chat")).toBeLessThan(html.indexOf("Issues"));
    expect(html).toContain("Pinned");
    expect(html).toContain("Today");
    expect(queryOptions).toContainEqual(expect.objectContaining({
      queryKey: ["chats", "org-1", "all"],
      enabled: false,
    }));
  });

  it("groups latest activity threads from today before older recent threads", () => {
    chatList = [];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:older-chat",
          kind: "chat",
          title: "Older chat",
          preview: "Yesterday's follow-up.",
          subtitle: null,
          href: "/messenger/chat/older-chat",
          latestActivityAt: "2026-04-10T12:00:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
        {
          threadKey: "chat:today-chat",
          kind: "chat",
          title: "Today chat",
          preview: "Today's follow-up.",
          subtitle: null,
          href: "/messenger/chat/today-chat",
          latestActivityAt: "2026-04-11T09:55:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
      ],
    };

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html.indexOf('data-testid="messenger-thread-section-today"')).toBeLessThan(
      html.indexOf('data-testid="messenger-thread-chat-today-chat"'),
    );
    expect(html.indexOf('data-testid="messenger-thread-chat-today-chat"')).toBeLessThan(
      html.indexOf('data-testid="messenger-thread-section-recent"'),
    );
    expect(html.indexOf('data-testid="messenger-thread-section-recent"')).toBeLessThan(
      html.indexOf('data-testid="messenger-thread-chat-older-chat"'),
    );
    expect(html).toContain("Today");
    expect(html).toContain("Recent");
  });

  it("promotes pinned split issue rows with pinned chats in latest activity mode", () => {
    chatList = [];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:chat-2",
          kind: "chat",
          title: "Recent unpinned chat",
          preview: "Recent but not pinned.",
          subtitle: null,
          href: "/messenger/chat/chat-2",
          latestActivityAt: "2026-04-11T09:55:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
        {
          threadKey: "issue:issue-1",
          kind: "issues",
          title: "ISS-1 · Pinned split issue",
          preview: "Pinned issue should sort with pinned rows.",
          subtitle: "assigned to me",
          href: "/messenger/issues/ISS-1",
          latestActivityAt: "2026-04-11T08:40:00.000Z",
          lastReadAt: null,
          unreadCount: 1,
          needsAttention: true,
          isPinned: true,
          metadata: { splitIssue: true, issueId: "issue-1", issueIdentifier: "ISS-1", status: "in_progress" },
        },
      ],
    };

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html.indexOf('data-testid="messenger-thread-issue-issue-1"')).toBeLessThan(
      html.indexOf('data-testid="messenger-thread-chat-chat-2"'),
    );
    expect(html).toContain("Pinned");
    expect(html).toContain("Today");
    expect(html).toContain('aria-label="Thread actions"');
    expect(html).toContain('data-slot="status-progress-arc"');
  });

  it("shows a spinning loader for split issue rows with an active execution run", () => {
    chatList = [];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "issue:issue-1",
          kind: "issues",
          title: "ISS-1 · Running split issue",
          preview: "The assigned agent is working on it.",
          subtitle: "assigned to me",
          href: "/messenger/issues/ISS-1",
          latestActivityAt: "2026-04-11T09:40:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
          metadata: {
            splitIssue: true,
            issueId: "issue-1",
            issueIdentifier: "ISS-1",
            status: "in_progress",
            activeExecutionRunId: "run-1",
          },
        },
      ],
    };

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain('title="Issue run in progress"');
    expect(html).toContain('data-testid="issue-issue-1-unread-badge-active-run"');
    expect(html).toContain("animate-spin");
    expect(html).not.toContain('data-slot="status-progress-arc"');
  });

  it("groups Messenger chats by project when the organization rule is project", () => {
    localStorageValues["rudder.messengerThreadOrganizationByOrg"] = JSON.stringify({ "org-1": "project" });
    localStorageValues["rudder.messengerSplitIssueNotificationsByOrg"] = JSON.stringify({ "org-1": false });
    chatList = [
      {
        id: "chat-1",
        title: "Project-linked chat",
        summary: "Project context is set.",
        latestReplyPreview: "Project context is set.",
        updatedAt: "2026-04-11T09:40:00.000Z",
        lastMessageAt: "2026-04-11T09:40:00.000Z",
        unreadCount: 0,
        needsAttention: false,
        isUnread: false,
        isPinned: false,
        primaryIssue: null,
        contextLinks: [
          {
            entityType: "project",
            entityId: "project-1",
            entity: { label: "Website launch", identifier: null },
          },
        ],
      },
    ];

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain("Threads organized by project");
    expect(html).toContain("Website launch");
    expect(html).toContain("System");
    expect(html.indexOf("Website launch")).toBeLessThan(html.indexOf("System"));
    expect(queryOptions).toContainEqual(expect.objectContaining({
      queryKey: ["chats", "org-1", "all"],
      enabled: true,
    }));
  });

  it("orders real project thread groups by the stored project order and keeps fixed groups at the bottom", () => {
    localStorageValues["rudder.messengerThreadOrganizationByOrg"] = JSON.stringify({ "org-1": "project" });
    localStorageValues["rudder.messengerSplitIssueNotificationsByOrg"] = JSON.stringify({ "org-1": false });
    localStorageValues["rudder.projectOrder:org-1:anonymous"] = JSON.stringify(["project-2", "project-1"]);
    chatList = [
      {
        id: "chat-1",
        title: "Alpha project chat",
        summary: "Alpha context.",
        latestReplyPreview: "Alpha context.",
        updatedAt: "2026-04-11T09:40:00.000Z",
        lastMessageAt: "2026-04-11T09:40:00.000Z",
        unreadCount: 0,
        needsAttention: false,
        isUnread: false,
        isPinned: false,
        primaryIssue: null,
        contextLinks: [
          {
            entityType: "project",
            entityId: "project-1",
            entity: { label: "Alpha project", identifier: null },
          },
        ],
      },
      {
        id: "chat-2",
        title: "Beta project chat",
        summary: "Beta context.",
        latestReplyPreview: "Beta context.",
        updatedAt: "2026-04-11T09:41:00.000Z",
        lastMessageAt: "2026-04-11T09:41:00.000Z",
        unreadCount: 0,
        needsAttention: false,
        isUnread: false,
        isPinned: false,
        primaryIssue: null,
        contextLinks: [
          {
            entityType: "project",
            entityId: "project-2",
            entity: { label: "Beta project", identifier: null },
          },
        ],
      },
    ];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:chat-1",
          kind: "chat",
          title: "Alpha project chat",
          preview: "Alpha context.",
          subtitle: null,
          href: "/messenger/chat/chat-1",
          latestActivityAt: "2026-04-11T09:40:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
        {
          threadKey: "chat:chat-2",
          kind: "chat",
          title: "Beta project chat",
          preview: "Beta context.",
          subtitle: null,
          href: "/messenger/chat/chat-2",
          latestActivityAt: "2026-04-11T09:41:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
        {
          threadKey: "issues",
          kind: "issues",
          title: "Issues",
          preview: "Followed issues",
          subtitle: null,
          href: "/messenger/issues",
          latestActivityAt: "2026-04-11T09:42:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
      ],
    };

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html.indexOf("Beta project")).toBeLessThan(html.indexOf("Alpha project"));
    expect(html.indexOf("Alpha project")).toBeLessThan(html.indexOf("System"));
  });

  it("shows an animated progress icon for the chat that is currently generating", () => {
    activeGeneratingChatIds = new Set(["chat-1"]);

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain('data-testid="messenger-generating-chat-chat-1"');
    expect(html).toContain('aria-label="Chat reply in progress"');
    expect(html).toContain("pointer-events-none absolute top-1/2");
    expect(html).toContain("right-1.5 h-5 w-5");
    expect(html).toContain("20m ago");
  });

  it("keeps chat actions available while a chat is generating", () => {
    activeGeneratingChatIds = new Set(["chat-1"]);

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain('aria-label="Chat actions"');
    expect(html).toContain("group-hover:opacity-100");
    expect(html).toContain("group-hover:opacity-0");
  });
});
