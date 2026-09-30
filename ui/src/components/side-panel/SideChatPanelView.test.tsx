// @vitest-environment jsdom

import { agentRunsApi } from "@/api/agent-runs";
import { agentsApi } from "@/api/agents";
import { approvalsApi } from "@/api/approvals";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import { organizationSkillsApi } from "@/api/organizationSkills";
import { organizationsApi } from "@/api/orgs";
import { ToastViewport } from "@/components/ToastViewport";
import {
  ChatGenerationCloseSupersededError,
  ChatGenerationProvider,
  useChatGenerationActions,
  useChatGenerations,
  type ChatStreamDraft as ChatGenerationStreamDraft,
} from "@/context/ChatGenerationContext";
import { SidePanelProvider, useSidePanel } from "@/context/SidePanelContext";
import { ToastProvider } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { readSideChatSendDraft, saveSideChatSendDraft } from "@/lib/side-chat-draft-storage";
import {
  sideChatGenerationScopeKey,
  sidePanelTargetKey,
  type SidePanelTarget,
} from "@/lib/side-panel-targets";
import type {
  Agent,
  ChatAskUserResponse,
  ChatConversation,
  ChatInlineAnnotationInput,
  ChatMessage,
  ChatStreamEvent,
} from "@rudderhq/shared";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SideChatPanelView } from "./SideChatPanelView";

vi.mock("@/api/agent-runs", () => ({
  agentRunsApi: { transcript: vi.fn() },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: vi.fn(),
    adapterModels: vi.fn(),
    skills: vi.fn(),
  },
}));

vi.mock("@/api/approvals", () => ({
  approvalsApi: {
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: vi.fn(),
  },
}));

vi.mock("@/api/organizationSkills", () => ({
  organizationSkillsApi: { list: vi.fn() },
}));

vi.mock("@/api/orgs", () => ({
  organizationsApi: { get: vi.fn() },
}));

vi.mock("@/api/chats", () => ({
  chatsApi: {
    get: vi.fn(),
    listMessages: vi.fn(),
    listQueue: vi.fn(),
    createSideChat: vi.fn(),
    destroySideChat: vi.fn(async () => undefined),
    stopMessageStream: vi.fn(),
    sendMessageStream: vi.fn(),
    resolveOperationProposal: vi.fn(),
    convertToIssue: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/components/AgentIconPicker", () => ({
  AgentIcon: () => <span>Agent</span>,
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <span>{children}</span>,
}));

vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
  }) => (
    <textarea
      aria-label="Side Chat draft"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("@/pages/Chat.attachments", () => ({
  ChatFileAttachmentChip: ({ name }: { name: string }) => <span>{name}</span>,
  ChatImageAttachmentTile: ({ name }: { name: string }) => <span>{name}</span>,
  PendingAttachmentPreview: ({ file }: { file: File }) => <span>{file.name}</span>,
}));

vi.mock("@/pages/Chat.messages", () => ({
  OptimisticUserDraftItem: ({ body }: { body: string }) => (
    <div data-testid="optimistic-user-message">{body}</div>
  ),
  AskUserPanel: ({
    onStructuredSubmit,
  }: {
    onStructuredSubmit?: (response: ChatAskUserResponse) => void;
  }) => (
    <button
      type="button"
      data-testid="side-chat-ask-user-submit"
      onClick={() => onStructuredSubmit?.({
        answers: [{ questionId: "scope", optionIds: ["narrow"] }],
      })}
    >
      Submit typed answer
    </button>
  ),
  ChatMessageItem: ({
    message,
    streamedAssistantBody,
    draftPresentation = false,
    draftState,
    actionPending,
    onApprovalAction,
    onConvertToIssue,
    onResolveOperationProposal,
    onSelectResponseAnnotation,
    onOpenFile,
    skillReferences,
  }: {
    message: ChatMessage;
    streamedAssistantBody?: string;
    draftPresentation?: boolean;
    draftState?: ChatGenerationStreamDraft["state"];
    actionPending?: boolean;
    onApprovalAction?: (approvalId: string, action: "approve" | "reject" | "requestRevision", messageId: string) => void;
    onConvertToIssue?: (message: ChatMessage) => void;
    onResolveOperationProposal?: (messageId: string, action: "approve" | "reject" | "requestRevision", decisionNote: string) => void;
    onSelectResponseAnnotation?: (
      annotation: ChatInlineAnnotationInput & { attachmentIds: string[] },
      ordinal: number,
    ) => void;
    onOpenFile?: (targetPath: string) => void;
    skillReferences?: Array<{ label?: string | null; displayName?: string | null }>;
  }) => {
    const assistantBody = streamedAssistantBody ?? message.body;
    const liveDraft = draftState === "streaming"
      || draftState === "tool_busy"
      || draftState === "finalizing";
    if (
      draftPresentation
      && !assistantBody.trim()
      && !liveDraft
      && draftState !== "waiting_for_network"
    ) return null;
    const inlineAnnotations = (
      message.structuredPayload?.inlineAnnotations ?? []
    ) as Array<ChatInlineAnnotationInput & { attachmentIds: string[] }>;
    return (
      <div
        data-testid={draftPresentation ? "side-chat-assistant-draft" : undefined}
        data-stream-state={draftPresentation ? draftState : undefined}
      >
        {assistantBody.trim()
          ? assistantBody
          : draftPresentation && draftState !== "waiting_for_network" ? "Thinking" : null}
        {skillReferences?.map((reference, index) => (
          <span key={`${reference.label ?? "skill"}-${index}`} data-testid="side-chat-skill-reference">
            {reference.displayName ?? reference.label}
          </span>
        ))}
        <button
          type="button"
          data-testid="side-chat-open-file"
          onClick={() => onOpenFile?.("/tmp/side-chat-evidence.md")}
        >
          Open file
        </button>
        {inlineAnnotations.map((candidate, index) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => onSelectResponseAnnotation?.(candidate, index + 1)}
          >
            Show source {index + 1}
          </button>
        ))}
        {message.approval ? (
          <button
            type="button"
            data-testid="side-chat-approval-action"
            disabled={actionPending}
            onClick={() => onApprovalAction?.(message.approval!.id, "approve", message.id)}
          >
            Approve
          </button>
        ) : null}
        {message.kind === "operation_proposal" ? (
          <button
            type="button"
            data-testid="side-chat-operation-action"
            disabled={actionPending}
            onClick={() => onResolveOperationProposal?.(message.id, "approve", "")}
          >
            Approve operation
          </button>
        ) : null}
        {message.kind === "issue_proposal" ? (
          <button
            type="button"
            data-testid="side-chat-convert-action"
            disabled={actionPending}
            onClick={() => onConvertToIssue?.(message)}
          >
            Create issue
          </button>
        ) : null}
      </div>
    );
  },
  StreamTranscriptItem: () => <div data-testid="side-chat-process">Process</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const sourceConversation = {
  id: "10000000-0000-4000-8000-000000000001",
  orgId: "50000000-0000-4000-8000-000000000001",
  contextLinks: [],
  preferredAgentId: "40000000-0000-4000-8000-000000000001",
  planMode: false,
  routedAgentId: null,
  chatRuntime: null,
} as unknown as ChatConversation;

const defaultAgent = {
  id: "40000000-0000-4000-8000-000000000001",
  orgId: sourceConversation.orgId,
  name: "Rudder Agent",
  urlKey: "rudder-agent",
  status: "idle",
  agentRuntimeType: "codex_local",
  agentRuntimeConfig: {},
  runtimeConfig: {},
} as unknown as Agent;

const sideConversation = {
  ...sourceConversation,
  id: "60000000-0000-4000-8000-000000000001",
  conversationKind: "side_chat",
  sideChatState: "active",
  sideChatExpiresAt: new Date(Date.now() + 60_000),
  planMode: false,
} as unknown as ChatConversation;

const annotation: ChatInlineAnnotationInput = {
  id: "30000000-0000-4000-8000-000000000001",
  selectedText: "Only failed deliveries show Retry.",
  comment: null,
  sourceConversationId: sourceConversation.id,
  sourceMessageId: "20000000-0000-4000-8000-000000000001",
  surface: "assistant_body",
  sourceHash: "a".repeat(64),
  start: 20,
  end: 54,
  prefix: "successful. ",
  suffix: " Continue.",
};

const target: Extract<SidePanelTarget, { kind: "side_chat" }> = {
  kind: "side_chat",
  sourceConversationId: sourceConversation.id,
  sourceMessageId: annotation.sourceMessageId,
  sourcePreview: annotation.selectedText,
  inlineAnnotations: [annotation],
  conversationId: null,
  clientMutationId: "side-chat-annotation-draft",
  label: "Side Chat",
};

function streamDraft(overrides: Partial<ChatGenerationStreamDraft> = {}): ChatGenerationStreamDraft {
  const createdAt = new Date("2026-05-06T10:00:00.000Z");
  return {
    chatId: sideConversation.id,
    streamKey: "stream-1",
    userBody: "hello",
    userCreatedAt: createdAt,
    userMessageId: null,
    chatTurnId: null,
    turnVariant: 0,
    editedFromCreatedAt: null,
    body: "partial",
    state: "streaming",
    createdAt,
    transcript: [],
    replyingAgentId: null,
    ...overrides,
  };
}

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;
let onReplaceTarget: ReturnType<typeof vi.fn>;
let latestGenerationActions: ReturnType<typeof useChatGenerationActions> | null = null;
let latestGenerations: ReturnType<typeof useChatGenerations> | null = null;
let latestSidePanel: ReturnType<typeof useSidePanel> | null = null;

function GenerationProbe() {
  latestGenerationActions = useChatGenerationActions();
  latestGenerations = useChatGenerations();
  return null;
}

function SidePanelProbe() {
  latestSidePanel = useSidePanel();
  return null;
}

class ResizeObserverMock {
  observe() {}

  unobserve() {}

  disconnect() {}
}

beforeAll(() => {
  notifyManager.setNotifyFunction((callback) => act(callback));
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  notifyManager.setNotifyFunction((callback) => callback());
});

beforeEach(() => {
  localStorage.removeItem("rudder:chat-send-mutations:v1");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(queryKeys.auth.session, {
    session: { id: "session-1", userId: "user-1" },
    user: { id: "user-1", email: "same@example.com", name: "Same User" },
  });
  onReplaceTarget = vi.fn();
  latestGenerationActions = null;
  latestGenerations = null;
  latestSidePanel = null;
  vi.mocked(agentRunsApi.transcript).mockReset().mockResolvedValue({
    entries: [], page: { cursor: null, hasMore: false, nextCursor: null, order: "oldest" },
  } as never);
  vi.mocked(agentsApi.list).mockReset().mockResolvedValue([defaultAgent]);
  vi.mocked(agentsApi.adapterModels).mockReset().mockResolvedValue([]);
  vi.mocked(agentsApi.skills).mockReset().mockResolvedValue({
    agentRuntimeType: "codex_local",
    supported: true,
    mode: "persistent",
    desiredSkills: ["agent:research-skill"],
    entries: [{
      key: "research-skill",
      selectionKey: "agent:research-skill",
      runtimeName: "research-skill",
      desired: true,
      configurable: true,
      alwaysEnabled: false,
      managed: true,
      state: "configured",
      sourceClass: "agent_home",
      sourcePath: "/tmp/skills/research-skill",
      description: "Researches a focused question.",
    }],
    warnings: [],
  });
  vi.mocked(organizationSkillsApi.list).mockReset().mockResolvedValue([]);
  vi.mocked(organizationsApi.get).mockReset().mockResolvedValue({
    id: sourceConversation.orgId,
    urlKey: "rudder",
  } as Awaited<ReturnType<typeof organizationsApi.get>>);
  vi.mocked(chatsApi.get).mockReset().mockResolvedValue(sourceConversation);
  vi.mocked(chatsApi.listMessages).mockReset().mockResolvedValue([]);
  vi.mocked(chatsApi.listQueue).mockReset().mockResolvedValue({
    activeGenerationId: null,
    activeAttemptEpoch: null,
    activeControlVersion: null,
    activeGenerationStatus: null,
    items: [],
  });
  vi.mocked(chatsApi.createSideChat).mockReset().mockResolvedValue(sideConversation);
  vi.mocked(chatsApi.destroySideChat).mockReset().mockResolvedValue({ id: sideConversation.id });
  vi.mocked(chatsApi.stopMessageStream).mockReset().mockResolvedValue({
    stopped: true,
    controlActionId: "side-chat-stop-default",
    generationId: null,
    disposition: "stopped",
  });
  vi.mocked(chatsApi.resolveOperationProposal).mockReset().mockResolvedValue({} as never);
  vi.mocked(chatsApi.convertToIssue).mockReset().mockResolvedValue({} as never);
  vi.mocked(chatsApi.update).mockReset().mockResolvedValue({
    ...sideConversation,
    planMode: false,
  });
  vi.mocked(approvalsApi.approve).mockReset().mockResolvedValue({} as never);
  vi.mocked(approvalsApi.reject).mockReset().mockResolvedValue({} as never);
  vi.mocked(approvalsApi.requestRevision).mockReset().mockResolvedValue({} as never);
  vi.mocked(chatsApi.sendMessageStream).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  window.localStorage.removeItem("rudder:side-chat-send-drafts:v1");
  latestGenerationActions = null;
  latestGenerations = null;
  latestSidePanel = null;
  host.remove();
});

async function waitForStreamingAssistantDraft() {
  await vi.waitFor(() => {
    const assistantDraft = host.querySelector<HTMLElement>(
      '[data-testid="side-chat-assistant-draft"]',
    );
    expect(assistantDraft).not.toBeNull();
    expect(assistantDraft?.getAttribute("data-stream-state")).toBe("streaming");
  });
}

async function renderView({
  viewTarget = target,
  onSelectResponseAnnotation = vi.fn(),
  onRegisterCloseHandler = vi.fn(),
  waitForAgent = true,
}: {
  viewTarget?: Extract<SidePanelTarget, { kind: "side_chat" }>;
  onSelectResponseAnnotation?: ReturnType<typeof vi.fn>;
  onRegisterCloseHandler?: (
    clientMutationId: string,
    handler: (() => Promise<string | null>) | null,
  ) => void;
  waitForAgent?: boolean;
} = {}) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SidePanelProvider>
          <ChatGenerationProvider>
            <ToastProvider>
              <SidePanelProbe />
              <SideChatPanelView
                organizationId={sourceConversation.orgId}
                target={viewTarget}
                onRegisterCloseHandler={onRegisterCloseHandler}
                onReplaceTarget={onReplaceTarget}
                onSelectResponseAnnotation={onSelectResponseAnnotation}
              />
              <ToastViewport />
            </ToastProvider>
          </ChatGenerationProvider>
        </SidePanelProvider>
      </QueryClientProvider>,
    );
  });
  if (waitForAgent) {
    await vi.waitFor(() => expect(host.textContent).toContain("Rudder Agent"));
  }
}

