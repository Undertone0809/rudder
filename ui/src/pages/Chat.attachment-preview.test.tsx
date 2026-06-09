// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChatConversation, ChatMessage, Project } from "@rudderhq/shared";
import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { Chat } from "./Chat";
import {
  resetChatPendingAttachmentsForTests,
  resolveChatPendingAttachmentScopeKey,
  updateChatPendingAttachmentsForScope,
} from "@/lib/chat-pending-attachments";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PREVIEW_IMAGE_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='480' height='320' viewBox='0 0 480 320'%3E%3Crect width='480' height='320' fill='%232f80ed'/%3E%3Ctext x='240' y='168' fill='white' font-size='34' font-family='Arial' text-anchor='middle'%3EPreview%3C/text%3E%3C/svg%3E";

const mockState = vi.hoisted(() => ({
  conversationId: "chat-1",
  conversations: [] as ChatConversation[],
  messagesByChatId: {} as Record<string, ChatMessage[]>,
  projects: [] as Project[],
  invalidateQueries: vi.fn(),
  markRead: vi.fn(),
  mutations: [] as unknown[],
  navigate: vi.fn(),
  pushToast: vi.fn(),
  queryKeys: [] as unknown[][],
  sendMessageStream: vi.fn(),
  setBreadcrumbs: vi.fn(),
  streamDrafts: {} as Record<string, ChatStreamDraft>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled = true }: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    if (!enabled) return { data: undefined, isPending: false, isLoading: false, error: null };
    mockState.queryKeys.push([...queryKey]);
    if (queryKey[0] === "chats" && queryKey[2] === "active") {
      return { data: mockState.conversations, isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "chats" && queryKey[1] === "detail") {
      return {
        data: mockState.conversations.find((chat) => chat.id === queryKey[2]) ?? null,
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "chats" && queryKey[1] === "messages") {
      return {
        data: mockState.messagesByChatId[String(queryKey[2])] ?? [],
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "agents") {
      return {
        data: [{ id: "agent-1", name: "Wesley", role: "engineer", title: "Founding Engineer", status: "active", icon: null }],
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "projects") {
      return { data: mockState.projects, isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "instance") {
      return { data: { nickname: "" }, isPending: false, isLoading: false, error: null };
    }
    return { data: [], isPending: false, isLoading: false, error: null };
  },
  useMutation: () => ({
    isPending: false,
    mutate: (variables: unknown) => {
      mockState.mutations.push(variables);
      mockState.markRead(variables);
    },
  }),
  useQueryClient: () => ({
    invalidateQueries: mockState.invalidateQueries,
    setQueryData: vi.fn(),
    setQueriesData: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: `/messenger/chat/${mockState.conversationId}`, search: "", hash: "", key: "chat" }),
  useNavigate: () => mockState.navigate,
  useParams: () => ({ conversationId: mockState.conversationId }),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    selectedOrganization: { id: "org-1", name: "Rudder", urlKey: "RUD" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockState.setBreadcrumbs }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockState.pushToast }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({ t: (key: string, values?: Record<string, string>) => values?.name ?? key }),
}));

vi.mock("@/context/ChatGenerationContext", () => ({
  useChatGenerations: () => ({
    abortChatStream: vi.fn(),
    sendInFlightByChatId: {},
    setChatSendInFlight: vi.fn(),
    setStreamAbortController: vi.fn(),
    setStreamDraftForChat: vi.fn(),
    streamDrafts: mockState.streamDrafts,
  }),
}));

vi.mock("@/api/chats", () => ({
  chatsApi: {
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(async (_chatId: string, patch: Partial<ChatConversation>) => ({
      ...mockState.conversations[0],
      ...patch,
    })),
    stopMessageStream: vi.fn(async () => undefined),
    sendMessageStream: mockState.sendMessageStream,
  },
}));

vi.mock("@/components/MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef((_props: unknown, ref) => {
      React.useImperativeHandle(ref, () => ({ focus: vi.fn() }));
      return <div data-testid="mock-markdown-editor" />;
    }),
  };
});

let cleanupFn: (() => void) | null = null;
let storageState: Record<string, string> = {};

