// @vitest-environment node

import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import { I18nProvider } from "@/context/I18nContext";
import { ThemeProvider } from "@/context/ThemeContext";
import {
  readChatScopedPendingFiles,
  updateChatScopedPendingFiles,
} from "@/lib/chat-pending-attachments";
import {
  createImageDesktopPayload,
  resolveImageFilename,
} from "@/lib/image-actions";
import {
  buildAutomationMentionHref,
  buildChatMentionHref,
  buildIssueMentionHref,
  buildLibraryDirectoryMentionHref,
  buildLibraryFileMentionHref,
  type Agent,
  type ChatConversation,
  type ChatMessage,
  type Issue,
  type MessengerThreadSummary,
  type OrganizationSkillListItem,
  type Project,
} from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_PROJECT_BY_AGENT_STORAGE_KEY,
  ChatMessageItem,
  ChatSystemMessageBody,
  INTERRUPTED_CHAT_CONTINUATION_PROMPT,
  NO_PROJECT_ID,
  ProposalCard,
  applyChatStreamProgressEvent,
  askUserAnswerFromMessage,
  askUserRequestFromMessage,
  assistantStateLabel,
  buildChatProposalRejectFeedbackPrompt,
  buildChatProposalRevisionPrompt,
  buildDraftChatContextLinks,
  canContinueInterruptedChatMessage,
  canRefreshAssistantChatMessage,
  canRefreshDisplayedAssistantChatMessage,
  canRetryFailedChatMessage,
  chatEmptyStateHeading,
  chatIssueApprovalPayloadWithProposalOverride,
  chatSidePanelTargetFromHref,
  computeDisplayedChatMessages,
  draftIssueContextLabel,
  findLatestUnansweredAskUserMessage,
  findRetrySourceUserMessage,
  formatAskUserAnswerMessage,
  isAskUserMessageAnswered,
  isChatAgentSelectionLocked,
  isChatProjectSelectionLocked,
  isUserVisibleIncomingChatMessage,
  issueProposalPrincipalSelectionValue,
  issueProposalWithPrincipalSelection,
  issueProposalWithPriority,
  issueProposalWithStatus,
  parseAskUserAnswerMessage,
  rememberChatProjectId,
  rememberChatProjectIdForAgent,
  resolveChatMessageAgentRunTarget,
  resolveDefaultDraftChatProjectId,
  resolveDraftIssueContext,
  resolveLatestChatAgentRunTarget,
  scrollChatMessagesToBottom,
  shouldAttachApprovalFeedbackSystemMessage,
  shouldAttachIssueCreatedSystemMessage,
  statusChipClassName,
  withOptimisticOutgoingMessage,
  withOptimisticPlanMode,
} from "./Chat";
import { mergeMessengerThreadSummaries } from "./Chat.parts";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/chat" }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams()],
}));

