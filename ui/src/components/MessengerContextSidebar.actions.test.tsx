// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessengerContextSidebar } from "./MessengerContextSidebar";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockUpdateUserState = vi.hoisted(() => vi.fn());
const invalidateQueries = vi.fn();

let messengerModel: any;
let messengerRoute: any;
let chatList: any[];
let activeGeneratingChatIds: Set<string>;
let cleanupFn: (() => void) | null = null;

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
    updateUserState: mockUpdateUserState,
  },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
    setChatGenerationActive: vi.fn(),
    activeChatIds: activeGeneratingChatIds,
  }),
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
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanupFn?.();
    cleanupFn = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
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
});
