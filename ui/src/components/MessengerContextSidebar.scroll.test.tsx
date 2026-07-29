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
const mockUpdateCustomGroup = vi.hoisted(() => vi.fn());

let messengerModel: any;
let messengerRoute: any;
let chatList: any[];
let customGroupList: any[];
let activeGeneratingChatIds: Set<string>;
let cleanupFn: (() => void) | null = null;
let intersectionObservers: Array<{
  callback: (entries: Array<{ isIntersecting: boolean }>) => void;
  element: Element | null;
}> = [];
let intersectionObserverOptions: IntersectionObserverInit | undefined;
let localStorageValues: Record<string, string>;

vi.mock("@/context/MainWorkbenchContext", () => ({
  useMainWorkbench: () => ({
    getState: () => ({ organizations: {} }),
    unbindSavedViewForOrganization: vi.fn(),
  }),
  useOrganizationMainWorkbench: () => ({
    activeTab: null,
    tabs: [],
    unbindSavedView: vi.fn(),
  }),
}));

function hydrateCustomGroupFixtures(groups: any[]) {
  return groups.map((group) => ({
    ...group,
    entries: group.entries.map((entry: any) => entry.item ? entry : {
      ...entry,
      item: {
        type: "thread" as const,
        itemKey: entry.threadKey,
        title: entry.thread.title,
        thread: entry.thread,
      },
    }),
  }));
}

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: {
    mutationFn: (variables: any) => Promise<any>;
    onSuccess?: (data: any, variables: any) => Promise<void> | void;
    onError?: (error: unknown, variables: any) => Promise<void> | void;
  }) => ({
    mutate: vi.fn(async (variables: any, callbacks?: { onError?: (error: unknown) => void }) => {
      try {
        const data = await options.mutationFn(variables);
        await options.onSuccess?.(data, variables);
      } catch (error) {
        await options.onError?.(error, variables);
        callbacks?.onError?.(error);
      }
    }),
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries }),
  useQuery: ({ queryKey }: { queryKey?: unknown }) => {
    const key = Array.isArray(queryKey) ? queryKey : [];
    if (key[0] === "messenger" && key[2] === "groups") {
      return { data: { groups: hydrateCustomGroupFixtures(customGroupList) } };
    }
    return { data: chatList };
  },
}));