describe("chat stream stop cutoff", () => {
  const draft = (overrides: Partial<ChatStreamDraft> = {}): ChatStreamDraft => ({
    chatId: "chat-1",
    streamKey: "stream-1",
    userBody: "Draft a plan",
    userCreatedAt: new Date("2026-07-16T09:00:00.000Z"),
    userMessageId: "user-1",
    chatTurnId: "turn-1",
    turnVariant: 0,
    editedFromCreatedAt: null,
    body: "Frozen prefix",
    state: "streaming",
    createdAt: new Date("2026-07-16T09:00:01.000Z"),
    transcript: [],
    replyingAgentId: "agent-1",
    ...overrides,
  });

  it("accepts progress only for the matching active generation", () => {
    const current = draft();

    expect(applyChatStreamProgressEvent(current, "stream-1", {
      type: "assistant_delta",
      delta: " before stop",
    })).toMatchObject({
      body: "Frozen prefix before stop",
      state: "streaming",
    });

    const replacement = draft({ streamKey: "stream-2", body: "Replacement generation" });
    expect(applyChatStreamProgressEvent(replacement, "stream-1", {
      type: "assistant_delta",
      delta: " stale output",
    })).toBe(replacement);
  });

  it("does not mutate the current transcript while coalescing streamed entries", () => {
    const current = draft({
      transcript: [{
        kind: "assistant",
        ts: "2026-07-16T09:00:02.000Z",
        text: "我",
        delta: true,
      }],
    });
    const event = {
      type: "transcript_entry" as const,
      entry: {
        kind: "assistant" as const,
        ts: "2026-07-16T09:00:03.000Z",
        text: "会",
        delta: true as const,
      },
    };

    const first = applyChatStreamProgressEvent(current, "stream-1", event);
    const replay = applyChatStreamProgressEvent(current, "stream-1", event);

    expect(current.transcript).toEqual([expect.objectContaining({ text: "我" })]);
    expect(first?.transcript).toEqual([expect.objectContaining({ text: "我会" })]);
    expect(replay?.transcript).toEqual([expect.objectContaining({ text: "我会" })]);
  });

  it("coalesces only matching streamed commentary segments", () => {
    const current = draft();
    const first = applyChatStreamProgressEvent(current, "stream-1", {
      type: "transcript_entry",
      entry: {
        kind: "assistant",
        ts: "2026-07-27T09:00:00.000Z",
        text: "读取 `rudder",
        delta: true,
        phase: "commentary",
        segmentId: "commentary-1",
      },
    });
    const second = applyChatStreamProgressEvent(first, "stream-1", {
      type: "transcript_entry",
      entry: {
        kind: "assistant",
        ts: "2026-07-27T09:00:01.000Z",
        text: "-docs`。",
        delta: true,
        phase: "commentary",
        segmentId: "commentary-1",
      },
    });
    const third = applyChatStreamProgressEvent(second, "stream-1", {
      type: "transcript_entry",
      entry: {
        kind: "assistant",
        ts: "2026-07-27T09:00:02.000Z",
        text: "另一条。",
        delta: true,
        phase: "commentary",
        segmentId: "commentary-2",
      },
    });

    expect(third?.transcript).toMatchObject([
      { text: "读取 `rudder-docs`。", segmentId: "commentary-1" },
      { text: "另一条。", segmentId: "commentary-2" },
    ]);
  });

  it("keeps body, state, and transcript immutable after Stop freezes the generation", () => {
    const frozen = draft({
      state: "stopping",
      transcript: [{
        kind: "thinking",
        ts: "2026-07-16T09:00:02.000Z",
        text: "Reasoning before stop",
      }],
    });

    expect(applyChatStreamProgressEvent(frozen, "stream-1", {
      type: "assistant_delta",
      delta: " late output",
    })).toBe(frozen);
    expect(applyChatStreamProgressEvent(frozen, "stream-1", {
      type: "assistant_state",
      state: "finalizing",
    })).toBe(frozen);
    expect(applyChatStreamProgressEvent(frozen, "stream-1", {
      type: "transcript_entry",
      entry: {
        kind: "thinking",
        ts: "2026-07-16T09:00:03.000Z",
        text: "Reasoning after stop",
      },
    })).toBe(frozen);

    const stopped = draft({ state: "stopped" });
    expect(applyChatStreamProgressEvent(stopped, "stream-1", {
      type: "assistant_delta",
      delta: " output after confirmation",
    })).toBe(stopped);

    expect(frozen).toMatchObject({
      body: "Frozen prefix",
      state: "stopping",
      transcript: [{ text: "Reasoning before stop" }],
    });
  });

  it("keeps accepting output after a tool-busy state and ignores replayed progress", () => {
    const generationId = "generation-tool-busy";
    const current = draft({ generationId, lastCommittedRenderSeq: 0 });
    const toolBusy = applyChatStreamProgressEvent(current, "stream-1", {
      type: "assistant_state",
      state: "tool_busy",
      generationId,
    });
    const toolResult = applyChatStreamProgressEvent(toolBusy, "stream-1", {
      type: "transcript_entry",
      generationId,
      generationSeq: 1,
      entry: {
        kind: "tool_result",
        ts: "2026-07-16T09:00:02.000Z",
        toolUseId: "memory-1",
        toolName: "para-memory-files",
        content: "memory loaded",
        isError: false,
      },
    });
    const replay = applyChatStreamProgressEvent(toolResult, "stream-1", {
      type: "transcript_entry",
      generationId,
      generationSeq: 1,
      entry: {
        kind: "tool_result",
        ts: "2026-07-16T09:00:02.000Z",
        toolUseId: "memory-1",
        toolName: "para-memory-files",
        content: "memory loaded",
        isError: false,
      },
    });
    const answer = applyChatStreamProgressEvent(replay, "stream-1", {
      type: "assistant_delta",
      generationId,
      generationSeq: 2,
      delta: "final answer",
    });

    expect(toolBusy?.state).toBe("tool_busy");
    expect(replay?.transcript).toHaveLength(1);
    expect(answer).toMatchObject({
      state: "tool_busy",
      body: "Frozen prefixfinal answer",
      lastCommittedRenderSeq: 2,
    });
  });

  it("rejects progress from another generation instead of replacing the active identity", () => {
    const current = draft({ generationId: "generation-1", lastCommittedRenderSeq: 3 });
    const stale = applyChatStreamProgressEvent(current, "stream-1", {
      type: "assistant_delta",
      generationId: "generation-2",
      generationSeq: 4,
      delta: "stale output",
    });

    expect(stale).toBe(current);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-1",
    orgId: "org-1",
    conversationId: "chat-1",
    role: "system",
    kind: "system_event",
    status: "completed",
    body: "System event.",
    structuredPayload: null,
    approvalId: null,
    approval: null,
    attachments: [],
    transcript: [],
    replyingAgentId: null,
    chatTurnId: null,
    turnVariant: 0,
    supersededAt: null,
    createdAt: new Date("2026-05-07T00:00:00.000Z"),
    updatedAt: new Date("2026-05-07T00:00:00.000Z"),
    ...overrides,
  };
}

function messengerThread(overrides: Partial<MessengerThreadSummary> & Pick<MessengerThreadSummary, "threadKey" | "title">): MessengerThreadSummary {
  return {
    kind: "chat",
    subtitle: null,
    preview: null,
    latestActivityAt: new Date("2026-05-01T10:00:00.000Z"),
    lastReadAt: null,
    unreadCount: 0,
    needsAttention: false,
    isPinned: false,
    href: `/messenger/${overrides.threadKey}`,
    ...overrides,
  };
}

function conversation(overrides: Partial<ChatConversation>): ChatConversation {
  return {
    id: "chat-1",
    orgId: "org-1",
    status: "active",
    mutability: "native_chat",
    title: "Plan mode chat",
    summary: null,
    latestReplyPreview: null,
    latestUserMessagePreview: null,
    userMessageCount: 0,
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
    lastReadAt: null,
    isPinned: false,
    isUnread: false,
    unreadCount: 0,
    needsAttention: false,
    resolvedAt: null,
    contextLinks: [],
    chatRuntime: {
      sourceType: "unconfigured",
      sourceLabel: "No chat runtime",
      runtimeAgentId: null,
      agentRuntimeType: null,
      model: null,
      available: false,
      error: null,
    },
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("latest Chat Agent Run target", () => {
  it("resolves one message using the replying, runtime, then preferred agent", () => {
    const runMessage = message({
      role: "assistant",
      kind: "message",
      runId: "run-exact",
      replyingAgentId: "agent-replying",
    });
    const runtimeConversation = conversation({
      preferredAgentId: "agent-preferred",
      chatRuntime: {
        sourceType: "agent",
        sourceLabel: "Runtime agent",
        runtimeAgentId: "agent-runtime",
        agentRuntimeType: "codex",
        model: null,
        available: true,
        error: null,
      },
    });

    expect(resolveChatMessageAgentRunTarget(runMessage, runtimeConversation)).toEqual({
      runId: "run-exact",
      agentId: "agent-replying",
    });
    expect(resolveChatMessageAgentRunTarget(
      { ...runMessage, replyingAgentId: null },
      runtimeConversation,
    )).toEqual({ runId: "run-exact", agentId: "agent-runtime" });
    expect(resolveChatMessageAgentRunTarget(
      { ...runMessage, replyingAgentId: null },
      conversation({ preferredAgentId: "agent-preferred" }),
    )).toEqual({ runId: "run-exact", agentId: "agent-preferred" });
  });

  it("requires both a run and an agent for a message target", () => {
    expect(resolveChatMessageAgentRunTarget(
      message({ role: "assistant", runId: null, replyingAgentId: "agent-1" }),
      conversation({}),
    )).toBeNull();
    expect(resolveChatMessageAgentRunTarget(
      message({ role: "assistant", runId: "run-1", replyingAgentId: null }),
      conversation({ preferredAgentId: null }),
    )).toBeNull();
  });

  it("selects the newest runtime-backed assistant message by createdAt across variants", () => {
    const target = resolveLatestChatAgentRunTarget([
      message({
        id: "newer-array-entry",
        role: "assistant",
        kind: "message",
        runId: "run-older",
        replyingAgentId: "agent-older",
        chatTurnId: "turn-1",
        turnVariant: 0,
        createdAt: new Date("2026-05-07T12:00:00.000Z"),
      }),
      message({
        id: "older-array-entry",
        role: "assistant",
        kind: "message",
        runId: "run-newest",
        replyingAgentId: "agent-newest",
        chatTurnId: "turn-1",
        turnVariant: 2,
        createdAt: new Date("2026-05-07T13:00:00.000Z"),
      }),
    ], conversation({ preferredAgentId: "agent-preferred" }));

    expect(target).toEqual({ runId: "run-newest", agentId: "agent-newest" });
  });

  it.each([
    ["streaming", { status: "streaming" as const }],
    ["completed", { status: "completed" as const }],
    ["interrupted", { status: "interrupted" as const }],
    ["failed", { status: "failed" as const }],
    ["stopped", { status: "stopped" as const }],
    ["superseded", { status: "completed" as const, supersededAt: new Date("2026-05-07T14:00:00.000Z") }],
  ])("keeps %s assistant attempts eligible", (_label, attempt) => {
    const target = resolveLatestChatAgentRunTarget([
      message({
        role: "assistant",
        kind: "message",
        runId: `run-${_label}`,
        replyingAgentId: "agent-attempt",
        ...attempt,
      }),
    ], conversation({}));

    expect(target).toEqual({ runId: `run-${_label}`, agentId: "agent-attempt" });
  });

  it("ignores non-assistant messages and assistant messages without a run", () => {
    const target = resolveLatestChatAgentRunTarget([
      message({
        role: "assistant",
        kind: "message",
        runId: "run-eligible",
        replyingAgentId: "agent-eligible",
        createdAt: new Date("2026-05-07T10:00:00.000Z"),
      }),
      message({
        role: "user",
        kind: "message",
        runId: "run-user",
        replyingAgentId: "agent-user",
        createdAt: new Date("2026-05-07T12:00:00.000Z"),
      }),
      message({
        role: "assistant",
        kind: "message",
        runId: null,
        replyingAgentId: "agent-no-run",
        createdAt: new Date("2026-05-07T13:00:00.000Z"),
      }),
    ], conversation({}));

    expect(target).toEqual({ runId: "run-eligible", agentId: "agent-eligible" });
  });

  it("prefers the message replying agent over conversation fallbacks", () => {
    const target = resolveLatestChatAgentRunTarget([
      message({
        role: "assistant",
        kind: "message",
        runId: "run-1",
        replyingAgentId: "agent-replying",
      }),
    ], conversation({
      preferredAgentId: "agent-preferred",
      chatRuntime: {
        sourceType: "agent",
        sourceLabel: "Runtime agent",
        runtimeAgentId: "agent-runtime",
        agentRuntimeType: "codex",
        model: null,
        available: true,
        error: null,
      },
    }));

    expect(target).toEqual({ runId: "run-1", agentId: "agent-replying" });
  });

  it("falls back to the conversation runtime agent, then the preferred agent", () => {
    const runMessage = message({
      role: "assistant",
      kind: "message",
      runId: "run-1",
      replyingAgentId: null,
    });
    const runtimeTarget = resolveLatestChatAgentRunTarget([runMessage], conversation({
      preferredAgentId: "agent-preferred",
      chatRuntime: {
        sourceType: "agent",
        sourceLabel: "Runtime agent",
        runtimeAgentId: "agent-runtime",
        agentRuntimeType: "codex",
        model: null,
        available: true,
        error: null,
      },
    }));
    const preferredTarget = resolveLatestChatAgentRunTarget([runMessage], conversation({
      preferredAgentId: "agent-preferred",
    }));

    expect(runtimeTarget).toEqual({ runId: "run-1", agentId: "agent-runtime" });
    expect(preferredTarget).toEqual({ runId: "run-1", agentId: "agent-preferred" });
  });

  it("returns null when no assistant run or no agent fallback is available", () => {
    expect(resolveLatestChatAgentRunTarget([
      message({ role: "assistant", kind: "message", runId: null }),
    ], conversation({ preferredAgentId: "agent-preferred" }))).toBeNull();
    expect(resolveLatestChatAgentRunTarget([
      message({ role: "assistant", kind: "message", runId: "run-1", replyingAgentId: null }),
    ], conversation({ preferredAgentId: null }))).toBeNull();
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function withMockWindowStorage() {
  const storage = createMemoryStorage();
  vi.stubGlobal("window", { localStorage: storage });
  return storage;
}

function renderSystemMessageBody(message: ChatMessage) {
  return renderToStaticMarkup(
    <ThemeProvider>
      <ChatSystemMessageBody message={message} skillReferences={[]} />
    </ThemeProvider>,
  );
}

function renderChatMessageItem(messageToRender: ChatMessage, options?: { canRefreshAssistantMessage?: boolean }) {
  return renderToStaticMarkup(
    <ThemeProvider>
      <ChatMessageItem
        conversation={conversation({})}
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
        canRefreshAssistantMessage={options?.canRefreshAssistantMessage ?? false}
        onRefreshAssistantMessage={vi.fn()}
        onOpenFile={vi.fn()}
        skillReferences={[]}
      />
    </ThemeProvider>,
  );
}

function renderProposalCard(
  message: ChatMessage,
  chat: ChatConversation = conversation({}),
  agents?: Agent[],
  decisionNote = "",
  extraProps: Partial<Pick<Parameters<typeof ProposalCard>[0], "actionPending" | "currentUserId" | "currentUserAvatarUrl" | "issueProposalOverride" | "onIssueProposalChange" | "issueCreatedMessage">> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemeProvider>
          <ProposalCard
            conversation={chat}
            message={message}
            agents={agents}
            decisionNote={decisionNote}
            onDecisionNoteChange={vi.fn()}
            decisionNoteMentions={[]}
            onDecisionNoteMentionQueryChange={vi.fn()}
            onDecisionNoteInlineTokenClick={vi.fn()}
            onApprovalAction={vi.fn()}
            {...extraProps}
            onResolveOperationProposal={vi.fn()}
            onConvertToIssue={vi.fn()}
            actionPending={extraProps.actionPending ?? false}
            skillReferences={[]}
          />
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("ChatSystemMessageBody", () => {
  it("highlights issue-created identifiers as issue links", () => {
    const html = renderSystemMessageBody(message({
      body: "Created issue ZST-29 from this chat conversation.",
      structuredPayload: {
        eventType: "issue_created",
        issueId: "issue-29",
        issueIdentifier: "ZST-29",
      },
    }));

    expect(html).toContain("Created issue ");
    expect(html).toContain('class="chat-system-issue-link"');
    expect(html).toContain('href="/issues/ZST-29"');
    expect(html).toContain('aria-label="Open issue ZST-29"');
    expect(html).toContain(">ZST-29</a> from this chat conversation.");
  });

  it("keeps normal system messages in markdown rendering", () => {
    const html = renderSystemMessageBody(message({
      body: "Applied **approved** organization change.",
      structuredPayload: {
        eventType: "operation_applied",
      },
    }));

    expect(html).toContain("rudder-markdown");
    expect(html).toMatch(/<strong[^>]*>approved<\/strong>/);
    expect(html).not.toContain("chat-system-issue-link");
  });

  it("renders Side Chat source events as direct links back to the source conversation", () => {
    const html = renderSystemMessageBody(message({
      body: "Side Chat started from [Main strategy chat](chat://source-chat).",
      structuredPayload: {
        eventType: "side_chat_started",
        sourceConversationId: "source-chat",
        sourceConversationTitle: "Main strategy chat",
      },
    }));

    expect(html).toContain("Side Chat started from");
    expect(html).toContain('href="/messenger/chat/source-chat"');
    expect(html).toContain('aria-label="Open source chat Main strategy chat"');
    expect(html).toContain(">Main strategy chat</a>.");
    expect(html).not.toContain('href="chat://source-chat"');
    expect(html).not.toContain("rudder-markdown");
  });

  it("renders automation source events as links back to automation detail", () => {
    const automationMessage = message({
      body: "From automation Say hello.",
      structuredPayload: {
        eventType: "automation_source",
        automationId: "auto-1",
        automationTitle: "Say hello",
      },
    });
    const html = renderSystemMessageBody(automationMessage);
    const messageHtml = renderChatMessageItem(automationMessage);

    expect(html).toContain("From automation");
    expect(html).toContain('href="/automations/auto-1"');
    expect(html).toContain('aria-label="Open automation Say hello"');
    expect(html).toContain(">Say hello</a>.");
    expect(messageHtml).toContain("lucide-repeat");
    expect(messageHtml).not.toContain("lucide-circle-check");
  });

  it("renders created automation events as links back to automation detail", () => {
    const html = renderSystemMessageBody(message({
      body: 'Created automation "Daily AI HOT report" from this chat conversation.',
      structuredPayload: {
        eventType: "automation_created",
        automationId: "auto-1",
        automationTitle: "Daily AI HOT report",
      },
    }));

    expect(html).toContain("Created automation");
    expect(html).toContain('href="/automations/auto-1"');
    expect(html).toContain('aria-label="Open automation Daily AI HOT report"');
    expect(html).toContain(">Daily AI HOT report</a> from this chat conversation.");
  });

  it("renders fork source messages as a clickable at-message token without exposing raw IDs", () => {
    const sourceMessageId = "99c63cd7-5996-4b16-a1e4-c6d462599a2e";
    const html = renderSystemMessageBody(message({
      body: "Forked from [Forkable strategy chat](chat://source-chat) at message.",
      structuredPayload: {
        eventType: "chat_fork",
        sourceConversationId: "source-chat",
        sourceConversationTitle: "Forkable strategy chat",
        sourceMessageId,
      },
    }));

    expect(html).toContain("Forked from");
    expect(html).toContain('href="/messenger/chat/source-chat"');
    expect(html).toContain('aria-label="Open source chat Forkable strategy chat"');
    expect(html).toContain('class="chat-system-issue-link chat-system-message-link"');
    expect(html).toContain('href="chat://source-chat?messageId=99c63cd7-5996-4b16-a1e4-c6d462599a2e"');
    expect(html).toContain('aria-label="Open source message"');
    expect(html).toContain("at <a");
    expect(html).toContain(">message</a>.");
    expect(html.replace(/href=\"[^\"]*\"/g, "")).not.toContain(sourceMessageId);
  });

  it("keeps legacy fork source titles when structured payloads predate title storage", () => {
    const html = renderSystemMessageBody(message({
      body: "Forked from [Legacy strategy chat](chat://source-chat) at message 99c63cd7-5996-4b16-a1e4-c6d462599a2e.",
      structuredPayload: {
        type: "chat_fork",
        sourceConversationId: "source-chat",
        sourceMessageId: "99c63cd7-5996-4b16-a1e4-c6d462599a2e",
      },
    }));

    expect(html).toContain(">Legacy strategy chat</a>");
    expect(html).not.toContain(">source chat</a>");
  });
});

describe("ChatMessageItem", () => {
  it("renders empty streaming assistant messages as the normal thinking state", () => {
    const html = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "streaming",
      body: "",
      replyingAgentId: "agent-1",
    }));

    expect(html).toContain("Thinking");
    expect(html).toContain('aria-label="Thinking..."');
    expect(html).not.toContain(">Streaming</span>");
    expect(html).not.toContain('aria-label="Copy message"');
  });

  it("keeps non-empty streaming assistant messages copyable with a status label", () => {
    const html = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "streaming",
      body: "Partial automation response.",
      replyingAgentId: "agent-1",
    }));

    expect(html).toContain(">Streaming</span>");
    expect(html).toContain("Partial automation response.");
    expect(html).toContain('aria-label="Copy message"');
    expect(html).not.toContain('aria-label="Refresh answer"');
  });

  it("hides message action buttons for stopped assistant placeholders", () => {
    const html = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "stopped",
      body: "",
      chatTurnId: "turn-1",
      replyingAgentId: "agent-1",
    }), { canRefreshAssistantMessage: true });

    expect(html).toContain(">Stopped</span>");
    expect(html).not.toContain('aria-label="Copy message"');
    expect(html).not.toContain('aria-label="Refresh answer"');
    expect(html).not.toContain('aria-label="Fork from here"');
  });

  it("renders a refresh action for completed assistant messages in a turn", () => {
    const html = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Final answer.",
      chatTurnId: "turn-1",
    }), { canRefreshAssistantMessage: true });

    expect(html).toContain('aria-label="Refresh answer"');
    expect(html).toContain("Final answer.");
  });

  it("renders failed assistant messages with a visible failure callout and retry action", () => {
    const html = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "failed",
      body: "The assistant response failed.",
      chatTurnId: "turn-1",
    }));

    expect(html).toContain('role="alert"');
    expect(html).toContain("Response failed");
    expect(html).toContain("This assistant response failed before it completed.");
    expect(html).toContain(">Failed</span>");
    expect(html).toContain("Retry");
  });

  it("renders recoverable chat failure diagnostics on failed assistant messages", () => {
    const html = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "failed",
      body: "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.",
      chatTurnId: "turn-1",
      runId: "12345678-1234-1234-1234-123456789abc",
      structuredPayload: {
        recoverableFailure: {
          recoverable: true,
          code: "chat_result_missing_sentinel",
          message: "The assistant finished without a final Rudder reply. Rudder saved the attempt and transcript; retry when ready.",
          runId: "12345678-1234-1234-1234-123456789abc",
        },
      },
    }));

    expect(html).toContain("The assistant finished without a final Rudder reply.");
    expect(html).toContain("Code chat_result_missing_sentinel");
    expect(html).toContain("Run 12345678");
    expect(html).toContain("Retry");
  });

  it("renders non-retryable runtime boot failures without a retry action", () => {
    const html = renderChatMessageItem(message({
      role: "assistant",
      kind: "message",
      status: "failed",
      body: "The assistant runtime did not start successfully. Fix the runtime command or environment, then run again.",
      chatTurnId: "turn-1",
      runId: "12345678-1234-1234-1234-123456789abc",
      structuredPayload: {
        recoverableFailure: {
          recoverable: false,
          retryable: false,
          phase: "runtime_boot",
          action: "repair_runtime",
          code: "chat_runtime_boot_failed",
          message: "The assistant runtime did not start successfully. Fix the runtime command or environment, then run again.",
          runId: "12345678-1234-1234-1234-123456789abc",
        },
      },
    }));

    expect(html).toContain("Runtime unavailable");
    expect(html).toContain("Fix the runtime command or environment");
    expect(html).toContain("Code chat_runtime_boot_failed");
    expect(html).not.toContain("Retry");
  });
});

