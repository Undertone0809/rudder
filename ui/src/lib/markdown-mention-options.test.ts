import { describe, expect, it } from "vitest";
import { buildMarkdownMentionOptions } from "./markdown-mention-options";

describe("buildMarkdownMentionOptions", () => {
  it("includes chat conversations as mentionable entities", () => {
    const options = buildMarkdownMentionOptions({
      chats: [
        {
          id: "chat-1",
          orgId: "org-1",
          status: "active",
          title: "Launch planning",
          summary: "Coordinate launch work",
          latestReplyPreview: null,
          preferredAgentId: null,
          routedAgentId: null,
          primaryIssueId: null,
          primaryIssue: null,
          issueCreationMode: "manual_approval",
          planMode: false,
          createdByUserId: null,
          lastMessageAt: null,
          lastReadAt: null,
          isPinned: false,
          isUnread: false,
          unreadCount: 0,
          needsAttention: false,
          resolvedAt: null,
          contextLinks: [],
          chatRuntime: {
            sourceType: "unconfigured",
            sourceLabel: "Unconfigured",
            runtimeAgentId: null,
            agentRuntimeType: null,
            model: null,
            available: false,
            error: null,
          },
          createdAt: new Date("2026-05-20T00:00:00Z"),
          updatedAt: new Date("2026-05-20T00:00:00Z"),
        },
      ],
    });

    expect(options).toContainEqual(expect.objectContaining({
      id: "chat:chat-1",
      name: "Launch planning",
      kind: "chat",
      chatConversationId: "chat-1",
      searchText: expect.stringContaining("Coordinate launch work"),
    }));
  });
});
