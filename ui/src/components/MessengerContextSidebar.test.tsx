// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatExactTimestamp } from "@/components/HoverTimestamp";
import { MessengerContextSidebar } from "./MessengerContextSidebar";

const invalidateQueries = vi.fn();

let messengerModel: any;
let messengerRoute: any;
let chatList: any[];
let queryOptions: Array<{ queryKey?: unknown; enabled?: boolean }>;
let localStorageValues: Record<string, string>;
let activeGeneratingChatIds: Set<string>;

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries }),
  useQuery: (options: { queryKey?: unknown; enabled?: boolean }) => {
    queryOptions.push(options);
    return { data: options.enabled === false ? undefined : chatList };
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

vi.mock("@/hooks/useMessenger", () => ({
  useMessengerModel: () => messengerModel,
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

  it("promotes pinned Messenger chats from thread summaries before chat list hydration", () => {
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
    expect(html).toContain("Recent");
    expect(queryOptions).toContainEqual(expect.objectContaining({
      queryKey: ["chats", "org-1", "all"],
      enabled: false,
    }));
  });

  it("groups Messenger chats by project when the organization rule is project", () => {
    localStorageValues["rudder.messengerThreadOrganizationByOrg"] = JSON.stringify({ "org-1": "project" });
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

  it("shows an animated progress icon for the chat that is currently generating", () => {
    activeGeneratingChatIds = new Set(["chat-1"]);

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain('data-testid="messenger-generating-chat-chat-1"');
    expect(html).toContain('aria-label="Chat reply in progress"');
    expect(html).toContain("pointer-events-none absolute right-2 top-1/2");
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