describe("Chat Side Panel targets", () => {
  it("resolves issue, automation, and library targets from chat links", () => {
    expect(chatSidePanelTargetFromHref(buildIssueMentionHref("issue-1", "ZST-1", "comment-1"))).toEqual({
      kind: "issue",
      issueId: "issue-1",
      ref: "ZST-1",
      commentId: "comment-1",
      label: "ZST-1",
    });
    expect(chatSidePanelTargetFromHref(buildChatMentionHref("chat-2"))).toBeNull();
    expect(chatSidePanelTargetFromHref(`${buildChatMentionHref("chat-2")}?messageId=message-3`, "Source message")).toBeNull();
    expect(chatSidePanelTargetFromHref(buildAutomationMentionHref("automation-1", "Daily report"))).toEqual({
      kind: "automation",
      automationId: "automation-1",
      label: "Daily report",
    });
    expect(chatSidePanelTargetFromHref(buildLibraryFileMentionHref("docs/plan.md"), "Plan doc")).toEqual({
      kind: "library_file",
      filePath: "docs/plan.md",
      label: "Plan doc",
    });
    expect(chatSidePanelTargetFromHref(buildLibraryDirectoryMentionHref("docs"), "Docs")).toEqual({
      kind: "library_directory",
      directoryPath: "docs",
      label: "Docs",
    });
    expect(chatSidePanelTargetFromHref("/messenger/chat/chat-2?messageId=message-3", "Source message")).toBeNull();
    expect(chatSidePanelTargetFromHref("/automations/automation-1?t=Daily%20report")).toEqual({
      kind: "automation",
      automationId: "automation-1",
      label: "Daily report",
    });
    expect(chatSidePanelTargetFromHref("/library?path=docs%2Fplan.md", "Plan doc")).toEqual({
      kind: "library_file",
      filePath: "docs/plan.md",
      label: "Plan doc",
    });
    expect(chatSidePanelTargetFromHref("/library?directory=docs", "Docs")).toEqual({
      kind: "library_directory",
      directoryPath: "docs",
      label: "Docs",
    });
    expect(chatSidePanelTargetFromHref(
      "skill://org/skill-1?ref=visualize",
      "visualize",
    )).toEqual({
      kind: "organization_skill_file",
      skillId: "skill-1",
      filePath: "SKILL.md",
      label: "visualize",
    });
    expect(chatSidePanelTargetFromHref(
      "/workspace/.agents/skills/visualize/SKILL.md",
      "visualize",
      [{
        id: "org-visualize",
        slug: "visualize",
        key: "rudder/visualize",
        name: "Visualize",
        sourcePath: "/workspace/organization-skills/visualize",
      } as OrganizationSkillListItem],
    )).toEqual({
      kind: "local_file",
      filePath: "/workspace/.agents/skills/visualize/SKILL.md",
      label: "visualize",
    });
  });

  it("does not treat external links or unsupported internal routes as Side Panel targets", () => {
    expect(chatSidePanelTargetFromHref("https://example.com", "Example")).toBeNull();
    expect(chatSidePanelTargetFromHref("/agents/agent-1", "Agent")).toBeNull();
  });
});

