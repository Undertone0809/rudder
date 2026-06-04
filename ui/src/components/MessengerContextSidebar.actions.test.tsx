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
const invalidateQueries = vi.fn();

let messengerModel: any;
let messengerRoute: any;
let chatList: any[];
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
  useQueryClient: () => ({ invalidateQueries }),
  useQuery: () => ({ data: chatList }),
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
    markThreadRead: vi.fn(),
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
    mockUpdateThreadUserState.mockClear();
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
    chatList = [baseConversation({ title: "Planning thread" })];
    messengerModel = baseModel();

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
          href: "/issues/ISS-1",
          latestActivityAt: "2026-04-11T09:40:00.000Z",
          lastReadAt: null,
          unreadCount: 0,
          needsAttention: false,
          isPinned: false,
          metadata: { splitIssue: true },
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
});