vi.mock("@/api/messenger", () => ({
  messengerApi: {
    updateCustomGroup: mockUpdateCustomGroup,
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
  useChatGenerations: () => ({ activeChatIds: activeGeneratingChatIds }),
  useChatGenerationActions: () => ({
    isChatGenerationActive: (chatId: string | null | undefined) => Boolean(chatId && activeGeneratingChatIds.has(chatId)),
    setChatGenerationActive: vi.fn(),
    activeChatIds: activeGeneratingChatIds,
  }),
  useChatGenerationActive: (chatId: string) => activeGeneratingChatIds.has(chatId),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: "org-1" }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
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
      sourceLabel: "Agent unavailable",
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
    intersectionObservers = [];
    intersectionObserverOptions = undefined;
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
      private readonly record: (typeof intersectionObservers)[number];
      constructor(
        callback: (entries: Array<{ isIntersecting: boolean }>) => void,
        options?: IntersectionObserverInit,
      ) {
        this.record = { callback, element: null };
        intersectionObservers.push(this.record);
        intersectionObserverOptions = options;
      }
      observe = vi.fn((element: Element) => {
        this.record.element = element;
      });
      disconnect = vi.fn();
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();
    activeGeneratingChatIds = new Set();
    chatList = [];
    customGroupList = [];
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
    mockUpdateCustomGroup.mockImplementation(async (_orgId: string, groupId: string, data: { collapsed?: boolean }) => {
      const group = customGroupList.find((candidate) => candidate.id === groupId);
      if (group && data.collapsed !== undefined) group.collapsed = data.collapsed;
      return group;
    });
  });

  function intersect(testId: string) {
    const observer = intersectionObservers.find(
      (candidate) => candidate.element?.getAttribute("data-testid") === testId,
    );
    observer?.callback([{ isIntersecting: true }]);
  }

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

  it("expands collapsed Project ancestors and reports nested custom-group attention before scrolling", async () => {
    window.localStorage.setItem("rudder.messengerThreadOrganizationByOrg", JSON.stringify({ "org-1": "project" }));
    window.localStorage.setItem("rudder.messengerCollapsedProjectGroupsByOrg", JSON.stringify({
      "org-1": ["project:none"],
    }));
    const unreadThread = baseThread("chat:grouped-unread", "Grouped unread", 1);
    customGroupList = [{
      id: "collapsed-project-group",
      orgId: "org-1",
      userId: "local-board",
      name: "Collapsed project group",
      icon: "folder",
      sortOrder: 0,
      collapsed: true,
      pinnedAt: null,
      entries: [{
        id: "entry-grouped-unread",
        groupId: "collapsed-project-group",
        threadKey: unreadThread.threadKey,
        sortOrder: 0,
        thread: unreadThread,
      }],
    }];
    messengerModel = {
      ...messengerModel,
      threadSummaries: [],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => {
      root.render(<MessengerContextSidebar />);
      await Promise.resolve();
    });

    const noProjectHeader = document.querySelector<HTMLElement>(
      '[data-testid="messenger-thread-section-project-none"]',
    );
    const groupSection = document.querySelector<HTMLElement>(
      '[data-testid="messenger-thread-section-custom-group-collapsed-project-group"]',
    );
    expect(noProjectHeader?.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(
      '[data-testid="messenger-thread-section-project-none-attention-count"]',
    )?.textContent).toBe("1");
    expect(groupSection?.querySelector('button[aria-expanded="false"]')).not.toBeNull();

    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(noProjectHeader?.getAttribute("aria-expanded")).toBe("true");
    expect(mockUpdateCustomGroup).toHaveBeenCalledWith(
      "org-1",
      "collapsed-project-group",
      { collapsed: false },
    );

    await act(async () => {
      root.render(<MessengerContextSidebar />);
      await Promise.resolve();
    });

    const unreadRow = document.querySelector<HTMLElement>(
      '[data-messenger-thread-key="chat:grouped-unread"]',
    );
    expect(groupSection?.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    expect(unreadRow?.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
  });

  it("attempts a failed automatic custom-group expansion only once per unread request", async () => {
    window.localStorage.setItem("rudder.messengerThreadOrganizationByOrg", JSON.stringify({ "org-1": "project" }));
    const unreadThread = baseThread("chat:failed-group-expansion", "Failed group expansion", 1);
    customGroupList = [{
      id: "failed-project-group",
      orgId: "org-1",
      userId: "local-board",
      name: "Failed project group",
      icon: "folder",
      sortOrder: 0,
      collapsed: true,
      pinnedAt: null,
      entries: [{
        id: "entry-failed-group-expansion",
        groupId: "failed-project-group",
        threadKey: unreadThread.threadKey,
        sortOrder: 0,
        thread: unreadThread,
      }],
    }];
    messengerModel = {
      ...messengerModel,
      threadSummaries: [],
    };
    mockUpdateCustomGroup.mockRejectedValue(new Error("network unavailable"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => {
      root.render(<MessengerContextSidebar />);
      await Promise.resolve();
    });
    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUpdateCustomGroup).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<MessengerContextSidebar />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUpdateCustomGroup).toHaveBeenCalledTimes(1);

    await act(async () => {
      requestMessengerUnreadScroll();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUpdateCustomGroup).toHaveBeenCalledTimes(2);
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
      intersect("messenger-thread-page-sentinel");
      await Promise.resolve();
    });

    expect(loadMoreThreadSummaries).toHaveBeenCalledTimes(1);
  });

  it("keeps auto-loading beyond the former rendered thread guard without a manual control", async () => {
    const loadMoreThreadSummaries = vi.fn().mockResolvedValue(undefined);
    messengerModel = {
      ...messengerModel,
      threadSummaries: Array.from({ length: 160 }, (_, index) =>
        baseThread(`chat:thread-${index}`, `Thread ${index}`),
      ),
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
    expect(document.querySelector('[data-testid="messenger-thread-page-load-more"]')).toBeNull();

    await act(async () => {
      intersect("messenger-thread-page-sentinel");
      await Promise.resolve();
    });

    expect(loadMoreThreadSummaries).toHaveBeenCalledTimes(1);
  });

  it("counts and scrolls unread threads nested inside the pinned custom section", async () => {
    window.localStorage.setItem("rudder.messengerThreadOrganizationByOrg", JSON.stringify({ "org-1": "custom" }));
    const loadMoreThreadSummaries = vi.fn().mockResolvedValue(undefined);
    const pinnedThreads = Array.from({ length: 160 }, (_, index) => ({
      ...baseThread(`chat:pinned-${index}`, `Pinned ${index}`, index === 0 ? 1 : 0),
      isPinned: true,
    }));
    chatList = pinnedThreads.map((thread, index) => baseConversation({
      id: `pinned-${index}`,
      title: thread.title,
      isPinned: true,
      isUnread: index === 0,
      unreadCount: index === 0 ? 1 : 0,
      needsAttention: index === 0,
    }));
    customGroupList = [{
      id: "pinned-group",
      orgId: "org-1",
      userId: "local-board",
      name: "Pinned work",
      icon: "folder",
      sortOrder: 0,
      collapsed: false,
      pinnedAt: "2026-04-11T09:40:00.000Z",
      entries: pinnedThreads.map((thread, index) => ({
        id: `entry-${index}`,
        groupId: "pinned-group",
        threadKey: thread.threadKey,
        sortOrder: index,
        thread,
      })),
    }];
    messengerModel = {
      ...messengerModel,
      threadSummaries: pinnedThreads,
      hasMoreThreadSummaries: true,
      loadMoreThreadSummaries,
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => {
      root.render(<MessengerContextSidebar />);
      await Promise.resolve();
    });

    const unreadRow = document.querySelector('[data-messenger-thread-key="chat:pinned-0"]') as HTMLElement | null;
    expect(unreadRow).not.toBeNull();
    await act(async () => {
      intersect("messenger-thread-page-sentinel");
      requestMessengerUnreadScroll();
      await Promise.resolve();
    });

    expect(loadMoreThreadSummaries).toHaveBeenCalledTimes(1);
    expect(unreadRow?.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
  });

  it("reveals an active pinned custom-group row beyond the initial group limit", async () => {
    window.localStorage.setItem("rudder.messengerThreadOrganizationByOrg", JSON.stringify({ "org-1": "custom" }));
    const pinnedThreads = Array.from({ length: 7 }, (_, index) => ({
      ...baseThread(`chat:pinned-${index}`, `Pinned ${index}`),
      isPinned: true,
    }));
    chatList = pinnedThreads.map((thread, index) => baseConversation({
      id: `pinned-${index}`,
      title: thread.title,
      isPinned: true,
    }));
    customGroupList = [{
      id: "pinned-group",
      orgId: "org-1",
      userId: "local-board",
      name: "Pinned work",
      icon: "folder",
      sortOrder: 0,
      collapsed: false,
      pinnedAt: "2026-04-11T09:40:00.000Z",
      entries: pinnedThreads.map((thread, index) => ({
        id: `entry-${index}`,
        groupId: "pinned-group",
        threadKey: thread.threadKey,
        sortOrder: index,
        thread,
      })),
    }];
    messengerRoute = { kind: "chat", conversationId: "pinned-6" };
    messengerModel = { ...messengerModel, threadSummaries: pinnedThreads };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => {
      root.render(<MessengerContextSidebar />);
      await Promise.resolve();
    });

    expect(document.querySelector('[data-messenger-thread-key="chat:pinned-6"]')).not.toBeNull();
  });

  it("keeps Project custom-group expansion local when more global thread pages exist", async () => {
    window.localStorage.setItem("rudder.messengerThreadOrganizationByOrg", JSON.stringify({ "org-1": "project" }));
    const loadMoreThreadSummaries = vi.fn().mockResolvedValue(undefined);
    const groupedThreads = Array.from({ length: 7 }, (_, index) =>
      baseThread(`chat:project-group-${index}`, `Project group ${index}`),
    );
    chatList = groupedThreads.map((thread, index) => baseConversation({
      id: `project-group-${index}`,
      title: thread.title,
    }));
    customGroupList = [{
      id: "project-group",
      orgId: "org-1",
      userId: "local-board",
      name: "Project work queue",
      icon: "folder",
      sortOrder: 0,
      collapsed: false,
      pinnedAt: null,
      entries: groupedThreads.map((thread, index) => ({
        id: `entry-${index}`,
        groupId: "project-group",
        threadKey: thread.threadKey,
        sortOrder: index,
        thread,
      })),
    }];
    messengerModel = {
      ...messengerModel,
      threadSummaries: groupedThreads,
      hasMoreThreadSummaries: true,
      loadMoreThreadSummaries,
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => {
      root.render(<MessengerContextSidebar />);
      await Promise.resolve();
    });

    const groupSectionId = "messenger-thread-section-custom-group-project-group";
    expect(document.querySelector(`[data-testid="${groupSectionId}"]`)).not.toBeNull();
    expect(document.querySelector('[data-messenger-thread-key="chat:project-group-5"]')).not.toBeNull();
    expect(document.querySelector('[data-messenger-thread-key="chat:project-group-6"]')).toBeNull();

    expect(document.querySelector(`[data-testid="${groupSectionId}-auto-loader"]`)).not.toBeNull();

    await act(async () => {
      intersect(`${groupSectionId}-auto-loader`);
      await Promise.resolve();
    });

    expect(document.querySelector('[data-messenger-thread-key="chat:project-group-6"]')).not.toBeNull();
    expect(document.querySelector(`[data-testid="${groupSectionId}-auto-loader"]`)).toBeNull();
    expect(loadMoreThreadSummaries).not.toHaveBeenCalled();
  });

  it("starts loading the next Messenger thread page before the user reaches the sentinel", async () => {
    messengerModel = {
      ...messengerModel,
      hasMoreThreadSummaries: true,
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

    expect(intersectionObserverOptions?.rootMargin).toBe("720px 0px 960px 0px");
  });
});