describe("draft issue chat context", () => {
  it("resolves pending issue context by id or identifier", () => {
    const issue = {
      id: "issue-1",
      identifier: "ZST-146",
      title: "Fix chat routing",
    } as Issue;

    expect(resolveDraftIssueContext([issue], "issue-1")).toBe(issue);
    expect(resolveDraftIssueContext([issue], "ZST-146")).toBe(issue);
    expect(resolveDraftIssueContext([issue], "missing")).toBeNull();
  });

  it("attaches issue context before project context when creating a draft chat", () => {
    expect(buildDraftChatContextLinks("project-1", "issue-1")).toEqual([
      { entityType: "issue", entityId: "issue-1" },
      { entityType: "project", entityId: "project-1" },
    ]);
    expect(draftIssueContextLabel({ identifier: null, title: "Untitled fix" })).toBe("Untitled fix");
  });
});

describe("draft chat project defaults", () => {
  const projects = [
    { id: "project-alpha" },
    { id: "project-beta" },
    { id: "project-gamma" },
  ] as Project[];

  it("prefers the pending issue project over remembered defaults", () => {
    withMockWindowStorage();
    rememberChatProjectId("org-1", "project-gamma");
    rememberChatProjectIdForAgent("org-1", "agent-1", "project-beta");

    expect(resolveDefaultDraftChatProjectId({
      orgId: "org-1",
      projects,
      issue: { projectId: "project-alpha" },
      agentId: "agent-1",
    })).toBe("project-alpha");
  });

  it("uses an agent-specific recent project before the organization recent project", () => {
    withMockWindowStorage();
    rememberChatProjectId("org-1", "project-gamma");
    rememberChatProjectIdForAgent("org-1", "agent-1", "project-beta");

    expect(resolveDefaultDraftChatProjectId({
      orgId: "org-1",
      projects,
      issue: null,
      agentId: "agent-1",
    })).toBe("project-beta");
  });

  it("honors an agent-specific no-project choice", () => {
    const storage = withMockWindowStorage();
    rememberChatProjectId("org-1", "project-gamma");
    rememberChatProjectIdForAgent("org-1", "agent-1", null);

    expect(resolveDefaultDraftChatProjectId({
      orgId: "org-1",
      projects,
      issue: null,
      agentId: "agent-1",
    })).toBe(NO_PROJECT_ID);
    expect(storage.getItem(CHAT_PROJECT_BY_AGENT_STORAGE_KEY)).toContain('"agent-1":null');
  });
});

describe("chat empty state heading", () => {
  const t = (
    key: "chat.emptyState.heading" | "chat.emptyState.headingNamed" | "chat.emptyState.headingProject",
    params?: Record<string, string>,
  ) => {
    if (key === "chat.emptyState.headingProject") return `What should we build in ${params?.project}?`;
    if (key === "chat.emptyState.headingNamed") return `What can I help with, ${params?.name}?`;
    return "What can I help with?";
  };

  it("uses the selected project name on a draft chat", () => {
    expect(chatEmptyStateHeading({
      activeProjectName: "Rudder Desktop",
      userNickname: "Zeeland",
      t,
    })).toBe("What should we build in Rudder Desktop?");
  });

  it("keeps the current personalized heading without a selected project", () => {
    expect(chatEmptyStateHeading({
      activeProjectName: null,
      userNickname: "Zeeland",
      t,
    })).toBe("What can I help with, Zeeland?");
  });
});