function clickButton(label: string) {
  const button = Array.from(host.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  expect(button).toBeDefined();
  act(() => button?.click());
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function dispatchSideChatPaste(target: Element, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: {
      files,
      items: files.map((file) => ({
        kind: "file",
        getAsFile: () => file,
      })),
    },
  });
  target.dispatchEvent(event);
}

function dispatchSideChatDrag(target: Element, type: string, files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    configurable: true,
    value: {
      files,
      items: files.map(() => ({ kind: "file" })),
      types: ["Files"],
      dropEffect: "none",
    },
  });
  target.dispatchEvent(event);
}

describe("SideChatPanelView composer controls", () => {
  it.each([
    { parentContinuity: "native", sideContinuity: "context_handoff", visible: true },
    { parentContinuity: "context_handoff", sideContinuity: "native", visible: false },
    { parentContinuity: "context_handoff", sideContinuity: "legacy", visible: false },
  ] as const)("shows the context handoff marker only for the Side Chat binding", async ({
    parentContinuity,
    sideContinuity,
    visible,
  }) => {
    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id
        ? { ...sideConversation, runtimeContinuity: sideContinuity }
        : { ...sourceConversation, runtimeContinuity: parentContinuity }
    ));
    await renderView({ viewTarget: { ...target, conversationId: sideConversation.id } });

    const marker = host.querySelector('[data-testid="side-chat-context-handoff"]');
    if (visible) {
      expect(marker?.textContent).toContain("handed off from the source conversation");
      expect(marker?.textContent).toContain("continues independently");
    } else {
      expect(marker).toBeNull();
    }
  });

  it("pages a Run transcript and exposes an unavailable continuation", async () => {
    vi.mocked(chatsApi.get).mockResolvedValue(sideConversation);
    vi.mocked(chatsApi.listMessages).mockResolvedValue([{
      id: "assistant-paged", conversationId: sideConversation.id, role: "assistant",
      kind: "text", status: "completed", body: "Answer", runId: "run-paged",
      createdAt: new Date(), updatedAt: new Date(),
    } as unknown as ChatMessage]);
    vi.mocked(agentRunsApi.transcript)
      .mockResolvedValueOnce({
        entries: [], availability: "available", completeness: "partial", revision: "rev-1",
        page: { cursor: null, hasMore: true, nextCursor: "page-2", order: "oldest" },
      } as never)
      .mockResolvedValueOnce({
        entries: [], availability: "offline", completeness: "partial", revision: "rev-1",
        page: { cursor: "page-2", hasMore: false, nextCursor: null, order: "oldest" },
      } as never);
    await renderView({ viewTarget: { ...target, conversationId: sideConversation.id } });
    await vi.waitFor(() => expect(host.textContent).toContain("Partial transcript"));
    clickButton("Next");
    await vi.waitFor(() => expect(host.textContent).toContain("Transcript offline."));
    expect(vi.mocked(agentRunsApi.transcript).mock.calls.at(-1)?.[1]).toMatchObject({ cursor: "page-2" });
    expect(host.querySelector('[aria-label="Previous transcript page"]')).not.toBeNull();
  });

  it("omits the project chip while keeping the agent and skills controls", async () => {
    await renderView();

    expect(host.querySelector('[data-testid="side-chat-project-chip"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-agent-selector"]')).not.toBeNull();
    expect(host.textContent).toContain("Skills");
  });

  it("does not render a previous principal's in-memory or persisted draft after an account switch", async () => {
    saveSideChatSendDraft("user-1", sourceConversation.orgId, sourceConversation.id, target.clientMutationId, {
      body: "Private draft for the first account.",
      acceptedUserMessageId: null,
    });
    await renderView({ viewTarget: { ...target, inlineAnnotations: [] } });

    const initialDraft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    );
    expect(initialDraft?.value).toBe("Private draft for the first account.");

    act(() => queryClient.setQueryData(queryKeys.auth.session, {
      session: { id: "session-2", userId: "user-2" },
      user: { id: "user-2", email: "same@example.com", name: "Same User" },
    }));

    await vi.waitFor(() => expect(host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )?.value).toBe(""));
    expect(readSideChatSendDraft("user-1", sourceConversation.orgId, sourceConversation.id, target.clientMutationId)).toEqual({
      body: "Private draft for the first account.",
      acceptedUserMessageId: null,
    });
    expect(readSideChatSendDraft("user-2", sourceConversation.orgId, sourceConversation.id, target.clientMutationId)).toBeNull();
  });

  it("fences a pending first send on principal change and admits the new principal independently", async () => {
    let resolveFirstCreate!: (conversation: ChatConversation) => void;
    const firstCreatePending = new Promise<ChatConversation>((resolve) => {
      resolveFirstCreate = resolve;
    });
    vi.mocked(chatsApi.createSideChat)
      .mockImplementationOnce(() => firstCreatePending)
      .mockResolvedValueOnce(sideConversation);
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      _conversationId,
      _body,
      options,
    ) => {
      await options.onEvent({ type: "final", messages: [] } as ChatStreamEvent);
    });
    await renderView({ viewTarget: { ...target, inlineAnnotations: [] } });

    changeTextarea(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Side Chat draft"]')!,
      "Principal A's first prompt.",
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Send Side Chat message"]')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(chatsApi.createSideChat).toHaveBeenCalledOnce());

    await act(async () => {
      queryClient.setQueryData(queryKeys.auth.session, {
        session: { id: "session-2", userId: "user-2" },
        user: { id: "user-2", email: "same@example.com", name: "Same User" },
      });
      resolveFirstCreate(sideConversation);
      await Promise.resolve();
      await vi.waitFor(() => expect(latestSidePanel?.principalId).toBe("user-2"));
    });
    expect(host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )?.value).toBe("");

    expect(chatsApi.createSideChat).toHaveBeenCalledOnce();
    expect(chatsApi.update).not.toHaveBeenCalled();
    expect(chatsApi.sendMessageStream).not.toHaveBeenCalled();
    expect(onReplaceTarget).not.toHaveBeenCalled();

    changeTextarea(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Side Chat draft"]')!,
      "Principal B's independent prompt.",
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Send Side Chat message"]')?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(chatsApi.sendMessageStream).toHaveBeenCalledOnce());
    expect(chatsApi.createSideChat).toHaveBeenCalledTimes(2);
    expect(chatsApi.sendMessageStream).toHaveBeenCalledWith(
      sideConversation.id,
      "Principal B's independent prompt.",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(onReplaceTarget).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ conversationId: sideConversation.id }),
    );
  });

  it("deletes an unsent draft only after the provisional Side Chat close succeeds", async () => {
    const closeHandlers = new Map<string, () => Promise<string | null>>();
    await renderView({
      viewTarget: { ...target, inlineAnnotations: [] },
      onRegisterCloseHandler: (_clientMutationId, handler) => {
        if (handler) closeHandlers.set(_clientMutationId, handler);
        else closeHandlers.delete(_clientMutationId);
      },
    });

    changeTextarea(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Side Chat draft"]')!,
      "Discard this unsent Side Chat prompt.",
    );
    await vi.waitFor(() => expect(readSideChatSendDraft(
      "user-1",
      sourceConversation.orgId,
      sourceConversation.id,
      target.clientMutationId,
    )?.body).toBe("Discard this unsent Side Chat prompt."));
    expect(chatsApi.destroySideChat).not.toHaveBeenCalled();

    const closeScopeKey = sideChatGenerationScopeKey(sourceConversation.orgId, target);
    await vi.waitFor(() => expect(closeHandlers.get(closeScopeKey)).toBeDefined());
    const close = closeHandlers.get(closeScopeKey);
    expect(close).toBeDefined();
    await act(async () => {
      await close?.();
    });

    expect(readSideChatSendDraft("user-1", sourceConversation.orgId, sourceConversation.id, target.clientMutationId)).toBeNull();
    expect(window.localStorage.getItem("rudder:side-chat-send-drafts:v1")).toBeNull();
  });

  it("keeps Plan Mode draft-only until first send, then persists it before generation", async () => {
    const callOrder: string[] = [];
    vi.mocked(chatsApi.update).mockImplementation(async () => {
      callOrder.push("update");
      return {
      ...sideConversation,
      planMode: true,
      };
    });
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      _conversationId,
      _body,
      options,
    ) => {
      callOrder.push("send");
      await options.onEvent({ type: "final", messages: [] });
    });
    await renderView({ viewTarget: { ...target, inlineAnnotations: [] } });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Add files and options"]')?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(
      document.body.querySelector('[data-testid="chat-plan-mode-toggle"]'),
    ).not.toBeNull());
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-testid="chat-plan-mode-toggle"]')?.click();
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Turn off plan mode"]')).not.toBeNull();
    expect(chatsApi.createSideChat).not.toHaveBeenCalled();
    expect(chatsApi.update).not.toHaveBeenCalled();

    changeTextarea(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Side Chat draft"]')!,
      "Plan the investigation",
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Send Side Chat message"]')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(chatsApi.sendMessageStream).toHaveBeenCalled());

    expect(chatsApi.update).toHaveBeenCalledWith(sideConversation.id, { planMode: true });
    expect(callOrder).toEqual(["update", "send"]);
  });

  it("refreshes the parent Side Chat history when the first send creates a Side Chat", async () => {
    const historyKey = queryKeys.chats.sideChats(
      sourceConversation.orgId,
      sourceConversation.id,
      "user-1",
    );
    queryClient.setQueryData(historyKey, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    });
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      _conversationId,
      _body,
      options,
    ) => {
      await options.onEvent({ type: "final", messages: [] });
    });
    await renderView({ viewTarget: { ...target, inlineAnnotations: [] } });

    changeTextarea(
      host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Side Chat draft"]')!,
      "Start this Side Chat.",
    );
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Send Side Chat message"]')?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(chatsApi.createSideChat).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBe(true));
  });

  it("reuses normal composer paste and drop attachment interactions", async () => {
    await renderView();
    const editorScroll = host.querySelector(
      '[data-testid="side-chat-composer-editor-scroll"]',
    );
    const dropTarget = host.querySelector(
      '[data-testid="side-chat-composer-file-drop-target"]',
    );
    expect(editorScroll).not.toBeNull();
    expect(dropTarget).not.toBeNull();

    await act(async () => {
      dispatchSideChatPaste(
        editorScroll!,
        [new File(["paste"], "pasted.txt", { type: "text/plain" })],
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain("pasted.txt"));

    act(() => {
      dispatchSideChatDrag(
        dropTarget!,
        "dragenter",
        [new File(["drop"], "dropped.txt", { type: "text/plain" })],
      );
    });
    expect(host.querySelector('[data-testid="chat-composer-file-drop-overlay"]'))
      .not.toBeNull();

    await act(async () => {
      dispatchSideChatDrag(
        dropTarget!,
        "drop",
        [new File(["drop"], "dropped.txt", { type: "text/plain" })],
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain("dropped.txt"));
    expect(host.querySelector('[data-testid="chat-composer-file-drop-overlay"]'))
      .toBeNull();
  });

  it("routes native AskUserQuestion answers through the approval payload without starting a Side Chat run", async () => {
    const askUserMessage = {
      id: "side-ask-user-1",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "assistant",
      kind: "ask_user",
      status: "completed",
      body: "Choose a rollout path.",
      structuredPayload: {
        requestUserInput: {
          questions: [{
            id: "scope",
            header: "Scope",
            question: "Which scope should the agent implement?",
            options: [
              { id: "narrow", label: "Narrow path" },
              { id: "broad", label: "Broad path" },
            ],
          }],
        },
      },
      approvalId: "side-approval-1",
      approval: { id: "side-approval-1" },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.listMessages).mockImplementation(async (_organizationId, conversationId) => (
      conversationId === sideConversation.id ? [askUserMessage] : []
    ));

    await renderView({
      waitForAgent: false,
      viewTarget: {
        ...target,
        conversationId: sideConversation.id,
        inlineAnnotations: [],
      },
    });
    await vi.waitFor(() => expect(host.querySelector(
      '[data-testid="side-chat-ask-user-submit"]',
    )).not.toBeNull());

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[data-testid="side-chat-ask-user-submit"]',
      )?.click();
      await Promise.resolve();
    });

    expect(approvalsApi.approve).toHaveBeenCalledWith(
      "side-approval-1",
      undefined,
      { inputResponse: { answers: [{ questionId: "scope", optionIds: ["narrow"] }] } },
    );
    expect(chatsApi.sendMessageStream).not.toHaveBeenCalled();
  });
});

