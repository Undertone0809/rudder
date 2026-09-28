// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearSideChatSendDraft,
  readSideChatSendDraft,
  saveSideChatSendDraft,
} from "./side-chat-draft-storage";

const storageKey = "rudder:side-chat-send-drafts:v1";

describe("Side Chat send draft storage", () => {
  afterEach(() => {
    window.localStorage.removeItem(storageKey);
  });

  it("restores an unaccepted first message with its original create identity", () => {
    saveSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1", {
      body: "Preserve this Side Chat prompt.",
      acceptedUserMessageId: null,
    });

    expect(readSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1")).toEqual({
      body: "Preserve this Side Chat prompt.",
      acceptedUserMessageId: null,
    });
    expect(readSideChatSendDraft("user-1", "org-2", "parent-1", "mutation-1")).toBeNull();
    expect(readSideChatSendDraft("user-2", "org-1", "parent-1", "mutation-1")).toBeNull();
    expect(readSideChatSendDraft("user-1", "org-1", "parent-2", "mutation-1")).toBeNull();
  });

  it("restores the accepted user-message identity so a retry edits instead of duplicating it", () => {
    saveSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1", {
      body: "The server accepted this prompt.",
      acceptedUserMessageId: "message-1",
    });

    expect(readSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1")).toEqual({
      body: "The server accepted this prompt.",
      acceptedUserMessageId: "message-1",
    });
  });

  it("clears the recovery draft after successful completion", () => {
    saveSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1", {
      body: "Finished prompt.",
      acceptedUserMessageId: "message-1",
    });

    clearSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1");

    expect(readSideChatSendDraft("user-1", "org-1", "parent-1", "mutation-1")).toBeNull();
    expect(window.localStorage.getItem(storageKey)).toBeNull();
  });
});
