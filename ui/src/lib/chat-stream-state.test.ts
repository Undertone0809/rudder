import type { ChatMessage } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  activeChatStreamTimelineInsertionIndex,
  mergeNativeSteerTranscriptEntries,
  nativeSteerTranscriptAnchor,
  readChatScopedFlag,
  readChatScopedState,
  setChatFlagState,
  setChatScopedState,
  shouldShowMessageDuringActiveEdit,
  shouldShowMessageDuringActiveStream,
} from "./chat-stream-state";

function steerMessage(input: {
  id: string;
  body: string;
  afterTranscriptEntryCount: number;
  generationSeq: number;
  deliveryDisposition?: string;
}): ChatMessage {
  return {
    id: input.id,
    orgId: "org-1",
    conversationId: "chat-1",
    role: "user",
    kind: "message",
    status: "completed",
    body: input.body,
    structuredPayload: {
      source: "steer",
      targetGenerationId: "generation-1",
      afterTranscriptEntryCount: input.afterTranscriptEntryCount,
      generationSeq: input.generationSeq,
      controlActionId: `control-${input.id}`,
      deliveryDisposition: input.deliveryDisposition ?? "accepted_current",
    },
    approvalId: null,
    approval: null,
    attachments: [],
    replyingAgentId: null,
    chatTurnId: `turn-${input.id}`,
    turnVariant: 0,
    supersededAt: null,
    createdAt: new Date("2026-07-21T08:00:00.000Z"),
    updatedAt: new Date("2026-07-21T08:00:00.000Z"),
  };
}

