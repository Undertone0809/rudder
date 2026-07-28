// @vitest-environment jsdom

import { chatsApi } from "@/api/chats";
import { buildChatMentionHref, type ChatConversation, type ChatInlineAnnotationInput, type ChatMessage, type ChatQueuedMessage } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canQueueComposerDraft,
  chatMessageJumpTargetFromHref,
  chatSendButtonDisabled,
  createQueuedComposerMessage,
  projectChatQueueDelivery,
  queuedMessagePayloadForBodyEdit,
  revealChatAnnotationSourceElement,
  sideChatTargetFromMessage,
  useChatDraftQueries,
} from "./Chat.workspace-helpers";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/api/chats", () => ({
  chatsApi: {
    createQueuedMessage: vi.fn(),
    list: vi.fn(),
    preflightDraft: vi.fn(),
  },
}));

const runtimeDescriptor = {
  sourceType: "agent" as const,
  sourceLabel: "General",
  runtimeAgentId: "agent-1",
  agentRuntimeType: "codex",
  model: null,
  available: true,
  error: null,
};

function DraftQueryProbe() {
  useChatDraftQueries({
    selectedOrganizationId: "org-1",
    selectedConversation: null,
    activeAgentId: "agent-1",
    activeProjectId: "__no_project__",
    issueContextId: null,
    planMode: false,
    noProjectId: "__no_project__",
    contextLinks: [],
  });
  return null;
}

async function mountProbe(queryClient: QueryClient) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DraftQueryProbe />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
  return { container, root };
}

function unmountProbe(root: Root, container: HTMLDivElement) {
  act(() => root.unmount());
  container.remove();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("chat reference navigation targets", () => {
  it("resolves chat mentions and Messenger routes with optional message anchors", () => {
    expect(chatMessageJumpTargetFromHref(buildChatMentionHref("chat-2"))).toEqual({
      conversationId: "chat-2",
      messageId: null,
    });
    expect(chatMessageJumpTargetFromHref(`${buildChatMentionHref("chat-2")}?messageId=message-3`)).toEqual({
      conversationId: "chat-2",
      messageId: "message-3",
    });
    expect(chatMessageJumpTargetFromHref("/RUD/messenger/chat/chat-4?targetMessageId=message-5")).toEqual({
      conversationId: "chat-4",
      messageId: "message-5",
    });
  });

  it("does not intercept external or non-chat links", () => {
    expect(chatMessageJumpTargetFromHref("https://example.com/messenger/chat/chat-2")).toBeNull();
    expect(chatMessageJumpTargetFromHref("/issues/issue-1")).toBeNull();
    expect(chatMessageJumpTargetFromHref("/plugins/foo/chat/bar")).toBeNull();
  });
});

describe("annotation source reveal", () => {
  it("highlights briefly and avoids smooth scrolling for reduced motion", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const source = document.createElement("div");
    source.scrollIntoView = vi.fn();

    revealChatAnnotationSourceElement(source);

    expect(source.scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      behavior: "auto",
    });
    expect(source.classList.contains("chat-message-jump-highlight")).toBe(true);
    vi.advanceTimersByTime(1_800);
    expect(source.classList.contains("chat-message-jump-highlight")).toBe(false);
  });
});

describe("useChatDraftQueries", () => {
  it("reuses a successful draft preflight when the user returns to Chat", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(chatsApi.preflightDraft).mockResolvedValue(runtimeDescriptor);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          gcTime: Number.POSITIVE_INFINITY,
          retry: false,
          staleTime: 30_000,
        },
      },
    });

    const first = await mountProbe(queryClient);
    expect(chatsApi.preflightDraft).toHaveBeenCalledTimes(1);
    unmountProbe(first.root, first.container);

    now += 60_000;
    const second = await mountProbe(queryClient);
    expect(chatsApi.preflightDraft).toHaveBeenCalledTimes(1);

    unmountProbe(second.root, second.container);
    queryClient.clear();
  });

  it("rechecks an unavailable draft preflight when the user returns after fixing the agent", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(chatsApi.preflightDraft).mockResolvedValue({
      ...runtimeDescriptor,
      available: false,
      error: "Configure this agent before sending messages.",
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          gcTime: Number.POSITIVE_INFINITY,
          retry: false,
          staleTime: 30_000,
        },
      },
    });

    const first = await mountProbe(queryClient);
    expect(chatsApi.preflightDraft).toHaveBeenCalledTimes(1);
    unmountProbe(first.root, first.container);

    vi.mocked(chatsApi.preflightDraft).mockResolvedValue(runtimeDescriptor);
    now += 1;
    const second = await mountProbe(queryClient);
    expect(chatsApi.preflightDraft).toHaveBeenCalledTimes(2);

    unmountProbe(second.root, second.container);
    queryClient.clear();
  });
});

describe("projectChatQueueDelivery", () => {
  it("prioritizes durable delivery and the active Steer request over a stale queued status", () => {
    const queued = { status: "queued", deliveredMessageId: null, continuationMessageId: null, deliveryDisposition: null } as ChatQueuedMessage;

    expect(projectChatQueueDelivery(queued, true)).toEqual({ state: "sending", label: "Sending…" });
    expect(projectChatQueueDelivery({ ...queued, deliveredMessageId: "message-1" })).toEqual({ state: "hidden" });
    expect(projectChatQueueDelivery({ ...queued, status: "failed_actionable", sourceMessageId: "message-1" })).toEqual({ state: "hidden" });
    expect(projectChatQueueDelivery({ ...queued, status: "failed_actionable", deliveryDisposition: "reconciled_current" })).toEqual({ state: "hidden" });
  });
});

