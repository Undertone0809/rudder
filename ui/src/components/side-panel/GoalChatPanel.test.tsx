// @vitest-environment jsdom

import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import * as chatSendMutationStorage from "@/lib/chat-send-mutation-storage";
import {
  createPendingChatStopRecovery,
  readPendingChatStopRecovery,
  savePendingChatStopRecovery,
} from "@/lib/chat-stop-recovery";
import { queryKeys } from "@/lib/queryKeys";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalChatPanel } from "./GoalChatPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigate = vi.fn();

vi.mock("@/lib/router", () => ({ useNavigate: () => navigate }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn() } }));
vi.mock("@/api/chats", () => ({
  chatsApi: {
    get: vi.fn(),
    listMessages: vi.fn(),
    listQueue: vi.fn(),
    getNativeChatCapabilities: vi.fn(),
    readNativeChatControl: vi.fn(),
    readNativeChatRecovery: vi.fn(),
    sendFirstMessageStream: vi.fn(),
    sendMessageStream: vi.fn(),
    reconcilePendingMessageSend: vi.fn(),
    stopMessageStream: vi.fn(),
  },
}));
vi.mock("@/pages/Chat.messages", () => ({
  ChatMessageItem: ({ message }: { message: { body?: string | null } }) => <div>{message.body}</div>,
  StreamTranscriptItem: () => null,
}));
vi.mock("@/components/chat/ChatComposer", () => ({
  ChatComposerSurface: ({ children, testId }: { children: ReactNode; testId?: string }) => <div data-testid={testId}>{children}</div>,
  ChatComposerEditor: ({ value, onChange, onSubmit, placeholder, readOnly }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    placeholder: string;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label="Goal chat message"
      value={value}
      placeholder={placeholder}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onSubmit();
      }}
    />
  ),
  ChatComposerToolbar: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => <div>{children}{actions}</div>,
  ChatComposerSendButton: ({ ariaLabel, disabled, onClick }: { ariaLabel: string; disabled: boolean; onClick: () => void }) => (
    <button type="button" aria-label={ariaLabel} disabled={disabled} onClick={onClick}>Send</button>
  ),
}));

const target: Extract<SidePanelTarget, { kind: "goal_chat" }> = {
  kind: "goal_chat",
  organizationId: "org-1",
  goalId: "goal-1",
  agentId: "agent-1",
  conversationId: null,
  clientMutationId: "goal-chat-mutation-1",
  body: "",
  label: "Ship Goal v2",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const baseNavigator = globalThis.navigator;

function installWebLocksStub() {
  const queues = new Map<string, Promise<void>>();
  const locks = {
    request: async <T,>(name: string, _options: LockOptions, callback: (lock: Lock) => T | Promise<T>) => {
      const previous = queues.get(name) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      queues.set(name, previous.then(() => gate));
      await previous;
      try {
        return await callback({ name, mode: "exclusive" } as Lock);
      } finally {
        release();
      }
    },
  } as LockManager;
  const navigatorStub = Object.create(baseNavigator) as Navigator;
  Object.defineProperty(navigatorStub, "locks", { configurable: true, value: locks });
  vi.stubGlobal("navigator", navigatorStub);
}

function renderPanel(
  onReplaceTarget = vi.fn(),
  initialTarget: Extract<SidePanelTarget, { kind: "goal_chat" }> = target,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [panelTarget, setPanelTarget] = useState(initialTarget);
    return (
      <GoalChatPanel
        target={panelTarget}
        onReplaceTarget={(key, next) => {
          onReplaceTarget(key, next);
          if (next.kind === "goal_chat") setPanelTarget(next);
        }}
      />
    );
  }
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
  });
  return { container, onReplaceTarget, queryClient };
}

