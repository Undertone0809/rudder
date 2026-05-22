// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ChatGenerationProvider, useChatGenerations, type ChatStreamDraft } from "./ChatGenerationContext";

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
    userBody: "hello",
    userCreatedAt: createdAt,
    userMessageId: null,
    chatTurnId: null,
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
});

describe("ChatGenerationProvider", () => {
  it("keeps active stream state when the chat route remounts", () => {
    const rerender = renderProvider("chat-route-a");

    act(() => {
      latestContext!.setChatSendInFlight("chat-1", true);
      latestContext!.setStreamDraftForChat("chat-1", streamDraft());
    });

    expect(latestContext!.isChatGenerationActive("chat-1")).toBe(true);
    expect(latestContext!.sendInFlightByChatId).toEqual({ "chat-1": true });
    expect(latestContext!.streamDrafts["chat-1"]?.body).toBe("partial");

    rerender("chat-route-b");

    expect(latestContext!.isChatGenerationActive("chat-1")).toBe(true);
    expect(latestContext!.sendInFlightByChatId).toEqual({ "chat-1": true });
    expect(latestContext!.streamDrafts["chat-1"]?.body).toBe("partial");
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
