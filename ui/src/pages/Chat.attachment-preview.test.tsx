// @vitest-environment jsdom

import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import { SidePanelProvider, useSidePanel } from "@/context/SidePanelContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { readChatAskUserDraft } from "@/lib/chat-draft-storage";
import {
  resetChatPendingAttachmentsForTests,
  resolveChatPendingAttachmentScopeKey,
  updateChatPendingAttachmentsForScope,
} from "@/lib/chat-pending-attachments";
import { buildAgentMentionHref, buildAutomationMentionHref, buildChatMentionHref, buildIssueMentionHref, type Agent, type AutomationDetail, type AutomationRunSummary, type ChatConversation, type ChatMessage, type ChatQueuedMessage, type ChatQueueSnapshot, type Goal, type Issue, type IssueComment, type IssueLabel, type OrganizationWorkspaceFileEntry, type Project } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "./Chat";
import { ChatSidePanel } from "./Chat.side-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PREVIEW_IMAGE_SRC =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='480' height='320' viewBox='0 0 480 320'%3E%3Crect width='480' height='320' fill='%232f80ed'/%3E%3Ctext x='240' y='168' fill='white' font-size='34' font-family='Arial' text-anchor='middle'%3EPreview%3C/text%3E%3C/svg%3E";

const mockState = vi.hoisted(() => ({
  conversationId: "chat-1" as string | null,
  conversations: [] as ChatConversation[],
  messagesByChatId: {} as Record<string, ChatMessage[]>,
  pendingChatDetailIds: new Set<string>(),
  issues: {} as Record<string, Issue>,
  issueComments: {} as Record<string, IssueComment[]>,
  agents: [] as Agent[],
  goals: [] as Goal[],
  labels: [] as IssueLabel[],
  automations: {} as Record<string, AutomationDetail>,
  automationRuns: {} as Record<string, AutomationRunSummary[]>,
  projects: [] as Project[],
  workspaceDirectories: {} as Record<string, { directoryPath: string; entries: OrganizationWorkspaceFileEntry[] }>,
  workspaceFiles: {} as Record<string, { filePath: string; content: string | null; contentType: string | null; previewKind: "text" | "image" | "pdf" | "binary"; contentPath: string | null; truncated: boolean }>,
  queueSnapshot: { activeGenerationId: null, items: [] } as ChatQueueSnapshot,
  cancelQueuedMessage: vi.fn(),
  createQueuedMessage: vi.fn(),
  steerQueuedMessage: vi.fn(),
  updateQueuedMessage: vi.fn(),
  invalidateQueries: vi.fn(),
  markRead: vi.fn(),
  mutations: [] as unknown[],
  navigate: vi.fn(),
  pushToast: vi.fn(),
  queryKeys: [] as unknown[][],
  getQueryData: vi.fn(),
  sendInFlightByChatId: {} as Record<string, true>,
  sendMessageStream: vi.fn(),
  setQueriesData: vi.fn(),
  setQueryData: vi.fn(),
  setBreadcrumbs: vi.fn(),
  stopMessageStream: vi.fn(),
  streamDrafts: {} as Record<string, ChatStreamDraft>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled = true }: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    if (!enabled) return { data: undefined, isPending: false, isLoading: false, error: null };
    mockState.queryKeys.push([...queryKey]);
    if (queryKey[0] === "chats" && queryKey[2] === "active") {
      return { data: mockState.conversations, isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "chats" && queryKey[2] === "detail") {
      if (mockState.pendingChatDetailIds.has(String(queryKey[3]))) {
        return {
          data: undefined,
          isPending: true,
          isLoading: true,
          error: null,
        };
      }
      return {
        data: mockState.conversations.find((chat) => chat.id === queryKey[3]) ?? null,
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "chats" && queryKey[2] === "messages") {
      return {
        data: mockState.messagesByChatId[String(queryKey[3])] ?? [],
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "chats" && queryKey[2] === "queue") {
      return {
        data: mockState.queueSnapshot,
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "issues" && queryKey[1] === "detail") {
      return {
        data: mockState.issues[String(queryKey[2])] ?? null,
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "issues" && queryKey[1] === "comments") {
      return {
        data: mockState.issueComments[String(queryKey[2])] ?? [],
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "issues" && queryKey[1] === "activity") {
      return { data: [], isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "issues" && queryKey[1] === "runs") {
      return { data: [], isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "issues" && queryKey[1] === "attachments") {
      return { data: [], isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "issues" && queryKey[1] === "live-runs") {
      return { data: [], isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "issues" && queryKey[1] === "active-run") {
      return { data: null, isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "issues" && queryKey[2] === "labels") {
      return {
        data: mockState.labels,
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "issues" && queryKey[1] === "children") {
      return { data: [], isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "issues" && queryKey.length === 2 && queryKey[1] === "org-1") {
      return {
        data: Object.values(mockState.issues),
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "automations" && queryKey[1] === "detail") {
      return {
        data: mockState.automations[String(queryKey[2])] ?? null,
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "automations" && queryKey[1] === "runs") {
      return {
        data: mockState.automationRuns[String(queryKey[2])] ?? [],
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "organizations" && queryKey[2] === "workspace-files") {
      const directoryPath = String(queryKey[3] ?? "");
      return {
        data: mockState.workspaceDirectories[directoryPath] ?? { directoryPath, entries: [] },
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "organizations" && queryKey[2] === "workspace-file") {
      const filePath = String(queryKey[3] ?? "");
      return {
        data: mockState.workspaceFiles[filePath] ?? null,
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "organizations" && queryKey[2] === "library-documents") {
      return { data: [], isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "organizations" && queryKey[2] === "workspace-mention-files") {
      return { data: { entries: [] }, isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "organization-skills") {
      return { data: [], isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "access") {
      return { data: { user: { id: "local-board" }, userId: "local-board" }, isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "agents") {
      return {
        data: mockState.agents,
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "projects") {
      return { data: mockState.projects, isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "goals") {
      return { data: mockState.goals, isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "auth" && queryKey[1] === "session") {
      return {
        data: { user: { id: "local-board", name: "Me" }, session: { userId: "local-board" } },
        isPending: false,
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "instance") {
      return { data: { nickname: "" }, isPending: false, isLoading: false, error: null };
    }
    return { data: [], isPending: false, isLoading: false, error: null };
  },
  useMutation: (options?: { mutationFn?: (variables: unknown) => unknown | Promise<unknown>; onSuccess?: (data: unknown, variables: unknown) => void | Promise<void> }) => ({
    isPending: false,
    mutate: (variables: unknown) => {
      mockState.mutations.push(variables);
      mockState.markRead(variables);
    },
    mutateAsync: async (variables: unknown) => {
      mockState.mutations.push(variables);
      const data = await Promise.resolve(options?.mutationFn?.(variables) ?? variables);
      mockState.markRead(variables);
      await options?.onSuccess?.(data, variables);
      return data;
    },
  }),
  useQueryClient: () => ({
    getQueryData: mockState.getQueryData,
    invalidateQueries: mockState.invalidateQueries,
    setQueryData: mockState.setQueryData,
    setQueriesData: mockState.setQueriesData,
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({
    pathname: mockState.conversationId ? `/messenger/chat/${mockState.conversationId}` : "/messenger/chat",
    search: "",
    hash: "",
    key: "chat",
  }),
  useNavigate: () => mockState.navigate,
  useParams: () => (mockState.conversationId ? { conversationId: mockState.conversationId } : {}),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("react-router-dom", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={typeof to === "string" ? to : "#"} {...props}>{children}</a>
  ),
  useLocation: () => ({
    pathname: mockState.conversationId ? `/messenger/chat/${mockState.conversationId}` : "/messenger/chat",
    search: "",
    hash: "",
    key: "chat",
  }),
  useNavigate: () => mockState.navigate,
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    selectedOrganization: { id: "org-1", name: "Rudder", urlKey: "RUD" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockState.setBreadcrumbs }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockState.pushToast }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true), openNewIssue: vi.fn() }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({ t: (key: string, values?: Record<string, string>) => values?.name ?? key }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: () => null,
}));

vi.mock("@/context/ChatGenerationContext", () => ({
  useChatGenerations: () => ({
    abortChatStream: vi.fn(),
    sendInFlightByChatId: mockState.sendInFlightByChatId,
    setChatSendInFlight: vi.fn(),
    setStreamAbortController: vi.fn(),
    setStreamDraftForChat: vi.fn(),
    streamDrafts: mockState.streamDrafts,
  }),
}));

vi.mock("@/api/chats", () => ({
  chatsApi: {
    create: vi.fn(),
    get: vi.fn(),
    update: vi.fn(async (_chatId: string, patch: Partial<ChatConversation>) => ({
      ...mockState.conversations[0],
      ...patch,
    })),
    stopMessageStream: mockState.stopMessageStream,
    sendMessageStream: mockState.sendMessageStream,
    listQueue: vi.fn(async () => mockState.queueSnapshot),
    createQueuedMessage: mockState.createQueuedMessage,
    updateQueuedMessage: mockState.updateQueuedMessage,
    cancelQueuedMessage: mockState.cancelQueuedMessage,
    steerQueuedMessage: mockState.steerQueuedMessage,
  },
}));

vi.mock("@/api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
    listComments: vi.fn(async (issueId: string) => mockState.issueComments[issueId] ?? []),
    addComment: vi.fn(async (issueId: string, body: string) => {
      const nextComment = issueComment({
        id: `comment-${(mockState.issueComments[issueId]?.length ?? 0) + 1}`,
        issueId,
        body,
        createdAt: new Date("2026-05-12T10:05:00.000Z"),
        updatedAt: new Date("2026-05-12T10:05:00.000Z"),
      });
      mockState.issueComments[issueId] = [...(mockState.issueComments[issueId] ?? []), nextComment];
      return nextComment;
    }),
    update: vi.fn(async (issueId: string, data: Partial<Issue>) => {
      const current = mockState.issues[issueId];
      if (!current) throw new Error("Issue not found");
      const updated = { ...current, ...data, updatedAt: new Date("2026-05-12T10:00:00.000Z") };
      mockState.issues[issueId] = updated;
      return updated;
    }),
  },
}));

vi.mock("@/api/automations", () => ({
  automationsApi: {
    get: vi.fn(),
    run: vi.fn(async (automationId: string) => automationRun({ id: `run-${automationId}-manual`, automationId })),
    update: vi.fn(async (automationId: string, data: Partial<AutomationDetail>) => {
      const current = mockState.automations[automationId];
      if (!current) throw new Error("Automation not found");
      const updated = { ...current, ...data, updatedAt: new Date("2026-05-12T10:00:00.000Z") };
      mockState.automations[automationId] = updated;
      return updated;
    }),
    listRuns: vi.fn(),
  },
}));

vi.mock("@/components/MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef((props: { value: string; onChange: (value: string) => void; onSubmit?: () => void; placeholder?: string }, ref) => {
      React.useImperativeHandle(ref, () => ({
        focus: vi.fn(),
        getMarkdown: () => props.value,
      }));
      return (
        <textarea
          aria-label="Composer draft"
          data-testid="mock-markdown-editor"
          placeholder={props.placeholder}
          value={props.value}
          onChange={(event) => props.onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              props.onSubmit?.();
            }
          }}
        />
      );
    }),
  };
});

let cleanupFn: (() => void) | null = null;
let scrollIntoViewMock: ReturnType<typeof vi.fn>;
let storageState: Record<string, string> = {};

function chat(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: "chat-1",
    orgId: "org-1",
    status: "active",
    title: "Pending proposal chat",
    summary: null,
    latestReplyPreview: null,
    latestUserMessagePreview: null,
    userMessageCount: 0,
    preferredAgentId: "agent-1",
    routedAgentId: null,
    primaryIssueId: null,
    forkedFromConversationId: null,
    forkedFromMessageId: null,
    forkRootConversationId: null,
    primaryIssue: null,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: null,
    lastMessageAt: new Date("2026-05-12T09:00:00.000Z"),
    lastReadAt: null,
    isPinned: false,
    isUnread: false,
    unreadCount: 0,
    needsAttention: false,
    resolvedAt: null,
    contextLinks: [],
    sourceMetadata: null,
    mutability: "native_chat",
    chatRuntime: {
      sourceType: "agent",
      sourceLabel: "Wesley",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "codex",
      model: null,
      available: true,
      error: null,
    },
    createdAt: new Date("2026-05-12T09:00:00.000Z"),
    updatedAt: new Date("2026-05-12T09:00:00.000Z"),
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "10000000-0000-4000-8000-000000000010",
    orgId: "org-1",
    urlKey: "rudder-mkt",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Rudder mkt",
    description: null,
    status: "planned",
    leadAgentId: null,
    targetDate: null,
    color: "#82b366",
    icon: "folder",
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      configured: false,
      scope: "none",
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "",
      effectiveLocalFolder: "",
      origin: "local_folder",
    },
    resources: [],
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date("2026-05-12T09:00:00.000Z"),
    updatedAt: new Date("2026-05-12T09:00:00.000Z"),
    ...overrides,
  };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    orgId: "org-1",
    name: "Wesley",
    urlKey: "wesley",
    role: "engineer",
    title: "Founding Engineer",
    icon: "robot",
    status: "active",
    reportsTo: null,
    capabilities: null,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {
      canCreateAgents: false,
      canManageSkills: false,
    },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-05-12T09:00:00.000Z"),
    updatedAt: new Date("2026-05-12T09:00:00.000Z"),
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-1",
    orgId: "org-1",
    conversationId: "chat-1",
    role: "user",
    kind: "message",
    status: "completed",
    body: "Attached image",
    structuredPayload: null,
    approvalId: null,
    approval: null,
    attachments: [],
    transcript: [],
    replyingAgentId: null,
    chatTurnId: null,
    turnVariant: 0,
    supersededAt: null,
    createdAt: new Date("2026-05-12T09:01:00.000Z"),
    updatedAt: new Date("2026-05-12T09:01:00.000Z"),
    ...overrides,
  };
}

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    orgId: "org-1",
    projectId: "10000000-0000-4000-8000-000000000010",
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    ancestors: [],
    title: "Polish side panel layout",
    description: "Make the issue reference read like a task detail panel.",
    status: "in_progress",
    priority: "high",
    boardOrder: 1,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    reviewerAgentId: null,
    reviewerUserId: "reviewer-user",
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    issueNumber: 42,
    identifier: "RUD-42",
    originKind: "manual",
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAgentRuntimeOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: "project_default",
    executionWorkspaceSettings: null,
    runWorkspaceId: null,
    runWorkspacePreference: "project_default",
    runWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labelIds: [],
    labels: [],
    project: project({ name: "Launch Ops" }),
    goal: null,
    currentRunWorkspace: null,
    currentExecutionWorkspace: null,
    workProducts: [],
    mentionedProjects: [],
    searchMatch: null,
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    createdAt: new Date("2026-05-12T08:00:00.000Z"),
    updatedAt: new Date("2026-05-12T09:30:00.000Z"),
    ...overrides,
  };
}

function issueComment(overrides: Partial<IssueComment> = {}): IssueComment {
  return {
    id: "comment-1",
    orgId: "org-1",
    issueId: "issue-1",
    authorAgentId: null,
    authorUserId: "local-board",
    body: "Existing side panel comment.",
    deletedAt: null,
    createdAt: new Date("2026-05-12T09:45:00.000Z"),
    updatedAt: new Date("2026-05-12T09:45:00.000Z"),
    ...overrides,
  };
}

function automationDetail(overrides: Partial<AutomationDetail> = {}): AutomationDetail {
  return {
    id: "automation-1",
    orgId: "org-1",
    projectId: "10000000-0000-4000-8000-000000000010",
    goalId: null,
    parentIssueId: null,
    title: "Daily report",
    description: "Summarize yesterday's project movement every morning.",
    assigneeAgentId: "agent-1",
    outputMode: "chat_output",
    chatConversationId: "chat-1",
    notifyOnIssueCreated: false,
    notifyOnIssueCreatedUserId: null,
    priority: "medium",
    status: "active",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    createdByAgentId: null,
    createdByUserId: "local-board",
    updatedByAgentId: null,
    updatedByUserId: null,
    lastTriggeredAt: new Date("2026-05-12T07:30:00.000Z"),
    lastEnqueuedAt: new Date("2026-05-12T07:30:00.000Z"),
    createdAt: new Date("2026-05-10T09:00:00.000Z"),
    updatedAt: new Date("2026-05-12T09:00:00.000Z"),
    project: { id: "10000000-0000-4000-8000-000000000010", name: "Launch Ops", description: null, status: "active", goalId: null },
    assignee: { id: "agent-1", name: "Wesley", role: "engineer", title: "Founding Engineer", urlKey: "wesley" },
    parentIssue: null,
    chatConversation: {
      id: "chat-1",
      title: "Daily report output",
      status: "active",
      preferredAgentId: "agent-1",
      lastMessageAt: new Date("2026-05-12T07:31:00.000Z"),
    },
    triggers: [{
      id: "trigger-1",
      orgId: "org-1",
      automationId: "automation-1",
      kind: "schedule",
      label: "Weekday morning",
      enabled: true,
      cronExpression: "0 9 * * 1-5",
      timezone: "Asia/Shanghai",
      nextRunAt: new Date("2026-05-13T01:00:00.000Z"),
      lastFiredAt: new Date("2026-05-12T01:00:00.000Z"),
      publicId: null,
      secretId: null,
      signingMode: null,
      replayWindowSec: null,
      lastRotatedAt: null,
      lastResult: "success",
      createdByAgentId: null,
      createdByUserId: "local-board",
      updatedByAgentId: null,
      updatedByUserId: null,
      createdAt: new Date("2026-05-10T09:00:00.000Z"),
      updatedAt: new Date("2026-05-12T09:00:00.000Z"),
    }],
    recentRuns: [],
    activeIssue: null,
    ...overrides,
  };
}

function automationRun(overrides: Partial<AutomationRunSummary> = {}): AutomationRunSummary {
  return {
    id: "automation-run-1",
    orgId: "org-1",
    automationId: "automation-1",
    triggerId: "trigger-1",
    source: "schedule",
    status: "completed",
    triggeredAt: new Date("2026-05-12T07:30:00.000Z"),
    idempotencyKey: null,
    triggerPayload: null,
    linkedIssueId: null,
    linkedChatConversationId: "chat-1",
    startedChatMessageId: "message-start",
    terminalChatMessageId: "message-terminal",
    lastChatMessageId: "message-terminal",
    coalescedIntoRunId: null,
    failureReason: null,
    completedAt: new Date("2026-05-12T07:31:00.000Z"),
    createdAt: new Date("2026-05-12T07:30:00.000Z"),
    updatedAt: new Date("2026-05-12T07:31:00.000Z"),
    linkedIssue: null,
    linkedChatConversation: {
      id: "chat-1",
      title: "Daily report output",
      status: "active",
      preferredAgentId: "agent-1",
      lastMessageAt: new Date("2026-05-12T07:31:00.000Z"),
    },
    trigger: { id: "trigger-1", kind: "schedule", label: "Weekday morning" },
    ...overrides,
  };
}

function queuedMessage(overrides: Partial<ChatQueuedMessage> = {}): ChatQueuedMessage {
  return {
    id: "queue-1",
    orgId: "org-1",
    conversationId: "chat-1",
    position: 1,
    status: "queued",
    version: 1,
    clientMutationId: "test:queue-1",
    payload: {
      body: "Follow up",
      attachmentIds: [],
      projectId: null,
      skillRefs: [],
      accessMode: null,
      model: null,
      effort: null,
      metadata: null,
    },
    expectedGenerationId: null,
    activeGenerationId: null,
    deliveryAttempts: 0,
    lastAttemptAt: null,
    lastDeliveryReason: null,
    sourceMessageId: null,
    deliveredMessageId: null,
    cancelledAt: null,
    steeredAt: null,
    dequeuedAt: null,
    createdAt: new Date("2026-05-12T09:04:00.000Z"),
    updatedAt: new Date("2026-05-12T09:04:00.000Z"),
    ...overrides,
  };
}

function pendingIssueProposal(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return message({
    id: "proposal-1",
    role: "assistant",
    kind: "issue_proposal",
    body: "Please review this proposal.",
    structuredPayload: {
      issueProposal: {
        title: "Fix attachment preview",
        priority: "medium",
        description: "Move the preview dialog outside the composer.",
      },
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
      createdAt: new Date("2026-05-12T09:02:00.000Z"),
      updatedAt: new Date("2026-05-12T09:02:00.000Z"),
    },
    createdAt: new Date("2026-05-12T09:02:00.000Z"),
    updatedAt: new Date("2026-05-12T09:02:00.000Z"),
    ...overrides,
  });
}

function pendingAskUser(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return message({
    id: "ask-user-1",
    role: "assistant",
    kind: "ask_user",
    body: "I need one decision before continuing.",
    structuredPayload: {
      requestUserInput: {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should the agent implement?",
            options: [
              {
                id: "narrow",
                label: "Narrow path",
                description: "Smallest shippable path",
                recommended: true,
              },
              {
                id: "broad",
                label: "Broad path",
              },
            ],
            allowFreeform: true,
          },
        ],
      },
    },
    createdAt: new Date("2026-05-12T09:03:00.000Z"),
    updatedAt: new Date("2026-05-12T09:03:00.000Z"),
    ...overrides,
  });
}

function longConversationMessages(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const messageNumber = index + 1;
    const isUserMessage = index % 2 === 0;
    return message({
      id: `long-message-${messageNumber}`,
      role: isUserMessage ? "user" : "assistant",
      body: `Checkpoint ${messageNumber}: ${isUserMessage ? "operator context" : "assistant progress"} for a long conversation.`,
      replyingAgentId: isUserMessage ? null : "agent-1",
      createdAt: new Date(`2026-05-12T10:${String(messageNumber).padStart(2, "0")}:00.000Z`),
      updatedAt: new Date(`2026-05-12T10:${String(messageNumber).padStart(2, "0")}:00.000Z`),
    });
  });
}

function pendingMultiAskUser(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return pendingAskUser({
    id: "ask-user-multi-1",
    body: "I need a few decisions before continuing.",
    structuredPayload: {
      requestUserInput: {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should the agent implement?",
            options: [
              { id: "narrow", label: "Narrow path", recommended: true },
              { id: "broad", label: "Broad path" },
            ],
            allowFreeform: true,
          },
          {
            id: "risk",
            header: "Risk",
            question: "Which risk should be handled first?",
            options: [
              { id: "tests", label: "Missing tests" },
              { id: "copy", label: "Copy clarity" },
            ],
            allowFreeform: true,
          },
          {
            id: "handoff",
            header: "Handoff",
            question: "What should the handoff include?",
            options: [
              { id: "summary", label: "Short summary" },
              { id: "full", label: "Full report" },
            ],
            allowFreeform: true,
          },
        ],
      },
    },
    ...overrides,
  });
}

function imageMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return message({
    id: "image-message-1",
    attachments: [
      {
        id: "attachment-1",
        orgId: "org-1",
        conversationId: "chat-1",
        messageId: "image-message-1",
        assetId: "asset-1",
        provider: "local_disk",
        objectKey: "asset-1",
        contentPath: PREVIEW_IMAGE_SRC,
        contentType: "image/svg+xml",
        byteSize: 68,
        sha256: "sha256",
        originalFilename: "proposal-screenshot.png",
        createdByAgentId: null,
        createdByUserId: "local-board",
        createdAt: new Date("2026-05-12T09:01:00.000Z"),
        updatedAt: new Date("2026-05-12T09:01:00.000Z"),
      },
    ],
    ...overrides,
  });
}

function installLocalStorageMock() {
  storageState = {};
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storageState[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storageState[key] = String(value);
    }),
    removeItem: vi.fn((key: string) => {
      delete storageState[key];
    }),
    clear: vi.fn(() => {
      storageState = {};
    }),
  });
}

