// @vitest-environment jsdom

import type { Agent } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Link, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommentThread,
  commentIdFromIssueCommentHash,
  extractIssueRouteRefFromPathname,
  resolveCurrentIssueCommentLink,
  resolveInternalMarkdownRoute,
} from "./CommentThread";
import { isAgentWakeEligible, shouldConfirmUnmentionedComment } from "./CommentThread.submit";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockConfirm = vi.hoisted(() => vi.fn(async () => true));
const mockTranscriptState = vi.hoisted(() => ({
  transcriptByRun: new Map<string, unknown[]>(),
  hasOutputForRun: vi.fn(() => false),
}));
const mockUseLiveRunTranscripts = vi.hoisted(() => vi.fn());

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ confirm: mockConfirm }),
}));

vi.mock("./MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef(
      (
        {
          agentMentionIntent,
          mentions,
          onChange,
          placeholder,
          contentClassName,
          value,
        }: {
          agentMentionIntent?: string;
          contentClassName?: string;
          mentions?: Array<{ id: string }>;
          onChange?: (value: string) => void;
          placeholder?: string;
          value?: string;
        },
        ref,
      ) => {
        const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
        React.useImperativeHandle(ref, () => ({
          focus: () => textareaRef.current?.focus(),
          getMarkdown: () => textareaRef.current?.value ?? value ?? "",
        }));
        return (
          <textarea
            ref={textareaRef}
            aria-label={placeholder ?? "Markdown editor"}
            data-content-class-name={contentClassName ?? ""}
            data-agent-mention-intent={agentMentionIntent ?? ""}
            data-mention-option-count={mentions?.length ?? 0}
            onChange={(event) => onChange?.(event.currentTarget.value)}
            onInput={(event) => onChange?.(event.currentTarget.value)}
            value={value ?? ""}
          />
        );
      },
    ),
  };
});

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({
    children,
    agentMentions,
    skillReferences,
  }: {
    children: ReactNode;
    agentMentions?: Array<{ name?: string | null }>;
    skillReferences?: Array<{ displayName?: string | null }>;
  }) => (
    <div
      data-agent-mention-count={agentMentions?.length ?? 0}
      data-agent-mention-name={agentMentions?.[0]?.name ?? ""}
      data-skill-reference-count={skillReferences?.length ?? 0}
      data-skill-reference-name={skillReferences?.[0]?.displayName ?? ""}
    >
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, title, ...props }: { children: ReactNode; title?: string }) => (
    <button title={title} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({
    children,
    className,
    onSelect,
  }: {
    children: ReactNode;
    className?: string;
    onSelect?: (event: { preventDefault: () => void }) => void;
  }) => (
    <button
      className={className}
      role="menuitem"
      type="button"
      onClick={() => onSelect?.({ preventDefault: vi.fn() })}
    >
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <div role="separator" />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: (options: unknown) => {
    mockUseLiveRunTranscripts(options);
    return {
      transcriptByRun: mockTranscriptState.transcriptByRun,
      hasOutputForRun: mockTranscriptState.hasOutputForRun,
    };
  },
}));

vi.mock("./transcript/RunTranscriptView", () => ({
  RunTranscriptView: ({
    emptyMessage,
    entries,
    presentation,
    streaming,
  }: {
    emptyMessage?: string;
    entries?: unknown[];
    presentation?: string;
    streaming?: boolean;
  }) => (
    <div
      data-presentation={presentation ?? "default"}
      data-streaming={streaming ? "true" : "false"}
      data-transcript-entry-count={entries?.length ?? 0}
    >
      {emptyMessage ?? "Transcript details"}
    </div>
  ),
}));

