// @vitest-environment jsdom

import { chatsApi } from "@/api/chats";
import { RunFeedbackChatPanel } from "@/components/side-panel/RunFeedbackChatPanel";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import type { ChatMessage, ChatStreamEvent } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn(async () => [{ id: "agent-1", name: "Noah" }]) },
}));

vi.mock("@/api/chats", () => ({
  chatsApi: {
    get: vi.fn(async () => ({ id: "chat-1", title: "Run feedback" })),
    listMessages: vi.fn(async () => []),
    sendMessageStream: vi.fn(),
    sendFirstMessageStream: vi.fn(),
    listQueue: vi.fn(),
    stopMessageStream: vi.fn(),
  },
}));

vi.mock("@/api/health", () => ({
  healthApi: { get: vi.fn(async () => ({ devServer: false })) },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: { list: vi.fn(async () => []) },
}));

vi.mock("@/components/ProjectIdentity", () => ({
  ProjectIcon: () => <span />,
}));

vi.mock("@/components/chat/ChatComposer", () => ({
  ChatComposerEditor: ({ value, onChange, onSubmit }: { value: string; onChange: (value: string) => void; onSubmit: () => void }) => (
    <textarea
      aria-label="Feedback draft"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmit();
      }}
    />
  ),
  ChatComposerSendButton: ({ mode, disabled, onClick, ariaLabel }: { mode: string; disabled: boolean; onClick: () => void; ariaLabel: string }) => (
    <button type="button" data-mode={mode} aria-label={ariaLabel} disabled={disabled} onClick={onClick}>
      {mode}
    </button>
  ),
  ChatComposerSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ChatComposerToolbar: ({ actions, children }: { actions: ReactNode; children: ReactNode }) => <div>{children}{actions}</div>,
}));

vi.mock("@/components/chat/ResponseAnnotations", () => ({
  DraftResponseAnnotationsPopover: () => null,
  ResponseAnnotationEditor: () => null,
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/lib/run-feedback-pending-files", () => ({
  consumeRunFeedbackPendingFiles: () => ({}),
}));

vi.mock("@/pages/Chat.messages", () => ({
  ChatMessageItem: ({ message }: { message: ChatMessage }) => <div>{message.body}</div>,
  StreamTranscriptItem: () => null,
}));

const target: Extract<SidePanelTarget, { kind: "run_feedback_chat" }> = {
  kind: "run_feedback_chat",
  agentId: "agent-1",
  organizationId: "org-1",
  conversationId: "chat-1",
  projectLocked: true,
  clientMutationId: "mutation-1",
  projectId: null,
  body: "Feedback",
  inlineAnnotations: [],
  label: "Run feedback",
};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const assistantMessage = {
  id: "assistant-1",
  role: "assistant",
  body: "Partial response",
  status: "streaming",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  transcript: [],
} as unknown as ChatMessage;