function chat(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: "chat-1",
    orgId: "org-1",
    status: "active",
    title: "Pending proposal chat",
    summary: null,
    latestReplyPreview: null,
    latestUserMessagePreview: null,
    userMessageCount: 0,
    preferredAgentId: "agent-1",
    routedAgentId: null,
    primaryIssueId: null,
    primaryIssue: null,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: null,
    lastMessageAt: new Date("2026-05-12T09:00:00.000Z"),
    lastReadAt: null,
    isPinned: false,
    isUnread: false,
    unreadCount: 0,
    needsAttention: false,
    resolvedAt: null,
    contextLinks: [],
    chatRuntime: {
      sourceType: "agent",
      sourceLabel: "Wesley",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "codex",
      model: null,
      available: true,
      error: null,
    },
    createdAt: new Date("2026-05-12T09:00:00.000Z"),
    updatedAt: new Date("2026-05-12T09:00:00.000Z"),
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "10000000-0000-4000-8000-000000000010",
    orgId: "org-1",
    urlKey: "rudder-mkt",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Rudder mkt",
    description: null,
    status: "planned",
    leadAgentId: null,
    targetDate: null,
    color: "#82b366",
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      configured: false,
      scope: "none",
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "",
      effectiveLocalFolder: "",
      origin: "local_folder",
    },
    resources: [],
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date("2026-05-12T09:00:00.000Z"),
    updatedAt: new Date("2026-05-12T09:00:00.000Z"),
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-1",
    orgId: "org-1",
    conversationId: "chat-1",
    role: "user",
    kind: "message",
    status: "completed",
    body: "Attached image",
    structuredPayload: null,
    approvalId: null,
    approval: null,
    attachments: [],
    transcript: [],
    replyingAgentId: null,
    chatTurnId: null,
    turnVariant: 0,
    supersededAt: null,
    createdAt: new Date("2026-05-12T09:01:00.000Z"),
    updatedAt: new Date("2026-05-12T09:01:00.000Z"),
    ...overrides,
  };
}

function pendingIssueProposal(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return message({
    id: "proposal-1",
    role: "assistant",
    kind: "issue_proposal",
    body: "Please review this proposal.",
    structuredPayload: {
      issueProposal: {
        title: "Fix attachment preview",
        priority: "medium",
        description: "Move the preview dialog outside the composer.",
      },
    },
    approvalId: "approval-1",
    approval: {
      id: "approval-1",
      orgId: "org-1",
      type: "chat_issue_creation",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: {},
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-05-12T09:02:00.000Z"),
      updatedAt: new Date("2026-05-12T09:02:00.000Z"),
    },
    createdAt: new Date("2026-05-12T09:02:00.000Z"),
    updatedAt: new Date("2026-05-12T09:02:00.000Z"),
    ...overrides,
  });
}

function pendingAskUser(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return message({
    id: "ask-user-1",
    role: "assistant",
    kind: "ask_user",
    body: "I need one decision before continuing.",
    structuredPayload: {
      requestUserInput: {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should the agent implement?",
            options: [
              {
                id: "narrow",
                label: "Narrow path",
                description: "Smallest shippable path",
                recommended: true,
              },
              {
                id: "broad",
                label: "Broad path",
              },
            ],
            allowFreeform: true,
          },
        ],
      },
    },
    createdAt: new Date("2026-05-12T09:03:00.000Z"),
    updatedAt: new Date("2026-05-12T09:03:00.000Z"),
    ...overrides,
  });
}

function pendingMultiAskUser(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return pendingAskUser({
    id: "ask-user-multi-1",
    body: "I need a few decisions before continuing.",
    structuredPayload: {
      requestUserInput: {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should the agent implement?",
            options: [
              { id: "narrow", label: "Narrow path", recommended: true },
              { id: "broad", label: "Broad path" },
            ],
            allowFreeform: true,
          },
          {
            id: "risk",
            header: "Risk",
            question: "Which risk should be handled first?",
            options: [
              { id: "tests", label: "Missing tests" },
              { id: "copy", label: "Copy clarity" },
            ],
            allowFreeform: true,
          },
          {
            id: "handoff",
            header: "Handoff",
            question: "What should the handoff include?",
            options: [
              { id: "summary", label: "Short summary" },
              { id: "full", label: "Full report" },
            ],
            allowFreeform: true,
          },
        ],
      },
    },
    ...overrides,
  });
}

function imageMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return message({
    id: "image-message-1",
    attachments: [
      {
        id: "attachment-1",
        orgId: "org-1",
        conversationId: "chat-1",
        messageId: "image-message-1",
        assetId: "asset-1",
        provider: "local_disk",
        objectKey: "asset-1",
        contentPath: PREVIEW_IMAGE_SRC,
        contentType: "image/svg+xml",
        byteSize: 68,
        sha256: "sha256",
        originalFilename: "proposal-screenshot.png",
        createdByAgentId: null,
        createdByUserId: "local-board",
        createdAt: new Date("2026-05-12T09:01:00.000Z"),
        updatedAt: new Date("2026-05-12T09:01:00.000Z"),
      },
    ],
    ...overrides,
  });
}

function installLocalStorageMock() {
  storageState = {};
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storageState[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storageState[key] = String(value);
    }),
    removeItem: vi.fn((key: string) => {
      delete storageState[key];
    }),
    clear: vi.fn(() => {
      storageState = {};
    }),
  });
}

function renderChat() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  const render = (targetRoot: Root) => {
    targetRoot.render(
      <ThemeProvider>
        <Chat />
      </ThemeProvider>,
    );
  };

  act(() => {
    render(root);
  });

  return {
    container,
    rerender: () => act(() => render(root)),
  };
}

function dispatchPasteFiles(target: Element, files: File[], options: { clipboardFiles?: File[] } = {}) {
  const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(pasteEvent, "clipboardData", {
    value: {
      items: files.map((file) => ({
        kind: "file",
        getAsFile: () => file,
      })),
      files: options.clipboardFiles ?? files,
    },
  });
  target.dispatchEvent(pasteEvent);
}

async function clickEnabledButton(container: Element, label: string) {
  await act(async () => {
    await Promise.resolve();
  });
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label)
  );
  expect(button).not.toBeUndefined();
  expect(button?.disabled).toBe(false);
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  installLocalStorageMock();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:chat-attachment-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  resetChatPendingAttachmentsForTests();
  mockState.conversationId = "chat-1";
  mockState.conversations = [
    chat({ id: "chat-1", title: "Pending proposal chat" }),
    chat({ id: "chat-2", title: "Other chat", lastMessageAt: new Date("2026-05-12T09:10:00.000Z") }),
  ];
  mockState.projects = [
    project(),
    project({
      id: "10000000-0000-4000-8000-000000000011",
      urlKey: "launch",
      name: "Launch Ops",
      color: "#2f80ed",
    }),
  ];
  mockState.messagesByChatId = {
    "chat-1": [imageMessage(), pendingIssueProposal()],
    "chat-2": [message({ id: "other-message-1", conversationId: "chat-2", body: "Other chat" })],
  };
  mockState.invalidateQueries.mockReset();
  mockState.markRead.mockReset();
  mockState.mutations = [];
  mockState.navigate.mockReset();
  mockState.pushToast.mockReset();
  mockState.queryKeys = [];
  mockState.sendMessageStream.mockReset();
  mockState.sendMessageStream.mockImplementation(async (chatId: string, body: string, options: {
    onEvent: (event: unknown) => void | Promise<void>;
  }) => {
    await options.onEvent({
      type: "ack",
      userMessage: message({
        id: "sent-user-message",
        conversationId: chatId,
        body,
        createdAt: new Date("2026-05-12T09:04:00.000Z"),
      }),
    });
    await options.onEvent({
      type: "final",
      messages: [
        message({
          id: "sent-user-message",
          conversationId: chatId,
          body,
          createdAt: new Date("2026-05-12T09:04:00.000Z"),
        }),
      ],
    });
  });
  mockState.setBreadcrumbs.mockReset();
  mockState.streamDrafts = {};
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Chat mention sources", () => {
  it("uses active conversations for mention options instead of archived threads", () => {
    renderChat();

    const chatListStatuses = mockState.queryKeys
      .filter((queryKey) => queryKey[0] === "chats" && queryKey.length === 3)
      .map((queryKey) => queryKey[2]);
    expect(chatListStatuses).toContain("active");
    expect(chatListStatuses).not.toContain("all");
  });
});

