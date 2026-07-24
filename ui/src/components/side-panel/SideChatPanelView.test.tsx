// @vitest-environment jsdom

import { chatsApi } from "@/api/chats";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import type {
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
  agentsApi: { list: vi.fn(async () => []) },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: { list: vi.fn(async () => []) },
}));

vi.mock("@/api/chats", () => ({
  chatsApi: {
    get: vi.fn(),
    listMessages: vi.fn(),
    createSideChat: vi.fn(),
    destroySideChat: vi.fn(async () => undefined),
    sendMessageStream: vi.fn(),
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
  StreamTranscriptItem: () => <div>Process</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const sourceConversation = {
  id: "10000000-0000-4000-8000-000000000001",
  orgId: "50000000-0000-4000-8000-000000000001",
  contextLinks: [],
  preferredAgentId: null,
  routedAgentId: null,
  chatRuntime: null,
} as unknown as ChatConversation;

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

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;
let onReplaceTarget: ReturnType<typeof vi.fn>;

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
  vi.mocked(chatsApi.get).mockReset().mockResolvedValue(sourceConversation);
  vi.mocked(chatsApi.listMessages).mockReset().mockResolvedValue([]);
  vi.mocked(chatsApi.createSideChat).mockReset().mockResolvedValue(sideConversation);
  vi.mocked(chatsApi.sendMessageStream).mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  host.remove();
});

function renderView({
  viewTarget = target,
  onSelectResponseAnnotation = vi.fn(),
}: {
  viewTarget?: Extract<SidePanelTarget, { kind: "side_chat" }>;
  onSelectResponseAnnotation?: ReturnType<typeof vi.fn>;
} = {}) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SideChatPanelView
          organizationId={sourceConversation.orgId}
          target={viewTarget}
          onRegisterCloseHandler={vi.fn()}
          onReplaceTarget={onReplaceTarget}
          onSelectResponseAnnotation={onSelectResponseAnnotation}
        />
      </QueryClientProvider>,
    );
  });
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

    renderView({
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
    renderView();
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

    renderView();
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
    renderView();
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
    renderView();
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
