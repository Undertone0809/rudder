import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@rudderhq/shared";
import type { TranscriptEntry } from "@/agent-runtimes";
import {
  formatChatProcessDuration,
  resolvePersistedChatProcessEndedAt,
  resolvePersistedChatProcessStartedAt,
} from "./chat-process-duration";

function makeMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "message-1",
    orgId: "org-1",
    conversationId: "chat-1",
    role: "assistant",
    kind: "message",
    status: "completed",
    body: "",
    structuredPayload: null,
    approvalId: null,
    approval: null,
    attachments: [],
    transcript: [],
    replyingAgentId: null,
    chatTurnId: "turn-1",
    turnVariant: 0,
    supersededAt: null,
    createdAt: new Date("2026-04-26T03:11:00.000Z"),
    updatedAt: new Date("2026-04-26T03:11:00.000Z"),
    ...overrides,
  };
}

describe("chat process duration helpers", () => {
  it("uses the same-turn user message as persisted process start", () => {
    const userMessage = makeMessage({
      id: "user-1",
      role: "user",
      body: "Fix the timing bug",
      createdAt: new Date("2026-04-26T03:02:00.000Z"),
      updatedAt: new Date("2026-04-26T03:02:00.000Z"),
    });
    const assistantMessage = makeMessage({
      id: "assistant-1",
      createdAt: new Date("2026-04-26T03:11:00.000Z"),
      updatedAt: new Date("2026-04-26T03:11:00.000Z"),
    });
    const transcript: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts: "2026-04-26T03:10:59.700Z",
        name: "shell",
        input: { command: "pnpm test" },
      },
      {
        kind: "tool_result",
        ts: "2026-04-26T03:10:59.900Z",
        toolUseId: "tool-1",
        content: "ok",
        isError: false,
      },
    ];

    const startedAt = resolvePersistedChatProcessStartedAt(
      [userMessage, assistantMessage],
      assistantMessage,
      transcript,
    );
    const endedAt = resolvePersistedChatProcessEndedAt(assistantMessage, transcript);

    expect(startedAt.toISOString()).toBe("2026-04-26T03:02:00.000Z");
    expect(formatChatProcessDuration(endedAt.getTime() - startedAt.getTime())).toBe("9m");
  });

  it("falls back to the latest previous user message when turn metadata is unavailable", () => {
    const previousUser = makeMessage({
      id: "user-previous",
      role: "user",
      chatTurnId: null,
      createdAt: new Date("2026-04-26T03:00:00.000Z"),
      updatedAt: new Date("2026-04-26T03:00:00.000Z"),
    });
    const latestUser = makeMessage({
      id: "user-latest",
      role: "user",
      chatTurnId: null,
      createdAt: new Date("2026-04-26T03:08:00.000Z"),
      updatedAt: new Date("2026-04-26T03:08:00.000Z"),
    });
    const assistantMessage = makeMessage({
      id: "assistant-1",
      chatTurnId: null,
      createdAt: new Date("2026-04-26T03:11:00.000Z"),
      updatedAt: new Date("2026-04-26T03:11:00.000Z"),
    });

    const startedAt = resolvePersistedChatProcessStartedAt(
      [previousUser, latestUser, assistantMessage],
      assistantMessage,
      [],
    );

    expect(startedAt.toISOString()).toBe("2026-04-26T03:08:00.000Z");
  });
});
