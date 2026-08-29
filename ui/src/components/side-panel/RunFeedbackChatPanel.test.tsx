// @vitest-environment jsdom

import { chatsApi } from "@/api/chats";
import { ApiError } from "@/api/client";
import { healthApi } from "@/api/health";
import { projectsApi } from "@/api/projects";
import { RunFeedbackChatPanel } from "@/components/side-panel/RunFeedbackChatPanel";
import { queryKeys } from "@/lib/queryKeys";
import type { SidePanelTarget } from "@/lib/side-panel-targets";
import type { ChatInlineAnnotationInput, ChatMessage, ChatStreamEvent } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: vi.fn(async () => [
      { id: "agent-1", name: "Noah", role: "engineer", title: "Operator", status: "active" },
      { id: "agent-2", name: "Sage", role: "researcher", title: "Reviewer", status: "active" },
    ]),
  },
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
  projectsApi: { list: vi.fn(async () => [{ id: "project-1", name: "Project Alpha", color: "blue", icon: null }]) },
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
  ChatComposerContextMenu: ({ children, testId, ariaLabel }: { children: ReactNode; testId: string; ariaLabel: string }) => (
    <div role="menu" data-testid={testId} aria-label={ariaLabel}>{children}</div>
  ),
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
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

const assistantMessage = {
  id: "assistant-1",
  role: "assistant",
  body: "Partial response",
  status: "streaming",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  transcript: [],
} as unknown as ChatMessage;

const projectAlpha = {
  id: "project-1",
  name: "Project Alpha",
  color: "blue",
  icon: null,
} as unknown as Awaited<ReturnType<typeof projectsApi.list>>[number];

const annotation: ChatInlineAnnotationInput = {
  id: "30000000-0000-4000-8000-000000000001",
  selectedText: "Only failed deliveries show Retry.",
  comment: null,
  sourceConversationId: "10000000-0000-4000-8000-000000000001",
  sourceMessageId: "20000000-0000-4000-8000-000000000001",
  surface: "assistant_body",
  sourceHash: "a".repeat(64),
  start: 20,
  end: 54,
  prefix: "successful. ",
  suffix: " Continue.",
};

