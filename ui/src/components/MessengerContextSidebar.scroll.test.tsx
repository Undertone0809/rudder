// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestMessengerUnreadScroll } from "@/lib/messenger-unread-scroll";
import { MessengerContextSidebar } from "./MessengerContextSidebar";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const invalidateQueries = vi.fn();

let messengerModel: any;
let messengerRoute: any;
let chatList: any[];
let activeGeneratingChatIds: Set<string>;
let cleanupFn: (() => void) | null = null;
let intersectionCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;

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
  useMessengerModel: () => messengerModel,
  messengerThreadKindLabel: (kind: string) => kind,
  resolveMessengerRoute: () => messengerRoute,
}));

function baseThread(threadKey: string, title: string, unreadCount = 0) {
  const conversationId = threadKey.startsWith("chat:") ? threadKey.slice("chat:".length) : null;
  return {
    threadKey,
    kind: conversationId ? "chat" : threadKey,
    title,
    preview: `${title} preview`,
    subtitle: null,
    href: conversationId ? `/messenger/chat/${conversationId}` : `/messenger/${threadKey}`,
    latestActivityAt: "2026-04-11T09:40:00.000Z",
    lastReadAt: null,
    unreadCount,
    needsAttention: unreadCount > 0,
    isPinned: false,
  };
}

describe("MessengerContextSidebar unread scroll requests", () => {
  beforeEach(() => {
    intersectionCallback = null;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();
    class MockIntersectionObserver {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        intersectionCallback = callback;
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    Element.prototype.scrollIntoView = vi.fn();
    activeGeneratingChatIds = new Set();
    chatList = [];
    messengerRoute = { kind: "root" };
    messengerModel = {
      selectedOrganizationId: "org-1",
      threadSummaries: [
        baseThread("chat:read-chat", "Read chat"),
        baseThread("chat:unread-chat", "Unread chat", 2),
        baseThread("issues", "Issues"),
      ],
      issueThreadDetail: null,
      approvalThreadDetail: null,
      systemThreadDetail: null,
      isLoading: false,
      error: null,
      hasMoreThreadSummaries: false,
      isFetchingMoreThreadSummaries: false,
      loadMoreThreadSummaries: vi.fn(),
    };
  });

  afterEach(() => {
    cleanupFn?.();
    cleanupFn = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("scrolls the first unread thread row into view when the primary rail requests it", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    await act(async () => {
      root.render(<MessengerContextSidebar />);
      await Promise.resolve();
    });

    const unreadRow = document.querySelector('[data-messenger-thread-key="chat:unread-chat"]') as HTMLElement | null;
    expect(unreadRow).not.toBeNull();

    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
    });

    expect(unreadRow?.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
  });

  it("loads the next Messenger thread page when the sidebar sentinel enters view", async () => {
    const loadMoreThreadSummaries = vi.fn().mockResolvedValue(undefined);
    messengerModel = {
      ...messengerModel,
      hasMoreThreadSummaries: true,
      loadMoreThreadSummaries,
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    };

    await act(async () => {
      root.render(<MessengerContextSidebar />);
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="messenger-thread-page-sentinel"]')).not.toBeNull();

    await act(async () => {
      intersectionCallback?.([{ isIntersecting: true }]);
      await Promise.resolve();
    });

    expect(loadMoreThreadSummaries).toHaveBeenCalledTimes(1);
  });
});
