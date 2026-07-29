// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatGenerationProvider,
  useChatGenerationActions,
  useChatGenerationActive,
  useChatGenerations,
  type ChatStreamDraft,
} from "./ChatGenerationContext";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let latestContext: ReturnType<typeof useChatGenerations> | null = null;
let cleanupFn: (() => void) | null = null;

function Probe() {
  latestContext = useChatGenerations();
  return null;
}

function renderProvider(probeKey: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
    latestContext = null;
  };

  const render = (key: string) => {
    act(() => {
      root.render(
        <ChatGenerationProvider>
          <Probe key={key} />
        </ChatGenerationProvider>,
      );
    });
  };

  render(probeKey);
  return render;
}

function streamDraft(overrides: Partial<ChatStreamDraft> = {}): ChatStreamDraft {
  const createdAt = new Date("2026-05-06T10:00:00.000Z");
  return {
    chatId: "chat-1",
    streamKey: "stream-1",
    userBody: "hello",
    userCreatedAt: createdAt,
    userMessageId: null,
    chatTurnId: null,
    turnVariant: 0,
    editedFromCreatedAt: null,
    body: "partial",
    state: "streaming",
    createdAt,
    transcript: [],
    replyingAgentId: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("ChatGenerationProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("keeps active stream state when the chat route remounts", () => {
    const rerender = renderProvider("chat-route-a");

    act(() => {
      latestContext!.setChatSendInFlight("chat-1", true);
      latestContext!.setStreamDraftForChat("chat-1", streamDraft());
      vi.advanceTimersByTime(50);
    });

    expect(latestContext!.isChatGenerationActive("chat-1")).toBe(true);
    expect(latestContext!.sendInFlightByChatId).toEqual({ "chat-1": true });
    expect(latestContext!.streamDrafts["chat-1"]?.body).toBe("partial");

    rerender("chat-route-b");

    expect(latestContext!.isChatGenerationActive("chat-1")).toBe(true);
    expect(latestContext!.sendInFlightByChatId).toEqual({ "chat-1": true });
    expect(latestContext!.streamDrafts["chat-1"]?.body).toBe("partial");
  });

  it("does not rerender stable actions or unrelated chat status consumers for deltas", () => {
    let actionsRenderCount = 0;
    let unrelatedStatusRenderCount = 0;
    let actions: ReturnType<typeof useChatGenerationActions> | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function ActionsProbe() {
      actionsRenderCount += 1;
      actions = useChatGenerationActions();
      return null;
    }
    function UnrelatedStatusProbe() {
      unrelatedStatusRenderCount += 1;
      useChatGenerationActive("chat-2");
      return null;
    }

    act(() => {
      root.render(
        <ChatGenerationProvider>
          <ActionsProbe />
          <UnrelatedStatusProbe />
        </ChatGenerationProvider>,
      );
    });
    act(() => {
      actions!.setStreamDraftForChat("chat-1", streamDraft());
      actions!.setStreamDraftForChat("chat-1", (current) => current
        ? { ...current, body: `${current.body} next token` }
        : current);
      vi.advanceTimersByTime(50);
    });

    expect(actionsRenderCount).toBe(1);
    expect(unrelatedStatusRenderCount).toBe(1);

    act(() => root.unmount());
    container.remove();
  });

  it("publishes the exact final raw draft before removing a completed stream", () => {
    renderProvider("chat-route-a");

    act(() => {
      latestContext!.setStreamDraftForChat("chat-1", streamDraft());
      vi.advanceTimersByTime(50);
      latestContext!.setStreamDraftForChat("chat-1", (current) => current
        ? {
            ...current,
            body: "final body",
            state: "finalizing",
            transcript: [{
              kind: "assistant",
              ts: "2026-05-06T10:00:01.000Z",
              text: "final reasoning",
            }],
          }
        : current);
      latestContext!.setStreamDraftForChat("chat-1", null);
    });

    expect(latestContext!.isChatGenerationActive("chat-1")).toBe(false);
    expect(latestContext!.streamDrafts["chat-1"]?.body).toBe("final body");
    expect(latestContext!.streamDrafts["chat-1"]?.transcript).toEqual([
      {
        kind: "assistant",
        ts: "2026-05-06T10:00:01.000Z",
        text: "final reasoning",
      },
    ]);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(latestContext!.streamDrafts["chat-1"]).toBeUndefined();
  });

  it("keeps abort controllers outside the remounted chat page", () => {
    const rerender = renderProvider("chat-route-a");
    const controller = new AbortController();

    act(() => {
      latestContext!.setStreamAbortController("chat-1", controller);
    });

    rerender("chat-route-b");

    act(() => {
      latestContext!.abortChatStream("chat-1");
    });

    expect(controller.signal.aborted).toBe(true);
  });
});