describe("SideChatPanelView streaming reconciliation", () => {
  it("keeps the active stream when the Side Chat view is unmounted and mounted again", async () => {
    const generationId = "80000000-0000-4000-8000-000000000020";
    const userMessage = {
      id: "70000000-0000-4000-8000-000000000020",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Keep streaming while I change pages.",
      chatTurnId: "90000000-0000-4000-8000-000000000020",
      turnVariant: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    let releaseStream!: () => void;
    const streamPending = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      conversationId,
      body,
      options,
    ) => {
      await options.onEvent({
        type: "ack",
        userMessage: { ...userMessage, conversationId, body },
        generationId,
      });
      await options.onEvent({
        type: "assistant_delta",
        delta: "The answer is still streaming.",
        generationId,
      });
      await streamPending;
      await options.onEvent({ type: "final", messages: [] });
    });

    const viewTarget = {
      ...target,
      conversationId: sideConversation.id,
      inlineAnnotations: [],
    };
    const renderProvidedView = (showView: boolean) => {
      act(() => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <ChatGenerationProvider>
              <ToastProvider>
                {showView ? (
                  <SideChatPanelView
                    organizationId={sourceConversation.orgId}
                    target={viewTarget}
                    onRegisterCloseHandler={vi.fn()}
                    onReplaceTarget={onReplaceTarget}
                    onSelectResponseAnnotation={vi.fn()}
                  />
                ) : null}
              </ToastProvider>
            </ChatGenerationProvider>
          </QueryClientProvider>,
        );
      });
    };

    renderProvidedView(true);
    await vi.waitFor(() => expect(host.textContent).toContain("Rudder Agent"));
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, userMessage.body);
    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });
    await waitForStreamingAssistantDraft();

    renderProvidedView(false);
    expect(host.querySelector('[data-testid="side-chat-process"]')).toBeNull();

    renderProvidedView(true);
    await vi.waitFor(() => expect(host.querySelector(
      '[data-testid="side-chat-process"]',
    )).not.toBeNull());

    await act(async () => {
      releaseStream();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(host.querySelector('[aria-label="Sending Side Chat message"]')).toBeNull();
  });

  it("deduplicates a rapid send and retries an acknowledged turn by editing its user message", async () => {
    const generationId = "80000000-0000-4000-8000-000000000022";
    const userMessage = {
      id: "70000000-0000-4000-8000-000000000022",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Retry the same Side Chat turn.",
      chatTurnId: "90000000-0000-4000-8000-000000000022",
      turnVariant: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    const assistantMessage = {
      id: "70000000-0000-4000-8000-000000000023",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "The retried answer.",
      generationId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    const sendOptions: Array<{ editUserMessageId?: string | null }> = [];
    let retried = false;
    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.listMessages).mockImplementation(async () => (
      retried ? [userMessage, assistantMessage] : []
    ));
    vi.mocked(chatsApi.sendMessageStream).mockImplementation(async (
      conversationId,
      body,
      options,
    ) => {
      sendOptions.push(options);
      await options.onEvent({
        type: "ack",
        userMessage: { ...userMessage, conversationId, body },
        generationId,
      });
      if (sendOptions.length === 1) throw new Error("first stream failed after ack");
      retried = true;
      await options.onEvent({ type: "final", messages: [assistantMessage] });
    });

    const viewTarget = {
      ...target,
      conversationId: sideConversation.id,
      inlineAnnotations: [],
    };
    await renderView({ viewTarget });
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, userMessage.body);
    await act(async () => {
      const sendButton = host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )!;
      sendButton.click();
      sendButton.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(sendOptions).toHaveLength(1));
    await vi.waitFor(() => expect(host.textContent).toContain("Something went wrong. Try again."));
    expect(chatsApi.sendMessageStream).toHaveBeenCalledOnce();

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(sendOptions).toHaveLength(2));
    expect(sendOptions[1]?.editUserMessageId).toBe(userMessage.id);
    await vi.waitFor(() => expect(host.textContent).toContain("The retried answer."));
    expect(chatsApi.sendMessageStream).toHaveBeenCalledTimes(2);
  });

  it("persists a pending send id for the same payload and rotates it when the payload changes", async () => {
    const sendOptions: Array<{ clientMutationId?: string }> = [];
    let attempt = 0;
    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.sendMessageStream).mockImplementation(async (
      _conversationId,
      _body,
      options,
    ) => {
      sendOptions.push(options);
      attempt += 1;
      throw new Error(`network-${attempt}`);
    });

    await renderView({
      viewTarget: {
        ...target,
        conversationId: sideConversation.id,
        inlineAnnotations: [],
      },
    });
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, "Retry this exact payload.");

    const send = async () => {
      await act(async () => {
        host.querySelector<HTMLButtonElement>(
          '[aria-label="Send Side Chat message"]',
        )?.click();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    };

    await send();
    await send();
    expect(sendOptions[0]?.clientMutationId).toEqual(expect.any(String));
    expect(sendOptions[1]?.clientMutationId).toBe(sendOptions[0]?.clientMutationId);

    changeTextarea(draft, "Retry with a changed payload.");
    await send();
    expect(sendOptions[2]?.clientMutationId).toEqual(expect.any(String));
    expect(sendOptions[2]?.clientMutationId).not.toBe(sendOptions[0]?.clientMutationId);
  });

  it("destroys a provisional Side Chat created after an unmount/remount close", async () => {
    let resolveCreate!: (conversation: ChatConversation) => void;
    const createPending = new Promise<ChatConversation>((resolve) => {
      resolveCreate = resolve;
    });
    vi.mocked(chatsApi.createSideChat).mockImplementationOnce(() => createPending);
    const closeHandlers = new Map<string, (() => Promise<string | null>)>();
    const registerCloseHandler = vi.fn((clientMutationId: string, handler: (() => Promise<string | null>) | null) => {
      if (handler) closeHandlers.set(clientMutationId, handler);
      else closeHandlers.delete(clientMutationId);
    });
    const viewTarget = {
      ...target,
      inlineAnnotations: [],
    };
    const renderProvidedView = (showView: boolean) => {
      act(() => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <ChatGenerationProvider>
              <ToastProvider>
                {showView ? (
                  <SideChatPanelView
                    organizationId={sourceConversation.orgId}
                    target={viewTarget}
                    onRegisterCloseHandler={registerCloseHandler}
                    onReplaceTarget={onReplaceTarget}
                    onSelectResponseAnnotation={vi.fn()}
                  />
                ) : null}
              </ToastProvider>
            </ChatGenerationProvider>
          </QueryClientProvider>,
        );
      });
    };

    renderProvidedView(true);
    await vi.waitFor(() => expect(host.textContent).toContain("Rudder Agent"));
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, "Close while the Side Chat is still being created.");
    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(chatsApi.createSideChat).toHaveBeenCalledOnce());

    renderProvidedView(false);
    renderProvidedView(true);
    const closeHandler = closeHandlers.get(sideChatGenerationScopeKey(sourceConversation.orgId, target));
    expect(closeHandler).toBeDefined();
    await act(async () => {
      await closeHandler?.();
    });
    expect(chatsApi.destroySideChat).not.toHaveBeenCalled();

    await act(async () => {
      resolveCreate(sideConversation);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(chatsApi.destroySideChat).toHaveBeenCalledWith(sideConversation.id));
    expect(chatsApi.sendMessageStream).not.toHaveBeenCalled();
  });

  it("fences sends and provider cleanup while a Side Chat close is pending", async () => {
    let resolveDestroy!: (result: { id: string }) => void;
    const destroyPending = new Promise<{ id: string }>((resolve) => {
      resolveDestroy = resolve;
    });
    vi.mocked(chatsApi.destroySideChat).mockImplementationOnce(() => destroyPending);

    const closeHandlers = new Map<string, (() => Promise<string | null>)>();
    const registerCloseHandler = vi.fn((clientMutationId: string, handler: (() => Promise<string | null>) | null) => {
      if (handler) closeHandlers.set(clientMutationId, handler);
      else closeHandlers.delete(clientMutationId);
    });
    const viewTarget = {
      ...target,
      conversationId: sideConversation.id,
      inlineAnnotations: [],
    };
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ChatGenerationProvider>
            <GenerationProbe />
            <ToastProvider>
              <SideChatPanelView
                organizationId={sourceConversation.orgId}
                target={viewTarget}
                onRegisterCloseHandler={registerCloseHandler}
                onReplaceTarget={onReplaceTarget}
                onSelectResponseAnnotation={vi.fn()}
              />
            </ToastProvider>
          </ChatGenerationProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Rudder Agent"));
    const streamScopeKey = sideChatGenerationScopeKey(sourceConversation.orgId, target);
    await vi.waitFor(() => expect(closeHandlers.get(streamScopeKey)).toBeDefined());

    act(() => {
      latestGenerationActions?.setStreamDraftForChat(streamScopeKey, streamDraft({
        chatId: sideConversation.id,
        streamKey: "old-generation",
        body: "Old generation",
      }));
    });
    await vi.waitFor(() => expect(latestGenerations?.streamDrafts[streamScopeKey]?.body)
      .toBe("Old generation"));

    let closePromise!: Promise<string | null>;
    act(() => {
      closePromise = closeHandlers.get(streamScopeKey)!();
    });
    await vi.waitFor(() => expect(chatsApi.destroySideChat).toHaveBeenCalledWith(sideConversation.id));

    const draft = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Side Chat draft"]')!;
    changeTextarea(draft, "Do not start while close is pending.");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Send Side Chat message"]')?.click();
      await Promise.resolve();
    });
    expect(chatsApi.sendMessageStream).not.toHaveBeenCalled();

    act(() => {
      latestGenerationActions?.beginChatGeneration(streamScopeKey, sideConversation.id);
      latestGenerationActions?.setStreamDraftForChat(streamScopeKey, streamDraft({
        chatId: sideConversation.id,
        streamKey: "new-generation",
        body: "New generation",
      }));
    });
    await vi.waitFor(() => expect(latestGenerations?.streamDrafts[streamScopeKey]?.body)
      .toBe("New generation"));

    await act(async () => {
      resolveDestroy({ id: sideConversation.id });
      await expect(closePromise).rejects.toBeInstanceOf(ChatGenerationCloseSupersededError);
    });
    expect(latestGenerations?.streamDrafts[streamScopeKey]?.body).toBe("New generation");
  });

  it("uses the fresh queue snapshot for a complete Side Chat Stop fence", async () => {
    const generationId = "80000000-0000-4000-8000-000000000020";
    vi.mocked(chatsApi.listQueue).mockResolvedValueOnce({
      activeGenerationId: generationId,
      activeAttemptEpoch: 4,
      activeControlVersion: 9,
      activeGenerationStatus: "running",
      items: [],
    });
    vi.mocked(chatsApi.destroySideChat).mockRejectedValueOnce(
      new ApiError("Keep the test focused on the Stop request.", 500, null),
    );
    const closeHandlers = new Map<string, (() => Promise<string | null>)>();
    const registerCloseHandler = vi.fn((clientMutationId: string, handler: (() => Promise<string | null>) | null) => {
      if (handler) closeHandlers.set(clientMutationId, handler);
      else closeHandlers.delete(clientMutationId);
    });
    const viewTarget = {
      ...target,
      conversationId: sideConversation.id,
      inlineAnnotations: [],
    };

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ChatGenerationProvider>
            <GenerationProbe />
            <ToastProvider>
              <SideChatPanelView
                organizationId={sourceConversation.orgId}
                target={viewTarget}
                onRegisterCloseHandler={registerCloseHandler}
                onReplaceTarget={onReplaceTarget}
                onSelectResponseAnnotation={vi.fn()}
              />
            </ToastProvider>
          </ChatGenerationProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Rudder Agent"));
    const streamScopeKey = sideChatGenerationScopeKey(sourceConversation.orgId, target);
    const generation = latestGenerationActions?.beginChatGeneration(streamScopeKey, sideConversation.id);
    act(() => {
      latestGenerationActions?.setStreamDraftForChat(streamScopeKey, streamDraft({
        chatId: sideConversation.id,
        generationEpoch: generation?.epoch,
        generationId,
        attemptEpoch: 1,
      }));
    });
    await vi.waitFor(async () => {
      // The probe can observe a render before the panel's registration effect
      // commits. Close through the handler for the committed stream state.
      await act(async () => { await Promise.resolve(); });
      expect(latestGenerations?.streamDrafts[streamScopeKey]?.generationId).toBe(generationId);
    });

    const closeHandler = closeHandlers.get(streamScopeKey);
    expect(closeHandler).toBeDefined();
    await act(async () => {
      await expect(closeHandler?.()).rejects.toMatchObject({ status: 500 });
    });

    expect(chatsApi.listQueue).toHaveBeenCalledWith(sideConversation.id);
    expect(chatsApi.stopMessageStream).toHaveBeenCalledWith(sideConversation.id, expect.objectContaining({
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 4,
      expectedControlVersion: 9,
    }));
  });

  it.each([404, 500])("clears provider-owned streaming state when close returns %s", async (status) => {
    const generationId = "80000000-0000-4000-8000-000000000021";
    const userMessage = {
      id: "70000000-0000-4000-8000-000000000021",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Close this stream after the backend response.",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      conversationId,
      body,
      options,
    ) => {
      await options.onEvent({
        type: "ack",
        userMessage: { ...userMessage, conversationId, body },
        generationId,
      });
      await options.onEvent({
        type: "assistant_delta",
        delta: "This should be cleared.",
        generationId,
      });
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    vi.mocked(chatsApi.destroySideChat).mockClear().mockRejectedValueOnce(
      new ApiError(`Close failed with ${status}`, status, null),
    );
    const closeHandlers = new Map<string, (() => Promise<string | null>)>();
    const registerCloseHandler = vi.fn((clientMutationId: string, handler: (() => Promise<string | null>) | null) => {
      if (handler) closeHandlers.set(clientMutationId, handler);
      else closeHandlers.delete(clientMutationId);
    });
    const viewTarget = {
      ...target,
      conversationId: sideConversation.id,
      inlineAnnotations: [],
    };
    const historyKey = queryKeys.chats.sideChats(
      sourceConversation.orgId,
      sourceConversation.id,
      "user-1",
    );
    queryClient.setQueryData(historyKey, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    });

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidePanelProvider>
            <ChatGenerationProvider>
              <ToastProvider>
                <SideChatPanelView
                  organizationId={sourceConversation.orgId}
                  target={viewTarget}
                  onRegisterCloseHandler={registerCloseHandler}
                  onReplaceTarget={onReplaceTarget}
                  onSelectResponseAnnotation={vi.fn()}
                />
              </ToastProvider>
            </ChatGenerationProvider>
          </SidePanelProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Rudder Agent"));
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, userMessage.body);
    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });
    await waitForStreamingAssistantDraft();

    const closeHandler = closeHandlers.get(sideChatGenerationScopeKey(sourceConversation.orgId, target));
    expect(closeHandler).toBeDefined();
    await act(async () => {
      await expect(closeHandler?.()).rejects.toMatchObject({ status });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(host.querySelector("[data-testid=\"side-chat-streaming-reply\"]")).toBeNull();
    expect(host.querySelector('[aria-label="Sending Side Chat message"]')).toBeNull();

    if (status === 404) {
      expect(readSideChatSendDraft(
        "user-1",
        sourceConversation.orgId,
        sourceConversation.id,
        target.clientMutationId,
      )).toBeNull();
      expect(window.localStorage.getItem("rudder:side-chat-send-drafts:v1")).toBeNull();
      expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBe(true);
    } else {
      expect(readSideChatSendDraft(
        "user-1",
        sourceConversation.orgId,
        sourceConversation.id,
        target.clientMutationId,
      )).toEqual({ body: userMessage.body, acceptedUserMessageId: userMessage.id });
      expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBe(false);
      await act(async () => {
        await expect(closeHandler?.()).resolves.toBe(sideConversation.id);
      });
      expect(chatsApi.destroySideChat).toHaveBeenCalledTimes(2);
      expect(readSideChatSendDraft(
        "user-1",
        sourceConversation.orgId,
        sourceConversation.id,
        target.clientMutationId,
      )).toBeNull();
      expect(window.localStorage.getItem("rudder:side-chat-send-drafts:v1")).toBeNull();
      expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBe(true);
    }
  });

  it("keeps close pending and provider state when close returns an active-generation 409", async () => {
    const generationId = "80000000-0000-4000-8000-000000000024";
    const userMessage = {
      id: "70000000-0000-4000-8000-000000000024",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Retry this close after the active generation settles.",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      conversationId,
      body,
      options,
    ) => {
      await options.onEvent({
        type: "ack",
        userMessage: { ...userMessage, conversationId, body },
        generationId,
      });
      await options.onEvent({
        type: "assistant_delta",
        delta: "The active generation is still draining.",
        generationId,
      });
      await new Promise<void>((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    vi.mocked(chatsApi.destroySideChat).mockClear().mockRejectedValueOnce(
      new ApiError("The active generation is still running", 409, {
        details: { code: "active_generation" },
      }),
    );
    const closeHandlers = new Map<string, (() => Promise<string | null>)>();
    const registerCloseHandler = vi.fn((clientMutationId: string, handler: (() => Promise<string | null>) | null) => {
      if (handler) closeHandlers.set(clientMutationId, handler);
      else closeHandlers.delete(clientMutationId);
    });
    const viewTarget = {
      ...target,
      conversationId: sideConversation.id,
      inlineAnnotations: [],
    };

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidePanelProvider>
            <ChatGenerationProvider>
              <GenerationProbe />
              <ToastProvider>
                <SidePanelProbe />
                <SideChatPanelView
                  organizationId={sourceConversation.orgId}
                  target={viewTarget}
                  onRegisterCloseHandler={registerCloseHandler}
                  onReplaceTarget={onReplaceTarget}
                  onSelectResponseAnnotation={vi.fn()}
                />
              </ToastProvider>
            </ChatGenerationProvider>
          </SidePanelProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Rudder Agent"));
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, userMessage.body);
    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });
    await waitForStreamingAssistantDraft();

    const streamScopeKey = sideChatGenerationScopeKey(sourceConversation.orgId, target);
    const closeHandler = closeHandlers.get(streamScopeKey);
    expect(closeHandler).toBeDefined();
    act(() => latestSidePanel?.openTarget(viewTarget));
    const sideChatTargetKey = sidePanelTargetKey(viewTarget);
    expect(latestSidePanel?.tabs).toContainEqual(viewTarget);

    const closeThroughTabCoordinator = async () => {
      try {
        const conversationId = await closeHandler?.();
        if (conversationId) latestSidePanel?.closeTarget(sideChatTargetKey);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
          latestSidePanel?.closeTarget(sideChatTargetKey);
        }
        return error;
      }
      return null;
    };
    await act(async () => {
      const closeError = await closeThroughTabCoordinator();
      expect(closeError).toMatchObject({ message: "The active generation is still running" });
      expect(closeError).not.toBeInstanceOf(ApiError);
    });

    expect(chatsApi.destroySideChat).toHaveBeenCalledTimes(1);
    expect(latestGenerations?.streamDrafts[streamScopeKey]?.streamKey).toBeDefined();
    expect(latestGenerations?.streamDrafts[streamScopeKey]?.state).toBeDefined();
    expect(latestGenerationActions?.isChatGenerationClosePending(streamScopeKey)).toBe(true);
    expect(readSideChatSendDraft(
      "user-1",
      sourceConversation.orgId,
      sourceConversation.id,
      target.clientMutationId,
    )).toEqual({ body: userMessage.body, acceptedUserMessageId: userMessage.id });
    expect(latestSidePanel?.tabs).toContainEqual(viewTarget);

    await act(async () => {
      expect(await closeThroughTabCoordinator()).toBeNull();
    });
    expect(chatsApi.destroySideChat).toHaveBeenCalledTimes(2);
    expect(latestGenerations?.streamDrafts[streamScopeKey]).toBeUndefined();
    expect(latestSidePanel?.tabs).not.toContainEqual(viewTarget);
    expect(readSideChatSendDraft("user-1", sourceConversation.orgId, sourceConversation.id, target.clientMutationId)).toBeNull();
  });

  it("passes the stable already-kept conflict code to the parent and refreshes Side Chat history", async () => {
    const keptError = new ApiError("Conflict", 409, {
      details: { code: "side_chat_kept" },
    });
    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.destroySideChat).mockRejectedValueOnce(keptError);
    const closeHandlers = new Map<string, () => Promise<string | null>>();
    const viewTarget = {
      ...target,
      conversationId: sideConversation.id,
      inlineAnnotations: [],
    };
    const historyKey = queryKeys.chats.sideChats(
      sourceConversation.orgId,
      sourceConversation.id,
      "user-1",
    );
    queryClient.setQueryData(historyKey, {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    });

    await renderView({
      viewTarget,
      onRegisterCloseHandler: (scopeKey, handler) => {
        if (handler) closeHandlers.set(scopeKey, handler);
        else closeHandlers.delete(scopeKey);
      },
    });

    const closeHandler = closeHandlers.get(sideChatGenerationScopeKey(sourceConversation.orgId, viewTarget));
    expect(closeHandler).toBeDefined();
    await act(async () => {
      await expect(closeHandler?.()).rejects.toBe(keptError);
    });

    expect(chatsApi.destroySideChat).toHaveBeenCalledWith(sideConversation.id);
    expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBe(true);
  });

  it("does not let a stale Stop response clear a newer generation", async () => {
    let resolveStop!: (result: {
      stopped: boolean;
      controlActionId: string;
      generationId: string | null;
    }) => void;
    const stopPending = new Promise<{
      stopped: boolean;
      controlActionId: string;
      generationId: string | null;
    }>((resolve) => {
      resolveStop = resolve;
    });
    vi.mocked(chatsApi.stopMessageStream).mockImplementationOnce(() => stopPending);
    const viewTarget = {
      ...target,
      conversationId: sideConversation.id,
      inlineAnnotations: [],
    };

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ChatGenerationProvider>
            <GenerationProbe />
            <ToastProvider>
              <SideChatPanelView
                organizationId={sourceConversation.orgId}
                target={viewTarget}
                onRegisterCloseHandler={vi.fn()}
                onReplaceTarget={onReplaceTarget}
                onSelectResponseAnnotation={vi.fn()}
              />
            </ToastProvider>
          </ChatGenerationProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Rudder Agent"));

    const streamScopeKey = sideChatGenerationScopeKey(sourceConversation.orgId, target);
    let oldGeneration!: { epoch: number };
    act(() => {
      oldGeneration = latestGenerationActions!.beginChatGeneration(
        streamScopeKey,
        sideConversation.id,
      );
      latestGenerationActions!.setChatSendInFlight(streamScopeKey, true);
      latestGenerationActions!.setStreamDraftForChat(streamScopeKey, streamDraft({
        chatId: sideConversation.id,
        streamKey: "stop-old-generation",
        generationEpoch: oldGeneration.epoch,
      }));
    });
    await vi.waitFor(() => expect(latestGenerations?.streamDrafts[streamScopeKey]?.streamKey)
      .toBe("stop-old-generation"));

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Stop Side Chat response"]',
      )?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(latestGenerations?.streamDrafts[streamScopeKey]?.state)
      .toBe("stopping"));

    let newGeneration!: { epoch: number };
    act(() => {
      newGeneration = latestGenerationActions!.beginChatGeneration(
        streamScopeKey,
        sideConversation.id,
      );
      latestGenerationActions!.setChatSendInFlight(streamScopeKey, true);
      latestGenerationActions!.setStreamDraftForChat(streamScopeKey, streamDraft({
        chatId: sideConversation.id,
        streamKey: "stop-new-generation",
        generationEpoch: newGeneration.epoch,
        body: "New generation",
      }));
    });

    await act(async () => {
      resolveStop({
        stopped: true,
        controlActionId: "stop-old",
        generationId: null,
      });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(latestGenerations?.streamDrafts[streamScopeKey]?.streamKey)
      .toBe("stop-new-generation"));
    expect(latestGenerations?.streamDrafts[streamScopeKey]?.body).toBe("New generation");
    expect(latestGenerations?.sendInFlightByChatId[streamScopeKey]).toBe(true);
  });

  it("keeps the acknowledged user message ahead of the assistant when a stale refresh replaces the cache", async () => {
    const generationId = "80000000-0000-4000-8000-000000000000";
    const userMessage = {
      id: "70000000-0000-4000-8000-000000000000",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Keep my message visible while you think.",
      structuredPayload: null,
      attachments: [],
      replyingAgentId: null,
      chatTurnId: "90000000-0000-4000-8000-000000000000",
      turnVariant: 0,
      supersededAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    let releaseStream!: () => void;
    const streamPending = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      conversationId,
      body,
      options,
    ) => {
      await options.onEvent({
        type: "ack",
        userMessage: { ...userMessage, conversationId, body },
        generationId,
      });
      queryClient.setQueryData(
        queryKeys.chats.messages(sourceConversation.orgId, sideConversation.id),
        [],
      );
      await streamPending;
    });

    await renderView({
      viewTarget: {
        ...target,
        conversationId: sideConversation.id,
        inlineAnnotations: [],
      },
    });
    await vi.waitFor(() => expect(queryClient.getQueryState(
      queryKeys.chats.messages(sourceConversation.orgId, sideConversation.id),
    )?.status).toBe("success"));
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, userMessage.body);

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(
      host.querySelector('[data-testid="optimistic-user-message"]')?.textContent,
    ).toBe(userMessage.body));
    await waitForStreamingAssistantDraft();
    const userDraft = host.querySelector('[data-testid="optimistic-user-message"]');
    const assistantDraft = host.querySelector('[data-testid="side-chat-assistant-draft"]');
    expect(userDraft).not.toBeNull();
    expect(assistantDraft).not.toBeNull();
    const orderedDraftNodes = Array.from(host.querySelectorAll(
      '[data-testid="optimistic-user-message"], [data-testid="side-chat-assistant-draft"]',
    ));
    expect(orderedDraftNodes.indexOf(userDraft!)).toBeLessThan(
      orderedDraftNodes.indexOf(assistantDraft!),
    );

    releaseStream();
  });

  it("marks a stream that reaches EOF without final as failed and stops the sending state", async () => {
    const generationId = "80000000-0000-4000-8000-000000000010";
    const userMessage = {
      id: "70000000-0000-4000-8000-000000000010",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Recover from an incomplete Side Chat stream.",
      structuredPayload: null,
      attachments: [],
      replyingAgentId: null,
      chatTurnId: "90000000-0000-4000-8000-000000000010",
      turnVariant: 0,
      supersededAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;

    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      conversationId,
      body,
      options,
    ) => {
      await options.onEvent({
        type: "ack",
        userMessage: { ...userMessage, conversationId, body },
        generationId,
      });
      await options.onEvent({
        type: "assistant_delta",
        delta: "Partial answer before disconnect.",
        generationId,
      });
    });

    await renderView({
      viewTarget: {
        ...target,
        conversationId: sideConversation.id,
        inlineAnnotations: [],
      },
    });
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, userMessage.body);

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(host.querySelector('[aria-label="Sending Side Chat message"]')).toBeNull();
  });

  it("renders one live reply when the persisted streaming assistant message is refreshed", async () => {
    const generationId = "80000000-0000-4000-8000-000000000001";
    const userMessage = {
      id: "70000000-0000-4000-8000-000000000001",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Keep the live reply singular.",
      structuredPayload: null,
      attachments: [],
      replyingAgentId: null,
      chatTurnId: "90000000-0000-4000-8000-000000000001",
      turnVariant: 0,
      supersededAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    const persistedStreamingAssistant = {
      ...userMessage,
      id: "70000000-0000-4000-8000-000000000002",
      role: "assistant",
      status: "streaming",
      body: "",
      generationId,
      transcript: [{
        kind: "thinking",
        ts: new Date().toISOString(),
        text: "Inspecting the render path.",
      }],
    } as unknown as ChatMessage;
    let releaseStream!: () => void;
    const streamPending = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      conversationId,
      body,
      options,
    ) => {
      await options.onEvent({
        type: "ack",
        userMessage: { ...userMessage, conversationId, body },
        generationId,
      });
      await options.onEvent({
        type: "transcript_entry",
        generationId,
        entry: {
          kind: "thinking",
          ts: new Date().toISOString(),
          text: "Inspecting the render path.",
        },
      });
      queryClient.setQueryData(
        queryKeys.chats.messages(sourceConversation.orgId, sideConversation.id),
        [userMessage, persistedStreamingAssistant],
      );
      await streamPending;
    });

    await renderView({
      viewTarget: {
        ...target,
        conversationId: sideConversation.id,
        inlineAnnotations: [],
      },
    });
    await vi.waitFor(() => expect(chatsApi.listMessages).toHaveBeenCalled());
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, "Keep the live reply singular.");

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(
      host.querySelectorAll('[data-testid="side-chat-process"]'),
    ).toHaveLength(1));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="chat-agent-selector"]')?.click();
      await Promise.resolve();
    });
    const runtimeSelector = await vi.waitFor(() => {
      const selector = document.body.querySelector<HTMLButtonElement>(
        '[data-testid="chat-agent-runtime-selector"]',
      );
      expect(selector).not.toBeNull();
      return selector!;
    });
    expect(runtimeSelector.disabled).toBe(false);

    releaseStream();
  });

  it("replaces a refreshed streaming projection with the final message by id", async () => {
    const generationId = "80000000-0000-4000-8000-000000000002";
    const assistantMessageId = "70000000-0000-4000-8000-000000000004";
    const userMessage = {
      id: "70000000-0000-4000-8000-000000000003",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Finish without a stale projection.",
      structuredPayload: null,
      attachments: [],
      replyingAgentId: null,
      chatTurnId: "90000000-0000-4000-8000-000000000002",
      turnVariant: 0,
      supersededAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    const streamingAssistant = {
      ...userMessage,
      id: assistantMessageId,
      role: "assistant",
      status: "streaming",
      body: "Partial reply",
      generationId,
      transcript: [],
    } as unknown as ChatMessage;
    const completedAssistant = {
      ...streamingAssistant,
      status: "completed",
      body: "Authoritative final reply",
    } as unknown as ChatMessage;
    let releaseAfterFinal!: () => void;
    const finalPending = new Promise<void>((resolve) => {
      releaseAfterFinal = resolve;
    });

    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      conversationId,
      body,
      options,
    ) => {
      await options.onEvent({
        type: "ack",
        userMessage: { ...userMessage, conversationId, body },
        generationId,
      });
      queryClient.setQueryData(
        queryKeys.chats.messages(sourceConversation.orgId, sideConversation.id),
        [userMessage, streamingAssistant],
      );
      await options.onEvent({
        type: "final",
        messages: [completedAssistant],
      });
      await finalPending;
    });

    await renderView({
      viewTarget: {
        ...target,
        conversationId: sideConversation.id,
        inlineAnnotations: [],
      },
    });
    await vi.waitFor(() => expect(queryClient.getQueryState(
      queryKeys.chats.messages(sourceConversation.orgId, sideConversation.id),
    )?.status).toBe("success"));
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, "Finish without a stale projection.");

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(host.textContent).toContain("Authoritative final reply"));
    expect(host.textContent).not.toContain("Partial reply");
    releaseAfterFinal();
  });

  it("prefers a refreshed authoritative failure over the local failed draft", async () => {
    const generationId = "80000000-0000-4000-8000-000000000003";
    const userMessage = {
      id: "70000000-0000-4000-8000-000000000005",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Show the durable failure.",
      structuredPayload: null,
      attachments: [],
      replyingAgentId: null,
      chatTurnId: "90000000-0000-4000-8000-000000000003",
      turnVariant: 0,
      supersededAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    const failedAssistant = {
      ...userMessage,
      id: "70000000-0000-4000-8000-000000000006",
      role: "assistant",
      status: "failed",
      body: "Durable provider failure details",
      generationId,
      transcript: [],
    } as unknown as ChatMessage;
    let authoritativeMessages: ChatMessage[] = [];

    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.listMessages).mockImplementation(async (_organizationId, conversationId) => (
      conversationId === sideConversation.id ? authoritativeMessages : []
    ));
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      conversationId,
      body,
      options,
    ) => {
      await options.onEvent({
        type: "ack",
        userMessage: { ...userMessage, conversationId, body },
        generationId,
      });
      authoritativeMessages = [userMessage, failedAssistant];
      await options.onEvent({
        type: "error",
        error: "The stream disconnected after persistence.",
        messageId: failedAssistant.id,
      });
    });

    await renderView({
      viewTarget: {
        ...target,
        conversationId: sideConversation.id,
        inlineAnnotations: [],
      },
    });
    await vi.waitFor(() => expect(queryClient.getQueryState(
      queryKeys.chats.messages(sourceConversation.orgId, sideConversation.id),
    )?.status).toBe("success"));
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, "Show the durable failure.");

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(host.textContent).toContain("Durable provider failure details"));
    expect(host.querySelector('[data-testid="side-chat-assistant-draft"]')).toBeNull();
  });
});