describe("ProposalCard", () => {
  it("uses the account avatar only for current-user proposal principals", () => {
    const currentHtml = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      structuredPayload: {
        title: "Current owner",
        description: "Use the signed-in account avatar.",
        assigneeUserId: "local-board",
      },
    }), conversation({}), [], "", {
      currentUserId: "local-board",
      currentUserAvatarUrl: "https://example.test/current.png",
    });
    const otherHtml = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      structuredPayload: {
        title: "Other owner",
        description: "Keep another user's fallback.",
        assigneeUserId: "other-user",
      },
    }), conversation({}), [], "", {
      currentUserId: "local-board",
      currentUserAvatarUrl: "https://example.test/current.png",
    });

    expect(currentHtml).toContain('data-avatar-url="https://example.test/current.png"');
    expect(otherHtml).not.toContain('data-avatar-url="https://example.test/current.png"');
  });
  it("keeps assistant rationale outside the structured review card", () => {
    const assistantBody = "结论：不通过，需要修。这个应该作为普通回复正文。";
    const issueTitle = "Fix issue Chat entry";
    const issueDescription = "Only this structured issue description belongs in the review card.";
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      body: assistantBody,
      structuredPayload: {
        title: issueTitle,
        priority: "high",
        description: issueDescription,
      },
    }));

    const reviewBlockIndex = html.indexOf('data-testid="proposal-review-block"');
    expect(reviewBlockIndex).toBeGreaterThan(0);
    expect(html.indexOf(assistantBody)).toBeLessThan(reviewBlockIndex);

    const reviewBlockHtml = html.slice(reviewBlockIndex);
    expect(reviewBlockHtml).toContain("Issue proposal");
    expect(reviewBlockHtml).not.toContain("Draft issue awaiting review");
    expect(reviewBlockHtml).not.toContain("Proposed issue");
    expect(reviewBlockHtml).not.toContain("Issue description");
    expect(reviewBlockHtml).toContain("Priority");
    expect(reviewBlockHtml).toContain("High");
    expect(reviewBlockHtml).toContain("Proposal details");
    expect(reviewBlockHtml).toContain("chat-review-details-body--collapsed");
    expect(reviewBlockHtml).not.toContain("<details");
    expect(reviewBlockHtml).not.toContain("<summary");
    expect(reviewBlockHtml).not.toContain("Goal");
    expect(reviewBlockHtml).not.toContain("Review this proposal here before continuing the conversation.");
    expect(reviewBlockHtml).toContain(issueTitle);
    expect(reviewBlockHtml).toContain(issueDescription);
    expect(reviewBlockHtml).not.toContain(assistantBody);
  });

  it("renders proposed reviewer metadata in issue proposal cards", () => {
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      body: "This should become a reviewed issue.",
      structuredPayload: {
        issueProposal: {
          title: "Implement reviewed flow",
          priority: "medium",
          description: "Create a tracked task with review.",
          assigneeAgentId: "agent-1",
          reviewerAgentId: "agent-2",
        },
      },
    }), conversation({}), [
      { id: "agent-1", name: "Wesley", role: "engineer", title: "Founding Engineer", icon: null } as Agent,
      { id: "agent-2", name: "CTO", role: "cto", title: "Chief Technology Officer", icon: null } as Agent,
    ]);

    expect(html).toContain("Assignee · Wesley");
    expect(html).toContain("Reviewer · CTO");
    expect(html).toContain("Owner");
    expect(html).toContain('data-slot="assignee-label"');
    expect(html).toContain('data-agent-avatar-style="bare"');
    expect(html).not.toContain('data-slot="assignee-agent-avatar-frame"');
    expect(html).not.toContain('data-slot="agent-title-badge"');
    expect(html).not.toContain("Founding Engineer");
    expect(html).not.toContain("Chief Technology Officer");
  });

  it("highlights the proposal review surface while an approval action is pending", () => {
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      body: "This should become a reviewed issue.",
      structuredPayload: {
        title: "Add proposal action feedback",
        priority: "medium",
        description: "Show local progress while Rudder is converting the proposal.",
      },
    }), undefined, undefined, "", { actionPending: true });

    const reviewBlockHtml = html.slice(html.indexOf('data-testid="proposal-review-block"'));
    expect(reviewBlockHtml).toContain('data-active-surface="proposal-action"');
    expect(reviewBlockHtml).toContain("chat-review-block--action-pending");
    expect(reviewBlockHtml).not.toContain("active-surface-ring");
  });

  it("renders approved issue creation as a compact proposal outcome", () => {
    const issueCreatedMessage = message({
      id: "system-issue-created",
      role: "system",
      kind: "system_event",
      body: "Created issue ZST-703 from this chat conversation.",
      structuredPayload: {
        eventType: "issue_created",
        issueId: "issue-703",
        issueIdentifier: "ZST-703",
        approvalId: "approval-1",
      },
      createdAt: new Date("2026-05-07T00:00:02.000Z"),
    });
    const approvalFeedbackMessage = message({
      id: "system-approval-feedback",
      role: "system",
      kind: "system_event",
      body: "Approved with execution feedback:\n\nUse the accepted direction and keep the scope tight.",
      structuredPayload: {
        eventType: "approval_feedback",
        issueId: "issue-703",
        issueIdentifier: "ZST-703",
        approvalId: "approval-1",
        decisionNote: "Use the accepted direction and keep the scope tight.",
      },
      createdAt: new Date("2026-05-07T00:00:03.000Z"),
    });
    const proposalMessage = message({
      id: "proposal-1",
      role: "assistant",
      kind: "issue_proposal",
      body: "Please review this proposal.",
      structuredPayload: {
        title: "Improve proposal outcome UI",
        priority: "medium",
        description: "Keep approval receipts attached to the review block.",
      },
      approvalId: "approval-1",
      approval: {
        id: "approval-1",
        orgId: "org-1",
        type: "chat_issue_creation",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        status: "approved",
        payload: {},
        decisionNote: "Use the accepted direction and keep the scope tight.",
        decidedByUserId: "board",
        decidedAt: new Date("2026-05-07T00:01:00.000Z"),
        createdAt: new Date("2026-05-07T00:00:00.000Z"),
        updatedAt: new Date("2026-05-07T00:01:00.000Z"),
      },
    });
    const html = renderProposalCard(proposalMessage, undefined, undefined, "", {
      issueCreatedMessage,
    });

    expect(shouldAttachIssueCreatedSystemMessage(proposalMessage, issueCreatedMessage)).toBe(true);
    expect(shouldAttachApprovalFeedbackSystemMessage(proposalMessage, issueCreatedMessage, approvalFeedbackMessage)).toBe(true);
    expect(html).toContain('data-testid="proposal-review-outcome"');
    expect(html).toContain('data-testid="proposal-review-receipt"');
    expect(html).toContain("Approved");
    expect(html).toContain("Issue ");
    expect(html).toContain('href="/issues/ZST-703"');
    expect(html).toContain(">ZST-703</a>");
    expect(html).toContain(" created");
    expect(html).toContain("Execution feedback");
    expect(html).toContain("Use the accepted direction and keep the scope tight.");
    expect(html).toContain("chat-review-note--approved");
    expect(html).not.toContain("Created issue ZST-703 from this chat conversation.");
    expect(html).not.toContain("Approved with execution feedback");
  });

  it("renders owner and reviewer as editable selectors while issue proposals are pending", () => {
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      body: "This should become an issue.",
      structuredPayload: {
        title: "Implement editable proposal principals",
        priority: "medium",
        description: "Allow operators to adjust the proposal owner and reviewer before approval.",
        assigneeAgentId: "agent-1",
        reviewerAgentId: "agent-2",
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
        createdAt: new Date("2026-05-07T00:00:00.000Z"),
        updatedAt: new Date("2026-05-07T00:00:00.000Z"),
      },
    }), conversation({}), [
      { id: "agent-1", name: "Wesley", role: "engineer", title: "Founding Engineer", icon: null } as Agent,
      { id: "agent-2", name: "CTO", role: "cto", title: "Chief Technology Officer", icon: null } as Agent,
    ], "", {
      currentUserId: "local-board",
      onIssueProposalChange: vi.fn(),
    });

    expect(html).toContain('aria-label="Edit owner"');
    expect(html).toContain('aria-label="Edit reviewer"');
    expect(html).toContain('aria-label="Edit status"');
    expect(html).toContain("grid-cols-[4.5rem_minmax(0,1fr)]");
    expect(html).toContain("w-full max-w-full justify-end");
    expect(html).toContain("Wesley");
    expect(html).toContain("CTO");
    expect(html).toContain('data-testid="proposal-review-note"');
    expect(html).toContain("Reply and execution feedback");
    expect(html).toContain("Optional for approval or rejection. Required for Request changes.");
    expect(html).toContain("rudder-mdxeditor-scope");
    expect(html).not.toContain("<textarea");
  });

  it("renders explicit no-owner reasons on issue proposal cards", () => {
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      body: "This should stay unassigned for now.",
      structuredPayload: {
        title: "Clarify execution owner",
        priority: "medium",
        description: "The operator should pick the owner after review.",
        assigneeUnassignedReason: "No suitable execution owner is known yet.",
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
        createdAt: new Date("2026-05-07T00:00:00.000Z"),
        updatedAt: new Date("2026-05-07T00:00:00.000Z"),
      },
    }), conversation({}), [], "", {
      currentUserId: "local-board",
      onIssueProposalChange: vi.fn(),
    });

    expect(html).toContain("No owner");
    expect(html).toContain("Reason: No suitable execution owner is known yet.");
    expect(html).not.toContain("Owner decision missing");
  });

  it("applies proposal metadata overrides to approval payloads", () => {
    const proposal = {
      title: "Route proposal edits",
      description: "Approve with the operator-edited owner and reviewer.",
      assigneeUserId: "local-board",
      reviewerAgentId: "agent-1",
      status: "todo",
    };

    const nextOwner = issueProposalWithPrincipalSelection(proposal, "assignee", "agent:agent-2");
    const nextReviewer = issueProposalWithPrincipalSelection(nextOwner, "reviewer", "user:local-board");
    const nextStatus = issueProposalWithStatus(nextReviewer, "in_review");
    const nextPriority = issueProposalWithPriority(nextStatus, "critical");
    const payload = chatIssueApprovalPayloadWithProposalOverride({
      chatConversationId: "chat-1",
      chatMessageId: "message-1",
      proposedIssue: {
        title: "Original title",
        description: "Original description",
        assigneeUserId: "someone-else",
        reviewerAgentId: "agent-1",
        status: "todo",
      },
    }, nextPriority);

    expect(issueProposalPrincipalSelectionValue(nextPriority, "assignee")).toBe("agent:agent-2");
    expect(issueProposalPrincipalSelectionValue(nextPriority, "reviewer")).toBe("user:local-board");
    expect(payload.proposedIssue).toMatchObject({
      title: "Route proposal edits",
      description: "Approve with the operator-edited owner and reviewer.",
      status: "in_review",
      priority: "critical",
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      reviewerAgentId: null,
      reviewerUserId: "local-board",
    });
  });

  it("links replying agent attribution to agent detail", () => {
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      body: "Open the agent detail from this message.",
      replyingAgentId: "agent-1",
      structuredPayload: {
        title: "Check attribution link",
        priority: "medium",
        description: "The assistant attribution should link to the agent detail.",
      },
    }), conversation({}), [
      { id: "agent-1", name: "Wesley", role: "engineer", title: "Founding Engineer", icon: null } as Agent,
    ]);

    expect(html).toContain('href="/agents/wesley"');
    expect(html).toContain('aria-label="Open Wesley agent detail"');
  });

  it("renders uploaded replying agent avatars without the assistant avatar shell", () => {
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      body: "Use the uploaded image avatar directly.",
      replyingAgentId: "agent-1",
      structuredPayload: {
        title: "Review image avatar",
        priority: "medium",
        description: "The assistant attribution should use the raw avatar image.",
      },
    }), conversation({}), [
      {
        id: "agent-1",
        name: "Wesley",
        role: "engineer",
        title: "Founding Engineer",
        icon: "asset:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      } as Agent,
    ]);

    expect(html).toContain('src="/api/assets/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/content"');
    expect(html).toContain("h-8 w-8 shrink-0");
    expect(html).not.toContain("border-border/70");
    expect(html).not.toContain("bg-muted/90");
    expect(html).not.toContain("shadow-sm");
  });

  it("renders DiceBear replying agent avatars without the assistant avatar shell", () => {
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      body: "Use the generated avatar directly.",
      replyingAgentId: "agent-1",
      structuredPayload: {
        title: "Review generated avatar",
        priority: "medium",
        description: "The assistant attribution should use the raw generated avatar image.",
      },
    }), conversation({}), [
      {
        id: "agent-1",
        name: "Wesley",
        role: "engineer",
        title: "Founding Engineer",
        icon: "dicebear:notionists:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      } as Agent,
    ]);

    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain("h-8 w-8 shrink-0");
    expect(html).not.toContain("border-border/70");
    expect(html).not.toContain("bg-muted/90");
    expect(html).not.toContain("shadow-sm");
  });

  it("renders generated replying agent avatars when the stored icon is missing", () => {
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      body: "Use a generated fallback avatar.",
      replyingAgentId: "agent-1",
      structuredPayload: {
        title: "Review missing avatar",
        priority: "medium",
        description: "The assistant attribution should not fall back to the bot glyph.",
      },
    }), conversation({}), [
      {
        id: "agent-1",
        name: "Mira",
        role: "general",
        title: "Operator",
        icon: null,
      } as Agent,
    ]);

    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain("h-8 w-8 shrink-0");
    expect(html).not.toContain("border-border/70");
    expect(html).not.toContain("bg-muted/90");
    expect(html).not.toContain("shadow-sm");
  });

  it("renders generated replying agent avatars while the agent directory is unavailable", () => {
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      body: "Use a generated fallback avatar before agent data loads.",
      replyingAgentId: "agent-1",
      structuredPayload: {
        title: "Review unloaded avatar",
        priority: "medium",
        description: "The assistant attribution should not flash the bot glyph.",
      },
    }), conversation({}), []);

    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain("h-8 w-8 shrink-0");
    expect(html).not.toContain("border-border/70");
    expect(html).not.toContain("bg-muted/90");
    expect(html).not.toContain("shadow-sm");
  });

  it("shows revision-requested issue proposals as read-only requested changes", () => {
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "issue_proposal",
      body: "Please review this proposal.",
      structuredPayload: {
        title: "Fix approval flow",
        priority: "high",
        description: "Create a better review loop.",
      },
      approvalId: "approval-1",
      approval: {
        id: "approval-1",
        orgId: "org-1",
        type: "chat_issue_creation",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        status: "revision_requested",
        payload: {},
        decisionNote: "Assign the issue to the creating agent.",
        decidedByUserId: "board",
        decidedAt: new Date("2026-05-07T00:01:00.000Z"),
        createdAt: new Date("2026-05-07T00:00:00.000Z"),
        updatedAt: new Date("2026-05-07T00:01:00.000Z"),
      },
    }));

    expect(html).toContain("Requested changes");
    expect(html).toContain("chat-review-note--revision");
    expect(html).toContain("chat-review-note-icon");
    expect(html).toContain("Assign the issue to the creating agent.");
    expect(html).not.toContain("Feedback for agent");
    expect(html).not.toContain(">Approve</button>");
    expect(html).not.toContain(">Request changes</button>");
    expect(html).not.toContain(">Reject</button>");
  });

  it("shows requested changes for lightweight operation proposals", () => {
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "operation_proposal",
      body: "Please review this change.",
      structuredPayload: {
        operationProposal: {
          targetType: "agent",
          targetId: "agent-1",
          summary: "Update agent title",
          patch: { title: "Founding Engineer" },
        },
        operationProposalState: {
          status: "revision_requested",
          decisionNote: "Use a role-specific title.",
          decidedByUserId: "board",
          decidedAt: "2026-05-07T00:01:00.000Z",
        },
      },
    }));

    expect(html).toContain("Requested changes");
    expect(html).toContain("chat-review-note--revision");
    expect(html).toContain("chat-review-note-icon");
    expect(html).toContain("Use a role-specific title.");
    expect(html).not.toContain("Feedback for agent");
    expect(html).not.toContain(">Approve</button>");
    expect(html).not.toContain(">Request changes</button>");
    expect(html).not.toContain(">Reject</button>");
  });

  it("keeps pending review guidance visible for lightweight operation proposals", () => {
    const html = renderProposalCard(message({
      role: "assistant",
      kind: "operation_proposal",
      body: "Please review this lightweight change.",
      structuredPayload: {
        operationProposal: {
          targetType: "agent",
          targetId: "agent-1",
          summary: "Update agent title",
          patch: { title: "Founding Engineer" },
        },
      },
    }));

    expect(html).toContain("Operation proposal");
    expect(html).toContain("Review this proposal here before continuing the conversation.");
  });
});

