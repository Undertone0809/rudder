// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ChatConversation } from "@rudderhq/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import {
  ChatLongMessageBody,
  ChatEmptyStatePromptOptions,
  ChatEmptyStateRecentConversations,
  EMPTY_STATE_PROMPT_GROUPS,
  OPEN_TASK_PRIORITY_PROMPT,
} from "./Chat";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/chat" }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("@/components/transcript/RunTranscriptView", () => ({
  RunTranscriptView: () => null,
}));

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
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
    root.render(element);
  });
  return container;
}

function turnChatIntoIssueGroup() {
  const group = EMPTY_STATE_PROMPT_GROUPS.find((candidate) => candidate.label === "Turn a chat into an issue");
  if (!group) throw new Error("Missing Turn a chat into an issue prompt group");
  return group;
}

function chatConversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: "chat-1",
    orgId: "org-1",
    status: "active",
    title: "Recent planning chat",
    summary: "Clarified the draft scope.",
    latestReplyPreview: null,
    latestUserMessagePreview: null,
    userMessageCount: 0,
    preferredAgentId: null,
    routedAgentId: null,
    primaryIssueId: null,
    primaryIssue: null,
    issueCreationMode: "manual_approval",
    planMode: false,
    chatRuntime: { available: true, error: null, runtimeAgentId: null },
    contextLinks: [],
    isPinned: false,
    isUnread: false,
    lastReadAt: null,
    lastMessageAt: new Date("2026-06-09T08:00:00.000Z"),
    createdAt: new Date("2026-06-09T07:00:00.000Z"),
    updatedAt: new Date("2026-06-09T08:00:00.000Z"),
    ...overrides,
  } as ChatConversation;
}

describe("Chat empty-state prompt examples", () => {
  it("includes the open-task priority prompt under issue examples", () => {
    expect(turnChatIntoIssueGroup().examples).toContain(OPEN_TASK_PRIORITY_PROMPT);
  });

  it("selects the priority prompt without using a submit button", () => {
    const onExampleSelect = vi.fn();
    const container = render(
      <ChatEmptyStatePromptOptions
        group={turnChatIntoIssueGroup()}
        optionsId="chat-empty-state-prompt-options"
        entered
        originX="50%"
        onExampleSelect={onExampleSelect}
      />,
    );

    const priorityPromptButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === OPEN_TASK_PRIORITY_PROMPT);

    expect(priorityPromptButton).toBeTruthy();
    expect(priorityPromptButton?.getAttribute("type")).toBe("button");

    act(() => {
      priorityPromptButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onExampleSelect).toHaveBeenCalledWith(OPEN_TASK_PRIORITY_PROMPT);
  });
});

