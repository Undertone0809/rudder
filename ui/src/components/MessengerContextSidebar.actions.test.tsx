// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessengerContextSidebar } from "./MessengerContextSidebar";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockUpdateUserState = vi.hoisted(() => vi.fn());
const mockUpdateThreadUserState = vi.hoisted(() => vi.fn());
const mockRemove = vi.hoisted(() => vi.fn());
const mockStopMessageStream = vi.hoisted(() => vi.fn());
const mockAbortChatStream = vi.hoisted(() => vi.fn());
const mockSetChatSendInFlight = vi.hoisted(() => vi.fn());
const mockSetStreamDraftForChat = vi.hoisted(() => vi.fn());
const mockConfirm = vi.hoisted(() => vi.fn(async () => true));
const mockMarkThreadRead = vi.hoisted(() => vi.fn());
const invalidateQueries = vi.fn();
const setQueryData = vi.fn();
const setQueriesData = vi.fn();

let messengerModel: any;
let messengerRoute: any;
let chatList: any[];
let agentList: any[];
let activeGeneratingChatIds: Set<string>;
let cleanupFn: (() => void) | null = null;
let clipboardWriteText: ReturnType<typeof vi.fn>;

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: {
    mutationFn: (variables: any) => Promise<any>;
    onSuccess?: (data: any) => Promise<void> | void;
  }) => ({
    mutate: vi.fn(async (variables: any) => {
      const result = await options.mutationFn(variables);
      await options.onSuccess?.(result);
    }),
    isPending: false,
  }),
  useQueryClient: () => ({ invalidateQueries, setQueryData, setQueriesData }),
  useQuery: (options: { queryKey?: unknown; enabled?: boolean }) => {
    if (options.enabled === false) return { data: undefined };
    const queryKey = Array.isArray(options.queryKey) ? options.queryKey : [];
    if (queryKey[0] === "agents") return { data: agentList };
    return { data: chatList };
  },
}));

vi.mock("@/api/chats", () => ({
  chatsApi: {
    update: vi.fn(),
    remove: mockRemove,
    stopMessageStream: mockStopMessageStream,
    updateUserState: mockUpdateUserState,
  },
}));

vi.mock("@/api/messenger", () => ({
  messengerApi: {
    markThreadRead: mockMarkThreadRead,
    updateThreadUserState: mockUpdateThreadUserState,
  },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
    variant,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    variant?: "default" | "destructive";
  }) => (
    <button type="button" data-variant={variant} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
  }: {
    children: ReactNode;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <button type="button" aria-checked={checked} onClick={() => onCheckedChange?.(!checked)}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <div role="separator" />,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
    abortChatStream: mockAbortChatStream,
    activeChatIds: activeGeneratingChatIds,
    setChatSendInFlight: mockSetChatSendInFlight,
    setStreamDraftForChat: mockSetStreamDraftForChat,
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ confirm: mockConfirm }),
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({ selectedOrganizationId: "org-1" }),
}));

vi.mock("@/hooks/useMessenger", () => ({
  useMessengerModel: () => messengerModel,
  messengerThreadKindLabel: (kind: string) => kind,
  resolveMessengerRoute: () => messengerRoute,
}));