describe("RunFeedbackChatPanel", () => {
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
    vi.mocked(projectsApi.list).mockReset().mockResolvedValue([projectAlpha]);
    vi.mocked(healthApi.get).mockReset().mockResolvedValue({ status: "ok" });
    vi.mocked(chatsApi.get).mockReset().mockResolvedValue({ id: "chat-1", title: "Run feedback" } as never);
    vi.mocked(chatsApi.listMessages).mockReset().mockResolvedValue([]);
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

  it("ignores a legacy preferred Agent while sending the chosen Project through the Run Agent", async () => {
    const onReplaceTarget = vi.fn();
    let draftTarget = {
      ...target,
      conversationId: null,
      projectLocked: false,
      projectId: null,
      preferredAgentId: "agent-2",
    };
    const renderTarget = () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={draftTarget}
            onReplaceTarget={onReplaceTarget}
          />
        </QueryClientProvider>,
      );
    };

    await act(async () => renderTarget());
    await act(async () => {
      await vi.waitFor(() => expect(
        (host.querySelector("[data-testid='run-feedback-project-selector']") as HTMLButtonElement | null)?.disabled,
      ).toBe(false));
    });

    await act(async () => {
      (host.querySelector("[data-testid='run-feedback-project-selector']") as HTMLButtonElement).click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(document.body.textContent).toContain("Project Alpha"));
    });
    const projectOption = Array.from(document.body.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']"))
      .find((button) => button.textContent?.includes("Project Alpha"));
    expect(projectOption).toBeDefined();
    await act(async () => projectOption?.click());
    draftTarget = onReplaceTarget.mock.calls.at(-1)?.[1];
    expect(draftTarget.projectId).toBe("project-1");

    await act(async () => renderTarget());
    expect((host.querySelector("[data-testid='chat-agent-selector']") as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector("[data-testid='chat-agent-selector']")?.textContent).toContain("Noah");
    expect(draftTarget.preferredAgentId).toBe("agent-1");

    await act(async () => renderTarget());
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Send feedback"]')).not.toBeNull());
    });
    await act(async () => {
      (host.querySelector('[aria-label="Send feedback"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(chatsApi.sendFirstMessageStream).toHaveBeenCalledTimes(1));
    });
    const sendOptions = vi.mocked(chatsApi.sendFirstMessageStream).mock.calls[0]?.[2];
    expect(sendOptions?.preferredAgentId).toBe("agent-1");
    expect(sendOptions?.contextLinks).toEqual([{ entityType: "project", entityId: "project-1" }]);
    await act(async () => {
      releaseFirstStream?.();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  });

  it("automatically sends a new Debug Chat exactly once with the stable Run request", async () => {
    const onReplaceTarget = vi.fn();
    let currentTarget: Extract<SidePanelTarget, { kind: "run_debug_chat" }> = {
      kind: "run_debug_chat",
      organizationId: "org-1",
      runId: "run-1",
      agentId: "agent-1",
      preferredAgentId: "agent-1",
      conversationId: null,
      clientMutationId: "run-debug:org-1:run-1",
      projectId: null,
      body: "Investigate Run ID: run-1",
      autoSend: true,
      errorMessage: null,
      inlineAnnotations: [],
      label: "Debug Run",
    };
    onReplaceTarget.mockImplementation((_key, nextTarget) => {
      currentTarget = nextTarget as typeof currentTarget;
    });
    const renderTarget = () => root.render(
      <QueryClientProvider client={queryClient}>
        <RunFeedbackChatPanel
          organizationId="org-1"
          target={currentTarget}
          onReplaceTarget={onReplaceTarget}
        />
      </QueryClientProvider>,
    );

    await act(async () => renderTarget());
    await act(async () => {
      await vi.waitFor(() => expect(chatsApi.sendFirstMessageStream).toHaveBeenCalledTimes(1));
    });
    expect(currentTarget.autoSend).toBe(false);
    expect(chatsApi.sendFirstMessageStream).toHaveBeenCalledWith(
      "org-1",
      "Investigate Run ID: run-1",
      expect.objectContaining({
        preferredAgentId: "agent-1",
        planMode: false,
        issueCreationMode: "manual_approval",
        clientMutationId: "run-debug:org-1:run-1",
        contextLinks: [],
      }),
    );
    expect((host.querySelector('[aria-label="Feedback draft"]') as HTMLTextAreaElement).value).toBe("");

    await act(async () => renderTarget());
    currentTarget = { ...currentTarget, autoSend: true };
    await act(async () => renderTarget());
    expect(chatsApi.sendFirstMessageStream).toHaveBeenCalledTimes(1);
    expect(currentTarget.autoSend).toBe(false);
    await act(async () => {
      releaseFirstStream?.();
      await Promise.resolve();
    });
  });

  it("keeps a failed Debug Chat request retryable without a conversation", async () => {
    vi.mocked(chatsApi.sendFirstMessageStream).mockImplementationOnce(async () => {
      await Promise.resolve();
      throw new ApiError("Unavailable", 503, null);
    });
    let currentTarget: Extract<SidePanelTarget, { kind: "run_debug_chat" }> = {
      kind: "run_debug_chat",
      organizationId: "org-1",
      runId: "run-1",
      agentId: "agent-1",
      preferredAgentId: "agent-1",
      conversationId: null,
      clientMutationId: "run-debug:org-1:run-1",
      projectId: null,
      body: "Investigate Run ID: run-1",
      autoSend: true,
      errorMessage: null,
      inlineAnnotations: [],
      label: "Debug Run",
    };
    const onReplaceTarget = vi.fn((_key, nextTarget) => {
      currentTarget = nextTarget as typeof currentTarget;
    });
    const renderTarget = () => root.render(
      <QueryClientProvider client={queryClient}>
        <RunFeedbackChatPanel
          organizationId="org-1"
          target={currentTarget}
          onReplaceTarget={onReplaceTarget}
        />
      </QueryClientProvider>,
    );

    await act(async () => {
      renderTarget();
    });
    await act(async () => {
      await vi.waitFor(() => expect(chatsApi.sendFirstMessageStream).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(currentTarget.errorMessage).toContain("Choose another agent or try again"));
    });
    await act(async () => {
      renderTarget();
    });
    await act(async () => {
      await vi.waitFor(() => expect(host.textContent).toContain("Choose another agent or try again"));
    });

    expect(currentTarget).toEqual(expect.objectContaining({
      autoSend: false,
      body: "Investigate Run ID: run-1",
      clientMutationId: "run-debug:org-1:run-1",
      conversationId: null,
    }));
    expect((host.querySelector('[aria-label="Feedback draft"]') as HTMLTextAreaElement).value)
      .toBe("Investigate Run ID: run-1");
    expect(chatsApi.get).not.toHaveBeenCalledWith(expect.stringContaining("run-debug"));
  });

  it("keeps a recovered network-waiting Debug Chat sending and stoppable", async () => {
    vi.mocked(chatsApi.listQueue).mockImplementation(async () => ({
      activeGenerationId: queueTerminal ? null : "generation-1",
      activeAttemptEpoch: queueTerminal ? null : 4,
      activeControlVersion: queueTerminal ? null : 9,
      activeGenerationStatus: queueTerminal ? null : "waiting_for_network",
      items: [],
    }));
    const debugTarget: Extract<SidePanelTarget, { kind: "run_debug_chat" }> = {
      kind: "run_debug_chat",
      organizationId: "org-1",
      runId: "run-network-wait",
      agentId: "agent-1",
      preferredAgentId: "agent-1",
      conversationId: "chat-1",
      clientMutationId: "run-debug:org-1:run-network-wait",
      projectId: null,
      body: "",
      autoSend: false,
      errorMessage: null,
      inlineAnnotations: [],
      label: "Debug Run",
    };

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={debugTarget}
            onReplaceTarget={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Stop feedback"]')).not.toBeNull());
    });
    expect(host.querySelector('[data-debug-queue-status="waiting_for_network"]')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={debugTarget}
            onReplaceTarget={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Stop feedback"]')).not.toBeNull());
    });
    expect(host.querySelector('[data-debug-queue-status="waiting_for_network"]')).not.toBeNull();
    await act(async () => {
      (host.querySelector('[aria-label="Stop feedback"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(chatsApi.stopMessageStream).toHaveBeenCalledWith(
        "chat-1",
        expect.objectContaining({ expectedGenerationId: "generation-1" }),
      ));
      await vi.waitFor(() => expect(host.querySelector('[aria-label="Stop feedback"]')).toBeNull());
    });
  });

  it("shows the truthful bound Agent for an existing legacy feedback Chat", async () => {
    vi.mocked(chatsApi.get).mockResolvedValue({
      id: "chat-1",
      title: "Legacy Run feedback",
      preferredAgentId: "agent-2",
    } as never);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={{ ...target, preferredAgentId: "agent-2" }}
            onReplaceTarget={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });

    const agentSelector = host.querySelector("[data-testid='chat-agent-selector']") as HTMLButtonElement;
    await act(async () => {
      await vi.waitFor(() => expect(agentSelector.textContent).toContain("Sage"));
    });
    expect(agentSelector.disabled).toBe(true);
  });

  it("recovers a missing cached chat as a fresh draft and sends it exactly once", async () => {
    vi.mocked(chatsApi.get).mockRejectedValue(new ApiError("Not found", 404, null));
    const onReplaceTarget = vi.fn();
    let currentTarget = { ...target, preferredAgentId: "agent-2" };
    const renderTarget = () => root.render(
      <QueryClientProvider client={queryClient}>
        <RunFeedbackChatPanel
          organizationId="org-1"
          target={currentTarget}
          onReplaceTarget={onReplaceTarget}
        />
      </QueryClientProvider>,
    );

    act(() => renderTarget());

    await act(async () => {
      await vi.waitFor(() => expect(chatsApi.get).toHaveBeenCalledWith("chat-1"));
      await vi.waitFor(() => expect(
        onReplaceTarget.mock.calls.some(([, nextTarget]) => nextTarget.recoveryNotice?.includes("Your draft was kept")),
      ).toBe(true));
    });
    currentTarget = onReplaceTarget.mock.calls
      .find(([, nextTarget]) => nextTarget.recoveryNotice?.includes("Your draft was kept"))?.[1] ?? currentTarget;
    expect(currentTarget.recoveryNotice).toContain("Your draft was kept");
    await act(async () => {
      renderTarget();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => expect(host.textContent).toContain("Your draft was kept"));
    });
    expect(currentTarget).toEqual(expect.objectContaining({
      conversationId: null,
      projectLocked: false,
      body: "Feedback",
      projectId: null,
      preferredAgentId: "agent-1",
    }));
    expect(currentTarget.clientMutationId).not.toBe("mutation-1");
    expect((host.querySelector("[data-testid='run-feedback-project-selector']") as HTMLButtonElement).disabled).toBe(false);
    expect((host.querySelector("[data-testid='chat-agent-selector']") as HTMLButtonElement).disabled).toBe(true);

    const sendButton = host.querySelector('[aria-label="Send feedback"]') as HTMLButtonElement;
    await act(async () => {
      sendButton.click();
      sendButton.click();
      await vi.waitFor(() => expect(chatsApi.sendFirstMessageStream).toHaveBeenCalledTimes(1));
    });
    expect(vi.mocked(chatsApi.sendFirstMessageStream).mock.calls[0]?.[2].preferredAgentId).toBe("agent-1");
    await act(async () => {
      releaseFirstStream?.();
      await Promise.resolve();
    });
  });

  it("shows a retryable Project loading failure in the selector menu", async () => {
    vi.mocked(projectsApi.list).mockRejectedValueOnce(new ApiError("Unavailable", 503, null));
    const draftTarget = { ...target, conversationId: null, projectLocked: false };
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={draftTarget}
            onReplaceTarget={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await vi.waitFor(() => expect(
        (host.querySelector("[data-testid='run-feedback-project-selector']") as HTMLButtonElement).disabled,
      ).toBe(false));
      (host.querySelector("[data-testid='run-feedback-project-selector']") as HTMLButtonElement).click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Projects could not be loaded."));
    });

    vi.mocked(projectsApi.list).mockResolvedValueOnce([projectAlpha]);
    await act(async () => {
      const retry = Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent === "Retry");
      retry?.click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Project Alpha"));
    });
  });

  it("allows a retry after stale annotation submission is blocked", async () => {
    vi.mocked(healthApi.get).mockResolvedValue({
      status: "ok",
      devServer: {
        enabled: true,
        restartRequired: true,
        reason: "backend_changes",
        lastChangedAt: null,
        changedPathCount: 1,
        changedPathsSample: ["server/src/index.ts"],
        envFileChanged: false,
        pendingMigrations: [],
        lastRestartAt: null,
      },
    });
    const onReplaceTarget = vi.fn();
    const annotatedTarget = {
      ...target,
      inlineAnnotations: [annotation],
      recoveryNotice: "Your draft was kept.",
    };
    const renderTarget = () => root.render(
      <QueryClientProvider client={queryClient}>
        <RunFeedbackChatPanel
          organizationId="org-1"
          target={annotatedTarget}
          onReplaceTarget={onReplaceTarget}
        />
      </QueryClientProvider>,
    );
    act(() => renderTarget());

    await act(async () => {
      await vi.waitFor(() => expect(
        queryClient.getQueryData<{ devServer?: { restartRequired?: boolean } }>(queryKeys.health)
          ?.devServer?.restartRequired,
      ).toBe(true));
      (host.querySelector('[aria-label="Send feedback"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(chatsApi.sendMessageStream).not.toHaveBeenCalled();
    expect(onReplaceTarget).not.toHaveBeenCalled();

    await act(async () => {
      queryClient.setQueryData(queryKeys.health, { status: "ok" });
      renderTarget();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      (host.querySelector('[aria-label="Send feedback"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(chatsApi.sendMessageStream).toHaveBeenCalledTimes(1));
    });
    expect(onReplaceTarget).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recoveryNotice: null }),
    );
  });

  it("keeps the draft and retries after a send failure", async () => {
    vi.mocked(chatsApi.sendMessageStream).mockRejectedValueOnce(new ApiError("Unavailable", 503, null));
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunFeedbackChatPanel
            organizationId="org-1"
            target={target}
            onReplaceTarget={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });

    const draft = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Feedback draft"]')!;
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Send feedback"]')?.click();
      await vi.waitFor(() => expect(host.textContent).toContain("Rudder could not process the request. Try again."));
    });
    expect(draft.value).toBe("Feedback");
    expect(chatsApi.sendMessageStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Send feedback"]')?.click();
      await vi.waitFor(() => expect(chatsApi.sendMessageStream).toHaveBeenCalledTimes(2));
    });
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