async function waitUntil(assertion: () => void) {
  const started = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - started > 2500) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function change(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  installWebLocksStub();
  vi.mocked(agentsApi.list).mockResolvedValue([{ id: "agent-1", name: "Goal owner" }] as never);
  vi.mocked(chatsApi.get).mockResolvedValue(null as never);
  vi.mocked(chatsApi.listMessages).mockResolvedValue([
    { id: "message-user", conversationId: "chat-goal-1", role: "user", body: "Review the current Goal progress" },
    { id: "message-assistant", conversationId: "chat-goal-1", role: "assistant", body: "Working from the Goal context." },
  ] as never);
  vi.mocked(chatsApi.listQueue).mockResolvedValue({
    activeGenerationId: "generation-1",
    activeAttemptEpoch: 2,
    activeControlVersion: 3,
    activeGenerationStatus: "running",
    items: [],
  } as never);
  vi.mocked(chatsApi.getNativeChatCapabilities).mockResolvedValue({
    executionAuthority: "native_rust",
    firstSend: true,
    readTurn: true,
    nativeControls: true,
    recoveryRead: true,
  });
  vi.mocked(chatsApi.readNativeChatControl).mockResolvedValue({
    executionAuthority: "native_rust",
    orgId: "org-1",
    conversationId: "chat-goal-1",
    generationId: "generation-1",
    attemptEpoch: 2,
    controlVersion: 3,
    lastClientCheckpointSeq: null,
    lastClientCheckpointHash: null,
    lastSequence: 0,
    runtimeTerminal: false,
  });
  vi.mocked(chatsApi.readNativeChatRecovery).mockResolvedValue({
    executionAuthority: "native_rust",
    orgId: "org-1",
    conversationId: "chat-goal-1",
    recovery: null,
  });
  vi.mocked(chatsApi.sendFirstMessageStream).mockImplementation(async (_orgId, body, options) => {
    await options.onEvent({
      type: "ack",
      userMessage: { id: "message-user", conversationId: "chat-goal-1", role: "user", body },
    } as never);
    await options.onEvent({
      type: "final",
      messages: [{ id: "message-assistant", conversationId: "chat-goal-1", role: "assistant", body: "Working from the Goal context." }],
    } as never);
  });
  vi.mocked(chatsApi.sendMessageStream).mockResolvedValue(undefined);
  vi.mocked(chatsApi.reconcilePendingMessageSend).mockReset().mockImplementation(async (_conversationId, request) => ({
    outcome: "not_found",
    clientMutationId: request.clientMutationId,
  }));
  vi.mocked(chatsApi.stopMessageStream).mockImplementation(async (_chatId, request) => ({
    stopped: true,
    disposition: "stopped",
    controlActionId: request!.controlActionId,
    generationId: request!.expectedGenerationId!,
  }));
  window.localStorage.clear();
  navigate.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GoalChatPanel", () => {
  it("hydrates the composer from the new Goal when the scope changes with the same body prop", async () => {
    const initialTarget = { ...target, body: "Shared body" };
    const nextTarget = { ...initialTarget, organizationId: "org-2", goalId: "goal-2" };
    const onReplaceTarget = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const renderTarget = (value: typeof initialTarget) => root?.render(
      <QueryClientProvider client={queryClient}>
        <GoalChatPanel target={value} onReplaceTarget={onReplaceTarget} />
      </QueryClientProvider>,
    );

    await act(async () => renderTarget(initialTarget));
    const editor = container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!;
    change(editor, "Unsaved text from the previous Goal");
    expect(editor.value).toBe("Unsaved text from the previous Goal");

    await act(async () => renderTarget(nextTarget));
    expect(editor.value).toBe("Shared body");
  });

  it("creates a real Chat anchored to the Goal and persists the resumed target", async () => {
    const onReplaceTarget = vi.fn();
    const rendered = renderPanel(onReplaceTarget);
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    const editor = rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!;
    change(editor, "Review the current Goal progress");

    expect(onReplaceTarget).toHaveBeenCalledWith("goal-chat:org-1:goal-1", expect.objectContaining({
      goalId: "goal-1",
      body: "Review the current Goal progress",
    }));

    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await waitUntil(() => expect(chatsApi.sendFirstMessageStream).toHaveBeenCalledTimes(1));
    expect(chatsApi.sendFirstMessageStream).toHaveBeenCalledWith("org-1", "Review the current Goal progress", expect.objectContaining({
      preferredAgentId: "agent-1",
      clientMutationId: "goal-chat-mutation-1",
      contextLinks: [{ entityType: "goal", entityId: "goal-1" }],
    }));
    await waitUntil(() => expect(onReplaceTarget).toHaveBeenCalledWith("goal-chat:org-1:goal-1", expect.objectContaining({
      conversationId: "chat-goal-1",
      body: "",
    })));
    await waitUntil(() => expect(JSON.parse(window.localStorage.getItem("rudder.goal-chat:org-1:goal-1") ?? "null")).toMatchObject({
      conversationId: "chat-goal-1",
      body: "",
    }));
    await waitUntil(() => expect(rendered.container.textContent).toContain("Working from the Goal context."));
  });

  it("replaces Goal stream text with the latest fenced snapshot", async () => {
    const pending = deferred<void>();
    vi.mocked(chatsApi.sendFirstMessageStream).mockImplementationOnce(async (_orgId, body, options) => {
      await options.onEvent({
        type: "ack",
        userMessage: { id: "message-user", conversationId: "chat-goal-1", role: "user", body },
        generationId: "generation-snapshot",
        attemptEpoch: 4,
        generationSeq: 1,
        bodyHash: "1".repeat(64),
      } as never);
      await options.onEvent({
        type: "assistant_delta",
        delta: "obsolete partial",
        generationId: "generation-snapshot",
        attemptEpoch: 4,
        generationSeq: 2,
        bodyHash: "2".repeat(64),
      } as never);
      await options.onEvent({
        type: "assistant_snapshot",
        body: "canonical snapshot",
        generationId: "generation-snapshot",
        attemptEpoch: 4,
        generationSeq: 3,
        bodyHash: "3".repeat(64),
      } as never);
      await options.onEvent({
        type: "assistant_snapshot",
        body: "duplicate must not replace",
        generationId: "generation-snapshot",
        attemptEpoch: 4,
        generationSeq: 3,
        bodyHash: "4".repeat(64),
      } as never);
      await options.onEvent({
        type: "assistant_snapshot",
        body: "stale attempt must not replace",
        generationId: "generation-snapshot",
        attemptEpoch: 3,
        generationSeq: 4,
        bodyHash: "5".repeat(64),
      } as never);
      await options.onEvent({
        type: "assistant_delta",
        delta: " plus tail",
        generationId: "generation-snapshot",
        attemptEpoch: 4,
        generationSeq: 4,
        bodyHash: "6".repeat(64),
      } as never);
      await pending.promise;
    });

    const rendered = renderPanel();
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Check snapshot replacement");
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());

    await waitUntil(() => expect(rendered.container.querySelector('[data-testid="goal-chat-streaming"]')?.textContent)
      .toBe("canonical snapshot plus tail"));
    await act(async () => pending.resolve());
  });

  it("keeps a clear Agent working state visible while a Goal chat run is active", async () => {
    let finish: (() => void) | null = null;
    vi.mocked(chatsApi.sendFirstMessageStream).mockImplementationOnce(async (_orgId, body, options) => {
      await options.onEvent({
        type: "ack",
        userMessage: { id: "message-user", conversationId: "chat-goal-1", role: "user", body },
      } as never);
      await new Promise<void>((resolve) => { finish = resolve; });
      await options.onEvent({ type: "final", messages: [] } as never);
    });

    const rendered = renderPanel();
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Advance this Goal");
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());

    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner is working..."));
    expect(rendered.container.querySelector('[data-testid="goal-chat-working"]')).not.toBeNull();

    await act(async () => { finish?.(); });
    await waitUntil(() => expect(rendered.container.querySelector('[data-testid="goal-chat-working"]')).toBeNull());
  });

  it("stops a long-running Goal chat and offers a retry", async () => {
    vi.mocked(chatsApi.sendFirstMessageStream).mockImplementationOnce(async (_orgId, body, options) => {
      await options.onEvent({
        type: "ack",
        userMessage: { id: "message-user", conversationId: "chat-goal-1", role: "user", body },
      } as never);
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });

    const rendered = renderPanel();
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Advance this Goal");
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await waitUntil(() => expect(rendered.container.querySelector('[aria-label="Stop streaming"]')).not.toBeNull());
    await waitUntil(() => expect(rendered.queryClient.getQueryData(
      queryKeys.chats.queue("org-1", "chat-goal-1"),
    )).toMatchObject({ activeGenerationId: "generation-1" }));

    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Stop streaming"]')?.click());

    await waitUntil(() => expect(chatsApi.stopMessageStream).toHaveBeenCalledWith("chat-goal-1", expect.objectContaining({
      controlActionId: expect.any(String),
      expectedGenerationId: "generation-1",
      expectedAttemptEpoch: 2,
      expectedControlVersion: 3,
      lastCommittedRenderSeq: 0,
      renderedBodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    })));
    await waitUntil(() => expect(rendered.container.textContent).toContain("Response stopped."));
    expect(rendered.container.textContent).toContain("Retry message");
    expect(readPendingChatStopRecovery("org-1", "chat-goal-1")).toBeNull();
  });

  it("settles an owner-lost Stop without claiming cleanup or offering retry", async () => {
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (_chatId, body, options) => {
      await options.onEvent({
        type: "ack",
        generationId: "generation-1",
        attemptEpoch: 2,
        userMessage: { id: "message-user", conversationId: "chat-goal-1", role: "user", body },
      } as never);
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    vi.mocked(chatsApi.listQueue).mockResolvedValue({
      activeGenerationId: "generation-1",
      activeAttemptEpoch: 2,
      activeControlVersion: 3,
      activeGenerationStatus: "running",
      items: [],
    } as never);
    vi.mocked(chatsApi.stopMessageStream).mockImplementationOnce(async (_chatId, request) => {
      vi.mocked(chatsApi.listQueue).mockResolvedValue({
        activeGenerationId: null,
        activeAttemptEpoch: null,
        activeControlVersion: null,
        activeGenerationStatus: null,
        items: [],
      } as never);
      vi.mocked(chatsApi.readNativeChatRecovery).mockResolvedValueOnce({
        executionAuthority: "native_rust",
        orgId: "org-1",
        conversationId: "chat-goal-1",
        recovery: {
          generationId: "generation-1",
          runId: "run-1",
          attemptEpoch: 2,
          generationStatus: "interrupted_unverified",
          controlState: "control_lost",
          cleanupState: "unknown",
        },
      });
      return {
        stopped: false,
        disposition: "control_lost",
        controlActionId: request!.controlActionId,
        generationId: request!.expectedGenerationId!,
        idempotent: false,
      };
    });

    const rendered = renderPanel(vi.fn(), { ...target, conversationId: "chat-goal-1" });
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Advance this Goal");
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await waitUntil(() => expect(rendered.container.querySelector('[aria-label="Stop streaming"]')).not.toBeNull());

    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Stop streaming"]')?.click());

    await waitUntil(() => expect(rendered.container.querySelector('[data-testid="goal-chat-owner-loss-blocked"]')).not.toBeNull());
    expect(rendered.container.textContent).toContain("Runtime cleanup could not be verified");
    expect(rendered.container.querySelector('[aria-label="Stop streaming"]')).toBeNull();
    expect(rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
    expect(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')?.readOnly).toBe(true);
    expect(rendered.container.textContent).not.toContain("Response stopped.");
    expect(rendered.container.textContent).not.toContain("Retry message");
    expect(readPendingChatStopRecovery("org-1", "chat-goal-1")).toBeNull();
  });

  it("reopens a held generation from the durable recovery pointer when the legacy queue has no active generation", async () => {
    vi.mocked(chatsApi.listQueue).mockResolvedValue({
      activeGenerationId: null,
      activeAttemptEpoch: null,
      activeControlVersion: null,
      activeGenerationStatus: null,
      items: [],
    } as never);
    vi.mocked(chatsApi.readNativeChatRecovery).mockResolvedValue({
      executionAuthority: "native_rust",
      orgId: "org-1",
      conversationId: "chat-goal-1",
      recovery: {
        generationId: "generation-1",
        runId: "run-1",
        attemptEpoch: 2,
        generationStatus: "interrupted_unverified",
        controlState: "control_lost",
        cleanupState: "unknown",
      },
    });

    const rendered = renderPanel(vi.fn(), { ...target, conversationId: "chat-goal-1" });
    await waitUntil(() => expect(rendered.container.querySelector('[data-testid="goal-chat-owner-loss-blocked"]')).not.toBeNull());

    expect(rendered.container.querySelector('[aria-label="Stop streaming"]')).toBeNull();
    expect(rendered.container.querySelector('[aria-label="Continue response"]')).toBeNull();
    expect(rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
    expect(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')?.readOnly).toBe(true);
  });

  it("blocks Goal sends when a native recovery pointer cannot be read", async () => {
    vi.mocked(chatsApi.listQueue).mockResolvedValue({
      activeGenerationId: null,
      activeAttemptEpoch: null,
      activeControlVersion: null,
      activeGenerationStatus: null,
      items: [],
    } as never);
    vi.mocked(chatsApi.readNativeChatRecovery).mockRejectedValue(new Error("read failed"));

    const rendered = renderPanel(vi.fn(), { ...target, conversationId: "chat-goal-1" });
    await waitUntil(() => expect(rendered.container.querySelector('[data-testid="goal-chat-recovery-status-unavailable"]')).not.toBeNull());

    expect(rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
    expect(rendered.container.textContent).toContain("Sending is paused");
  });

  it("retains the legacy Stop route when the Native capability endpoint is absent", async () => {
    vi.mocked(chatsApi.getNativeChatCapabilities).mockResolvedValue(null);
    vi.mocked(chatsApi.sendFirstMessageStream).mockImplementationOnce(async (_orgId, body, options) => {
      await options.onEvent({
        type: "ack",
        userMessage: { id: "message-user", conversationId: "chat-goal-1", role: "user", body },
      } as never);
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });

    const rendered = renderPanel();
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Advance this Goal");
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await waitUntil(() => expect(rendered.container.querySelector('[aria-label="Stop streaming"]')).not.toBeNull());
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Stop streaming"]')?.click());

    await waitUntil(() => expect(chatsApi.stopMessageStream).toHaveBeenCalledTimes(1));
    expect(chatsApi.readNativeChatControl).not.toHaveBeenCalled();
    expect(chatsApi.stopMessageStream).toHaveBeenCalledWith("chat-goal-1", expect.objectContaining({
      controlActionId: expect.any(String),
      expectedGenerationId: "generation-1",
      expectedAttemptEpoch: 2,
      expectedControlVersion: 3,
    }));
    await waitUntil(() => expect(rendered.container.textContent).toContain("Response stopped."));
  });

  it("repairs an incomplete Goal Stop after reopen only for the original generation and attempt", async () => {
    const saved = createPendingChatStopRecovery({
      orgId: "org-1",
      chatId: "chat-goal-1",
      request: {
        controlActionId: "goal-old-stop",
        expectedGenerationId: "generation-1",
        expectedAttemptEpoch: 2,
      },
      frozenDraft: null,
    });
    savePendingChatStopRecovery(saved);

    const rendered = renderPanel(vi.fn(), { ...target, conversationId: "chat-goal-1" });
    await waitUntil(() => expect(chatsApi.stopMessageStream).toHaveBeenCalledTimes(1));

    expect(chatsApi.readNativeChatControl).toHaveBeenCalledWith("chat-goal-1", "org-1", "generation-1");
    expect(chatsApi.stopMessageStream).toHaveBeenCalledWith("chat-goal-1", {
      controlActionId: "goal-old-stop",
      expectedGenerationId: "generation-1",
      expectedAttemptEpoch: 2,
      expectedControlVersion: 3,
      lastCommittedRenderSeq: 0,
      renderedBodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    await waitUntil(() => expect(rendered.container.textContent).toContain("Response stopped."));
    expect(readPendingChatStopRecovery("org-1", "chat-goal-1")).toBeNull();
  });

  it("drops an incomplete Goal Stop instead of applying it to a replacement run", async () => {
    savePendingChatStopRecovery(createPendingChatStopRecovery({
      orgId: "org-1",
      chatId: "chat-goal-1",
      request: {
        controlActionId: "goal-obsolete-stop",
        expectedGenerationId: "generation-1",
        expectedAttemptEpoch: 2,
      },
      frozenDraft: null,
    }));
    vi.mocked(chatsApi.listQueue).mockResolvedValue({
      activeGenerationId: "generation-2",
      activeAttemptEpoch: 1,
      activeControlVersion: 4,
      activeGenerationStatus: "running",
      items: [],
    } as never);
    vi.mocked(chatsApi.readNativeChatControl).mockResolvedValue({
      executionAuthority: "native_rust",
      orgId: "org-1",
      conversationId: "chat-goal-1",
      generationId: "generation-2",
      attemptEpoch: 1,
      controlVersion: 4,
      lastClientCheckpointSeq: null,
      lastClientCheckpointHash: null,
      lastSequence: 0,
      runtimeTerminal: false,
    });

    const rendered = renderPanel(vi.fn(), { ...target, conversationId: "chat-goal-1" });
    await waitUntil(() => expect(rendered.container.textContent).toContain("The earlier Stop could not be tied to this response."));

    expect(chatsApi.readNativeChatControl).toHaveBeenCalledWith("chat-goal-1", "org-1", "generation-1");
    expect(chatsApi.stopMessageStream).not.toHaveBeenCalled();
    expect(readPendingChatStopRecovery("org-1", "chat-goal-1")).toBeNull();
    expect(rendered.container.textContent).not.toContain("Response stopped.");
  });

  it("keeps Stop disabled until the first Chat acknowledgement supplies a durable target", async () => {
    let acknowledge: (() => void) | null = null;
    vi.mocked(chatsApi.sendFirstMessageStream).mockImplementationOnce(async (_orgId, body, options) => {
      await new Promise<void>((resolve) => { acknowledge = resolve; });
      await options.onEvent({
        type: "ack",
        userMessage: { id: "message-user", conversationId: "chat-goal-1", role: "user", body },
      } as never);
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });

    const rendered = renderPanel();
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Advance this Goal");
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());

    const unavailableStop = rendered.container.querySelector<HTMLButtonElement>('[aria-label="Stop unavailable until chat starts"]')!;
    expect(unavailableStop.disabled).toBe(true);
    act(() => unavailableStop.click());
    expect(chatsApi.stopMessageStream).not.toHaveBeenCalled();
    expect(rendered.container.textContent).not.toContain("Response stopped.");

    await act(async () => { acknowledge?.(); });
    await waitUntil(() => expect(rendered.container.querySelector('[aria-label="Stop streaming"]')).not.toBeNull());
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Stop streaming"]')?.click());
    await waitUntil(() => expect(rendered.container.textContent).toContain("Response stopped."));
  });

  it("lets a committed completion converge instead of aborting it", async () => {
    let finish: (() => void) | null = null;
    let streamSignal: AbortSignal | undefined;
    vi.mocked(chatsApi.sendFirstMessageStream).mockImplementationOnce(async (_orgId, body, options) => {
      streamSignal = options.signal;
      await options.onEvent({
        type: "ack",
        userMessage: { id: "message-user", conversationId: "chat-goal-1", role: "user", body },
      } as never);
      await new Promise<void>((resolve) => { finish = resolve; });
      await options.onEvent({
        type: "final",
        messages: [{ id: "message-assistant", conversationId: "chat-goal-1", role: "assistant", body: "Completed before Stop." }],
      } as never);
    });
    vi.mocked(chatsApi.stopMessageStream).mockImplementationOnce(async (_chatId, request) => ({
      stopped: false,
      disposition: "completion_committed",
      controlActionId: request!.controlActionId,
      generationId: request!.expectedGenerationId!,
    }));

    const rendered = renderPanel();
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Advance this Goal");
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await waitUntil(() => expect(rendered.container.querySelector('[aria-label="Stop streaming"]')).not.toBeNull());
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Stop streaming"]')?.click());

    await waitUntil(() => expect(chatsApi.readNativeChatControl).toHaveBeenCalledTimes(1));
    await waitUntil(() => expect(chatsApi.stopMessageStream).toHaveBeenCalledTimes(1));
    await waitUntil(() => expect(rendered.container.textContent).toContain("Response completed before Stop reached the cutoff."));
    expect(streamSignal?.aborted).toBe(false);
    expect(rendered.container.textContent).not.toContain("Retry message");
    await act(async () => { finish?.(); });
    await waitUntil(() => expect(rendered.container.textContent).toContain("Completed before Stop."));
  });

  it("retries an ambiguous Stop with the same action after the panel reopens", async () => {
    vi.mocked(chatsApi.sendFirstMessageStream).mockImplementationOnce(async (_orgId, body, options) => {
      await options.onEvent({
        type: "ack",
        userMessage: { id: "message-user", conversationId: "chat-goal-1", role: "user", body },
      } as never);
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    vi.mocked(chatsApi.stopMessageStream)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementationOnce(async (_chatId, request) => ({
        stopped: true,
        disposition: "stopping",
        controlActionId: request!.controlActionId,
        generationId: request!.expectedGenerationId,
      } as never));

    const first = renderPanel();
    await waitUntil(() => expect(first.container.textContent).toContain("Goal owner"));
    change(first.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Advance this Goal");
    act(() => first.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await waitUntil(() => expect(first.container.querySelector('[aria-label="Stop streaming"]')).not.toBeNull());
    act(() => first.container.querySelector<HTMLButtonElement>('[aria-label="Stop streaming"]')?.click());
    await waitUntil(() => expect(first.container.textContent).toContain("Rudder could not confirm that the response stopped."));
    const firstRequest = vi.mocked(chatsApi.stopMessageStream).mock.calls[0]?.[1];
    expect(readPendingChatStopRecovery("org-1", "chat-goal-1")?.request).toEqual(firstRequest);

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    const reopened = renderPanel(vi.fn(), { ...target, conversationId: "chat-goal-1" });

    await waitUntil(() => expect(chatsApi.stopMessageStream).toHaveBeenCalledTimes(2));
    expect(vi.mocked(chatsApi.stopMessageStream).mock.calls[1]?.[1]).toEqual(firstRequest);
    await waitUntil(() => expect(reopened.container.textContent).toContain("Response stopped."));
    expect(readPendingChatStopRecovery("org-1", "chat-goal-1")).toBeNull();
  });

  it("keeps the stream running when Stop is definitively rejected", async () => {
    vi.mocked(chatsApi.getNativeChatCapabilities).mockResolvedValue(null);
    let streamSignal: AbortSignal | undefined;
    vi.mocked(chatsApi.sendFirstMessageStream).mockImplementationOnce(async (_orgId, body, options) => {
      streamSignal = options.signal;
      await options.onEvent({
        type: "ack",
        userMessage: { id: "message-user", conversationId: "chat-goal-1", role: "user", body },
      } as never);
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });
    vi.mocked(chatsApi.stopMessageStream).mockRejectedValueOnce(
      new ApiError("control version changed", 409, { error: "control version changed" }),
    );

    const rendered = renderPanel();
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Advance this Goal");
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await waitUntil(() => expect(rendered.container.querySelector('[aria-label="Stop streaming"]')).not.toBeNull());
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Stop streaming"]')?.click());

    await waitUntil(() => expect(rendered.container.textContent).toContain("Rudder did not accept the Stop request."));
    expect(rendered.container.textContent).not.toContain("control version changed");
    expect(streamSignal?.aborted).toBe(false);
    expect(readPendingChatStopRecovery("org-1", "chat-goal-1")).toBeNull();
  });

  it.each([
    ["network", new TypeError("Failed to fetch\u001b[31m internal transport detail")],
    ["incomplete-fence", new ApiError("complete_stop_fence_required raw detail", 400, { error: "complete_stop_fence_required" })],
    ["conflict", new ApiError("control version changed private detail", 409, { error: "control version changed" })],
    ["server", new ApiError("database stack trace private detail", 503, { error: "internal_error" })],
  ] as const)("keeps a truthful retry state without showing %s diagnostics", async (_label, failure) => {
    const recovery = createPendingChatStopRecovery({
      orgId: "org-1",
      chatId: "chat-goal-1",
      executionAuthority: "native_rust",
      request: {
        controlActionId: "goal-complete-stop",
        expectedGenerationId: "generation-1",
        expectedAttemptEpoch: 2,
        expectedControlVersion: 3,
        lastCommittedRenderSeq: 0,
        renderedBodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
      frozenDraft: null,
    });
    savePendingChatStopRecovery(recovery);
    vi.mocked(chatsApi.stopMessageStream).mockRejectedValueOnce(failure);

    const rendered = renderPanel(vi.fn(), { ...target, conversationId: "chat-goal-1" });
    await waitUntil(() => expect(rendered.container.textContent).toContain("Rudder could not confirm that the response stopped."));

    expect(rendered.container.textContent).not.toContain("complete_stop_fence_required");
    expect(rendered.container.textContent).not.toContain("control version changed");
    expect(rendered.container.textContent).not.toContain("database stack trace");
    expect(rendered.container.textContent).not.toContain("Failed to fetch");
    expect(rendered.container.textContent).not.toContain("internal transport detail");
    expect(readPendingChatStopRecovery("org-1", "chat-goal-1")?.request).toEqual(recovery.request);
    expect(chatsApi.stopMessageStream).toHaveBeenCalledTimes(1);
  });

  it("retries the same message after a stream failure", async () => {
    vi.mocked(chatsApi.sendFirstMessageStream).mockImplementationOnce(async (_orgId, body, options) => {
      await options.onEvent({
        type: "ack",
        userMessage: { id: "message-user", conversationId: "chat-goal-1", role: "user", body },
      } as never);
      throw new Error("Runtime unavailable");
    });
    vi.mocked(chatsApi.sendMessageStream).mockResolvedValueOnce(undefined);

    const rendered = renderPanel();
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Advance this Goal");
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await waitUntil(() => expect(rendered.container.textContent).toContain("Something went wrong. Try again."));
    expect(rendered.container.textContent).not.toContain("Runtime unavailable");

    act(() => Array.from(rendered.container.querySelectorAll("button")).find((button) => button.textContent === "Retry message")?.click());

    await waitUntil(() => expect(chatsApi.sendMessageStream).toHaveBeenCalledWith(
      "chat-goal-1",
      "Advance this Goal",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
  });

  it("retains the existing Goal chat send identity when acknowledgement is lost", async () => {
    vi.mocked(chatsApi.listQueue).mockResolvedValue({ items: [] } as never);
    vi.mocked(chatsApi.sendMessageStream).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const rendered = renderPanel(vi.fn(), { ...target, conversationId: "chat-goal-1" });
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Retry this Goal safely");
    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click();
      await Promise.resolve();
    });
    await waitUntil(() => expect(chatsApi.sendMessageStream).toHaveBeenCalledTimes(1));
    await waitUntil(() => expect(rendered.container.textContent).toContain("Retry previous message"));
    await act(async () => {
      Array.from(rendered.container.querySelectorAll("button"))
        .find((button) => button.textContent === "Retry previous message")?.click();
      await Promise.resolve();
    });
    await waitUntil(() => expect(chatsApi.sendMessageStream).toHaveBeenCalledTimes(2));
    expect(chatsApi.reconcilePendingMessageSend).toHaveBeenCalledOnce();
    const calls = vi.mocked(chatsApi.sendMessageStream).mock.calls;
    expect(calls[0][2].clientMutationId).toEqual(expect.any(String));
    expect(calls[1][2].clientMutationId).toBe(calls[0][2].clientMutationId);
    expect(calls[1][0]).toBe("chat-goal-1");
    expect(calls[1][1]).toBe("Retry this Goal safely");
  });

  it("does not dispatch or restore an old Goal send after its target changes during identity preparation", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "mutation-goal-before-scope-change"),
      subtle: { digest: vi.fn() },
    } as unknown as Crypto);
    const prepareStarted = deferred();
    const releasePrepare = deferred();
    const preparationFinished = deferred();
    const prepare = chatSendMutationStorage.preparePendingChatSendMutation;
    vi.spyOn(chatSendMutationStorage, "preparePendingChatSendMutation")
      .mockImplementation(async (input) => {
        prepareStarted.resolve();
        await releasePrepare.promise;
        try {
          return await prepare(input);
        } finally {
          preparationFinished.resolve();
        }
      });
    const firstTarget = { ...target, conversationId: "chat-goal-1" };
    const nextTarget = {
      ...firstTarget,
      organizationId: "org-2",
      goalId: "goal-2",
      conversationId: "chat-goal-2",
      body: "Draft for the new Goal",
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const renderTarget = (value: typeof firstTarget) => root?.render(
      <QueryClientProvider client={queryClient}>
        <GoalChatPanel target={value} onReplaceTarget={vi.fn()} />
      </QueryClientProvider>,
    );

    await act(async () => renderTarget(firstTarget));
    await waitUntil(() => expect(container?.textContent).toContain("Goal owner"));
    change(container!.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Old Goal body");
    act(() => container!.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await prepareStarted.promise;
    await act(async () => renderTarget(nextTarget));
    releasePrepare.resolve();
    await preparationFinished.promise;
    await waitUntil(() => expect(container!.querySelector<HTMLTextAreaElement>(
      '[aria-label="Goal chat message"]',
    )?.value).toBe("Draft for the new Goal"));

    expect(chatsApi.sendMessageStream).not.toHaveBeenCalled();
    expect(chatSendMutationStorage.readPendingChatSendMutation(
      "org-1",
      "chat-goal-1",
      null,
    )?.id).toBe("mutation-goal-before-scope-change");
    expect(container?.textContent).not.toContain("Old Goal body");
    expect(container?.textContent).not.toContain("Something went wrong. Try again.");
  });

  it("does not restore a failed Goal preparation into the newly selected Goal", async () => {
    const prepareStarted = deferred();
    const rejectPrepare = deferred();
    const preparationFinished = deferred();
    vi.spyOn(chatSendMutationStorage, "preparePendingChatSendMutation")
      .mockImplementation(async () => {
        prepareStarted.resolve();
        try {
          await rejectPrepare.promise;
          throw new Error("Expected the old Goal preparation to fail.");
        } finally {
          preparationFinished.resolve();
        }
      });
    const firstTarget = { ...target, conversationId: "chat-goal-1" };
    const nextTarget = {
      ...firstTarget,
      organizationId: "org-2",
      goalId: "goal-2",
      conversationId: "chat-goal-2",
      body: "New Goal draft",
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const renderTarget = (value: typeof firstTarget) => root?.render(
      <QueryClientProvider client={queryClient}>
        <GoalChatPanel target={value} onReplaceTarget={vi.fn()} />
      </QueryClientProvider>,
    );

    await act(async () => renderTarget(firstTarget));
    await waitUntil(() => expect(container?.textContent).toContain("Goal owner"));
    change(container!.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Old failed body");
    act(() => container!.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await prepareStarted.promise;
    await act(async () => renderTarget(nextTarget));
    rejectPrepare.reject(new Error("Old Goal identity preparation failed."));
    await preparationFinished.promise;
    await act(async () => { await Promise.resolve(); });
    await waitUntil(() => expect(container!.querySelector<HTMLTextAreaElement>(
      '[aria-label="Goal chat message"]',
    )?.value).toBe("New Goal draft"));

    expect(chatsApi.sendMessageStream).not.toHaveBeenCalled();
    expect(container?.textContent).not.toContain("Old failed body");
    expect(container?.textContent).not.toContain("Something went wrong. Try again.");
  });

  it("does not submit when durable send-identity storage is unavailable", async () => {
    const rendered = renderPanel(vi.fn(), { ...target, conversationId: "chat-goal-1" });
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Keep this retry safe");
    vi.stubGlobal("localStorage", undefined);

    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await waitUntil(() => expect(rendered.container.textContent).toContain("Something went wrong. Try again."));
    expect(chatsApi.sendMessageStream).not.toHaveBeenCalled();
  });

  it("retries a committed pre-ack Goal message as an edit of that message", async () => {
    const committedMessageId = "70000000-0000-4000-8000-000000000011";
    vi.mocked(chatsApi.sendMessageStream).mockImplementationOnce(async (
      _conversationId,
      _body,
      options,
    ) => {
      await options.onEvent({
        type: "error",
        terminal: true,
        error: "The saved message could not be hydrated.",
        messageId: committedMessageId,
      } as never);
    });
    const rendered = renderPanel(vi.fn(), { ...target, conversationId: "chat-goal-1" });
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Retry this committed Goal message");

    await act(async () => {
      rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click();
      await Promise.resolve();
    });
    await waitUntil(() => expect(rendered.container.textContent).toContain("Something went wrong. Try again."));
    const firstMutationId = vi.mocked(chatsApi.sendMessageStream).mock.calls[0][2].clientMutationId;

    await act(async () => {
      Array.from(rendered.container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent === "Retry message")?.click();
      await Promise.resolve();
    });
    await waitUntil(() => expect(chatsApi.sendMessageStream).toHaveBeenCalledTimes(2));
    const retry = vi.mocked(chatsApi.sendMessageStream).mock.calls[1];
    expect(retry[1]).toBe("Retry this committed Goal message");
    expect(retry[2].editUserMessageId).toBe(committedMessageId);
    expect(retry[2].clientMutationId).not.toBe(firstMutationId);
  });

  it("fails closed when the Goal Owner is unavailable", async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([{ id: "agent-2", name: "Unrelated Agent" }] as never);
    const rendered = renderPanel();

    await waitUntil(() => expect(rendered.container.textContent).toContain("The Goal Owner is unavailable."));
    expect(rendered.container.textContent).not.toContain("Unrelated Agent");

    const editor = rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!;
    change(editor, "Advance this Goal");
    const send = rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
    expect(send.disabled).toBe(true);
    act(() => send.click());
    expect(chatsApi.sendFirstMessageStream).not.toHaveBeenCalled();
  });

  it("fails closed when the Goal has no Owner instead of choosing the first Agent", async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([{ id: "agent-2", name: "Unrelated Agent" }] as never);
    const rendered = renderPanel(vi.fn(), { ...target, agentId: null });

    await waitUntil(() => expect(rendered.container.textContent).toContain("The Goal Owner is unavailable."));
    expect(rendered.container.textContent).not.toContain("Unrelated Agent");

    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Advance this Goal");
    const send = rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
    expect(send.disabled).toBe(true);
    act(() => send.click());
    expect(chatsApi.sendFirstMessageStream).not.toHaveBeenCalled();
  });
});
