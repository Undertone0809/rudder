export type ChatTranscriptLoadInput = {
  selectedOrganizationId: string | null;
  conversationId: string | null;
  organizationRouteMatchesSelection: boolean;
  conversationSnapshotOrganizationId: string | null;
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

export type ChatLoadQueryState = {
  data: unknown;
  error: unknown;
};

export function resolveChatLoadError(queries: ChatLoadQueryState[]): unknown {
  for (const query of queries) {
    if (query.data === undefined && query.error) return query.error;
  }
  return null;
}

export function resolveChatTranscriptLoadState(
  input: ChatTranscriptLoadInput,
): ChatTranscriptLoadState {
  const knownConversationOrganizationMismatch = Boolean(
    input.selectedOrganizationId
    && input.conversationSnapshotOrganizationId
    && input.selectedOrganizationId !== input.conversationSnapshotOrganizationId,
  );
  const canQueryMessages = Boolean(
    input.selectedOrganizationId
    && input.conversationId
    && input.organizationRouteMatchesSelection
    && !knownConversationOrganizationMismatch
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
