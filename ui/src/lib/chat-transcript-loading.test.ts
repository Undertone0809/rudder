// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveChatTranscriptLoadState } from "./chat-transcript-loading";

describe("chat transcript loading", () => {
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
