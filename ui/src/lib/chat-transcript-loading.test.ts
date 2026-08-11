// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveChatLoadError, resolveChatTranscriptLoadState } from "./chat-transcript-loading";

describe("chat transcript loading", () => {
  it("keeps cached chat data visible when a background refresh fails", () => {
    expect(resolveChatLoadError([
      { data: [{ id: "message-1" }], error: new TypeError("Failed to fetch") },
      { data: { id: "chat-1" }, error: null },
    ])).toBeNull();
  });

  it("surfaces an initial chat load failure when no cached data exists", () => {
    const error = new TypeError("Failed to fetch");
    expect(resolveChatLoadError([
      { data: undefined, error },
      { data: [], error: null },
    ])).toBe(error);
  });

  it("starts the message query from a valid organization route before conversation detail resolves", () => {
    expect(resolveChatTranscriptLoadState({
      selectedOrganizationId: "org-1",
      conversationId: "chat-1",
      organizationRouteMatchesSelection: true,
      conversationSnapshotOrganizationId: null,
      hasConversationSnapshot: false,
      conversationDetailPending: true,
      hasMessages: false,
      messagesPending: true,
    })).toMatchObject({
      canQueryMessages: true,
      showConversationLoading: true,
      showMessagesLoading: false,
    });
  });

  it("keeps conversation loading active when messages resolve before detail", () => {
    expect(resolveChatTranscriptLoadState({
      selectedOrganizationId: "org-1",
      conversationId: "chat-1",
      organizationRouteMatchesSelection: true,
      conversationSnapshotOrganizationId: null,
      hasConversationSnapshot: false,
      conversationDetailPending: true,
      hasMessages: true,
      messagesPending: false,
    })).toEqual({
      canQueryMessages: true,
      showConversationLoading: true,
      showMessagesLoading: false,
    });
  });

  it("moves from conversation loading to message loading when detail resolves first", () => {
    expect(resolveChatTranscriptLoadState({
      selectedOrganizationId: "org-1",
      conversationId: "chat-1",
      organizationRouteMatchesSelection: true,
      conversationSnapshotOrganizationId: "org-1",
      hasConversationSnapshot: true,
      conversationDetailPending: false,
      hasMessages: false,
      messagesPending: true,
    })).toEqual({
      canQueryMessages: true,
      showConversationLoading: false,
      showMessagesLoading: true,
    });
  });

  it("does not query messages when the organization route does not match the selection", () => {
    expect(resolveChatTranscriptLoadState({
      selectedOrganizationId: "org-1",
      conversationId: "chat-1",
      organizationRouteMatchesSelection: false,
      conversationSnapshotOrganizationId: null,
      hasConversationSnapshot: false,
      conversationDetailPending: true,
      hasMessages: false,
      messagesPending: false,
    }).canQueryMessages).toBe(false);
  });

  it("does not query messages when a known conversation snapshot belongs to another organization", () => {
    expect(resolveChatTranscriptLoadState({
      selectedOrganizationId: "org-1",
      conversationId: "chat-1",
      organizationRouteMatchesSelection: true,
      conversationSnapshotOrganizationId: "org-2",
      hasConversationSnapshot: true,
      conversationDetailPending: false,
      hasMessages: false,
      messagesPending: false,
    }).canQueryMessages).toBe(false);
  });

  it("leaves loading states once a list or detail snapshot and messages are available", () => {
    expect(resolveChatTranscriptLoadState({
      selectedOrganizationId: "org-1",
      conversationId: "chat-1",
      organizationRouteMatchesSelection: true,
      conversationSnapshotOrganizationId: "org-1",
      hasConversationSnapshot: true,
      conversationDetailPending: true,
      hasMessages: true,
      messagesPending: false,
    })).toEqual({
      canQueryMessages: true,
      showConversationLoading: false,
      showMessagesLoading: false,
    });
  });
});