function renderChat({ expanded = false }: { expanded?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const toggleSidePanelExpanded = vi.fn();
  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  const render = (targetRoot: Root) => {
    targetRoot.render(
      <ThemeProvider>
        <SidePanelProvider>
          <SidePanelTestContextBinder />
          <Chat />
          <ChatSidePanel
            selectedOrganizationId="org-1"
            desktopWidth={420}
            expanded={expanded}
            onToggleExpanded={toggleSidePanelExpanded}
          />
        </SidePanelProvider>
      </ThemeProvider>,
    );
  };

  act(() => {
    render(root);
  });

  return {
    container,
    toggleSidePanelExpanded,
    rerender: () => act(() => render(root)),
  };
}

function SidePanelTestContextBinder() {
  const { setContextKey } = useSidePanel();
  const contextKey = mockState.conversationId ? `chat:${mockState.conversationId}` : null;

  useLayoutEffect(() => {
    setContextKey(contextKey);
  }, [contextKey, setContextKey]);

  return null;
}

function dispatchPasteFiles(target: Element, files: File[], options: { clipboardFiles?: File[] } = {}) {
  const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(pasteEvent, "clipboardData", {
    value: {
      items: files.map((file) => ({
        kind: "file",
        getAsFile: () => file,
      })),
      files: options.clipboardFiles ?? files,
    },
  });
  target.dispatchEvent(pasteEvent);
}

async function clickEnabledButton(container: Element, label: string) {
  await act(async () => {
    await Promise.resolve();
  });
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label)
  );
  expect(button).not.toBeUndefined();
  expect(button?.disabled).toBe(false);
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
}

