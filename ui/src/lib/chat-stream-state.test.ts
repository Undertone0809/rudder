import { describe, expect, it } from "vitest";
import {
  readChatScopedFlag,
  readChatScopedState,
  setChatFlagState,
  setChatScopedState,
  shouldShowMessageDuringActiveStream,
} from "./chat-stream-state";

describe("chat stream state helpers", () => {
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
});