describe("CommentThread", () => {
  let cleanupFn: (() => void) | null = null;

  it("extracts issue route refs from normal and messenger issue paths", () => {
    expect(extractIssueRouteRefFromPathname("/ZST/issues/ZST-573")).toBe("ZST-573");
    expect(extractIssueRouteRefFromPathname("/ZST/messenger/issues/ZST-573")).toBe("ZST-573");
    expect(extractIssueRouteRefFromPathname("/ZST/issues/issue%201")).toBe("issue 1");
    expect(extractIssueRouteRefFromPathname("/ZST/messenger/chat")).toBeNull();
  });

  it("resolves same-issue comment links for local scroll handling", () => {
    expect(commentIdFromIssueCommentHash("#comment-comment%20123")).toBe("comment 123");
    expect(resolveCurrentIssueCommentLink({
      href: "/ZST/issues/ZST-573#comment-comment-123",
      baseHref: "http://localhost:3100/ZST/messenger/issues/ZST-573",
      currentPathname: "/ZST/messenger/issues/ZST-573",
      currentIssueId: "issue-573",
      currentIssueRef: "ZST-573",
    })).toBe("comment-123");
    expect(resolveCurrentIssueCommentLink({
      href: "/ZST/issues/ZST-999#comment-comment-123",
      baseHref: "http://localhost:3100/ZST/issues/ZST-573",
      currentPathname: "/ZST/issues/ZST-573",
      currentIssueId: "issue-573",
      currentIssueRef: "ZST-573",
    })).toBeNull();
    expect(resolveCurrentIssueCommentLink({
      href: "https://example.com/ZST/issues/ZST-573#comment-comment-123",
      baseHref: "http://localhost:3100/ZST/issues/ZST-573",
      currentPathname: "/ZST/issues/ZST-573",
      currentIssueId: "issue-573",
      currentIssueRef: "ZST-573",
    })).toBeNull();
  });

  it("resolves same-origin markdown routes for SPA navigation", () => {
    expect(resolveInternalMarkdownRoute({
      href: "/ZST/messenger/chat/chat-123",
      baseHref: "http://localhost:3100/ZST/issues/ZST-617",
    })).toEqual({
      pathname: "/ZST/messenger/chat/chat-123",
      search: "",
      hash: "",
    });
    expect(resolveInternalMarkdownRoute({
      href: "http://localhost:3100/ZST/messenger/chat/chat-123?x=1#turn-2",
      baseHref: "http://localhost:3100/ZST/issues/ZST-617",
    })).toEqual({
      pathname: "/ZST/messenger/chat/chat-123",
      search: "?x=1",
      hash: "#turn-2",
    });
    expect(resolveInternalMarkdownRoute({
      href: "/api/assets/asset-1/content",
      baseHref: "http://localhost:3100/ZST/issues/ZST-617",
    })).toBeNull();
    expect(resolveInternalMarkdownRoute({
      href: "https://example.com/ZST/messenger/chat/chat-123",
      baseHref: "http://localhost:3100/ZST/issues/ZST-617",
    })).toBeNull();
  });

  it("centers hash-targeted comments inside the nearest scroll container", () => {
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

    HTMLElement.prototype.scrollTo = scrollTo;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if ((this as HTMLElement).dataset.testid === "issue-scroll-container") {
        return {
          x: 0,
          y: 100,
          top: 100,
          bottom: 500,
          left: 0,
          right: 800,
          width: 800,
          height: 400,
          toJSON: () => ({}),
        };
      }
      if ((this as HTMLElement).id === "comment-comment-2") {
        return {
          x: 0,
          y: 650,
          top: 650,
          bottom: 700,
          left: 0,
          right: 800,
          width: 800,
          height: 50,
          toJSON: () => ({}),
        };
      }
      return originalGetBoundingClientRect.call(this);
    };
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.testid === "issue-scroll-container" ? 1200 : 100;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.testid === "issue-scroll-container" ? 400 : 100;
      },
    });

    try {
      renderInteractive(
        <MemoryRouter initialEntries={["/issues/issue-1#comment-comment-2"]}>
          <div data-testid="issue-scroll-container" style={{ overflow: "auto" }}>
            <CommentThread
              comments={[
                {
                  id: "comment-1",
                  issueId: "issue-1",
                  orgId: "org-1",
                  authorUserId: "user-1",
                  authorAgentId: null,
                  body: "Earlier comment",
                  createdAt: new Date("2026-05-07T00:00:00.000Z"),
                  updatedAt: new Date("2026-05-07T00:00:00.000Z"),
                },
                {
                  id: "comment-2",
                  issueId: "issue-1",
                  orgId: "org-1",
                  authorUserId: "user-1",
                  authorAgentId: null,
                  body: "Target comment",
                  createdAt: new Date("2026-05-07T00:01:00.000Z"),
                  updatedAt: new Date("2026-05-07T00:01:00.000Z"),
                },
              ]}
              onAdd={async () => undefined}
            />
          </div>
        </MemoryRouter>,
      );

      expect(scrollTo).toHaveBeenCalledWith({
        top: 375,
        behavior: "auto",
      });
    } finally {
      HTMLElement.prototype.scrollTo = originalScrollTo;
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      }
    }
  });

  it("keeps the hash-scroll end spacer compact while comment hash positioning runs", () => {
    const container = renderInteractive(
      <MemoryRouter initialEntries={["/issues/issue-1#comment-comment-2"]}>
        <CommentThread
          comments={[
            {
              id: "comment-2",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Target comment",
              createdAt: new Date("2026-05-07T00:01:00.000Z"),
              updatedAt: new Date("2026-05-07T00:01:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );
    const spacer = container.querySelector("[data-testid='comment-hash-scroll-end-space']");

    expect(spacer).toBeTruthy();
    expect(spacer?.getAttribute("class")).toContain("h-[var(--comment-hash-scroll-end-space)]");
    expect(spacer?.getAttribute("style")).toContain("--comment-hash-scroll-end-space: min(6rem, 12vh)");
    expect(spacer?.getAttribute("class")).not.toContain("h-[min(18rem,35vh)]");
  });

  it("removes the hash-scroll end spacer after comment hash positioning settles", () => {
    vi.useFakeTimers();

    const container = renderInteractive(
      <MemoryRouter initialEntries={["/issues/issue-1#comment-comment-2"]}>
        <CommentThread
          comments={[
            {
              id: "comment-2",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Target comment",
              createdAt: new Date("2026-05-07T00:01:00.000Z"),
              updatedAt: new Date("2026-05-07T00:01:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(container.querySelector("[data-testid='comment-hash-scroll-end-space']")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1020);
    });

    expect(container.querySelector("[data-testid='comment-hash-scroll-end-space']")).toBeNull();
  });

  it("retries hash-targeted comment positioning after asynchronous layout shifts", () => {
    vi.useFakeTimers();
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

    HTMLElement.prototype.scrollTo = scrollTo;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if ((this as HTMLElement).dataset.testid === "issue-scroll-container") {
        return {
          x: 0,
          y: 100,
          top: 100,
          bottom: 500,
          left: 0,
          right: 800,
          width: 800,
          height: 400,
          toJSON: () => ({}),
        };
      }
      if ((this as HTMLElement).id === "comment-comment-2") {
        const targetTop = scrollTo.mock.calls.length === 0 ? 650 : 730;
        return {
          x: 0,
          y: targetTop,
          top: targetTop,
          bottom: targetTop + 50,
          left: 0,
          right: 800,
          width: 800,
          height: 50,
          toJSON: () => ({}),
        };
      }
      return originalGetBoundingClientRect.call(this);
    };
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.testid === "issue-scroll-container" ? 1200 : 100;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.testid === "issue-scroll-container" ? 400 : 100;
      },
    });

    try {
      renderInteractive(
        <MemoryRouter initialEntries={["/messenger/issues/issue-1#comment-comment-2"]}>
          <div data-testid="issue-scroll-container" style={{ overflow: "auto" }}>
            <CommentThread
              comments={[
                {
                  id: "comment-1",
                  issueId: "issue-1",
                  orgId: "org-1",
                  authorUserId: "user-1",
                  authorAgentId: null,
                  body: "Earlier comment",
                  createdAt: new Date("2026-05-07T00:00:00.000Z"),
                  updatedAt: new Date("2026-05-07T00:00:00.000Z"),
                },
                {
                  id: "comment-2",
                  issueId: "issue-1",
                  orgId: "org-1",
                  authorUserId: "user-1",
                  authorAgentId: null,
                  body: "Target comment",
                  createdAt: new Date("2026-05-07T00:01:00.000Z"),
                  updatedAt: new Date("2026-05-07T00:01:00.000Z"),
                },
              ]}
              onAdd={async () => undefined}
            />
          </div>
        </MemoryRouter>,
      );

      expect(scrollTo).toHaveBeenCalledWith({
        top: 375,
        behavior: "auto",
      });

      act(() => {
        vi.advanceTimersByTime(120);
      });

      expect(scrollTo).toHaveBeenLastCalledWith({
        top: 455,
        behavior: "auto",
      });
    } finally {
      HTMLElement.prototype.scrollTo = originalScrollTo;
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      }
    }
  });

  it("cancels hash-targeted comment retries after explicit user scroll input", () => {
    vi.useFakeTimers();
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

    HTMLElement.prototype.scrollTo = scrollTo;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if ((this as HTMLElement).dataset.testid === "issue-scroll-container") {
        return {
          x: 0,
          y: 100,
          top: 100,
          bottom: 500,
          left: 0,
          right: 800,
          width: 800,
          height: 400,
          toJSON: () => ({}),
        };
      }
      if ((this as HTMLElement).id === "comment-comment-2") {
        const targetTop = scrollTo.mock.calls.length === 0 ? 650 : 730;
        return {
          x: 0,
          y: targetTop,
          top: targetTop,
          bottom: targetTop + 50,
          left: 0,
          right: 800,
          width: 800,
          height: 50,
          toJSON: () => ({}),
        };
      }
      return originalGetBoundingClientRect.call(this);
    };
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.testid === "issue-scroll-container" ? 1200 : 100;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return (this as HTMLElement).dataset.testid === "issue-scroll-container" ? 400 : 100;
      },
    });

    try {
      const container = renderInteractive(
        <MemoryRouter initialEntries={["/messenger/issues/issue-1#comment-comment-2"]}>
          <div data-testid="issue-scroll-container" style={{ overflow: "auto" }}>
            <CommentThread
              comments={[
                {
                  id: "comment-1",
                  issueId: "issue-1",
                  orgId: "org-1",
                  authorUserId: "user-1",
                  authorAgentId: null,
                  body: "Earlier comment",
                  createdAt: new Date("2026-05-07T00:00:00.000Z"),
                  updatedAt: new Date("2026-05-07T00:00:00.000Z"),
                },
                {
                  id: "comment-2",
                  issueId: "issue-1",
                  orgId: "org-1",
                  authorUserId: "user-1",
                  authorAgentId: null,
                  body: "Target comment",
                  createdAt: new Date("2026-05-07T00:01:00.000Z"),
                  updatedAt: new Date("2026-05-07T00:01:00.000Z"),
                },
              ]}
              onAdd={async () => undefined}
            />
          </div>
        </MemoryRouter>,
      );

      expect(scrollTo).toHaveBeenCalledTimes(1);

      act(() => {
        container.querySelector("[data-testid='issue-scroll-container']")?.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
        vi.advanceTimersByTime(120);
      });

      expect(scrollTo).toHaveBeenCalledTimes(1);
    } finally {
      HTMLElement.prototype.scrollTo = originalScrollTo;
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      }
    }
  });

  it("reserves extra end space only for hash-targeted comments", () => {
    const comments = [
      {
        id: "comment-1",
        issueId: "issue-1",
        orgId: "org-1",
        authorUserId: "user-1",
        authorAgentId: null,
        body: "Target comment",
        createdAt: new Date("2026-05-07T00:00:00.000Z"),
        updatedAt: new Date("2026-05-07T00:00:00.000Z"),
      },
    ];

    let container = renderInteractive(
      <MemoryRouter initialEntries={["/messenger/issues/issue-1"]}>
        <CommentThread comments={comments} onAdd={async () => undefined} />
      </MemoryRouter>,
    );
    expect(container.querySelector("[data-testid='comment-hash-scroll-end-space']")).toBeNull();
    expect(container.querySelector("[role='region'][aria-label='Issue activity timeline']")).toBeNull();

    cleanupFn?.();
    cleanupFn = null;

    container = renderInteractive(
      <MemoryRouter initialEntries={["/messenger/issues/issue-1#comment-comment-1"]}>
        <CommentThread comments={comments} onAdd={async () => undefined} />
      </MemoryRouter>,
    );
    expect(container.querySelector("[data-testid='comment-hash-scroll-end-space']")).toBeTruthy();
  });

  it("progressively reveals a long Issue timeline while preserving its ends", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const comments = Array.from({ length: 80 }, (_, index) => ({
      id: `comment-${String(index).padStart(3, "0")}`,
      issueId: "issue-1",
      orgId: "org-1",
      authorUserId: "user-1",
      authorAgentId: null,
      body: `Timeline comment ${index}`,
      createdAt: new Date(1_720_000_000_000 + index * 1_000),
      updatedAt: new Date(1_720_000_000_000 + index * 1_000),
    }));
    const scrollRef = { current: null as HTMLElement | null };
    const container = renderInteractive(
      <MemoryRouter>
        <div
          ref={(element) => { scrollRef.current = element; }}
          style={{ height: 800, overflowY: "auto", width: 600 }}
        >
          <CommentThread
            comments={comments}
            onAdd={async () => undefined}
            timelineScrollElementRef={scrollRef}
            progressiveDisclosure={{ key: "issue-1", ready: true, failOpen: false }}
          />
        </div>
      </MemoryRouter>,
    );
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid='issue-timeline-disclosure']")).toBeTruthy();
    });
    expect(container.querySelector("[role='region'][aria-label='Issue activity timeline']")).toBeTruthy();
    expect(container.textContent).toContain("Timeline comment 0");
    expect(container.textContent).toContain("Timeline comment 79");
    const beforeLabel = container.querySelector("[data-testid='issue-timeline-disclosure']")?.textContent ?? "";
    const beforeCount = Number(beforeLabel.match(/(\d+) hidden/u)?.[1]);
    const loadMoreButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Load more") ?? null;
    expect(loadMoreButton?.className).toContain("h-8");
    expect(loadMoreButton?.className).toContain("cursor-pointer");
    expect(loadMoreButton?.className).toContain("!shadow-[var(--shadow-sm)]");
    expect(loadMoreButton?.className).toContain("hover:border-[color:var(--border-strong)]");
    expect(loadMoreButton?.className).toContain("hover:!bg-[color:var(--surface-active)]");
    expect(loadMoreButton?.querySelector("svg[aria-hidden='true']")).toBeTruthy();

    await click(loadMoreButton);

    const afterLabel = container.querySelector("[data-testid='issue-timeline-disclosure']")?.textContent ?? "";
    const afterCount = Number(afterLabel.match(/(\d+) hidden/u)?.[1]);
    expect(afterCount).toBeLessThan(beforeCount);
    expect(container.querySelectorAll("[data-testid='issue-timeline-disclosure']")).toHaveLength(1);
  });

  it("reveals a hidden hash target and fails open after an initial source error", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const comments = Array.from({ length: 80 }, (_, index) => ({
      id: `comment-${String(index).padStart(3, "0")}`,
      issueId: "issue-1",
      orgId: "org-1",
      authorUserId: "user-1",
      authorAgentId: null,
      body: `Hash timeline comment ${index}`,
      createdAt: new Date(1_720_000_000_000 + index * 1_000),
      updatedAt: new Date(1_720_000_000_000 + index * 1_000),
    }));
    const scrollRef = { current: null as HTMLElement | null };
    const container = renderInteractive(
      <MemoryRouter initialEntries={["/issues/issue-1#comment-comment-060"]}>
        <div
          ref={(element) => { scrollRef.current = element; }}
          style={{ height: 800, overflowY: "auto", width: 600 }}
        >
          <CommentThread
            comments={comments}
            onAdd={async () => undefined}
            timelineScrollElementRef={scrollRef}
            progressiveDisclosure={{ key: "issue-1", ready: true, failOpen: false }}
          />
        </div>
      </MemoryRouter>,
    );

    await vi.waitFor(() => {
      expect(container.querySelector("#comment-comment-060")).toBeTruthy();
    });

    cleanupFn?.();
    cleanupFn = null;
    const failOpen = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={comments}
          onAdd={async () => undefined}
          progressiveDisclosure={{ key: "issue-1", ready: false, failOpen: true }}
        />
      </MemoryRouter>,
    );
    expect(failOpen.querySelector("[data-testid='issue-timeline-disclosure']")).toBeNull();
    expect(failOpen.querySelector("#comment-comment-040")).toBeTruthy();
    expect(failOpen.querySelector("[role='region'][aria-label='Issue activity timeline']")).toBeTruthy();
  });

  it("scrolls to a revealed hash target when height disclosure does not require virtualization", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const comments = Array.from({ length: 40 }, (_, index) => ({
      id: `comment-${String(index).padStart(3, "0")}`,
      issueId: "issue-1",
      orgId: "org-1",
      authorUserId: "user-1",
      authorAgentId: null,
      body: `Long timeline comment ${index}\n${"x".repeat(12_000)}`,
      createdAt: new Date(1_720_000_000_000 + index * 1_000),
      updatedAt: new Date(1_720_000_000_000 + index * 1_000),
    }));
    const scrollRef = { current: null as HTMLElement | null };
    const container = renderInteractive(
      <MemoryRouter initialEntries={["/issues/issue-1"]}>
        <Link data-testid="hidden-comment-link" to="#comment-comment-020">Target comment</Link>
        <div
          ref={(element) => { scrollRef.current = element; }}
          style={{ height: 800, overflowY: "auto", width: 600 }}
        >
          <CommentThread
            comments={comments}
            onAdd={async () => undefined}
            timelineScrollElementRef={scrollRef}
            progressiveDisclosure={{ key: "issue-1", ready: true, failOpen: false }}
          />
        </div>
      </MemoryRouter>,
    );

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await vi.waitFor(() => {
      expect(container.querySelector("[data-testid='issue-timeline-disclosure']")).toBeTruthy();
      expect(container.querySelector("#comment-comment-020")).toBeNull();
    });
    expect(container.querySelector("[data-testid='comment-thread-virtual-timeline']")).toBeNull();

    scrollIntoView.mockClear();
    const hiddenCommentLink = container.querySelector("[data-testid='hidden-comment-link']");
    expect(hiddenCommentLink).toBeTruthy();
    await act(async () => {
      hiddenCommentLink!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(container.querySelector("#comment-comment-020")).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalled();
    expect(container.querySelector("[data-testid='issue-timeline-disclosure']")).toBeTruthy();
    expect(container.querySelector("[data-testid='comment-thread-virtual-timeline']")).toBeNull();
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });

  beforeEach(() => {
    mockConfirm.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanupFn?.();
    cleanupFn = null;
    document.body.innerHTML = "";
    mockTranscriptState.transcriptByRun = new Map();
    mockTranscriptState.hasOutputForRun.mockReset();
    mockTranscriptState.hasOutputForRun.mockReturnValue(false);
    mockUseLiveRunTranscripts.mockReset();
    mockConfirm.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function renderInteractive(element: ReactNode) {
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

  async function click(element: Element | null) {
    expect(element).toBeTruthy();
    await act(async () => {
      element!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
  }

  function change(element: Element | null, value: string) {
    expect(element).toBeTruthy();
    act(() => {
      const input = element as HTMLTextAreaElement;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("offers a general file attachment control for comments", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          onAdd={async () => undefined}
          imageUploadHandler={async () => "/api/attachments/attachment-1/content"}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("application/pdf");
    expect(html).toContain("text/csv");
    expect(html).toContain('title="Attach file"');
    expect(html).toContain("chat-composer");
    expect(html).toContain('data-agent-mention-intent="wake"');
    expect(html).not.toContain("Assignee");
  });

  it("detects only wake-intent agent mentions as directed comments", () => {
    const validAgentIds = new Set(["d573266f-af95-44e6-9303-e903a54662b8"]);
    expect(shouldConfirmUnmentionedComment("Ordinary comment", validAgentIds)).toBe(true);
    expect(shouldConfirmUnmentionedComment("@Dylan please review", validAgentIds)).toBe(true);
    expect(shouldConfirmUnmentionedComment("[Dylan](agent://d573266f-af95-44e6-9303-e903a54662b8) please review", validAgentIds)).toBe(true);
    expect(shouldConfirmUnmentionedComment("[Dylan](agent://d573266f-af95-44e6-9303-e903a54662b8?intent=wake) please review", validAgentIds)).toBe(false);
    expect(shouldConfirmUnmentionedComment("[Dylan](agent://agt_d573266f?intent=wake) please review", validAgentIds)).toBe(false);
    expect(shouldConfirmUnmentionedComment("[Other](agent://agt_aaaaaaaa?intent=wake) please review", validAgentIds)).toBe(true);
    expect(shouldConfirmUnmentionedComment(
      "[Ambiguous](agent://agt_d573266f?intent=wake) please review",
      new Set([...validAgentIds, "d573266f-1111-4111-8111-111111111111"]),
    )).toBe(true);
    expect(shouldConfirmUnmentionedComment("Ordinary reopen comment", validAgentIds, true)).toBe(false);
  });

  it("only treats invokable Agent statuses as eligible for reopen wakeups", () => {
    expect(isAgentWakeEligible("active")).toBe(true);
    expect(isAgentWakeEligible("idle")).toBe(true);
    expect(isAgentWakeEligible("running")).toBe(true);
    expect(isAgentWakeEligible("error")).toBe(true);
    expect(isAgentWakeEligible("paused")).toBe(false);
    expect(isAgentWakeEligible("terminated")).toBe(false);
    expect(isAgentWakeEligible("pending_approval")).toBe(false);
    expect(isAgentWakeEligible(undefined)).toBe(false);
  });

  it("keeps an unmentioned draft when the operator returns to add an Agent", async () => {
    mockConfirm.mockImplementation(async (options: { restoreFocus?: (confirmed: boolean) => void }) => {
      options.restoreFocus?.(false);
      return false;
    });
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread comments={[]} onAdd={onAdd} />
      </MemoryRouter>,
    );
    const editor = container.querySelector('textarea[aria-label="Leave a comment..."]');
    change(editor, "Please review this result");

    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Comment") ?? null);

    await vi.waitFor(() => expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "No Agent mentioned",
      description: "You did not @ any Agent. Send this comment anyway? Comments without an @ mention will not wake an Agent and may not be handled promptly.",
      cancelLabel: "Add an @ mention",
      confirmLabel: "Send anyway",
      restoreFocus: expect.any(Function),
    })));
    expect(onAdd).not.toHaveBeenCalled();
    expect((editor as HTMLTextAreaElement).value).toBe("Please review this result");
    await vi.waitFor(() => expect(document.activeElement).toBe(editor));
  });

  it("posts an unmentioned comment only after explicit confirmation", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread comments={[]} onAdd={onAdd} />
      </MemoryRouter>,
    );
    const editor = container.querySelector('textarea[aria-label="Leave a comment..."]');
    change(editor, "General project note");

    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Comment") ?? null);

    await vi.waitFor(() => expect(onAdd).toHaveBeenCalledWith("General project note", undefined));
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it("moves focus to the non-editable composer surface when an unmentioned comment is confirmed", async () => {
    mockConfirm.mockImplementation(async (options: { restoreFocus?: (confirmed: boolean) => void }) => {
      options.restoreFocus?.(true);
      return true;
    });
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread comments={[]} onAdd={onAdd} />
      </MemoryRouter>,
    );
    const editor = container.querySelector('textarea[aria-label="Leave a comment..."]') as HTMLTextAreaElement;
    const composerSurface = container.querySelector('[aria-label="Comment composer"]');
    change(editor, "General project note");

    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Comment") ?? null);

    await vi.waitFor(() => expect(onAdd).toHaveBeenCalledWith("General project note", undefined));
    expect(document.activeElement).toBe(composerSurface);
  });

  it("posts a directed Agent comment without confirmation", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          agentMap={new Map([["agent-1", { id: "agent-1" } as Agent]])}
          onAdd={onAdd}
        />
      </MemoryRouter>,
    );
    const editor = container.querySelector('textarea[aria-label="Leave a comment..."]');
    change(editor, "[Dylan](agent://agent-1?intent=wake) please review");

    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Comment") ?? null);

    await vi.waitFor(() => expect(onAdd).toHaveBeenCalledWith(
      "[Dylan](agent://agent-1?intent=wake) please review",
      undefined,
    ));
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("steers an active Issue Run without requiring an Agent mention", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread comments={[]} steerRunId="run-active" onAdd={onAdd} />
      </MemoryRouter>,
    );
    const editor = container.querySelector('textarea[aria-label="Leave a comment..."]');
    change(editor, "Use the compatibility-preserving approach");

    await click(container.querySelector("[data-testid='issue-comment-steer']"));

    await vi.waitFor(() => expect(onAdd).toHaveBeenCalledWith(
      "Use the compatibility-preserving approach",
      undefined,
      "steer",
    ));
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("skips confirmation for a reopen only when an Agent assignee will be woken", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          issueStatus="done"
          reopenWillWakeAgent
          onAdd={onAdd}
        />
      </MemoryRouter>,
    );
    const editor = container.querySelector('textarea[aria-label="Leave a comment..."]');
    change(editor, "Please continue the work");

    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Comment") ?? null);

    await vi.waitFor(() => expect(onAdd).toHaveBeenCalledWith("Please continue the work", true));
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("pins the fixed composer below an independently scrollable timeline", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          onAdd={async () => undefined}
          fixedComposer
        />
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="comment-thread-timeline-scroll"');
    expect(html).toContain("scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1");
    expect(html).toContain('data-testid="comment-thread-fixed-composer"');
    expect(html).toContain("sticky bottom-0 z-20");
    expect(html).not.toContain("bg-[color:var(--desktop-content-surface-light)]");
    expect(html).not.toContain("bg-[color:var(--desktop-content-surface-dark)]");
    expect(html).toContain("chat-composer");
    expect(html).not.toContain("xl:overflow-y-auto");
  });

  it("can keep the fixed composer in a single page scroll flow", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          onAdd={async () => undefined}
          fixedComposer
          fixedComposerTimelineScroll={false}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('data-testid="comment-thread-timeline-flow"');
    expect(html).toContain('data-testid="comment-thread-fixed-composer"');
    expect(html).toContain("sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20");
    expect(html).toContain("md:bottom-0");
    expect(html).toContain("pt-1");
    expect(html).not.toContain("-mb-4");
    expect(html).not.toContain("bg-[color:var(--desktop-content-surface-light)]");
    expect(html).not.toContain("bg-[color:var(--desktop-content-surface-dark)]");
    expect(html).toContain("chat-composer");
    expect(html).not.toContain('data-testid="comment-thread-timeline-scroll"');
    expect(html).not.toContain("flex-1 overflow-y-auto overscroll-contain");
  });

  it("attaches every selected comment file to the draft body", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const upload = vi.fn(async (file: File) => `/api/attachments/${file.name}/content`);
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          onAdd={onAdd}
          imageUploadHandler={upload}
        />
      </MemoryRouter>,
    );

    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    expect(input?.multiple).toBe(true);
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [first, second], configurable: true });

    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload).toHaveBeenNthCalledWith(1, first);
    expect(upload).toHaveBeenNthCalledWith(2, second);

    const editor = container.querySelector('textarea[aria-label="Leave a comment..."]') as HTMLTextAreaElement | null;
    await vi.waitFor(() => expect(editor?.value).toContain("![first.png](/api/attachments/first.png/content)"));
    expect(editor?.value).toContain("![second.png](/api/attachments/second.png/content)");

    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Comment") ?? null);
    await vi.waitFor(() => expect(onAdd).toHaveBeenCalledWith(
      [
        "![first.png](/api/attachments/first.png/content)",
        "",
        "![second.png](/api/attachments/second.png/content)",
      ].join("\n"),
      undefined,
    ));
  });

  it("persists and restores the comment draft across thread unmounts", () => {
    const draftKey = "rudder:test-issue-comment-draft";
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });

    let container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          draftKey={draftKey}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    change(container.querySelector('textarea[aria-label="Leave a comment..."]'), "Unsent issue comment");
    expect(storage.get(draftKey)).toBe("Unsent issue comment");

    cleanupFn?.();
    cleanupFn = null;
    expect(storage.get(draftKey)).toBe("Unsent issue comment");

    container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          draftKey={draftKey}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect((container.querySelector('textarea[aria-label="Leave a comment..."]') as HTMLTextAreaElement | null)?.value)
      .toBe("Unsent issue comment");
  });

  it("renders a stored comment draft on the initial pass", () => {
    const draftKey = "rudder:test-initial-issue-comment-draft";
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => key === draftKey ? "Initial issue draft" : null,
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          draftKey={draftKey}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("Initial issue draft");
  });

  it("passes skill mention metadata into rendered comments", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Use [build-advisor](/skills/build-advisor/SKILL.md).",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          mentions={[
            {
              id: "skill:build-advisor",
              name: "build-advisor",
              kind: "skill",
              skillRefLabel: "build-advisor",
              skillMarkdownTarget: "/skills/build-advisor/SKILL.md",
              skillDisplayName: "Build Advisor",
              skillDescription: "Professional diagnosis.",
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('data-skill-reference-count="1"');
    expect(html).toContain('data-skill-reference-name="Build Advisor"');
  });

  it("passes agent mention metadata into rendered comments", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "@Holden please review this.",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          mentions={[
            {
              id: "agent:agent-1",
              name: "Holden",
              kind: "agent",
              agentId: "agent-1",
              agentIcon: "code",
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('data-agent-mention-count="1"');
    expect(html).toContain('data-agent-mention-name="Holden"');
  });

  it("renders linked run transcripts with the chat-style runtime presentation", () => {
    mockTranscriptState.transcriptByRun = new Map([
      [
        "run-1",
        [
          {
            kind: "user",
            ts: "2026-06-17T08:00:01.000Z",
            text: "# Rudder Agent Operating Contract\n\nYour home directory is $AGENT_HOME.",
          },
          {
            kind: "tool_result",
            ts: "2026-06-17T08:00:02.000Z",
            toolUseId: "tool-1",
            content: "Tool response visible to the operator.",
            isError: false,
          },
          {
            kind: "assistant",
            ts: "2026-06-17T08:00:03.000Z",
            text: "I can use the enabled Rudder skills.",
          },
        ],
      ],
    ]);
    mockTranscriptState.hasOutputForRun.mockReturnValue(true);

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          linkedRuns={[
            {
              runId: "run-1",
              agentId: "agent-1",
              status: "running",
              createdAt: new Date("2026-06-17T08:00:00.000Z"),
              startedAt: new Date("2026-06-17T08:00:00.000Z"),
              invocationSource: "manual",
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('data-presentation="chat"');
    expect(html).toContain('data-transcript-entry-count="3"');
  });

  it("uses the operator nickname for board-authored comments", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Looks good.",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          operatorDisplayName="Zee"
        />
      </MemoryRouter>,
    );

    expect(html).toContain("Zee");
    expect(html).not.toContain("You");
  });

  it("falls back to You for board-authored comments without a nickname", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Looks good.",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          operatorDisplayName="   "
        />
      </MemoryRouter>,
    );

    expect(html).toContain("You");
  });

  it("hides deleted comments without exposing the original body or actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Sensitive deleted body",
              deletedAt: new Date("2026-05-07T00:10:00.000Z"),
              deletedByUserId: "user-1",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:10:00.000Z"),
            },
            {
              id: "comment-2",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Visible comment body",
              createdAt: new Date("2026-05-07T00:11:00.000Z"),
              updatedAt: new Date("2026-05-07T00:11:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          currentUserId="user-1"
          onUpdate={async () => undefined}
          onDelete={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain("Visible comment body");
    expect(html).not.toContain("Comment deleted");
    expect(html).not.toContain("Sensitive deleted body");
    expect(html).not.toContain('id="comment-comment-1"');
  });

  it("lets the current user edit and delete their own user-authored comment", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Original body",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          currentUserId="user-1"
          mentions={[{
            id: "agent:agent-1",
            name: "Holden (Reviewer)",
            kind: "agent",
            agentId: "agent-1",
          }]}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("Edit");
    expect(container.textContent).toContain("Delete");

    await click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit")) ?? null);
    const editEditor = container.querySelector('textarea[aria-label="Edit comment..."]');
    expect(editEditor?.getAttribute("data-agent-mention-intent")).toBe("wake");
    expect(editEditor?.getAttribute("data-mention-option-count")).toBe("1");
    change(editEditor, "Updated body");
    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Save") ?? null);
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith("comment-1", "Updated body"));

    await click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Delete")) ?? null);
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith("comment-1"));
    expect(mockConfirm).toHaveBeenCalledWith({
      title: "Delete this comment?",
      description: "The original text will no longer be visible.",
      confirmLabel: "Delete",
      tone: "destructive",
    });
  });

  it("collapses and expands comment bodies from the actions menu", async () => {
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Long comment body that should fold away.",
              runId: "run-1",
              runAgentId: "agent-1",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          currentUserId="user-1"
          onUpdate={async () => undefined}
        />
      </MemoryRouter>,
    );

    const commentBlock = container.querySelector("#comment-comment-1");
    expect(commentBlock?.textContent).toContain("Long comment body that should fold away.");
    expect(commentBlock?.textContent).toContain("run run-1");

    await click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Collapse comment")) ?? null);

    expect(commentBlock?.getAttribute("aria-label")).toBe("Collapsed comment");
    expect(commentBlock?.textContent).toContain("Long comment body that should fold away.");
    expect(commentBlock?.querySelector("[data-comment-body-collapsed]")?.className).toContain("grid-rows-[0fr]");
    expect(commentBlock?.querySelector('button[aria-label="Expand comment"]')).toBeTruthy();

    await click(commentBlock?.querySelector('button[aria-label="Expand comment"]') ?? null);

    expect(commentBlock?.getAttribute("aria-label")).toBeNull();
    expect(commentBlock?.querySelector("[data-comment-body-collapsed]")).toBeNull();
    expect(commentBlock?.textContent).toContain("Long comment body that should fold away.");
    expect(commentBlock?.textContent).toContain("run run-1");
  });

  it("keeps authored comments open and makes the mobile composer compact and bounded", async () => {
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "long-comment",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Long comment content. ".repeat(80),
              createdAt: new Date("2026-05-07T00:01:00.000Z"),
              updatedAt: new Date("2026-05-07T00:01:00.000Z"),
            },
            {
              id: "image-comment",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Visual evidence\n\n![screenshot](https://example.com/screenshot.png)",
              createdAt: new Date("2026-05-07T00:02:00.000Z"),
              updatedAt: new Date("2026-05-07T00:02:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          currentUserId="user-1"
        />
      </MemoryRouter>,
    );

    const longComment = container.querySelector("#comment-long-comment");
    const imageComment = container.querySelector("#comment-image-comment");
    const composerScroll = container.querySelector("[data-testid='issue-comment-composer-editor-scroll']");
    const composer = container.querySelector('[aria-label="Comment composer"]');
    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Leave a comment..."]');

    expect(longComment?.getAttribute("aria-label")).toBeNull();
    expect(imageComment?.getAttribute("aria-label")).toBeNull();
    expect(longComment?.textContent).toContain("Long comment content.");
    expect(imageComment?.textContent).toContain("Visual evidence");
    expect(composer?.getAttribute("data-composer-state")).toBe("empty");
    expect(composer?.className).toContain("grid-cols-[2.25rem_minmax(0,1fr)_auto]");
    expect(composerScroll?.className).toContain("h-[var(--comment-composer-editor-height)]");
    expect(composerScroll?.className).toContain("max-h-[min(24dvh,10rem)]");
    expect(composerScroll?.className).toContain("md:max-h-[min(38dvh,22rem)]");
    expect(composerScroll?.className).toContain("overflow-y-auto");
    expect(composerScroll?.className).toContain("overscroll-contain");
    expect(composerScroll?.className).toContain("motion-comment-composer-height");
    expect(composer?.textContent).toContain("Leave a comment...");
    expect(editor?.dataset.contentClassName).toContain("min-h-7");
    expect(editor?.dataset.contentClassName).toContain("md:min-h-16");

    await change(editor, "A comment that should expand the composer");
    expect(composer?.getAttribute("data-composer-state")).toBe("composing");
    expect(composer?.textContent).not.toContain("Leave a comment...");
  });

  it("keeps collapsed comment headers compact and uses a chevron expander", async () => {
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "A long folded comment.",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          currentUserId="user-1"
          onUpdate={async () => undefined}
          operatorDisplayName="Operator with a very long visible name that must not push controls outside"
        />
      </MemoryRouter>,
    );

    await click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Collapse comment")) ?? null);

    const commentBlock = container.querySelector("#comment-comment-1");
    const collapsedHeader = commentBlock?.querySelector("[data-comment-collapsed-header]");
    const collapsedSummary = collapsedHeader?.firstElementChild;
    const collapsedIdentity = collapsedSummary?.querySelector(".inline-flex");
    const collapsedPreview = collapsedSummary?.querySelector(".line-clamp-2");
    const expandButton = commentBlock?.querySelector('button[aria-label="Expand comment"]');

    expect(collapsedHeader?.className).toContain("grid-cols-[minmax(0,1fr)_auto_auto]");
    expect(collapsedSummary?.className).toContain("py-1");
    expect(collapsedSummary?.className).not.toContain("h-7");
    expect(collapsedSummary?.className).not.toContain("flex");
    expect(collapsedIdentity?.className).toContain("max-w-full");
    expect(collapsedIdentity?.className).toContain("overflow-hidden");
    expect(collapsedPreview?.className).toContain("mt-1");
    expect(collapsedPreview?.className).toContain("block");
    expect(commentBlock?.textContent).toContain("A long folded comment.");
    expect(expandButton?.className).toContain("rounded-full");
    expect(expandButton?.innerHTML).toContain("lucide-chevron-down");
    expect(expandButton?.innerHTML).not.toContain("lucide-square-terminal");
  });

  it("renders comment editing as a full composer surface with attachment upload", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    const upload = vi.fn().mockResolvedValue("/api/attachments/attachment-1/content");
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Original body",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          currentUserId="user-1"
          onUpdate={onUpdate}
          imageUploadHandler={upload}
        />
      </MemoryRouter>,
    );

    await click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit")) ?? null);

    const editSurface = container.querySelector("#comment-comment-1");
    expect(editSurface?.className).toContain("rounded-[var(--radius-lg)]");
    expect(container.querySelector('button[title="Attach file"]')).toBeTruthy();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    const file = new File(["image"], "diagram.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });

    await act(async () => {
      input!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(upload).toHaveBeenCalledWith(file));
    const editor = container.querySelector('textarea[aria-label="Edit comment..."]') as HTMLTextAreaElement | null;
    await vi.waitFor(() => expect(editor?.value).toContain("![diagram.png](/api/attachments/attachment-1/content)"));

    await click([...container.querySelectorAll("button")].find((button) => button.textContent === "Save") ?? null);
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledWith(
      "comment-1",
      "Original body\n\n![diagram.png](/api/attachments/attachment-1/content)",
    ));
  });

  it("does not show edit attachments without an upload handler", async () => {
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Original body",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          currentUserId="user-1"
          onUpdate={async () => undefined}
        />
      </MemoryRouter>,
    );

    await click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit")) ?? null);

    expect(container.querySelector('button[title="Attach file"]')).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("allows deleting agent-authored comments without exposing edit", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-agent",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: null,
              authorAgentId: "agent-1",
              body: "Agent body",
              createdAt: new Date("2026-05-07T00:01:00.000Z"),
              updatedAt: new Date("2026-05-07T00:01:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          currentUserId="user-1"
          onUpdate={async () => undefined}
          onDelete={onDelete}
        />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("Copy content");
    expect(container.textContent).not.toContain("Edit");
    expect(container.textContent).toContain("Delete");

    await click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Delete")) ?? null);
    await vi.waitFor(() => expect(onDelete).toHaveBeenCalledWith("comment-agent"));
  });

  it("hides edit and delete actions for other users' comments", () => {
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-other-user",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-2",
              authorAgentId: null,
              body: "Other user body",
              createdAt: new Date("2026-05-07T00:00:00.000Z"),
              updatedAt: new Date("2026-05-07T00:00:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
          currentUserId="user-1"
          onUpdate={async () => undefined}
          onDelete={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("Copy content");
    expect(container.textContent).not.toContain("Edit");
    expect(container.textContent).not.toContain("Delete");
  });

  it("mixes activity items and comments in chronological order", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Middle comment.",
              createdAt: new Date("2026-05-07T00:02:00.000Z"),
              updatedAt: new Date("2026-05-07T00:02:00.000Z"),
            },
          ]}
          activityItems={[
            {
              id: "activity-1",
              createdAt: new Date("2026-05-07T00:01:00.000Z"),
              node: <div>First activity</div>,
            },
            {
              id: "activity-2",
              createdAt: new Date("2026-05-07T00:03:00.000Z"),
              node: <div>Last activity</div>,
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html.indexOf("First activity")).toBeLessThan(html.indexOf("Middle comment."));
    expect(html.indexOf("Middle comment.")).toBeLessThan(html.indexOf("Last activity"));
  });

  it("presents linked run transcript rows as collapsible agent runs", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          linkedRuns={[
            {
              runId: "55555555-5555-4555-8555-555555555555",
              status: "completed",
              agentId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-07T00:02:00.000Z"),
              startedAt: new Date("2026-05-07T00:02:00.000Z"),
              finishedAt: new Date("2026-05-07T00:34:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).not.toContain("Not an issue comment");
    expect(html).toContain('aria-label="Agent run"');
    expect(html).toContain('data-run-id="55555555-5555-4555-8555-555555555555"');
    expect(html).toContain("Ran for 32m");
    expect(html).not.toContain(">Run</span>");
    expect(html).toContain('aria-label="Show details"');
    expect(html).toContain('data-size="sm"');
    expect(html).not.toContain("No run output captured.");
  });

  it("shows recent activity timestamps as relative labels while preserving exact titles", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-07T01:12:00.000Z"));

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[
            {
              id: "comment-1",
              issueId: "issue-1",
              orgId: "org-1",
              authorUserId: "user-1",
              authorAgentId: null,
              body: "Fresh update.",
              createdAt: new Date("2026-05-07T00:36:00.000Z"),
              updatedAt: new Date("2026-05-07T00:36:00.000Z"),
            },
          ]}
          linkedRuns={[
            {
              runId: "55555555-5555-4555-8555-555555555555",
              status: "succeeded",
              agentId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-07T00:12:00.000Z"),
              startedAt: new Date("2026-05-07T00:12:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain(">36m ago</time>");
    expect(html).toContain(">1h ago</time>");
    expect(html).toMatch(/title="May 7, 2026, \d{2}:36"/);
    expect(html).toMatch(/title="May 7, 2026, \d{2}:12"/);
    expect(html).not.toContain(">May 7, 2026, 00:36</a>");
    expect(html).not.toContain(">May 7, 2026, 00:12</time>");
  });

  it("collapses inactive linked run details by default", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          linkedRuns={[
            {
              runId: "55555555-5555-4555-8555-555555555555",
              status: "failed",
              agentId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-07T00:02:00.000Z"),
              startedAt: new Date("2026-05-07T00:02:00.000Z"),
            },
            {
              runId: "66666666-6666-4666-8666-666666666666",
              status: "succeeded",
              agentId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-07T00:03:00.000Z"),
              startedAt: new Date("2026-05-07T00:03:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Agent run"');
    expect(html).toContain("succeeded");
    expect(html).toContain('aria-label="Show details"');
    expect(html).not.toContain("No run output captured.");
    expect(html).not.toContain('data-streaming="false"');
  });

  it("hydrates terminal run logs only after that run is expanded", async () => {
    const terminalRunId = "55555555-5555-4555-8555-555555555555";
    const activeRunId = "66666666-6666-4666-8666-666666666666";
    const container = renderInteractive(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          linkedRuns={[
            {
              runId: terminalRunId,
              status: "succeeded",
              agentId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-07T00:02:00.000Z"),
              startedAt: new Date("2026-05-07T00:02:00.000Z"),
              resultJson: { summary: "Persisted terminal summary" },
            },
            {
              runId: activeRunId,
              status: "running",
              agentId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-07T00:03:00.000Z"),
              startedAt: new Date("2026-05-07T00:03:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(mockUseLiveRunTranscripts.mock.calls.at(-1)?.[0]).toMatchObject({
      runs: [{ id: activeRunId }],
    });

    const terminalRow = container.querySelector(`[data-run-id="${terminalRunId}"]`);
    const expandButton = terminalRow?.querySelector<HTMLButtonElement>('button[aria-label="Show details"]');
    expect(expandButton).toBeTruthy();
    await act(async () => {
      expandButton!.click();
    });

    expect(mockUseLiveRunTranscripts.mock.calls.at(-1)?.[0]).toMatchObject({
      runs: [
        { id: terminalRunId, resultJson: { summary: "Persisted terminal summary" } },
        { id: activeRunId },
      ],
    });
  });

  it("renders active linked run details in streaming mode", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CommentThread
          comments={[]}
          linkedRuns={[
            {
              runId: "55555555-5555-4555-8555-555555555555",
              status: "running",
              agentId: "22222222-2222-4222-8222-222222222222",
              createdAt: new Date("2026-05-07T00:02:00.000Z"),
              startedAt: new Date("2026-05-07T00:02:00.000Z"),
            },
          ]}
          onAdd={async () => undefined}
        />
      </MemoryRouter>,
    );

    expect(html).toContain('aria-label="Agent run"');
    expect(html).toContain('aria-label="Hide details"');
    expect(html).toContain("Run running. Waiting for output...");
    expect(html).toContain('data-streaming="true"');
  });
});
