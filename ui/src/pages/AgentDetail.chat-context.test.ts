// @vitest-environment jsdom

import type { ChatMessage, HeartbeatRun } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRunChatContext, RunChatContextCard } from "./AgentDetail.chat-context";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    createElement("a", { href: to, ...props }, children)
  ),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    const state = (globalThis as typeof globalThis & {
      __runChatContextQueryState?: "loaded" | "loading" | "error";
    }).__runChatContextQueryState ?? "loaded";
    if (state === "loading") {
      return { data: undefined, isError: false, isLoading: true };
    }
    if (state === "error") {
      return { data: undefined, isError: true, isLoading: false };
    }
    if (queryKey.includes("messages")) {
      return {
        data: [
          message({
            id: "user-current",
            role: "user",
            body: "Please list all enabled skills.",
            runId: null,
            replyingAgentId: null,
            chatTurnId: "turn-current",
            createdAt: new Date("2026-06-17T10:00:00.000Z"),
          }),
          message({
            id: "assistant-current",
            body: "Here is the full list of enabled skills.",
            runId: "run-current",
            chatTurnId: "turn-current",
            createdAt: new Date("2026-06-17T10:01:00.000Z"),
          }),
          message({
            id: "assistant-next",
            body: "Grouped by source.",
            runId: "run-next",
            replyingAgentId: "agent-2",
            chatTurnId: "turn-next",
            createdAt: new Date("2026-06-17T10:06:00.000Z"),
          }),
        ],
        isError: false,
        isLoading: false,
      };
    }
    return { data: undefined, isError: false, isLoading: false };
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  delete (globalThis as typeof globalThis & {
    __runChatContextQueryState?: "loaded" | "loading" | "error";
  }).__runChatContextQueryState;
  document.body.innerHTML = "";
});

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  act(() => {
    root.render(element);
  });
  return container;
}

function run(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "run-current",
    orgId: "org-1",
    agentId: "agent-1",
    invocationSource: "chat",
    triggerDetail: "chat_assistant_reply",
    status: "succeeded",
    startedAt: null,
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    chatConversationId: "chat-1",
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: {
      scene: "chat",
      conversationId: "chat-1",
      userMessageId: "user-current",
      chatTurnId: "turn-current",
    },
    createdAt: new Date("2026-06-17T10:00:00.000Z"),
    updatedAt: new Date("2026-06-17T10:01:00.000Z"),
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-1",
    orgId: "org-1",
    conversationId: "chat-1",
    role: "assistant",
    kind: "message",
    status: "completed",
    body: "Reply body",
    structuredPayload: null,
    approvalId: null,
    approval: null,
    attachments: [],
    runId: null,
    replyingAgentId: "agent-1",
    chatTurnId: "turn-current",
    turnVariant: 0,
    supersededAt: null,
    createdAt: new Date("2026-06-17T10:00:30.000Z"),
    updatedAt: new Date("2026-06-17T10:00:30.000Z"),
    ...overrides,
  };
}

