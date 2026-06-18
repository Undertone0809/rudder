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
const mockCreateCustomGroup = vi.hoisted(() => vi.fn());
const mockAssignCustomGroupEntry = vi.hoisted(() => vi.fn());
const mockListCustomGroups = vi.hoisted(() => vi.fn());
const mockUpdateCustomGroup = vi.hoisted(() => vi.fn());
const mockSeparateCustomGroup = vi.hoisted(() => vi.fn());
const mockReorderCustomGroups = vi.hoisted(() => vi.fn());
const mockReorderCustomGroupEntries = vi.hoisted(() => vi.fn());
const mockUpdateConversation = vi.hoisted(() => vi.fn());
const mockRegenerateTitle = vi.hoisted(() => vi.fn());
const mockRemove = vi.hoisted(() => vi.fn());
const mockStopMessageStream = vi.hoisted(() => vi.fn());
const mockAbortChatStream = vi.hoisted(() => vi.fn());
const mockSetChatSendInFlight = vi.hoisted(() => vi.fn());
const mockSetStreamDraftForChat = vi.hoisted(() => vi.fn());
const mockConfirm = vi.hoisted(() => vi.fn(async () => true));
const mockMarkThreadRead = vi.hoisted(() => vi.fn());
const invalidateQueries = vi.fn();
const cancelQueries = vi.fn(() => Promise.resolve());
const setQueryData = vi.fn();
const setQueriesData = vi.fn();
const sortableMockState = vi.hoisted(() => ({
  draggingId: null as string | null,
  measuredHeight: 96,
  measuredWidth: 320,
  transform: null as { x: number; y: number; scaleX?: number; scaleY?: number } | null,
}));
const dndMockState = vi.hoisted(() => ({
  onDragEnd: null as ((event: { active: { id: string }; over: { id: string } | null }) => void) | null,
  onDragStart: null as ((event: { active: { id: string } }) => void) | null,
  onDragOver: null as ((event: { active: { id: string }; over: { id: string } | null }) => void) | null,
}));
const mockUseSortable = vi.hoisted(() => vi.fn(({ id }: { id: string | number }) => ({
  attributes: {},
  listeners: {},
  setNodeRef: (node: HTMLElement | null) => {
    if (!node) return;
    Object.defineProperty(node, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: sortableMockState.measuredHeight,
        height: sortableMockState.measuredHeight,
        left: 0,
        right: sortableMockState.measuredWidth,
        top: 0,
        width: sortableMockState.measuredWidth,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
  },
  transform: sortableMockState.transform,
  transition: undefined,
  isDragging: sortableMockState.draggingId === String(id),
})));

let messengerModel: any;
let messengerRoute: any;
let chatList: any[];
let agentList: any[];
let customGroupList: any[];
let intelligenceProfiles: any[];
let activeGeneratingChatIds: Set<string>;
let cleanupFn: (() => void) | null = null;
let clipboardWriteText: ReturnType<typeof vi.fn>;

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: {
    mutationFn: (variables: any) => Promise<any>;
    onMutate?: (variables: any) => Promise<unknown> | unknown;
    onSuccess?: (data: any, variables: any) => Promise<void> | void;
    onError?: (error: unknown, variables: any) => Promise<void> | void;
  }) => ({
    mutate: vi.fn(async (variables: any) => {
      try {
        const mutationContext = options.onMutate?.(variables);
        if (mutationContext && typeof (mutationContext as Promise<unknown>).then === "function") {
          await mutationContext;
        }
        const result = await options.mutationFn(variables);
        await options.onSuccess?.(result, variables);
      } catch (error) {
        await options.onError?.(error, variables);
      }
    }),
    isPending: false,
  }),
  useQueryClient: () => ({ cancelQueries, invalidateQueries, setQueryData, setQueriesData }),
  useQuery: (options: { queryKey?: unknown; enabled?: boolean }) => {
    if (options.enabled === false) return { data: undefined };
    const queryKey = Array.isArray(options.queryKey) ? options.queryKey : [];
    if (queryKey[0] === "agents") return { data: agentList };
    if (queryKey[0] === "organizations" && queryKey[2] === "intelligence-profiles") return { data: intelligenceProfiles };
    if (queryKey[0] === "messenger" && queryKey[2] === "groups") return { data: { groups: customGroupList } };
    return { data: chatList };
  },
}));

vi.mock("@/api/chats", () => ({
  chatsApi: {
    update: mockUpdateConversation,
    regenerateTitle: mockRegenerateTitle,
    remove: mockRemove,
    stopMessageStream: mockStopMessageStream,
    updateUserState: mockUpdateUserState,
  },
}));

vi.mock("@/api/orgs", () => ({
  organizationsApi: {
    listIntelligenceProfiles: vi.fn(),
  },
}));

vi.mock("@/api/messenger", () => ({
  messengerApi: {
    markThreadRead: mockMarkThreadRead,
    updateThreadUserState: mockUpdateThreadUserState,
    listCustomGroups: mockListCustomGroups,
    createCustomGroup: mockCreateCustomGroup,
    updateCustomGroup: mockUpdateCustomGroup,
    separateCustomGroup: mockSeparateCustomGroup,
    reorderCustomGroups: mockReorderCustomGroups,
    assignCustomGroupEntry: mockAssignCustomGroupEntry,
    removeCustomGroupEntry: vi.fn(),
    reorderCustomGroupEntries: mockReorderCustomGroupEntries,
  },
}));

vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    useSortable: mockUseSortable,
  };
});

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
      onDragStart,
      onDragOver,
    }: {
      children: ReactNode;
      onDragEnd?: (event: { active: { id: string }; over: { id: string } | null }) => void;
      onDragStart?: (event: { active: { id: string } }) => void;
      onDragOver?: (event: { active: { id: string }; over: { id: string } | null }) => void;
    }) => {
      dndMockState.onDragEnd = onDragEnd ?? null;
      dndMockState.onDragStart = onDragStart ?? null;
      dndMockState.onDragOver = onDragOver ?? null;
      return <div data-testid="mock-dnd-context">{children}</div>;
    },
  };
});

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
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
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
    latestUserMessagePreview: null,
    userMessageCount: 0,
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
  return { container, root };
}

function cleanupSidebar() {
  cleanupFn?.();
  cleanupFn = null;
}

function tabbableDescendants(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )).filter((element) => {
    if (element.closest("[inert]")) return false;
    if (element.getAttribute("aria-hidden") === "true") return false;
    if ("disabled" in element && Boolean(element.disabled)) return false;
    return true;
  });
}

function installLocalStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  const getItem = vi.fn((key: string) => store[key] ?? null);
  const setItem = vi.fn((key: string, value: string) => {
    store[key] = value;
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: { getItem, setItem },
  });
  return { getItem, setItem, store };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("MessengerContextSidebar chat actions", () => {
  beforeEach(() => {
    activeGeneratingChatIds = new Set();
    messengerRoute = { kind: "root" };
    chatList = [baseConversation()];
    customGroupList = [];
    intelligenceProfiles = [
      {
        id: "profile-lightweight",
        orgId: "org-1",
        purpose: "lightweight",
        status: "configured",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4-mini" },
      },
    ];
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
    sortableMockState.draggingId = null;
    sortableMockState.measuredHeight = 96;
    sortableMockState.measuredWidth = 320;
    sortableMockState.transform = null;
    dndMockState.onDragEnd = null;
    dndMockState.onDragStart = null;
    dndMockState.onDragOver = null;
    mockUseSortable.mockClear();
    mockUpdateUserState.mockImplementation(async (chatId: string, data: Record<string, unknown>) => ({
      ...baseConversation(),
      id: chatId,
      isUnread: Boolean(data.unread),
      unreadCount: data.unread ? 1 : 0,
      isPinned: Boolean(data.pinned),
    }));
    mockUpdateConversation.mockImplementation(async (chatId: string, data: Record<string, unknown>) => ({
      ...baseConversation(),
      id: chatId,
      ...data,
    }));
    mockRegenerateTitle.mockImplementation(async (chatId: string) => ({
      ...baseConversation({ title: "Regenerated title" }),
      id: chatId,
    }));
    mockRemove.mockImplementation(async (chatId: string) => ({
      ...baseConversation(),
      id: chatId,
    }));
    mockStopMessageStream.mockResolvedValue({ stopped: true });
    mockMarkThreadRead.mockResolvedValue({ threadKey: "issue:issue-1", lastReadAt: "2026-04-11T09:40:00.000Z" });
    mockUpdateThreadUserState.mockResolvedValue({ threadKey: "issue:issue-1", pinned: true });
    mockCreateCustomGroup.mockResolvedValue({
      id: "group-1",
      orgId: "org-1",
      userId: "local-board",
      name: "Deep work",
      icon: "folder",
      sortOrder: 0,
      collapsed: false,
      createdAt: "2026-04-11T09:40:00.000Z",
      updatedAt: "2026-04-11T09:40:00.000Z",
    });
    mockAssignCustomGroupEntry.mockResolvedValue({
      id: "entry-1",
      orgId: "org-1",
      userId: "local-board",
      groupId: "group-1",
      threadKey: "chat:chat-1",
      sortOrder: 0,
      createdAt: "2026-04-11T09:40:00.000Z",
      updatedAt: "2026-04-11T09:40:00.000Z",
    });
    mockListCustomGroups.mockResolvedValue({ groups: [] });
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
    cleanupSidebar();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    mockConfirm.mockClear();
    mockMarkThreadRead.mockClear();
    mockUpdateThreadUserState.mockClear();
    mockCreateCustomGroup.mockClear();
    mockAssignCustomGroupEntry.mockClear();
    mockListCustomGroups.mockClear();
    mockUpdateCustomGroup.mockClear();
    mockSeparateCustomGroup.mockClear();
    mockReorderCustomGroups.mockClear();
    mockReorderCustomGroupEntries.mockClear();
    mockUpdateConversation.mockClear();
    cancelQueries.mockClear();
    invalidateQueries.mockClear();
    setQueryData.mockClear();
    setQueriesData.mockClear();
  });

  it("optimistically pins a chat thread before the user-state request resolves", async () => {
    renderSidebar();

    const pin = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Pin") as HTMLButtonElement | undefined;

    expect(pin).toBeTruthy();
    await act(async () => {
      pin?.click();
      await Promise.resolve();
    });

    expect(setQueryData).toHaveBeenCalledWith(["chats", "org-1", "detail", "chat-1"], expect.any(Function));
    expect(setQueryData).toHaveBeenCalledWith(["chats", "org-1", "active"], expect.any(Function));
    expect(setQueriesData).toHaveBeenCalledWith({ queryKey: ["messenger", "org-1", "threads", "pages"] }, expect.any(Function));
    expect(setQueryData.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateUserState.mock.invocationCallOrder[0]);
    expect(mockUpdateUserState).toHaveBeenCalledWith("chat-1", { pinned: true, unread: undefined });
  });

  it("unpins a pinned chat from the aligned hover pin control", async () => {
    chatList = [baseConversation({ isPinned: true })];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          ...baseModel().threadSummaries[0],
          isPinned: true,
        },
      ],
    };

    renderSidebar();

    const pin = document.querySelector<HTMLButtonElement>('[data-testid="messenger-pin-toggle-chat-chat-1"]');

    expect(pin).toBeTruthy();
    expect(pin?.className).toContain("right-1.5");
    expect(pin?.className).toContain("text-[color:var(--accent-strong)]");
    await act(async () => {
      pin?.click();
      await Promise.resolve();
    });

    expect(mockUpdateUserState).toHaveBeenCalledWith("chat-1", { pinned: false, unread: undefined });
  });

  it("optimistically removes an archived chat from active Messenger caches before the update request resolves", async () => {
    renderSidebar();

    const archive = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Archive")) as HTMLButtonElement | undefined;

    expect(archive).toBeTruthy();
    await act(async () => {
      archive?.click();
      await Promise.resolve();
    });

    expect(setQueryData).toHaveBeenCalledWith(["chats", "org-1", "active"], expect.any(Function));
    expect(setQueryData).toHaveBeenCalledWith(["messenger", "org-1", "threads"], expect.any(Function));
    expect(setQueriesData).toHaveBeenCalledWith({ queryKey: ["messenger", "org-1", "threads", "pages"] }, expect.any(Function));
    expect(setQueryData.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateConversation.mock.invocationCallOrder[0]);
    expect(mockUpdateConversation).toHaveBeenCalledWith("chat-1", { status: "archived" });
  });

  it("optimistically renames a chat across cached Messenger views before the update request resolves", async () => {
    renderSidebar();

    const rename = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Rename") as HTMLButtonElement | undefined;

    expect(rename).toBeTruthy();
    await act(async () => {
      rename?.click();
    });

    const input = document.querySelector<HTMLInputElement>("input");
    expect(input).toBeTruthy();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input!, "Renamed from sidebar");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(setQueryData).toHaveBeenCalledWith(["chats", "org-1", "detail", "chat-1"], expect.any(Function));
    expect(setQueryData).toHaveBeenCalledWith(["chats", "org-1", "active"], expect.any(Function));
    expect(setQueryData).toHaveBeenCalledWith(["messenger", "org-1", "threads"], expect.any(Function));
    expect(setQueriesData).toHaveBeenCalledWith({ queryKey: ["messenger", "org-1", "threads", "pages"] }, expect.any(Function));
    expect(setQueryData.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateConversation.mock.invocationCallOrder[0]);
    expect(mockUpdateConversation).toHaveBeenCalledWith("chat-1", { title: "Renamed from sidebar" });
  });

  it("keeps a pending rename visible when stale thread data renders before the update resolves", async () => {
    installLocalStorage({
      "rudder.messengerThreadOrganizationByOrg": JSON.stringify({ "org-1": "project" }),
    });
    let resolveUpdate!: (value: unknown) => void;
    mockUpdateConversation.mockImplementationOnce(() => new Promise((resolve) => {
      resolveUpdate = resolve;
    }));
    const { root } = renderSidebar();

    const rename = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Rename") as HTMLButtonElement | undefined;

    await act(async () => {
      rename?.click();
    });

    const input = document.querySelector<HTMLInputElement>("input");
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input!, "Renamed from sidebar");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Renamed from sidebar");

    chatList = [baseConversation({ title: "hi" })];
    messengerModel = baseModel();
    await act(async () => {
      root.render(<MessengerContextSidebar />);
    });

    expect(document.body.textContent).toContain("Renamed from sidebar");
    expect(document.body.textContent).not.toContain("hiHello Zee!");

    await act(async () => {
      resolveUpdate(baseConversation({ title: "Renamed from sidebar" }));
      await Promise.resolve();
    });
  });

  it("regenerates a chat title from the actions menu when fast intelligence is configured", async () => {
    renderSidebar();

    const regenerate = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Regenerate title")) as HTMLButtonElement | undefined;

    expect(regenerate).toBeTruthy();
    await act(async () => {
      regenerate?.click();
      await Promise.resolve();
    });

    expect(mockRegenerateTitle).toHaveBeenCalledWith("chat-1");
    expect(setQueryData).toHaveBeenCalledWith(["chats", "org-1", "detail", "chat-1"], expect.any(Function));
    expect(setQueryData).toHaveBeenCalledWith(["messenger", "org-1", "threads"], expect.any(Function));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["chats", "org-1", "detail", "chat-1"] });
  });

  it("hides chat title regeneration when fast intelligence is not configured", () => {
    intelligenceProfiles = [
      {
        id: "profile-lightweight",
        orgId: "org-1",
        purpose: "lightweight",
        status: "disabled",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { model: "gpt-5.4-mini" },
      },
    ];

    renderSidebar();

    const regenerate = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Regenerate title"));

    expect(regenerate).toBeUndefined();
  });

  it("optimistically pins a split issue thread before the Messenger user-state request resolves", async () => {
    chatList = [];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
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
          },
        },
      ],
    };

    renderSidebar();

    const pin = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Pin") as HTMLButtonElement | undefined;

    expect(pin).toBeTruthy();
    await act(async () => {
      pin?.click();
      await Promise.resolve();
    });

    expect(setQueryData).toHaveBeenCalledWith(["messenger", "org-1", "threads"], expect.any(Function));
    expect(setQueriesData).toHaveBeenCalledWith({ queryKey: ["messenger", "org-1", "threads", "pages"] }, expect.any(Function));
    expect(setQueryData.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateThreadUserState.mock.invocationCallOrder[0]);
    expect(mockUpdateThreadUserState).toHaveBeenCalledWith("org-1", "issue:issue-1", { pinned: true });
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

  it("creates a group from a latest activity chat action while staying in the main thread layout", async () => {
    const storage = installLocalStorage();

    renderSidebar();

    const newGroup = Array.from(document.querySelectorAll("button"))
      .filter((button) => button.textContent?.includes("New group"))
      .at(-1) as HTMLButtonElement | undefined;

    expect(newGroup).toBeTruthy();
    await act(async () => {
      newGroup?.click();
    });

    const editor = document.querySelector('[data-testid="messenger-custom-group-editor"]');
    expect(editor).toBeTruthy();
    const nameInput = editor?.querySelector<HTMLInputElement>('input[aria-label="Group name"]');
    const iconButtonLabels = Array.from(editor?.querySelectorAll("button") ?? [])
      .map((button) => button.getAttribute("aria-label"))
      .filter((label): label is string => Boolean(label?.endsWith(" group icon")));
    const emojiButton = Array.from(editor?.querySelectorAll("button") ?? [])
      .find((button) => button.getAttribute("aria-label") === "Use 🚀 group emoji") as HTMLButtonElement | undefined;
    const submitButton = Array.from(editor?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent === "Create") as HTMLButtonElement | undefined;

    expect(nameInput).toBeTruthy();
    expect(iconButtonLabels).toEqual(["Use folder group icon"]);
    expect(emojiButton).toBeTruthy();
    expect(submitButton).toBeTruthy();
    await act(async () => {
      setInputValue(nameInput!, "Deep work");
      emojiButton?.click();
      await Promise.resolve();
    });
    await act(async () => {
      submitButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockCreateCustomGroup).toHaveBeenCalledWith("org-1", { name: "Deep work", icon: "🚀::amber" });
    expect(mockAssignCustomGroupEntry).toHaveBeenCalledWith("org-1", "group-1", "chat:chat-1");
    expect(storage.setItem).toHaveBeenCalledWith("rudder.messengerThreadOrganizationByOrg", JSON.stringify({ "org-1": "latest" }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["messenger", "org-1", "groups"] });
  });

  it("edits group name, emoji, and color from the group actions menu", async () => {
    customGroupList = [
      {
        id: "group-1",
        orgId: "org-1",
        userId: "local-board",
        name: "Deep work",
        icon: "😀::amber",
        sortOrder: 0,
        collapsed: false,
        createdAt: "2026-04-11T09:40:00.000Z",
        updatedAt: "2026-04-11T09:40:00.000Z",
        entries: [
          {
            id: "entry-1",
            orgId: "org-1",
            userId: "local-board",
            groupId: "group-1",
            threadKey: "chat:chat-1",
            sortOrder: 0,
            createdAt: "2026-04-11T09:40:00.000Z",
            updatedAt: "2026-04-11T09:40:00.000Z",
            thread: {
              threadKey: "chat:chat-1",
              kind: "chat",
              title: "Planning thread",
              preview: "Plan.",
              subtitle: null,
              href: "/messenger/chat/chat-1",
              latestActivityAt: "2026-04-11T09:40:00.000Z",
              lastReadAt: null,
              unreadCount: 0,
              needsAttention: false,
              isPinned: false,
            },
          },
        ],
      },
    ];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [],
    };
    renderSidebar();

    const editGroupButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Edit group") as HTMLButtonElement | undefined;

    expect(editGroupButton).toBeTruthy();
    await act(async () => {
      editGroupButton?.click();
      await Promise.resolve();
    });

    const editor = document.querySelector('[data-testid="messenger-custom-group-editor"]');
    const nameInput = editor?.querySelector<HTMLInputElement>('input[aria-label="Group name"]');
    const emojiButton = Array.from(editor?.querySelectorAll("button") ?? [])
      .find((button) => button.getAttribute("aria-label") === "Use 🔥 group emoji") as HTMLButtonElement | undefined;
    const colorButton = Array.from(editor?.querySelectorAll("button") ?? [])
      .find((button) => button.getAttribute("aria-label") === "Use teal group color") as HTMLButtonElement | undefined;
    const saveButton = Array.from(editor?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent === "Save") as HTMLButtonElement | undefined;

    expect(nameInput).toBeTruthy();
    expect(emojiButton).toBeTruthy();
    expect(colorButton).toBeTruthy();
    expect(saveButton).toBeTruthy();
    await act(async () => {
      setInputValue(nameInput!, "Release Notes");
      emojiButton?.click();
      await Promise.resolve();
    });
    await act(async () => {
      colorButton?.click();
      await Promise.resolve();
    });
    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUpdateCustomGroup).toHaveBeenCalledWith("org-1", "group-1", {
      name: "Release Notes",
      icon: "🔥::teal",
    });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["messenger", "org-1", "groups"] });
  });

  it("moves a pinned chat into a group when dropped on a grouped chat row", async () => {
    customGroupList = [
      {
        id: "group-1",
        orgId: "org-1",
        userId: "local-board",
        name: "Deep work",
        icon: "😀::amber",
        sortOrder: 0,
        collapsed: false,
        createdAt: "2026-04-11T09:40:00.000Z",
        updatedAt: "2026-04-11T09:40:00.000Z",
        entries: [
          {
            id: "entry-1",
            orgId: "org-1",
            userId: "local-board",
            groupId: "group-1",
            threadKey: "chat:grouped",
            sortOrder: 0,
            createdAt: "2026-04-11T09:40:00.000Z",
            updatedAt: "2026-04-11T09:40:00.000Z",
            thread: {
              threadKey: "chat:grouped",
              kind: "chat",
              title: "Grouped thread",
              preview: "Grouped work.",
              subtitle: null,
              href: "/messenger/chat/grouped",
              latestActivityAt: "2026-04-11T09:30:00.000Z",
              lastReadAt: null,
              unreadCount: 0,
              needsAttention: false,
              isPinned: false,
            },
          },
        ],
      },
    ];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:pinned",
          kind: "chat",
          title: "Pinned thread",
          preview: "Pinned work.",
          subtitle: null,
          href: "/messenger/chat/pinned",
          latestActivityAt: "2026-04-11T09:50:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: true,
        },
      ],
    };

    renderSidebar();

    await act(async () => {
      dndMockState.onDragEnd?.({
        active: { id: "chat:pinned" },
        over: { id: "chat:grouped" },
      });
      await Promise.resolve();
    });

    expect(mockAssignCustomGroupEntry).toHaveBeenCalledWith("org-1", "group-1", "chat:pinned");
  });

  it("wires a single ungrouped pinned chat row for custom drag", () => {
    customGroupList = [
      {
        id: "group-1",
        orgId: "org-1",
        userId: "local-board",
        name: "Deep work",
        icon: "😀::amber",
        sortOrder: 0,
        collapsed: false,
        createdAt: "2026-04-11T09:40:00.000Z",
        updatedAt: "2026-04-11T09:40:00.000Z",
        entries: [],
      },
    ];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:pinned",
          kind: "chat",
          title: "Pinned thread",
          preview: "Pinned work.",
          subtitle: null,
          href: "/messenger/chat/pinned",
          latestActivityAt: "2026-04-11T09:50:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: true,
        },
      ],
    };

    renderSidebar();

    expect(mockUseSortable).toHaveBeenCalledWith(expect.objectContaining({ id: "chat:pinned" }));
  });

  it("keeps custom row drag transforms translate-only", () => {
    sortableMockState.draggingId = "chat:pinned";
    sortableMockState.transform = { x: 12, y: 18, scaleX: 0.7, scaleY: 0.35 };
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:pinned",
          kind: "chat",
          title: "Pinned thread",
          preview: "Pinned work.",
          subtitle: null,
          href: "/messenger/chat/pinned",
          latestActivityAt: "2026-04-11T09:50:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: true,
        },
      ],
    };

    renderSidebar();

    const pinnedRow = document.querySelector('[data-testid="messenger-thread-chat-pinned"]') as HTMLElement | null;
    if (!pinnedRow) throw new Error("Expected pinned thread row to render");
    const sortableWrapper = pinnedRow.parentElement as HTMLDivElement | null;
    expect(sortableWrapper).toBeTruthy();
    expect(sortableWrapper?.style.height).toBe("96px");
    expect(sortableWrapper?.style.width).toBe("320px");
    expect(sortableWrapper?.style.transform).toBe("translate3d(12px, 18px, 0)");
    expect(sortableWrapper?.style.transform).not.toContain("scale");
  });

  it("moves a pinned chat into a group from the thread actions menu", async () => {
    const storage = installLocalStorage();
    customGroupList = [
      {
        id: "group-1",
        orgId: "org-1",
        userId: "local-board",
        name: "Deep work",
        icon: "😀::amber",
        sortOrder: 0,
        collapsed: false,
        createdAt: "2026-04-11T09:40:00.000Z",
        updatedAt: "2026-04-11T09:40:00.000Z",
        entries: [],
      },
    ];
    chatList = [baseConversation({ isPinned: true })];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:chat-1",
          kind: "chat",
          title: "Pinned thread",
          preview: "Pinned work.",
          subtitle: null,
          href: "/messenger/chat/chat-1",
          latestActivityAt: "2026-04-11T09:50:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: true,
        },
      ],
    };

    renderSidebar();

    const groupMenuItem = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Deep work")) as HTMLButtonElement | undefined;

    expect(groupMenuItem).toBeTruthy();
    await act(async () => {
      groupMenuItem?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockAssignCustomGroupEntry).toHaveBeenCalledWith("org-1", "group-1", "chat:chat-1");
    expect(storage.setItem).toHaveBeenCalledWith("rudder.messengerThreadOrganizationByOrg", JSON.stringify({ "org-1": "latest" }));
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["messenger", "org-1", "groups"] });
  });

  it("moves a pinned chat into a group when a group block is dropped on it", async () => {
    customGroupList = [
      {
        id: "group-1",
        orgId: "org-1",
        userId: "local-board",
        name: "Deep work",
        icon: "😀::amber",
        sortOrder: 0,
        collapsed: false,
        createdAt: "2026-04-11T09:40:00.000Z",
        updatedAt: "2026-04-11T09:40:00.000Z",
        entries: [
          {
            id: "entry-1",
            orgId: "org-1",
            userId: "local-board",
            groupId: "group-1",
            threadKey: "chat:grouped",
            sortOrder: 0,
            createdAt: "2026-04-11T09:40:00.000Z",
            updatedAt: "2026-04-11T09:40:00.000Z",
            thread: {
              threadKey: "chat:grouped",
              kind: "chat",
              title: "Grouped thread",
              preview: "Grouped work.",
              subtitle: null,
              href: "/messenger/chat/grouped",
              latestActivityAt: "2026-04-11T09:30:00.000Z",
              lastReadAt: null,
              unreadCount: 0,
              needsAttention: false,
              isPinned: false,
            },
          },
        ],
      },
    ];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:pinned",
          kind: "chat",
          title: "Pinned thread",
          preview: "Pinned work.",
          subtitle: null,
          href: "/messenger/chat/pinned",
          latestActivityAt: "2026-04-11T09:50:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: true,
        },
      ],
    };

    renderSidebar();

    await act(async () => {
      dndMockState.onDragEnd?.({
        active: { id: "custom-group:group-1" },
        over: { id: "chat:pinned" },
      });
      await Promise.resolve();
    });

    expect(mockAssignCustomGroupEntry).toHaveBeenCalledWith("org-1", "group-1", "chat:pinned");
  });

  it("marks group merge targets without scaling the block", async () => {
    customGroupList = [
      {
        id: "group-1",
        orgId: "org-1",
        userId: "local-board",
        name: "Deep work",
        icon: "😀::amber",
        sortOrder: 0,
        collapsed: false,
        createdAt: "2026-04-11T09:40:00.000Z",
        updatedAt: "2026-04-11T09:40:00.000Z",
        entries: [
          {
            id: "entry-1",
            orgId: "org-1",
            userId: "local-board",
            groupId: "group-1",
            threadKey: "chat:grouped",
            sortOrder: 0,
            createdAt: "2026-04-11T09:40:00.000Z",
            updatedAt: "2026-04-11T09:40:00.000Z",
            thread: {
              threadKey: "chat:grouped",
              kind: "chat",
              title: "Grouped thread",
              preview: "Grouped work.",
              subtitle: null,
              href: "/messenger/chat/grouped",
              latestActivityAt: "2026-04-11T09:30:00.000Z",
              lastReadAt: null,
              unreadCount: 0,
              needsAttention: false,
              isPinned: false,
            },
          },
        ],
      },
    ];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:pinned",
          kind: "chat",
          title: "Pinned thread",
          preview: "Pinned work.",
          subtitle: null,
          href: "/messenger/chat/pinned",
          latestActivityAt: "2026-04-11T09:50:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: true,
        },
      ],
    };

    renderSidebar();

    await act(async () => {
      dndMockState.onDragStart?.({ active: { id: "chat:pinned" } });
      dndMockState.onDragOver?.({
        active: { id: "chat:pinned" },
        over: { id: "chat:grouped" },
      });
      await Promise.resolve();
    });

    const groupSection = document.querySelector('[data-testid="messenger-thread-section-custom-group-group-1"]') as HTMLElement | null;
    if (!groupSection) throw new Error("Expected custom group section to render");
    expect(groupSection.dataset.dragMergeTarget).toBe("true");
    expect(groupSection.className).not.toContain("scale-");
  });

  it("creates a group when one loose chat is dropped on another loose chat", async () => {
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:source",
          kind: "chat",
          title: "Source tab",
          preview: "Source work.",
          subtitle: null,
          href: "/messenger/chat/source",
          latestActivityAt: "2026-04-11T09:50:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
        {
          threadKey: "chat:target",
          kind: "chat",
          title: "Target tab",
          preview: "Target work.",
          subtitle: null,
          href: "/messenger/chat/target",
          latestActivityAt: "2026-04-11T09:40:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
      ],
    };

    renderSidebar();

    await act(async () => {
      dndMockState.onDragEnd?.({
        active: { id: "chat:source" },
        over: { id: "chat:target" },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockCreateCustomGroup).toHaveBeenCalledWith("org-1", { name: "Target tab", icon: "folder::amber" });
    expect(mockAssignCustomGroupEntry).toHaveBeenCalledWith("org-1", "group-1", "chat:target");
    expect(mockAssignCustomGroupEntry).toHaveBeenCalledWith("org-1", "group-1", "chat:source");
  });

  it("does not create custom groups from non-chat rows", async () => {
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:chat-1",
          kind: "chat",
          title: "Planning chat",
          preview: "Chat work.",
          subtitle: null,
          href: "/messenger/chat/chat-1",
          latestActivityAt: "2026-04-11T09:50:00.000Z",
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
    };

    renderSidebar();

    await act(async () => {
      dndMockState.onDragEnd?.({
        active: { id: "issues" },
        over: { id: "chat:chat-1" },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockCreateCustomGroup).not.toHaveBeenCalled();
    expect(mockAssignCustomGroupEntry).not.toHaveBeenCalled();
  });

  it("does not merge non-chat rows into an existing custom group", async () => {
    customGroupList = [
      {
        id: "group-1",
        orgId: "org-1",
        userId: "local-board",
        name: "Deep work",
        icon: "😀::amber",
        sortOrder: 0,
        collapsed: false,
        createdAt: "2026-04-11T09:40:00.000Z",
        updatedAt: "2026-04-11T09:40:00.000Z",
        entries: [
          {
            id: "entry-1",
            orgId: "org-1",
            userId: "local-board",
            groupId: "group-1",
            threadKey: "chat:grouped",
            sortOrder: 0,
            createdAt: "2026-04-11T09:40:00.000Z",
            updatedAt: "2026-04-11T09:40:00.000Z",
            thread: {
              threadKey: "chat:grouped",
              kind: "chat",
              title: "Grouped thread",
              preview: "Grouped work.",
              subtitle: null,
              href: "/messenger/chat/grouped",
              latestActivityAt: "2026-04-11T09:30:00.000Z",
              lastReadAt: null,
              unreadCount: 0,
              needsAttention: false,
              isPinned: false,
            },
          },
        ],
      },
    ];
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

    await act(async () => {
      dndMockState.onDragEnd?.({
        active: { id: "issues" },
        over: { id: "chat:grouped" },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockCreateCustomGroup).not.toHaveBeenCalled();
    expect(mockAssignCustomGroupEntry).not.toHaveBeenCalled();
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
    installLocalStorage({
      "rudder.messengerThreadOrganizationByOrg": JSON.stringify({ "org-1": "project" }),
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
    expect(document.querySelector('[data-testid="messenger-thread-section-project-project-1"]')?.textContent).not.toContain("2");
    expect(document.querySelector('[data-testid="messenger-thread-section-system"]')).toBeNull();
  });

  it("preserves a dragged top-level section size instead of flattening the preview", () => {
    installLocalStorage({
      "rudder.messengerThreadOrganizationByOrg": JSON.stringify({ "org-1": "project" }),
    });
    sortableMockState.draggingId = "project:project-1";
    sortableMockState.measuredHeight = 96;
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
      ],
    };

    renderSidebar();

    const draggedSection = document.querySelector<HTMLElement>(
      '[data-testid="messenger-thread-section-project-project-1"]',
    )?.parentElement;
    expect(draggedSection?.style.height).toBe("96px");
    expect(draggedSection?.style.width).toBe("320px");
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

  it("collapses agent thread groups from the agent header", async () => {
    const { setItem } = installLocalStorage({
      "rudder.messengerThreadOrganizationByOrg": JSON.stringify({ "org-1": "agent" }),
    });
    chatList = [
      baseConversation({
        id: "chat-1",
        title: "Holden thread",
        preferredAgentId: "agent-1",
      }),
    ];
    messengerModel = {
      ...baseModel(1),
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
          unreadCount: 1,
          needsAttention: true,
          isPinned: false,
          metadata: { preferredAgentId: "agent-1" },
        },
      ],
    };

    renderSidebar();

    const agentHeader = document.querySelector<HTMLButtonElement>(
      '[data-testid="messenger-thread-section-agent-agent-1"]',
    );
    expect(agentHeader?.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[data-testid="messenger-thread-section-agent-agent-1-attention-count"]')?.textContent).toBe("1");

    await act(async () => {
      agentHeader?.click();
    });

    expect(agentHeader?.getAttribute("aria-expanded")).toBe("false");
    const agentContent = document.querySelector<HTMLElement>('[data-testid="messenger-thread-section-agent-agent-1-content"]');
    expect(agentContent?.getAttribute("aria-hidden")).toBe("true");
    expect(agentContent?.hasAttribute("inert")).toBe(true);
    expect(agentContent?.className).toContain("grid-rows-[0fr]");
    expect(setItem).toHaveBeenCalledWith(
      "rudder.messengerCollapsedThreadGroupsByOrg",
      JSON.stringify({ "org-1": { agent: ["agent:agent-1"] } }),
    );
  });

  it("progressively shows and collapses large agent thread groups", async () => {
    installLocalStorage({
      "rudder.messengerThreadOrganizationByOrg": JSON.stringify({ "org-1": "agent" }),
    });
    chatList = Array.from({ length: 8 }, (_, index) =>
      baseConversation({
        id: `chat-${index + 1}`,
        title: `Agent thread ${index + 1}`,
        preferredAgentId: "agent-1",
      }),
    );
    messengerModel = {
      ...baseModel(),
      threadSummaries: chatList.map((conversation, index) => ({
        threadKey: `chat:${conversation.id}`,
        kind: "chat",
        title: conversation.title,
        preview: "Agent conversation",
        subtitle: null,
        href: `/messenger/chat/${conversation.id}`,
        latestActivityAt: `2026-04-11T09:${String(59 - index).padStart(2, "0")}:00.000Z`,
        lastReadAt: null,
        unreadCount: 0,
        needsAttention: false,
        isPinned: false,
        metadata: { preferredAgentId: "agent-1" },
      })),
    };

    renderSidebar();

    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-6"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-7"]')).toBeNull();

    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="messenger-thread-section-agent-agent-1-show-more"]',
      )?.click();
    });

    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-7"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-8"]')).toBeTruthy();

    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="messenger-thread-section-agent-agent-1-collapse"]',
      )?.click();
    });

    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-6"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-7"]')).toBeNull();
  });

  it("applies stored thread-type order and collapses thread-type groups", async () => {
    const { setItem } = installLocalStorage({
      "rudder.messengerThreadOrganizationByOrg": JSON.stringify({ "org-1": "kind" }),
      "rudder.messengerThreadGroupOrder:kind:org-1:anonymous": JSON.stringify([
        "kind:approvals",
        "kind:chat",
      ]),
    });
    chatList = [baseConversation()];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:chat-1",
          kind: "chat",
          title: "Chat thread",
          preview: "Chat conversation",
          subtitle: null,
          href: "/messenger/chat/chat-1",
          latestActivityAt: "2026-04-11T09:40:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
        {
          threadKey: "approvals",
          kind: "approvals",
          title: "Approvals",
          preview: "Approval update",
          subtitle: null,
          href: "/messenger/approvals",
          latestActivityAt: "2026-04-11T09:41:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
      ],
    };

    renderSidebar();

    const approvalsHeader = document.querySelector<HTMLButtonElement>('[data-testid="messenger-thread-section-kind-approvals"]');
    const chatHeader = document.querySelector<HTMLButtonElement>('[data-testid="messenger-thread-section-kind-chat"]');
    expect(approvalsHeader).toBeTruthy();
    expect(chatHeader).toBeTruthy();
    expect(approvalsHeader?.compareDocumentPosition(chatHeader!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    await act(async () => {
      approvalsHeader?.click();
    });

    expect(approvalsHeader?.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector<HTMLElement>('[data-testid="messenger-thread-section-kind-approvals-content"]')?.hasAttribute("inert")).toBe(true);
    expect(setItem).toHaveBeenCalledWith(
      "rudder.messengerCollapsedThreadGroupsByOrg",
      JSON.stringify({ "org-1": { kind: ["kind:approvals"] } }),
    );
  });

  it("collapses project thread groups from the project header", async () => {
    const { setItem } = installLocalStorage({
      "rudder.messengerThreadOrganizationByOrg": JSON.stringify({ "org-1": "project" }),
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
    const projectContent = document.querySelector<HTMLElement>('[data-testid="messenger-thread-section-project-project-1-content"]');
    expect(projectContent).not.toBeNull();
    if (!projectContent) throw new Error("Expected project content to render");
    expect(projectContent.getAttribute("aria-hidden")).toBe("true");
    expect(projectContent.hasAttribute("inert")).toBe(true);
    expect(projectContent.className).toContain("grid-rows-[0fr]");
    expect(tabbableDescendants(projectContent)).toHaveLength(0);
    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-1"]')).toBeTruthy();
    expect(setItem).toHaveBeenCalledWith(
      "rudder.messengerCollapsedProjectGroupsByOrg",
      JSON.stringify({ "org-1": ["project:project-1"] }),
    );
  });

  it("progressively shows and collapses large project thread groups", async () => {
    installLocalStorage({
      "rudder.messengerThreadOrganizationByOrg": JSON.stringify({ "org-1": "project" }),
    });
    chatList = Array.from({ length: 8 }, (_, index) =>
      baseConversation({
        id: `chat-${index + 1}`,
        title: `Project thread ${index + 1}`,
        contextLinks: [
          {
            entityType: "project",
            entityId: "project-1",
            entity: { label: "Operator console" },
          },
        ],
      }),
    );
    messengerModel = {
      ...baseModel(),
      threadSummaries: chatList.map((conversation, index) => ({
        threadKey: `chat:${conversation.id}`,
        kind: "chat",
        title: conversation.title,
        preview: "Project conversation",
        subtitle: null,
        href: `/messenger/chat/${conversation.id}`,
        latestActivityAt: `2026-04-11T09:${String(59 - index).padStart(2, "0")}:00.000Z`,
        lastReadAt: null,
        unreadCount: 0,
        needsAttention: false,
        isPinned: false,
      })),
    };

    renderSidebar();

    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-6"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-7"]')).toBeNull();

    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="messenger-thread-section-project-project-1-show-more"]',
      )?.click();
    });

    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-7"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-8"]')).toBeTruthy();

    await act(async () => {
      document.querySelector<HTMLButtonElement>(
        '[data-testid="messenger-thread-section-project-project-1-collapse"]',
      )?.click();
    });

    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-6"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="messenger-thread-chat-chat-7"]')).toBeNull();
  });

  it("applies stored project-mode order to system sections and hides total group counts", () => {
    installLocalStorage({
      "rudder.messengerThreadOrganizationByOrg": JSON.stringify({ "org-1": "project" }),
      "rudder.messengerProjectGroupOrder:org-1:anonymous": JSON.stringify([
        "messenger-section:system",
        "messenger-section:project:none",
        "project-1",
      ]),
    });
    chatList = [
      baseConversation({
        id: "chat-1",
        title: "Project chat",
        contextLinks: [
          {
            entityType: "project",
            entityId: "project-1",
            entity: { label: "Operator console" },
          },
        ],
      }),
      baseConversation({
        id: "chat-2",
        title: "Loose chat",
      }),
    ];
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          threadKey: "chat:chat-1",
          kind: "chat",
          title: "Project chat",
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
          threadKey: "approvals",
          kind: "approvals",
          title: "Approvals",
          preview: "Approval update",
          subtitle: null,
          href: "/messenger/approvals",
          latestActivityAt: "2026-04-11T09:41:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
        {
          threadKey: "chat:chat-2",
          kind: "chat",
          title: "Loose chat",
          preview: "No project conversation",
          subtitle: null,
          href: "/messenger/chat/chat-2",
          latestActivityAt: "2026-04-11T09:42:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
        },
      ],
    };

    renderSidebar();

    const systemHeader = document.querySelector<HTMLElement>('[data-testid="messenger-thread-section-system"]');
    const noProjectHeader = document.querySelector<HTMLElement>('[data-testid="messenger-thread-section-project-none"]');
    const projectHeader = document.querySelector<HTMLElement>('[data-testid="messenger-thread-section-project-project-1"]');
    expect(systemHeader).toBeTruthy();
    expect(noProjectHeader).toBeTruthy();
    expect(projectHeader).toBeTruthy();
    expect(systemHeader?.compareDocumentPosition(noProjectHeader!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(noProjectHeader?.compareDocumentPosition(projectHeader!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(systemHeader?.textContent).toBe("System");
    expect(noProjectHeader?.textContent).toBe("No project");
    expect(projectHeader?.textContent).toBe("Operator console");
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

  it("unpins split issue rows from the aligned hover pin control", async () => {
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
          isPinned: true,
          metadata: { splitIssue: true, issueId: "issue-1", issueIdentifier: "ISS-1", status: "todo" },
        },
      ],
    };

    renderSidebar();

    const pinButton = document.querySelector<HTMLButtonElement>('[data-testid="messenger-pin-toggle-issue-issue-1"]');

    expect(pinButton).toBeTruthy();
    expect(pinButton?.className).toContain("right-1.5");
    expect(pinButton?.className).toContain("text-[color:var(--accent-strong)]");
    await act(async () => {
      pinButton?.click();
    });

    expect(mockUpdateThreadUserState).toHaveBeenCalledWith("org-1", "issue:issue-1", { pinned: false });
  });

  it("hides split issue rows until the issue update watermark changes", async () => {
    const storage = installLocalStorage();
    chatList = [];
    const issueThread = {
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
    };
    messengerModel = {
      ...baseModel(),
      threadSummaries: [issueThread],
    };

    renderSidebar();

    expect(document.querySelector('[data-testid="messenger-thread-issue-issue-1"]')).toBeTruthy();
    const hideButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Hide")) as HTMLButtonElement | undefined;
    expect(hideButton).toBeTruthy();

    await act(async () => {
      hideButton?.click();
    });

    expect(document.querySelector('[data-testid="messenger-thread-issue-issue-1"]')).toBeNull();
    expect(JSON.parse(storage.store["rudder.messengerHiddenIssueThreads:org-1:anonymous"] ?? "{}")).toEqual({
      "issue:issue-1": "2026-04-11T09:40:00.000Z|todo|idle|0|settled",
    });

    cleanupSidebar();
    renderSidebar();
    expect(document.querySelector('[data-testid="messenger-thread-issue-issue-1"]')).toBeNull();

    cleanupSidebar();
    messengerModel = {
      ...baseModel(),
      threadSummaries: [
        {
          ...issueThread,
          latestActivityAt: "2026-04-11T09:45:00.000Z",
          unreadCount: 1,
          needsAttention: true,
          metadata: { ...issueThread.metadata, status: "in_progress" },
        },
      ],
    };
    renderSidebar();
    expect(document.querySelector('[data-testid="messenger-thread-issue-issue-1"]')).toBeTruthy();
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