describe("proposal revision prompts", () => {
  it("builds an agent-facing revision prompt from operator feedback", () => {
    expect(buildChatProposalRevisionPrompt({
      proposalTitle: "Fix approval flow",
      feedback: "Assign the issue to the creating agent.",
    })).toContain("Please revise the proposal \"Fix approval flow\"");
    expect(buildChatProposalRevisionPrompt({
      proposalTitle: "Fix approval flow",
      feedback: "Assign the issue to the creating agent.",
    })).toContain("Return a new proposal for review. Do not create the issue or apply the change yet.");
  });

  it("builds an agent-facing rejection feedback prompt from operator feedback", () => {
    expect(buildChatProposalRejectFeedbackPrompt({
      proposalTitle: "Fix approval flow",
      feedback: "This solves the wrong workflow.",
    })).toContain("I rejected the proposal \"Fix approval flow\".");
    expect(buildChatProposalRejectFeedbackPrompt({
      proposalTitle: "Fix approval flow",
      feedback: "This solves the wrong workflow.",
    })).toContain("Continue from this feedback. Do not create the issue or apply the change unless I approve a new proposal.");
  });
});

describe("interrupted chat messages", () => {
  it("labels interrupted assistant messages and exposes continuation intent", () => {
    const interrupted = message({
      role: "assistant",
      kind: "message",
      status: "interrupted",
      body: "Partial preserved reply",
    });

    expect(assistantStateLabel("interrupted")).toBe("Interrupted");
    expect(statusChipClassName("interrupted")).toContain("amber");
    expect(canContinueInterruptedChatMessage(interrupted)).toBe(true);
    expect(INTERRUPTED_CHAT_CONTINUATION_PROMPT).toBe("Continue from the interrupted chat run.");
  });

  it("does not offer continuation for completed or user messages", () => {
    expect(canContinueInterruptedChatMessage(message({ role: "assistant", status: "completed" }))).toBe(false);
    expect(canContinueInterruptedChatMessage(message({ role: "user", status: "interrupted" }))).toBe(false);
  });
});

describe("failed chat retry", () => {
  it("offers retry for failed assistant messages in a turn", () => {
    expect(canRetryFailedChatMessage(message({
      role: "assistant",
      kind: "message",
      status: "failed",
      chatTurnId: "turn-1",
    }))).toBe(true);

    expect(canRetryFailedChatMessage(message({
      role: "assistant",
      kind: "message",
      status: "failed",
      chatTurnId: null,
    }))).toBe(false);
    expect(canRetryFailedChatMessage(message({
      role: "assistant",
      kind: "message",
      status: "completed",
      chatTurnId: "turn-1",
    }))).toBe(false);
    expect(canRetryFailedChatMessage(message({
      role: "user",
      kind: "message",
      status: "failed",
      chatTurnId: "turn-1",
    }))).toBe(false);
  });

  it("does not offer retry for failed messages marked non-retryable", () => {
    expect(canRetryFailedChatMessage(message({
      role: "assistant",
      kind: "message",
      status: "failed",
      chatTurnId: "turn-1",
      structuredPayload: {
        recoverableFailure: {
          recoverable: false,
          retryable: false,
          phase: "runtime_boot",
          code: "chat_runtime_boot_failed",
          message: "Fix runtime setup first.",
        },
      },
    }))).toBe(false);
  });

  it("offers refresh for completed assistant messages in a turn", () => {
    expect(canRefreshAssistantChatMessage(message({
      role: "assistant",
      kind: "message",
      status: "completed",
      chatTurnId: "turn-1",
    }))).toBe(true);

    expect(canRefreshAssistantChatMessage(message({
      role: "assistant",
      kind: "message",
      status: "streaming",
      chatTurnId: "turn-1",
    }))).toBe(false);
    expect(canRefreshAssistantChatMessage(message({
      role: "assistant",
      kind: "message",
      status: "failed",
      chatTurnId: "turn-1",
    }))).toBe(false);
    expect(canRefreshAssistantChatMessage(message({
      role: "assistant",
      kind: "message",
      status: "interrupted",
      chatTurnId: "turn-1",
    }))).toBe(false);
    expect(canRefreshAssistantChatMessage(message({
      role: "assistant",
      kind: "message",
      status: "stopped",
      chatTurnId: "turn-1",
    }))).toBe(false);
    expect(canRefreshAssistantChatMessage(message({
      role: "assistant",
      kind: "message",
      status: "completed",
      chatTurnId: null,
    }))).toBe(false);
    expect(canRefreshAssistantChatMessage(message({
      role: "user",
      kind: "message",
      status: "completed",
      chatTurnId: "turn-1",
    }))).toBe(false);
  });

  it("only offers displayed refresh on the active completed branch when no reply is running", () => {
    const completedAssistant = message({
      role: "assistant",
      kind: "message",
      status: "completed",
      chatTurnId: "turn-1",
    });

    expect(canRefreshDisplayedAssistantChatMessage({
      message: completedAssistant,
      branchControls: null,
      hasActiveReply: false,
    })).toBe(true);
    expect(canRefreshDisplayedAssistantChatMessage({
      message: completedAssistant,
      branchControls: { current: 2, total: 2 },
      hasActiveReply: false,
    })).toBe(true);
    expect(canRefreshDisplayedAssistantChatMessage({
      message: completedAssistant,
      branchControls: { current: 1, total: 2 },
      hasActiveReply: false,
    })).toBe(false);
    expect(canRefreshDisplayedAssistantChatMessage({
      message: completedAssistant,
      branchControls: { current: 2, total: 2 },
      hasActiveReply: true,
    })).toBe(false);
    expect(canRefreshDisplayedAssistantChatMessage({
      message: message({
        role: "assistant",
        kind: "message",
        status: "failed",
        chatTurnId: "turn-1",
      }),
      branchControls: { current: 2, total: 2 },
      hasActiveReply: false,
    })).toBe(false);
  });

  it("finds the same-turn user message as the retry source", () => {
    const source = message({
      id: "user-1",
      role: "user",
      kind: "message",
      body: "Retry this request",
      chatTurnId: "turn-1",
      turnVariant: 2,
    });
    const failed = message({
      id: "assistant-1",
      role: "assistant",
      kind: "message",
      status: "failed",
      chatTurnId: "turn-1",
      turnVariant: 2,
    });

    expect(findRetrySourceUserMessage([
      message({ id: "user-other", role: "user", chatTurnId: "turn-1", turnVariant: 1 }),
      source,
    ], failed)).toBe(source);
  });
});

