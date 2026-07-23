// @vitest-environment jsdom

import { ThemeProvider } from "@/context/ThemeContext";
import type { ChatConversation } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyChatPromptToDraft,
  ChatEmptyStatePromptOptions,
  ChatEmptyStatePromptStarters,
  ChatEmptyStateRecentConversations,
  ChatLongMessageBody,
  chatPromptGroupForExactTrigger,
  chatPromptQueryFromDraft,
  chatPromptSuggestionsForDisplay,
  chatPromptSuggestionsForDraft,
  EMPTY_STATE_PROMPT_GROUPS,
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

function automateGroup() {
  const group = EMPTY_STATE_PROMPT_GROUPS.find((candidate) => candidate.id === "automate");
  if (!group) throw new Error("Missing automate prompt group");
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

describe("Chat empty-state prompt starters", () => {
  it("uses the four Codex task categories as two-step prompt groups", () => {
    expect(EMPTY_STATE_PROMPT_GROUPS.map((group) => group.label)).toEqual([
      "Create a file or build a site",
      "Research and plan next steps",
      "Get a briefing on recent work",
      "Automate routine and recurring work",
    ]);
    expect(EMPTY_STATE_PROMPT_GROUPS.map((group) => group.trigger)).toEqual([
      "Create a",
      "Figure out next steps",
      "Brief me on",
      "Automate",
    ]);
    expect(EMPTY_STATE_PROMPT_GROUPS.every((group) => group.suggestions.length === 4)).toBe(true);
    expect(EMPTY_STATE_PROMPT_GROUPS.every((group) => (
      group.suggestions.every((suggestion) => suggestion.prompt.includes("Start by asking me"))
    ))).toBe(true);
  });

  it("renders lightweight starter rows and selects a group before a complete prompt", () => {
    const onGroupSelect = vi.fn();
    const container = render(
      <ChatEmptyStatePromptStarters active onGroupSelect={onGroupSelect} />,
    );
    const starter = container.querySelector<HTMLButtonElement>("[data-testid='chat-empty-state-starter-automate']");

    expect(container.querySelector("[data-testid='chat-empty-state-starters']")?.className).toContain("t-stagger");
    expect(starter?.className).toContain("t-stagger-line");
    expect(starter?.className).not.toContain("h-[124px]");

    act(() => {
      starter?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onGroupSelect).toHaveBeenCalledWith(expect.objectContaining({
      id: "automate",
      trigger: "Automate",
    }));
  });

  it("matches only normalized prefixes of displayed suggestion labels", () => {
    expect(chatPromptSuggestionsForDraft("Create a").map((suggestion) => suggestion.label)).toEqual([
      "Create a new document",
      "Create a new spreadsheet",
      "Create a new presentation",
      "Create a new website",
    ]);
    expect(chatPromptSuggestionsForDraft("  cReAtE\u00a0 A   NeW D  ").map((suggestion) => suggestion.label)).toEqual([
      "Create a new document",
    ]);
    expect(chatPromptSuggestionsForDraft("Figure out next steps").map((suggestion) => suggestion.label)).toEqual([
      "Figure out next steps for a topic I'm exploring",
      "Figure out next steps after comparing options",
      "Figure out next steps for an upcoming meeting",
      "Figure out next steps for a strategy or project",
    ]);
  });

  it("recognizes only an exact prompt-group trigger for composer emphasis", () => {
    expect(chatPromptGroupForExactTrigger("Create a")?.id).toBe("create");
    expect(chatPromptGroupForExactTrigger("Create a new")).toBeNull();
    expect(chatPromptGroupForExactTrigger("Automate")?.id).toBe("automate");
  });

  it.each([
    "",
    "   ",
    "what",
    "fi",
    "file",
    "monitoring changes",
    "A",
  ])("returns no suggestions for an empty or unmatched %j query", (query) => {
    expect(chatPromptSuggestionsForDraft(query)).toEqual([]);
  });

  it("does not reuse retained rows for a new unmatched query", () => {
    const retainedSuggestions = chatPromptSuggestionsForDraft("Automate");
    expect(chatPromptSuggestionsForDisplay([], retainedSuggestions, "what", null)).toEqual([]);
    expect(chatPromptSuggestionsForDisplay([], retainedSuggestions, "fi", "automate")).toEqual([]);
    expect(chatPromptSuggestionsForDisplay([], retainedSuggestions, "", null)).toEqual([]);

    const selectedPromptQuery = automateGroup().suggestions[0].prompt.toLowerCase();
    expect(chatPromptSuggestionsForDisplay(
      [],
      retainedSuggestions,
      selectedPromptQuery,
      selectedPromptQuery,
    )).toBe(retainedSuggestions);
  });

  it("hides suggestions after a complete prompt has been selected", () => {
    const selectedPrompt = automateGroup().suggestions[1].prompt;
    expect(chatPromptSuggestionsForDraft(selectedPrompt)).toEqual([]);
    expect(chatPromptSuggestionsForDraft(`${selectedPrompt} Include weather.`)).toEqual([]);
  });

  it("preserves selected Skill references while replacing the typed starter", () => {
    const skillReference = "[daily-brief](skill://org/skill-1?ref=daily-brief)";
    const draft = `Automate ${skillReference}\u00a0`;
    const prompt = automateGroup().suggestions[0].prompt;

    expect(chatPromptQueryFromDraft(draft)).toBe("Automate");
    expect(applyChatPromptToDraft(draft, prompt)).toBe(`${prompt} ${skillReference}\u00a0`);
  });

  it("renders keyboard-selectable options and fills without submitting", () => {
    const onSuggestionSelect = vi.fn();
    const suggestions = automateGroup().suggestions.map((suggestion) => ({
      ...suggestion,
      groupId: automateGroup().id,
    }));
    const container = render(
      <ChatEmptyStatePromptOptions
        suggestions={suggestions}
        optionsId="chat-empty-state-prompt-options"
        activeIndex={1}
        onActiveIndexChange={vi.fn()}
        onSuggestionSelect={onSuggestionSelect}
      />,
    );

    const listbox = container.querySelector("[role='listbox']");
    const morningPrepButton = Array.from(container.querySelectorAll<HTMLButtonElement>("[role='option']"))
      .find((button) => button.textContent?.includes("Automate my morning prep"));

    expect(listbox?.getAttribute("aria-label")).toBe("Suggested prompts");
    expect(listbox?.className).toContain("t-stagger");
    expect(morningPrepButton?.getAttribute("type")).toBe("button");
    expect(morningPrepButton?.getAttribute("tabindex")).toBe("-1");
    expect(morningPrepButton?.getAttribute("aria-selected")).toBe("true");

    act(() => {
      morningPrepButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSuggestionSelect).toHaveBeenCalledWith(expect.objectContaining({
      id: "automate-morning-prep",
      prompt: automateGroup().suggestions[1].prompt,
    }));
  });

  it("keeps prompt options inert while the secondary page enters", () => {
    const onSuggestionSelect = vi.fn();
    const suggestions = automateGroup().suggestions.map((suggestion) => ({
      ...suggestion,
      groupId: automateGroup().id,
    }));
    const container = render(
      <ChatEmptyStatePromptOptions
        suggestions={suggestions}
        optionsId="chat-empty-state-prompt-options"
        activeIndex={0}
        interactive={false}
        onActiveIndexChange={vi.fn()}
        onSuggestionSelect={onSuggestionSelect}
      />,
    );

    const listbox = container.querySelector<HTMLElement>("[role='listbox']");
    const firstOption = container.querySelector<HTMLButtonElement>("[role='option']");
    expect(listbox?.dataset.interactive).toBe("false");
    expect(firstOption?.disabled).toBe(true);
    expect(firstOption?.getAttribute("aria-disabled")).toBe("true");

    act(() => {
      firstOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      firstOption?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
      firstOption?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    expect(onSuggestionSelect).not.toHaveBeenCalled();
  });

  it("keeps retained prompt options inert while their page is hidden", () => {
    const onSuggestionSelect = vi.fn();
    const suggestions = automateGroup().suggestions.map((suggestion) => ({
      ...suggestion,
      groupId: automateGroup().id,
    }));
    const container = render(
      <ChatEmptyStatePromptOptions
        suggestions={suggestions}
        optionsId="chat-empty-state-prompt-options"
        activeIndex={0}
        active={false}
        interactive={false}
        onActiveIndexChange={vi.fn()}
        onSuggestionSelect={onSuggestionSelect}
      />,
    );

    const listbox = container.querySelector<HTMLElement>("[role='listbox']");
    const firstOption = container.querySelector<HTMLButtonElement>("[role='option']");
    expect(listbox?.getAttribute("aria-hidden")).toBe("true");
    expect(listbox?.dataset.interactive).toBe("false");
    expect(firstOption?.disabled).toBe(true);

    act(() => {
      firstOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      firstOption?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
      firstOption?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    expect(onSuggestionSelect).not.toHaveBeenCalled();
  });

  it("emphasizes each prompt group's shared trigger", () => {
    const container = render(
      <ChatEmptyStatePromptOptions
        suggestions={EMPTY_STATE_PROMPT_GROUPS.flatMap((group) => (
          group.suggestions.map((suggestion) => ({ ...suggestion, groupId: group.id }))
        ))}
        optionsId="chat-empty-state-prompt-options"
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onSuggestionSelect={vi.fn()}
      />,
    );

    const options = Array.from(container.querySelectorAll<HTMLElement>("[role='option']"));
    expect(options).toHaveLength(16);
    expect(options.map((option) => option.querySelector("strong")?.textContent)).toEqual(
      EMPTY_STATE_PROMPT_GROUPS.flatMap((group) => Array(4).fill(group.trigger)),
    );
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
            latestUserMessagePreview: "Can this release workflow run from the desktop shell?",
            latestReplyPreview: "Assistant reply should stay hidden.",
          }),
        ]}
        visible
        conversationPath={(id) => `/chat/${id}`}
        onPrefetchConversation={vi.fn()}
      />,
    );

    const recentSection = container.querySelector<HTMLElement>("[data-testid='chat-empty-state-recent-project-conversations']");
    const row = recentSection?.querySelector<HTMLElement>("[data-testid='chat-empty-state-recent-conversation-chat-1']");
    const rowTitle = row?.querySelector<HTMLElement>(".font-medium");

    expect(rowTitle?.textContent).toBe("Can this release workflow run from the desktop shell?");
    expect(recentSection?.textContent).toContain("Assistant reply should stay hidden.");
  });

  it("keeps recent conversations open only while the empty-state composer is empty", () => {
    const visibleContainer = render(
      <ChatEmptyStateRecentConversations
        conversations={[chatConversation()]}
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

  it("loads more recent conversations when the scroll sentinel becomes visible", () => {
    const originalIntersectionObserver = globalThis.IntersectionObserver;
    const observe = vi.fn();
    const disconnect = vi.fn();
    let triggerIntersect: ((entries: IntersectionObserverEntry[]) => void) | null = null;

    class MockIntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "";
      readonly thresholds: ReadonlyArray<number> = [];

      constructor(callback: IntersectionObserverCallback) {
        triggerIntersect = (entries) => callback(entries, this as unknown as IntersectionObserver);
      }

      observe = observe;
      unobserve = vi.fn();
      disconnect = disconnect;
      takeRecords = () => [];
    }

    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: MockIntersectionObserver,
    });

    try {
      const onLoadMoreConversations = vi.fn();
      const container = render(
        <ChatEmptyStateRecentConversations
          conversations={[chatConversation()]}
          visible
          conversationPath={(id) => `/chat/${id}`}
          onPrefetchConversation={vi.fn()}
          hasMoreConversations
          onLoadMoreConversations={onLoadMoreConversations}
        />,
      );

      const loadMore = container.querySelector<HTMLElement>("[data-testid='chat-empty-state-recent-conversations-load-more']");
      expect(loadMore).toBeTruthy();
      expect(observe).toHaveBeenCalledWith(loadMore);

      act(() => {
        triggerIntersect?.([{ isIntersecting: true } as IntersectionObserverEntry]);
      });

      expect(onLoadMoreConversations).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, "IntersectionObserver", {
        configurable: true,
        writable: true,
        value: originalIntersectionObserver,
      });
    }
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
