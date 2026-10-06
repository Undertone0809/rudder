// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingChatSendMutation,
  preparePendingChatSendMutation,
  readPendingChatSendMutation,
  savePendingChatSendMutation,
} from "./chat-send-mutation-storage";

describe("chat send mutation storage", () => {
  beforeEach(() => localStorage.clear());

  it("survives a composer remount and clears only the acknowledged identity", () => {
    savePendingChatSendMutation("org-1", "chat-1", null, {
      id: "mutation-1",
      fingerprint: "fingerprint-1",
    });

    expect(readPendingChatSendMutation("org-1", "chat-1", null)).toEqual({
      id: "mutation-1",
      fingerprint: "fingerprint-1",
    });
    clearPendingChatSendMutation("org-1", "chat-1", null, "stale-mutation");
    expect(readPendingChatSendMutation("org-1", "chat-1", null)?.id).toBe("mutation-1");
    clearPendingChatSendMutation("org-1", "chat-1", null, "mutation-1");
    expect(readPendingChatSendMutation("org-1", "chat-1", null)).toBeNull();
  });

  it("reuses a first-turn identity only while its selected context is unchanged", () => {
    const input = {
      orgId: "org-1",
      conversationId: null,
      body: "Start the task",
      files: [],
      inlineAnnotations: [],
      mutationContext: { preferredAgentId: "agent-1", contextLinks: [] },
    };
    const first = preparePendingChatSendMutation(input);
    const replay = preparePendingChatSendMutation(input);
    const changedContext = preparePendingChatSendMutation({
      ...input,
      mutationContext: { preferredAgentId: "agent-2", contextLinks: [] },
    });

    expect(replay.clientMutationId).toBe(first.clientMutationId);
    expect(changedContext.clientMutationId).not.toBe(first.clientMutationId);
  });
});
