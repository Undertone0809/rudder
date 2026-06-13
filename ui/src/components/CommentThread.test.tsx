// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CommentThread,
  commentIdFromIssueCommentHash,
  extractIssueRouteRefFromPathname,
  resolveCurrentIssueCommentLink,
} from "./CommentThread";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockConfirm = vi.hoisted(() => vi.fn(async () => true));

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
          onChange,
          placeholder,
          value,
        }: {
          agentMentionIntent?: string;
          onChange?: (value: string) => void;
          placeholder?: string;
          value?: string;
        },
        ref,
      ) => {
        const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
        React.useImperativeHandle(ref, () => ({
          getMarkdown: () => textareaRef.current?.value ?? value ?? "",
        }));
        return (
          <textarea
            ref={textareaRef}
            aria-label={placeholder ?? "Markdown editor"}
            data-agent-mention-intent={agentMentionIntent ?? ""}
            onChange={(event) => onChange?.(event.currentTarget.value)}
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

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
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
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

vi.mock("./transcript/RunTranscriptView", () => ({
  RunTranscriptView: ({
    emptyMessage,
    streaming,
  }: {
    emptyMessage?: string;
    streaming?: boolean;
  }) => <div data-streaming={streaming ? "true" : "false"}>{emptyMessage ?? "Transcript details"}</div>,
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

  beforeEach(() => {
    mockConfirm.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanupFn?.();
    cleanupFn = null;
    document.body.innerHTML = "";
    mockConfirm.mockReset();
    vi.restoreAllMocks();
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
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("Edit");
    expect(container.textContent).toContain("Delete");

    await click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit")) ?? null);
    change(container.querySelector('textarea[aria-label="Edit comment..."]'), "Updated body");
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

  it("hides edit and delete actions for other users and agent-authored comments", () => {
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
