// @vitest-environment jsdom

import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import { readPendingChatStopRecovery } from "@/lib/chat-stop-recovery";
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
    sendFirstMessageStream: vi.fn(),
    sendMessageStream: vi.fn(),
    stopMessageStream: vi.fn(),
  },
}));
vi.mock("@/pages/Chat.messages", () => ({
  ChatMessageItem: ({ message }: { message: { body?: string | null } }) => <div>{message.body}</div>,
  StreamTranscriptItem: () => null,
}));
vi.mock("@/components/chat/ChatComposer", () => ({
  ChatComposerSurface: ({ children, testId }: { children: ReactNode; testId?: string }) => <div data-testid={testId}>{children}</div>,
  ChatComposerEditor: ({ value, onChange, onSubmit, placeholder }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    placeholder: string;
  }) => (
    <textarea
      aria-label="Goal chat message"
      value={value}
      placeholder={placeholder}
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

function change(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
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
  vi.mocked(chatsApi.stopMessageStream).mockResolvedValue({ stopped: true } as never);
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
});

describe("GoalChatPanel", () => {
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
    })));
    await waitUntil(() => expect(rendered.container.textContent).toContain("Response stopped."));
    expect(rendered.container.textContent).toContain("Retry message");
    expect(readPendingChatStopRecovery("org-1", "chat-goal-1")).toBeNull();
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
    vi.mocked(chatsApi.stopMessageStream).mockResolvedValueOnce({
      stopped: false,
      disposition: "completion_committed",
    } as never);

    const rendered = renderPanel();
    await waitUntil(() => expect(rendered.container.textContent).toContain("Goal owner"));
    change(rendered.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Advance this Goal");
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await waitUntil(() => expect(rendered.container.querySelector('[aria-label="Stop streaming"]')).not.toBeNull());
    act(() => rendered.container.querySelector<HTMLButtonElement>('[aria-label="Stop streaming"]')?.click());

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
      } as never));

    const first = renderPanel();
    await waitUntil(() => expect(first.container.textContent).toContain("Goal owner"));
    change(first.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal chat message"]')!, "Advance this Goal");
    act(() => first.container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click());
    await waitUntil(() => expect(first.container.querySelector('[aria-label="Stop streaming"]')).not.toBeNull());
    act(() => first.container.querySelector<HTMLButtonElement>('[aria-label="Stop streaming"]')?.click());
    await waitUntil(() => expect(first.container.textContent).toContain("Stop confirmation pending."));
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

    await waitUntil(() => expect(rendered.container.textContent).toContain("Stop was rejected. control version changed"));
    expect(streamSignal?.aborted).toBe(false);
    expect(readPendingChatStopRecovery("org-1", "chat-goal-1")).toBeNull();
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