describe("chat stream state helpers", () => {
  it("merges multiple native Steer messages by durable transcript anchors instead of timestamps", () => {
    const firstSteer = steerMessage({
      id: "steer-1",
      body: "Direction after A",
      afterTranscriptEntryCount: 1,
      generationSeq: 4,
    });
    const secondSteer = steerMessage({
      id: "steer-2",
      body: "Direction after B",
      afterTranscriptEntryCount: 2,
      generationSeq: 7,
    });
    const entries = [
      { kind: "thinking" as const, ts: "2026-07-21T08:00:00.000Z", text: "Reasoning A" },
      { kind: "tool_call" as const, ts: "2026-07-21T08:00:00.000Z", name: "inspect", input: {} },
      { kind: "thinking" as const, ts: "2026-07-21T08:00:00.000Z", text: "Reasoning B" },
    ];

    expect(mergeNativeSteerTranscriptEntries(entries, [secondSteer, firstSteer])).toEqual([
      entries[0],
      expect.objectContaining({ kind: "user", source: "steer", text: firstSteer.body }),
      entries[1],
      expect.objectContaining({ kind: "user", source: "steer", text: secondSteer.body }),
      entries[2],
    ]);
  });

  it("keeps fallback continuation feedback out of the old generation transcript", () => {
    const continuation = steerMessage({
      id: "steer-continuation",
      body: "Run this next",
      afterTranscriptEntryCount: 1,
      generationSeq: 4,
      deliveryDisposition: "continuation_pending",
    });

    expect(nativeSteerTranscriptAnchor(continuation)).toBeNull();
    expect(mergeNativeSteerTranscriptEntries([
      { kind: "thinking", ts: "2026-07-21T08:00:00.000Z", text: "Old run" },
    ], [continuation])).toHaveLength(1);
  });

  it("scopes send-in-flight flags to the selected chat only", () => {
    const flags = {
      "chat-a": true,
    } satisfies Record<string, true>;

    expect(readChatScopedFlag(flags, "chat-a")).toBe(true);
    expect(readChatScopedFlag(flags, "chat-b")).toBe(false);
    expect(readChatScopedFlag(flags, null)).toBe(false);
  });

  it("scopes stream drafts to the selected chat only", () => {
    const drafts = {
      "chat-a": { body: "reply A" },
      "chat-b": { body: "reply B" },
    };

    expect(readChatScopedState(drafts, "chat-a")).toEqual({ body: "reply A" });
    expect(readChatScopedState(drafts, "chat-b")).toEqual({ body: "reply B" });
    expect(readChatScopedState(drafts, "chat-c")).toBeNull();
    expect(readChatScopedState(drafts, undefined)).toBeNull();
  });

  it("removes one chat flag without disturbing other active chats", () => {
    const next = setChatFlagState(
      {
        "chat-a": true,
        "chat-b": true,
      },
      "chat-a",
      false,
    );

    expect(next).toEqual({ "chat-b": true });
  });

  it("removes one chat draft without disturbing other chat drafts", () => {
    const next = setChatScopedState(
      {
        "chat-a": { body: "reply A" },
        "chat-b": { body: "reply B" },
      },
      "chat-a",
      null,
    );

    expect(next).toEqual({ "chat-b": { body: "reply B" } });
  });

  it("hides finalized assistant messages for the active stream turn", () => {
    const activeStream = {
      userCreatedAt: new Date("2026-04-30T10:00:00.000Z"),
      chatTurnId: "turn-active",
    };

    expect(shouldShowMessageDuringActiveStream({
      role: "user",
      chatTurnId: "turn-active",
      createdAt: new Date("2026-04-30T10:00:00.000Z"),
    }, activeStream)).toBe(true);

    expect(shouldShowMessageDuringActiveStream({
      role: "assistant",
      chatTurnId: "turn-active",
      createdAt: new Date("2026-04-30T10:00:01.000Z"),
    }, activeStream)).toBe(false);

    expect(shouldShowMessageDuringActiveStream({
      role: "assistant",
      chatTurnId: "turn-previous",
      createdAt: new Date("2026-04-30T09:59:59.000Z"),
    }, activeStream)).toBe(true);

    expect(shouldShowMessageDuringActiveStream({
      role: "assistant",
      chatTurnId: null,
      createdAt: new Date("2026-04-30T10:00:02.000Z"),
    }, activeStream)).toBe(false);
  });

  it("keeps the active response before user feedback persisted during that response", () => {
    const messages = [
      { id: "active-user", createdAt: new Date("2026-04-30T10:00:00.000Z") },
      { id: "steer-user", createdAt: new Date("2026-04-30T10:00:02.000Z") },
    ];

    expect(activeChatStreamTimelineInsertionIndex(messages, {
      userMessageId: "active-user",
      userCreatedAt: messages[0]!.createdAt,
    })).toBe(1);
  });

  it("places an optimistic active response before later feedback when its user message is not loaded yet", () => {
    const messages = [
      { id: "previous-message", createdAt: new Date("2026-04-30T09:59:59.000Z") },
      { id: "steer-user", createdAt: new Date("2026-04-30T10:00:02.000Z") },
    ];

    expect(activeChatStreamTimelineInsertionIndex(messages, {
      userMessageId: "active-user",
      userCreatedAt: new Date("2026-04-30T10:00:00.000Z"),
    })).toBe(1);
  });

  it("places an optimistic active response before feedback with the same persisted timestamp", () => {
    const messages = [
      { id: "previous-message", createdAt: new Date("2026-04-30T09:59:59.000Z") },
      { id: "steer-user", createdAt: new Date("2026-04-30T10:00:00.000Z") },
    ];

    expect(activeChatStreamTimelineInsertionIndex(messages, {
      userMessageId: "active-user",
      userCreatedAt: new Date("2026-04-30T10:00:00.000Z"),
    })).toBe(1);
  });

  it("keeps new Steer feedback visible across an active historical-message edit cutoff", () => {
    const activeEdit = {
      userMessageId: "edited-user",
      userCreatedAt: new Date("2026-04-30T10:00:00.000Z"),
      editedFromCreatedAt: new Date("2026-04-30T09:00:00.000Z"),
    };

    expect(shouldShowMessageDuringActiveEdit({
      id: "historical-later-user",
      role: "user",
      createdAt: new Date("2026-04-30T09:30:00.000Z"),
    }, activeEdit)).toBe(false);
    expect(shouldShowMessageDuringActiveEdit({
      id: "edited-user",
      role: "user",
      createdAt: activeEdit.userCreatedAt,
    }, activeEdit)).toBe(false);
    expect(shouldShowMessageDuringActiveEdit({
      id: "steer-user",
      role: "user",
      createdAt: activeEdit.userCreatedAt,
    }, activeEdit)).toBe(true);
  });
});
