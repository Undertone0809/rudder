// @vitest-environment jsdom

import { agentsApi } from "@/api/agents";
import { chatsApi } from "@/api/chats";
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
    sendFirstMessageStream: vi.fn(),
    sendMessageStream: vi.fn(),
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

function renderPanel(onReplaceTarget = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [panelTarget, setPanelTarget] = useState(target);
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
  return { container, onReplaceTarget };
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
});
