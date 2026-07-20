import type { ChatConversation, ChatMessage } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { latestSideChatAnchor, sideChatConversationMessages, sideChatIsReadOnly } from "./side-chat";

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: crypto.randomUUID(),
    orgId: "org-1",
    conversationId: "chat-1",
    role: "assistant",
    kind: "message",
    status: "completed",
    body: "answer",
    structuredPayload: null,
    approvalId: null,
    approval: null,
    attachments: [],
    replyingAgentId: null,
    chatTurnId: null,
    turnVariant: 0,
    supersededAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("Side Chat helpers", () => {
  it("anchors to the latest completed assistant response", () => {
    const older = message({ id: "older", body: "older" });
    const streaming = message({ id: "streaming", status: "streaming" });
    expect(latestSideChatAnchor([older, message({ role: "user" }), streaming])).toBe(older);
  });

  it("shows only messages created after the Side Chat boundary", () => {
    const copied = message({ id: "copied" });
    const boundary = message({
      id: "boundary",
      role: "system",
      kind: "system_event",
      structuredPayload: { eventType: "side_chat_started" },
    });
    const followUp = message({ id: "follow-up", role: "user" });
    expect(sideChatConversationMessages([copied, boundary, followUp])).toEqual([followUp]);
  });

  it("makes completed and expired Side Chats read-only", () => {
    expect(sideChatIsReadOnly({ conversationKind: "side_chat", sideChatState: "completed" } as ChatConversation)).toBe(true);
    expect(sideChatIsReadOnly({ conversationKind: "side_chat", sideChatState: "expired" } as ChatConversation)).toBe(true);
    expect(sideChatIsReadOnly({ conversationKind: "side_chat", sideChatState: "active" } as ChatConversation)).toBe(false);
  });

  it("makes an active Side Chat read-only as soon as its local expiry elapses", () => {
    const conversation = {
      conversationKind: "side_chat",
      sideChatState: "active",
      sideChatExpiresAt: new Date("2026-07-20T10:00:00.000Z"),
    } as ChatConversation;
    expect(sideChatIsReadOnly(conversation, new Date("2026-07-20T09:59:59.999Z"))).toBe(false);
    expect(sideChatIsReadOnly(conversation, new Date("2026-07-20T10:00:00.000Z"))).toBe(true);
  });

  it("keeps a promoted Side Chat editable as a normal Chat", () => {
    expect(sideChatIsReadOnly({
      conversationKind: "side_chat",
      sideChatState: "kept",
      sideChatExpiresAt: null,
    } as ChatConversation)).toBe(false);
  });
});
