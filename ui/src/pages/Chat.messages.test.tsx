// @vitest-environment jsdom

import type { TranscriptEntry } from "@/agent-runtimes";
import { __clearWebsiteMetadataIconCacheForTests } from "@/components/MarkdownBody";
import type { MentionOption } from "@/components/MarkdownEditor";
import { ThemeProvider } from "@/context/ThemeContext";
import { buildAgentMentionHref, buildAutomationMentionHref, buildIssueMentionHref, type ChatMessage } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageItem, ChatMessagesLoadingState, LazyStreamTranscriptItem, StreamTranscriptItem } from "./Chat.messages";

const markdownMentionsMock = vi.hoisted(() => ({
  mentions: [] as MentionOption[],
}));

const websiteMetadataApiMock = vi.hoisted(() => ({
  get: vi.fn(),
}));

const issuesApiMock = vi.hoisted(() => ({
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

vi.mock("@/api/issues", () => ({
  issuesApi: issuesApiMock,
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
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

beforeEach(() => {
  issuesApiMock.get.mockRejectedValue(new Error("Issue detail is not configured for this test"));
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  markdownMentionsMock.mentions = [];
  __clearWebsiteMetadataIconCacheForTests();
  websiteMetadataApiMock.get.mockReset();
  vi.unstubAllGlobals();
  issuesApiMock.get.mockReset();
  queryClient.clear();
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
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
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

async function waitForIssueStatus(container: HTMLElement, status: string) {
  await act(async () => {
    await vi.waitFor(() => {
      expect(container.querySelector('[data-mention-kind="issue"]')?.getAttribute("data-mention-status")).toBe(status);
    });
  });
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
          conversationKind: "chat",
          messengerVisible: true,
          sideChatState: null,
          sideChatExpiresAt: null,
          sideChatCompletedAt: null,
          sideChatKeptAt: null,
          sideChatClientMutationId: null,
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
        onOpenSideChat={vi.fn()}
        onForkMessage={onForkMessage}
        onEditUserMessage={vi.fn()}
        onContinueInterruptedMessage={vi.fn()}
        onRetryFailedMessage={vi.fn()}
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

describe("StreamTranscriptItem controlled disclosure", () => {
  it("responds to an external open request after the transcript mounts", () => {
    const entries: TranscriptEntry[] = [{
      kind: "thinking",
      ts: "2026-07-23T10:00:00.000Z",
      text: "Visible process evidence",
    }];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };
    const renderTranscript = (open: boolean) => (
      <QueryClientProvider client={queryClient}>
        <StreamTranscriptItem
          entries={entries}
          state="completed"
          streamStartedAt={new Date("2026-07-23T10:00:00.000Z")}
          streamEndedAt={new Date("2026-07-23T10:00:01.000Z")}
          open={open}
          onOpenChange={vi.fn()}
        />
      </QueryClientProvider>
    );

    act(() => root.render(renderTranscript(false)));
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");

    act(() => root.render(renderTranscript(true)));
    expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
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

  it("renders immutable sent annotations above the user bubble and hides their files from the generic gallery", () => {
    const annotationAttachment = {
      id: "40000000-0000-4000-8000-000000000001",
      orgId: "50000000-0000-4000-8000-000000000001",
      conversationId: "20000000-0000-4000-8000-000000000001",
      messageId: "60000000-0000-4000-8000-000000000001",
      assetId: "70000000-0000-4000-8000-000000000001",
      contentType: "application/pdf",
      byteSize: 42,
      sha256: "b".repeat(64),
      originalFilename: "annotation-proof.pdf",
      createdByAgentId: null,
      createdByUserId: "80000000-0000-4000-8000-000000000001",
      createdAt: new Date("2026-07-23T00:00:00Z"),
      updatedAt: new Date("2026-07-23T00:00:00Z"),
      contentPath: "/api/assets/70000000-0000-4000-8000-000000000001/content",
    };
    const regularAttachment = {
      ...annotationAttachment,
      id: "40000000-0000-4000-8000-000000000002",
      assetId: "70000000-0000-4000-8000-000000000002",
      originalFilename: "regular-file.pdf",
      contentPath: "/api/assets/70000000-0000-4000-8000-000000000002/content",
    };
    const container = renderChatMessageItem(message({
      role: "user",
      kind: "message",
      status: "completed",
      body: "",
      structuredPayload: {
        inlineAnnotations: [{
          id: "10000000-0000-4000-8000-000000000001",
          selectedText: "Only real send failures show Retry.",
          comment: "When can this happen?",
          sourceConversationId: "20000000-0000-4000-8000-000000000001",
          sourceMessageId: "30000000-0000-4000-8000-000000000001",
          surface: "assistant_body",
          sourceHash: "a".repeat(64),
          start: 10,
          end: 45,
          prefix: "",
          suffix: "",
          attachmentIds: [annotationAttachment.id],
        }],
      },
      attachments: [annotationAttachment, regularAttachment],
    }));

    const bubble = container.querySelector('[data-testid="chat-user-message-bubble"]');
    expect(container.querySelector("[aria-label='Show 1 annotation']")).not.toBeNull();
    expect(bubble?.textContent).toContain("regular-file.pdf");
    expect(bubble?.textContent).not.toContain("annotation-proof.pdf");

    act(() => {
      container.querySelector<HTMLElement>("[aria-label='Show 1 annotation']")?.click();
    });
    expect(document.body.textContent).toContain("annotation-proof.pdf");
    expect(document.body.querySelectorAll("a").length).toBeGreaterThanOrEqual(2);
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

  it("renders known website icons before following CJK text in user messages", () => {
    const url = "https://app.rudder.zeeland.studio/issues/RUD-1";
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
    expect(link?.querySelector("img.rudder-website-link-logo")?.getAttribute("src")).toMatch(/^data:image\/(?:x-icon|png|svg\+xml);base64,/u);
    expect(link?.querySelector("[data-website-icon='generic']")).toBeNull();
    expect(websiteMetadataApiMock.get).not.toHaveBeenCalled();
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

  it("renders ordinary user issue mentions with the same status icon affordance as assistant markdown", () => {
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
    expect(mention?.classList.contains("rudder-mention-chip--with-status-icon")).toBe(true);
  });

  it("resolves issue status for user message references outside the mention catalog", async () => {
    window.history.pushState({}, "", "/MARAAA/messenger/chat/chat-1");
    issuesApiMock.get.mockResolvedValue({
      id: "a6ecf978-b334-43aa-8065-a5ea6abffb9f",
      identifier: "ZST-776",
      status: "in_progress",
    });

    const container = renderChatMessageItem(message({
      role: "user",
      kind: "message",
      status: "completed",
      body: [
        "总结一下，这个任务都在做些啥？ ",
        "[ZST-776 深度分析一下你今天这些 agent run 中遇到的各种报错和困难，优化系统]",
        "(issue://a6ecf978-b334-43aa-8065-a5ea6abffb9f?r=ZST-776)",
      ].join(""),
    }));

    await waitForIssueStatus(container, "in_progress");
    const mention = container.querySelector('[data-mention-kind="issue"]');
    expect(issuesApiMock.get).toHaveBeenCalledWith("a6ecf978-b334-43aa-8065-a5ea6abffb9f");
    expect(mention?.classList.contains("rudder-mention-chip--with-status-icon")).toBe(true);
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
  it("marks only stable visible assistant bodies as response annotation sources", () => {
    const completed = renderChatMessageItem(message({
      id: "assistant-completed",
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Stable answer",
    }));
    const stableSource = completed.querySelector("[data-chat-annotation-source]");
    expect(stableSource?.getAttribute("data-chat-annotation-source")).toBe("assistant:assistant-completed");
    expect(stableSource?.getAttribute("data-annotation-surface")).toBe("assistant_body");
    expect(stableSource?.getAttribute("data-message-id")).toBe("assistant-completed");

    cleanupFn?.();
    cleanupFn = null;

    const streaming = renderChatMessageItem(message({
      id: "assistant-streaming",
      role: "assistant",
      kind: "message",
      status: "streaming",
      body: "Growing answer",
    }));
    expect(streaming.querySelector("[data-chat-annotation-source]")).toBeNull();
  });

  it("exposes a fork action on persisted assistant responses", () => {
    const container = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Fork from this answer",
    }));

    expect(container.querySelector('button[aria-label="Fork from here"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Open Side Chat"]')).not.toBeNull();
  });

  it("does not expose Side Chat for an incomplete assistant response", () => {
    const container = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "interrupted",
      body: "Partial answer",
    }));

    expect(container.querySelector('button[aria-label="Open Side Chat"]')).toBeNull();
  });

  it("renders a persisted message-owned inline visual and hides its directive", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '<div id="widget"><input class="form-range" type="range"><button class="btn">Run</button></div>',
      { status: 200 },
    )));
    const container = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "completed",
      body: 'Simulator\n::codex-inline-vis{file="simulator.html"}',
      structuredPayload: {
        inlineVisuals: [{ directiveIndex: 0, file: "simulator.html", status: "ready", attachmentId: "visual-1" }],
      },
      attachments: [{
        id: "visual-1",
        orgId: "org-1",
        conversationId: "chat-1",
        messageId: "message-1",
        assetId: "asset-1",
        contentType: "text/html",
        byteSize: 100,
        sha256: "sha",
        originalFilename: "simulator.html",
        createdByAgentId: "agent-1",
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        contentPath: "/api/assets/asset-1/content",
      }],
    }));

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(container.textContent).toContain("Simulator");
    expect(container.textContent).not.toContain("::codex-inline-vis");
    expect(container.querySelector('iframe[sandbox="allow-same-origin"]')).not.toBeNull();
    expect(container.querySelector('iframe[sandbox*="allow-scripts"]')).toBeNull();
  });

  it("renders a runtime-neutral visual without exposing its backing HTML attachment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '<div id="widget"><section class="card">Balanced</section></div>',
      { status: 200 },
    )));
    const container = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "completed",
      body: 'Q4 Capacity Scenarios\n::rudder-inline-vis{slot="0"}',
      structuredPayload: {
        inlineVisualsV1: [{
          version: 1,
          slot: 0,
          file: "inline-visual-1.html",
          status: "ready",
          attachmentId: "visual-v1",
          contentType: "text/html",
          byteSize: 64,
          sha256: "a".repeat(64),
        }],
      },
      attachments: [{
        id: "visual-v1",
        orgId: "org-1",
        conversationId: "chat-1",
        messageId: "message-1",
        assetId: "asset-v1",
        contentType: "text/html",
        byteSize: 64,
        sha256: "a".repeat(64),
        originalFilename: "inline-visual-1.html",
        createdByAgentId: "agent-1",
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        contentPath: "/api/assets/asset-v1/content",
      }],
    }));

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(container.textContent).toContain("Q4 Capacity Scenarios");
    expect(container.textContent).not.toContain("::rudder-inline-vis");
    expect(container.textContent).not.toContain("inline-visual-1.html");
    expect(container.querySelector('iframe[sandbox="allow-same-origin"]')).not.toBeNull();
    expect(container.querySelector('iframe[sandbox*="allow-scripts"]')).toBeNull();
  });

  it("does not use an attachment owned by another branch message", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const container = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "completed",
      body: 'Chart\n::codex-inline-vis{file="chart.html"}',
      structuredPayload: {
        inlineVisuals: [{ directiveIndex: 0, file: "chart.html", status: "ready", attachmentId: "visual-other" }],
      },
      attachments: [{
        id: "visual-other",
        orgId: "org-1",
        conversationId: "chat-1",
        messageId: "another-variant-message",
        assetId: "asset-other",
        contentType: "text/html",
        byteSize: 100,
        sha256: "sha",
        originalFilename: "chart.html",
        createdByAgentId: "agent-1",
        createdByUserId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        contentPath: "/api/assets/asset-other/content",
      }],
    }));

    expect(container.textContent).toContain("Visual artifact unavailable");
    expect(container.textContent).not.toContain("::codex-inline-vis");
    expect(container.querySelector("iframe")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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

describe("steer fallback chat rendering", () => {
  it("keeps partial output without a stopped or failure label", () => {
    const container = renderChatMessageItem(message({
      status: "failed",
      body: "Useful partial answer.",
      generationTerminalReason: "steer_fallback_unverified",
    }));

    expect(container.textContent).toContain("Useful partial answer.");
    expect(container.textContent).not.toContain("Stopped");
    expect(container.textContent).not.toContain("Response failed");
    expect(container.querySelector('button[aria-label="Open Side Chat"]')).toBeNull();
  });

  it("suppresses a stopped placeholder assistant bubble", () => {
    const container = renderChatMessageItem(message({
      status: "stopped",
      body: "Chat run stopped before a final reply. Continue the conversation to resume from the preserved context.",
      generationTerminalReason: "steer_fallback_unverified",
    }));

    expect(container.querySelector('[data-testid="chat-assistant-message"]')).toBeNull();
    expect(container.textContent).not.toContain("Chat run stopped before a final reply");
  });

  it("keeps fallback process history without a stopped-with-errors label", () => {
    const container = render(
      <StreamTranscriptItem
        entries={[{ kind: "stderr", ts: "2026-06-15T10:00:00.000Z", text: "partial tool output" }]}
        state="failed"
        generationTerminalReason="steer_fallback_unverified"
        streamStartedAt={new Date("2026-06-15T10:00:00.000Z")}
        defaultOpen
      />,
    );

    expect(container.querySelector('[data-testid="chat-transcript-item"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Stopped with errors");
  });

  it("keeps an operator-stopped assistant message visibly stopped", () => {
    const container = renderChatMessageItem(message({
      status: "stopped",
      body: "The operator stopped this run.",
      generationTerminalReason: "operator_stop",
    }));

    expect(container.textContent).toContain("Stopped");
  });
});