describe("createQueuedComposerMessage", () => {
  it("passes annotation file indexes and files through to the Queue request", async () => {
    const queryClient = new QueryClient();
    const conversation = {
      id: "chat-1",
      orgId: "org-1",
    } as ChatConversation;
    const annotation: ChatInlineAnnotationInput = {
      id: "00000000-0000-4000-8000-000000000001",
      selectedText: "quoted answer",
      comment: "Explain this",
      sourceConversationId: "00000000-0000-4000-8000-000000000002",
      sourceMessageId: "00000000-0000-4000-8000-000000000003",
      surface: "assistant_body",
      sourceHash: "a".repeat(64),
      start: 4,
      end: 17,
      prefix: "the ",
      suffix: " next",
      attachmentFileIndexes: [0],
    };
    const annotationFile = new File(["proof"], "proof.png", { type: "image/png" });
    const queued = {
      id: "queue-1",
      conversationId: conversation.id,
      payload: {
        body: "",
        inlineAnnotations: [{ ...annotation, attachmentFileIndexes: undefined }],
      },
    };
    vi.mocked(chatsApi.createQueuedMessage).mockResolvedValue(queued as never);

    await createQueuedComposerMessage({
      conversation,
      body: "",
      inlineAnnotations: [annotation],
      files: [annotationFile],
      orgId: "org-1",
      projectId: null,
      serverActiveGenerationId: "generation-1",
      queueSnapshot: undefined,
      queryClient,
    });

    expect(chatsApi.createQueuedMessage).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({
        payload: expect.objectContaining({
          body: "",
          inlineAnnotations: [annotation],
        }),
      }),
      { files: [annotationFile] },
    );
  });
});

describe("canQueueComposerDraft", () => {
  it("allows annotation-only Queue turns while a reply is active", () => {
    expect(canQueueComposerDraft({
      activeReply: true,
      body: "",
      annotationCount: 1,
      pendingRegularFileCount: 0,
      newConversationSendInFlight: false,
    })).toBe(true);
  });

  it("keeps unsupported regular Composer files out of Queue", () => {
    expect(canQueueComposerDraft({
      activeReply: true,
      body: "",
      annotationCount: 1,
      pendingRegularFileCount: 1,
      newConversationSendInFlight: false,
    })).toBe(false);
  });
});

describe("chatSendButtonDisabled", () => {
  it("blocks Send and Queue while a runtime selection is saving", () => {
    for (const sendButtonMode of ["send", "queue"] as const) {
      expect(chatSendButtonDisabled({
        selectedConversationExternalBound: false,
        modelSelectionPending: true,
        composerUnavailable: false,
        sendButtonMode,
        hasDraft: true,
      })).toBe(true);
    }
  });

  it("keeps Stop enabled while a runtime selection is saving", () => {
    expect(chatSendButtonDisabled({
      selectedConversationExternalBound: false,
      modelSelectionPending: true,
      composerUnavailable: false,
      sendButtonMode: "stop",
      hasDraft: false,
    })).toBe(false);
  });
});

describe("sideChatTargetFromMessage", () => {
  it("owns an exact provisional annotation without mutating the source message", () => {
    const conversation = {
      id: "10000000-0000-4000-8000-000000000001",
    } as ChatConversation;
    const sourceMessage = {
      id: "20000000-0000-4000-8000-000000000001",
      body: "The full assistant response.",
    } as unknown as ChatMessage;
    const annotation: ChatInlineAnnotationInput = {
      id: "30000000-0000-4000-8000-000000000001",
      selectedText: "assistant response",
      comment: null,
      sourceConversationId: conversation.id,
      sourceMessageId: sourceMessage.id,
      surface: "assistant_body",
      sourceHash: "a".repeat(64),
      start: 9,
      end: 27,
      prefix: "The full ",
      suffix: ".",
    };

    const target = sideChatTargetFromMessage(conversation, sourceMessage, annotation);

    expect(target.sourcePreview).toBe(annotation.selectedText);
    expect(target.inlineAnnotations).toEqual([annotation]);
    expect(target.inlineAnnotations?.[0]).not.toBe(annotation);
    expect(sourceMessage.body).toBe("The full assistant response.");
  });
});

describe("queuedMessagePayloadForBodyEdit", () => {
  it("omits annotations so the server preserves their queued assets", () => {
    const payload = queuedMessagePayloadForBodyEdit({
      body: "",
      inlineAnnotations: [{
        id: "00000000-0000-4000-8000-000000000001",
        selectedText: "quoted answer",
        comment: "Explain this",
        sourceConversationId: "00000000-0000-4000-8000-000000000002",
        sourceMessageId: "00000000-0000-4000-8000-000000000003",
        surface: "assistant_body",
        sourceHash: "a".repeat(64),
        start: 4,
        end: 17,
        prefix: "the ",
        suffix: " next",
        attachmentIds: ["00000000-0000-4000-8000-000000000004"],
      }],
      attachmentIds: [],
      skillRefs: [],
    }, "Updated prompt");

    expect(payload).toEqual({
      body: "Updated prompt",
      attachmentIds: [],
      skillRefs: [],
    });
    expect(payload).not.toHaveProperty("inlineAnnotations");
  });
});
