// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatMessage, Issue, IssueComment } from "@rudderhq/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { issuesApi } from "@/api/issues";
import { ChatRichReferences, markdownPreview } from "./ChatRichReferences";

vi.mock("@/api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
    getComment: vi.fn(),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

function baseMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    orgId: "org-1",
    conversationId: "chat-1",
    role: "assistant",
    kind: "message",
    status: "completed",
    body: "Assistant reply.",
    structuredPayload: null,
    approvalId: null,
    approval: null,
    attachments: [],
    transcript: [],
    replyingAgentId: null,
    chatTurnId: null,
    turnVariant: 0,
    supersededAt: null,
    createdAt: new Date("2026-05-15T00:00:00.000Z"),
    updatedAt: new Date("2026-05-15T00:00:00.000Z"),
    ...overrides,
  };
}

function baseIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    orgId: "org-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Render issue card",
    description: "Show a rich issue reference in chat.",
    status: "in_progress",
    priority: "high",
    boardOrder: 0,
    assigneeAgentId: "agent-123456789",
    assigneeUserId: null,
    reviewerAgentId: null,
    reviewerUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 153,
    identifier: "ZST-153",
    requestDepth: 0,
    billingCode: null,
    assigneeAgentRuntimeOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-15T00:00:00.000Z"),
    updatedAt: new Date("2026-05-15T01:00:00.000Z"),
    ...overrides,
  };
}

function baseComment(overrides: Partial<IssueComment> = {}): IssueComment {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "org-1",
    issueId: "issue-1",
    authorAgentId: "agent-commenter",
    authorUserId: null,
    body: "Reviewer said **add tests** before approval.",
    createdAt: new Date("2026-05-15T01:00:00.000Z"),
    updatedAt: new Date("2026-05-15T01:00:00.000Z"),
    ...overrides,
  };
}

function renderHarness(message: ChatMessage) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ChatRichReferences message={message} />
      </QueryClientProvider>,
    );
  });

  cleanupFn = () => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  };

  return container;
}

async function flushQueries() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(predicate: () => boolean, debugElement?: Element) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error(`Timed out waiting for assertion state.\n${debugElement?.innerHTML ?? ""}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

beforeEach(() => {
  vi.mocked(issuesApi.get).mockReset();
  vi.mocked(issuesApi.getComment).mockReset();
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.replaceChildren();
});

describe("ChatRichReferences", () => {
  it("renders issue and issue comment cards for explicit card references", async () => {
    vi.mocked(issuesApi.get).mockResolvedValue(baseIssue());
    vi.mocked(issuesApi.getComment).mockResolvedValue(baseComment({
      body: "Reviewer said **add tests** and link [the issue](/issues/ZST-153).",
    }));

    const container = renderHarness(baseMessage({
      structuredPayload: {
        richReferences: [
          { type: "issue", identifier: "ZST-153", display: "card" },
          { type: "issue_comment", identifier: "ZST-153", commentId: "11111111-1111-4111-8111-111111111111", display: "card" },
          { type: "issue", identifier: "ZST-154", display: "inline" },
        ],
      },
    }));

    await flushQueries();
    await waitFor(() => container.querySelectorAll("a").length === 2, container);

    expect(container.querySelector('[data-testid="chat-rich-references"]')).toBeTruthy();
    const links = Array.from(container.querySelectorAll("a"));
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe("/issues/ZST-153");
    expect(links[0].getAttribute("aria-label")).toBe("Open issue ZST-153");
    expect(links[0].textContent).toContain("Render issue card");
    expect(links[0].textContent).toContain("High");

    expect(links[1].getAttribute("href")).toBe("/issues/ZST-153#comment-11111111-1111-4111-8111-111111111111");
    expect(links[1].getAttribute("aria-label")).toBe("Open comment on issue ZST-153");
    expect(links[1].textContent).toContain("Reviewer said add tests and link the issue.");
    expect(issuesApi.get).toHaveBeenCalledWith("ZST-153");
    expect(issuesApi.getComment).toHaveBeenCalledWith("ZST-153", "11111111-1111-4111-8111-111111111111");
  });

  it("renders an unavailable fallback for missing or inaccessible references", async () => {
    vi.mocked(issuesApi.get).mockRejectedValue(new ApiError("Forbidden", 403, { error: "Forbidden" }));

    const container = renderHarness(baseMessage({
      structuredPayload: {
        richReferences: [
          { type: "issue", identifier: "ZST-403", display: "card" },
        ],
      },
    }));

    await flushQueries();
    await waitFor(() => container.textContent?.includes("Permission denied") ?? false, container);

    expect(container.textContent).toContain("Permission denied");
    expect(container.textContent).toContain("You do not have access to this reference.");
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("markdownPreview", () => {
  it("returns plain text for markdown-heavy comment bodies", () => {
    expect(markdownPreview("![shot](asset.png) **Ready**: [open](/issues/ZST-153) `now`"))
      .toBe("Ready: open now");
    expect(markdownPreview("")).toBe("No comment body.");
  });
});
