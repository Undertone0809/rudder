// @vitest-environment jsdom

import type { TranscriptEntry } from "@/agent-runtimes";
import { ThemeProvider } from "@/context/ThemeContext";
import { buildAgentMentionHref, type ChatMessage } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageItem, LazyStreamTranscriptItem, StreamTranscriptItem } from "./Chat.messages";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/messenger/chat/chat-1", search: "", hash: "", key: "chat" }),
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

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-1",
    orgId: "org-1",
    conversationId: "chat-1",
    role: "assistant",
    kind: "message",
    status: "failed",
    body: "The assistant response failed.",
    structuredPayload: null,
    approvalId: null,
    approval: null,
    attachments: [],
    transcript: [],
    replyingAgentId: null,
    chatTurnId: "turn-1",
    turnVariant: 0,
    supersededAt: null,
    createdAt: new Date("2026-06-15T10:00:00.000Z"),
    updatedAt: new Date("2026-06-15T10:00:00.000Z"),
    ...overrides,
  };
}

function renderChatMessageItem(messageToRender: ChatMessage) {
  return render(
    <ThemeProvider>
      <ChatMessageItem
        conversation={{
          id: "chat-1",
          orgId: "org-1",
          status: "active",
          title: "Plain text chat",
          summary: null,
          preferredAgentId: null,
          routedAgentId: null,
          primaryIssueId: null,
          primaryIssue: null,
          issueCreationMode: "manual_approval",
          planMode: false,
          createdByUserId: null,
          lastMessageAt: null,
          resolvedAt: null,
          createdAt: new Date("2026-06-15T10:00:00.000Z"),
          updatedAt: new Date("2026-06-15T10:00:00.000Z"),
          latestReplyPreview: null,
          latestUserMessagePreview: null,
          userMessageCount: 0,
          contextLinks: [],
          lastReadAt: null,
          isPinned: false,
          unreadCount: 0,
          isUnread: false,
          needsAttention: false,
          chatRuntime: {
            sourceType: "unconfigured",
            sourceLabel: "No chat runtime",
            runtimeAgentId: null,
            agentRuntimeType: null,
            model: null,
            available: false,
            error: null,
          },
        }}
        message={messageToRender}
        agents={[]}
        decisionNote=""
        onDecisionNoteChange={vi.fn()}
        decisionNoteMentions={[]}
        onDecisionNoteMentionQueryChange={vi.fn()}
        onDecisionNoteInlineTokenClick={vi.fn()}
        onApprovalAction={vi.fn()}
        onResolveOperationProposal={vi.fn()}
        onConvertToIssue={vi.fn()}
        actionPending={false}
        onCopyMessageText={vi.fn()}
        onEditUserMessage={vi.fn()}
        onContinueInterruptedMessage={vi.fn()}
        onRetryFailedMessage={vi.fn()}
        onOpenImage={vi.fn()}
        onOpenFile={vi.fn()}
        skillReferences={[]}
      />
    </ThemeProvider>,
  );
}