describe("SideChatPanelView response annotations", () => {
  it("disables mutations for copied source proposals and approval records", async () => {
    const copiedSource = {
      conversationId: sourceConversation.id,
      messageId: annotation.sourceMessageId,
    };
    const copiedApproval = {
      id: "70000000-0000-4000-8000-000000000011",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Copied approval",
      approval: { id: "approval-copied" },
      structuredPayload: { sideChatSource: copiedSource },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    const copiedOperation = {
      ...copiedApproval,
      id: "70000000-0000-4000-8000-000000000012",
      body: "Copied operation proposal",
      approval: null,
      kind: "operation_proposal",
    } as unknown as ChatMessage;
    const copiedIssue = {
      ...copiedApproval,
      id: "70000000-0000-4000-8000-000000000013",
      body: "Copied issue proposal",
      approval: null,
      kind: "issue_proposal",
    } as unknown as ChatMessage;
    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.listMessages).mockImplementation(async (_organizationId, conversationId) => (
      conversationId === sideConversation.id
        ? [copiedApproval, copiedOperation, copiedIssue]
        : []
    ));

    await renderView({
      viewTarget: {
        ...target,
        conversationId: sideConversation.id,
        inlineAnnotations: [],
      },
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Copied approval"));

    for (const selector of [
      '[data-testid="side-chat-approval-action"]',
      '[data-testid="side-chat-operation-action"]',
      '[data-testid="side-chat-convert-action"]',
    ]) {
      const button = host.querySelector<HTMLButtonElement>(selector);
      expect(button?.disabled).toBe(true);
      act(() => button?.click());
    }
    expect(approvalsApi.approve).not.toHaveBeenCalled();
    expect(chatsApi.resolveOperationProposal).not.toHaveBeenCalled();
    expect(chatsApi.convertToIssue).not.toHaveBeenCalled();
  });

  it("keeps an expired Side Chat read-only, including proposal actions", async () => {
    const expiredConversation = {
      ...sideConversation,
      sideChatState: "expired",
      sideChatExpiresAt: new Date(Date.now() - 60_000),
    } as unknown as ChatConversation;
    const issueProposal = {
      id: "70000000-0000-4000-8000-000000000014",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "assistant",
      kind: "issue_proposal",
      status: "completed",
      body: "Expired issue proposal",
      structuredPayload: {},
      approval: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? expiredConversation : sourceConversation
    ));
    vi.mocked(chatsApi.listMessages).mockImplementation(async (_organizationId, conversationId) => (
      conversationId === sideConversation.id ? [issueProposal] : []
    ));

    await renderView({
      viewTarget: {
        ...target,
        conversationId: sideConversation.id,
        inlineAnnotations: [],
      },
      waitForAgent: false,
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Expired issue proposal"));

    expect(host.querySelector('[data-testid="side-chat-read-only"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="side-chat-composer"]')).toBeNull();
    const action = host.querySelector<HTMLButtonElement>('[data-testid="side-chat-convert-action"]');
    expect(action?.disabled).toBe(true);
    act(() => action?.click());
    expect(chatsApi.convertToIssue).not.toHaveBeenCalled();
  });

  it("forwards a historical annotation source action from a transient Side Chat", async () => {
    const onSelectResponseAnnotation = vi.fn();
    const persistedAnnotation = { ...annotation, attachmentIds: [] };
    const sideUserMessage = {
      id: "70000000-0000-4000-8000-000000000010",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "user",
      kind: "message",
      status: "completed",
      body: "Explain the selected source.",
      structuredPayload: { inlineAnnotations: [persistedAnnotation] },
      attachments: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.listMessages).mockImplementation(async (_organizationId, conversationId) => (
      conversationId === sideConversation.id ? [sideUserMessage] : []
    ));

    await renderView({
      viewTarget: {
        ...target,
        conversationId: sideConversation.id,
        inlineAnnotations: [],
      },
      onSelectResponseAnnotation,
    });
    await vi.waitFor(() => expect(host.textContent).toContain(
      "Explain the selected source.",
    ));

    act(() => {
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Show source 1")
        ?.click();
    });

    expect(onSelectResponseAnnotation).toHaveBeenCalledWith(
      persistedAnnotation,
      1,
    );
  });

  it("dismisses provisional annotation details with Escape and restores chip focus", async () => {
    await renderView();
    const chip = host.querySelector<HTMLButtonElement>(
      '[aria-label="Show 1 annotation"]',
    )!;
    act(() => chip.click());
    expect(document.body.querySelector('[aria-label="Edit annotation 1"]')).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }));
    });

    expect(document.body.querySelector('[aria-label="Edit annotation 1"]')).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    await vi.waitFor(() => expect(document.activeElement).toBe(chip));
  });

  it("keeps an annotation draft and does not create a Side Chat while the dev runtime is stale", async () => {
    queryClient.setQueryData(queryKeys.health, {
      devServer: {
        enabled: true,
        restartRequired: true,
      },
    });
    await renderView();

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });

    expect(chatsApi.createSideChat).not.toHaveBeenCalled();
    expect(chatsApi.sendMessageStream).not.toHaveBeenCalled();
    expect(host.textContent).toContain("1 annotation");
    expect(document.body.textContent).toContain("Restart Rudder to send annotations");
    expect(document.body.textContent).toContain("Copy it before restarting Rudder");
    expect(Array.from(document.body.querySelectorAll("button"))
      .some((button) => button.textContent === "Restart Rudder")).toBe(false);
  });

  it("keeps the Side Chat provisional until annotation-only Send and owns comment files", async () => {
    const screenshot = new File(["image"], "evidence.png", { type: "image/png" });
    vi.mocked(chatsApi.sendMessageStream).mockImplementation(async (
      conversationId,
      body,
      options,
    ) => {
      await options.onEvent({
        type: "ack",
        userMessage: {
          id: "70000000-0000-4000-8000-000000000001",
          conversationId,
          body,
          role: "user",
        } as ChatMessage,
      } as ChatStreamEvent);
      await options.onEvent({ type: "final", messages: [] } as ChatStreamEvent);
    });

    await renderView();
    expect(chatsApi.createSideChat).not.toHaveBeenCalled();
    expect(host.textContent).toContain("1 annotation");
    expect(host.querySelector('[aria-label="Show 1 annotation"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Edit annotation 1"]')).toBeNull();

    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="Show 1 annotation"]')?.click();
    });
    const edit = document.body.querySelector<HTMLButtonElement>('[aria-label="Edit annotation 1"]');
    expect(edit).not.toBeNull();
    act(() => edit?.click());
    const editor = document.body.querySelector(
      '[data-testid="chat-response-annotation-editor"]',
    )!;
    changeTextarea(editor.querySelector("textarea")!, "Please verify this.");
    const fileInput = editor.querySelector<HTMLInputElement>('input[type="file"]')!;
    act(() => {
      Object.defineProperty(fileInput, "files", {
        configurable: true,
        value: [screenshot],
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const save = Array.from(editor.querySelectorAll("button"))
      .find((candidate) => candidate.textContent?.trim() === "Save");
    expect(save).toBeDefined();
    act(() => save?.click());

    const send = host.querySelector<HTMLButtonElement>(
      '[aria-label="Send Side Chat message"]',
    )!;
    expect(send.disabled).toBe(false);
    await act(async () => {
      send.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      send.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(chatsApi.sendMessageStream).toHaveBeenCalledOnce());

    expect(chatsApi.createSideChat).toHaveBeenCalledWith(
      sourceConversation.id,
      {
        sourceMessageId: annotation.sourceMessageId,
        clientMutationId: target.clientMutationId,
        preferredAgentId: defaultAgent.id,
      },
    );
    expect(chatsApi.sendMessageStream).toHaveBeenCalledWith(
      sideConversation.id,
      "",
      expect.objectContaining({
        files: [screenshot],
        inlineAnnotations: [
          expect.objectContaining({
            id: annotation.id,
            comment: "Please verify this.",
            attachmentFileIndexes: [0],
          }),
        ],
      }),
    );
    expect(host.textContent).not.toContain("1 annotation");
  });

  it("restores body and retains annotations when the first send is rejected", async () => {
    vi.mocked(chatsApi.sendMessageStream).mockRejectedValueOnce(
      new Error("Source annotation is no longer valid."),
    );
    await renderView();
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, "Check this edge case.");

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain(
      "Something went wrong. Try again.",
    ));

    expect(draft.value).toBe("Check this edge case.");
    expect(host.textContent).toContain("1 annotation");
  });

  it("preserves first-send runtime selection when Side Chat fails before acknowledgement", async () => {
    vi.mocked(agentsApi.adapterModels).mockResolvedValue([
      { id: "gpt-5.6-sol", label: "GPT-5.6-sol", variants: ["high"] },
      { id: "gpt-5.6-terra", label: "GPT-5.6-terra", variants: ["xhigh"] },
    ]);
    vi.mocked(chatsApi.sendMessageStream).mockRejectedValueOnce(new Error("Admission failed."));
    await renderView({ viewTarget: { ...target, inlineAnnotations: [] } });

    act(() => host.querySelector<HTMLButtonElement>('[data-testid="chat-agent-selector"]')?.click());
    await vi.waitFor(() => expect(document.body.querySelector(
      '[data-testid="chat-agent-runtime-selector"]',
    )).not.toBeNull());
    act(() => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-agent-runtime-selector"]',
    )?.click());
    await vi.waitFor(() => expect(document.body.querySelector(
      '[data-testid="chat-model-selector"]',
    )).not.toBeNull());
    act(() => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-model-selector"]',
    )?.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("GPT-5.6-terra"));
    act(() => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("GPT-5.6-terra"))?.click());
    await vi.waitFor(() => expect(document.body.querySelector(
      '[data-testid="chat-model-selector"]',
    )?.getAttribute("data-value")).toBe("gpt-5.6-terra"));
    act(() => document.body.querySelector<HTMLButtonElement>(
      '[data-testid="chat-effort-selector"]',
    )?.click());
    await vi.waitFor(() => expect(document.body.textContent).toContain("Extra High"));
    act(() => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Extra High")?.click());
    act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    const draft = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Side Chat draft"]')!;
    changeTextarea(draft, "Retry with the same runtime.");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Send Side Chat message"]')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain("Something went wrong. Try again."));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Send Side Chat message"]')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(chatsApi.sendMessageStream).toHaveBeenCalledTimes(2));
    expect(chatsApi.sendMessageStream).toHaveBeenLastCalledWith(
      sideConversation.id,
      "Retry with the same runtime.",
      expect.objectContaining({ modelOverride: "gpt-5.6-terra", effortOverride: "xhigh" }),
    );
  });

  it("does not restore a Side Chat draft when a pre-ack error identifies the committed user message", async () => {
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      _conversationId,
      _body,
      options,
    ) => {
      await options.onEvent({
        type: "error",
        error: "The saved message could not be hydrated.",
        messageId: "70000000-0000-4000-8000-000000000002",
      });
    });
    await renderView();
    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    changeTextarea(draft, "Do not send this twice.");

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Send Side Chat message"]',
      )?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain(
      "Something went wrong. Try again.",
    ));

    expect(draft.value).toBe("");
    expect(host.textContent).not.toContain("1 annotation");
  });
});

