import { describe, expect, it } from "vitest";
import {
  readChatScopedFlag,
  readChatScopedState,
  setChatFlagState,
  setChatScopedState,
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
});
