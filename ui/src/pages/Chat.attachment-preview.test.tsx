// @vitest-environment jsdom

import { ApiError } from "@/api/client";
import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import { ImagePreviewProvider } from "@/context/ImagePreviewContext";
import { SidePanelProvider, useSidePanel } from "@/context/SidePanelContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { readChatAskUserDraft } from "@/lib/chat-draft-storage";
import {
  resetChatPendingAttachmentsForTests,
  resolveChatPendingAttachmentScopeKey,
  updateChatPendingAttachmentsForScope,
} from "@/lib/chat-pending-attachments";
import {
  readPendingChatStopRecovery,
} from "@/lib/chat-stop-recovery";
import { buildAgentMentionHref, buildAutomationMentionHref, buildChatMentionHref, buildIssueMentionHref, type Agent, type AutomationDetail, type AutomationRunSummary, type BrowserShortcutAction, type ChatConversation, type ChatMessage, type ChatQueuedMessage, type ChatQueueSnapshot, type ChatRuntimeDescriptor, type ChatStreamEvent, type Goal, type Issue, type IssueComment, type IssueLabel, type OrganizationWorkspaceFileEntry, type Project } from "@rudderhq/shared";
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const mockState = vi.hoisted(() => ({
  abortChatStream: vi.fn(),
  conversationId: "chat-1" as string | null,
  conversations: [] as ChatConversation[],
  messagesByChatId: {} as Record<string, ChatMessage[]>,
  fetchingChatDetailIds: new Set<string>(),
  failedChatDetailIds: new Set<string>(),
  pendingChatDetailIds: new Set<string>(),
  issues: {} as Record<string, Issue>,
  issueComments: {} as Record<string, IssueComment[]>,
  agents: [] as Agent[],
  goals: [] as Goal[],
  labels: [] as IssueLabel[],
  automations: {} as Record<string, AutomationDetail>,
  automationRuns: {} as Record<string, AutomationRunSummary[]>,
  projects: [] as Project[],
  routeBase: "/messenger/chat",
  workspaceDirectories: {} as Record<string, { directoryPath: string; entries: OrganizationWorkspaceFileEntry[] }>,
  workspaceFiles: {} as Record<string, { rootPath?: string | null; filePath: string; content: string | null; contentType: string | null; previewKind: "text" | "image" | "pdf" | "binary"; contentPath: string | null; message?: string | null; truncated: boolean }>,
  queueSnapshot: {
    activeGenerationId: null,
    activeAttemptEpoch: null,
    activeControlVersion: null,
    activeGenerationStatus: null,
    items: [],
  } as ChatQueueSnapshot,
  cancelQueuedMessage: vi.fn(),
  checkpointMessageStream: vi.fn(),
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
  refetchChatDetail: vi.fn(),
  removeQueries: vi.fn(),
  destroySideChat: vi.fn(),
  keepSideChat: vi.fn(),
  updateWorkspaceFile: vi.fn(),
  sendInFlightByChatId: {} as Record<string, true>,
  setChatSendInFlight: vi.fn(),
  createConversation: vi.fn(),
  draftPreflight: {
    sourceType: "agent",
    sourceLabel: "Wesley",
    runtimeAgentId: "agent-1",
    agentRuntimeType: "codex",
    model: null,
    available: true,
    error: null,
  } as ChatRuntimeDescriptor,
  preflightDraft: vi.fn(),
  sendFirstMessageStream: vi.fn(),
  sendMessageStream: vi.fn(),
  setStreamDraftForChat: vi.fn(),
  setSidebarOpen: vi.fn(),
  sidebarOpen: true,
  setQueriesData: vi.fn(),
  setQueryData: vi.fn(),
  setBreadcrumbs: vi.fn(),
  stopMessageStream: vi.fn(),
  streamDrafts: {} as Record<string, ChatStreamDraft>,
  intelligenceProfiles: [] as Array<{ id: string; orgId: string; purpose: string; status: string }>,
  browserShortcutListener: null as ((action: BrowserShortcutAction) => void) | null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled = true }: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    if (!enabled) {
      return {
        data: undefined,
        isPending: false,
        isLoading: false,
        error: null,
        refetch: mockState.refetchChatDetail,
      };
    }
    mockState.queryKeys.push([...queryKey]);
    if (queryKey[0] === "chats" && queryKey[2] === "active") {
      return { data: mockState.conversations, isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "chats" && queryKey[2] === "detail") {
      const chatId = String(queryKey[3]);
      const data = mockState.conversations.find((chat) => chat.id === chatId) ?? null;
      if (mockState.pendingChatDetailIds.has(String(queryKey[3]))) {
        return {
          data: undefined,
          isPending: true,
          isLoading: true,
          isFetching: true,
          isError: false,
          error: null,
          refetch: mockState.refetchChatDetail,
        };
      }
      if (mockState.fetchingChatDetailIds.has(chatId)) {
        return {
          data,
          isPending: false,
          isLoading: false,
          isFetching: true,
          isError: false,
          error: null,
          refetch: mockState.refetchChatDetail,
        };
      }
      if (mockState.failedChatDetailIds.has(chatId)) {
        return {
          data,
          isPending: false,
          isLoading: false,
          isFetching: false,
          isError: true,
          error: new Error("Side Chat status failed to load"),
          refetch: mockState.refetchChatDetail,
        };
      }
      return {
        data,
        isPending: false,
        isLoading: false,
        isFetching: false,
        isError: false,
        error: null,
        refetch: mockState.refetchChatDetail,
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
    if (queryKey[0] === "chats" && queryKey[2] === "draft-preflight") {
      return {
        data: mockState.draftPreflight,
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
    if (queryKey[0] === "organizations" && queryKey[2] === "intelligence-profiles") {
      return { data: mockState.intelligenceProfiles, isPending: false, isLoading: false, error: null };
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
    if (queryKey[0] === "instance" && queryKey[1] === "browser-settings") {
      return { data: { enabled: true, openLinksIn: "built_in" }, isPending: false, isLoading: false, error: null };
    }
    if (queryKey[0] === "instance") {
      return { data: { nickname: "" }, isPending: false, isLoading: false, error: null };
    }
    return { data: [], isPending: false, isLoading: false, error: null };
  },
  useMutation: (options?: {
    mutationFn?: (variables: unknown) => unknown | Promise<unknown>;
    onSuccess?: (data: unknown, variables: unknown) => void | Promise<void>;
    onError?: (error: unknown, variables: unknown) => void | Promise<void>;
  }) => ({
    isPending: false,
    mutate: (variables: unknown) => {
      mockState.mutations.push(variables);
      mockState.markRead(variables);
    },
    mutateAsync: async (variables: unknown) => {
      mockState.mutations.push(variables);
      try {
        const data = await Promise.resolve(options?.mutationFn?.(variables) ?? variables);
        mockState.markRead(variables);
        await options?.onSuccess?.(data, variables);
        return data;
      } catch (error) {
        await options?.onError?.(error, variables);
        throw error;
      }
    },
  }),
  useQueryClient: () => ({
    getQueryData: mockState.getQueryData,
    invalidateQueries: mockState.invalidateQueries,
    removeQueries: mockState.removeQueries,
    setQueryData: mockState.setQueryData,
    setQueriesData: mockState.setQueriesData,
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({
    pathname: mockState.conversationId ? `${mockState.routeBase}/${mockState.conversationId}` : mockState.routeBase,
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
    pathname: mockState.conversationId ? `${mockState.routeBase}/${mockState.conversationId}` : mockState.routeBase,
    search: "",
    hash: "",
    key: "chat",
  }),
  useNavigate: () => mockState.navigate,
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    selectedOrganization: { id: "org-1", name: "Rudder", issuePrefix: "RUD", urlKey: "rudder" },
  }),
}));

vi.mock("@/components/WorkspacePdfPreview", () => ({
  WorkspacePdfPreview: ({ src, testId, title }: { src: string; testId: string; title: string }) => (
    <canvas aria-label={title} data-pdf-src={src} data-rendered-page="1" data-testid={testId} />
  ),
}));

vi.mock("@/hooks/useViewedOrganization", () => ({
  useViewedOrganization: () => ({ viewedOrganizationId: "org-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockState.setBreadcrumbs }),
}));

vi.mock("@/context/ToastContext", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ pushToast: mockState.pushToast }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true), openNewIssue: vi.fn() }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockState.setSidebarOpen,
    sidebarOpen: mockState.sidebarOpen,
  }),
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
    abortChatStream: mockState.abortChatStream,
    sendInFlightByChatId: mockState.sendInFlightByChatId,
    setChatSendInFlight: mockState.setChatSendInFlight,
    setStreamAbortController: vi.fn(),
    setStreamDraftForChat: mockState.setStreamDraftForChat,
    streamDrafts: mockState.streamDrafts,
  }),
}));