async function clickEnabledButtonByAriaLabel(container: Element, label: string) {
  await act(async () => {
    await Promise.resolve();
  });
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull();
  expect(button?.disabled).toBe(false);
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  installLocalStorageMock();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:chat-attachment-preview"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  resetChatPendingAttachmentsForTests();
  mockState.conversationId = "chat-1";
  mockState.conversations = [
    chat({ id: "chat-1", title: "Pending proposal chat" }),
    chat({ id: "chat-2", title: "Other chat", lastMessageAt: new Date("2026-05-12T09:10:00.000Z") }),
  ];
  mockState.projects = [
    project(),
    project({
      id: "10000000-0000-4000-8000-000000000011",
      urlKey: "launch",
      name: "Launch Ops",
      color: "#2f80ed",
    }),
  ];
  mockState.workspaceDirectories = {};
  mockState.workspaceFiles = {};
  mockState.issues = {};
  mockState.issueComments = {};
  mockState.agents = [agent()];
  mockState.goals = [];
  mockState.labels = [];
  mockState.automations = {};
  mockState.automationRuns = {};
  mockState.messagesByChatId = {
    "chat-1": [imageMessage(), pendingIssueProposal()],
    "chat-2": [message({ id: "other-message-1", conversationId: "chat-2", body: "Other chat" })],
  };
  mockState.queueSnapshot = { activeGenerationId: null, items: [] };
  mockState.cancelQueuedMessage.mockReset();
  mockState.cancelQueuedMessage.mockResolvedValue(queuedMessage({ status: "cancelled" }));
  mockState.createQueuedMessage.mockReset();
  mockState.createQueuedMessage.mockImplementation(async (_chatId: string, data: { payload: { body: string } }) =>
    queuedMessage({ payload: { body: data.payload.body, attachmentIds: [], projectId: null, skillRefs: [], accessMode: null, model: null, effort: null, metadata: null } })
  );
  mockState.steerQueuedMessage.mockReset();
  mockState.steerQueuedMessage.mockResolvedValue({ result: "queued_fallback", item: queuedMessage(), queueVersion: 1 });
  mockState.updateQueuedMessage.mockReset();
  mockState.updateQueuedMessage.mockImplementation(async (_chatId: string, itemId: string, data: { payload: ChatQueuedMessage["payload"] }) =>
    queuedMessage({ id: itemId, payload: data.payload })
  );
  mockState.pendingChatDetailIds = new Set();
  mockState.invalidateQueries.mockReset();
  mockState.markRead.mockReset();
  mockState.mutations = [];
  mockState.navigate.mockReset();
  mockState.pushToast.mockReset();
  mockState.queryKeys = [];
  mockState.getQueryData.mockReset();
  mockState.sendInFlightByChatId = {};
  mockState.sendMessageStream.mockReset();
  mockState.setQueriesData.mockReset();
  mockState.setQueryData.mockReset();
  mockState.stopMessageStream.mockReset();
  mockState.stopMessageStream.mockResolvedValue(undefined);
  mockState.sendMessageStream.mockImplementation(async (chatId: string, body: string, options: {
    onEvent: (event: unknown) => void | Promise<void>;
  }) => {
    await options.onEvent({
      type: "ack",
      userMessage: message({
        id: "sent-user-message",
        conversationId: chatId,
        body,
        createdAt: new Date("2026-05-12T09:04:00.000Z"),
      }),
    });
    await options.onEvent({
      type: "final",
      messages: [
        message({
          id: "sent-user-message",
          conversationId: chatId,
          body,
          createdAt: new Date("2026-05-12T09:04:00.000Z"),
        }),
      ],
    });
  });
  mockState.setBreadcrumbs.mockReset();
  mockState.streamDrafts = {};
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  scrollIntoViewMock = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoViewMock,
  });
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Chat mention sources", () => {
  it("uses active conversations for mention options instead of archived threads", () => {
    renderChat();

    const chatListStatuses = mockState.queryKeys
      .filter((queryKey) => queryKey[0] === "chats" && queryKey[3] === "preview")
      .map((queryKey) => queryKey[2]);
    expect(chatListStatuses).toContain("active");
    expect(chatListStatuses).not.toContain("all");
  });
});

