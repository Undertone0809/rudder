// @vitest-environment jsdom

import { chatsApi } from "@/api/chats";
import type { ChatQueuedMessage } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectChatQueueDelivery, useChatDraftQueries } from "./Chat.workspace-helpers";

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

describe("projectChatQueueDelivery", () => {
  it("prioritizes durable delivery and the active Steer request over a stale queued status", () => {
    const queued = { status: "queued", deliveredMessageId: null, continuationMessageId: null, deliveryDisposition: null } as ChatQueuedMessage;

    expect(projectChatQueueDelivery(queued, true)).toEqual({ state: "sending", label: "Sending…" });
    expect(projectChatQueueDelivery({ ...queued, deliveredMessageId: "message-1" })).toEqual({ state: "hidden" });
    expect(projectChatQueueDelivery({ ...queued, status: "failed_actionable", sourceMessageId: "message-1" })).toEqual({ state: "hidden" });
    expect(projectChatQueueDelivery({ ...queued, status: "failed_actionable", deliveryDisposition: "reconciled_current" })).toEqual({ state: "hidden" });
  });
});