describe("buildRunChatContext", () => {
  it("links a chat run back to the original user input and aggregates conversation replies", () => {
    const context = buildRunChatContext(run({}), [
      message({
        id: "user-current",
        role: "user",
        body: "Please list all enabled skills.",
        runId: null,
        replyingAgentId: null,
        chatTurnId: "turn-current",
        createdAt: new Date("2026-06-17T10:00:00.000Z"),
      }),
      message({
        id: "assistant-current",
        body: "Here is the full list.",
        runId: "run-current",
        chatTurnId: "turn-current",
        createdAt: new Date("2026-06-17T10:01:00.000Z"),
      }),
      message({
        id: "user-next",
        role: "user",
        body: "Group them by source.",
        runId: null,
        replyingAgentId: null,
        chatTurnId: "turn-next",
        createdAt: new Date("2026-06-17T10:05:00.000Z"),
      }),
      message({
        id: "assistant-next",
        body: "Grouped by source.",
        runId: "run-next",
        chatTurnId: "turn-next",
        createdAt: new Date("2026-06-17T10:06:00.000Z"),
      }),
    ]);

    expect(context.conversationId).toBe("chat-1");
    expect(context.userMessage?.body).toBe("Please list all enabled skills.");
    expect(context.currentReply?.id).toBe("assistant-current");
    expect(context.replies.map((reply) => reply.id)).toEqual(["assistant-current", "assistant-next"]);
  });

  it("falls back to the turn user message when the run snapshot lacks a user message id", () => {
    const context = buildRunChatContext(run({
      contextSnapshot: {
        scene: "chat",
        conversationId: "chat-1",
        chatTurnId: "turn-current",
      },
    }), [
      message({
        id: "user-current",
        role: "user",
        body: "What changed?",
        runId: null,
        replyingAgentId: null,
        chatTurnId: "turn-current",
      }),
      message({
        id: "assistant-current",
        body: "The detail page now has context.",
        runId: "run-current",
        chatTurnId: "turn-current",
      }),
    ]);

    expect(context.userMessage?.id).toBe("user-current");
  });

  it("keeps the original user input and reply for a superseded chat branch", () => {
    const supersededAt = new Date("2026-06-17T10:10:00.000Z");
    const context = buildRunChatContext(run({}), [
      message({
        id: "user-current",
        role: "user",
        body: "Original prompt before edit.",
        runId: null,
        replyingAgentId: null,
        chatTurnId: "turn-current",
        supersededAt,
        createdAt: new Date("2026-06-17T10:00:00.000Z"),
      }),
      message({
        id: "assistant-current",
        body: "Reply generated for the original prompt.",
        runId: "run-current",
        chatTurnId: "turn-current",
        supersededAt,
        createdAt: new Date("2026-06-17T10:01:00.000Z"),
      }),
      message({
        id: "user-edited",
        role: "user",
        body: "Edited prompt.",
        runId: null,
        replyingAgentId: null,
        chatTurnId: "turn-edited",
        createdAt: new Date("2026-06-17T10:11:00.000Z"),
      }),
      message({
        id: "assistant-edited",
        body: "Reply generated for the edited prompt.",
        runId: "run-edited",
        chatTurnId: "turn-edited",
        createdAt: new Date("2026-06-17T10:12:00.000Z"),
      }),
    ]);

    expect(context.userMessage?.body).toBe("Original prompt before edit.");
    expect(context.currentReply?.body).toBe("Reply generated for the original prompt.");
    expect(context.replies.map((reply) => reply.id)).toEqual(["assistant-current", "assistant-edited"]);
    expect(context.replies[0]?.isSuperseded).toBe(true);
  });
});

describe("RunChatContextCard", () => {
  it("keeps the chat context compact with only the open action and replies", () => {
    const container = render(createElement(RunChatContextCard, {
      run: run({}),
      agentRouteId: "agent-1",
    }));

    expect(container.textContent).toContain("Open conversation");
    expect(container.textContent).toContain("Reply 1");
    expect(container.textContent).toContain("Reply 2");
    expect(container.textContent).not.toContain("Conversation replies");
    expect(container.textContent).not.toContain("Skill inventory request");
    expect(container.textContent).not.toContain("2 agent replies in this conversation");
    expect(container.textContent).not.toContain("User input");
    expect(container.textContent).not.toContain("This reply");
    expect(container.textContent).not.toContain("Please list all enabled skills.");
  });

  it("renders chat replies as a labeled compact work-object list", () => {
    const container = render(createElement(RunChatContextCard, {
      run: run({}),
      agentRouteId: "agent-1",
    }));

    const list = container.querySelector("[data-testid='run-chat-context-list']");

    expect(container.textContent).toContain("Chat Replies (2)");
    expect(list?.className).toContain("border");
    expect(list?.className).toContain("divide-y");
  });

  it("does not show a zero reply count while replies are still loading", () => {
    (globalThis as typeof globalThis & {
      __runChatContextQueryState?: "loaded" | "loading" | "error";
    }).__runChatContextQueryState = "loading";

    const container = render(createElement(RunChatContextCard, {
      run: run({}),
      agentRouteId: "agent-1",
    }));

    expect(container.textContent).toContain("Chat Replies");
    expect(container.textContent).toContain("Loading replies...");
    expect(container.textContent).not.toContain("Chat Replies (0)");
  });
});