describe("LazyStreamTranscriptItem", () => {
  it("shows process duration without exposing raw event counts", () => {
    const summary: NonNullable<ChatMessage["transcriptSummary"]> = {
      entryCount: 19,
      startedAt: "2026-06-09T08:00:00.000Z",
      endedAt: "2026-06-09T08:00:08.000Z",
    };

    const container = render(
      <LazyStreamTranscriptItem
        summary={summary}
        state="completed"
        onLoad={vi.fn()}
      />,
    );

    expect(container.textContent).toContain("Worked for 8s");
    expect(container.textContent).not.toContain("Run 609695f1");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toContain("19 events");
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("user chat message rendering", () => {
  it("keeps user-authored markdown syntax literal while preserving links and Rudder references", () => {
    window.history.pushState({}, "", "/MARAAA/messenger/chat/chat-1");

    const container = renderChatMessageItem(message({
      role: "user",
      kind: "message",
      status: "completed",
      body: `**bold** # heading [plain](https://example.com) http://example.com\nAsk [Wesley](${buildAgentMentionHref("agent-1", "code")}) to review.`,
    }));
    const bubble = container.querySelector('[data-testid="chat-user-message-bubble"]');

    expect(bubble?.textContent).toContain("**bold** # heading plain http://example.com");
    expect(bubble?.querySelectorAll("strong")).toHaveLength(0);
    expect(bubble?.querySelectorAll("h1,h2,h3,h4,h5,h6")).toHaveLength(0);
    expect(bubble?.querySelectorAll(".rudder-markdown, [data-testid='chat-long-message-body']")).toHaveLength(0);
    expect(bubble?.querySelectorAll('a[href="https://example.com"]')).toHaveLength(1);
    expect(bubble?.querySelectorAll('a[href="http://example.com"]')).toHaveLength(1);
    expect(bubble?.querySelector('[data-mention-kind="agent"]')?.textContent).toBe("Wesley");
    expect(bubble?.querySelector('[data-mention-kind="agent"]')?.getAttribute("href")).toBe("/MARAAA/agents/agent-1");
  });

  it("keeps unsafe schemes literal while preserving organization routing for internal links", () => {
    window.history.pushState({}, "", "/MARAAA/messenger/chat/chat-1");

    const container = renderChatMessageItem(message({
      role: "user",
      kind: "message",
      status: "completed",
      body: "[unsafe](javascript:alert(1)) [issue](/issues/ZST-1) [docs](/docs/install)",
    }));
    const bubble = container.querySelector('[data-testid="chat-user-message-bubble"]');

    expect(bubble?.textContent).toContain("[unsafe](javascript:alert(1))");
    expect(bubble?.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(bubble?.querySelector('a[href="/MARAAA/issues/ZST-1"]')?.textContent).toBe("issue");
    expect(bubble?.querySelector('a[href="/docs/install"]')?.textContent).toBe("docs");
  });
});

describe("failed chat transcript rendering", () => {
  it("keeps failed process details and the failed assistant message visibly marked", () => {
    const entries: TranscriptEntry[] = [
      {
        kind: "assistant",
        ts: "2026-06-15T10:00:00.000Z",
        text: "I will inspect the current state.",
      },
      {
        kind: "result",
        ts: "2026-06-15T10:00:04.000Z",
        text: "Chat assistant reply failed.",
        inputTokens: 10,
        outputTokens: 5,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "failed",
        isError: true,
        errors: ["Chat assistant reply failed."],
      },
    ];

    const failedMessage = message({});
    const container = render(
      <ThemeProvider>
        <StreamTranscriptItem
          entries={entries}
          state="failed"
          streamStartedAt={new Date("2026-06-15T10:00:00.000Z")}
          streamEndedAt={new Date("2026-06-15T10:00:04.000Z")}
          assistantMessageBody={failedMessage.body}
          defaultOpen
        />
        <ChatMessageItem
          conversation={{
            id: "chat-1",
            orgId: "org-1",
            status: "active",
            title: "Failed chat",
            summary: null,
            preferredAgentId: null,
            routedAgentId: null,
            primaryIssueId: null,
            primaryIssue: null,
            issueCreationMode: "manual_approval",
            planMode: false,
            createdByUserId: null,
            lastMessageAt: null,
            resolvedAt: null,
            createdAt: new Date("2026-06-15T10:00:00.000Z"),
            updatedAt: new Date("2026-06-15T10:00:00.000Z"),
            latestReplyPreview: null,
            latestUserMessagePreview: null,
            userMessageCount: 0,
            contextLinks: [],
            lastReadAt: null,
            isPinned: false,
            unreadCount: 0,
            isUnread: false,
            needsAttention: false,
            chatRuntime: {
              sourceType: "unconfigured",
              sourceLabel: "No chat runtime",
              runtimeAgentId: null,
              agentRuntimeType: null,
              model: null,
              available: false,
              error: null,
            },
          }}
          message={failedMessage}
          agents={[]}
          decisionNote=""
          onDecisionNoteChange={vi.fn()}
          decisionNoteMentions={[]}
          onDecisionNoteMentionQueryChange={vi.fn()}
          onDecisionNoteInlineTokenClick={vi.fn()}
          onApprovalAction={vi.fn()}
          onResolveOperationProposal={vi.fn()}
          onConvertToIssue={vi.fn()}
          actionPending={false}
          onCopyMessageText={vi.fn()}
          onEditUserMessage={vi.fn()}
          onContinueInterruptedMessage={vi.fn()}
          onRetryFailedMessage={vi.fn()}
          onOpenImage={vi.fn()}
          onOpenFile={vi.fn()}
          skillReferences={[]}
        />
      </ThemeProvider>,
    );

    expect(container.textContent).toContain("Worked for 4s");
    expect(container.textContent).not.toContain("Run 609695f1");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("Stopped with errors");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Response failed");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("This assistant response failed before it completed.");
    expect(container.querySelector('[role="alert"]')?.textContent).not.toContain("Retry");
    expect(container.textContent).toContain("Retry");
  });
});