describe("Chat Side Panel link handling", () => {
  async function openIssueReferenceSidePanel(container: HTMLElement) {
    await act(async () => {
      await Promise.resolve();
    });

    const issueReference = container.querySelector<HTMLAnchorElement>('a[data-mention-kind="issue"]');
    expect(issueReference).not.toBeNull();

    await act(async () => {
      issueReference?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel).not.toBeNull();
    return sidePanel!;
  }

  it("opens a supported chat reference in the Side Panel without leaving the current chat", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-side-panel-link",
          role: "assistant",
          body: `Inspect [Other chat](${buildChatMentionHref("chat-2")}) before replying.`,
          replyingAgentId: "agent-1",
          createdAt: new Date("2026-05-12T09:06:00.000Z"),
          updatedAt: new Date("2026-05-12T09:06:00.000Z"),
        }),
      ],
      "chat-2": [message({ id: "other-message-1", conversationId: "chat-2", body: "Other chat side panel content" })],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const chatReference = container.querySelector<HTMLAnchorElement>('a[data-mention-kind="chat"]');
    expect(chatReference).not.toBeNull();

    await act(async () => {
      chatReference?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel).not.toBeNull();
    expect(sidePanel?.textContent).toContain("Other chat");
    expect(sidePanel?.textContent).toContain("1 message");
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(1);
    expect(container.querySelector("[data-testid='chat-side-panel-tabs']")).not.toBeNull();
    expect(mockState.navigate).not.toHaveBeenCalledWith("/messenger/chat/chat-2");
  });

  it("opens an automation mention in the Side Panel without navigating away", async () => {
    mockState.automations["automation-1"] = automationDetail();
    mockState.automationRuns["automation-1"] = [automationRun()];
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-automation-side-panel",
          role: "assistant",
          body: `Check [Daily report](${buildAutomationMentionHref("automation-1", "Daily report")}) before changing the schedule.`,
          replyingAgentId: "agent-1",
          createdAt: new Date("2026-05-12T09:06:00.000Z"),
          updatedAt: new Date("2026-05-12T09:06:00.000Z"),
        }),
      ],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const automationReference = container.querySelector<HTMLAnchorElement>('a[data-mention-kind="automation"]');
    expect(automationReference).not.toBeNull();

    await act(async () => {
      automationReference?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel).not.toBeNull();
    expect(sidePanel?.textContent).toContain("Daily report");
    expect(sidePanel?.textContent).toContain("Active");
    expect(sidePanel?.textContent).toContain("Next run");
    expect(sidePanel?.textContent).toContain("Last ran");
    expect(sidePanel?.textContent).toContain("Launch Ops");
    expect(sidePanel?.textContent).toContain("Repeats");
    expect(sidePanel?.textContent).toContain("Previous runs");
    expect(sidePanel?.textContent).toContain("Run now");
    expect(mockState.navigate).not.toHaveBeenCalledWith("/automations/automation-1");
    expect(sidePanel?.querySelector<HTMLAnchorElement>('a[href="/automations/automation-1"]')).toBeNull();
  });

  it("lets the operator pause an automation from the Side Panel", async () => {
    mockState.automations["automation-1"] = automationDetail();
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-automation-toggle-side-panel",
          role: "assistant",
          body: `Check [Daily report](${buildAutomationMentionHref("automation-1", "Daily report")}) before changing the schedule.`,
          replyingAgentId: "agent-1",
          createdAt: new Date("2026-05-12T09:06:00.000Z"),
          updatedAt: new Date("2026-05-12T09:06:00.000Z"),
        }),
      ],
    };

    const { container, rerender } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const automationReference = container.querySelector<HTMLAnchorElement>('a[data-mention-kind="automation"]');
    await act(async () => {
      automationReference?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const pauseButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Pause"),
    );
    expect(pauseButton).not.toBeUndefined();

    await act(async () => {
      pauseButton?.click();
      await Promise.resolve();
    });
    rerender();

    expect(mockState.mutations).toContainEqual({
      automationId: "automation-1",
      data: { status: "paused" },
    });
    const sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.textContent).toContain("Paused");
    expect(sidePanel?.textContent).toContain("Resume");
  });

  it("opens an internal automation route in the Side Panel without leaving chat", async () => {
    mockState.automations["automation-1"] = automationDetail();
    mockState.automationRuns["automation-1"] = [];
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-automation-route",
          role: "assistant",
          body: "Open [Automation](/automations/automation-1?t=Daily%20report) for context.",
          replyingAgentId: "agent-1",
          createdAt: new Date("2026-05-12T09:06:00.000Z"),
          updatedAt: new Date("2026-05-12T09:06:00.000Z"),
        }),
      ],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const automationReference = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find(
      (candidate) => (candidate.getAttribute("href") ?? "").includes("/automations/automation-1"),
    );
    expect(automationReference).not.toBeUndefined();

    await act(async () => {
      automationReference?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel).not.toBeNull();
    expect(sidePanel?.textContent).toContain("Daily report");
    expect(sidePanel?.textContent).toContain("Runs in");
    expect(sidePanel?.textContent).toContain("No runs yet.");
    expect(mockState.navigate).not.toHaveBeenCalledWith("/automations/automation-1?t=Daily%20report");
  });

  it("renders issue references as a detail panel with task fields and comment target", async () => {
    mockState.issues["issue-1"] = issue();
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-issue-side-panel",
          role: "assistant",
          body: `Review [RUD-42](${buildIssueMentionHref("issue-1", "RUD-42", "comment-1", "in_progress")}) next.`,
          replyingAgentId: "agent-1",
          createdAt: new Date("2026-05-12T09:06:00.000Z"),
          updatedAt: new Date("2026-05-12T09:06:00.000Z"),
        }),
      ],
    };

    const { container } = renderChat();
    const sidePanel = await openIssueReferenceSidePanel(container);
    expect(sidePanel?.textContent).toContain("Polish side panel layout");
    expect(sidePanel?.textContent).toContain("RUD-42");
    expect(sidePanel?.textContent).toContain("In Progress");
    expect(sidePanel?.textContent).toContain("High");
    expect(sidePanel?.textContent).toContain("Assignee");
    expect(sidePanel?.textContent).toContain("Wesley");
    expect(sidePanel?.textContent).toContain("Founding Engineer");
    expect(sidePanel?.textContent).toContain("Reviewer");
    expect(sidePanel?.textContent).toContain("Project");
    expect(sidePanel?.textContent).toContain("Make the issue reference read like a task detail panel.");
    expect(sidePanel?.textContent).toContain("Activity");
    expect(sidePanel?.textContent).toContain("comment-1");
    expect(container.querySelector('button[aria-label="Edit issue"]')).toBeNull();
    expect(sidePanel?.textContent?.indexOf("Assignee")).toBeLessThan(
      sidePanel?.textContent?.indexOf("Make the issue reference read like a task detail panel.") ?? Number.POSITIVE_INFINITY,
    );
    expect(sidePanel?.textContent?.indexOf("Updated")).toBe(-1);
  });

  it("keeps the issue detail properties card on the right when the Side Panel is expanded", async () => {
    mockState.issues["issue-1"] = issue();
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-expanded-issue-side-panel",
          role: "assistant",
          body: `Review [RUD-42](${buildIssueMentionHref("issue-1", "RUD-42", "comment-1", "in_progress")}) next.`,
          replyingAgentId: "agent-1",
          createdAt: new Date("2026-05-12T09:06:00.000Z"),
          updatedAt: new Date("2026-05-12T09:06:00.000Z"),
        }),
      ],
    };

    const { container } = renderChat({ expanded: true });
    const sidePanel = await openIssueReferenceSidePanel(container);

    const embeddedIssueDetail = sidePanel.querySelector<HTMLElement>("[data-testid='embedded-issue-detail']");
    expect(embeddedIssueDetail).not.toBeNull();
    expect(sidePanel.textContent).toContain("Properties");
    expect(sidePanel.textContent).toContain("Sub-issues");
    expect(sidePanel.textContent).toContain("Add sub-issue");
    expect(sidePanel.textContent).toContain("Attach");
    expect(sidePanel.textContent).toContain("Created by");
    expect(sidePanel.textContent).toContain("Updated");
    expect(sidePanel.textContent.indexOf("Activity")).toBeLessThan(sidePanel.textContent.indexOf("Properties"));
    expect(sidePanel.textContent).not.toContain("CreatedUpdated");

    const propertiesRegion = sidePanel.querySelector<HTMLElement>("[aria-label='Issue properties']");
    expect(sidePanel.querySelector("[data-testid='chat-side-panel-issue-view']")).toBeNull();
    expect(propertiesRegion).not.toBeNull();
  });

  it("lets the operator directly edit issue title and description from the Side Panel", async () => {
    mockState.issues["issue-1"] = issue();
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-editable-issue-side-panel",
          role: "assistant",
          body: `Review [RUD-42](${buildIssueMentionHref("issue-1", "RUD-42", null, "in_progress")}) next.`,
          replyingAgentId: "agent-1",
          createdAt: new Date("2026-05-12T09:06:00.000Z"),
          updatedAt: new Date("2026-05-12T09:06:00.000Z"),
        }),
      ],
    };

    const { container, rerender } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const issueReference = container.querySelector<HTMLAnchorElement>('a[data-mention-kind="issue"]');
    await act(async () => {
      issueReference?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    expect(container.querySelector('button[aria-label="Edit issue"]')).toBeNull();
    const titleDisplay = Array.from(container.querySelectorAll<HTMLElement>("[data-testid='chat-side-panel'] h2")).find(
      (candidate) => candidate.textContent?.includes("Polish side panel layout"),
    );
    expect(titleDisplay).not.toBeUndefined();
    await act(async () => {
      titleDisplay?.click();
      await Promise.resolve();
    });

    const titleInput = container.querySelector<HTMLTextAreaElement>("[data-testid='chat-side-panel'] textarea:not([data-testid])");
    const descriptionInput = Array.from(container.querySelectorAll<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']")).find(
      (candidate) => candidate.placeholder === "Add a description...",
    );
    expect(titleInput).not.toBeNull();
    expect(descriptionInput).not.toBeNull();

    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(titleInput), "value")?.set?.call(
        titleInput,
        "Polish editable side panel",
      );
      titleInput!.dispatchEvent(new Event("input", { bubbles: true }));
      titleInput!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(descriptionInput), "value")?.set?.call(
        descriptionInput,
        "Updated from the chat side panel.",
      );
      descriptionInput!.dispatchEvent(new Event("input", { bubbles: true }));
      descriptionInput!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
      await Promise.resolve();
    });
    rerender();

    expect(mockState.mutations).toContainEqual({
      issueId: "issue-1",
      data: {
        title: "Polish editable side panel",
      },
    });
    expect(mockState.mutations).toContainEqual({
      issueId: "issue-1",
      data: {
        description: "Updated from the chat side panel.",
      },
    });
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Polish editable side panel");
  });

  it("lets the operator update issue status and comment from the Side Panel", async () => {
    mockState.issues["issue-1"] = issue();
    mockState.issueComments["issue-1"] = [
      issueComment({
        id: "comment-existing",
        body: "Existing side panel comment.",
      }),
    ];
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-actionable-issue-side-panel",
          role: "assistant",
          body: `Review [RUD-42](${buildIssueMentionHref("issue-1", "RUD-42", "comment-existing", "in_progress")}) next.`,
          replyingAgentId: "agent-1",
          createdAt: new Date("2026-05-12T09:06:00.000Z"),
          updatedAt: new Date("2026-05-12T09:06:00.000Z"),
        }),
      ],
    };

    const { container, rerender } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const issueReference = container.querySelector<HTMLAnchorElement>('a[data-mention-kind="issue"]');
    await act(async () => {
      issueReference?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.textContent).toContain("Existing side panel comment.");

    const statusButton = sidePanel?.querySelector<HTMLButtonElement>('[data-slot="issue-status-icon"]')?.closest("button");
    expect(statusButton).not.toBeNull();
    await act(async () => {
      statusButton?.click();
      await Promise.resolve();
    });

    const doneStatusOption = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(
      (candidate) => candidate.textContent?.includes("Done"),
    );
    expect(doneStatusOption).not.toBeUndefined();
    await act(async () => {
      doneStatusOption?.click();
      await Promise.resolve();
    });
    rerender();

    expect(mockState.mutations).toContainEqual({
      issueId: "issue-1",
      data: {
        status: "done",
      },
    });

    const commentEditor = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Leave a comment..."]');
    expect(commentEditor).not.toBeNull();
    await act(async () => {
      const textareaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      textareaValueSetter?.call(commentEditor, "Posted without leaving Messenger.");
      commentEditor!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    const commentButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent === "Comment",
    );
    expect(commentButton).not.toBeUndefined();
    expect(commentButton?.disabled).toBe(false);
    await act(async () => {
      commentButton?.click();
      await Promise.resolve();
    });
    rerender();

    expect(mockState.mutations).toContainEqual({
      issueId: "issue-1",
      body: "Posted without leaving Messenger.",
      reopen: true,
    });
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Posted without leaving Messenger.");
  });

  it("lets the operator edit side panel issue assignee through rendered agent metadata", async () => {
    mockState.agents = [
      agent({ id: "agent-1", name: "Wesley", title: "Founding Engineer", icon: "robot" }),
      agent({ id: "agent-2", name: "Ada", title: "Review Lead", icon: "sparkles", role: "pm" }),
    ];
    mockState.issues["issue-1"] = issue();
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-assignee-issue-side-panel",
          role: "assistant",
          body: `Review [RUD-42](${buildIssueMentionHref("issue-1", "RUD-42", null, "in_progress")}) next.`,
          replyingAgentId: "agent-1",
          createdAt: new Date("2026-05-12T09:06:00.000Z"),
          updatedAt: new Date("2026-05-12T09:06:00.000Z"),
        }),
      ],
    };

    const { container, rerender } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const issueReference = container.querySelector<HTMLAnchorElement>('a[data-mention-kind="issue"]');
    await act(async () => {
      issueReference?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.textContent).toContain("Wesley");
    expect(sidePanel?.textContent).toContain("Founding Engineer");

    const assigneeButton = Array.from(sidePanel?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
      (candidate) => candidate.textContent?.includes("Wesley") && candidate.textContent?.includes("Founding Engineer"),
    );
    expect(assigneeButton).not.toBeUndefined();
    await act(async () => {
      assigneeButton?.click();
      await Promise.resolve();
    });

    const adaOption = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Ada") && candidate.textContent?.includes("Review Lead"),
    );
    expect(adaOption).not.toBeUndefined();
    await act(async () => {
      adaOption?.click();
      await Promise.resolve();
    });
    rerender();

    expect(mockState.mutations).toContainEqual({
      issueId: "issue-1",
      data: {
        assigneeAgentId: "agent-2",
        assigneeUserId: null,
      },
    });
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Ada");
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Review Lead");
  });

  it("keeps multiple Side Panel chat targets as deduplicated focusable tabs", async () => {
    mockState.conversations = [
      chat({ id: "chat-1", title: "Current chat" }),
      chat({ id: "chat-2", title: "Other chat", lastMessageAt: new Date("2026-05-12T09:10:00.000Z") }),
      chat({ id: "chat-3", title: "Third chat", lastMessageAt: new Date("2026-05-12T09:11:00.000Z") }),
    ];
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-side-panel-tabs",
          role: "assistant",
          body: `Compare [Other chat](${buildChatMentionHref("chat-2")}) with [Third chat](${buildChatMentionHref("chat-3")}).`,
          replyingAgentId: "agent-1",
          createdAt: new Date("2026-05-12T09:06:00.000Z"),
          updatedAt: new Date("2026-05-12T09:06:00.000Z"),
        }),
      ],
      "chat-2": [message({ id: "other-message-1", conversationId: "chat-2", body: "Other chat side panel content" })],
      "chat-3": [message({ id: "third-message-1", conversationId: "chat-3", body: "Third chat side panel content" })],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const chatReferences = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[data-mention-kind="chat"]'));
    expect(chatReferences).toHaveLength(2);

    await act(async () => {
      chatReferences[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });
    const currentChatReferences = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[data-mention-kind="chat"]'));
    await act(async () => {
      currentChatReferences[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    let tabs = Array.from(container.querySelectorAll<HTMLElement>("[data-testid='chat-side-panel-tab']"));
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.textContent).toContain("Other chat");
    expect(tabs[1]?.textContent).toContain("Third chat");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Third chat side panel content");

    const refreshedChatReferences = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[data-mention-kind="chat"]'));
    await act(async () => {
      refreshedChatReferences[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    tabs = Array.from(container.querySelectorAll<HTMLElement>("[data-testid='chat-side-panel-tab']"));
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Other chat side panel content");

    const closeButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-testid='chat-side-panel-tab-close']"));
    await act(async () => {
      closeButtons[0]?.click();
      await Promise.resolve();
    });

    tabs = Array.from(container.querySelectorAll<HTMLElement>("[data-testid='chat-side-panel-tab']"));
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.textContent).toContain("Third chat");
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Third chat side panel content");
  });

  it("opens the Library browser from the plus menu with a file-count summary and file drill-in", async () => {
    mockState.workspaceDirectories = {
      "": {
        directoryPath: "",
        entries: [
          { name: "agents", path: "agents", isDirectory: true },
          { name: "docs", path: "docs", isDirectory: true },
          { name: "notes.md", path: "notes.md", isDirectory: false },
          { name: "projects", path: "projects", isDirectory: true },
          { name: "skills", path: "skills", isDirectory: true },
        ],
      },
      agents: {
        directoryPath: "agents",
        entries: [
          {
            name: "asher",
            displayLabel: "Asher",
            path: "agents/asher",
            isDirectory: true,
            entityType: "agent_workspace",
            agentIcon: null,
            agentRole: "engineer",
          },
        ],
      },
      docs: {
        directoryPath: "docs",
        entries: [{ name: "guide.md", path: "docs/guide.md", isDirectory: false }],
      },
      "agents/asher": {
        directoryPath: "agents/asher",
        entries: [{ name: "instructions", path: "agents/asher/instructions", isDirectory: true }],
      },
      "agents/asher/instructions": {
        directoryPath: "agents/asher/instructions",
        entries: [],
      },
      projects: {
        directoryPath: "projects",
        entries: [{ name: "rudder-dev", displayLabel: "Rudder Dev", path: "projects/rudder-dev", isDirectory: true }],
      },
      "projects/rudder-dev": {
        directoryPath: "projects/rudder-dev",
        entries: [],
      },
      skills: {
        directoryPath: "skills",
        entries: [{ name: "build-advisor", path: "skills/build-advisor", isDirectory: true }],
      },
      "skills/build-advisor": {
        directoryPath: "skills/build-advisor",
        entries: [{ name: "SKILL.md", path: "skills/build-advisor/SKILL.md", isDirectory: false }],
      },
    };
    mockState.workspaceFiles = {
      "notes.md": {
        filePath: "notes.md",
        content: "# Side Panel notes\n\n- Keep markdown rendered",
        contentType: "text/markdown",
        previewKind: "text",
        contentPath: null,
        truncated: false,
      },
    };
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "library-menu-message", body: "Open the library browser." })],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const plusTrigger = container.querySelector<HTMLButtonElement>('button[aria-label="Add files and options"]');
    expect(plusTrigger).not.toBeNull();
    await act(async () => {
      plusTrigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const openLibraryOption = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (candidate) => candidate.textContent?.includes("Open Library in Side Panel"),
    );
    expect(openLibraryOption).not.toBeUndefined();

    await act(async () => {
      openLibraryOption?.click();
      await Promise.resolve();
    });

    let sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel).not.toBeNull();
    expect(sidePanel?.textContent).toContain("Library root");
    expect(sidePanel?.textContent).toContain("1 file · 4 folders");
    expect(sidePanel?.textContent).toContain("notes.md");
    expect(sidePanel?.querySelector('[data-testid="chat-side-panel-library-agents-root-icon"]')).not.toBeNull();
    expect(sidePanel?.querySelector('[data-testid="chat-side-panel-library-skills-root-icon"]')).not.toBeNull();

    const docsButton = Array.from(sidePanel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("docs"),
    );
    expect(docsButton).not.toBeUndefined();
    expect(docsButton?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      docsButton?.click();
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(docsButton?.getAttribute("aria-expanded")).toBe("true");
    expect(sidePanel?.textContent).toContain("guide.md");

    const agentsButton = Array.from(sidePanel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("agents"),
    );
    expect(agentsButton).not.toBeUndefined();

    await act(async () => {
      agentsButton?.click();
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.textContent).toContain("Asher");
    expect(sidePanel?.querySelector('[data-testid="chat-side-panel-library-agent-icon"]')).not.toBeNull();
    expect(sidePanel?.querySelector('[data-testid="chat-side-panel-library-agent-badge"]')?.textContent).toContain("Agent");

    const skillsButton = Array.from(sidePanel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("skills"),
    );
    expect(skillsButton).not.toBeUndefined();

    await act(async () => {
      skillsButton?.click();
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.textContent).toContain("build-advisor");
    expect(sidePanel?.querySelector('[data-testid="chat-side-panel-library-skill-folder-icon"]')).not.toBeNull();

    const projectsButton = Array.from(sidePanel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("projects"),
    );
    expect(projectsButton).not.toBeUndefined();

    await act(async () => {
      projectsButton?.click();
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.textContent).toContain("Rudder Dev");
    expect(sidePanel?.querySelector('[data-testid="chat-side-panel-library-project-icon"]')).not.toBeNull();

    const notesButton = Array.from(sidePanel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("notes.md"),
    );
    expect(notesButton).not.toBeUndefined();

    await act(async () => {
      notesButton?.click();
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    const markdownPreview = sidePanel?.querySelector("[data-testid='chat-side-panel-library-markdown-preview']");
    expect(markdownPreview?.querySelector("h1")?.textContent).toBe("Side Panel notes");
    expect(markdownPreview?.querySelector("li")?.textContent).toBe("Keep markdown rendered");
    expect(markdownPreview?.textContent).not.toContain("# Side Panel notes");
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(2);
  });

  it("renders a stable Library entry target as an inline file preview", async () => {
    mockState.workspaceFiles = {
      "reports/activity.md": {
        filePath: "reports/activity.md",
        content: "# Activity report\n\nStable Library entry links should render inline.",
        contentType: "text/markdown",
        previewKind: "text",
        contentPath: null,
        truncated: false,
      },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ThemeProvider>
          <SidePanelProvider>
            <ChatSidePanel
              selectedOrganizationId="org-1"
              target={{
                kind: "library_entry",
                entryId: "entry-activity",
                path: "reports/activity.md",
                label: "activity.md",
              }}
            />
          </SidePanelProvider>
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    const sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel).not.toBeNull();
    expect(sidePanel?.textContent).toContain("reports/activity.md");
    expect(sidePanel?.textContent).toContain("Activity report");
    expect(sidePanel?.textContent).toContain("Stable Library entry links should render inline.");
    expect(sidePanel?.textContent).not.toContain("Open this target in the full page for details.");
  });

  it("opens the empty Side Panel picker from the add-tab button without a menu", async () => {
    mockState.workspaceDirectories = {
      "": {
        directoryPath: "",
        entries: [{ name: "notes.md", path: "notes.md", isDirectory: false }],
      },
    };
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "empty-side-panel-message", body: "Open the global side panel." })],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const chatSidePanelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open Side Panel"]');
    expect(chatSidePanelButton).not.toBeNull();
    await act(async () => {
      chatSidePanelButton?.click();
      await Promise.resolve();
    });

    let sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel).not.toBeNull();
    expect(sidePanel?.textContent).toContain("Open a panel");

    expect(sidePanel?.querySelector("[data-testid='chat-side-panel-empty-issue-target']")).toBeNull();
    expect(sidePanel?.textContent).not.toContain("Pin an issue workspace");

    const addTabButton = sidePanel!.querySelector<HTMLButtonElement>('[data-testid="chat-side-panel-add-tab"]');
    expect(addTabButton).not.toBeNull();
    await act(async () => {
      addTabButton?.click();
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.textContent).toContain("Open a panel");
    expect(sidePanel?.querySelector('[data-testid="chat-side-panel-add-menu"]')).toBeNull();

    const libraryOption = Array.from(sidePanel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Library"),
    );
    await act(async () => {
      libraryOption?.click();
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.textContent).toContain("Library root");
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(1);
  });

  it("opens an interactive browser target from the empty Side Panel picker", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "browser-side-panel-message", body: "Open the browser panel." })],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const chatSidePanelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open Side Panel"]');
    expect(chatSidePanelButton).not.toBeNull();
    await act(async () => {
      chatSidePanelButton?.click();
      await Promise.resolve();
    });

    let sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel).not.toBeNull();

    const browserOption = Array.from(sidePanel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Browser"),
    );
    expect(browserOption).not.toBeUndefined();
    await act(async () => {
      browserOption?.click();
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.textContent).toContain("Start browsing");
    expect(sidePanel?.querySelector("[data-testid='chat-side-panel-browser-view']")).not.toBeNull();
    expect(sidePanel?.className).toContain("motion-chat-side-panel");
    expect(sidePanel?.className).toContain("transition-[width,opacity,transform]");
    expect(container.querySelector('[data-testid="chat-side-panel-trigger"]')).toBeNull();
    expect(sidePanel?.querySelector('[data-testid="chat-side-panel-collapse"]')).not.toBeNull();
    expect(sidePanel?.querySelector('[data-testid="chat-side-panel-expand-toggle"]')).not.toBeNull();

    const urlInput = sidePanel!.querySelector<HTMLInputElement>('input[aria-label="Browser URL"]');
    expect(urlInput).not.toBeNull();
    await act(async () => {
      urlInput!.value = "localhost:3100/api/health";
      urlInput!.dispatchEvent(new Event("input", { bubbles: true }));
      urlInput!.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.querySelector("[data-testid='chat-side-panel-browser-start']")).toBeNull();
    const webview = sidePanel?.querySelector<HTMLElement>("[data-testid='chat-side-panel-browser-webview']");
    expect(webview).not.toBeNull();
    expect(webview?.getAttribute("src")).toBe("http://localhost:3100/api/health");
    expect(Array.from(sidePanel!.querySelectorAll<HTMLElement>("[data-testid='chat-side-panel-tab']")).at(0)?.textContent).toContain("localhost");

    const newBrowserTabButton = sidePanel!.querySelector<HTMLButtonElement>('button[aria-label="Open new browser tab"]');
    await act(async () => {
      newBrowserTabButton?.click();
      await Promise.resolve();
    });

    const tabs = Array.from(container.querySelectorAll<HTMLElement>("[data-testid='chat-side-panel-tab']"));
    expect(tabs).toHaveLength(2);
    expect(tabs.at(-1)?.textContent).toContain("New tab");
  });

  it("does not call Electron webview APIs before dom-ready in the browser target", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "browser-side-panel-message", body: "Open the browser panel." })],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const chatSidePanelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open Side Panel"]');
    expect(chatSidePanelButton).not.toBeNull();
    await act(async () => {
      chatSidePanelButton?.click();
      await Promise.resolve();
    });

    let sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    const browserOption = Array.from(sidePanel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Browser"),
    );
    await act(async () => {
      browserOption?.click();
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    const urlInput = sidePanel!.querySelector<HTMLInputElement>('input[aria-label="Browser URL"]');
    expect(urlInput).not.toBeNull();
    await act(async () => {
      urlInput!.value = "google";
      urlInput!.dispatchEvent(new Event("input", { bubbles: true }));
      urlInput!.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    const webview = sidePanel?.querySelector<HTMLElement & {
      canGoBack?: () => boolean;
      canGoForward?: () => boolean;
      getURL?: () => string;
    }>("[data-testid='chat-side-panel-browser-webview']");
    expect(webview).not.toBeNull();
    expect(webview?.getAttribute("src")).toBe("https://www.google.com/search?q=google");

    const notReadyError = new Error("The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.");
    const canGoBack = vi.fn(() => {
      throw notReadyError;
    });
    const canGoForward = vi.fn(() => {
      throw notReadyError;
    });
    const getURL = vi.fn(() => {
      throw notReadyError;
    });
    Object.assign(webview!, { canGoBack, canGoForward, getURL });

    await act(async () => {
      webview!.dispatchEvent(new Event("did-start-loading"));
      webview!.dispatchEvent(new Event("did-stop-loading"));
      webview!.dispatchEvent(new Event("page-title-updated"));
      await Promise.resolve();
    });

    expect(canGoBack).not.toHaveBeenCalled();
    expect(canGoForward).not.toHaveBeenCalled();
    expect(getURL).not.toHaveBeenCalled();
    expect(container.querySelector("[data-testid='chat-side-panel-browser-view']")).not.toBeNull();

    const readyUrl = vi.fn(() => "https://www.google.com/search?q=google");
    Object.assign(webview!, {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      getURL: readyUrl,
    });

    await act(async () => {
      webview!.dispatchEvent(new Event("dom-ready"));
      webview!.dispatchEvent(new Event("did-stop-loading"));
      await Promise.resolve();
    });

    expect(readyUrl).toHaveBeenCalled();
    expect(container.querySelector("[data-testid='chat-side-panel-browser-view']")).not.toBeNull();
  });

  it("uses a mobile overlay Side Panel without removing the Chat composer", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    mockState.workspaceDirectories = {
      "": {
        directoryPath: "",
        entries: [{ name: "notes.md", path: "notes.md", isDirectory: false }],
      },
    };
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "mobile-side-panel-message", body: "Open the side panel." })],
    };

    const { container } = renderChat();
    const sidePanelTrigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-side-panel-trigger"]');
    expect(sidePanelTrigger).not.toBeNull();
    expect(sidePanelTrigger?.textContent?.trim()).toBe("");
    expect(sidePanelTrigger?.className).toContain("w-7");
    expect(sidePanelTrigger?.title).toBe("Open Side Panel");

    await act(async () => {
      sidePanelTrigger?.click();
      await Promise.resolve();
    });

    const sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel).not.toBeNull();
    expect(sidePanel?.className).toContain("fixed");
    expect(sidePanel?.className).toContain("inset-x-3");

    const closeSidePanelButton = sidePanel?.querySelector<HTMLButtonElement>('[data-testid="chat-side-panel-collapse"]');
    expect(closeSidePanelButton).not.toBeNull();

    await act(async () => {
      closeSidePanelButton?.click();
      await Promise.resolve();
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 220));
    });
    expect(container.querySelector("[data-testid='chat-side-panel']")).toBeNull();
    expect(sidePanelTrigger?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("textarea[aria-label='Composer draft']")).not.toBeNull();
  });

  it("keeps editable issue fields and activity in one narrow Side Panel scroll flow", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
    mockState.issues["issue-1"] = issue();
    mockState.issueComments["issue-1"] = [
      issueComment({ id: "comment-1", body: "Existing side panel comment." }),
      issueComment({ id: "comment-2", body: "Follow-up activity should scroll below the task body." }),
      issueComment({ id: "comment-3", body: "Keep editable fields near the top." }),
    ];
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-mobile-issue-side-panel",
          role: "assistant",
          body: `Review [RUD-42](${buildIssueMentionHref("issue-1", "RUD-42", "comment-1", "in_progress")}) next.`,
          replyingAgentId: "agent-1",
          createdAt: new Date("2026-05-12T09:06:00.000Z"),
          updatedAt: new Date("2026-05-12T09:06:00.000Z"),
        }),
      ],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const issueReference = container.querySelector<HTMLAnchorElement>('a[data-mention-kind="issue"]');
    await act(async () => {
      issueReference?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    const issueView = sidePanel?.querySelector<HTMLElement>("[data-testid='chat-side-panel-issue-view']");
    const issueScroller = sidePanel?.querySelector<HTMLElement>("[data-testid='chat-side-panel-issue-scroll']");
    const timelineFlow = sidePanel?.querySelector<HTMLElement>("[data-testid='comment-thread-timeline-flow']");
    const activityScroller = sidePanel?.querySelector<HTMLElement>("[data-testid='comment-thread-timeline-scroll']");
    const fixedComposer = sidePanel?.querySelector<HTMLElement>("[data-testid='comment-thread-fixed-composer']");
    const sidePanelScrollBody = sidePanel?.querySelector<HTMLElement>("[data-testid='chat-side-panel-scroll-body']");
    expect(sidePanel).not.toBeNull();
    expect(issueView).not.toBeNull();
    expect(issueScroller).not.toBeNull();
    expect(timelineFlow).not.toBeNull();
    expect(activityScroller).toBeNull();
    expect(fixedComposer).not.toBeNull();
    expect(issueScroller?.className).toContain("overflow-y-auto");
    expect(fixedComposer?.className).toContain("sticky bottom-0");
    expect(sidePanelScrollBody?.className).toContain("overflow-hidden");
    expect(sidePanel?.className).toContain("fixed");
    expect(sidePanel?.textContent?.indexOf("Assignee")).toBeLessThan(
      sidePanel?.textContent?.indexOf("Existing side panel comment.") ?? Number.POSITIVE_INFINITY,
    );
    expect(sidePanel?.textContent?.indexOf("Make the issue reference read like a task detail panel.")).toBeLessThan(
      sidePanel?.textContent?.indexOf("Existing side panel comment.") ?? Number.POSITIVE_INFINITY,
    );
    expect(timelineFlow?.textContent).toContain("Existing side panel comment.");
    expect(timelineFlow?.textContent).toContain("Follow-up activity should scroll below the task body.");
    expect(timelineFlow?.textContent).toContain("Keep editable fields near the top.");
  });
});

