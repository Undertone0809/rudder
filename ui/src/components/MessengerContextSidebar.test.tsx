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
let localStorageValues: Record<string, string>;

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries }),
  useQuery: () => ({ data: chatList }),
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
        unreadCount: 0,
        needsAttention: false,
      },
      {
        threadKey: "issues",
        kind: "issues",
        title: "Issues",
        preview: "Followed issues",
        subtitle: null,
        href: "/messenger/issues",
        latestActivityAt: "2026-04-11T09:40:00.000Z",
        unreadCount: 0,
        needsAttention: false,
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
    chatList = [
      {
        id: "chat-1",
        title: "规定 Agent 的处理流程",
        summary: null,
        latestReplyPreview: "## 需求\n把 Agent 的处理流程规范化",
        updatedAt: "2026-04-11T09:40:00.000Z",
        lastMessageAt: "2026-04-11T09:40:00.000Z",
        unreadCount: 0,
        needsAttention: false,
        isUnread: false,
        isPinned: false,
        primaryIssue: null,
      },
    ];

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain("需求: 把 Agent 的处理流程规范化");
    expect(html).not.toContain("## 需求");
  });

  it("renders the thread organization control", () => {
    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html).toContain('data-testid="messenger-thread-organization-trigger"');
    expect(html).toContain('aria-label="Organize threads"');
  });

  it("promotes pinned Messenger chats above recent threads", () => {
    chatList = [
      {
        id: "chat-1",
        title: "Pinned older chat",
        summary: "Pinned should stay visible.",
        latestReplyPreview: "Pinned should stay visible.",
        updatedAt: "2026-04-11T08:40:00.000Z",
        lastMessageAt: "2026-04-11T08:40:00.000Z",
        unreadCount: 0,
        needsAttention: false,
        isUnread: false,
        isPinned: true,
        primaryIssue: null,
        contextLinks: [],
      },
      {
        id: "chat-2",
        title: "Recent unpinned chat",
        summary: "Recent but not pinned.",
        latestReplyPreview: "Recent but not pinned.",
        updatedAt: "2026-04-11T09:55:00.000Z",
        lastMessageAt: "2026-04-11T09:55:00.000Z",
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
      threadSummaries: [
        {
          threadKey: "chat:chat-2",
          kind: "chat",
          title: "Recent unpinned chat",
          preview: "Recent but not pinned.",
          subtitle: null,
          href: "/messenger/chat/chat-2",
          latestActivityAt: "2026-04-11T09:55:00.000Z",
          unreadCount: 0,
          needsAttention: false,
        },
        {
          threadKey: "issues",
          kind: "issues",
          title: "Issues",
          preview: "Followed issues",
          subtitle: null,
          href: "/messenger/issues",
          latestActivityAt: "2026-04-11T09:50:00.000Z",
          unreadCount: 0,
          needsAttention: false,
        },
        {
          threadKey: "chat:chat-1",
          kind: "chat",
          title: "Pinned older chat",
          preview: "Pinned should stay visible.",
          subtitle: null,
          href: "/messenger/chat/chat-1",
          latestActivityAt: "2026-04-11T08:40:00.000Z",
          unreadCount: 0,
          needsAttention: false,
        },
      ],
    };

    const html = renderToStaticMarkup(<MessengerContextSidebar />);

    expect(html.indexOf("Pinned older chat")).toBeLessThan(html.indexOf("Recent unpinned chat"));
    expect(html.indexOf("Pinned older chat")).toBeLessThan(html.indexOf("Issues"));
    expect(html).toContain("Pinned");
    expect(html).toContain("Recent");
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
  });
});