vi.mock("@/api/chats", () => ({
  chatsApi: {
    create: mockState.createConversation,
    preflightDraft: mockState.preflightDraft,
    sendFirstMessageStream: mockState.sendFirstMessageStream,
    get: vi.fn(),
    update: vi.fn(async (_chatId: string, patch: Partial<ChatConversation>) => ({
      ...mockState.conversations[0],
      ...patch,
    })),
    regenerateTitle: vi.fn(async (chatId: string) => ({
      ...mockState.conversations.find((conversation) => conversation.id === chatId),
      title: "Regenerated Feishu title",
    })),
    checkpointMessageStream: mockState.checkpointMessageStream,
    stopMessageStream: mockState.stopMessageStream,
    sendMessageStream: mockState.sendMessageStream,
    destroySideChat: mockState.destroySideChat,
    keepSideChat: mockState.keepSideChat,
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

vi.mock("@/api/orgs", () => ({
  organizationsApi: {
    createWorkspaceWebPreviewSession: vi.fn(async (_organizationId: string, request: { networkMode: "connected" | "offline" }) => ({
      previewUrl: "http://preview.localhost:3100/workspace-preview/test-token/index.html",
      networkMode: request.networkMode,
      expiresAt: "2026-07-15T12:00:00.000Z",
    })),
    readWorkspaceFile: vi.fn(async (_organizationId: string, filePath: string) => mockState.workspaceFiles[filePath]),
    listWorkspaceFiles: vi.fn(),
    updateWorkspaceFile: (...args: unknown[]) => mockState.updateWorkspaceFile(...args),
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
      const undoStackRef = React.useRef<string[]>([]);
      const redoStackRef = React.useRef<string[]>([]);
      React.useImperativeHandle(ref, () => ({
        focus: vi.fn(),
        getMarkdown: () => props.value,
        undo: () => {
          const previous = undoStackRef.current.pop();
          if (previous === undefined) return false;
          redoStackRef.current.push(props.value);
          props.onChange(previous);
          return true;
        },
        redo: () => {
          const next = redoStackRef.current.pop();
          if (next === undefined) return false;
          undoStackRef.current.push(props.value);
          props.onChange(next);
          return true;
        },
        canUndo: () => undoStackRef.current.length > 0,
        canRedo: () => redoStackRef.current.length > 0,
      }));
      return (
        <textarea
          aria-label="Composer draft"
          data-testid="mock-markdown-editor"
          placeholder={props.placeholder}
          value={props.value}
          onChange={(event) => {
            undoStackRef.current.push(props.value);
            redoStackRef.current = [];
            props.onChange(event.currentTarget.value);
          }}
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
let sessionStorageState: Record<string, string> = {};

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
    deliveryIntent: "queue",
    deliveryDisposition: null,
    controlActionId: null,
    expectedGenerationId: null,
    activeGenerationId: null,
    attemptEpoch: null,
    providerClientMessageId: null,
    providerThreadId: null,
    providerTurnId: null,
    providerEvidence: null,
    continuationGenerationId: null,
    continuationMessageId: null,
    deliveryLeaseToken: null,
    deliveryLeaseEpoch: 0,
    deliveryLeaseOwner: null,
    deliveryLeaseExpiresAt: null,
    reconciliationReason: null,
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

function queueSnapshot(overrides: Partial<ChatQueueSnapshot> = {}): ChatQueueSnapshot {
  return {
    activeGenerationId: null,
    activeAttemptEpoch: null,
    activeControlVersion: null,
    activeGenerationStatus: null,
    items: [],
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
  sessionStorageState = {};
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
  vi.stubGlobal("sessionStorage", {
    getItem: vi.fn((key: string) => sessionStorageState[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      sessionStorageState[key] = String(value);
    }),
    removeItem: vi.fn((key: string) => {
      delete sessionStorageState[key];
    }),
    clear: vi.fn(() => {
      sessionStorageState = {};
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
        <ImagePreviewProvider>
          <SidePanelProvider>
            <SidePanelTestContextBinder />
            <Chat />
            <ChatSidePanel
              selectedOrganizationId="org-1"
              expanded={expanded}
              onToggleExpanded={toggleSidePanelExpanded}
            />
          </SidePanelProvider>
        </ImagePreviewProvider>
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

async function startControlledChatStream() {
  let onStreamEvent!: (event: ChatStreamEvent) => void | Promise<void>;
  let resolveStream!: () => void;
  mockState.messagesByChatId = {
    "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
  };
  mockState.sendMessageStream.mockImplementationOnce((
    _chatId: string,
    _body: string,
    options: { onEvent: (event: ChatStreamEvent) => void | Promise<void> },
  ) => {
    onStreamEvent = options.onEvent;
    return new Promise<void>((resolve) => {
      resolveStream = resolve;
    });
  });

  const rendered = renderChat();
  const textarea = rendered.container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Composer draft']");
  expect(textarea).not.toBeNull();
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    valueSetter?.call(textarea, "Start a controlled reply.");
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
  await clickEnabledButtonByAriaLabel(rendered.container, "Send");
  await vi.waitFor(() => expect(mockState.sendMessageStream).toHaveBeenCalledTimes(1));

  const createdDraft = mockState.setStreamDraftForChat.mock.calls
    .map((call) => call[1])
    .find((candidate): candidate is ChatStreamDraft => (
      Boolean(candidate)
      && typeof candidate === "object"
      && "streamKey" in candidate
    ));
  expect(createdDraft).toBeDefined();
  mockState.streamDrafts = { "chat-1": createdDraft! };
  mockState.sendInFlightByChatId = { "chat-1": true };
  rendered.rerender();

  return {
    ...rendered,
    createdDraft: createdDraft!,
    emitAck: async (createdAt: Date) => {
      await act(async () => {
        await onStreamEvent({
          type: "ack",
          userMessage: message({
            id: "persisted-active-user",
            body: "Start a controlled reply.",
            chatTurnId: "persisted-active-turn",
            createdAt,
            updatedAt: createdAt,
          }),
          generationId: "persisted-generation",
          attemptEpoch: 1,
          generationSeq: 0,
          bodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        });
      });
    },
    emitFinal: async () => {
      await act(async () => {
        await onStreamEvent({
          type: "final",
          messages: [message({ id: "late-final", body: "Late final body" })],
        });
      });
    },
    finishStream: async () => {
      await act(async () => {
        resolveStream();
        await Promise.resolve();
      });
    },
  };
}

async function renderPersistedSideChatPanel(conversationId: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => act(() => root.unmount());

  await act(async () => {
    root.render(
      <ThemeProvider>
        <SidePanelProvider>
          <ChatSidePanel
            selectedOrganizationId="org-1"
            target={{
              kind: "side_chat",
              sourceConversationId: "chat-1",
              sourceMessageId: "assistant-source",
              sourcePreview: "Source answer",
              conversationId,
              clientMutationId: `client-${conversationId}`,
              label: "Side Chat",
            }}
          />
        </SidePanelProvider>
      </ThemeProvider>,
    );
    await Promise.resolve();
  });

  return container;
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
  mockState.abortChatStream.mockReset();
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
  mockState.routeBase = "/messenger/chat";
  mockState.workspaceDirectories = {};
  mockState.workspaceFiles = {};
  mockState.updateWorkspaceFile.mockReset();
  mockState.updateWorkspaceFile.mockImplementation(async (
    _organizationId: string,
    filePath: string,
    data: { content: string },
  ) => {
    const current = mockState.workspaceFiles[filePath];
    if (!current) throw new Error("Workspace file not found");
    const updated = { ...current, content: data.content };
    mockState.workspaceFiles[filePath] = updated;
    return updated;
  });
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
  mockState.queueSnapshot = queueSnapshot();
  mockState.cancelQueuedMessage.mockReset();
  mockState.cancelQueuedMessage.mockResolvedValue(queuedMessage({ status: "cancelled" }));
  mockState.checkpointMessageStream.mockReset();
  mockState.checkpointMessageStream.mockResolvedValue({ advanced: true });
  mockState.createQueuedMessage.mockReset();
  mockState.createQueuedMessage.mockImplementation(async (_chatId: string, data: { payload: { body: string } }) =>
    queuedMessage({ payload: { body: data.payload.body, attachmentIds: [], projectId: null, skillRefs: [], accessMode: null, model: null, effort: null, metadata: null } })
  );
  mockState.steerQueuedMessage.mockReset();
  mockState.steerQueuedMessage.mockResolvedValue({
    result: "pending",
    disposition: "pending",
    controlActionId: "20000000-0000-4000-8000-000000000002",
    activeGenerationId: "generation-1",
    item: queuedMessage({ status: "steer_pending", deliveryIntent: "steer", deliveryDisposition: "pending" }),
    queueVersion: 1,
    transcriptEventId: null,
  });
  mockState.updateQueuedMessage.mockReset();
  mockState.updateQueuedMessage.mockImplementation(async (_chatId: string, itemId: string, data: { payload: ChatQueuedMessage["payload"] }) =>
    queuedMessage({ id: itemId, payload: data.payload })
  );
  mockState.fetchingChatDetailIds = new Set();
  mockState.failedChatDetailIds = new Set();
  mockState.pendingChatDetailIds = new Set();
  mockState.invalidateQueries.mockReset();
  mockState.markRead.mockReset();
  mockState.mutations = [];
  mockState.navigate.mockReset();
  mockState.pushToast.mockReset();
  mockState.queryKeys = [];
  mockState.getQueryData.mockReset();
  mockState.refetchChatDetail.mockReset();
  mockState.removeQueries.mockReset();
  mockState.destroySideChat.mockReset();
  mockState.destroySideChat.mockResolvedValue(undefined);
  mockState.keepSideChat.mockReset();
  mockState.sendInFlightByChatId = {};
  mockState.setChatSendInFlight.mockReset();
  mockState.createConversation.mockReset();
  mockState.createConversation.mockResolvedValue(chat({
    id: "new-chat-1",
    title: "Start atomic chat",
    preferredAgentId: "agent-1",
    lastMessageAt: null,
  }));
  mockState.draftPreflight = {
    sourceType: "agent",
    sourceLabel: "Wesley",
    runtimeAgentId: "agent-1",
    agentRuntimeType: "codex",
    model: null,
    available: true,
    error: null,
  };
  mockState.preflightDraft.mockReset();
  mockState.preflightDraft.mockResolvedValue(mockState.draftPreflight);
  mockState.sendFirstMessageStream.mockReset();
  mockState.sendMessageStream.mockReset();
  mockState.setSidebarOpen.mockReset();
  mockState.setStreamDraftForChat.mockReset();
  mockState.sidebarOpen = true;
  mockState.setQueriesData.mockReset();
  mockState.setQueryData.mockReset();
  mockState.stopMessageStream.mockReset();
  mockState.stopMessageStream.mockResolvedValue({ stopped: true, disposition: "stopping" });
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
  mockState.browserShortcutListener = null;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
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
  Object.defineProperty(window, "desktopShell", {
    configurable: true,
    value: {
      getBrowserPartition: vi.fn(async () => "persist:rudder-browser-v1-test"),
      openExternal: vi.fn(async () => undefined),
      forceOpenExternal: vi.fn(async () => undefined),
      setSidePanelCloseShortcutActive: vi.fn(async () => undefined),
      setBrowserSurfaceShortcutActive: vi.fn(async () => undefined),
      onBrowserShortcut: vi.fn((listener: (action: BrowserShortcutAction) => void) => {
        mockState.browserShortcutListener = listener;
        return () => {
          if (mockState.browserShortcutListener === listener) mockState.browserShortcutListener = null;
        };
      }),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanupFn?.();
  cleanupFn = null;
  delete (window as typeof window & { desktopShell?: unknown }).desktopShell;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Messenger sidebar controls", () => {
  it("shows an opener on the chat canvas when the Messenger sidebar is collapsed", async () => {
    mockState.sidebarOpen = false;

    const { container } = renderChat();
    const openButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open Messenger sidebar"]');

    expect(openButton).not.toBeNull();
    expect(openButton?.title).toBe("Open Messenger sidebar");
    expect(openButton?.querySelector(".lucide-panel-left")).not.toBeNull();

    await act(async () => {
      openButton?.click();
      await Promise.resolve();
    });

    expect(mockState.setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it("does not label the legacy Chat sidebar as Messenger", () => {
    mockState.routeBase = "/chat";
    mockState.sidebarOpen = false;

    const { container } = renderChat();

    expect(container.querySelector('button[aria-label="Open Messenger sidebar"]')).toBeNull();
  });
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

  it("closes any Side Panel tab from its context menu", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-side-panel-context-menu",
          role: "assistant",
          body: `Inspect [Other chat](${buildChatMentionHref("chat-2")}) before replying.`,
          replyingAgentId: "agent-1",
        }),
      ],
      "chat-2": [message({ id: "other-message-1", conversationId: "chat-2", body: "Other chat side panel content" })],
    };

    const { container } = renderChat();
    await act(async () => {
      container.querySelector<HTMLAnchorElement>('a[data-mention-kind="chat"]')?.click();
      await Promise.resolve();
    });

    const tabShell = container.querySelector<HTMLElement>("[data-side-panel-tab-key]");
    await act(async () => {
      tabShell?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 40,
        clientY: 40,
      }));
      await Promise.resolve();
    });

    const menu = document.querySelector<HTMLElement>("[data-testid='chat-side-panel-tab-context-menu']");
    expect(menu?.getAttribute("role")).toBe("menu");
    const closeItem = Array.from(menu?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])
      .find((candidate) => candidate.textContent?.trim() === "Close");
    expect(closeItem).not.toBeNull();

    await act(async () => {
      closeItem?.click();
      await Promise.resolve();
    });
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(0);
  });

  it("explains why a draft Side Chat cannot move to Messenger", async () => {
    mockState.conversations = [chat({ id: "chat-1", title: "Source chat" })];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());

    await act(async () => {
      root.render(
        <ThemeProvider>
          <SidePanelProvider>
            <ChatSidePanel
              selectedOrganizationId="org-1"
              target={{
                kind: "side_chat",
                sourceConversationId: "chat-1",
                sourceMessageId: "assistant-source",
                sourcePreview: "Source answer",
                conversationId: null,
                clientMutationId: "side-chat-draft",
                label: "Side Chat",
              }}
            />
          </SidePanelProvider>
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    const tabShell = container.querySelector<HTMLElement>("[data-side-panel-tab-key]");
    await act(async () => {
      tabShell?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 40,
        clientY: 40,
      }));
      await Promise.resolve();
    });

    const moveItem = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"))
      .find((candidate) => candidate.textContent?.trim() === "Move to Messenger");
    expect(moveItem?.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      moveItem?.focus();
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });
    expect(document.querySelector<HTMLElement>("[role='tooltip']")?.textContent).toContain(
      "Send a message first to create this Side Chat.",
    );
  });

  it("moves an active Side Chat to Messenger with the same conversation id", async () => {
    const sideChat = chat({
      id: "side-chat-1",
      title: "Side Chat",
      conversationKind: "side_chat",
      sideChatState: "active",
      sideChatExpiresAt: new Date("2099-07-20T10:00:00.000Z"),
      messengerVisible: false,
    });
    const keptSideChat = chat({
      ...sideChat,
      sideChatState: "kept",
      sideChatExpiresAt: null,
      messengerVisible: true,
    });
    mockState.conversations = [chat({ id: "chat-1", title: "Source chat" }), sideChat];
    mockState.keepSideChat.mockResolvedValue(keptSideChat);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());

    await act(async () => {
      root.render(
        <ThemeProvider>
          <SidePanelProvider>
            <ChatSidePanel
              selectedOrganizationId="org-1"
              target={{
                kind: "side_chat",
                sourceConversationId: "chat-1",
                sourceMessageId: "assistant-source",
                sourcePreview: "Source answer",
                conversationId: "side-chat-1",
                clientMutationId: "side-chat-active",
                label: "Side Chat",
              }}
            />
          </SidePanelProvider>
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    const tabShell = container.querySelector<HTMLElement>("[data-side-panel-tab-key]");
    await act(async () => {
      tabShell?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 40,
        clientY: 40,
      }));
      await Promise.resolve();
    });

    const moveItem = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"))
      .find((candidate) => candidate.textContent?.trim() === "Move to Messenger");
    expect(moveItem?.hasAttribute("aria-disabled")).toBe(false);
    expect(container.textContent).not.toContain("Keep in Messenger");

    await act(async () => {
      moveItem?.click();
      await Promise.resolve();
    });

    expect(mockState.keepSideChat).toHaveBeenCalledWith("side-chat-1");
    expect(mockState.pushToast).toHaveBeenCalledWith({
      title: "Moved to Messenger",
      body: "This is now a normal Messenger chat.",
      tone: "success",
    });
    expect(mockState.navigate).toHaveBeenCalledWith("/messenger/chat/side-chat-1");
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(0);
  });

  it("keeps the Side Chat tab open when moving to Messenger fails", async () => {
    const sideChat = chat({
      id: "side-chat-failed",
      title: "Side Chat",
      conversationKind: "side_chat",
      sideChatState: "active",
      sideChatExpiresAt: new Date("2099-07-20T10:00:00.000Z"),
      messengerVisible: false,
    });
    mockState.conversations = [chat({ id: "chat-1", title: "Source chat" }), sideChat];
    mockState.keepSideChat.mockRejectedValue(new Error("Promotion failed"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());

    await act(async () => {
      root.render(
        <ThemeProvider>
          <SidePanelProvider>
            <ChatSidePanel
              selectedOrganizationId="org-1"
              target={{
                kind: "side_chat",
                sourceConversationId: "chat-1",
                sourceMessageId: "assistant-source",
                sourcePreview: "Source answer",
                conversationId: "side-chat-failed",
                clientMutationId: "side-chat-failed",
                label: "Side Chat",
              }}
            />
          </SidePanelProvider>
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    const tabShell = container.querySelector<HTMLElement>("[data-side-panel-tab-key]");
    await act(async () => {
      tabShell?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 40,
        clientY: 40,
      }));
      await Promise.resolve();
    });
    const moveItem = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"))
      .find((candidate) => candidate.textContent?.trim() === "Move to Messenger");

    await act(async () => {
      moveItem?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(1);
    expect(mockState.navigate).not.toHaveBeenCalled();
    expect(mockState.pushToast).toHaveBeenCalledWith({
      title: "Could not move Side Chat",
      body: "Promotion failed",
      tone: "error",
    });
  });

  it("blocks every close ingress while moving a Side Chat to Messenger", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const sideChat = chat({
      id: "side-chat-moving",
      title: "Side Chat",
      conversationKind: "side_chat",
      sideChatState: "active",
      sideChatExpiresAt: new Date("2099-07-20T10:00:00.000Z"),
      messengerVisible: false,
    });
    const keptSideChat = chat({
      ...sideChat,
      sideChatState: "kept",
      sideChatExpiresAt: null,
      messengerVisible: true,
    });
    const moveRequest = deferred<ChatConversation>();
    mockState.conversations = [chat({ id: "chat-1", title: "Source chat" }), sideChat];
    mockState.keepSideChat.mockReturnValue(moveRequest.promise);
    const container = await renderPersistedSideChatPanel(sideChat.id);
    const tabShell = container.querySelector<HTMLElement>("[data-side-panel-tab-key]");

    await act(async () => {
      tabShell?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 40,
        clientY: 40,
      }));
      await Promise.resolve();
    });
    const moveItem = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"))
      .find((candidate) => candidate.textContent?.trim() === "Move to Messenger");
    await act(async () => {
      moveItem?.click();
      await Promise.resolve();
    });

    await act(async () => {
      tabShell?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 40,
        clientY: 40,
      }));
      await Promise.resolve();
    });
    const closeItem = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"))
      .find((candidate) => candidate.textContent?.trim() === "Close");
    expect(closeItem?.getAttribute("aria-disabled")).toBe("true");
    const inlineClose = container.querySelector<HTMLButtonElement>("[data-testid='chat-side-panel-tab-close']");
    expect(inlineClose?.disabled).toBe(true);

    const shortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "w",
      metaKey: true,
    });
    await act(async () => {
      closeItem?.click();
      inlineClose?.click();
      document.dispatchEvent(shortcut);
      await Promise.resolve();
    });

    expect(shortcut.defaultPrevented).toBe(true);
    expect(mockState.destroySideChat).not.toHaveBeenCalled();
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(1);

    await act(async () => {
      moveRequest.resolve(keptSideChat);
      await moveRequest.promise;
      await Promise.resolve();
    });
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(0);
    expect(mockState.navigate).toHaveBeenCalledWith("/messenger/chat/side-chat-moving");
  });

  it("blocks Move and duplicate closes while Side Chat destruction is pending", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    const sideChat = chat({
      id: "side-chat-closing",
      title: "Side Chat",
      conversationKind: "side_chat",
      sideChatState: "active",
      sideChatExpiresAt: new Date("2099-07-20T10:00:00.000Z"),
      messengerVisible: false,
    });
    const closeRequest = deferred<void>();
    mockState.conversations = [chat({ id: "chat-1", title: "Source chat" }), sideChat];
    mockState.destroySideChat.mockReturnValue(closeRequest.promise);
    const container = await renderPersistedSideChatPanel(sideChat.id);
    const inlineClose = container.querySelector<HTMLButtonElement>("[data-testid='chat-side-panel-tab-close']");

    await act(async () => {
      inlineClose?.click();
      await Promise.resolve();
    });
    expect(inlineClose?.disabled).toBe(true);

    const tabShell = container.querySelector<HTMLElement>("[data-side-panel-tab-key]");
    await act(async () => {
      tabShell?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 40,
        clientY: 40,
      }));
      await Promise.resolve();
    });
    const menuItems = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"));
    const moveItem = menuItems.find((candidate) => candidate.textContent?.trim() === "Move to Messenger");
    const closeItem = menuItems.find((candidate) => candidate.textContent?.trim() === "Close");
    expect(moveItem?.getAttribute("aria-disabled")).toBe("true");
    expect(closeItem?.getAttribute("aria-disabled")).toBe("true");

    const shortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "w",
      metaKey: true,
    });
    await act(async () => {
      moveItem?.click();
      closeItem?.click();
      document.dispatchEvent(shortcut);
      await Promise.resolve();
    });
    expect(shortcut.defaultPrevented).toBe(true);
    expect(mockState.keepSideChat).not.toHaveBeenCalled();
    expect(mockState.destroySideChat).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(1);

    await act(async () => {
      closeRequest.resolve();
      await closeRequest.promise;
      await Promise.resolve();
    });
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(0);
  });

  it("closes a stale Side Chat tab when the conversation is already gone", async () => {
    const sideChat = chat({
      id: "side-chat-gone",
      conversationKind: "side_chat",
      sideChatState: "active",
      sideChatExpiresAt: new Date("2099-07-20T10:00:00.000Z"),
      messengerVisible: false,
    });
    mockState.conversations = [chat({ id: "chat-1", title: "Source chat" }), sideChat];
    mockState.destroySideChat.mockRejectedValue(new ApiError("Side Chat not found", 404, {}));
    const container = await renderPersistedSideChatPanel(sideChat.id);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='chat-side-panel-tab-close']")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(0);
    expect(mockState.removeQueries).toHaveBeenCalledTimes(2);
    expect(mockState.pushToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("reconciles a kept Side Chat after a lost Move response without deleting it", async () => {
    const sideChat = chat({
      id: "side-chat-kept-remotely",
      conversationKind: "side_chat",
      sideChatState: "kept",
      sideChatExpiresAt: null,
      messengerVisible: true,
    });
    mockState.conversations = [chat({ id: "chat-1", title: "Source chat" }), sideChat];
    mockState.destroySideChat.mockRejectedValue(new ApiError("Side Chat is already kept", 409, {}));
    const container = await renderPersistedSideChatPanel(sideChat.id);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='chat-side-panel-tab-close']")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(0);
    expect(mockState.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["messenger", "org-1"] });
    expect(mockState.removeQueries).not.toHaveBeenCalled();
    expect(mockState.pushToast).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "error" }));
  });

  it("retries Side Chat destruction after a transient close failure", async () => {
    const sideChat = chat({
      id: "side-chat-close-retry",
      conversationKind: "side_chat",
      sideChatState: "active",
      sideChatExpiresAt: new Date("2099-07-20T10:00:00.000Z"),
      messengerVisible: false,
    });
    mockState.conversations = [chat({ id: "chat-1", title: "Source chat" }), sideChat];
    mockState.destroySideChat
      .mockRejectedValueOnce(new ApiError("Service unavailable", 503, {}))
      .mockResolvedValueOnce(undefined);
    const container = await renderPersistedSideChatPanel(sideChat.id);

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='chat-side-panel-tab-close']")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(1);
    expect(mockState.pushToast).toHaveBeenCalledWith({
      title: "Could not close Side Chat",
      body: "Service unavailable",
      tone: "error",
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='chat-side-panel-tab-close']")?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockState.destroySideChat).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(0);
  });

  it("explains why an expired Side Chat cannot move to Messenger", async () => {
    const sideChat = chat({
      id: "side-chat-expired",
      title: "Side Chat",
      conversationKind: "side_chat",
      sideChatState: "active",
      sideChatExpiresAt: new Date("2020-07-20T10:00:00.000Z"),
      messengerVisible: false,
    });
    mockState.conversations = [chat({ id: "chat-1", title: "Source chat" }), sideChat];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());

    await act(async () => {
      root.render(
        <ThemeProvider>
          <SidePanelProvider>
            <ChatSidePanel
              selectedOrganizationId="org-1"
              target={{
                kind: "side_chat",
                sourceConversationId: "chat-1",
                sourceMessageId: "assistant-source",
                sourcePreview: "Source answer",
                conversationId: "side-chat-expired",
                clientMutationId: "side-chat-expired",
                label: "Side Chat",
              }}
            />
          </SidePanelProvider>
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    const tabShell = container.querySelector<HTMLElement>("[data-side-panel-tab-key]");
    await act(async () => {
      tabShell?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 40,
        clientY: 40,
      }));
      await Promise.resolve();
    });
    const moveItem = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"))
      .find((candidate) => candidate.textContent?.trim() === "Move to Messenger");
    expect(moveItem?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      moveItem?.focus();
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });
    expect(document.querySelector<HTMLElement>("[role='tooltip']")?.textContent).toContain(
      "This Side Chat can no longer be moved. Close it instead.",
    );
  });

  it("keeps Move to Messenger disabled while a cached Side Chat status refreshes", async () => {
    const cachedSideChat = chat({
      id: "side-chat-loading",
      title: "Side Chat",
      conversationKind: "side_chat",
      sideChatState: "active",
      sideChatExpiresAt: new Date("2099-07-20T10:00:00.000Z"),
      messengerVisible: false,
    });
    mockState.conversations = [chat({ id: "chat-1", title: "Source chat" }), cachedSideChat];
    mockState.fetchingChatDetailIds.add("side-chat-loading");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());

    await act(async () => {
      root.render(
        <ThemeProvider>
          <SidePanelProvider>
            <ChatSidePanel
              selectedOrganizationId="org-1"
              target={{
                kind: "side_chat",
                sourceConversationId: "chat-1",
                sourceMessageId: "assistant-source",
                sourcePreview: "Source answer",
                conversationId: "side-chat-loading",
                clientMutationId: "side-chat-loading",
                label: "Side Chat",
              }}
            />
          </SidePanelProvider>
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    const tabShell = container.querySelector<HTMLElement>("[data-side-panel-tab-key]");
    await act(async () => {
      tabShell?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 40,
        clientY: 40,
      }));
      await Promise.resolve();
    });
    const moveItem = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"))
      .find((candidate) => candidate.textContent?.trim() === "Move to Messenger");
    expect(moveItem?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      moveItem?.focus();
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });
    expect(document.querySelector<HTMLElement>("[role='tooltip']")?.textContent).toContain(
      "Checking whether this Side Chat can be moved…",
    );
  });

  it("does not enable Move to Messenger from stale cache when lifecycle refresh fails", async () => {
    const cachedSideChat = chat({
      id: "side-chat-status-error",
      title: "Side Chat",
      conversationKind: "side_chat",
      sideChatState: "active",
      sideChatExpiresAt: new Date("2099-07-20T10:00:00.000Z"),
      messengerVisible: false,
    });
    mockState.conversations = [chat({ id: "chat-1", title: "Source chat" }), cachedSideChat];
    mockState.failedChatDetailIds.add("side-chat-status-error");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());

    await act(async () => {
      root.render(
        <ThemeProvider>
          <SidePanelProvider>
            <ChatSidePanel
              selectedOrganizationId="org-1"
              target={{
                kind: "side_chat",
                sourceConversationId: "chat-1",
                sourceMessageId: "assistant-source",
                sourcePreview: "Source answer",
                conversationId: "side-chat-status-error",
                clientMutationId: "side-chat-status-error",
                label: "Side Chat",
              }}
            />
          </SidePanelProvider>
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    const tabShell = container.querySelector<HTMLElement>("[data-side-panel-tab-key]");
    await act(async () => {
      tabShell?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 40,
        clientY: 40,
      }));
      await Promise.resolve();
    });
    const moveItem = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']"))
      .find((candidate) => candidate.textContent?.trim() === "Move to Messenger");
    expect(moveItem?.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      moveItem?.focus();
      await new Promise((resolve) => window.setTimeout(resolve, 350));
    });
    expect(document.querySelector<HTMLElement>("[role='tooltip']")?.textContent).toContain(
      "This Side Chat can no longer be moved. Close it instead.",
    );
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
    expect(sidePanel?.querySelector("[data-testid='automation-detail-shell']")).not.toBeNull();
    expect(sidePanel?.textContent).toContain("Daily report");
    expect(sidePanel?.textContent).toContain("Active");
    expect(sidePanel?.textContent).toContain("Next run");
    expect(sidePanel?.textContent).toContain("Details");
    expect(sidePanel?.textContent).toContain("Frequency");
    expect(sidePanel?.textContent).toContain("Previous runs");
    expect(sidePanel?.querySelector("button[aria-label='Automation actions']")).not.toBeNull();
    expect(sidePanel?.querySelector("button[aria-label='Pause automation']")).not.toBeNull();
    expect(mockState.navigate).not.toHaveBeenCalledWith("/automations/automation-1");
    expect(sidePanel?.querySelector<HTMLAnchorElement>('a[href="/automations/automation-1"]')).toBeNull();
  }, 15_000);

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

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const automationReference = container.querySelector<HTMLAnchorElement>('a[data-mention-kind="automation"]');
    await act(async () => {
      automationReference?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const pauseButton = container.querySelector<HTMLButtonElement>("button[aria-label='Pause automation']");
    expect(pauseButton).not.toBeNull();

    await act(async () => {
      pauseButton?.click();
      await Promise.resolve();
    });
    expect(mockState.mutations).toContainEqual("paused");
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
    expect(sidePanel?.querySelector("[data-testid='automation-detail-shell']")).not.toBeNull();
    expect(sidePanel?.textContent).toContain("Daily report");
    expect(sidePanel?.textContent).toContain("Details");
    expect(sidePanel?.textContent).toContain("Frequency");
    expect(sidePanel?.textContent).toContain("No activity yet.");
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

    await act(async () => {
      tabs[0]?.parentElement?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 40,
        clientY: 40,
      }));
      await Promise.resolve();
    });
    tabs = Array.from(container.querySelectorAll<HTMLElement>("[data-testid='chat-side-panel-tab']"));
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("false");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("[data-testid='chat-side-panel-tab-context-menu']")).not.toBeNull();
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Third chat side panel content");
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
      await Promise.resolve();
    });

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

  it("closes the active Side Panel chat tab with Command+W", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    mockState.conversations = [
      chat({ id: "chat-1", title: "Current chat" }),
      chat({ id: "chat-2", title: "Other chat", lastMessageAt: new Date("2026-05-12T09:10:00.000Z") }),
      chat({ id: "chat-3", title: "Third chat", lastMessageAt: new Date("2026-05-12T09:11:00.000Z") }),
    ];
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "assistant-side-panel-shortcut",
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
    await act(async () => {
      chatReferences[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });
    const currentChatReferences = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[data-mention-kind="chat"]'));
    await act(async () => {
      currentChatReferences[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(2);
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Third chat side panel content");

    const shortcut = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "w", metaKey: true });
    await act(async () => {
      document.dispatchEvent(shortcut);
      await Promise.resolve();
    });

    const tabs = Array.from(container.querySelectorAll<HTMLElement>("[data-testid='chat-side-panel-tab']"));
    expect(shortcut.defaultPrevented).toBe(true);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.textContent).toContain("Other chat");
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Other chat side panel content");
  });

  it("opens the Library browser from the Side Panel picker with a file-count summary and file drill-in", async () => {
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

    const chatSidePanelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open Side Panel"]');
    expect(chatSidePanelButton).not.toBeNull();
    await act(async () => {
      chatSidePanelButton?.click();
      await Promise.resolve();
    });

    let sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    const openLibraryOption = Array.from(sidePanel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Library"),
    );
    expect(openLibraryOption).not.toBeUndefined();

    await act(async () => {
      openLibraryOption?.click();
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
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
    const fileView = sidePanel?.querySelector("[data-testid='chat-side-panel-library-file-view']");
    const fileToolbar = sidePanel?.querySelector("[data-testid='chat-side-panel-library-file-toolbar']");
    const markdownEditor = sidePanel?.querySelector("[data-testid='chat-side-panel-library-markdown-editor']");
    const markdownInput = markdownEditor?.querySelector<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']");
    expect(markdownInput?.value).toBe("# Side Panel notes\n\n- Keep markdown rendered");
    expect(markdownEditor?.querySelector("[data-testid='chat-side-panel-library-history-controls']")).not.toBeNull();
    expect(Array.from(fileView?.querySelectorAll("button") ?? []).map((button) => button.textContent)).not.toContain("Preview");
    expect(Array.from(fileView?.querySelectorAll("button") ?? []).map((button) => button.textContent)).not.toContain("Edit");
    expect(fileToolbar?.textContent).toContain("notes.md");
    expect(fileView?.textContent).not.toContain("text/markdown");
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(2);
  });

  it("closes the active Library preview tab with Command+W", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    mockState.workspaceDirectories = {
      "": {
        directoryPath: "",
        entries: [{ name: "notes.md", path: "notes.md", isDirectory: false }],
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
      "chat-1": [message({ id: "library-shortcut-message", body: "Open the library browser." })],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const chatSidePanelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open Side Panel"]');
    await act(async () => {
      chatSidePanelButton?.click();
      await Promise.resolve();
    });

    let sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    const openLibraryOption = Array.from(sidePanel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("Library"),
    );
    await act(async () => {
      openLibraryOption?.click();
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    const notesButton = Array.from(sidePanel!.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes("notes.md"),
    );
    await act(async () => {
      notesButton?.click();
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.querySelector("[data-testid='chat-side-panel-library-markdown-editor']")).not.toBeNull();
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(2);

    const shortcut = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "w", metaKey: true });
    await act(async () => {
      document.dispatchEvent(shortcut);
      await Promise.resolve();
    });

    const tabs = Array.from(container.querySelectorAll<HTMLElement>("[data-testid='chat-side-panel-tab']"));
    expect(shortcut.defaultPrevented).toBe(true);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.textContent).toContain("Library");
    expect(container.querySelector("[data-testid='chat-side-panel']")?.textContent).toContain("Library root");
    expect(container.querySelector("[data-testid='chat-side-panel-library-markdown-editor']")).toBeNull();
  });

  it("renders a stable Library entry target as an inline Markdown editor", async () => {
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
    cleanupFn = () => act(() => root.unmount());

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
    const fileView = sidePanel?.querySelector("[data-testid='chat-side-panel-library-file-view']");
    const fileToolbar = sidePanel?.querySelector("[data-testid='chat-side-panel-library-file-toolbar']");
    expect(sidePanel).not.toBeNull();
    expect(fileToolbar?.querySelector("nav")?.getAttribute("tabindex")).toBe("0");
    expect(fileView?.textContent).not.toContain("reports/activity.md");
    expect(fileView?.textContent).not.toContain("text/markdown");
    expect(sidePanel?.querySelector<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']")?.value).toBe(
      "# Activity report\n\nStable Library entry links should render inline.",
    );
    expect(sidePanel?.textContent).not.toContain("Open this target in the full page for details.");
  });

  it("edits Markdown directly with undo, redo, autosave retry, and preserved frontmatter", async () => {
    vi.useFakeTimers();
    mockState.workspaceFiles = {
      "reports/editable.md": {
        filePath: "reports/editable.md",
        content: "---\ntitle: Editable report\n---\n# Original heading\n\nOriginal body.",
        contentType: "text/markdown",
        previewKind: "text",
        contentPath: null,
        truncated: false,
      },
    };
    mockState.updateWorkspaceFile.mockRejectedValueOnce(new Error("Temporary save failure"));

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());

    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <SidePanelProvider>
              <ChatSidePanel
                selectedOrganizationId="org-1"
                target={{ kind: "library_file", filePath: "reports/editable.md", label: "editable.md" }}
              />
            </SidePanelProvider>
          </ThemeProvider>,
        );
        await Promise.resolve();
      });

      const editor = container.querySelector<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']");
      const undoButton = container.querySelector<HTMLButtonElement>('button[aria-label="Undo Markdown edit"]');
      const redoButton = container.querySelector<HTMLButtonElement>('button[aria-label="Redo Markdown edit"]');
      expect(editor?.value).toBe("# Original heading\n\nOriginal body.");
      expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Frontmatter"]')?.value).toBe(
        "---\ntitle: Editable report\n---",
      );
      expect(undoButton?.disabled).toBe(true);

      await act(async () => {
        if (editor) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
            editor,
            "# Revised heading\n\nRevised body.",
          );
          editor.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await Promise.resolve();
      });
      expect(undoButton?.disabled).toBe(false);

      await act(async () => {
        undoButton?.click();
        await Promise.resolve();
      });
      expect(editor?.value).toBe("# Original heading\n\nOriginal body.");
      expect(redoButton?.disabled).toBe(false);

      await act(async () => {
        redoButton?.click();
        await Promise.resolve();
      });
      expect(editor?.value).toBe("# Revised heading\n\nRevised body.");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(container.textContent).toContain("Save failed");
      expect(mockState.updateWorkspaceFile).toHaveBeenCalledTimes(1);

      await act(async () => {
        Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
          .find((button) => button.textContent === "Retry")
          ?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockState.updateWorkspaceFile).toHaveBeenCalledTimes(2);
      expect(mockState.updateWorkspaceFile).toHaveBeenLastCalledWith(
        "org-1",
        "reports/editable.md",
        {
          content: "---\ntitle: Editable report\n---\n# Revised heading\n\nRevised body.",
          expectedContent: "---\ntitle: Editable report\n---\n# Original heading\n\nOriginal body.",
        },
      );
      expect(container.textContent).toContain("Saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a truncated Side Panel Markdown file read-only", async () => {
    mockState.workspaceFiles = {
      "reports/truncated.md": {
        filePath: "reports/truncated.md",
        content: "# Partial preview\n",
        contentType: "text/markdown",
        previewKind: "text",
        contentPath: null,
        message: "Preview truncated to the first 200 KB.",
        truncated: true,
      },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());

    await act(async () => {
      root.render(
        <ThemeProvider>
          <SidePanelProvider>
            <ChatSidePanel
              selectedOrganizationId="org-1"
              target={{ kind: "library_file", filePath: "reports/truncated.md", label: "truncated.md" }}
            />
          </SidePanelProvider>
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector("[data-testid='chat-side-panel-library-markdown-editor']")).toBeNull();
    expect(container.querySelector("[data-testid='chat-side-panel-library-markdown-preview']")).not.toBeNull();
    expect(container.querySelector("[data-testid='chat-side-panel-library-readonly-notice']")?.textContent).toBe(
      "Preview truncated to the first 200 KB.",
    );
    expect(mockState.updateWorkspaceFile).not.toHaveBeenCalled();
  });

  it("saves the latest Markdown state after reverting while an older save is in flight", async () => {
    vi.useFakeTimers();
    mockState.workspaceFiles = {
      "notes/in-flight.md": {
        filePath: "notes/in-flight.md",
        content: "# Server copy\n",
        contentType: "text/markdown",
        previewKind: "text",
        contentPath: null,
        truncated: false,
      },
    };
    let resolveFirstSave: (() => void) | null = null;
    mockState.updateWorkspaceFile.mockImplementationOnce((
      _organizationId: string,
      filePath: string,
      data: { content: string },
    ) => new Promise((resolve) => {
      resolveFirstSave = () => {
        const updated = { ...mockState.workspaceFiles[filePath], content: data.content };
        mockState.workspaceFiles[filePath] = updated;
        resolve(updated);
      };
    }));

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());

    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <SidePanelProvider>
              <ChatSidePanel
                selectedOrganizationId="org-1"
                target={{ kind: "library_file", filePath: "notes/in-flight.md", label: "in-flight.md" }}
              />
            </SidePanelProvider>
          </ThemeProvider>,
        );
        await Promise.resolve();
      });

      const editor = container.querySelector<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']");
      const changeEditor = (value: string) => {
        if (!editor) return;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(editor, value);
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      };

      await act(async () => {
        changeEditor("# In-flight revision\n");
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(mockState.updateWorkspaceFile).toHaveBeenCalledTimes(1);

      await act(async () => {
        changeEditor("# Server copy\n");
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Saving");

      await act(async () => {
        resolveFirstSave?.();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockState.updateWorkspaceFile).toHaveBeenCalledTimes(2);
      expect(mockState.updateWorkspaceFile).toHaveBeenLastCalledWith(
        "org-1",
        "notes/in-flight.md",
        { content: "# Server copy\n", expectedContent: "# In-flight revision\n" },
      );
      expect(mockState.workspaceFiles["notes/in-flight.md"]?.content).toBe("# Server copy\n");
      expect(container.textContent).toContain("Saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores an unsaved Side Panel Markdown draft after the editor remounts", async () => {
    vi.useFakeTimers();
    mockState.workspaceFiles = {
      "notes/recovery.md": {
        filePath: "notes/recovery.md",
        content: "# Server copy\n",
        contentType: "text/markdown",
        previewKind: "text",
        contentPath: null,
        truncated: false,
      },
    };

    const firstContainer = document.createElement("div");
    document.body.appendChild(firstContainer);
    const firstRoot = createRoot(firstContainer);

    try {
      await act(async () => {
        firstRoot.render(
          <ThemeProvider>
            <SidePanelProvider>
              <ChatSidePanel
                selectedOrganizationId="org-1"
                target={{ kind: "library_file", filePath: "notes/recovery.md", label: "recovery.md" }}
              />
            </SidePanelProvider>
          </ThemeProvider>,
        );
        await Promise.resolve();
      });
      const firstEditor = firstContainer.querySelector<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']");
      await act(async () => {
        if (firstEditor) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
            firstEditor,
            "# Recovered draft\n\nNot saved yet.",
          );
          firstEditor.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await Promise.resolve();
      });
      await act(async () => firstRoot.unmount());
      expect(mockState.updateWorkspaceFile).not.toHaveBeenCalled();

      const secondContainer = document.createElement("div");
      document.body.appendChild(secondContainer);
      const secondRoot = createRoot(secondContainer);
      cleanupFn = () => act(() => secondRoot.unmount());
      await act(async () => {
        secondRoot.render(
          <ThemeProvider>
            <SidePanelProvider>
              <ChatSidePanel
                selectedOrganizationId="org-1"
                target={{ kind: "library_file", filePath: "notes/recovery.md", label: "recovery.md" }}
              />
            </SidePanelProvider>
          </ThemeProvider>,
        );
        await Promise.resolve();
      });
      expect(secondContainer.querySelector<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']")?.value).toBe(
        "# Recovered draft\n\nNot saved yet.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an unsaved Side Panel Markdown draft when the server base changed", async () => {
    vi.useFakeTimers();
    mockState.workspaceFiles = {
      "notes/stale-recovery.md": {
        filePath: "notes/stale-recovery.md",
        content: "# Original server copy\n",
        contentType: "text/markdown",
        previewKind: "text",
        contentPath: null,
        truncated: false,
      },
    };

    const firstContainer = document.createElement("div");
    document.body.appendChild(firstContainer);
    const firstRoot = createRoot(firstContainer);

    try {
      await act(async () => {
        firstRoot.render(
          <ThemeProvider>
            <SidePanelProvider>
              <ChatSidePanel
                selectedOrganizationId="org-1"
                target={{ kind: "library_file", filePath: "notes/stale-recovery.md", label: "stale-recovery.md" }}
              />
            </SidePanelProvider>
          </ThemeProvider>,
        );
        await Promise.resolve();
      });
      const firstEditor = firstContainer.querySelector<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']");
      await act(async () => {
        if (firstEditor) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
            firstEditor,
            "# Unsaved stale draft\n",
          );
          firstEditor.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await Promise.resolve();
      });
      await act(async () => firstRoot.unmount());

      mockState.workspaceFiles["notes/stale-recovery.md"] = {
        ...mockState.workspaceFiles["notes/stale-recovery.md"],
        content: "# New server copy\n",
      };

      const secondContainer = document.createElement("div");
      document.body.appendChild(secondContainer);
      const secondRoot = createRoot(secondContainer);
      cleanupFn = () => act(() => secondRoot.unmount());
      await act(async () => {
        secondRoot.render(
          <ThemeProvider>
            <SidePanelProvider>
              <ChatSidePanel
                selectedOrganizationId="org-1"
                target={{ kind: "library_file", filePath: "notes/stale-recovery.md", label: "stale-recovery.md" }}
              />
            </SidePanelProvider>
          </ThemeProvider>,
        );
        await Promise.resolve();
      });

      expect(secondContainer.querySelector<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']")?.value).toBe(
        "# Unsaved stale draft\n",
      );
      expect(secondContainer.textContent).toContain("Conflict");
      expect(sessionStorageState).not.toEqual({});
      expect(mockState.updateWorkspaceFile).not.toHaveBeenCalled();

      await act(async () => {
        Array.from(secondContainer.querySelectorAll("button"))
          .find((button) => button.textContent === "Use latest")
          ?.click();
        await Promise.resolve();
      });
      expect(secondContainer.querySelector<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']")?.value).toBe(
        "# New server copy\n",
      );
      expect(sessionStorageState).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a failed save response as saved when verification finds the draft on disk", async () => {
    vi.useFakeTimers();
    mockState.workspaceFiles = {
      "notes/ambiguous-save.md": {
        filePath: "notes/ambiguous-save.md",
        content: "# Original copy\n",
        contentType: "text/markdown",
        previewKind: "text",
        contentPath: null,
        truncated: false,
      },
    };
    mockState.updateWorkspaceFile.mockImplementationOnce(async (
      _organizationId: string,
      filePath: string,
      data: { content: string },
    ) => {
      mockState.workspaceFiles[filePath] = {
        ...mockState.workspaceFiles[filePath]!,
        content: data.content,
      };
      throw new Error("Activity log unavailable after write");
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());

    try {
      await act(async () => {
        root.render(
          <ThemeProvider>
            <SidePanelProvider>
              <ChatSidePanel
                selectedOrganizationId="org-1"
                target={{ kind: "library_file", filePath: "notes/ambiguous-save.md", label: "ambiguous-save.md" }}
              />
            </SidePanelProvider>
          </ThemeProvider>,
        );
        await Promise.resolve();
      });
      const editor = container.querySelector<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']");
      await act(async () => {
        if (editor) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
            editor,
            "# Persisted despite response failure\n",
          );
          editor.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await vi.advanceTimersByTimeAsync(700);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toContain("Saved");
      expect(container.textContent).not.toContain("Conflict");
      expect(mockState.updateWorkspaceFile).toHaveBeenCalledTimes(1);
      expect(sessionStorageState).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes Keep mine after an older save request rejects", async () => {
    vi.useFakeTimers();
    const filePath = "notes/keep-mine-race.md";
    mockState.workspaceFiles = {
      [filePath]: {
        filePath,
        content: "# Original copy\n",
        contentType: "text/markdown",
        previewKind: "text",
        contentPath: null,
        truncated: false,
      },
    };
    let rejectFirstSave: ((reason?: unknown) => void) | null = null;
    mockState.updateWorkspaceFile.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectFirstSave = reject;
    }));

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());
    const renderPanel = () => (
      <ThemeProvider>
        <SidePanelProvider>
          <ChatSidePanel
            selectedOrganizationId="org-1"
            target={{ kind: "library_file", filePath, label: "keep-mine-race.md" }}
          />
        </SidePanelProvider>
      </ThemeProvider>
    );

    try {
      await act(async () => {
        root.render(renderPanel());
        await Promise.resolve();
      });
      const editor = container.querySelector<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']");
      await act(async () => {
        if (editor) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(editor, "# My draft\n");
          editor.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(mockState.updateWorkspaceFile).toHaveBeenCalledTimes(1);

      mockState.workspaceFiles[filePath] = { ...mockState.workspaceFiles[filePath]!, content: "# Agent copy\n" };
      await act(async () => {
        root.render(renderPanel());
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Conflict");

      await act(async () => {
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === "Keep mine")
          ?.click();
        rejectFirstSave?.(new Error("Stale save rejected"));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockState.updateWorkspaceFile).toHaveBeenCalledTimes(2);
      expect(mockState.workspaceFiles[filePath]?.content).toBe("# My draft\n");
      expect(container.textContent).toContain("Saved");
      expect(container.textContent).not.toContain("Save failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Use latest resolved after an older save request rejects", async () => {
    vi.useFakeTimers();
    const filePath = "notes/use-latest-race.md";
    mockState.workspaceFiles = {
      [filePath]: {
        filePath,
        content: "# Original copy\n",
        contentType: "text/markdown",
        previewKind: "text",
        contentPath: null,
        truncated: false,
      },
    };
    let rejectFirstSave: ((reason?: unknown) => void) | null = null;
    mockState.updateWorkspaceFile.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectFirstSave = reject;
    }));

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());
    const renderPanel = () => (
      <ThemeProvider>
        <SidePanelProvider>
          <ChatSidePanel
            selectedOrganizationId="org-1"
            target={{ kind: "library_file", filePath, label: "use-latest-race.md" }}
          />
        </SidePanelProvider>
      </ThemeProvider>
    );

    try {
      await act(async () => {
        root.render(renderPanel());
        await Promise.resolve();
      });
      const editor = container.querySelector<HTMLTextAreaElement>("[data-testid='mock-markdown-editor']");
      await act(async () => {
        if (editor) {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(editor, "# My draft\n");
          editor.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(mockState.updateWorkspaceFile).toHaveBeenCalledTimes(1);

      mockState.workspaceFiles[filePath] = { ...mockState.workspaceFiles[filePath]!, content: "# Agent copy\n" };
      await act(async () => {
        root.render(renderPanel());
        await Promise.resolve();
      });
      expect(container.textContent).toContain("Conflict");

      await act(async () => {
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === "Use latest")
          ?.click();
        rejectFirstSave?.(new Error("Stale save rejected"));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockState.updateWorkspaceFile).toHaveBeenCalledTimes(1);
      expect(editor?.value).toBe("# Agent copy\n");
      expect(container.textContent).toContain("Saved");
      expect(container.textContent).not.toContain("Save failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a Library PDF inline in the Side Panel", async () => {
    mockState.workspaceFiles = {
      "reports/quarterly/report.pdf": {
        filePath: "reports/quarterly/report.pdf",
        content: null,
        contentType: "application/pdf",
        previewKind: "pdf",
        contentPath: "/api/orgs/org-1/workspace/file/content?path=reports%2Fquarterly%2Freport.pdf",
        truncated: false,
      },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());

    await act(async () => {
      root.render(
        <ThemeProvider>
          <SidePanelProvider>
            <ChatSidePanel
              selectedOrganizationId="org-1"
              target={{
                kind: "library_file",
                filePath: "reports/quarterly/report.pdf",
                label: "report.pdf",
              }}
            />
          </SidePanelProvider>
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    const preview = container.querySelector<HTMLCanvasElement>("[data-testid='chat-side-panel-library-pdf-preview']");
    expect(preview).not.toBeNull();
    expect(preview?.getAttribute("data-pdf-src")).toBe(
      "/api/orgs/org-1/workspace/file/content?path=reports%2Fquarterly%2Freport.pdf",
    );
    expect(preview?.getAttribute("aria-label")).toBe("reports/quarterly/report.pdf");
    expect(container.textContent).not.toContain("No inline preview is available for this file.");
  });

  it.each([false, true])("offers Desktop app launch targets from the HTML toolbar when expanded is %s", async (expanded) => {
    const openWorkspaceFileLocation = vi.fn(async () => {});
    const openWorkspaceFileInIde = vi.fn(async () => {});
    Object.defineProperty(window, "desktopShell", {
      configurable: true,
      value: {
        listWorkspaceLaunchTargets: vi.fn(async () => [
          { id: "cursor", label: "Cursor", kind: "ide" },
          { id: "vscode", label: "VS Code", kind: "ide" },
          { id: "terminal", label: "Terminal", kind: "terminal" },
          { id: "finder", label: "Finder", kind: "folder" },
        ]),
        openWorkspaceFileInIde,
        openWorkspaceFileLocation,
      },
    });
    mockState.workspaceFiles = {
      "reports/activity.html": {
        rootPath: "/Users/tester/Documents/Rudder/rudder",
        filePath: "reports/activity.html",
        content: "<!doctype html><html><body><h1>Activity report</h1></body></html>",
        contentType: "text/html",
        previewKind: "text",
        contentPath: null,
        truncated: false,
      },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());

    await act(async () => {
      root.render(
        <ThemeProvider>
          <SidePanelProvider>
            <ChatSidePanel
              expanded={expanded}
              selectedOrganizationId="org-1"
              target={{ kind: "library_file", filePath: "reports/activity.html", label: "activity.html" }}
            />
          </SidePanelProvider>
        </ThemeProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Open file options"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("Open");
    const toolbar = container.querySelector<HTMLElement>("[data-testid='chat-side-panel-library-file-toolbar']");
    expect(toolbar?.querySelector("nav[aria-label='Library file path']")?.textContent).toBe("reportsactivity.html");
    expect(container.querySelector("[data-testid='chat-side-panel-library-html-preview-toolbar']")?.contains(trigger))
      .toBe(true);
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const menuItems = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(menuItems.map((item) => item.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining("Open in Library"),
      expect.stringContaining("Default app"),
      expect.stringContaining("Cursor"),
      expect.stringContaining("VS Code"),
      expect.stringContaining("Terminal"),
      expect.stringContaining("Finder"),
    ]));
    const cursorItem = menuItems.find((item) => item.textContent?.includes("Cursor"));
    expect(cursorItem?.querySelector("img")?.getAttribute("src")).toBe("/brands/cursor-app-icon.svg");

    const terminalItem = menuItems.find((item) => item.textContent?.includes("Terminal"));
    await act(async () => {
      terminalItem?.click();
      await Promise.resolve();
    });
    expect(openWorkspaceFileLocation).toHaveBeenCalledWith(
      "/Users/tester/Documents/Rudder/rudder",
      "reports/activity.html",
      "terminal",
    );
  }, 15_000);

  it("keeps Open in Library available outside Desktop while hiding app launch targets", async () => {
    mockState.workspaceFiles = {
      "reports/activity.md": {
        rootPath: "/Users/tester/Documents/Rudder/rudder",
        filePath: "reports/activity.md",
        content: "# Activity report\n",
        contentType: "text/markdown",
        previewKind: "text",
        contentPath: null,
        truncated: false,
      },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => act(() => root.unmount());
    await act(async () => {
      root.render(
        <ThemeProvider>
          <SidePanelProvider>
            <ChatSidePanel
              selectedOrganizationId="org-1"
              target={{ kind: "library_file", filePath: "reports/activity.md", label: "activity.md" }}
            />
          </SidePanelProvider>
        </ThemeProvider>,
      );
      await Promise.resolve();
    });

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Open file options"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });

    const menuItems = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(menuItems.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Open in Library"),
    ]);
    expect(menuItems.some((item) => item.textContent?.includes("Default app"))).toBe(false);

    await act(async () => {
      menuItems[0]?.click();
      await Promise.resolve();
    });
    expect(mockState.navigate).toHaveBeenCalledWith("/rudder/library?path=reports%2Factivity.md");
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
    expect(sidePanel?.className).toContain("h-full");
    expect(sidePanel?.className).toContain("w-full");
    expect(sidePanel?.className).not.toContain("motion-chat-side-panel");
    expect(container.querySelector('[data-testid="chat-side-panel-trigger"]')).toBeNull();
    const collapseButton = sidePanel?.querySelector('[data-testid="chat-side-panel-collapse"]');
    expect(collapseButton).not.toBeNull();
    expect(collapseButton?.querySelector(".lucide-panel-right")).not.toBeNull();
    expect(sidePanel?.querySelector('[data-testid="chat-side-panel-expand-toggle"]')).not.toBeNull();

    const urlInput = sidePanel!.querySelector<HTMLInputElement>('input[aria-label="Browser URL"]');
    expect(urlInput).not.toBeNull();
    await act(async () => {
      urlInput!.value = "localhost:4173/browser-fixture";
      urlInput!.dispatchEvent(new Event("input", { bubbles: true }));
      urlInput!.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.querySelector("[data-testid='chat-side-panel-browser-start']")).toBeNull();
    const webview = sidePanel?.querySelector<HTMLElement>("[data-testid='chat-side-panel-browser-webview']");
    expect(webview).not.toBeNull();
    expect(webview?.getAttribute("src")).toBe("http://localhost:4173/browser-fixture");
    expect(webview?.getAttribute("allowpopups")).toBe("true");
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
    const readyCanGoBack = vi.fn(() => true);
    const readyCanGoForward = vi.fn(() => false);
    Object.assign(webview!, {
      canGoBack: readyCanGoBack,
      canGoForward: readyCanGoForward,
      getURL: readyUrl,
    });

    await act(async () => {
      webview!.dispatchEvent(new Event("dom-ready"));
      webview!.dispatchEvent(new Event("did-stop-loading"));
      await Promise.resolve();
    });

    expect(readyUrl).toHaveBeenCalled();
    expect(sidePanel?.querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.disabled).toBe(false);

    const titleEvent = Object.assign(new Event("page-title-updated"), { title: "Search results" });
    await act(async () => {
      webview!.dispatchEvent(titleEvent);
      await Promise.resolve();
    });

    expect(sidePanel?.querySelector<HTMLButtonElement>('button[aria-label="Back"]')?.disabled).toBe(false);
    expect(container.querySelector("[data-testid='chat-side-panel-tab']")?.textContent).toContain("Search results");
    expect(container.querySelector("[data-testid='chat-side-panel-browser-webview']")).toBe(webview);

    const inPageNavigation = Object.assign(new Event("did-navigate-in-page"), {
      url: "https://example.org/redirected",
    });
    await act(async () => {
      webview!.dispatchEvent(inPageNavigation);
      await Promise.resolve();
    });

    expect(webview?.getAttribute("src")).toBe("https://www.google.com/search?q=google");
    expect(sidePanel?.querySelector<HTMLInputElement>('input[aria-label="Browser URL"]')?.value).toBe(
      "https://example.org/redirected",
    );
    expect(container.querySelector("[data-testid='chat-side-panel-tab']")?.textContent).toContain("example.org");
    expect(container.querySelector("[data-testid='chat-side-panel-browser-webview']")).toBe(webview);
    expect(container.querySelector("[data-testid='chat-side-panel-browser-view']")).not.toBeNull();
  });

  it("renders a full Browser connection error state and reloads the current webview", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "browser-error-message", body: "Open the browser panel." })],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const sidePanelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open Side Panel"]');
    await act(async () => {
      sidePanelButton?.click();
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
    await act(async () => {
      urlInput!.value = "127.0.0.1:3201";
      urlInput!.dispatchEvent(new Event("input", { bubbles: true }));
      urlInput!.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    const webview = container.querySelector<HTMLElement & {
      canGoBack?: () => boolean;
      canGoForward?: () => boolean;
      getURL?: () => string;
      reload?: () => void;
    }>("[data-testid='chat-side-panel-browser-webview']");
    expect(webview).not.toBeNull();
    const reload = vi.fn();
    Object.assign(webview!, {
      canGoBack: () => false,
      canGoForward: () => false,
      getURL: () => "http://127.0.0.1:3201/",
      reload,
    });

    const removeEventListener = vi.spyOn(webview!, "removeEventListener");
    await act(async () => {
      webview!.dispatchEvent(new Event("dom-ready"));
      webview!.dispatchEvent(Object.assign(new Event("did-start-navigation"), {
        isMainFrame: true,
        url: "http://127.0.0.1:3201/",
      }));
      await Promise.resolve();
    });
    expect(removeEventListener).not.toHaveBeenCalledWith("did-fail-load", expect.any(Function));

    await act(async () => {
      webview!.dispatchEvent(Object.assign(new Event("did-fail-load"), {
        errorDescription: "ERR_CONNECTION_REFUSED",
        isMainFrame: false,
        validatedURL: "http://127.0.0.1:3201/subframe",
      }));
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid='chat-side-panel-browser-error']")).toBeNull();
    expect(webview?.className).not.toContain("invisible");

    await act(async () => {
      webview!.dispatchEvent(Object.assign(new Event("did-fail-load"), {
        errorDescription: "ERR_ABORTED",
        isMainFrame: true,
        validatedURL: "http://127.0.0.1:3201/",
      }));
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid='chat-side-panel-browser-error']")).toBeNull();
    expect(webview?.className).not.toContain("invisible");

    await act(async () => {
      webview!.dispatchEvent(Object.assign(new Event("did-fail-load"), {
        errorDescription: "ERR_CONNECTION_REFUSED",
        isMainFrame: true,
        validatedURL: "http://127.0.0.1:3201/",
      }));
      await Promise.resolve();
    });

    const errorState = container.querySelector<HTMLElement>("[data-testid='chat-side-panel-browser-error']");
    expect(errorState).not.toBeNull();
    expect(errorState?.textContent).toContain("This site can't be reached");
    expect(errorState?.textContent).toContain("127.0.0.1 refused to connect.");
    expect(errorState?.textContent).toContain("ERR_CONNECTION_REFUSED");
    expect(webview?.getAttribute("src")).toBe("http://127.0.0.1:3201");
    expect(webview?.className).toContain("invisible");

    const detailsButton = Array.from(errorState!.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Details"),
    );
    await act(async () => {
      detailsButton?.click();
      await Promise.resolve();
    });
    expect(errorState?.textContent).toContain("http://127.0.0.1:3201/");

    const reloadButton = Array.from(errorState!.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Reload"),
    );
    await act(async () => {
      reloadButton?.click();
      await Promise.resolve();
    });
    expect(reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      webview!.dispatchEvent(new Event("did-start-loading"));
      await Promise.resolve();
    });
    expect(container.querySelector("[data-testid='chat-side-panel-browser-error']")).toBeNull();

    await act(async () => {
      webview!.dispatchEvent(Object.assign(new Event("did-fail-load"), {
        errorDescription: "ERR_NAME_NOT_RESOLVED",
        isMainFrame: true,
        validatedURL: "http://missing.test/",
      }));
      await Promise.resolve();
    });
    const dnsErrorState = container.querySelector<HTMLElement>("[data-testid='chat-side-panel-browser-error']");
    expect(dnsErrorState?.textContent).toContain("missing.test's server IP address could not be found.");
    expect(dnsErrorState?.textContent).not.toContain("refused to connect");
  });

  it("routes focused Desktop Browser shortcuts to the active ready webview", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "browser-shortcut-actions", body: "Use Browser shortcuts." })],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Open Side Panel"]')?.click();
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
    const urlInput = sidePanel!.querySelector<HTMLInputElement>('input[aria-label="Browser URL"]')!;
    await act(async () => {
      urlInput.value = "localhost:4173/browser-fixture";
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));
      urlInput.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    const webview = container.querySelector<HTMLElement & {
      canGoBack?: () => boolean;
      canGoForward?: () => boolean;
      getURL?: () => string;
      goBack?: () => void;
      goForward?: () => void;
      reload?: () => void;
      reloadIgnoringCache?: () => void;
      setZoomFactor?: (factor: number) => void;
    }>("[data-testid='chat-side-panel-browser-webview']")!;
    const reload = vi.fn();
    const reloadIgnoringCache = vi.fn();
    const goBack = vi.fn();
    const goForward = vi.fn();
    const setZoomFactor = vi.fn();
    Object.assign(webview, {
      canGoBack: () => true,
      canGoForward: () => true,
      getURL: () => "http://localhost:4173/browser-fixture",
      goBack,
      goForward,
      reload,
      reloadIgnoringCache,
      setZoomFactor,
    });
    await act(async () => {
      webview.dispatchEvent(new Event("dom-ready"));
      urlInput.focus();
      await Promise.resolve();
    });

    expect(mockState.browserShortcutListener).not.toBeNull();
    await act(async () => {
      mockState.browserShortcutListener?.("reload");
      mockState.browserShortcutListener?.("reload_ignoring_cache");
      mockState.browserShortcutListener?.("go_back");
      mockState.browserShortcutListener?.("go_forward");
      mockState.browserShortcutListener?.("zoom_in");
      await Promise.resolve();
    });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(goBack).toHaveBeenCalledTimes(1);
    expect(goForward).toHaveBeenCalledTimes(1);
    expect(setZoomFactor).toHaveBeenLastCalledWith(1.1);
    expect(sidePanel?.querySelector("[data-testid='chat-side-panel-browser-zoom']")?.textContent).toBe("110%");

    await act(async () => {
      mockState.browserShortcutListener?.("zoom_out");
      mockState.browserShortcutListener?.("zoom_reset");
      await Promise.resolve();
    });
    expect(setZoomFactor).toHaveBeenLastCalledWith(1);
    expect(sidePanel?.querySelector("[data-testid='chat-side-panel-browser-zoom']")).toBeNull();

    const focusTarget = sidePanel!.querySelector<HTMLButtonElement>('button[aria-label="Open new browser tab"]')!;
    focusTarget.focus();
    urlInput.setSelectionRange(0, 0);
    await act(async () => {
      mockState.browserShortcutListener?.("focus_location");
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(urlInput);
    expect(urlInput.selectionStart).toBe(0);
    expect(urlInput.selectionEnd).toBe(urlInput.value.length);

    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);
    outsideButton.focus();
    await act(async () => {
      mockState.browserShortcutListener?.("reload");
      await Promise.resolve();
    });
    expect(reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      focusTarget.focus();
      mockState.browserShortcutListener?.("new_tab");
      await Promise.resolve();
    });
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(2);
    const activeBlankAddress = container.querySelector<HTMLInputElement>(
      "[data-testid='chat-side-panel-browser-view'] input[aria-label='Browser URL']",
    )!;
    activeBlankAddress.focus();
    await act(async () => {
      mockState.browserShortcutListener?.("reload");
      mockState.browserShortcutListener?.("zoom_in");
      await Promise.resolve();
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(setZoomFactor).toHaveBeenCalledTimes(3);
  });

  it("hides Browser entry points outside the Desktop Browser capability", async () => {
    delete (window as typeof window & { desktopShell?: unknown }).desktopShell;
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "browser-capability-message", body: "Open the side panel." })],
    };

    const { container } = renderChat();
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Open Side Panel"]');
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });

    const sidePanel = container.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
    expect(sidePanel?.textContent).toContain("Library");
    expect(Array.from(sidePanel!.querySelectorAll("button")).some((button) => button.textContent?.includes("Browser"))).toBe(false);
  });

  it("closes the active Browser side panel tab when the webview receives Command+W", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "browser-side-panel-shortcut-message", body: "Open the browser panel." })],
    };

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const chatSidePanelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open Side Panel"]');
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
    await act(async () => {
      urlInput!.value = "localhost:4173/browser-fixture";
      urlInput!.dispatchEvent(new Event("input", { bubbles: true }));
      urlInput!.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    const webview = container.querySelector<HTMLElement>("[data-testid='chat-side-panel-browser-webview']");
    expect(webview).not.toBeNull();
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(1);

    const shortcut = new Event("before-input-event", { bubbles: true, cancelable: true }) as Event & {
      input?: { key: string; meta: boolean };
    };
    shortcut.input = { key: "w", meta: true };
    await act(async () => {
      webview!.dispatchEvent(shortcut);
      await Promise.resolve();
    });

    expect(shortcut.defaultPrevented).toBe(true);
    expect(container.querySelectorAll("[data-testid='chat-side-panel-tab']")).toHaveLength(0);
    expect(container.querySelector("[data-testid='chat-side-panel']")).toBeNull();
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

    const sidePanel = document.body.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
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
    expect(document.body.querySelector("[data-testid='chat-side-panel']")).toBeNull();
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

    const sidePanel = document.body.querySelector<HTMLElement>("[data-testid='chat-side-panel']");
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
          body: `The agent reply tracks [ZST-789](${buildIssueMentionHref("issue-789", "ZST-789", null, "in_progress")}) and keeps \`agent://\` as code only.`,
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
        streamKey: "stream-1",
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

  it("acknowledges the newest visible generation checkpoint after the stream draft commits", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        streamKey: "stream-1",
        userBody: "Please draft a plan.",
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: "user-message-1",
        chatTurnId: "turn-1",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: "Rendered prefix",
        generationId: "generation-1",
        attemptEpoch: 2,
        lastCommittedRenderSeq: 9,
        renderedBodyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };

    renderChat();

    await vi.waitFor(() => expect(mockState.checkpointMessageStream).toHaveBeenCalledWith(
      "chat-1",
      {
        generationId: "generation-1",
        attemptEpoch: 2,
        generationSeq: 9,
        renderedBodyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ));
  });

  it("rebases the active timeline anchor to the persisted ACK time when the browser clock is ahead", async () => {
    const controlled = await startControlledChatStream();
    const persistedCreatedAt = new Date("2020-05-12T09:04:00.000Z");
    expect(controlled.createdDraft.userCreatedAt.getTime()).toBeGreaterThan(persistedCreatedAt.getTime());
    const callCountBeforeAck = mockState.setStreamDraftForChat.mock.calls.length;

    await controlled.emitAck(persistedCreatedAt);

    const ackUpdate = mockState.setStreamDraftForChat.mock.calls
      .slice(callCountBeforeAck)
      .map((call) => call[1])
      .find((candidate): candidate is (current: ChatStreamDraft | null) => ChatStreamDraft | null => (
        typeof candidate === "function"
      ));
    expect(ackUpdate).toBeDefined();
    expect(ackUpdate!(controlled.createdDraft)?.userCreatedAt).toEqual(persistedCreatedAt);
  });

  it("freezes immediately, then aborts and clears the matching stream after Stop acknowledgement", async () => {
    let resolveStop!: (value: { stopped: boolean }) => void;
    mockState.stopMessageStream.mockReturnValue(new Promise((resolve) => {
      resolveStop = resolve;
    }));
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
        streamKey: "stream-1",
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
    mockState.setStreamDraftForChat.mockClear();

    await clickEnabledButtonByAriaLabel(container, "Stop streaming");

    expect(mockState.stopMessageStream).toHaveBeenCalledWith("chat-1", expect.objectContaining({
      controlActionId: expect.any(String),
      lastCommittedRenderSeq: 0,
      renderedBodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    }));
    expect(mockState.abortChatStream).not.toHaveBeenCalled();
    expect(mockState.setStreamDraftForChat).toHaveBeenCalledTimes(1);
    const freezeUpdate = mockState.setStreamDraftForChat.mock.calls[0]?.[1] as (
      current: ChatStreamDraft | null,
    ) => ChatStreamDraft | null;
    const frozen = freezeUpdate(mockState.streamDrafts["chat-1"] ?? null);
    expect(frozen).toMatchObject({
      streamKey: "stream-1",
      body: "Working on it...",
      state: "stopping",
    });
    expect(mockState.pushToast).not.toHaveBeenCalledWith(expect.objectContaining({
      title: "Response stopped",
    }));

    await act(async () => {
      resolveStop({ stopped: true });
      await Promise.resolve();
    });

    expect(mockState.setStreamDraftForChat).toHaveBeenCalledTimes(2);
    const settledUpdate = mockState.setStreamDraftForChat.mock.calls[1]?.[1] as (
      current: ChatStreamDraft | null,
    ) => ChatStreamDraft | null;
    expect(settledUpdate(frozen)).toBeNull();
    expect(mockState.abortChatStream).toHaveBeenCalledWith("chat-1");
    expect(mockState.setChatSendInFlight).toHaveBeenCalledWith("chat-1", false);
    expect(readPendingChatStopRecovery("org-1", "chat-1")).toBeNull();
    expect(mockState.pushToast).toHaveBeenCalledWith({
      title: "Response stopped",
      body: "Rudder interrupted the current reply.",
      tone: "info",
    });
  });

  it("keeps a final-before-ACK event behind the Stop cutoff", async () => {
    let resolveStop!: (value: { stopped: boolean; disposition: string }) => void;
    mockState.stopMessageStream.mockReturnValueOnce(new Promise((resolve) => {
      resolveStop = resolve;
    }));
    const stream = await startControlledChatStream();

    await clickEnabledButtonByAriaLabel(stream.container, "Stop streaming");
    const firstRequest = mockState.stopMessageStream.mock.calls[0]?.[1];
    mockState.setQueryData.mockClear();
    await stream.emitFinal();

    expect(mockState.stopMessageStream).toHaveBeenCalledTimes(1);
    expect(mockState.setQueryData).not.toHaveBeenCalled();

    await act(async () => {
      resolveStop({ stopped: true, disposition: "stopping" });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(readPendingChatStopRecovery("org-1", "chat-1")).toBeNull());

    expect(mockState.stopMessageStream).toHaveBeenCalledTimes(1);
    expect(mockState.stopMessageStream).toHaveBeenCalledWith("chat-1", firstRequest);
    expect(mockState.abortChatStream).toHaveBeenCalledWith("chat-1");
    await stream.finishStream();
  });

  it("suppresses a final event that arrives after the Stop ACK", async () => {
    const stream = await startControlledChatStream();

    await clickEnabledButtonByAriaLabel(stream.container, "Stop streaming");
    await vi.waitFor(() => expect(mockState.abortChatStream).toHaveBeenCalledWith("chat-1"));
    expect(readPendingChatStopRecovery("org-1", "chat-1")).toBeNull();

    mockState.setQueryData.mockClear();
    await stream.emitFinal();

    expect(mockState.setQueryData).not.toHaveBeenCalled();
    expect(mockState.setChatSendInFlight).toHaveBeenCalledWith("chat-1", false);
    await stream.finishStream();
  });

  it("lets the original final converge when completion committed before Stop", async () => {
    mockState.stopMessageStream.mockResolvedValueOnce({
      stopped: false,
      disposition: "completion_committed",
    });
    const stream = await startControlledChatStream();

    await clickEnabledButtonByAriaLabel(stream.container, "Stop streaming");
    await vi.waitFor(() => expect(mockState.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Response completed",
    })));

    expect(mockState.abortChatStream).not.toHaveBeenCalled();
    expect(mockState.setChatSendInFlight).toHaveBeenCalledWith("chat-1", false);
    expect(readPendingChatStopRecovery("org-1", "chat-1")).toBeNull();
    expect(mockState.pushToast).not.toHaveBeenCalledWith(expect.objectContaining({
      title: "Stop confirmation pending",
    }));
    expect(mockState.pushToast).not.toHaveBeenCalledWith(expect.objectContaining({
      title: "Stop was rejected",
    }));

    mockState.setQueryData.mockClear();
    await stream.emitFinal();
    expect(mockState.setQueryData).toHaveBeenCalled();
    await stream.finishStream();
  });

  it("retries the same Stop action immediately when final follows a transport-unknown result", async () => {
    mockState.stopMessageStream
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementationOnce(async (_chatId: string, request: { controlActionId: string }) => ({
        stopped: true,
        disposition: "stopping",
        controlActionId: request.controlActionId,
      }));
    const stream = await startControlledChatStream();

    await clickEnabledButtonByAriaLabel(stream.container, "Stop streaming");
    await vi.waitFor(() => expect(mockState.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Stop confirmation pending",
    })));
    const firstRequest = mockState.stopMessageStream.mock.calls[0]?.[1];

    await stream.emitFinal();
    await vi.waitFor(() => expect(mockState.stopMessageStream).toHaveBeenCalledTimes(2));

    expect(mockState.stopMessageStream.mock.calls[1]?.[1]).toEqual(firstRequest);
    await vi.waitFor(() => expect(readPendingChatStopRecovery("org-1", "chat-1")).toBeNull());
    expect(mockState.abortChatStream).toHaveBeenCalledWith("chat-1");
    await stream.finishStream();
  });

  it("does not downgrade an acknowledged Stop when message and queue refresh fail", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        streamKey: "stream-refresh-failure",
        userBody: "Please draft a plan.",
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: "user-message-1",
        chatTurnId: "turn-1",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: "Visible prefix",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };
    const { container } = renderChat();
    mockState.invalidateQueries.mockReset();
    mockState.invalidateQueries.mockRejectedValue(new Error("refresh failed"));

    await clickEnabledButtonByAriaLabel(container, "Stop streaming");
    await vi.waitFor(() => expect(readPendingChatStopRecovery("org-1", "chat-1")).toBeNull());

    expect(mockState.abortChatStream).toHaveBeenCalledWith("chat-1");
    expect(mockState.setChatSendInFlight).toHaveBeenCalledWith("chat-1", false);
    expect(mockState.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Response stopped",
    }));
    expect(mockState.pushToast).not.toHaveBeenCalledWith(expect.objectContaining({
      title: "Stop confirmation pending",
    }));
  });

  it("does not let an old Stop recovery abort or clear a newer stream", async () => {
    let resolveStop!: (value: { stopped: boolean; disposition: string }) => void;
    mockState.stopMessageStream.mockReturnValueOnce(new Promise((resolve) => {
      resolveStop = resolve;
    }));
    const oldDraft: ChatStreamDraft = {
      chatId: "chat-1",
      streamKey: "stream-old",
      userBody: "Old reply",
      userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
      userMessageId: "user-message-old",
      chatTurnId: "turn-old",
      turnVariant: 0,
      editedFromCreatedAt: null,
      body: "Old visible prefix",
      state: "streaming",
      createdAt: new Date("2026-05-12T09:04:01.000Z"),
      transcript: [],
      replyingAgentId: "agent-1",
    };
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-old", body: "Old reply" })],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = { "chat-1": oldDraft };
    const rendered = renderChat();

    await clickEnabledButtonByAriaLabel(rendered.container, "Stop streaming");
    const newDraft = {
      ...oldDraft,
      streamKey: "stream-new",
      userMessageId: "user-message-new",
      chatTurnId: "turn-new",
      body: "New stream output",
    };
    mockState.streamDrafts = { "chat-1": newDraft };
    rendered.rerender();

    await act(async () => {
      resolveStop({ stopped: true, disposition: "stopping" });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(readPendingChatStopRecovery("org-1", "chat-1")).toBeNull());

    expect(mockState.abortChatStream).not.toHaveBeenCalled();
    expect(mockState.setChatSendInFlight).not.toHaveBeenCalledWith("chat-1", false);
    for (const [, update] of mockState.setStreamDraftForChat.mock.calls) {
      if (typeof update === "function") expect(update(newDraft)).toBe(newDraft);
    }
  });

  it.each([
    { state: "stopping" as const, label: "Stopping response" },
    { state: "stopped" as const, label: "Response stopped" },
  ])("exposes a stable $state state without offering Stop again", ({ state, label }) => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        streamKey: "stream-1",
        userBody: "Please draft a plan.",
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: "user-message-1",
        chatTurnId: "turn-1",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: "Working on it...",
        state,
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };

    const { container } = renderChat();

    const statusButton = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(statusButton).not.toBeNull();
    expect(statusButton?.disabled).toBe(true);
    expect(container.querySelector("button[aria-label='Stop streaming']")).toBeNull();
  });

  it("keeps stop available when only the server reports an active generation", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: "generation-1",
      activeAttemptEpoch: 1,
      activeControlVersion: 0,
      activeGenerationStatus: "running",
    });

    const { container } = renderChat();

    await clickEnabledButtonByAriaLabel(container, "Stop streaming");

    expect(mockState.stopMessageStream).toHaveBeenCalledWith("chat-1", expect.objectContaining({
      controlActionId: expect.any(String),
      expectedGenerationId: "generation-1",
      expectedAttemptEpoch: 1,
      expectedControlVersion: 0,
    }));
    const [, stopRequest] = mockState.stopMessageStream.mock.calls.at(-1) ?? [];
    expect(stopRequest).not.toHaveProperty("lastCommittedRenderSeq");
    expect(stopRequest).not.toHaveProperty("renderedBodyHash");
  });

  it("uses one coherent server generation fence while retaining the rendered draft checkpoint", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        streamKey: "stream-1",
        userBody: "Please draft a plan.",
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: "user-message-1",
        chatTurnId: "turn-1",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: "Visible prefix",
        generationId: "generation-1",
        attemptEpoch: 1,
        lastCommittedRenderSeq: 9,
        renderedBodyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: "generation-1",
      activeAttemptEpoch: 2,
      activeControlVersion: 7,
      activeGenerationStatus: "running",
    });

    const { container } = renderChat();
    await clickEnabledButtonByAriaLabel(container, "Stop streaming");

    expect(mockState.stopMessageStream).toHaveBeenCalledWith("chat-1", expect.objectContaining({
      expectedGenerationId: "generation-1",
      expectedAttemptEpoch: 2,
      expectedControlVersion: 7,
      lastCommittedRenderSeq: 9,
      renderedBodyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }));
  });

  it("restores the live draft state and clears recovery when Stop is explicitly rejected", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        streamKey: "stream-1",
        userBody: "Please draft a plan.",
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: "user-message-1",
        chatTurnId: "turn-1",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: "Visible prefix",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };
    mockState.stopMessageStream.mockRejectedValueOnce(
      new ApiError("control version changed", 409, { error: "control version changed" }),
    );

    const { container } = renderChat();
    await clickEnabledButtonByAriaLabel(container, "Stop streaming");

    await vi.waitFor(() => expect(mockState.setStreamDraftForChat).toHaveBeenCalledTimes(2));
    const restoreUpdate = mockState.setStreamDraftForChat.mock.calls[1]?.[1] as (
      current: ChatStreamDraft | null,
    ) => ChatStreamDraft | null;
    expect(restoreUpdate({ ...mockState.streamDrafts["chat-1"]!, state: "stopping" })).toMatchObject({
      state: "streaming",
      body: "Visible prefix",
    });
    expect(readPendingChatStopRecovery("org-1", "chat-1")).toBeNull();
  });

  it("retains an unknown Stop result and replays the exact action after remount", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        streamKey: "stream-1",
        userBody: "Please draft a plan.",
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: "user-message-1",
        chatTurnId: "turn-1",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: "Immutable visible prefix",
        generationId: "generation-1",
        attemptEpoch: 1,
        lastCommittedRenderSeq: 4,
        renderedBodyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: "generation-1",
      activeAttemptEpoch: 1,
      activeControlVersion: 3,
      activeGenerationStatus: "running",
    });
    mockState.stopMessageStream
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(() => new Promise(() => {}));

    const firstRender = renderChat();
    await clickEnabledButtonByAriaLabel(firstRender.container, "Stop streaming");
    await vi.waitFor(() => expect(mockState.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Stop confirmation pending",
    })));

    const firstRequest = mockState.stopMessageStream.mock.calls[0]?.[1];
    const persisted = readPendingChatStopRecovery("org-1", "chat-1");
    expect(persisted?.request).toEqual(firstRequest);
    expect(persisted?.frozenDraft).toMatchObject({
      body: "Immutable visible prefix",
      state: "streaming",
    });
    const freezeUnknownUpdate = mockState.setStreamDraftForChat.mock.calls[0]?.[1] as (
      current: ChatStreamDraft | null,
    ) => ChatStreamDraft | null;
    expect(freezeUnknownUpdate(mockState.streamDrafts["chat-1"] ?? null)).toMatchObject({
      body: "Immutable visible prefix",
      state: "stopping",
    });

    cleanupFn?.();
    cleanupFn = null;
    mockState.setStreamDraftForChat.mockClear();
    mockState.stopMessageStream.mockClear();
    let resolveReplay!: (value: { stopped: boolean; disposition: string }) => void;
    mockState.stopMessageStream.mockReturnValueOnce(new Promise((resolve) => {
      resolveReplay = resolve;
    }));
    mockState.streamDrafts = {};

    renderChat();
    await vi.waitFor(() => expect(mockState.stopMessageStream).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveReplay({ stopped: true, disposition: "stopping" });
      await Promise.resolve();
    });

    expect(mockState.stopMessageStream).toHaveBeenCalledWith("chat-1", firstRequest);
    expect(readPendingChatStopRecovery("org-1", "chat-1")).toBeNull();
    const restoredDraft = mockState.setStreamDraftForChat.mock.calls[0]?.[1] as (
      current: ChatStreamDraft | null,
    ) => ChatStreamDraft | null;
    expect(restoredDraft(null)).toMatchObject({
      body: "Immutable visible prefix",
      state: "stopping",
    });
    const replaySettledUpdate = mockState.setStreamDraftForChat.mock.calls.at(-1)?.[1] as (
      current: ChatStreamDraft | null,
    ) => ChatStreamDraft | null;
    expect(replaySettledUpdate({ ...persisted!.frozenDraft!, state: "stopped" })).toBeNull();
    expect(mockState.abortChatStream).toHaveBeenCalledWith("chat-1");
  });

  it("does not label an arbitrary no-active-generation response as stopped", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        streamKey: "stream-1",
        userBody: "Please draft a plan.",
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: "user-message-1",
        chatTurnId: "turn-1",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: "Naturally completed prefix",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };
    mockState.stopMessageStream.mockResolvedValueOnce({
      stopped: false,
      disposition: "no_active_generation",
    });

    const { container } = renderChat();
    await clickEnabledButtonByAriaLabel(container, "Stop streaming");
    await vi.waitFor(() => expect(mockState.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "No active response",
    })));

    const settleUpdate = mockState.setStreamDraftForChat.mock.calls[1]?.[1] as (
      current: ChatStreamDraft | null,
    ) => ChatStreamDraft | null;
    expect(settleUpdate({ ...mockState.streamDrafts["chat-1"]!, state: "stopping" })).toBeNull();
    expect(mockState.pushToast).not.toHaveBeenCalledWith(expect.objectContaining({
      title: "Response stopped",
    }));
  });

  it("adds a composer message to Queue when the server reports an active generation", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: "generation-1",
      activeAttemptEpoch: 1,
      activeControlVersion: 0,
      activeGenerationStatus: "running",
    });

    const { container } = renderChat();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Composer draft']");
    expect(textarea).not.toBeNull();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(textarea, "Add this after the current reply.");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await clickEnabledButtonByAriaLabel(container, "Queue");

    expect(mockState.createQueuedMessage).toHaveBeenCalledTimes(1);
    expect(mockState.createQueuedMessage).toHaveBeenCalledWith("chat-1", expect.objectContaining({
      expectedGenerationId: "generation-1",
      payload: expect.objectContaining({
        body: "Add this after the current reply.",
        metadata: { source: "chat_composer" },
      }),
    }));
    expect(mockState.sendMessageStream).not.toHaveBeenCalled();
    expect(mockState.pushToast).toHaveBeenCalledWith({
      title: "Queued",
      body: "Added to Queue.",
      tone: "info",
    });
  });

  it("edits the original turn directly when a stale generation id is already terminal", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({
        id: "user-message-1",
        body: "Please draft a plan.",
        chatTurnId: "turn-1",
      })],
    };
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: "generation-terminal",
      activeAttemptEpoch: 1,
      activeControlVersion: 1,
      activeGenerationStatus: "stopped",
    });

    const { container } = renderChat();

    expect(container.querySelector('button[aria-label="Stop streaming"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Queue"]')).toBeNull();
    await clickEnabledButtonByAriaLabel(container, "Edit message");
    const inlineEditor = container.querySelector<HTMLElement>("[data-testid='chat-inline-message-editor']");
    expect(inlineEditor).not.toBeNull();
    await clickEnabledButton(inlineEditor!, "Send");

    await vi.waitFor(() => expect(mockState.sendMessageStream).toHaveBeenCalledTimes(1));
    expect(mockState.sendMessageStream).toHaveBeenCalledWith(
      "chat-1",
      "Please draft a plan.",
      expect.objectContaining({ editUserMessageId: "user-message-1" }),
    );
    expect(mockState.createQueuedMessage).not.toHaveBeenCalled();
  });

  it("keeps an original-turn edit out of Queue while the current response is active", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({
        id: "user-message-1",
        body: "Please draft a plan.",
        chatTurnId: "turn-1",
      })],
    };
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: "generation-running",
      activeAttemptEpoch: 1,
      activeControlVersion: 0,
      activeGenerationStatus: "running",
    });

    const { container } = renderChat();

    await clickEnabledButtonByAriaLabel(container, "Edit message");
    const inlineEditor = container.querySelector<HTMLElement>("[data-testid='chat-inline-message-editor']");
    const sendButton = Array.from(inlineEditor?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((button) => button.textContent?.trim() === "Send");

    expect(sendButton).not.toBeUndefined();
    expect(sendButton?.disabled).toBe(true);
    expect(mockState.sendMessageStream).not.toHaveBeenCalled();
    expect(mockState.createQueuedMessage).not.toHaveBeenCalled();
  });

  it("keeps a failed-response Retry out of Queue while another response is active", async () => {
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "user-message-1",
          body: "Please draft a plan.",
          chatTurnId: "turn-1",
        }),
        message({
          id: "assistant-message-1",
          role: "assistant",
          body: "The response failed.",
          status: "failed",
          chatTurnId: "turn-1",
          createdAt: new Date("2026-05-12T09:01:01.000Z"),
        }),
      ],
    };
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: "generation-running",
      activeAttemptEpoch: 1,
      activeControlVersion: 0,
      activeGenerationStatus: "running",
    });

    const { container } = renderChat();
    await clickEnabledButton(container, "Retry");

    expect(mockState.sendMessageStream).not.toHaveBeenCalled();
    expect(mockState.createQueuedMessage).not.toHaveBeenCalled();
    expect(mockState.pushToast).toHaveBeenCalledWith({
      title: "Retry unavailable",
      body: "Stop the current response before retrying this message.",
      tone: "error",
    });
  });

  it("renders claimed Queue messages without editable queue actions before delivery", () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: "generation-1",
      activeAttemptEpoch: 1,
      activeControlVersion: 0,
      activeGenerationStatus: "running",
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
    });

    const { container } = renderChat();
    const queueItem = container.querySelector("[data-testid='chat-running-queue-item']");

    expect(queueItem?.textContent).toContain("Running");
    expect(queueItem?.textContent).toContain("Already delivering");
    expect(queueItem?.querySelector("button[aria-label='Edit queued message']")).toBeNull();
    expect(queueItem?.querySelector("button[aria-label='Delete queued message']")).toBeNull();
    expect(queueItem?.textContent).not.toContain("Steer");
  });

  it("lets retained feedback be steered into a continuation after Stop", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        streamKey: "stream-before-retained-steer",
        userBody: "Please draft a plan.",
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: "user-message-1",
        chatTurnId: "turn-1",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: "Stopped prefix",
        generationId: "generation-1",
        attemptEpoch: 3,
        lastCommittedRenderSeq: 12,
        renderedBodyHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };
    const item = queuedMessage({
      id: "queue-retained-steer",
      expectedGenerationId: "generation-1",
      payload: {
        body: "Keep this feedback after Stop.",
        attachmentIds: [],
        projectId: null,
        skillRefs: [],
        accessMode: null,
        model: null,
        effort: null,
        metadata: null,
      },
    });
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: "generation-1",
      activeAttemptEpoch: 3,
      activeControlVersion: 7,
      activeGenerationStatus: "running",
      items: [item],
    });
    mockState.steerQueuedMessage.mockResolvedValueOnce({
      result: "scheduled_next",
      disposition: "continuation_pending",
      controlActionId: "20000000-0000-4000-8000-000000000002",
      activeGenerationId: null,
      item: queuedMessage({
        ...item,
        status: "continuation_pending",
        deliveryIntent: "steer",
        deliveryDisposition: "continuation_pending",
      }),
      queueVersion: 2,
      transcriptEventId: null,
    });

    const { container } = renderChat();
    await clickEnabledButtonByAriaLabel(container, "Stop streaming");
    await vi.waitFor(() => expect(readPendingChatStopRecovery("org-1", "chat-1")).toBeNull());
    await clickEnabledButton(container, "Steer");

    expect(mockState.steerQueuedMessage).toHaveBeenCalledWith(
      "chat-1",
      "queue-retained-steer",
      expect.objectContaining({
        expectedActiveGenerationId: "generation-1",
        controlActionId: expect.any(String),
      }),
    );
    const durableUpdater = mockState.setQueryData.mock.calls.at(-1)?.[1] as (
      current: ChatQueueSnapshot,
    ) => ChatQueueSnapshot;
    expect(durableUpdater(mockState.queueSnapshot).items[0]).toMatchObject({
      status: "continuation_pending",
      deliveryDisposition: "continuation_pending",
    });
  });

  it("sends durable Steer identity and reports same-run delivery without an unsupported warning", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        streamKey: "stream-1",
        userBody: "Please draft a plan.",
        userCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        userMessageId: "user-message-1",
        chatTurnId: "turn-1",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: "Rendered before steer",
        generationId: "generation-1",
        attemptEpoch: 3,
        lastCommittedRenderSeq: 12,
        renderedBodyHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:04:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };
    const item = queuedMessage({
      id: "queue-steer-1",
      expectedGenerationId: "generation-1",
      payload: {
        body: "Use the public API instead.",
        attachmentIds: [],
        projectId: null,
        skillRefs: [],
        accessMode: null,
        model: null,
        effort: null,
        metadata: null,
      },
    });
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: "generation-1",
      activeAttemptEpoch: 3,
      activeControlVersion: 7,
      activeGenerationStatus: "running",
      items: [item],
    });
    mockState.steerQueuedMessage.mockResolvedValueOnce({
      result: "delivered_current",
      disposition: "accepted_current",
      controlActionId: "20000000-0000-4000-8000-000000000002",
      activeGenerationId: "generation-1",
      item: queuedMessage({
        ...item,
        status: "accepted_current",
        deliveryIntent: "steer",
        deliveryDisposition: "accepted_current",
      }),
      queueVersion: 2,
      transcriptEventId: null,
    });

    const { container } = renderChat();
    await clickEnabledButton(container, "Steer");

    expect(mockState.steerQueuedMessage).toHaveBeenCalledWith(
      "chat-1",
      "queue-steer-1",
      {
        expectedActiveGenerationId: "generation-1",
        controlActionId: expect.any(String),
        expectedAttemptEpoch: 3,
        expectedControlVersion: 7,
        lastCommittedRenderSeq: 12,
        renderedBodyHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    );
    expect(mockState.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Delivered to current run",
      tone: "success",
    }));
    expect(mockState.pushToast).not.toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining("cannot accept mid-run steering"),
    }));
  });

  it("keeps accepted Steer feedback after the active response when the response completes", () => {
    const originalUserMessage = message({
      id: "user-message-before-steer",
      body: "Please draft a plan.",
      chatTurnId: "turn-active",
      createdAt: new Date("2026-05-12T09:04:00.000Z"),
      updatedAt: new Date("2026-05-12T09:04:00.000Z"),
    });
    const activeAssistantMessage = message({
      id: "assistant-message-before-steer",
      role: "assistant",
      status: "streaming",
      body: "In-progress answer before Steer",
      replyingAgentId: "agent-1",
      chatTurnId: "turn-active",
      createdAt: new Date("2026-05-12T09:04:01.000Z"),
      updatedAt: new Date("2026-05-12T09:04:01.000Z"),
    });
    const steerUserMessage = message({
      id: "user-message-from-steer",
      body: "hi from Steer",
      chatTurnId: "turn-steer",
      createdAt: new Date("2026-05-12T09:04:02.000Z"),
      updatedAt: new Date("2026-05-12T09:04:02.000Z"),
    });
    mockState.messagesByChatId = {
      "chat-1": [originalUserMessage, activeAssistantMessage, steerUserMessage],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        streamKey: "stream-with-steer-message",
        userBody: originalUserMessage.body,
        userCreatedAt: originalUserMessage.createdAt,
        userMessageId: originalUserMessage.id,
        chatTurnId: "turn-active",
        turnVariant: 0,
        editedFromCreatedAt: null,
        body: activeAssistantMessage.body,
        generationId: "generation-1",
        attemptEpoch: 3,
        lastCommittedRenderSeq: 12,
        renderedBodyHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        state: "streaming",
        createdAt: activeAssistantMessage.createdAt,
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };

    const { container, rerender } = renderChat();
    const content = container.querySelector<HTMLElement>("[data-testid='chat-messages-content']");
    expect(content).not.toBeNull();
    expect(content!.textContent!.indexOf(activeAssistantMessage.body))
      .toBeLessThan(content!.textContent!.indexOf(steerUserMessage.body));

    mockState.messagesByChatId = {
      "chat-1": [
        originalUserMessage,
        { ...activeAssistantMessage, status: "completed" },
        steerUserMessage,
      ],
    };
    mockState.sendInFlightByChatId = {};
    mockState.streamDrafts = {};
    rerender();

    expect(content!.textContent!.indexOf(activeAssistantMessage.body))
      .toBeLessThan(content!.textContent!.indexOf(steerUserMessage.body));
  });

  it("keeps accepted Steer feedback visible while an edited message response is active", () => {
    const editedUserMessage = message({
      id: "edited-user-message",
      body: "Edited plan request",
      chatTurnId: "turn-edited",
      turnVariant: 1,
      createdAt: new Date("2026-05-12T09:05:00.000Z"),
      updatedAt: new Date("2026-05-12T09:05:00.000Z"),
    });
    const steerUserMessage = message({
      id: "user-message-from-edited-steer",
      body: "visible Steer feedback for edited response",
      chatTurnId: "turn-steer",
      createdAt: new Date("2026-05-12T09:05:02.000Z"),
      updatedAt: new Date("2026-05-12T09:05:02.000Z"),
    });
    mockState.messagesByChatId = {
      "chat-1": [
        message({
          id: "message-before-edit",
          body: "Earlier context",
          createdAt: new Date("2026-05-12T09:03:00.000Z"),
          updatedAt: new Date("2026-05-12T09:03:00.000Z"),
        }),
        editedUserMessage,
        steerUserMessage,
      ],
    };
    mockState.sendInFlightByChatId = { "chat-1": true };
    mockState.streamDrafts = {
      "chat-1": {
        chatId: "chat-1",
        streamKey: "edited-stream-with-steer-message",
        userBody: editedUserMessage.body,
        userCreatedAt: editedUserMessage.createdAt,
        userMessageId: editedUserMessage.id,
        chatTurnId: editedUserMessage.chatTurnId,
        turnVariant: editedUserMessage.turnVariant,
        editedFromCreatedAt: new Date("2026-05-12T09:04:00.000Z"),
        body: "Edited response still in progress",
        state: "streaming",
        createdAt: new Date("2026-05-12T09:05:01.000Z"),
        transcript: [],
        replyingAgentId: "agent-1",
      },
    };

    const { container } = renderChat();
    const content = container.querySelector<HTMLElement>("[data-testid='chat-messages-content']");

    expect(content?.textContent).toContain(steerUserMessage.body);
    expect(content!.textContent!.indexOf("Edited response still in progress"))
      .toBeLessThan(content!.textContent!.indexOf(steerUserMessage.body));
  });

  it("locks Steer immediately and applies the durable response item without waiting for refetch", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    let resolveSteer!: (value: Awaited<ReturnType<typeof mockState.steerQueuedMessage>>) => void;
    const item = queuedMessage({ id: "queue-steer-lock", payload: { body: "Apply this now", attachmentIds: [], projectId: null, skillRefs: [], accessMode: null, model: null, effort: null, metadata: null } });
    mockState.queueSnapshot = queueSnapshot({ items: [item] });
    mockState.steerQueuedMessage.mockReturnValueOnce(new Promise((resolve) => {
      resolveSteer = resolve;
    }));

    const { container } = renderChat();
    await clickEnabledButton(container, "Steer");

    expect(mockState.steerQueuedMessage).toHaveBeenCalledTimes(1);
    expect(container.querySelector("button")?.textContent).not.toContain("Steer");
    const optimisticUpdater = mockState.setQueryData.mock.calls[0]?.[1] as (
      current: ChatQueueSnapshot,
    ) => ChatQueueSnapshot;
    expect(optimisticUpdater(mockState.queueSnapshot).items[0]).toMatchObject({
      status: "steer_pending",
      deliveryDisposition: "pending",
    });

    await act(async () => {
      resolveSteer({
        result: "scheduled_next",
        disposition: "continuation_pending",
        controlActionId: "20000000-0000-4000-8000-000000000002",
        activeGenerationId: null,
        item: queuedMessage({ ...item, status: "continuation_pending", deliveryIntent: "steer", deliveryDisposition: "continuation_pending" }),
        queueVersion: 2,
        transcriptEventId: null,
      });
      await Promise.resolve();
    });
    const durableUpdater = mockState.setQueryData.mock.calls.at(-1)?.[1] as (
      current: ChatQueueSnapshot,
    ) => ChatQueueSnapshot;
    expect(durableUpdater(mockState.queueSnapshot).items[0]).toMatchObject({
      status: "continuation_pending",
      deliveryDisposition: "continuation_pending",
    });
  });

  it("keeps Steer locked and retries a transport-unknown response with the same action id", async () => {
    vi.useFakeTimers();
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    const item = queuedMessage({
      id: "queue-steer-retry",
      payload: {
        body: "Apply this feedback once",
        attachmentIds: [],
        projectId: null,
        skillRefs: [],
        accessMode: null,
        model: null,
        effort: null,
        metadata: null,
      },
    });
    mockState.queueSnapshot = queueSnapshot({ items: [item] });
    mockState.steerQueuedMessage
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementationOnce(async (
        _chatId: string,
        _itemId: string,
        request: { controlActionId: string },
      ) => ({
        result: "scheduled_next",
        disposition: "continuation_pending",
        controlActionId: request.controlActionId,
        activeGenerationId: null,
        item: queuedMessage({
          ...item,
          status: "continuation_pending",
          deliveryIntent: "steer",
          deliveryDisposition: "continuation_pending",
          controlActionId: request.controlActionId,
        }),
        queueVersion: 2,
        transcriptEventId: null,
      }));

    const { container } = renderChat();
    await clickEnabledButton(container, "Steer");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockState.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Feedback confirmation pending",
    }));

    expect(container.textContent).not.toContain("Steer");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(mockState.steerQueuedMessage).toHaveBeenCalledTimes(2);

    const firstRequest = mockState.steerQueuedMessage.mock.calls[0]?.[2];
    const retryRequest = mockState.steerQueuedMessage.mock.calls[1]?.[2];
    expect(retryRequest).toEqual(firstRequest);
    expect(retryRequest?.controlActionId).toEqual(firstRequest?.controlActionId);
    const durableUpdater = mockState.setQueryData.mock.calls.at(-1)?.[1] as (
      current: ChatQueueSnapshot,
    ) => ChatQueueSnapshot;
    expect(durableUpdater(mockState.queueSnapshot).items[0]).toMatchObject({
      status: "continuation_pending",
      deliveryDisposition: "continuation_pending",
      controlActionId: firstRequest?.controlActionId,
    });
  });

  it("reports actionable Steer failure instead of an in-progress success", async () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    const item = queuedMessage({ id: "queue-steer-failed" });
    mockState.queueSnapshot = queueSnapshot({ items: [item] });
    mockState.steerQueuedMessage.mockResolvedValueOnce({
      result: "failed_actionable",
      disposition: "failed_actionable",
      controlActionId: "20000000-0000-4000-8000-000000000002",
      activeGenerationId: null,
      item: queuedMessage({ ...item, status: "failed_actionable", deliveryIntent: "steer", deliveryDisposition: "failed_actionable" }),
      queueVersion: 2,
      transcriptEventId: null,
    });

    const { container } = renderChat();
    await clickEnabledButton(container, "Steer");

    await vi.waitFor(() => expect(mockState.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Feedback needs attention",
      tone: "error",
    })));
  });

  it("renders accepted Steer feedback as delivered instead of still queued", () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: "generation-1",
      activeAttemptEpoch: 1,
      activeControlVersion: 2,
      activeGenerationStatus: "running",
      items: [queuedMessage({
        status: "accepted_current",
        deliveryIntent: "steer",
        deliveryDisposition: "accepted_current",
        lastDeliveryReason: null,
      })],
    });

    const { container } = renderChat();
    const queueItem = container.querySelector("[data-testid='chat-running-queue-item']");

    expect(queueItem?.textContent).toContain("Delivered to current run");
    expect(queueItem?.textContent).not.toContain("Still queued");
  });

  it("offers Steer for retained Queue messages after Stop so feedback resumes server-side", () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: null,
      items: [
        queuedMessage({
          status: "queued",
          lastDeliveryReason: "closing",
          payload: {
            body: "Continue from the interrupted chat run.",
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
    });

    const { container } = renderChat();
    const queueItem = container.querySelector("[data-testid='chat-running-queue-item']");

    const queue = container.querySelector("[data-testid='chat-running-queue']");
    expect(queue?.textContent).toContain("Queue");
    expect(queue?.textContent?.toLowerCase()).not.toContain("follow-up");
    expect(queueItem?.textContent).toContain("Still queued");
    expect(queueItem?.textContent).toContain("Continue from the interrupted chat run.");
    expect(queueItem?.textContent).toContain("Steer");
    expect(queueItem?.querySelector("button[aria-label='Edit queued message']")).not.toBeNull();
    expect(queueItem?.querySelector("button[aria-label='Delete queued message']")).not.toBeNull();
    expect(mockState.steerQueuedMessage).not.toHaveBeenCalled();
  });

  it("hides Queue messages after the queued message is delivered", () => {
    mockState.messagesByChatId = {
      "chat-1": [message({ id: "user-message-1", body: "Please draft a plan." })],
    };
    mockState.queueSnapshot = queueSnapshot({
      activeGenerationId: "generation-2",
      activeAttemptEpoch: 1,
      activeControlVersion: 0,
      activeGenerationStatus: "running",
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
    });

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

  it("keeps Feishu-backed chats send-locked while allowing title actions", async () => {
    mockState.intelligenceProfiles = [
      { id: "profile-lightweight", orgId: "org-1", purpose: "lightweight", status: "configured" },
    ];
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
    expect(document.body.textContent).toContain("Rename");
    expect(document.body.textContent).toContain("Regenerate title");
    expect(document.body.textContent).not.toContain("Open Side Panel");
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
        streamKey: "stream-ask-user",
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

describe("Atomic new-chat drafts", () => {
  it("keeps an unavailable draft unpersisted and links to agent settings", async () => {
    mockState.conversationId = null;
    mockState.conversations = [];
    mockState.messagesByChatId = {};
    mockState.draftPreflight = {
      sourceType: "unconfigured",
      sourceLabel: "Unconfigured chat runtime",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "process",
      model: null,
      available: false,
      error: "The current user has not configured a chat model yet.",
    };

    const { container } = renderChat();
    const editor = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Composer draft']");
    expect(editor).not.toBeNull();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(editor, "This must stay a draft.");
      editor!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("The current user has not configured a chat model yet.");
    expect(container.querySelector<HTMLAnchorElement>('a[href="/agents"]')?.textContent).toContain("Open agents");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')?.disabled).toBe(true);

    await act(async () => {
      editor!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(mockState.preflightDraft).not.toHaveBeenCalled();
    expect(mockState.createConversation).not.toHaveBeenCalled();
    expect(mockState.sendFirstMessageStream).not.toHaveBeenCalled();
    expect(mockState.sendMessageStream).not.toHaveBeenCalled();
    expect(mockState.navigate).not.toHaveBeenCalled();
  });

  it("retains the complete draft when first-turn submission fails before ack", async () => {
    const attachment = new File(["failure context"], "failure-context.txt", { type: "text/plain" });
    mockState.conversationId = null;
    mockState.conversations = [];
    mockState.messagesByChatId = {};
    updateChatPendingAttachmentsForScope(
      resolveChatPendingAttachmentScopeKey("org-1", null),
      () => [attachment],
    );
    mockState.sendFirstMessageStream.mockRejectedValueOnce(
      new ApiError("Runtime rejected the first turn", 503, null),
    );

    const { container } = renderChat();
    await act(async () => {
      await Promise.resolve();
    });

    const projectSelector = container.querySelector<HTMLButtonElement>("[data-testid='chat-project-selector']");
    act(() => projectSelector?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const projectOption = Array.from(document.body.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']"))
      .find((button) => button.textContent?.includes("Rudder mkt"));
    act(() => projectOption?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const optionsButton = container.querySelector<HTMLButtonElement>('button[aria-label="Add files and options"]');
    act(() => optionsButton?.dispatchEvent(new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    })));
    const planModeToggle = document.body.querySelector<HTMLButtonElement>("[data-testid='chat-plan-mode-toggle']");
    expect(planModeToggle).not.toBeNull();
    act(() => planModeToggle?.click());

    const editor = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Composer draft']");
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(editor, "Keep every draft field.");
      editor!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await clickEnabledButtonByAriaLabel(container, "Send");
    await vi.waitFor(() => expect(mockState.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      body: "Runtime rejected the first turn",
      tone: "error",
    })));

    expect(mockState.createConversation).not.toHaveBeenCalled();
    expect(mockState.sendMessageStream).not.toHaveBeenCalled();
    expect(mockState.sendFirstMessageStream).toHaveBeenCalledTimes(1);
    expect(mockState.sendFirstMessageStream.mock.calls[0]?.[0]).toBe("org-1");
    expect(mockState.sendFirstMessageStream.mock.calls[0]?.[1]).toBe("Keep every draft field.");
    expect(mockState.sendFirstMessageStream.mock.calls[0]?.[2]).toMatchObject({
      preferredAgentId: "agent-1",
      planMode: true,
      files: [attachment],
      contextLinks: [
        { entityType: "project", entityId: "10000000-0000-4000-8000-000000000010" },
      ],
    });
    expect(editor?.value).toBe("Keep every draft field.");
    expect(container.textContent).toContain("failure-context.txt");
    expect(container.querySelector("[data-testid='chat-project-selector']")?.textContent).toContain("Rudder mkt");
    expect(mockState.navigate).not.toHaveBeenCalled();
  });

  it("commits the first-turn UI only after the acknowledgement", async () => {
    mockState.conversationId = null;
    mockState.conversations = [];
    mockState.messagesByChatId = {};
    let onEvent!: (event: ChatStreamEvent) => void | Promise<void>;
    let resolveStream!: () => void;
    mockState.sendFirstMessageStream.mockImplementationOnce((
      _orgId: string,
      _body: string,
      options: { onEvent: (event: ChatStreamEvent) => void | Promise<void> },
    ) => {
      onEvent = options.onEvent;
      return new Promise<void>((resolve) => {
        resolveStream = resolve;
      });
    });

    const { container } = renderChat();
    const editor = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Composer draft']");
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      valueSetter?.call(editor, "Create exactly one accepted chat.");
      editor!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await clickEnabledButtonByAriaLabel(container, "Send");
    await vi.waitFor(() => expect(mockState.sendFirstMessageStream).toHaveBeenCalledTimes(1));

    expect(mockState.createConversation).not.toHaveBeenCalled();
    expect(mockState.sendMessageStream).not.toHaveBeenCalled();
    expect(mockState.navigate).not.toHaveBeenCalled();
    expect(editor?.value).toBe("Create exactly one accepted chat.");

    const acceptedConversation = chat({
      id: "atomic-chat-1",
      title: "Create exactly one accepted chat",
      preferredAgentId: "agent-1",
      lastMessageAt: new Date("2026-05-12T10:00:00.000Z"),
    });
    const acceptedMessage = message({
      id: "atomic-message-1",
      conversationId: acceptedConversation.id,
      body: "Create exactly one accepted chat.",
      chatTurnId: "atomic-turn-1",
      createdAt: new Date("2026-05-12T10:00:00.000Z"),
    });
    await act(async () => {
      await onEvent({
        type: "ack",
        conversation: acceptedConversation,
        userMessage: acceptedMessage,
        generationId: "atomic-generation-1",
        attemptEpoch: 1,
        generationSeq: 0,
      });
    });

    expect(editor?.value).toBe("");
    expect(mockState.navigate).toHaveBeenCalledWith("/chat/atomic-chat-1");
    expect(mockState.setQueryData).toHaveBeenCalledWith(
      expect.arrayContaining(["chats", "org-1", "detail", "atomic-chat-1"]),
      expect.objectContaining({ id: "atomic-chat-1" }),
    );
    expect(mockState.setStreamDraftForChat).toHaveBeenCalledWith(
      "atomic-chat-1",
      expect.objectContaining({
        userBody: "Create exactly one accepted chat.",
        userMessageId: "atomic-message-1",
        generationId: "atomic-generation-1",
        state: "streaming",
      }),
    );

    await act(async () => {
      resolveStream();
      await Promise.resolve();
    });
  });
});

describe("Chat project context selector", () => {
  it("keeps the selected project icon in place and clears the draft project without opening the menu", () => {
    mockState.conversationId = null;
    mockState.conversations = [];
    mockState.messagesByChatId = {};

    const { container } = renderChat();
    const projectSelector = container.querySelector<HTMLButtonElement>("[data-testid='chat-project-selector']");

    expect(projectSelector).not.toBeNull();
    expect(projectSelector?.querySelector("[data-testid='chat-project-icon']")).toBeNull();
    expect(container.querySelector("[data-testid='chat-agent-selector-chevron']")).toBeNull();

    act(() => {
      projectSelector?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const projectMenuItem = Array.from(document.body.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']"))
      .find((button) => button.textContent?.includes("Rudder mkt"));
    expect(projectMenuItem).not.toBeUndefined();

    act(() => {
      projectMenuItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const clearProject = container.querySelector<HTMLButtonElement>("[data-testid='chat-project-clear']");
    expect(projectSelector?.textContent).toContain("Rudder mkt");
    expect(projectSelector?.querySelector("[data-testid='chat-project-icon'] svg")).not.toBeNull();
    expect(clearProject?.getAttribute("aria-label")).toBe("Clear project context: Rudder mkt");

    act(() => {
      clearProject?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(projectSelector?.textContent).toContain("No project");
    expect(projectSelector?.querySelector("[data-testid='chat-project-icon']")).toBeNull();
    expect(container.querySelector("[data-testid='chat-project-clear']")).toBeNull();
    expect(document.body.querySelector("[data-testid='chat-project-menu']")).toBeNull();
  });

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
    expect(projectSelector?.querySelector("[data-testid='chat-project-icon'] svg")).not.toBeNull();
    expect(container.querySelector("[data-testid='chat-project-clear']")).toBeNull();
    expect(container.querySelector("[data-testid='chat-project-selector-chevron']")).toBeNull();

    act(() => {
      projectSelector?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.querySelector("[data-testid='chat-project-menu']")).toBeNull();
    expect(projectSelector?.textContent).toContain("Rudder mkt");
    expect(mockState.mutations).toEqual([]);
  });
});
