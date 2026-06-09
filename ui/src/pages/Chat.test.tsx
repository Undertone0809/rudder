// @vitest-environment node

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, ChatConversation, ChatMessage, Issue, MessengerThreadSummary, Project } from "@rudderhq/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import {
  ChatSystemMessageBody,
  ChatMessageItem,
  INTERRUPTED_CHAT_CONTINUATION_PROMPT,
  ProposalCard,
  CHAT_PROJECT_BY_AGENT_STORAGE_KEY,
  NO_PROJECT_ID,
  askUserAnswerFromMessage,
  assistantStateLabel,
  buildChatProposalRevisionPrompt,
  buildDraftChatContextLinks,
  chatIssueApprovalPayloadWithProposalOverride,
  canContinueInterruptedChatMessage,
  canRetryFailedChatMessage,
  chatEmptyStateHeading,
  computeDisplayedChatMessages,
  draftIssueContextLabel,
  askUserRequestFromMessage,
  findLatestUnansweredAskUserMessage,
  findRetrySourceUserMessage,
  formatAskUserAnswerMessage,
  isChatAgentSelectionLocked,
  isChatProjectSelectionLocked,
  isAskUserMessageAnswered,
  isUserVisibleIncomingChatMessage,
  issueProposalPrincipalSelectionValue,
  issueProposalWithPrincipalSelection,
  parseAskUserAnswerMessage,
  rememberChatProjectId,
  rememberChatProjectIdForAgent,
  resolveDefaultDraftChatProjectId,
  resolveDraftIssueContext,
  scrollChatMessagesToBottom,
  statusChipClassName,
  withOptimisticOutgoingMessage,
  withOptimisticPlanMode,
} from "./Chat";
import { mergeMessengerThreadSummaries } from "./Chat.parts";
import {
  createImageDesktopPayload,
  resolveImageFilename,
} from "@/lib/image-actions";
import {
  readChatScopedPendingFiles,
  updateChatScopedPendingFiles,
} from "@/lib/chat-pending-attachments";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/chat" }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams()],
}));

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
    title: "Plan mode chat",
    summary: null,
    latestReplyPreview: null,
    latestUserMessagePreview: null,
    userMessageCount: 0,
    preferredAgentId: null,
    routedAgentId: null,
    primaryIssueId: null,
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

function renderChatMessageItem(messageToRender: ChatMessage) {
  return renderToStaticMarkup(
    <ThemeProvider>
      <ChatMessageItem
        conversation={conversation({})}
        message={messageToRender}
        agents={[]}
        decisionNote=""
        onDecisionNoteChange={vi.fn()}
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

function renderProposalCard(
  message: ChatMessage,
  chat: ChatConversation = conversation({}),
  agents?: Agent[],
  decisionNote = "",
  extraProps: Partial<Pick<Parameters<typeof ProposalCard>[0], "currentUserId" | "issueProposalOverride" | "onIssueProposalChange">> = {},
) {
  return renderToStaticMarkup(
    <ThemeProvider>
      <ProposalCard
        conversation={chat}
        message={message}
        agents={agents}
        decisionNote={decisionNote}
        onDecisionNoteChange={vi.fn()}
        onApprovalAction={vi.fn()}
        {...extraProps}
        onResolveOperationProposal={vi.fn()}
        onConvertToIssue={vi.fn()}
        actionPending={false}
        skillReferences={[]}
      />
    </ThemeProvider>,
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
    expect(html).toContain("<strong>approved</strong>");
    expect(html).not.toContain("chat-system-issue-link");
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
    expect(html).toContain("grid-cols-[4.5rem_minmax(0,1fr)]");
    expect(html).toContain("w-full max-w-full justify-end");
    expect(html).toContain("Wesley");
    expect(html).toContain("CTO");
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

  it("applies proposal principal overrides to approval payloads", () => {
    const proposal = {
      title: "Route proposal edits",
      description: "Approve with the operator-edited owner and reviewer.",
      assigneeUserId: "local-board",
      reviewerAgentId: "agent-1",
    };

    const nextOwner = issueProposalWithPrincipalSelection(proposal, "assignee", "agent:agent-2");
    const nextReviewer = issueProposalWithPrincipalSelection(nextOwner, "reviewer", "user:local-board");
    const payload = chatIssueApprovalPayloadWithProposalOverride({
      chatConversationId: "chat-1",
      chatMessageId: "message-1",
      proposedIssue: {
        title: "Original title",
        description: "Original description",
        assigneeUserId: "someone-else",
        reviewerAgentId: "agent-1",
      },
    }, nextReviewer);

    expect(issueProposalPrincipalSelectionValue(nextReviewer, "assignee")).toBe("agent:agent-2");
    expect(issueProposalPrincipalSelectionValue(nextReviewer, "reviewer")).toBe("user:local-board");
    expect(payload.proposedIssue).toMatchObject({
      title: "Route proposal edits",
      description: "Approve with the operator-edited owner and reviewer.",
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
      hasLastMessageAt: true,
      hasMessages: true,
      hasActiveStream: false,
      hasActiveSendInFlight: false,
    })).toBe(false);
  });

  it("locks historical conversations once a real preferred agent is selected", () => {
    expect(isChatAgentSelectionLocked({
      hasConversation: true,
      preferredAgentId: "agent-1",
      hasLastMessageAt: true,
      hasMessages: true,
      hasActiveStream: false,
      hasActiveSendInFlight: false,
    })).toBe(true);
  });

  it("locks unassigned conversations while a send or stream is active", () => {
    expect(isChatAgentSelectionLocked({
      hasConversation: true,
      preferredAgentId: null,
      hasLastMessageAt: false,
      hasMessages: false,
      hasActiveStream: true,
      hasActiveSendInFlight: false,
    })).toBe(true);
    expect(isChatAgentSelectionLocked({
      hasConversation: true,
      preferredAgentId: null,
      hasLastMessageAt: false,
      hasMessages: false,
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