describe("ChatEmptyStateRecentConversations", () => {
  it("renders the latest user question instead of the assistant reply after multiple user questions", () => {
    const container = render(
      <ChatEmptyStateRecentConversations
        conversations={[
          chatConversation({
            title: "Release maintainer setup",
            latestUserMessagePreview: "Can this release workflow run from the desktop shell?",
            userMessageCount: 2,
            latestReplyPreview: "Confirmed: release-maintainer was forked and can be used directly.",
          }),
        ]}
        projectName="Rudder dev"
        visible
        conversationPath={(id) => `/chat/${id}`}
        onPrefetchConversation={vi.fn()}
      />,
    );

    const recentSection = container.querySelector<HTMLElement>("[data-testid='chat-empty-state-recent-project-conversations']");

    expect(recentSection?.textContent).toContain("Can this release workflow run from the desktop shell?");
    expect(recentSection?.textContent).not.toContain("Confirmed: release-maintainer was forked");
  });

  it("renders the assistant reply when the conversation only has one user question", () => {
    const container = render(
      <ChatEmptyStateRecentConversations
        conversations={[
          chatConversation({
            title: "Release maintainer setup",
            latestUserMessagePreview: "Can this release workflow run from the desktop shell?",
            userMessageCount: 1,
            latestReplyPreview: "Confirmed: release-maintainer was forked and can be used directly.",
          }),
        ]}
        projectName="Rudder dev"
        visible
        conversationPath={(id) => `/chat/${id}`}
        onPrefetchConversation={vi.fn()}
      />,
    );

    const recentSection = container.querySelector<HTMLElement>("[data-testid='chat-empty-state-recent-project-conversations']");

    expect(recentSection?.textContent).toContain("Confirmed: release-maintainer was forked");
    expect(recentSection?.textContent).not.toContain("Can this release workflow run from the desktop shell?");
  });

  it("keeps default chat titles from falling back to assistant replies in the row title", () => {
    const container = render(
      <ChatEmptyStateRecentConversations
        conversations={[
          chatConversation({
            title: "New chat",
            summary: null,
            latestReplyPreview: "Assistant reply should stay hidden.",
          }),
        ]}
        projectName="Rudder dev"
        visible
        conversationPath={(id) => `/chat/${id}`}
        onPrefetchConversation={vi.fn()}
      />,
    );

    const recentSection = container.querySelector<HTMLElement>("[data-testid='chat-empty-state-recent-project-conversations']");
    const row = recentSection?.querySelector<HTMLElement>("[data-testid='chat-empty-state-recent-conversation-chat-1']");
    const rowTitle = row?.querySelector<HTMLElement>(".font-medium");

    expect(rowTitle?.textContent).toBe("New chat");
    expect(recentSection?.textContent).toContain("Assistant reply should stay hidden.");
  });

  it("keeps recent conversations open only while the empty-state composer is empty", () => {
    const visibleContainer = render(
      <ChatEmptyStateRecentConversations
        conversations={[chatConversation()]}
        projectName="Rudder dev"
        visible
        conversationPath={(id) => `/chat/${id}`}
        onPrefetchConversation={vi.fn()}
      />,
    );

    const openSection = visibleContainer.querySelector<HTMLElement>("[data-testid='chat-empty-state-recent-project-conversations']");
    const openLink = visibleContainer.querySelector<HTMLAnchorElement>("[data-testid='chat-empty-state-recent-conversation-chat-1']");

    expect(openSection?.dataset.state).toBe("open");
    expect(openSection?.getAttribute("aria-hidden")).toBe("false");
    expect(openLink?.getAttribute("tabindex")).toBeNull();
    expect(openSection?.textContent).not.toContain("Recent conversations");
    expect(openSection?.textContent).toContain("Recent planning chat");

    cleanupFn?.();
    cleanupFn = null;

    const hiddenContainer = render(
      <ChatEmptyStateRecentConversations
        conversations={[chatConversation()]}
        projectName="Rudder dev"
        visible={false}
        conversationPath={(id) => `/chat/${id}`}
        onPrefetchConversation={vi.fn()}
      />,
    );

    const closedSection = hiddenContainer.querySelector<HTMLElement>("[data-testid='chat-empty-state-recent-project-conversations']");
    const closedLink = hiddenContainer.querySelector<HTMLAnchorElement>("[data-testid='chat-empty-state-recent-conversation-chat-1']");

    expect(closedSection?.dataset.state).toBe("closed");
    expect(closedSection?.getAttribute("aria-hidden")).toBe("true");
    expect(closedLink?.getAttribute("tabindex")).toBe("-1");
  });
});

describe("ChatLongMessageBody", () => {
  it("shows overflowing message text without a disclosure toggle", () => {
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 900,
    });

    try {
      const container = render(
        <ThemeProvider>
          <ChatLongMessageBody
            body={"Long message\n\n".repeat(80)}
            skillReferences={[]}
          />
        </ThemeProvider>,
      );

      const body = container.querySelector<HTMLElement>("[data-testid='chat-long-message-body']");
      const toggle = container.querySelector<HTMLButtonElement>("[data-testid='chat-long-message-toggle']");

      expect(body?.style.maxHeight).toBe("");
      expect(body?.className).not.toContain("overflow-hidden");
      expect(toggle).toBeNull();
    } finally {
      if (scrollHeight) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      }
    }
  });
});
