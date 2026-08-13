// @vitest-environment jsdom

import { agentsApi } from "@/api/agents";
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
import { ToastProvider } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  sideChatGenerationScopeKey,
  type SidePanelTarget,
} from "@/lib/side-panel-targets";
import type {
  Agent,
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

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: vi.fn(),
    adapterModels: vi.fn(),
    skills: vi.fn(),
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
    createSideChat: vi.fn(),
    destroySideChat: vi.fn(async () => undefined),
    sendMessageStream: vi.fn(),
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
  AssistantDraftItem: () => <div>Assistant draft</div>,
  OptimisticUserDraftItem: ({ body }: { body: string }) => (
    <div data-testid="optimistic-user-message">{body}</div>
  ),
  ChatMessageItem: ({
    message,
    onSelectResponseAnnotation,
  }: {
    message: ChatMessage;
    onSelectResponseAnnotation?: (
      annotation: ChatInlineAnnotationInput & { attachmentIds: string[] },
      ordinal: number,
    ) => void;
  }) => {
    const inlineAnnotations = (
      message.structuredPayload?.inlineAnnotations ?? []
    ) as Array<ChatInlineAnnotationInput & { attachmentIds: string[] }>;
    return (
      <div>
        {message.body}
        {inlineAnnotations.map((candidate, index) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => onSelectResponseAnnotation?.(candidate, index + 1)}
          >
            Show source {index + 1}
          </button>
        ))}
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

function GenerationProbe() {
  latestGenerationActions = useChatGenerationActions();
  latestGenerations = useChatGenerations();
  return null;
}

beforeAll(() => {
  notifyManager.setNotifyFunction((callback) => act(callback));
});

afterAll(() => {
  notifyManager.setNotifyFunction((callback) => callback());
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  onReplaceTarget = vi.fn();
  latestGenerationActions = null;
  latestGenerations = null;
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
  vi.mocked(chatsApi.createSideChat).mockReset().mockResolvedValue(sideConversation);
  vi.mocked(chatsApi.sendMessageStream).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  latestGenerationActions = null;
  latestGenerations = null;
  host.remove();
});

async function renderView({
  viewTarget = target,
  onSelectResponseAnnotation = vi.fn(),
}: {
  viewTarget?: Extract<SidePanelTarget, { kind: "side_chat" }>;
  onSelectResponseAnnotation?: ReturnType<typeof vi.fn>;
} = {}) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ChatGenerationProvider>
          <ToastProvider>
            <SideChatPanelView
              organizationId={sourceConversation.orgId}
              target={viewTarget}
              onRegisterCloseHandler={vi.fn()}
              onReplaceTarget={onReplaceTarget}
              onSelectResponseAnnotation={onSelectResponseAnnotation}
            />
            <ToastViewport />
          </ToastProvider>
        </ChatGenerationProvider>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(host.textContent).toContain("Rudder Agent"));
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
  it("omits the project chip while keeping the agent and skills controls", async () => {
    await renderView();

    expect(host.querySelector('[data-testid="side-chat-project-chip"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-agent-selector"]')).not.toBeNull();
    expect(host.textContent).toContain("Skills");
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
    await vi.waitFor(() => expect(host.textContent).toContain("Assistant draft"));

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
    await vi.waitFor(() => expect(host.textContent).toContain("first stream failed after ack"));
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
    expect(chatsApi.destroySideChat).toHaveBeenCalledWith(sideConversation.id);

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

  it.each([404, 409, 500])("clears provider-owned streaming state when close returns %s", async (status) => {
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

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
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
    await vi.waitFor(() => expect(host.textContent).toContain("Assistant draft"));

    const closeHandler = closeHandlers.get(sideChatGenerationScopeKey(sourceConversation.orgId, target));
    expect(closeHandler).toBeDefined();
    await act(async () => {
      await expect(closeHandler?.()).rejects.toMatchObject({ status });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(host.querySelector("[data-testid=\"side-chat-streaming-reply\"]")).toBeNull();
    expect(host.querySelector('[aria-label="Sending Side Chat message"]')).toBeNull();

    if (status === 500) {
      await act(async () => {
        await expect(closeHandler?.()).resolves.toBe(sideConversation.id);
      });
      expect(chatsApi.destroySideChat).toHaveBeenCalledTimes(2);
    }
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
    expect(host.textContent?.indexOf(userMessage.body)).toBeLessThan(
      host.textContent?.indexOf("Assistant draft") ?? -1,
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

    await vi.waitFor(() => expect(host.textContent).toContain(
      "Side Chat stream ended before a final response.",
    ));
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
    expect(host.textContent).not.toContain("Assistant draft");
  });
});

describe("SideChatPanelView response annotations", () => {
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
        modelOverride: null,
        effortOverride: null,
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
      "Source annotation is no longer valid.",
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
    await vi.waitFor(() => expect(host.textContent).toContain("Admission failed."));
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
      "The saved message could not be hydrated.",
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
