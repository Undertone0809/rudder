// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import {
  ChatLongMessageBody,
  ChatEmptyStatePromptOptions,
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

describe("ChatLongMessageBody", () => {
  it("hides overflowing message text until expanded", () => {
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

      expect(body?.style.maxHeight).toBe("392px");
      expect(body?.className).toContain("overflow-hidden");
      expect(toggle?.textContent).toContain("Show more");
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");

      act(() => {
        toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(body?.style.maxHeight).toBe("");
      expect(body?.className).not.toContain("overflow-hidden");
      expect(toggle?.textContent).toContain("Show less");
      expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    } finally {
      if (scrollHeight) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeight);
      }
    }
  });
});
