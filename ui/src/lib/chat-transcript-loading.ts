export type ChatTranscriptLoadInput = {
  selectedOrganizationId: string | null;
  conversationId: string | null;
  organizationRouteMatchesSelection: boolean;
  hasConversationSnapshot: boolean;
  conversationDetailPending: boolean;
  hasMessages: boolean;
  messagesPending: boolean;
};

export type ChatTranscriptLoadState = {
  canQueryMessages: boolean;
  showConversationLoading: boolean;
  showMessagesLoading: boolean;
};

export function resolveChatTranscriptLoadState(
  input: ChatTranscriptLoadInput,
): ChatTranscriptLoadState {
  const canQueryMessages = Boolean(
    input.selectedOrganizationId
    && input.conversationId
    && input.organizationRouteMatchesSelection,
  );
  return {
    canQueryMessages,
    showConversationLoading: Boolean(
      input.conversationId
      && (
        !input.organizationRouteMatchesSelection
        || (!input.hasConversationSnapshot && input.conversationDetailPending)
      )
    ),
    showMessagesLoading: Boolean(
      input.conversationId
      && input.hasConversationSnapshot
      && input.messagesPending
      && !input.hasMessages
    ),
  };
}
