// @vitest-environment jsdom

import { requestMessengerUnreadScroll } from "@/lib/messenger-unread-scroll";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function baseConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-unread-chat",
    orgId: "org-1",
    title: "Project unread chat",
    summary: "Project unread preview",
    latestReplyPreview: null,
    latestUserMessagePreview: null,
    userMessageCount: 0,
    latestActivityAt: "2026-04-11T09:40:00.000Z",
    createdAt: "2026-04-11T09:30:00.000Z",
    updatedAt: "2026-04-11T09:40:00.000Z",
    status: "active",
    issueCreationMode: "manual_approval",
    planMode: false,
    preferredAgentId: null,
    routedAgentId: null,
    unreadCount: 2,
    isUnread: true,
    needsAttention: true,
    isPinned: false,
    primaryIssue: null,
    contextLinks: [
      {
        entityType: "project",
        entityId: "project-1",
        entity: { label: "Operator console" },
      },
    ],
    chatRuntime: {
      sourceType: "unconfigured",
      sourceLabel: "No agent selected",
      runtimeAgentId: null,
      agentRuntimeType: null,
      model: null,
      available: false,
      error: null,
    },
    ...overrides,
  };
}

describe("MessengerContextSidebar unread scroll requests", () => {
  beforeEach(() => {
    intersectionCallback = null;
    localStorageValues = {};
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => localStorageValues[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          localStorageValues[key] = value;
        }),
        removeItem: vi.fn((key: string) => {
          delete localStorageValues[key];
        }),
        clear: vi.fn(() => {
          localStorageValues = {};
        }),
      },
    });
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
    window.localStorage.clear();
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
    window.localStorage.clear();
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

  it("cycles through unread thread rows on repeated primary rail requests", async () => {
    messengerModel = {
      ...messengerModel,
      threadSummaries: [
        baseThread("chat:read-chat", "Read chat"),
        baseThread("chat:first-unread", "First unread", 1),
        baseThread("chat:second-unread", "Second unread", 1),
        baseThread("chat:third-unread", "Third unread", 1),
      ],
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

    const scrolledThreadKeys: string[] = [];
    for (const row of Array.from(document.querySelectorAll<HTMLElement>("[data-messenger-thread-key]"))) {
      row.scrollIntoView = vi.fn(() => {
        scrolledThreadKeys.push(row.dataset.messengerThreadKey ?? "");
      });
    }

    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
    });
    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
    });
    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
    });
    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
    });

    expect(scrolledThreadKeys).toEqual([
      "chat:first-unread",
      "chat:second-unread",
      "chat:third-unread",
      "chat:first-unread",
    ]);
  });

  it("consumes an unread scroll request that was fired before the sidebar mounted", async () => {
    messengerModel = {
      ...messengerModel,
      threadSummaries: [
        baseThread("chat:first-unread", "First unread", 1),
        baseThread("chat:read-chat", "Read chat"),
      ],
    };
    const scrolledThreadKeys: string[] = [];
    Element.prototype.scrollIntoView = vi.fn(function scrollIntoView(this: Element) {
      scrolledThreadKeys.push((this as HTMLElement).dataset.messengerThreadKey ?? "");
    });

    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
    });

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

    expect(scrolledThreadKeys).toContain("chat:first-unread");
  });

  it("loads more thread pages before wrapping to the first unread thread", async () => {
    const loadMoreThreadSummaries = vi.fn().mockResolvedValue(undefined);
    messengerModel = {
      ...messengerModel,
      threadSummaries: [
        baseThread("chat:first-unread", "First unread", 1),
      ],
      hasMoreThreadSummaries: true,
      loadMoreThreadSummaries,
    };
    const scrolledThreadKeys: string[] = [];
    Element.prototype.scrollIntoView = vi.fn(function scrollIntoView(this: Element) {
      scrolledThreadKeys.push((this as HTMLElement).dataset.messengerThreadKey ?? "");
    });
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

    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
    });
    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
    });

    expect(loadMoreThreadSummaries).toHaveBeenCalledTimes(1);
    expect(scrolledThreadKeys).toEqual(["chat:first-unread"]);

    messengerModel = {
      ...messengerModel,
      threadSummaries: [
        baseThread("chat:first-unread", "First unread", 1),
        baseThread("chat:second-unread", "Second unread", 1),
      ],
      hasMoreThreadSummaries: false,
    };

    await act(async () => {
      root.render(<MessengerContextSidebar />);
      await Promise.resolve();
    });

    expect(scrolledThreadKeys).toEqual(["chat:first-unread", "chat:second-unread"]);
  });

  it("resets the unread scroll cursor when the Messenger organization changes", async () => {
    messengerModel = {
      ...messengerModel,
      selectedOrganizationId: "org-1",
      threadSummaries: [
        baseThread("issues", "Issues", 1),
        baseThread("approvals", "Approvals", 1),
      ],
    };
    const scrolledThreadKeys: string[] = [];
    Element.prototype.scrollIntoView = vi.fn(function scrollIntoView(this: Element) {
      scrolledThreadKeys.push((this as HTMLElement).dataset.messengerThreadKey ?? "");
    });
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
    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
    });

    messengerModel = {
      ...messengerModel,
      selectedOrganizationId: "org-2",
      threadSummaries: [
        baseThread("issues", "Issues", 1),
        baseThread("approvals", "Approvals", 1),
      ],
    };

    await act(async () => {
      root.render(<MessengerContextSidebar />);
      await Promise.resolve();
    });
    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
    });

    expect(scrolledThreadKeys).toHaveLength(2);
    expect(scrolledThreadKeys[1]).toBe(scrolledThreadKeys[0]);
  });

  it("expands a collapsed project section before scrolling to its first unread thread", async () => {
    window.localStorage.setItem("rudder.messengerThreadOrganizationByOrg", JSON.stringify({ "org-1": "project" }));
    chatList = [baseConversation()];
    messengerModel = {
      ...messengerModel,
      threadSummaries: [
        baseThread("chat:project-unread-chat", "Project unread chat", 2),
        baseThread("chat:read-chat", "Read chat"),
      ],
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

    const projectHeader = document.querySelector('[data-testid="messenger-thread-section-project-project-1"]');
    expect(projectHeader?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-messenger-thread-key="chat:project-unread-chat"]')).not.toBeNull();

    await act(async () => {
      (projectHeader as HTMLButtonElement | null)?.click();
      await Promise.resolve();
    });

    expect(projectHeader?.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem("rudder.messengerCollapsedProjectGroupsByOrg")).toBe(JSON.stringify({
      "org-1": ["project:project-1"],
    }));
    const projectContent = document.querySelector('[data-testid="messenger-thread-section-project-project-1-content"]');
    expect(projectContent?.getAttribute("aria-hidden")).toBe("true");
    expect(projectContent?.className).toContain("grid-rows-[0fr]");
    expect(document.querySelector('[data-messenger-thread-key="chat:project-unread-chat"]')).not.toBeNull();

    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
      await Promise.resolve();
    });

    const unreadRow = document.querySelector('[data-messenger-thread-key="chat:project-unread-chat"]') as HTMLElement | null;
    expect(projectHeader?.getAttribute("aria-expanded")).toBe("true");
    expect(projectContent?.getAttribute("aria-hidden")).toBeNull();
    expect(window.localStorage.getItem("rudder.messengerCollapsedProjectGroupsByOrg")).toBe(JSON.stringify({ "org-1": [] }));
    expect(unreadRow).not.toBeNull();
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
