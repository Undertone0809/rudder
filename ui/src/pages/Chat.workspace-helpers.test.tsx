// @vitest-environment jsdom

import { chatsApi } from "@/api/chats";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { advanceChatDraftModelScope, chatComposerSubmitAction, chatSendButtonDisabled, useChatDraftQueries } from "./Chat.workspace-helpers";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/api/chats", () => ({
  chatsApi: {
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
    modelOverride: "gpt-5.6-terra",
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
  vi.restoreAllMocks();
  document.body.replaceChildren();
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

describe("chatComposerSubmitAction", () => {
  it("blocks keyboard Queue while a conversation model change is pending", () => {
    expect(chatComposerSubmitAction({
      composerUnavailable: false,
      newConversationSendInFlight: false,
      modelSelectionPending: true,
      selectedConversationHasActiveReply: true,
      hasSelectedConversation: true,
      controlsDisabled: true,
    })).toBe("none");
  });

  it("still allows Queue during an active reply when no model change is pending", () => {
    expect(chatComposerSubmitAction({
      composerUnavailable: false,
      newConversationSendInFlight: false,
      modelSelectionPending: false,
      selectedConversationHasActiveReply: true,
      hasSelectedConversation: true,
      controlsDisabled: true,
    })).toBe("queue");
  });
});

describe("chatSendButtonDisabled", () => {
  it("keeps Stop available while a conversation model change is pending", () => {
    expect(chatSendButtonDisabled({
      selectedConversationExternalBound: false,
      modelSelectionPending: true,
      composerUnavailable: false,
      sendButtonMode: "stop",
      hasDraft: false,
    })).toBe(false);
  });

  it.each(["send", "queue"] as const)("blocks %s while a conversation model change is pending", (sendButtonMode) => {
    expect(chatSendButtonDisabled({
      selectedConversationExternalBound: false,
      modelSelectionPending: true,
      composerUnavailable: false,
      sendButtonMode,
      hasDraft: true,
    })).toBe(true);
  });
});

describe("advanceChatDraftModelScope", () => {
  it("resets a draft override when the effective Agent or organization changes", () => {
    const initial = advanceChatDraftModelScope(null, "org-1", "agent-1");
    expect(initial).toEqual({ scope: "org-1:agent-1", reset: false });
    expect(advanceChatDraftModelScope(initial.scope, "org-1", "agent-2").reset).toBe(true);
    expect(advanceChatDraftModelScope(initial.scope, "org-2", "agent-1").reset).toBe(true);
    expect(advanceChatDraftModelScope(initial.scope, "org-1", "agent-1").reset).toBe(false);
  });
});