describe("Chat unread state", () => {
  it("does not render a Messenger chat that belongs to another organization", async () => {
    mockState.conversations = [
      chat({ id: "chat-1", orgId: "org-old", title: "Old organization chat" }),
    ];
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "old-org-message", body: "Old org content" })],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockState.navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/(?:messenger\/)?chat$/), { replace: true });
    expect(container.textContent).not.toContain("Old org content");
    expect(mockState.queryKeys).not.toContainEqual(["chats", "org-1", "messages", "chat-1"]);
  });

  it("optimistically clears the selected Messenger chat before mark-read finishes", () => {
    const unreadChat = chat({
      id: "chat-1",
      title: "Unread chat",
      isUnread: true,
      unreadCount: 2,
      needsAttention: true,
      lastMessageAt: new Date("2026-05-12T09:05:00.000Z"),
    });
    mockState.conversations = [unreadChat];
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-message-1",
          role: "assistant",
          kind: "message",
          body: "Unread assistant reply",
          createdAt: new Date("2026-05-12T09:05:00.000Z"),
          updatedAt: new Date("2026-05-12T09:05:00.000Z"),
        }),
      ],
    };

    renderChat();

    expect(mockState.markRead).toHaveBeenCalledWith("chat-1");

    const detailUpdater = mockState.setQueryData.mock.calls.find((call) =>
      Array.isArray(call[0]) && call[0][0] === "chats" && call[0][1] === "org-1" && call[0][2] === "detail" && call[0][3] === "chat-1",
    )?.[1] as ((current: ChatConversation) => ChatConversation) | undefined;
    expect(detailUpdater?.(unreadChat)).toMatchObject({
      isUnread: false,
      unreadCount: 0,
      needsAttention: false,
    });

    const threadPageUpdater = mockState.setQueriesData.mock.calls.find((call) =>
      Array.isArray(call[0]?.queryKey) && call[0].queryKey[0] === "messenger" && call[0].queryKey[2] === "threads",
    )?.[1] as ((current: {
      pages: Array<{ items: Array<{ threadKey: string; unreadCount: number; needsAttention: boolean }>; pageInfo: Record<string, unknown> }>;
      pageParams: unknown[];
    }) => {
      pages: Array<{ items: Array<{ threadKey: string; unreadCount: number; needsAttention: boolean }> }>;
    }) | undefined;
    expect(threadPageUpdater?.({
      pages: [{
        items: [{ threadKey: "chat:chat-1", unreadCount: 2, needsAttention: true }],
        pageInfo: { limit: 40, nextCursor: null, hasMore: false },
      }],
      pageParams: [null],
    }).pages[0]?.items[0]).toMatchObject({
      unreadCount: 0,
      needsAttention: false,
    });

    const badgeUpdater = mockState.setQueryData.mock.calls.find((call) =>
      Array.isArray(call[0]) && call[0][0] === "sidebar-badges" && call[0][1] === "org-1",
    )?.[1] as ((current: { inbox: number; chatAttention: number }) => { inbox: number; chatAttention: number }) | undefined;
    expect(badgeUpdater?.({ inbox: 3, chatAttention: 2 })).toMatchObject({
      inbox: 2,
      chatAttention: 1,
    });
  });
});

