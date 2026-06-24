// @vitest-environment jsdom

import type { TranscriptEntry } from "@/agent-runtimes";
import { __clearWebsiteMetadataIconCacheForTests } from "@/components/MarkdownBody";
import type { MentionOption } from "@/components/MarkdownEditor";
import { ThemeProvider } from "@/context/ThemeContext";
import { buildAgentMentionHref, buildAutomationMentionHref, buildIssueMentionHref, type ChatMessage } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessageItem, ChatMessagesLoadingState, LazyStreamTranscriptItem, StreamTranscriptItem } from "./Chat.messages";

const markdownMentionsMock = vi.hoisted(() => ({
  mentions: [] as MentionOption[],
}));

const websiteMetadataApiMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/context/MarkdownMentionsContext", () => ({
  useMarkdownMentions: () => ({
    mentions: markdownMentionsMock.mentions,
    onMentionQueryChange: () => undefined,
  }),
}));

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

vi.mock("@/api/websiteMetadata", () => ({
  websiteMetadataApi: websiteMetadataApiMock,
}));

vi.mock("../api/websiteMetadata", () => ({
  websiteMetadataApi: websiteMetadataApiMock,
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
  markdownMentionsMock.mentions = [];
  __clearWebsiteMetadataIconCacheForTests();
  websiteMetadataApiMock.get.mockReset();
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
  const onForkMessage = vi.fn();
  return render(
    <ThemeProvider>
      <ChatMessageItem
        conversation={{
          id: "chat-1",
          orgId: "org-1",
          status: "active",
          mutability: "native_chat",
          title: "Plain text chat",
          summary: null,
          preferredAgentId: null,
          routedAgentId: null,
          primaryIssueId: null,
          forkedFromConversationId: null,
          forkedFromMessageId: null,
          forkRootConversationId: null,
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
        onForkMessage={onForkMessage}
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

describe("ChatMessagesLoadingState", () => {
  it("uses message skeletons for the chat loading state", () => {
    const container = render(<ChatMessagesLoadingState />);

    expect(container.querySelector("[role='status']")?.getAttribute("aria-label")).toBe("Chat messages loading");
    expect(container.querySelectorAll("[data-slot='skeleton']")).toHaveLength(5);
    expect(container.querySelector(".chat-message-user")).not.toBeNull();
  });
});

describe("user chat message rendering", () => {
  it("does not expose a fork action on user messages", () => {
    const container = renderChatMessageItem(message({
      role: "user",
      kind: "message",
      status: "completed",
      body: "Try this angle",
    }));

    expect(container.querySelector('button[aria-label="Fork from here"]')).toBeNull();
  });

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

  it("renders X status URLs with fetched website icons before following CJK text in user messages", async () => {
    const url = "https://x.com/my_knn_totoro/status/2068910037238772102";
    websiteMetadataApiMock.get.mockResolvedValue({
      url,
      siteName: "X",
      iconUrl: "https://x.com/favicon.ico",
    });
    const container = renderChatMessageItem(message({
      role: "user",
      kind: "message",
      status: "completed",
      body: `${url} 你觉得这个我怎么回复比较好?`,
    }));
    const bubble = container.querySelector('[data-testid="chat-user-message-bubble"]');
    const link = bubble?.querySelector("a");

    expect(link?.getAttribute("href")).toBe(url);
    expect(link?.textContent).toBe(url);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.classList.contains("rudder-website-link")).toBe(true);
    expect(link?.querySelector("[data-website-icon='generic']")).toBeTruthy();
    await act(async () => {
      await vi.waitFor(() => {
        expect(websiteMetadataApiMock.get).toHaveBeenCalledWith(url);
      });
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(link?.querySelector("img.rudder-website-link-logo")?.getAttribute("src")).toBe("https://x.com/favicon.ico");
      });
    });
    expect(link?.querySelector("img.rudder-website-link-logo")?.getAttribute("data-website-icon")).toBe("metadata");
    expect(bubble?.textContent).toContain("你觉得这个我怎么回复比较好?");
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

  it("marks issue comment mentions with the same semantic attributes as rendered markdown", () => {
    window.history.pushState({}, "", "/MARAAA/messenger/chat/chat-1");
    markdownMentionsMock.mentions = [{
      id: "issue:issue-1",
      name: "RUD-8 Markdown consistency",
      kind: "issue",
      issueId: "issue-1",
      issueIdentifier: "RUD-8",
      issueStatus: "backlog",
    }];

    const container = renderChatMessageItem(message({
      role: "user",
      kind: "message",
      status: "completed",
      body: `Check [Issue comment c7fe865f](${buildIssueMentionHref("issue-1", "RUD-8", "comment-1", "backlog")})`,
    }));
    const bubble = container.querySelector('[data-testid="chat-user-message-bubble"]');
    const mention = bubble?.querySelector('[data-mention-kind="issue"]');

    expect(mention?.textContent).toBe("RUD-8 Markdown consistency");
    expect(mention?.getAttribute("href")).toBe("/MARAAA/issues/issue-1#comment-comment-1");
    expect(mention?.getAttribute("data-mention-comment")).toBe("true");
    expect(mention?.getAttribute("data-mention-status")).toBe("backlog");
    expect(mention?.classList.contains("rudder-mention-chip--with-status-icon")).toBe(true);
  });

  it("keeps ordinary issue mentions lightweight even when status metadata is available", () => {
    window.history.pushState({}, "", "/MARAAA/messenger/chat/chat-1");
    markdownMentionsMock.mentions = [{
      id: "issue:issue-1",
      name: "RUD-8 Markdown consistency",
      kind: "issue",
      issueId: "issue-1",
      issueIdentifier: "RUD-8",
      issueStatus: "done",
    }];

    const container = renderChatMessageItem(message({
      role: "user",
      kind: "message",
      status: "completed",
      body: `Check [RUD-8 Markdown consistency](${buildIssueMentionHref("issue-1", "RUD-8", null, "done")})`,
    }));
    const mention = container.querySelector('[data-mention-kind="issue"]');

    expect(mention?.getAttribute("data-mention-status")).toBe("done");
    expect(mention?.classList.contains("rudder-mention-chip--with-status-icon")).toBe(false);
  });

  it("renders automation-style assistant issue links as issue chips", () => {
    window.history.pushState({}, "", "/MARAAA/messenger/issues/MARAAA-752");
    markdownMentionsMock.mentions = [{
      id: "issue:1664b23e-1111-4111-8111-111111111111",
      name: "MARAAA-747 Rudder SEO / GSC Daily Check",
      kind: "issue",
      issueId: "1664b23e-1111-4111-8111-111111111111",
      issueIdentifier: "MARAAA-747",
      issueStatus: "done",
    }];

    const container = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "- 完成 [1664b23e](/issues/1664b23e): 2026-06-21 Rudder SEO / GSC Daily Check。",
    }));
    const mention = container.querySelector('[data-mention-kind="issue"]');

    expect(mention?.textContent).toBe("MARAAA-747 Rudder SEO / GSC Daily Check");
    expect(mention?.getAttribute("href")).toBe("/MARAAA/issues/1664b23e");
    expect(mention?.classList.contains("rudder-mention-chip")).toBe(true);
  });

  it("renders automation mentions in assistant messages with automation titles", () => {
    markdownMentionsMock.mentions = [{
      id: "automation:0d232c68-1111-4111-8111-111111111111",
      name: "每日 Rudder 产品与搜索数据分析报告",
      kind: "automation",
      automationId: "0d232c68-1111-4111-8111-111111111111",
      automationTitle: "每日 Rudder 产品与搜索数据分析报告",
      automationStatus: "active",
    }];

    const container = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "completed",
      body: `完成 chat [0d232c68](${buildAutomationMentionHref("0d232c68-1111-4111-8111-111111111111", "每日 Rudder 产品与搜索数据分析报告")})。`,
    }));
    const mention = container.querySelector('[data-mention-kind="automation"]');

    expect(mention?.textContent).toBe("每日 Rudder 产品与搜索数据分析报告");
    expect(mention?.getAttribute("href")).toBe("/MARAAA/automations/0d232c68-1111-4111-8111-111111111111");
    expect(container.textContent).not.toContain("0d232c68");
  });

  it("renders automation mentions in user plain-text messages with automation titles", () => {
    markdownMentionsMock.mentions = [{
      id: "automation:0d232c68-1111-4111-8111-111111111111",
      name: "每日 Rudder 产品与搜索数据分析报告",
      kind: "automation",
      automationId: "0d232c68-1111-4111-8111-111111111111",
      automationTitle: "每日 Rudder 产品与搜索数据分析报告",
      automationStatus: "active",
    }];

    const container = renderChatMessageItem(message({
      role: "user",
      kind: "message",
      status: "completed",
      body: `看这个 automation [0d232c68](${buildAutomationMentionHref("0d232c68-1111-4111-8111-111111111111", "每日 Rudder 产品与搜索数据分析报告")})。`,
    }));
    const mention = container.querySelector('[data-mention-kind="automation"]');

    expect(mention?.textContent).toBe("每日 Rudder 产品与搜索数据分析报告");
    expect(mention?.getAttribute("href")).toBe("/MARAAA/automations/0d232c68-1111-4111-8111-111111111111");
    expect(container.textContent).not.toContain("0d232c68");
  });

  it("uses automation title metadata in user plain-text messages before catalog load", () => {
    const container = renderChatMessageItem(message({
      role: "user",
      kind: "message",
      status: "completed",
      body: `看这个 automation [0d232c68](${buildAutomationMentionHref("0d232c68-1111-4111-8111-111111111111", "每日 Rudder 产品与搜索数据分析报告")})。`,
    }));
    const mention = container.querySelector('[data-mention-kind="automation"]');

    expect(mention?.textContent).toBe("每日 Rudder 产品与搜索数据分析报告");
    expect(container.textContent).not.toContain("0d232c68");
  });
});

describe("assistant chat message rendering", () => {
  it("exposes a fork action on persisted assistant responses", () => {
    const container = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Fork from this answer",
    }));

    expect(container.querySelector('button[aria-label="Fork from here"]')).not.toBeNull();
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
            mutability: "native_chat",
            title: "Failed chat",
            summary: null,
            preferredAgentId: null,
            routedAgentId: null,
            primaryIssueId: null,
            forkedFromConversationId: null,
            forkedFromMessageId: null,
            forkRootConversationId: null,
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