describe("Chat attachment previews", () => {
  it("does not over-cancel the workspace main padding on desktop", () => {
    const { container } = renderChat();

    const shell = container.querySelector(".chat-shell");
    expect(shell?.className).toContain("md:-mx-3.5");
    expect(shell?.className).toContain("lg:-mx-5");
    expect(shell?.className).not.toContain("md:-mx-6");
    expect(shell?.className).not.toContain("lg:-mx-7");
  });

  it("opens message image previews while a pending proposal hides the composer and clears on conversation change", () => {
    const { container, rerender } = renderChat();

    expect(container.querySelector("[data-testid='proposal-review-block']")).not.toBeNull();
    expect(container.querySelector("[data-testid='chat-composer-toolbar']")).toBeNull();

    const imageButton = container.querySelector<HTMLButtonElement>(
      "[data-testid='chat-image-attachment'] button",
    );
    expect(imageButton).not.toBeNull();

    act(() => {
      imageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const preview = document.body.querySelector("[data-testid='chat-image-preview-dialog']");
    expect(preview).not.toBeNull();
    expect(preview?.querySelector("img")?.getAttribute("alt")).toBe("proposal-screenshot.png");

    mockState.conversationId = "chat-2";
    rerender();

    expect(document.body.querySelector("[data-testid='chat-image-preview-dialog']")).toBeNull();
  });
});

describe("Chat ask_user panel", () => {
  const multilineFreeformAnswer = [
    "Answering the requested input:",
    "",
    "- Scope",
    "  Answer: Use the narrow path",
    "    - keep API extensible",
    "    - defer broad UI",
  ].join("\n");

  it("hides the bottom composer while input is pending and restores it after an answer", () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
      ],
    };

    const { container, rerender } = renderChat();

    expect(container.querySelector("[data-testid='chat-ask-user-panel']")).not.toBeNull();
    expect(container.querySelector("[data-testid='chat-composer-toolbar']")).toBeNull();
    expect(container.textContent).not.toContain("Choose an answer to continue");
    expect(container.textContent).not.toContain("The assistant is waiting on this decision.");
    expect(container.textContent).not.toContain("You can still type in the composer below.");

    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
        message({
          id: "user-answer",
          body: "Answering the requested input:\n\n- Scope\n  Answer: Narrow path",
          createdAt: new Date("2026-05-12T09:04:00.000Z"),
        }),
      ],
    };
    rerender();

    expect(container.querySelector("[data-testid='chat-ask-user-panel']")).toBeNull();
    expect(container.querySelector("[data-testid='chat-ask-user-answer']")).not.toBeNull();
    expect(container.textContent).toContain("Answered");
    expect(container.textContent).not.toContain("Answering the requested input:");
    expect(container.querySelector("[data-testid='chat-composer-toolbar']")).not.toBeNull();
  });

  it("lets Other answers include pending attachments", async () => {
    const attachment = new File(["log output"], "failure-log.txt", { type: "text/plain" });
    updateChatPendingAttachmentsForScope(
      resolveChatPendingAttachmentScopeKey("org-1", "chat-1"),
      () => [attachment],
    );
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
      ],
    };

    const { container } = renderChat();
    const panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();

    await clickEnabledButton(container, "Other");
    expect(panel?.textContent).toContain("Attach");
    expect(panel?.textContent).toContain("failure-log.txt");
    expect(container.querySelector("[data-testid='chat-ask-user-pending-attachment']")).not.toBeNull();

    const textarea = panel?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(textarea, "This needs the attached log.");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await clickEnabledButton(container, "Submit answer");

    expect(mockState.sendMessageStream).toHaveBeenCalledTimes(1);
    expect(mockState.sendMessageStream.mock.calls[0]?.[2]).toMatchObject({
      files: [attachment],
    });
    expect(container.querySelector("[data-testid='chat-ask-user-pending-attachment']")).toBeNull();
  });

  it("lets Other answers paste attachments directly into the input panel", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
      ],
    };

    const { container } = renderChat();
    const panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();

    await clickEnabledButton(container, "Other");
    const textarea = panel?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    const attachment = new File(["receipt details"], "receipt.txt", { type: "text/plain" });
    await act(async () => {
      dispatchPasteFiles(textarea!, [attachment]);
      await Promise.resolve();
    });

    expect(panel?.textContent).toContain("receipt.txt");
    expect(container.querySelector("[data-testid='chat-ask-user-pending-attachment']")).not.toBeNull();

    await clickEnabledButton(container, "Submit answer");

    expect(mockState.sendMessageStream).toHaveBeenCalledTimes(1);
    const sentFiles = mockState.sendMessageStream.mock.calls[0]?.[2]?.files as File[] | undefined;
    expect(sentFiles).toHaveLength(1);
    expect(sentFiles?.[0]?.name).toBe("receipt.txt");
    expect(container.querySelector("[data-testid='chat-ask-user-pending-attachment']")).toBeNull();
  });

  it("dedupes pasted attachments exposed through both clipboard items and files", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
      ],
    };

    const { container } = renderChat();
    const panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();

    await clickEnabledButton(container, "Other");
    const textarea = panel?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    const clipboardItemFile = new File(["receipt image"], "receipt.png", {
      type: "image/png",
      lastModified: 1000,
    });
    const clipboardListFile = new File(["receipt image"], "receipt.png", {
      type: "image/png",
      lastModified: 2000,
    });
    await act(async () => {
      dispatchPasteFiles(textarea!, [clipboardItemFile], { clipboardFiles: [clipboardListFile] });
      await Promise.resolve();
    });

    expect(container.querySelectorAll("[data-testid='chat-ask-user-pending-attachment']")).toHaveLength(1);

    await clickEnabledButton(container, "Submit answer");

    expect(mockState.sendMessageStream).toHaveBeenCalledTimes(1);
    const sentFiles = mockState.sendMessageStream.mock.calls[0]?.[2]?.files as File[] | undefined;
    expect(sentFiles).toHaveLength(1);
    expect(sentFiles?.[0]?.name).toBe("receipt.png");
  });

  it("renders persisted multiline Other answers without dropping bullet lines", () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
        message({
          id: "user-answer",
          body: multilineFreeformAnswer,
          createdAt: new Date("2026-05-12T09:04:00.000Z"),
        }),
      ],
    };

    const { container } = renderChat();

    const answer = container.querySelector("[data-testid='chat-ask-user-answer']");
    expect(answer).not.toBeNull();
    expect(answer?.textContent).toContain("Use the narrow path");
    expect(answer?.textContent).toContain("- keep API extensible");
    expect(answer?.textContent).toContain("- defer broad UI");
    expect(container.textContent).not.toContain("Answering the requested input:");
  });

  it("renders optimistic multiline Other answers without dropping bullet lines", () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
      ],
    };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        userBody: multilineFreeformAnswer,
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: null,
        chatTurnId: "turn-ask-user",
        editedFromCreatedAt: null,
        body: "",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };

    const { container } = renderChat();

    const answer = container.querySelector("[data-testid='chat-ask-user-answer']");
    expect(answer).not.toBeNull();
    expect(answer?.textContent).toContain("Use the narrow path");
    expect(answer?.textContent).toContain("- keep API extensible");
    expect(answer?.textContent).toContain("- defer broad UI");
    expect(container.textContent).not.toContain("Answering the requested input:");
  });

  it("steps through multi-question input instead of expanding every question", () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingMultiAskUser(),
      ],
    };

    const { container } = renderChat();
    const panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("Question 1 of 3");
    expect(panel?.textContent).toContain("Scope");
    expect(panel?.textContent).toContain("Narrow path");
    expect(panel?.textContent).not.toContain("Missing tests");
    expect(panel?.textContent).not.toContain("Short summary");

    const clickButton = (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes(label)
      );
      expect(button).not.toBeUndefined();
      act(() => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };

    clickButton("Narrow path");
    expect(panel?.textContent).toContain("Question 2 of 3");
    expect(panel?.textContent).toContain("Missing tests");
    expect(panel?.textContent).not.toContain("Short summary");

    clickButton("Back");
    expect(panel?.textContent).toContain("Question 1 of 3");
    expect(panel?.textContent).toContain("Broad path");

    clickButton("Broad path");
    clickButton("Missing tests");
    expect(panel?.textContent).toContain("Question 3 of 3");
    clickButton("Other");

    const textarea = panel?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(textarea, "Include screenshot evidence");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    clickButton("Review answers");
    expect(panel?.textContent).toContain("Review answers");
    expect(panel?.textContent).toContain("Broad path");
    expect(panel?.textContent).toContain("Missing tests");
    expect(panel?.textContent).toContain("Include screenshot evidence");
    expect(panel?.textContent).not.toContain("Question 3 of 3");
  });

  it("lets one ask_user question collect multiple selected options", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser({
          structuredPayload: {
            requestUserInput: {
              questions: [
                {
                  id: "evidence",
                  header: "Evidence",
                  question: "Which evidence should the agent collect?",
                  selectionMode: "multiple",
                  options: [
                    { id: "tests", label: "Test output" },
                    { id: "screenshots", label: "Screenshots" },
                    { id: "diff", label: "Diff summary" },
                  ],
                  allowFreeform: false,
                },
              ],
            },
          },
        }),
      ],
    };

    const { container } = renderChat();
    const panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();

    await clickEnabledButton(container, "Test output");
    expect(panel?.textContent).toContain("Screenshots");
    await clickEnabledButton(container, "Screenshots");
    await clickEnabledButton(container, "Submit answer");

    expect(mockState.sendMessageStream).toHaveBeenCalledTimes(1);
    expect(mockState.sendMessageStream.mock.calls[0]?.[1]).toContain("Answer: Test output, Screenshots");
  });
});

