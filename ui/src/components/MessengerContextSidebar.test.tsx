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
      },
    ];
    messengerModel = baseModel();
    messengerRoute = { kind: "root" };
    invalidateQueries.mockReset();
  });

  afterEach(() => {
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
});