describe("Chat route loading", () => {
  it("shows a target conversation loading state instead of the new-chat empty state", () => {
    mockState.conversationId = "chat-loading";
    mockState.conversations = [];
    mockState.messagesByChatId = {};
    mockState.pendingChatDetailIds = new Set(["chat-loading"]);

    const { container } = renderChat();

    expect(container.querySelector("[data-testid='chat-conversation-loading-state']")).not.toBeNull();
    expect(container.querySelectorAll("[data-slot='skeleton']")).toHaveLength(5);
    expect(container.querySelector(".chat-message-user")).not.toBeNull();
    expect(container.querySelector("[data-testid='chat-composer-toolbar']")).toBeNull();
    expect(container.querySelector("[data-testid='chat-empty-state-tabs']")).toBeNull();
    expect(container.textContent).not.toContain("Scope a new feature");
  });
});

describe("Chat message scroll map", () => {
  it("stays hidden until a conversation has more than five user messages", async () => {
    mockState.messagesByChatId = {
      "chat-1": longConversationMessages(10),
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid='chat-scroll-map']")).toBeNull();
  });

  it("previews long conversation positions and jumps to the selected message", async () => {
    mockState.messagesByChatId = {
      "chat-1": longConversationMessages(12),
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const scrollMap = container.querySelector<HTMLElement>("[data-testid='chat-scroll-map']");
    expect(scrollMap).not.toBeNull();
    expect(scrollMap?.querySelectorAll("[data-testid^='chat-scroll-map-marker-']")).toHaveLength(6);
    expect(scrollMap?.className).toContain("w-4");
    expect(scrollMap?.className).toContain("gap-0.5");
    expect(container.querySelector<HTMLElement>("[data-testid='chat-messages-shell']")?.className).toContain("relative");
    expect(container.querySelector<HTMLElement>("[data-testid='chat-messages-content']")?.className).not.toContain("ml-5");
    expect(container.querySelector<HTMLElement>("[data-testid='chat-messages-content']")?.className).toContain("pb-4");

    const marker = container.querySelector<HTMLButtonElement>("[data-testid='chat-scroll-map-marker-long-message-7']");
    expect(marker).not.toBeNull();

    await act(async () => {
      marker?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await Promise.resolve();
    });

    const preview = document.body.querySelector<HTMLElement>("[data-testid='chat-scroll-map-preview']");
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain("Checkpoint 7");
    expect(preview?.textContent).toContain("operator context");
    expect(preview?.textContent).toContain("assistant progress");
    expect(preview?.className).toContain("w-[40rem]");
    expect(preview?.className).toContain("bg-[rgba(42,42,42,0.94)]");
    expect(preview?.className).toContain("rounded-[18px]");

    await act(async () => {
      marker?.click();
      await Promise.resolve();
    });

    const targetMessage = container.querySelector("[data-message-id='long-message-7']");
    const targetBubble = targetMessage?.querySelector("[data-testid='chat-user-message-bubble']");
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(targetMessage?.className).not.toContain("chat-message-jump-highlight");
    expect(targetBubble?.className).toContain("chat-message-jump-highlight");
  });

  it("renders markdown tokens in hover previews without exposing raw mention protocols", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        ...longConversationMessages(12),
        message({
          id: "token-message",
          role: "user",
          body: `Ask [Heidi](${buildAgentMentionHref("agent-123", "code")}) to review \`verification\` and [ZST-789](${buildIssueMentionHref("issue-789", "ZST-789", null, "in_progress")}).`,
          createdAt: new Date("2026-05-12T10:13:00.000Z"),
          updatedAt: new Date("2026-05-12T10:13:00.000Z"),
        }),
        message({
          id: "token-assistant",
          role: "assistant",
          body: `The agent reply mentions [Heidi](${buildAgentMentionHref("agent-123", "code")}) and keeps \`agent://\` as code only.`,
          replyingAgentId: "agent-1",
          createdAt: new Date("2026-05-12T10:14:00.000Z"),
          updatedAt: new Date("2026-05-12T10:14:00.000Z"),
        }),
      ],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const marker = container.querySelector<HTMLButtonElement>("[data-testid='chat-scroll-map-marker-token-message']");
    expect(marker).not.toBeNull();

    await act(async () => {
      marker?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await Promise.resolve();
    });

    const preview = document.body.querySelector<HTMLElement>("[data-testid='chat-scroll-map-preview']");
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain("Heidi");
    expect(preview?.textContent).toContain("verification");
    expect(preview?.innerHTML).toContain('data-mention-kind="agent"');
    expect(preview?.innerHTML).toContain('data-mention-kind="issue"');
    expect(preview?.innerHTML).not.toContain("agent://agent-123");
    expect(preview?.innerHTML).not.toContain("issue://issue-789");
  });
});

describe("Chat streaming controls", () => {
  it("highlights the composer boundary while an agent response is streaming", () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "user-message-1",
          body: "Please draft a plan.",
          chatTurnId: "turn-1",
        }),
      ],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        userBody: "Please draft a plan.",
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: "user-message-1",
        chatTurnId: "turn-1",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: "Working on it...",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };

    const { container } = renderChat();

    expect(container.querySelector(".chat-composer")?.className).toContain("chat-composer--streaming");
  });

  it("notifies the operator after stopping an active response", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "user-message-1",
          body: "Please draft a plan.",
          chatTurnId: "turn-1",
        }),
      ],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        userBody: "Please draft a plan.",
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: "user-message-1",
        chatTurnId: "turn-1",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: "Working on it...",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };

    const { container } = renderChat();

    await clickEnabledButtonByAriaLabel(container, "Stop streaming");
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockState.stopMessageStream).toHaveBeenCalledWith("chat-1");
    expect(mockState.pushToast).toHaveBeenCalledWith({
      title: "Response stopped",
      body: "Rudder interrupted the current reply.",
      tone: "info",
    });
  });

  it("keeps stop available when only the server reports an active generation", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.queueSnapshot = {
      activeGenerationId: "generation-1",
      items: [],
    };

    const { container } = renderChat();

    await clickEnabledButtonByAriaLabel(container, "Stop streaming");

    expect(mockState.stopMessageStream).toHaveBeenCalledWith("chat-1");
  });

  it("queues a composer follow-up instead of sending a new stream when the server reports an active generation", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.queueSnapshot = {
      activeGenerationId: "generation-1",
      items: [],
    };

    const { container } = renderChat();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Composer draft']");
    expect(textarea).not.toBeNull();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(textarea, "Add this after the current reply.");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await clickEnabledButtonByAriaLabel(container, "Queue follow-up");

    expect(mockState.createQueuedMessage).toHaveBeenCalledTimes(1);
    expect(mockState.createQueuedMessage).toHaveBeenCalledWith("chat-1", expect.objectContaining({
      expectedGenerationId: "generation-1",
      payload: expect.objectContaining({
        body: "Add this after the current reply.",
        metadata: { source: "chat_composer" },
      }),
    }));
    expect(mockState.sendMessageStream).not.toHaveBeenCalled();
  });

  it("renders claimed queued follow-ups without editable queue actions before delivery", () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.queueSnapshot = {
      activeGenerationId: "generation-1",
      items: [
        queuedMessage({
          status: "dequeue_claimed",
          payload: {
            body: "Already delivering",
            attachmentIds: [],
            projectId: null,
            skillRefs: [],
            accessMode: null,
            model: null,
            effort: null,
            metadata: null,
          },
        }),
      ],
    };

    const { container } = renderChat();
    const queueItem = container.querySelector("[data-testid='chat-running-queue-item']");

    expect(queueItem?.textContent).toContain("Running");
    expect(queueItem?.textContent).toContain("Already delivering");
    expect(queueItem?.querySelector("button[aria-label='Edit queued message']")).toBeNull();
    expect(queueItem?.querySelector("button[aria-label='Delete queued message']")).toBeNull();
    expect(queueItem?.textContent).not.toContain("Steer");
  });

  it("hides queued follow-ups after the queued message is delivered", () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.queueSnapshot = {
      activeGenerationId: "generation-2",
      items: [
        queuedMessage({
          status: "running",
          sourceMessageId: "user-message-2",
          deliveredMessageId: "user-message-2",
          payload: {
            body: "Already delivered",
            attachmentIds: [],
            projectId: null,
            skillRefs: [],
            accessMode: null,
            model: null,
            effort: null,
            metadata: null,
          },
        }),
      ],
    };

    const { container } = renderChat();

    expect(container.querySelector("[data-testid='chat-running-queue']")).toBeNull();
    expect(container.textContent).not.toContain("Already delivered");
  });
});

