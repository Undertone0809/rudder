// @vitest-environment jsdom

import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import { queryKeys } from "@/lib/queryKeys";
import type { ChatMessage, ChatQueueSnapshot } from "@rudderhq/shared";
import { notifyManager, QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { act, useCallback, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useChatStreamTerminalReconciliation } from "./useChatStreamTerminalReconciliation";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const activeQueue = {
  activeGenerationId: "generation-1",
  activeGenerationStatus: "running",
} as ChatQueueSnapshot;

const terminalQueue = {
  activeGenerationId: "generation-1",
  activeGenerationStatus: "completed",
} as ChatQueueSnapshot;

const terminalMessage = {
  id: "assistant-final",
  role: "assistant",
  kind: "message",
  status: "completed",
  body: "Recovered final answer.",
  generationId: "generation-1",
} as unknown as ChatMessage;

const streamDraft = {
  chatId: "chat-1",
  streamKey: "stream-1",
  userBody: "Continue the same conversation.",
  userCreatedAt: new Date("2026-10-01T00:00:00.000Z"),
  userMessageId: "user-1",
  chatTurnId: "turn-1",
  turnVariant: 0,
  editedFromCreatedAt: null,
  body: "",
  generationId: "generation-1",
  state: "waiting_for_network",
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  transcript: [],
  replyingAgentId: "agent-1",
} as unknown as ChatStreamDraft;

const messagesKey = queryKeys.chats.messages("org-1", "chat-1");
const mountedRoots: Array<{ root: Root; container: HTMLDivElement; client: QueryClient }> = [];

beforeAll(() => {
  notifyManager.setNotifyFunction((callback) => {
    act(callback);
  });
});

function StreamReconciliationProbe({
  messages,
  queueSnapshot,
}: {
  messages: ChatMessage[];
  queueSnapshot: ChatQueueSnapshot;
}) {
  const queryClient = useQueryClient();
  const [stream, setStream] = useState<ChatStreamDraft | null>(streamDraft);
  const [sendInFlight, setSendInFlight] = useState(true);
  const setDraft = useCallback((
    _scopeKey: string,
    nextDraft: null | ((current: ChatStreamDraft | null) => ChatStreamDraft | null),
  ) => {
    setStream((current) => typeof nextDraft === "function" ? nextDraft(current) : nextDraft);
  }, []);
  const setSendState = useCallback((_scopeKey: string, inFlight: boolean) => {
    setSendInFlight(inFlight);
  }, []);

  useChatStreamTerminalReconciliation({
    orgId: "org-1",
    chatId: "chat-1",
    scopeKey: "org-1:chat-1",
    queueSnapshot,
    messages,
    stream,
    queryClient,
    setChatSendInFlight: setSendState,
    setStreamDraftForChat: setDraft,
  });

  const final = messages.find((message) => (
    message.role === "assistant"
    && message.generationId === "generation-1"
    && message.status !== "streaming"
  ));
  return (
    <div>
      <span data-testid="stream-state">{stream ? "streaming" : "cleared"}</span>
      <span data-testid="send-state">{sendInFlight ? "sending" : "idle"}</span>
      {final ? <p data-testid="final-answer">{final.body}</p> : null}
    </div>
  );
}

function DelayedMessagesProbe({
  fetchMessages,
  queueSnapshot = terminalQueue,
}: {
  fetchMessages: () => Promise<ChatMessage[]>;
  queueSnapshot?: ChatQueueSnapshot;
}) {
  const { data = [] } = useQuery({
    queryKey: messagesKey,
    queryFn: fetchMessages,
    initialData: [] as ChatMessage[],
    staleTime: Infinity,
    retry: false,
  });
  return <StreamReconciliationProbe messages={data} queueSnapshot={queueSnapshot} />;
}

function CachedMessagesProbe({ queueSnapshot }: { queueSnapshot: ChatQueueSnapshot }) {
  const { data = [] } = useQuery({
    queryKey: messagesKey,
    queryFn: async () => [],
    initialData: [] as ChatMessage[],
    staleTime: Infinity,
  });
  return <StreamReconciliationProbe messages={data} queueSnapshot={queueSnapshot} />;
}

async function mountProbe(client: QueryClient, probe: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push({ root, container, client });
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{probe}</QueryClientProvider>);
  });
  return container;
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

afterEach(() => {
  for (const { root, container, client } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
    client.clear();
  }
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

afterAll(() => {
  notifyManager.setNotifyFunction((callback) => callback());
});

describe("useChatStreamTerminalReconciliation", () => {
  it("shows a persisted final and clears the stale stream while its queue is still active", async () => {
    const client = createQueryClient();
    const container = await mountProbe(
      client,
      <CachedMessagesProbe queueSnapshot={activeQueue} />,
    );

    expect(container.querySelector('[data-testid="stream-state"]')?.textContent).toBe("streaming");
    act(() => {
      client.setQueryData(messagesKey, [terminalMessage]);
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="stream-state"]')?.textContent).toBe("cleared");
      expect(container.querySelector('[data-testid="send-state"]')?.textContent).toBe("idle");
      expect(container.querySelector('[data-testid="final-answer"]')?.textContent).toBe("Recovered final answer.");
    });
  });

  it("retries terminal message reconciliation when the first query still has the old projection", async () => {
    const client = createQueryClient();
    let readCount = 0;
    const fetchMessages = vi.fn(async (): Promise<ChatMessage[]> => {
      readCount += 1;
      return readCount === 1 ? [] : [terminalMessage];
    });
    const container = await mountProbe(client, <DelayedMessagesProbe fetchMessages={fetchMessages} />);

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="stream-state"]')?.textContent).toBe("cleared");
        expect(container.querySelector('[data-testid="send-state"]')?.textContent).toBe("idle");
        expect(container.querySelector('[data-testid="final-answer"]')?.textContent).toBe("Recovered final answer.");
      }, { timeout: 4_000, interval: 20 });
    });
    expect(fetchMessages).toHaveBeenCalledTimes(2);
  });

  it("keeps reconciling a network-waiting stream while its generation remains active", async () => {
    const client = createQueryClient();
    let readCount = 0;
    const fetchMessages = vi.fn(async (): Promise<ChatMessage[]> => {
      readCount += 1;
      return readCount === 1 ? [] : [terminalMessage];
    });
    const container = await mountProbe(
      client,
      <DelayedMessagesProbe fetchMessages={fetchMessages} queueSnapshot={activeQueue} />,
    );

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('[data-testid="stream-state"]')?.textContent).toBe("cleared");
        expect(container.querySelector('[data-testid="send-state"]')?.textContent).toBe("idle");
        expect(container.querySelector('[data-testid="final-answer"]')?.textContent).toBe("Recovered final answer.");
      }, { timeout: 2_000, interval: 20 });
    });
    expect(fetchMessages).toHaveBeenCalledTimes(2);
  });
});