describe("Chat project context selector", () => {
  it("does not render resource counts in the project context menu", () => {
    mockState.conversations = [chat({ id: "chat-1", lastMessageAt: null })];
    mockState.messagesByChatId = { "chat-1": [] };
    mockState.projects = [
      project({
        name: "Rudder mkt",
        resources: [
          {
            id: "attachment-1",
            orgId: "org-1",
            projectId: "10000000-0000-4000-8000-000000000010",
            resourceId: "resource-1",
            role: "working_set",
            note: null,
            sortOrder: 0,
            resource: {
              id: "resource-1",
              orgId: "org-1",
              name: "Main repo",
              kind: "directory",
              sourceType: "external",
              locator: "/Users/zeeland/projects/rudder-oss",
              description: null,
              metadata: null,
              createdAt: new Date("2026-05-12T09:00:00.000Z"),
              updatedAt: new Date("2026-05-12T09:00:00.000Z"),
            },
            createdAt: new Date("2026-05-12T09:00:00.000Z"),
            updatedAt: new Date("2026-05-12T09:00:00.000Z"),
          },
        ],
      }),
    ];

    const { container } = renderChat();

    const projectSelector = container.querySelector<HTMLButtonElement>("[data-testid='chat-project-selector']");
    expect(projectSelector).not.toBeNull();

    act(() => {
      projectSelector?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const projectMenu = document.body.querySelector("[data-testid='chat-project-menu']");
    expect(projectMenu).not.toBeNull();
    expect(projectMenu?.textContent).toContain("Rudder mkt");
    expect(projectMenu?.textContent).not.toMatch(/\b\d+\s+resources\b/u);
  });

  it("locks the project selector after a conversation already has project context", () => {
    mockState.conversations = [
      chat({
        id: "chat-1",
        contextLinks: [
          {
            id: "context-project-1",
            orgId: "org-1",
            conversationId: "chat-1",
            entityType: "project",
            entityId: "10000000-0000-4000-8000-000000000010",
            metadata: null,
            entity: {
              type: "project",
              id: "10000000-0000-4000-8000-000000000010",
              label: "Rudder mkt",
              subtitle: null,
              identifier: null,
              status: "active",
              href: "/projects/10000000-0000-4000-8000-000000000010",
            },
            createdAt: new Date("2026-05-12T09:00:00.000Z"),
            updatedAt: new Date("2026-05-12T09:00:00.000Z"),
          },
        ],
      }),
    ];
    mockState.messagesByChatId = { "chat-1": [] };

    const { container } = renderChat();

    const projectSelector = container.querySelector<HTMLButtonElement>("[data-testid='chat-project-selector']");
    expect(projectSelector).not.toBeNull();
    expect(projectSelector?.textContent).toContain("Rudder mkt");
    expect(projectSelector?.disabled).toBe(true);
    expect(container.querySelector("[data-testid='chat-project-selector-chevron']")).toBeNull();

    act(() => {
      projectSelector?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.querySelector("[data-testid='chat-project-menu']")).toBeNull();
    expect(projectSelector?.textContent).toContain("Rudder mkt");
    expect(mockState.mutations).toEqual([]);
  });
});