describe("isUserVisibleIncomingChatMessage", () => {
  it("ignores empty assistant placeholders until visible content appears", () => {
    expect(isUserVisibleIncomingChatMessage(message({
      role: "assistant",
      kind: "message",
      status: "streaming",
      body: "",
    }))).toBe(false);

    expect(isUserVisibleIncomingChatMessage(message({
      role: "assistant",
      kind: "message",
      status: "streaming",
      body: "First visible token",
    }))).toBe(true);
  });

  it("treats structured incoming cards as visible messages", () => {
    expect(isUserVisibleIncomingChatMessage(message({
      role: "assistant",
      kind: "issue_proposal",
      body: "",
    }))).toBe(true);

    expect(isUserVisibleIncomingChatMessage(message({
      role: "user",
      kind: "message",
      body: "User-authored text",
    }))).toBe(false);
  });
});

describe("ask_user chat messages", () => {
  const askUserPayload = {
    requestUserInput: {
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which scope should the agent implement?",
          options: [
            { id: "narrow", label: "Narrow path", description: "Smallest shippable path", recommended: true },
            { id: "broad", label: "Broad path" },
          ],
          allowFreeform: true,
        },
      ],
    },
  };

  it("finds the latest visible unanswered ask_user message by branch order", () => {
    const firstAsk = message({
      id: "ask-1",
      role: "assistant",
      kind: "ask_user",
      body: "Need scope.",
      structuredPayload: askUserPayload,
      createdAt: new Date("2026-05-07T00:00:01.000Z"),
    });
    const firstAnswer = message({
      id: "user-2",
      role: "user",
      kind: "message",
      body: "Use the narrow path.",
      createdAt: new Date("2026-05-07T00:00:02.000Z"),
    });
    const secondAsk = message({
      id: "ask-2",
      role: "assistant",
      kind: "ask_user",
      body: "Need review route.",
      structuredPayload: askUserPayload,
      createdAt: new Date("2026-05-07T00:00:03.000Z"),
    });

    const messages = [firstAsk, firstAnswer, secondAsk];
    expect(askUserRequestFromMessage(firstAsk)?.questions[0]?.id).toBe("scope");
    expect(isAskUserMessageAnswered(firstAsk, messages)).toBe(true);
    expect(isAskUserMessageAnswered(secondAsk, messages)).toBe(false);
    expect(findLatestUnansweredAskUserMessage(messages)).toBe(secondAsk);
  });

  it("treats a visible superseded branch answer as answered", () => {
    const ask = message({
      id: "ask-branch",
      role: "assistant",
      kind: "ask_user",
      body: "Need scope.",
      structuredPayload: askUserPayload,
      createdAt: new Date("2026-05-07T00:00:01.000Z"),
    });
    const answer = message({
      id: "answer-branch",
      role: "user",
      kind: "message",
      body: formatAskUserAnswerMessage(askUserPayload.requestUserInput, {
        scope: { kind: "option", label: "Narrow path" },
      }),
      chatTurnId: "answer-turn",
      turnVariant: 0,
      supersededAt: new Date("2026-05-07T00:00:04.000Z"),
      createdAt: new Date("2026-05-07T00:00:02.000Z"),
    });
    const failedReply = message({
      id: "failed-branch",
      role: "assistant",
      kind: "message",
      status: "failed",
      chatTurnId: "answer-turn",
      turnVariant: 0,
      supersededAt: new Date("2026-05-07T00:00:04.000Z"),
      createdAt: new Date("2026-05-07T00:00:03.000Z"),
    });
    const visibleBranch = computeDisplayedChatMessages(
      [ask, answer, failedReply],
      { chatTurnId: "answer-turn", turnVariant: 0 },
    );

    expect(isAskUserMessageAnswered(ask, visibleBranch)).toBe(true);
    expect(findLatestUnansweredAskUserMessage(visibleBranch)).toBeNull();
    expect(askUserAnswerFromMessage(answer, visibleBranch)).toEqual([
      { questionId: "scope", title: "Scope", answer: "Narrow path" },
    ]);
  });

  it("formats selected and freeform answers as a normal user message", () => {
    const request = askUserPayload.requestUserInput;
    const body = formatAskUserAnswerMessage(request, {
      scope: {
        kind: "freeform",
        text: [
          "Use the narrow path",
          "- keep API extensible",
          "- defer broad UI",
        ].join("\n"),
      },
    });

    expect(body).toBe([
      "Answering the requested input:",
      "",
      "- Scope",
      "  Answer: Use the narrow path",
      "    - keep API extensible",
      "    - defer broad UI",
    ].join("\n"));
    expect(parseAskUserAnswerMessage(request, body)).toEqual([
      {
        questionId: "scope",
        title: "Scope",
        answer: [
          "Use the narrow path",
          "- keep API extensible",
          "- defer broad UI",
        ].join("\n"),
      },
    ]);
  });

  it("formats multiple selected answers as a normal user message", () => {
    const request = {
      questions: [
        {
          ...askUserPayload.requestUserInput.questions[0],
          selectionMode: "multiple" as const,
        },
      ],
    };
    const body = formatAskUserAnswerMessage(request, {
      scope: {
        kind: "options",
        labels: ["Narrow path", "Broad path"],
      },
    });

    expect(body).toBe([
      "Answering the requested input:",
      "",
      "- Scope",
      "  Answer: Narrow path, Broad path",
    ].join("\n"));
    expect(parseAskUserAnswerMessage(request, body)).toEqual([
      {
        questionId: "scope",
        title: "Scope",
        answer: "Narrow path, Broad path",
      },
    ]);
  });

  it("parses legacy multiline freeform bullets without treating them as question titles", () => {
    const request = askUserPayload.requestUserInput;
    const body = [
      "Answering the requested input:",
      "",
      "- Scope",
      "  Answer: Use the narrow path",
      "- keep API extensible",
      "- defer broad UI",
    ].join("\n");

    expect(parseAskUserAnswerMessage(request, body)).toEqual([
      {
        questionId: "scope",
        title: "Scope",
        answer: [
          "Use the narrow path",
          "- keep API extensible",
          "- defer broad UI",
        ].join("\n"),
      },
    ]);
  });

  it("matches a structured ask_user answer to the preceding request", () => {
    const ask = message({
      id: "ask-1",
      role: "assistant",
      kind: "ask_user",
      body: "Need scope.",
      structuredPayload: askUserPayload,
      createdAt: new Date("2026-05-07T00:00:01.000Z"),
    });
    const answer = message({
      id: "answer-1",
      role: "user",
      kind: "message",
      body: "Answering the requested input:\n\n- Scope\n  Answer: Narrow path",
      createdAt: new Date("2026-05-07T00:00:02.000Z"),
    });

    expect(askUserAnswerFromMessage(answer, [ask, answer])).toEqual([
      {
        questionId: "scope",
        title: "Scope",
        answer: "Narrow path",
      },
    ]);
  });
});