describe("SideChatPanelView composer controls", () => {
  it("stages Add files and inserts an enabled Skill reference", async () => {
    await renderView({
      viewTarget: {
        ...target,
        inlineAnnotations: [],
      },
    });

    await act(async () => {
      const addButton = host.querySelector<HTMLButtonElement>('[aria-label="Add files and options"]');
      addButton?.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerType: "mouse",
      }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Add files"));

    const file = new File(["evidence"], "evidence.txt", { type: "text/plain" });
    const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => {
      Object.defineProperty(fileInput, "files", {
        configurable: true,
        value: [file],
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain("evidence.txt"));
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }));
      await Promise.resolve();
    });

    await act(async () => {
      const skillsButton = host.querySelector<HTMLButtonElement>('[aria-label="Skills"]');
      skillsButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("research-skill"));
    const skillSearch = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search skills..."]',
    )!;
    await vi.waitFor(() => expect(document.activeElement).toBe(skillSearch));
    await act(async () => {
      skillSearch.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="side-chat-skill-menu"]')).toBeNull();
      expect(document.activeElement).toBe(
        host.querySelector<HTMLButtonElement>('[aria-label="Skills"]'),
      );
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Skills"]')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("research-skill"));
    const skillOption = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((candidate) => candidate.textContent?.includes("research-skill"));
    expect(skillOption).toBeDefined();
    await act(async () => {
      skillOption?.click();
      await Promise.resolve();
    });

    const draft = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Side Chat draft"]',
    )!;
    await vi.waitFor(() => expect(draft.value).toContain("[research-skill]("));
  });
});