function baseConversation(overrides: Record<string, unknown> = {}) {
  return {
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

function baseModel(unreadCount = 0) {
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
        unreadCount,
        needsAttention: unreadCount > 0,
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

function renderSidebar() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  act(() => {
    root.render(<MessengerContextSidebar />);
  });
}

describe("MessengerContextSidebar chat actions", () => {
  beforeEach(() => {
    activeGeneratingChatIds = new Set();
    messengerRoute = { kind: "root" };
    chatList = [baseConversation()];
    agentList = [
      {
        id: "agent-1",
        orgId: "org-1",
        name: "Holden",
        urlKey: "holden",
        role: "reviewer",
        title: null,
        icon: "dicebear:notionists:holden",
        status: "active",
      },
    ];
    messengerModel = baseModel();
    mockUpdateUserState.mockImplementation(async (chatId: string, data: Record<string, unknown>) => ({
      ...baseConversation(),
      id: chatId,
      isUnread: Boolean(data.unread),
      unreadCount: data.unread ? 1 : 0,
    }));
    mockRemove.mockImplementation(async (chatId: string) => ({
      ...baseConversation(),
      id: chatId,
    }));
    mockStopMessageStream.mockResolvedValue({ stopped: true });
    mockMarkThreadRead.mockResolvedValue({ threadKey: "issue:issue-1", lastReadAt: "2026-04-11T09:40:00.000Z" });
    mockUpdateThreadUserState.mockResolvedValue({ threadKey: "issue:issue-1", pinned: true });
    mockConfirm.mockResolvedValue(true);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
    });
    clipboardWriteText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: clipboardWriteText,
      },
    });
  });

  afterEach(() => {
    cleanupFn?.();
    cleanupFn = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    mockConfirm.mockClear();
    mockMarkThreadRead.mockClear();
    mockUpdateThreadUserState.mockClear();
    invalidateQueries.mockClear();
    setQueryData.mockClear();
    setQueriesData.mockClear();
  });

  it("marks a read chat thread unread from the actions menu", () => {
    renderSidebar();

    const markUnread = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Mark as Unread")) as HTMLButtonElement | undefined;

    expect(markUnread).toBeTruthy();
    act(() => {
      markUnread?.click();
    });

    expect(mockUpdateUserState).toHaveBeenCalledWith("chat-1", { pinned: undefined, unread: true });
  });

  it("offers Mark as Read for an already unread chat thread", () => {
    chatList = [baseConversation({ isUnread: true, unreadCount: 2, needsAttention: true })];
    messengerModel = baseModel(2);

    renderSidebar();

    const markRead = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Mark as Read")) as HTMLButtonElement | undefined;

    expect(markRead).toBeTruthy();
    act(() => {
      markRead?.click();
    });

    expect(mockUpdateUserState).toHaveBeenCalledWith("chat-1", { pinned: undefined, unread: false });
  });

  it("copies a canonical chat reference from the actions menu", () => {
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          ...baseModel().threadSummaries[0],
          title: "Planning thread",
        },
      ],
    };

    renderSidebar();

    const copyLink = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Copy Chat Link")) as HTMLButtonElement | undefined;

    expect(copyLink).toBeTruthy();
    act(() => {
      copyLink?.click();
    });

    expect(clipboardWriteText).toHaveBeenCalledWith("[Planning thread](chat://chat-1)");
  });

  it("deletes a chat thread from the actions menu", async () => {
    renderSidebar();

    const deleteButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Delete")) as HTMLButtonElement | undefined;

    expect(deleteButton).toBeTruthy();
    expect(deleteButton?.dataset.variant).toBe("destructive");
    await act(async () => {
      deleteButton?.click();
      await Promise.resolve();
    });

    expect(mockConfirm).toHaveBeenCalledWith({
      title: "Delete chat",
      description: 'Delete "hi"? This cannot be undone.',
      confirmLabel: "Delete",
      tone: "destructive",
    });
    expect(mockRemove).toHaveBeenCalledWith("chat-1");
  });

  it("stops an active reply before deleting a generating chat thread", async () => {
    activeGeneratingChatIds = new Set(["chat-1"]);
    renderSidebar();

    const deleteButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Delete")) as HTMLButtonElement | undefined;

    expect(deleteButton).toBeTruthy();
    expect(deleteButton?.disabled).toBe(false);
    await act(async () => {
      deleteButton?.click();
      await Promise.resolve();
    });

    expect(mockConfirm).toHaveBeenCalledWith({
      title: "Delete chat",
      description: 'Delete "hi"? This cannot be undone.',
      confirmLabel: "Delete",
      tone: "destructive",
    });
    expect(mockAbortChatStream).toHaveBeenCalledWith("chat-1");
    expect(mockStopMessageStream).toHaveBeenCalledWith("chat-1");
    expect(mockSetStreamDraftForChat).toHaveBeenCalledWith("chat-1", null);
    expect(mockSetChatSendInFlight).toHaveBeenCalledWith("chat-1", false);
    expect(mockRemove).toHaveBeenCalledWith("chat-1", { cancelActive: true });
  });

  it("does not expose thread pin actions on the aggregate Issues row", () => {
    chatList = [];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
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
    };

    renderSidebar();

    expect(document.querySelector('[aria-label="Thread actions"]')).toBeNull();
  });

  it("groups split issue rows by project beside project chats", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => {
          if (key === "rudder.messengerThreadOrganizationByOrg") return JSON.stringify({ "org-1": "project" });
          return null;
        }),
        setItem: vi.fn(),
      },
    });
    chatList = [
      baseConversation({
        title: "Roadmap chat",
        unreadCount: 1,
        needsAttention: true,
        isUnread: true,
        contextLinks: [
          {
            entityType: "project",
            entityId: "project-1",
            entity: { label: "Operator console" },
          },
        ],
      }),
    ];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:chat-1",
          kind: "chat",
          title: "Roadmap chat",
          preview: "Project conversation",
          subtitle: null,
          href: "/messenger/chat/chat-1",
          latestActivityAt: "2026-04-11T09:40:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
        {
          threadKey: "issue:issue-1",
          kind: "issues",
          title: "ISS-1 · Split issue",
          preview: "Project issue update",
          subtitle: null,
          href: "/messenger/issues/ISS-1",
          latestActivityAt: "2026-04-11T09:41:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
          metadata: {
            splitIssue: true,
            issueId: "issue-1",
            issueIdentifier: "ISS-1",
            status: "todo",
            projectId: "project-1",
            projectName: "Operator console",
          },
        },
      ],
    };

    renderSidebar();

    const projectSection = document.querySelector('[data-testid="messenger-thread-section-project-project-1"]')
      ?.parentElement;
    expect(projectSection?.textContent).toContain("Operator console");
    expect(projectSection?.textContent).toContain("Roadmap chat");
    expect(projectSection?.textContent).toContain("ISS-1 · Split issue");
    expect(document.querySelector('[data-testid="messenger-thread-section-system"]')).toBeNull();
  });

  it("groups chats by selected agent", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => {
          if (key === "rudder.messengerThreadOrganizationByOrg") return JSON.stringify({ "org-1": "agent" });
          return null;
        }),
        setItem: vi.fn(),
      },
    });
    chatList = [
      baseConversation({
        id: "chat-1",
        title: "Holden thread",
        preferredAgentId: "agent-1",
        chatRuntime: {
          sourceType: "agent",
          sourceLabel: "Holden",
          runtimeAgentId: "agent-1",
          agentRuntimeType: "codex",
          model: null,
          available: true,
          error: null,
        },
      }),
      baseConversation({
        id: "chat-2",
        title: "Unassigned thread",
      }),
    ];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:chat-1",
          kind: "chat",
          title: "Holden thread",
          preview: "Agent-selected chat",
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
          threadKey: "chat:chat-2",
          kind: "chat",
          title: "Unassigned thread",
          preview: "No selected agent",
          subtitle: null,
          href: "/messenger/chat/chat-2",
          latestActivityAt: "2026-04-11T09:41:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
      ],
    };

    renderSidebar();

    const agentSection = document.querySelector('[data-testid="messenger-thread-section-agent-agent-1"]')
      ?.parentElement;
    const noAgentSection = document.querySelector('[data-testid="messenger-thread-section-agent-none"]')
      ?.parentElement;
    expect(agentSection?.textContent).toContain("Holden");
    expect(agentSection?.textContent).toContain("Holden thread");
    expect(noAgentSection?.textContent).toContain("No agent");
    expect(noAgentSection?.textContent).toContain("Unassigned thread");
  });

  it("collapses project thread groups from the project header", async () => {
    const setItem = vi.fn();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => {
          if (key === "rudder.messengerThreadOrganizationByOrg") return JSON.stringify({ "org-1": "project" });
          return null;
        }),
        setItem,
      },
    });
    chatList = [
      baseConversation({
        title: "Roadmap chat",
        contextLinks: [
          {
            entityType: "project",
            entityId: "project-1",
            entity: { label: "Operator console" },
          },
        ],
      }),
    ];
    messengerModel = baseModel(1);

    renderSidebar();

    const projectHeader = document.querySelector<HTMLButtonElement>(
      '[data-testid="messenger-thread-section-project-project-1"]',
    );
    expect(projectHeader?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-testid="messenger-thread-section-project-project-1-attention-count"]')?.textContent).toBe("1");
    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-1"]')).toBeTruthy();

    await act(async () => {
      projectHeader?.click();
    });

    expect(projectHeader?.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-testid="messenger-thread-section-project-project-1-attention-count"]')?.textContent).toBe("1");
    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-1"]')).toBeNull();
    expect(setItem).toHaveBeenCalledWith(
      "rudder.messengerCollapsedProjectGroupsByOrg",
      JSON.stringify({ "org-1": ["project:project-1"] }),
    );
  });

  it("pins split issue rows through issue thread user state", async () => {
    chatList = [];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "issue:issue-1",
          kind: "issues",
          title: "ISS-1 · Split issue",
          preview: "Followed issue update",
          subtitle: null,
          href: "/messenger/issues/ISS-1",
          latestActivityAt: "2026-04-11T09:40:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
          metadata: { splitIssue: true, issueId: "issue-1", issueIdentifier: "ISS-1", status: "todo" },
        },
      ],
    };

    renderSidebar();

    expect(document.querySelector('[aria-label="Thread actions"]')).toBeTruthy();
    const pinButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Pin")) as HTMLButtonElement | undefined;

    expect(pinButton).toBeTruthy();
    await act(async () => {
      pinButton?.click();
    });

    expect(mockUpdateThreadUserState).toHaveBeenCalledWith("org-1", "issue:issue-1", { pinned: true });
  });

  it("optimistically clears split issue unread state before mark-read finishes", () => {
    mockMarkThreadRead.mockReturnValue(new Promise(() => undefined));
    chatList = [];
    messengerRoute = { kind: "issue", issueId: "ISS-1" };
    const unreadThread = {
      threadKey: "issue:issue-1",
      kind: "issues",
      title: "ISS-1 · Split issue",
      preview: "Followed issue update",
      subtitle: null,
      href: "/messenger/issues/ISS-1",
      latestActivityAt: "2026-04-11T09:40:00.000Z",
      lastReadAt: null,
      unreadCount: 1,
      needsAttention: true,
      isPinned: false,
      metadata: { splitIssue: true, issueId: "issue-1", issueIdentifier: "ISS-1", status: "todo" },
    };
    messengerModel = {
      ...baseModel(),
      threadSummaries: [unreadThread],
    };

    renderSidebar();

    expect(mockMarkThreadRead).toHaveBeenCalledWith("org-1", "issue:issue-1", "2026-04-11T09:40:00.000Z");
    expect(setQueryData).toHaveBeenCalledWith(expect.any(Array), expect.any(Function));
    expect(setQueriesData).toHaveBeenCalledWith(expect.objectContaining({ queryKey: expect.any(Array) }), expect.any(Function));

    const flatUpdater = setQueryData.mock.calls.find((call) =>
      Array.isArray(call[0]) && call[0][0] === "messenger" && call[0][2] === "threads",
    )?.[1] as ((current: typeof unreadThread[]) => typeof unreadThread[]) | undefined;
    const pageUpdater = setQueriesData.mock.calls.find((call) =>
      Array.isArray(call[0]?.queryKey) && call[0].queryKey[0] === "messenger" && call[0].queryKey[2] === "threads",
    )?.[1] as ((current: { pages: Array<{ items: typeof unreadThread[]; pageInfo: Record<string, unknown> }>; pageParams: unknown[] }) => { pages: Array<{ items: typeof unreadThread[] }> }) | undefined;

    expect(flatUpdater?.([unreadThread])[0]).toMatchObject({
      threadKey: "issue:issue-1",
      unreadCount: 0,
      needsAttention: false,
    });
    expect(pageUpdater?.({
      pages: [{ items: [unreadThread], pageInfo: { limit: 40, nextCursor: null, hasMore: false } }],
      pageParams: [null],
    }).pages[0]?.items[0]).toMatchObject({
      threadKey: "issue:issue-1",
      unreadCount: 0,
      needsAttention: false,
    });
  });
});