describe("RunFeedbackChatPanel stop control", () => {
  let root: Root;
  let host: HTMLDivElement;
  let queryClient: QueryClient;
  let releaseStream: (() => void) | undefined;
  let releaseFirstStream: (() => void) | undefined;
  let emitStreamEvent: ((event: ChatStreamEvent) => Promise<void> | void) | undefined;
  let queueTerminal = false;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    releaseStream = undefined;
    releaseFirstStream = undefined;
    emitStreamEvent = undefined;
    queueTerminal = false;
    vi.mocked(chatsApi.listQueue).mockReset().mockImplementation(async () => ({
      activeGenerationId: queueTerminal ? null : "generation-1",
      activeAttemptEpoch: queueTerminal ? null : 4,
      activeControlVersion: queueTerminal ? null : 9,
      activeGenerationStatus: queueTerminal ? null : "running",
      items: [],
    }));
    vi.mocked(chatsApi.sendMessageStream).mockReset().mockImplementation(async (_chatId, _body, options) => {
      emitStreamEvent = options.onEvent;
      await options.onEvent({
        type: "ack",
        userMessage: { ...assistantMessage, id: "user-1", role: "user", body: "Feedback", conversationId: "chat-1" },
        generationId: "generation-1",
        attemptEpoch: 4,
        generationSeq: 7,
        bodyHash: "hash-at-ack",
      });
      await options.onEvent({
        type: "assistant_delta",
        delta: "Partial response",
        generationId: "generation-1",
        attemptEpoch: 4,
        generationSeq: 8,
        bodyHash: "hash-at-delta",
      });
      await options.onEvent({
        type: "transcript_entry",
        entry: { kind: "tool_call", ts: new Date().toISOString(), name: "inspect", input: {} },
        generationId: "generation-1",
        attemptEpoch: 4,
        generationSeq: 9,
        bodyHash: "hash-at-transcript",
      });
      await new Promise<void>((resolve) => {
        releaseStream = resolve;
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    vi.mocked(chatsApi.sendFirstMessageStream).mockReset().mockImplementation(async (_orgId, _body, options) => {
      await new Promise<void>((resolve) => {
        releaseFirstStream = resolve;
      });
      await options.onEvent({
        type: "ack",
        userMessage: { ...assistantMessage, id: "user-2", role: "user", body: "Feedback", conversationId: "chat-2" },
      });
    });
    vi.mocked(chatsApi.stopMessageStream).mockReset().mockImplementation(async (_chatId, request) => {
      const controlActionId = request?.controlActionId ?? "test-control-action";
      queueTerminal = true;
      return {
        stopped: true,
        controlActionId,
        generationId: "generation-1",
        disposition: "stopping",
      };
    });
  });

  afterEach(async () => {
    await act(async () => {
      releaseStream?.();
      releaseFirstStream?.();
      await Promise.resolve();
    });
    act(() => root.unmount());
    queryClient.clear();
    host.remove();
  });

  it("exposes Stop while feedback streams and aborts only after the server accepts the cutoff", async () => {
    const onReplaceTarget = vi.fn();
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={target}
            onReplaceTarget={onReplaceTarget}
          />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => expect(host.querySelector('[aria-label="Send feedback"]')).not.toBeNull());
    act(() => (host.querySelector('[aria-label="Send feedback"]') as HTMLButtonElement).click());
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Stop feedback"]')).not.toBeNull());
    });

    await act(async () => {
      (host.querySelector('[aria-label="Stop feedback"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(chatsApi.stopMessageStream).toHaveBeenCalledWith("chat-1", expect.objectContaining({
        controlActionId: expect.any(String),
        expectedGenerationId: "generation-1",
        expectedAttemptEpoch: 4,
        expectedControlVersion: 9,
        lastCommittedRenderSeq: 9,
        renderedBodyHash: "hash-at-transcript",
      })));
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Send feedback"]')).not.toBeNull());
    });
    expect(host.querySelector('[aria-label="Stopping feedback"]')).toBeNull();

    await act(async () => {
      await emitStreamEvent?.({
        type: "assistant_delta",
        delta: "late output",
        generationId: "generation-1",
        attemptEpoch: 4,
        generationSeq: 9,
        bodyHash: "late-hash",
      });
      await emitStreamEvent?.({ type: "final", messages: [{ ...assistantMessage, body: "late final" }] });
    });
    expect(host.querySelector('[data-testid="run-feedback-chat-streaming"]')).toBeNull();
  });

  it("keeps the Stop state while the server is still converging", async () => {
    const onReplaceTarget = vi.fn();
    let resolveStop: (() => void) | undefined;
    vi.mocked(chatsApi.stopMessageStream).mockImplementationOnce(async (_chatId, request) => {
      return await new Promise((resolve) => {
        resolveStop = () => {
          queueTerminal = true;
          resolve({
            stopped: true,
            controlActionId: request?.controlActionId ?? "test-control-action",
            generationId: "generation-1",
            disposition: "stopping",
          });
        };
      });
    });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={target}
            onReplaceTarget={onReplaceTarget}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Send feedback"]')).not.toBeNull());
    });
    act(() => (host.querySelector('[aria-label="Send feedback"]') as HTMLButtonElement).click());
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Stop feedback"]')).not.toBeNull());
    });

    act(() => (host.querySelector('[aria-label="Stop feedback"]') as HTMLButtonElement).click());
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Stopping feedback"]')).not.toBeNull());
      await vi.waitFor(() => expect(chatsApi.stopMessageStream).toHaveBeenCalledTimes(1));
    });
    expect((host.querySelector('[aria-label="Stopping feedback"]') as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('[aria-label="Send feedback"]')).toBeNull();

    await act(async () => {
      resolveStop?.();
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Send feedback"]')).not.toBeNull());
    });
  });

  it("omits the generation fence when the queue snapshot is partial", async () => {
    vi.mocked(chatsApi.listQueue).mockImplementation(async () => ({
      activeGenerationId: "generation-1",
      activeAttemptEpoch: null,
      activeControlVersion: null,
      activeGenerationStatus: "running",
      items: [],
    }));
    vi.mocked(chatsApi.stopMessageStream).mockImplementationOnce(async (_chatId, request) => ({
      stopped: true,
      controlActionId: request?.controlActionId ?? "test-control-action",
      generationId: "generation-1",
      disposition: "stopped",
    }));
    const onReplaceTarget = vi.fn();
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={target}
            onReplaceTarget={onReplaceTarget}
          />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Send feedback"]')).not.toBeNull());
    act(() => (host.querySelector('[aria-label="Send feedback"]') as HTMLButtonElement).click());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Stop feedback"]')).not.toBeNull());
    await act(async () => {
      (host.querySelector('[aria-label="Stop feedback"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(chatsApi.stopMessageStream).toHaveBeenCalledTimes(1));
    });

    const request = vi.mocked(chatsApi.stopMessageStream).mock.calls[0]?.[1];
    expect(request).not.toHaveProperty("expectedGenerationId");
    expect(request).not.toHaveProperty("expectedAttemptEpoch");
    expect(request).not.toHaveProperty("expectedControlVersion");
  });

  it("holds late events outside the UI until the Stop response accepts or rejects them", async () => {
    const onReplaceTarget = vi.fn();
    let resolveStop: ((value: { stopped: boolean; controlActionId: string; generationId: string; disposition: string }) => void) | undefined;
    vi.mocked(chatsApi.stopMessageStream).mockImplementationOnce(async (_chatId, request) => await new Promise((resolve) => {
      resolveStop = () => {
        queueTerminal = true;
        resolve({
          stopped: true,
          controlActionId: request?.controlActionId ?? "test-control-action",
          generationId: "generation-1",
          disposition: "stopping",
        });
      };
    }));
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={target}
            onReplaceTarget={onReplaceTarget}
          />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Send feedback"]')).not.toBeNull());
    act(() => (host.querySelector('[aria-label="Send feedback"]') as HTMLButtonElement).click());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Stop feedback"]')).not.toBeNull());
    await act(async () => {
      (host.querySelector('[aria-label="Stop feedback"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(chatsApi.stopMessageStream).toHaveBeenCalledTimes(1));
    });
    await act(async () => {
      await emitStreamEvent?.({
        type: "assistant_delta",
        delta: "late output",
        generationId: "generation-1",
        attemptEpoch: 4,
        generationSeq: 9,
        bodyHash: "late-hash",
      });
      await emitStreamEvent?.({ type: "final", messages: [{ ...assistantMessage, body: "late final" }] });
    });
    expect(host.textContent).not.toContain("late output");
    expect(host.textContent).not.toContain("late final");

    await act(async () => {
      resolveStop?.({ stopped: true, controlActionId: "test-control-action", generationId: "generation-1", disposition: "stopping" });
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Send feedback"]')).not.toBeNull());
    });
  });

  it("does not stop or render an old stream after switching conversations", async () => {
    const onReplaceTarget = vi.fn();
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={target}
            onReplaceTarget={onReplaceTarget}
          />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Send feedback"]')).not.toBeNull());
    act(() => (host.querySelector('[aria-label="Send feedback"]') as HTMLButtonElement).click());
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Stop feedback"]')).not.toBeNull());

    const nextTarget = { ...target, conversationId: "chat-2", clientMutationId: "mutation-2", body: "Other feedback" };
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={nextTarget}
            onReplaceTarget={onReplaceTarget}
          />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Sending feedback"]')).not.toBeNull());
    expect(host.querySelector('[aria-label="Stop feedback"]')).toBeNull();
    await act(async () => {
      await emitStreamEvent?.({
        type: "assistant_delta",
        delta: "wrong target output",
        generationId: "generation-1",
        attemptEpoch: 4,
        generationSeq: 9,
        bodyHash: "wrong-target-hash",
      });
    });
    expect(host.textContent).not.toContain("wrong target output");
    expect(chatsApi.stopMessageStream).not.toHaveBeenCalled();
  });

  it("does not reuse a previous conversation when the side panel switches to a draft", async () => {
    const onReplaceTarget = vi.fn();
    const draftTarget = { ...target, conversationId: null, projectLocked: false };
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={target}
            onReplaceTarget={onReplaceTarget}
          />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Send feedback"]')).not.toBeNull());

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={draftTarget}
            onReplaceTarget={onReplaceTarget}
          />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Send feedback"]')).not.toBeNull());

    expect(host.querySelector('[aria-label="Stop feedback"]')).toBeNull();

    act(() => (host.querySelector('[aria-label="Send feedback"]') as HTMLButtonElement).click());
    await vi.waitFor(() => expect(chatsApi.sendFirstMessageStream).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(host.querySelector('[aria-label="Sending feedback"]')).not.toBeNull());
    expect(host.querySelector('[aria-label="Stop feedback"]')).toBeNull();

    await act(async () => {
      releaseFirstStream?.();
      await Promise.resolve();
    });
  });
});