describe("SideChatPanelView message references and files", () => {
  it("renders available Skill references and opens local files in the Side Panel", async () => {
    const message = {
      id: "70000000-0000-4000-8000-000000000030",
      orgId: sourceConversation.orgId,
      conversationId: sideConversation.id,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "See the research skill and evidence file.",
      structuredPayload: {},
      approvalId: null,
      approval: null,
      attachments: [],
      replyingAgentId: defaultAgent.id,
      chatTurnId: null,
      turnVariant: 0,
      supersededAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as ChatMessage;
    vi.mocked(chatsApi.get).mockImplementation(async (conversationId) => (
      conversationId === sideConversation.id ? sideConversation : sourceConversation
    ));
    vi.mocked(chatsApi.listMessages).mockResolvedValue([message]);

    await renderView({
      viewTarget: {
        ...target,
        conversationId: sideConversation.id,
        inlineAnnotations: [],
      },
    });
    await vi.waitFor(() => expect(
      Array.from(host.querySelectorAll('[data-testid="side-chat-skill-reference"]'))
        .some((reference) => reference.textContent?.includes("research-skill")),
    ).toBe(true));

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="side-chat-open-file"]')?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(latestSidePanel?.tabs).toContainEqual(
      expect.objectContaining({
        kind: "local_file",
        filePath: "/tmp/side-chat-evidence.md",
        label: "side-chat-evidence.md",
      }),
    ));
  });
});