describe("computeDisplayedChatMessages", () => {
  it("preserves system events created after a previewed turn", () => {
    const messages = [
      message({
        id: "user-1",
        role: "user",
        kind: "message",
        body: "please draft another issue",
        chatTurnId: "turn-1",
        turnVariant: 0,
        createdAt: new Date("2026-05-07T00:00:00.000Z"),
      }),
      message({
        id: "proposal-1",
        role: "assistant",
        kind: "issue_proposal",
        body: "Create a scoped issue.",
        chatTurnId: "turn-1",
        turnVariant: 0,
        createdAt: new Date("2026-05-07T00:00:01.000Z"),
      }),
      message({
        id: "system-1",
        role: "system",
        kind: "system_event",
        body: "Created issue ZST-29 from this chat conversation.",
        structuredPayload: {
          eventType: "issue_created",
          issueId: "issue-29",
          issueIdentifier: "ZST-29",
        },
        chatTurnId: null,
        createdAt: new Date("2026-05-07T00:00:02.000Z"),
      }),
    ];

    expect(computeDisplayedChatMessages(messages, { chatTurnId: "turn-1", turnVariant: 0 }).map((row) => row.id))
      .toEqual(["user-1", "proposal-1", "system-1"]);
  });

  it("keeps prior turn variants visible while a newer variant is still streaming", () => {
    const messages = [
      message({
        id: "user-v0",
        role: "user",
        kind: "message",
        body: "Original request",
        chatTurnId: "turn-1",
        turnVariant: 0,
        supersededAt: new Date("2026-05-07T00:01:00.000Z"),
        createdAt: new Date("2026-05-07T00:00:00.000Z"),
      }),
      message({
        id: "assistant-v0",
        role: "assistant",
        kind: "message",
        body: "Original response",
        chatTurnId: "turn-1",
        turnVariant: 0,
        supersededAt: new Date("2026-05-07T00:01:00.000Z"),
        createdAt: new Date("2026-05-07T00:00:01.000Z"),
      }),
      message({
        id: "context-after",
        role: "system",
        kind: "system_event",
        body: "Unrelated system event.",
        chatTurnId: null,
        supersededAt: null,
        createdAt: new Date("2026-05-07T00:00:02.000Z"),
      }),
    ];

    expect(computeDisplayedChatMessages(messages, { chatTurnId: "turn-1", turnVariant: 0 }).map((row) => row.id))
      .toEqual(["user-v0", "assistant-v0", "context-after"]);
  });
});

describe("scrollChatMessagesToBottom", () => {
  it("scrolls the message region to its full height without animation", () => {
    const scrollTo = vi.fn();
    const element = {
      scrollHeight: 1248,
      scrollTo,
    } as unknown as Pick<HTMLElement, "scrollHeight" | "scrollTo">;

    scrollChatMessagesToBottom(element);

    expect(scrollTo).toHaveBeenCalledWith({ top: 1248, behavior: "auto" });
  });
});

describe("chat scoped pending files", () => {
  it("keeps pending attachments scoped by conversation", () => {
    const chatOneFiles = [{ name: "chat-one.png" }];
    const chatTwoFiles = [{ name: "chat-two.txt" }];
    let scopes: Record<string, Array<{ name: string }>> = {};

    scopes = updateChatScopedPendingFiles(scopes, "org-1:chat-1", () => chatOneFiles);
    scopes = updateChatScopedPendingFiles(scopes, "org-1:chat-2", () => chatTwoFiles);

    expect(readChatScopedPendingFiles(scopes, "org-1:chat-1")).toBe(chatOneFiles);
    expect(readChatScopedPendingFiles(scopes, "org-1:chat-2")).toBe(chatTwoFiles);
    expect(readChatScopedPendingFiles(scopes, "org-1:chat-3")).toEqual([]);
  });

  it("clears only the active conversation attachment scope", () => {
    const chatOneFiles = [{ name: "chat-one.png" }];
    const chatTwoFiles = [{ name: "chat-two.txt" }];
    let scopes: Record<string, Array<{ name: string }>> = {
      "org-1:chat-1": chatOneFiles,
      "org-1:chat-2": chatTwoFiles,
    };

    scopes = updateChatScopedPendingFiles<{ name: string }>(scopes, "org-1:chat-1", () => []);

    expect(readChatScopedPendingFiles(scopes, "org-1:chat-1")).toEqual([]);
    expect(readChatScopedPendingFiles(scopes, "org-1:chat-2")).toBe(chatTwoFiles);
    expect(scopes).not.toHaveProperty("org-1:chat-1");
  });
});

describe("chat image attachment actions", () => {
  it("adds an image extension when sending image data to desktop actions", async () => {
    const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });

    await expect(createImageDesktopPayload(blob, "screenshot")).resolves.toEqual({
      filename: "screenshot.png",
      contentType: "image/png",
      base64: "iVBORw==",
    });
  });

  it("keeps existing image filenames intact", () => {
    expect(resolveImageFilename("diagram.webp", "image/png")).toBe("diagram.webp");
    expect(resolveImageFilename("avatar", "image/jpeg")).toBe("avatar.jpg");
  });
});

describe("withOptimisticPlanMode", () => {
  it("updates plan mode before the server refetch completes", () => {
    const original = conversation({ planMode: false });

    const optimistic = withOptimisticPlanMode(original, true);

    expect(optimistic).not.toBe(original);
    expect(optimistic.planMode).toBe(true);
    expect(optimistic.updatedAt.getTime()).toBeGreaterThan(original.updatedAt.getTime());
  });

  it("keeps the same conversation object when plan mode is already current", () => {
    const original = conversation({ planMode: true });

    expect(withOptimisticPlanMode(original, true)).toBe(original);
  });
});

describe("withOptimisticOutgoingMessage", () => {
  it("promotes a default new chat title from the outgoing message", () => {
    const original = conversation({ title: "New chat" });
    const sentAt = new Date("2026-05-13T09:00:00.000Z");

    const optimistic = withOptimisticOutgoingMessage(
      original,
      "chat 场景还需要加上 ask user for question 的 kind，我们来讨论下",
      sentAt,
    );

    expect(optimistic.title).toBe("chat 场景还需要加上 ask user for question 的 kind，我们来讨论下");
    expect(optimistic.summary).toBe("chat 场景还需要加上 ask user for question 的 kind，我们来讨论下");
    expect(optimistic.lastMessageAt).toBe(sentAt);
  });

  it("preserves explicit chat titles during optimistic sends", () => {
    const original = conversation({ title: "Already named" });

    const optimistic = withOptimisticOutgoingMessage(original, "new message", new Date());

    expect(optimistic.title).toBe("Already named");
  });
});

describe("mergeMessengerThreadSummaries", () => {
  it("keeps pinned chats ahead of newer unpinned optimistic updates", () => {
    const pinnedOlder = messengerThread({
      threadKey: "chat:pinned-older",
      title: "Pinned older",
      isPinned: true,
      latestActivityAt: new Date("2026-05-01T08:00:00.000Z"),
    });
    const recentUnpinned = messengerThread({
      threadKey: "chat:recent",
      title: "Recent",
      latestActivityAt: new Date("2026-05-03T08:00:00.000Z"),
    });
    const incomingUnpinned = messengerThread({
      threadKey: "chat:incoming",
      title: "Incoming",
      latestActivityAt: new Date("2026-05-04T08:00:00.000Z"),
    });

    const merged = mergeMessengerThreadSummaries([recentUnpinned, pinnedOlder], incomingUnpinned);

    expect(merged.map((thread) => thread.threadKey)).toEqual([
      "chat:pinned-older",
      "chat:incoming",
      "chat:recent",
    ]);
  });
});

describe("isChatAgentSelectionLocked", () => {
  it("keeps historical unassigned conversations repairable", () => {
    expect(isChatAgentSelectionLocked({
      hasConversation: true,
      preferredAgentId: null,
      hasActiveStream: false,
      hasActiveSendInFlight: false,
    })).toBe(false);
  });

  it("locks historical conversations once a real preferred agent is selected", () => {
    expect(isChatAgentSelectionLocked({
      hasConversation: true,
      preferredAgentId: "agent-1",
      hasActiveStream: false,
      hasActiveSendInFlight: false,
    })).toBe(true);
  });

  it("locks persisted assigned conversations before the first message", () => {
    expect(isChatAgentSelectionLocked({
      hasConversation: true,
      preferredAgentId: "agent-1",
      hasActiveStream: false,
      hasActiveSendInFlight: false,
    })).toBe(true);
  });

  it("locks unassigned conversations while a send or stream is active", () => {
    expect(isChatAgentSelectionLocked({
      hasConversation: true,
      preferredAgentId: null,
      hasActiveStream: true,
      hasActiveSendInFlight: false,
    })).toBe(true);
    expect(isChatAgentSelectionLocked({
      hasConversation: true,
      preferredAgentId: null,
      hasActiveStream: false,
      hasActiveSendInFlight: true,
    })).toBe(true);
  });
});

describe("isChatProjectSelectionLocked", () => {
  it("keeps draft conversations editable before work starts", () => {
    expect(isChatProjectSelectionLocked({
      hasConversation: true,
      hasLastMessageAt: false,
      hasMessages: false,
      hasActiveStream: false,
      hasActiveSendInFlight: false,
    })).toBe(false);
  });

  it("locks conversations after messages or active sends exist", () => {
    expect(isChatProjectSelectionLocked({
      hasConversation: true,
      hasLastMessageAt: true,
      hasMessages: false,
      hasActiveStream: false,
      hasActiveSendInFlight: false,
    })).toBe(true);
    expect(isChatProjectSelectionLocked({
      hasConversation: true,
      hasLastMessageAt: false,
      hasMessages: true,
      hasActiveStream: false,
      hasActiveSendInFlight: false,
    })).toBe(true);
    expect(isChatProjectSelectionLocked({
      hasConversation: true,
      hasLastMessageAt: false,
      hasMessages: false,
      hasActiveStream: false,
      hasActiveSendInFlight: true,
    })).toBe(true);
  });
});
