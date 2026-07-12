import type { ChatConversation, ChatRuntimeDescriptor } from "@rudderhq/shared";
import { describe, expect, it, vi } from "vitest";
import { enrichConversationRuntimeDescriptors } from "../services/chat-assistant.runtime-batch.js";

function makeDescriptor(overrides: Partial<ChatRuntimeDescriptor> = {}): ChatRuntimeDescriptor {
  return {
    sourceType: "agent",
    sourceLabel: "Chat Specialist",
    runtimeAgentId: "agent-1",
    agentRuntimeType: "codex_local",
    model: "gpt-5.4",
    available: true,
    error: null,
    ...overrides,
  };
}

function makeConversation(overrides: Partial<ChatConversation> = {}): ChatConversation {
  const now = new Date("2026-07-12T08:00:00.000Z");
  return {
    id: "chat-1",
    orgId: "organization-1",
    status: "active",
    mutability: "native_chat",
    title: "Runtime batch test",
    summary: null,
    latestReplyPreview: null,
    latestUserMessagePreview: null,
    userMessageCount: 0,
    preferredAgentId: "agent-1",
    routedAgentId: null,
    primaryIssueId: null,
    forkedFromConversationId: null,
    forkedFromMessageId: null,
    forkRootConversationId: null,
    primaryIssue: null,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "user-1",
    lastMessageAt: now,
    lastReadAt: now,
    isPinned: false,
    isUnread: false,
    unreadCount: 0,
    needsAttention: false,
    resolvedAt: null,
    contextLinks: [],
    chatRuntime: makeDescriptor({ sourceLabel: "Original descriptor" }),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("enrichConversationRuntimeDescriptors", () => {
  it("deduplicates 500 conversations sharing one organization and preferred agent", async () => {
    const descriptor = makeDescriptor();
    const resolveDescriptor = vi.fn().mockResolvedValue(descriptor);
    const conversations = Array.from({ length: 500 }, (_, index) => makeConversation({
      id: `chat-${index}`,
      chatRuntime: makeDescriptor({ sourceLabel: `Original ${index}` }),
    }));
    const inputSnapshots = conversations.map((conversation) => ({ ...conversation }));
    const inputDescriptors = conversations.map((conversation) => conversation.chatRuntime);

    const enriched = await enrichConversationRuntimeDescriptors(conversations, resolveDescriptor);

    expect(resolveDescriptor).toHaveBeenCalledTimes(1);
    expect(enriched).toHaveLength(conversations.length);
    expect(enriched.map((conversation) => conversation.id)).toEqual(
      conversations.map((conversation) => conversation.id),
    );
    enriched.forEach((conversation, index) => {
      expect(conversation).not.toBe(conversations[index]);
      expect(conversation).toEqual({
        ...conversations[index],
        chatRuntime: descriptor,
      });
      expect(conversation.chatRuntime).toBe(descriptor);
    });
    expect(conversations).toEqual(inputSnapshots);
    conversations.forEach((conversation, index) => {
      expect(conversation.chatRuntime).toBe(inputDescriptors[index]);
    });
  });

  it("resolves the same preferred agent separately for different organizations", async () => {
    const resolveDescriptor = vi.fn(async (conversation: Pick<ChatConversation, "orgId" | "preferredAgentId">) =>
      makeDescriptor({ sourceLabel: conversation.orgId }),
    );

    const enriched = await enrichConversationRuntimeDescriptors([
      makeConversation({ id: "chat-org-1", orgId: "organization-1" }),
      makeConversation({ id: "chat-org-2", orgId: "organization-2" }),
    ], resolveDescriptor);

    expect(resolveDescriptor).toHaveBeenCalledTimes(2);
    expect(resolveDescriptor.mock.calls.map(([conversation]) => conversation.orgId)).toEqual([
      "organization-1",
      "organization-2",
    ]);
    expect(enriched.map((conversation) => conversation.chatRuntime.sourceLabel)).toEqual([
      "organization-1",
      "organization-2",
    ]);
  });

  it("resolves different preferred agents separately within one organization", async () => {
    const resolveDescriptor = vi.fn(async (conversation: Pick<ChatConversation, "orgId" | "preferredAgentId">) =>
      makeDescriptor({
        sourceLabel: conversation.preferredAgentId ?? "Choose an agent",
        runtimeAgentId: conversation.preferredAgentId,
      }),
    );

    const enriched = await enrichConversationRuntimeDescriptors([
      makeConversation({ id: "chat-agent-1", preferredAgentId: "agent-1" }),
      makeConversation({ id: "chat-agent-2", preferredAgentId: "agent-2" }),
    ], resolveDescriptor);

    expect(resolveDescriptor).toHaveBeenCalledTimes(2);
    expect(resolveDescriptor.mock.calls.map(([conversation]) => conversation.preferredAgentId)).toEqual([
      "agent-1",
      "agent-2",
    ]);
    expect(enriched.map((conversation) => conversation.chatRuntime.runtimeAgentId)).toEqual([
      "agent-1",
      "agent-2",
    ]);
  });

  it("deduplicates missing preferred agents and preserves the supplied unconfigured descriptor", async () => {
    const unconfiguredDescriptor = makeDescriptor({
      sourceType: "unconfigured",
      sourceLabel: "Choose an agent",
      runtimeAgentId: null,
      agentRuntimeType: null,
      model: null,
      available: false,
      error: "Choose a chat agent before sending messages.",
    });
    const resolveDescriptor = vi.fn(async (conversation: Pick<ChatConversation, "orgId" | "preferredAgentId">) => {
      expect(conversation.preferredAgentId).toBeNull();
      return unconfiguredDescriptor;
    });

    const enriched = await enrichConversationRuntimeDescriptors([
      makeConversation({ id: "chat-unconfigured-1", preferredAgentId: null }),
      makeConversation({ id: "chat-unconfigured-2", preferredAgentId: null }),
    ], resolveDescriptor);

    expect(resolveDescriptor).toHaveBeenCalledTimes(1);
    expect(enriched.map((conversation) => conversation.chatRuntime)).toEqual([
      unconfiguredDescriptor,
      unconfiguredDescriptor,
    ]);
  });

  it("rejects the full enrichment when one unique runtime resolution rejects", async () => {
    const failure = new Error("runtime resolution failed");
    const resolveDescriptor = vi.fn(async (conversation: Pick<ChatConversation, "orgId" | "preferredAgentId">) => {
      if (conversation.preferredAgentId === "agent-1") throw failure;
      return makeDescriptor({ runtimeAgentId: conversation.preferredAgentId });
    });

    const enrichment = enrichConversationRuntimeDescriptors([
      makeConversation({ id: "chat-failing-1", preferredAgentId: "agent-1" }),
      makeConversation({ id: "chat-failing-2", preferredAgentId: "agent-1" }),
      makeConversation({ id: "chat-success", preferredAgentId: "agent-2" }),
    ], resolveDescriptor);

    await expect(enrichment).rejects.toBe(failure);
    expect(resolveDescriptor).toHaveBeenCalledTimes(2);
  });
});