describe("Feishu-backed chat controls", () => {
  function feishuChat(overrides: Partial<ChatConversation> = {}) {
    return chat({
      mutability: "external_bound_chat",
      sourceMetadata: {
        source: "agent_integration",
        provider: "feishu",
        integrationId: "integration-1",
        externalChatId: "oc_chat",
        externalChatType: "p2p",
      },
      ...overrides,
    });
  }

  it("shows a read-only fork CTA instead of sending Feishu quick commands", async () => {
    mockState.conversations = [feishuChat()];
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "plain-user-message", body: "Message from Feishu" })],
    };

    const { container } = renderChat();

    expect(container.querySelector("[data-testid='chat-external-bound-readonly']")).not.toBeNull();
    expect(container.querySelector("textarea[aria-label='Composer draft']")).toBeNull();
    expect(container.querySelector("[data-testid='feishu-quick-command']")).toBeNull();
    const forkButton = container.querySelector<HTMLButtonElement>("[data-testid='chat-fork-to-continue']");
    expect(forkButton).not.toBeNull();

    await act(async () => {
      forkButton?.click();
      await Promise.resolve();
    });

    expect(mockState.sendMessageStream).not.toHaveBeenCalled();
    expect(mockState.mutations.at(-1)).toEqual({ chatId: "chat-1" });
  });

  it("allows normal composer controls in a native fork from Feishu", () => {
    mockState.conversations = [
      chat({
        id: "chat-fork",
        title: "Forked Feishu chat",
        forkedFromConversationId: "chat-1",
        forkRootConversationId: "chat-1",
        mutability: "native_fork_from_external",
      }),
    ];
    mockState.conversationId = "chat-fork";
    mockState.messagesByChatId = {
      "chat-fork": [message({ id: "fork-message", conversationId: "chat-fork", body: "Continue in Rudder" })],
    };

    const { container } = renderChat();

    expect(container.querySelector("[data-testid='chat-external-bound-readonly']")).toBeNull();
    expect(container.querySelector("textarea[aria-label='Composer draft']")).not.toBeNull();
  });

  it("hides local mutation actions for Feishu-backed chats", async () => {
    mockState.conversations = [feishuChat()];
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "plain-user-message", body: "Message from Feishu" })],
    };

    const { container } = renderChat();
    const sidePanelTrigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-side-panel-trigger"]');
    expect(sidePanelTrigger).not.toBeNull();

    await act(async () => {
      sidePanelTrigger?.click();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Open a panel");
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Browser");
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Library");

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>("[data-testid='chat-side-panel'] button"))
        .find((button) => button.textContent?.includes("Library"))
        ?.click();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Library root");

    const actionsTrigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-actions-trigger"]');
    expect(actionsTrigger).not.toBeNull();

    await act(async () => {
      actionsTrigger?.dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Pin");
    expect(document.body.textContent).toContain("Fork");
    expect(document.body.textContent).not.toContain("Open Side Panel");
    expect(document.body.textContent).not.toContain("Rename");
    expect(document.body.textContent).not.toContain("Regenerate title");
    expect(document.body.textContent).not.toContain("Delete");
    expect(document.body.textContent).not.toContain("Archive");
  });
});

describe("Chat attachment previews", () => {
  it("renders the chat workspace as an internal card without negative shell margins", () => {
    const { container } = renderChat();

    const shell = container.querySelector(".chat-shell");
    expect(shell?.className).not.toContain("md:-mx-3.5");
    expect(shell?.className).not.toContain("lg:-mx-5");
    expect(container.querySelector("main.workspace-main-card")).not.toBeNull();
  });

  it("opens message image previews while a pending proposal hides the composer and clears on conversation change", () => {
    const { container, rerender } = renderChat();

    expect(container.querySelector("[data-testid='proposal-review-block']")).not.toBeNull();
    expect(container.querySelector("[data-testid='chat-composer-toolbar']")).toBeNull();

    const imageButton = container.querySelector<HTMLButtonElement>(
      "[data-testid='chat-image-attachment'] button",
    );
    expect(imageButton).not.toBeNull();

    act(() => {
      imageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const preview = document.body.querySelector("[data-testid='chat-image-preview-dialog']");
    expect(preview).not.toBeNull();
    expect(preview?.querySelector("img")?.getAttribute("alt")).toBe("proposal-screenshot.png");

    mockState.conversationId = "chat-2";
    rerender();

    expect(document.body.querySelector("[data-testid='chat-image-preview-dialog']")).toBeNull();
  });

  it("opens sent image previews on double-click", () => {
    mockState.messagesByChatId = {
      "chat-1": [imageMessage()],
    };

    const { container } = renderChat();
    const imageButton = container.querySelector<HTMLButtonElement>(
      "[data-testid='chat-image-attachment'] button",
    );
    expect(imageButton).not.toBeNull();

    act(() => {
      imageButton?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });

    const preview = document.body.querySelector("[data-testid='chat-image-preview-dialog']");
    expect(preview).not.toBeNull();
    expect(preview?.querySelector("img")?.getAttribute("alt")).toBe("proposal-screenshot.png");
  });

  it("opens pending composer image previews on double-click", () => {
    const attachment = new File(["draft image"], "draft-screenshot.png", { type: "image/png" });
    updateChatPendingAttachmentsForScope(
      resolveChatPendingAttachmentScopeKey("org-1", "chat-1"),
      () => [attachment],
    );
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "plain-user-message", body: "Please inspect this." })],
    };

    const { container } = renderChat();
    const imageButton = container.querySelector<HTMLButtonElement>(
      "[data-testid='chat-pending-image-attachment'] button",
    );
    expect(imageButton).not.toBeNull();

    act(() => {
      imageButton?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });

    const preview = document.body.querySelector("[data-testid='chat-image-preview-dialog']");
    expect(preview).not.toBeNull();
    expect(preview?.querySelector("img")?.getAttribute("alt")).toBe("draft-screenshot.png");
  });

  it("hides new-chat use cases when pending attachments are staged", () => {
    const attachment = new File(["draft attachment"], "scope-notes.txt", { type: "text/plain" });
    mockState.conversationId = null;
    mockState.conversations = [];
    mockState.messagesByChatId = {};
    updateChatPendingAttachmentsForScope(
      resolveChatPendingAttachmentScopeKey("org-1", null),
      () => [attachment],
    );

    const { container } = renderChat();

    expect(container.querySelector("[data-testid='chat-pending-attachments']")).not.toBeNull();
    expect(container.querySelector("[data-testid='chat-pending-attachment']")).not.toBeNull();
    expect(container.textContent).not.toContain("Scope a new feature");
    expect(container.textContent).not.toContain("Clarify a vague request");
    expect(container.textContent).not.toContain("Turn a chat into an issue");
  });

  it("keeps multiple pasted images with identical clipboard metadata staged", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "plain-user-message", body: "Please inspect these screenshots." })],
    };

    const { container } = renderChat();
    const editorScroll = container.querySelector("[data-testid='chat-composer-editor-scroll']");
    expect(editorScroll).not.toBeNull();

    const images = Array.from({ length: 4 }, (_, index) =>
      new File([`image-${index}`], "image.png", {
        type: "image/png",
        lastModified: 1000,
      })
    );
    await act(async () => {
      dispatchPasteFiles(editorScroll!, images);
      await Promise.resolve();
    });

    expect(container.querySelectorAll("[data-testid='chat-pending-attachment']")).toHaveLength(4);
    expect(container.querySelectorAll("[data-testid='chat-pending-image-attachment']")).toHaveLength(4);

    const removeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[aria-label='Remove image.png']"),
    );
    expect(removeButtons).toHaveLength(4);

    await act(async () => {
      removeButtons[0]?.click();
      await Promise.resolve();
    });

    expect(container.querySelectorAll("[data-testid='chat-pending-attachment']")).toHaveLength(3);
  });

  it("approves issue proposals with the operator-selected issue status", async () => {
    const { container } = renderChat();

    const statusTrigger = container.querySelector<HTMLButtonElement>('button[aria-label="Edit status"]');
    expect(statusTrigger).not.toBeNull();

    await act(async () => {
      statusTrigger?.dispatchEvent(new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }));
      await Promise.resolve();
    });

    const inReviewOption = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (candidate) => candidate.textContent?.includes("in review"),
    );
    expect(inReviewOption).not.toBeUndefined();

    await act(async () => {
      inReviewOption?.click();
      await Promise.resolve();
    });

    await clickEnabledButton(container, "Approve");

    expect(mockState.mutations.at(-1)).toMatchObject({
      approvalId: "approval-1",
      action: "approve",
      messageId: "proposal-1",
      payloadOverride: {
        proposedIssue: {
          title: "Fix attachment preview",
          description: "Move the preview dialog outside the composer.",
          priority: "medium",
          status: "in_review",
        },
      },
    });
  });
});

describe("Chat ask_user panel", () => {
  const multilineFreeformAnswer = [
    "Answering the requested input:",
    "",
    "- Scope",
    "  Answer: Use the narrow path",
    "    - keep API extensible",
    "    - defer broad UI",
  ].join("\n");

  it("hides the bottom composer while input is pending and restores it after an answer", () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
      ],
    };

    const { container, rerender } = renderChat();

    expect(container.querySelector("[data-testid='chat-ask-user-panel']")).not.toBeNull();
    expect(container.querySelector("[data-testid='chat-composer-toolbar']")).toBeNull();
    expect(container.textContent).not.toContain("Choose an answer to continue");
    expect(container.textContent).not.toContain("The assistant is waiting on this decision.");
    expect(container.textContent).not.toContain("You can still type in the composer below.");

    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
        message({
          id: "user-answer",
          body: "Answering the requested input:\n\n- Scope\n  Answer: Narrow path",
          createdAt: new Date("2026-05-12T09:04:00.000Z"),
        }),
      ],
    };
    rerender();

    expect(container.querySelector("[data-testid='chat-ask-user-panel']")).toBeNull();
    expect(container.querySelector("[data-testid='chat-ask-user-answer']")).not.toBeNull();
    expect(container.textContent).toContain("Answered");
    expect(container.textContent).not.toContain("Answering the requested input:");
    expect(container.querySelector("[data-testid='chat-composer-toolbar']")).not.toBeNull();
  });

  it("lets Other answers include pending attachments", async () => {
    const attachment = new File(["log output"], "failure-log.txt", { type: "text/plain" });
    updateChatPendingAttachmentsForScope(
      resolveChatPendingAttachmentScopeKey("org-1", "chat-1"),
      () => [attachment],
    );
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
      ],
    };

    const { container } = renderChat();
    const panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();

    await clickEnabledButton(container, "Other");
    expect(panel?.textContent).toContain("Attach");
    expect(panel?.textContent).toContain("failure-log.txt");
    expect(container.querySelector("[data-testid='chat-ask-user-pending-attachment']")).not.toBeNull();

    const textarea = panel?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(textarea, "This needs the attached log.");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await clickEnabledButton(container, "Submit answer");

    expect(mockState.sendMessageStream).toHaveBeenCalledTimes(1);
    expect(mockState.sendMessageStream.mock.calls[0]?.[2]).toMatchObject({
      files: [attachment],
    });
    expect(container.querySelector("[data-testid='chat-ask-user-pending-attachment']")).toBeNull();
  });

  it("opens Other answer pending image previews on double-click", async () => {
    const attachment = new File(["image bytes"], "answer-screenshot.png", { type: "image/png" });
    updateChatPendingAttachmentsForScope(
      resolveChatPendingAttachmentScopeKey("org-1", "chat-1"),
      () => [attachment],
    );
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
      ],
    };

    const { container } = renderChat();
    const panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();

    await clickEnabledButton(container, "Other");

    const imageButton = panel?.querySelector<HTMLButtonElement>(
      "[data-testid='chat-pending-image-attachment'] button",
    );
    expect(imageButton).not.toBeNull();

    act(() => {
      imageButton?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });

    const preview = document.body.querySelector("[data-testid='chat-image-preview-dialog']");
    expect(preview).not.toBeNull();
    expect(preview?.querySelector("img")?.getAttribute("alt")).toBe("answer-screenshot.png");
  });

  it("lets Other answers paste attachments directly into the input panel", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
      ],
    };

    const { container } = renderChat();
    const panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();

    await clickEnabledButton(container, "Other");
    const textarea = panel?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    const attachment = new File(["receipt details"], "receipt.txt", { type: "text/plain" });
    await act(async () => {
      dispatchPasteFiles(textarea!, [attachment]);
      await Promise.resolve();
    });

    expect(panel?.textContent).toContain("receipt.txt");
    expect(container.querySelector("[data-testid='chat-ask-user-pending-attachment']")).not.toBeNull();

    await clickEnabledButton(container, "Submit answer");

    expect(mockState.sendMessageStream).toHaveBeenCalledTimes(1);
    const sentFiles = mockState.sendMessageStream.mock.calls[0]?.[2]?.files as File[] | undefined;
    expect(sentFiles).toHaveLength(1);
    expect(sentFiles?.[0]?.name).toBe("receipt.txt");
    expect(container.querySelector("[data-testid='chat-ask-user-pending-attachment']")).toBeNull();
  });

  it("dedupes pasted attachments exposed through both clipboard items and files", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
      ],
    };

    const { container } = renderChat();
    const panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();

    await clickEnabledButton(container, "Other");
    const textarea = panel?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();

    const clipboardItemFile = new File(["receipt image"], "receipt.png", {
      type: "image/png",
      lastModified: 1000,
    });
    const clipboardListFile = new File(["receipt image"], "receipt.png", {
      type: "image/png",
      lastModified: 2000,
    });
    await act(async () => {
      dispatchPasteFiles(textarea!, [clipboardItemFile], { clipboardFiles: [clipboardListFile] });
      await Promise.resolve();
    });

    expect(container.querySelectorAll("[data-testid='chat-ask-user-pending-attachment']")).toHaveLength(1);

    await clickEnabledButton(container, "Submit answer");

    expect(mockState.sendMessageStream).toHaveBeenCalledTimes(1);
    const sentFiles = mockState.sendMessageStream.mock.calls[0]?.[2]?.files as File[] | undefined;
    expect(sentFiles).toHaveLength(1);
    expect(sentFiles?.[0]?.name).toBe("receipt.png");
  });

  it("renders persisted multiline Other answers without dropping bullet lines", () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
        message({
          id: "user-answer",
          body: multilineFreeformAnswer,
          createdAt: new Date("2026-05-12T09:04:00.000Z"),
        }),
      ],
    };

    const { container } = renderChat();

    const answer = container.querySelector("[data-testid='chat-ask-user-answer']");
    expect(answer).not.toBeNull();
    expect(answer?.textContent).toContain("Use the narrow path");
    expect(answer?.textContent).toContain("- keep API extensible");
    expect(answer?.textContent).toContain("- defer broad UI");
    expect(container.textContent).not.toContain("Answering the requested input:");
  });

  it("renders optimistic multiline Other answers without dropping bullet lines", () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser(),
      ],
    };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        userBody: multilineFreeformAnswer,
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: null,
        chatTurnId: "turn-ask-user",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: "",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };

    const { container } = renderChat();

    const answer = container.querySelector("[data-testid='chat-ask-user-answer']");
    expect(answer).not.toBeNull();
    expect(answer?.textContent).toContain("Use the narrow path");
    expect(answer?.textContent).toContain("- keep API extensible");
    expect(answer?.textContent).toContain("- defer broad UI");
    expect(container.textContent).not.toContain("Answering the requested input:");
  });

  it("steps through multi-question input instead of expanding every question", () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingMultiAskUser(),
      ],
    };

    const { container } = renderChat();
    const panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("Question 1 of 3");
    expect(panel?.textContent).toContain("Scope");
    expect(panel?.textContent).toContain("Narrow path");
    expect(panel?.textContent).not.toContain("Missing tests");
    expect(panel?.textContent).not.toContain("Short summary");

    const clickButton = (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes(label)
      );
      expect(button).not.toBeUndefined();
      act(() => {
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };

    clickButton("Narrow path");
    expect(panel?.textContent).toContain("Question 2 of 3");
    expect(panel?.textContent).toContain("Missing tests");
    expect(panel?.textContent).not.toContain("Short summary");

    clickButton("Back");
    expect(panel?.textContent).toContain("Question 1 of 3");
    expect(panel?.textContent).toContain("Broad path");

    clickButton("Broad path");
    clickButton("Missing tests");
    expect(panel?.textContent).toContain("Question 3 of 3");
    clickButton("Other");

    const textarea = panel?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(textarea, "Include screenshot evidence");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    clickButton("Review answers");
    expect(panel?.textContent).toContain("Review answers");
    expect(panel?.textContent).toContain("Broad path");
    expect(panel?.textContent).toContain("Missing tests");
    expect(panel?.textContent).toContain("Include screenshot evidence");
    expect(panel?.textContent).not.toContain("Question 3 of 3");
  });

  it("restores unfinished ask_user selections after switching conversations and clears them on submit", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingMultiAskUser(),
      ],
      "chat-2": [message({ id: "other-message-1", conversationId: "chat-2", body: "Other chat" })],
    };

    const { container, rerender } = renderChat();
    let panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();

    await clickEnabledButton(container, "Broad path");
    await clickEnabledButton(container, "Missing tests");
    await clickEnabledButton(container, "Other");
    const textarea = panel?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(textarea, "Include screenshot evidence");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickEnabledButton(container, "Review answers");
    expect(panel?.textContent).toContain("Review answers");

    mockState.conversationId = "chat-2";
    rerender();
    expect(container.querySelector("[data-testid='chat-ask-user-panel']")).toBeNull();

    mockState.conversationId = "chat-1";
    rerender();
    panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain("Review answers");
    expect(panel?.textContent).toContain("Broad path");
    expect(panel?.textContent).toContain("Missing tests");
    expect(panel?.textContent).toContain("Include screenshot evidence");

    await clickEnabledButton(container, "Submit answer");

    expect(mockState.sendMessageStream).toHaveBeenCalledTimes(1);
    expect(mockState.sendMessageStream.mock.calls[0]?.[1]).toContain("Answer: Broad path");
    expect(readChatAskUserDraft("org-1", "ask-user-multi-1")).toBeNull();
  });

  it("keeps ask_user draft when answer submission fails before ack", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingMultiAskUser(),
      ],
    };
    mockState.sendMessageStream.mockImplementationOnce(async () => {
      throw new Error("Network failed before ack");
    });

    const { container } = renderChat();
    let panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();

    await clickEnabledButton(container, "Broad path");
    await clickEnabledButton(container, "Missing tests");
    await clickEnabledButton(container, "Other");
    const textarea = panel?.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(textarea, "Keep the draft through failure");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickEnabledButton(container, "Review answers");

    await clickEnabledButton(container, "Submit answer");
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockState.sendMessageStream).toHaveBeenCalledTimes(1);
    expect(mockState.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Network failed before ack",
      tone: "error",
    }));
    const draft = readChatAskUserDraft("org-1", "ask-user-multi-1");
    expect(draft).not.toBeNull();
    expect(draft?.reviewingAnswers).toBe(true);
    expect(draft?.selectedByQuestionId.scope).toEqual(["broad"]);
    expect(draft?.selectedByQuestionId.risk).toEqual(["tests"]);
    expect(draft?.freeformByQuestionId.handoff).toBe("Keep the draft through failure");

    panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel?.textContent).toContain("Review answers");
    expect(panel?.textContent).toContain("Broad path");
    expect(panel?.textContent).toContain("Missing tests");
    expect(panel?.textContent).toContain("Keep the draft through failure");
  });

  it("lets one ask_user question collect multiple selected options", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({ id: "user-before-ask", body: "Please help scope this." }),
        pendingAskUser({
          structuredPayload: {
            requestUserInput: {
              questions: [
                {
                  id: "evidence",
                  header: "Evidence",
                  question: "Which evidence should the agent collect?",
                  selectionMode: "multiple",
                  options: [
                    { id: "tests", label: "Test output" },
                    { id: "screenshots", label: "Screenshots" },
                    { id: "diff", label: "Diff summary" },
                  ],
                  allowFreeform: false,
                },
              ],
            },
          },
        }),
      ],
    };

    const { container } = renderChat();
    const panel = container.querySelector("[data-testid='chat-ask-user-panel']");
    expect(panel).not.toBeNull();

    await clickEnabledButton(container, "Test output");
    expect(panel?.textContent).toContain("Screenshots");
    await clickEnabledButton(container, "Screenshots");
    await clickEnabledButton(container, "Submit answer");

    expect(mockState.sendMessageStream).toHaveBeenCalledTimes(1);
    expect(mockState.sendMessageStream.mock.calls[0]?.[1]).toContain("Answer: Test output, Screenshots");
  });
});

describe("Chat project context selector", () => {
  it("does not render resource counts in the project context menu", () => {
    mockState.conversations = [chat({ id: "chat-1", lastMessageAt: null })];
    mockState.messagesByChatId = { "chat-1": [] };
    mockState.projects = [
      project({
        name: "Rudder mkt",
        resources: [
          {
            id: "attachment-1",
            orgId: "org-1",
            projectId: "10000000-0000-4000-8000-000000000010",
            resourceId: "resource-1",
            role: "working_set",
            note: null,
            sortOrder: 0,
            resource: {
              id: "resource-1",
              orgId: "org-1",
              name: "Main repo",
              kind: "directory",
              sourceType: "external",
              locator: "/Users/zeeland/projects/rudder-oss",
              description: null,
              metadata: null,
              createdAt: new Date("2026-05-12T09:00:00.000Z"),
              updatedAt: new Date("2026-05-12T09:00:00.000Z"),
            },
            createdAt: new Date("2026-05-12T09:00:00.000Z"),
            updatedAt: new Date("2026-05-12T09:00:00.000Z"),
          },
        ],
      }),
    ];

    const { container } = renderChat();

    const projectSelector = container.querySelector<HTMLButtonElement>("[data-testid='chat-project-selector']");
    expect(projectSelector).not.toBeNull();

    act(() => {
      projectSelector?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const projectMenu = document.body.querySelector("[data-testid='chat-project-menu']");
    expect(projectMenu).not.toBeNull();
    expect(projectMenu?.textContent).toContain("Rudder mkt");
    expect(projectMenu?.textContent).not.toMatch(/\b\d+\s+resources\b/u);
  });

  it("hides the no-project selector after a conversation starts without project context", () => {
    mockState.conversations = [chat({ id: "chat-1" })];
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "message-1",
          role: "user",
          kind: "message",
          body: "What skill do you have?",
          createdAt: new Date("2026-05-12T09:01:00.000Z"),
          updatedAt: new Date("2026-05-12T09:01:00.000Z"),
        }),
      ],
    };
    mockState.projects = [project({ name: "Rudder mkt" })];

    const { container } = renderChat();

    expect(container.querySelector("[data-testid='chat-project-selector']")).toBeNull();
  });

  it("locks the project selector after a conversation already has project context", () => {
    mockState.conversations = [
      chat({
        id: "chat-1",
        contextLinks: [
          {
            id: "context-project-1",
            orgId: "org-1",
            conversationId: "chat-1",
            entityType: "project",
            entityId: "10000000-0000-4000-8000-000000000010",
            metadata: null,
            entity: {
              type: "project",
              id: "10000000-0000-4000-8000-000000000010",
              label: "Rudder mkt",
              subtitle: null,
              identifier: null,
              status: "active",
              href: "/projects/10000000-0000-4000-8000-000000000010",
            },
            createdAt: new Date("2026-05-12T09:00:00.000Z"),
            updatedAt: new Date("2026-05-12T09:00:00.000Z"),
          },
        ],
      }),
    ];
    mockState.messagesByChatId = { "chat-1": [] };

    const { container } = renderChat();

    const projectSelector = container.querySelector<HTMLButtonElement>("[data-testid='chat-project-selector']");
    expect(projectSelector).not.toBeNull();
    expect(projectSelector?.textContent).toContain("Rudder mkt");
    expect(projectSelector?.disabled).toBe(true);
    expect(container.querySelector("[data-testid='chat-project-selector-chevron']")).toBeNull();

    act(() => {
      projectSelector?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.querySelector("[data-testid='chat-project-menu']")).toBeNull();
    expect(projectSelector?.textContent).toContain("Rudder mkt");
    expect(mockState.mutations).toEqual([]);
  });
});
