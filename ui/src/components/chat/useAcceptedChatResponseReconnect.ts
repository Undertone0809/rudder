import type { ChatSendRecovery } from "@/components/chat/ChatSendRecoveryNotice";
import { readPendingChatStopRecovery } from "@/lib/chat-stop-recovery";
import type { ChatConversation, ChatInlineAnnotationInput } from "@rudderhq/shared";
import { useCallback, useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

type ScopedChatSendRecovery = ChatSendRecovery & { orgId: string; conversationId: string };

type AcceptedResponseResumeOptions = {
  bodyOverride: string;
  filesOverride: File[];
  inlineAnnotationsOverride: ChatInlineAnnotationInput[];
  conversationOverride: ChatConversation;
  forceImmediateSend: true;
  resumeClientMutationId: string;
};

type RecoveryDiscovery = {
  checking: boolean;
  clearRecovery: () => void;
  clearCompletedNotice: () => void;
};

const acceptedResponseAttachments = new Set<string>();
const acceptedResponseKey = (orgId: string, chatId: string, mutationId: string) => JSON.stringify([orgId, chatId, mutationId]);

export function resolveActiveChatSendRecovery(
  chatSendRecovery: ScopedChatSendRecovery | null,
  discoveredRecovery: ChatSendRecovery | null,
  selectedOrganizationId: string | null,
  selectedConversation: ChatConversation | null,
): ScopedChatSendRecovery | null {
  return (chatSendRecovery?.orgId === selectedOrganizationId
    && chatSendRecovery.conversationId === selectedConversation?.id ? chatSendRecovery : null)
    ?? (discoveredRecovery && selectedOrganizationId && selectedConversation
      ? { ...discoveredRecovery, orgId: selectedOrganizationId, conversationId: selectedConversation.id }
      : null);
}

/** Reconnects an accepted response once per page, organization, chat, and mutation. */
export function useAcceptedChatResponseReconnect(input: {
  activeRecovery: ScopedChatSendRecovery | null;
  chatSendRecovery: ScopedChatSendRecovery | null;
  selectedConversation: ChatConversation | null;
  selectedOrganizationId: string | null;
  selectedConversationStreamScopeKey: string | null;
  activeSendInFlight: boolean;
  sendInFlightByChatId: Record<string, true>;
  stoppingChatIds: Set<string>;
  chatSendLocksRef: MutableRefObject<Record<string, true>>;
  recoveryDiscovery: RecoveryDiscovery;
  setChatSendRecovery: Dispatch<SetStateAction<ScopedChatSendRecovery | null>>;
  sendMessage: (options: AcceptedResponseResumeOptions) => unknown;
}) {
  const {
    activeRecovery,
    chatSendRecovery,
    selectedConversation,
    selectedOrganizationId,
    selectedConversationStreamScopeKey,
    activeSendInFlight,
    sendInFlightByChatId,
    stoppingChatIds,
    chatSendLocksRef,
    recoveryDiscovery,
    setChatSendRecovery,
    sendMessage,
  } = input;
  const [responseReconnectVersion, setResponseReconnectVersion] = useState(0);

  useEffect(() => {
    const recovery = activeRecovery;
    if (!recovery || recovery.action === "retry" || !selectedConversation || !selectedOrganizationId
      || recoveryDiscovery.checking) return;
    const key = acceptedResponseKey(selectedOrganizationId, selectedConversation.id, recovery.clientMutationId);
    const attached = Boolean(selectedConversationStreamScopeKey && sendInFlightByChatId[selectedConversationStreamScopeKey]);
    const stopping = stoppingChatIds.has(selectedConversation.id)
      || Boolean(readPendingChatStopRecovery(selectedOrganizationId, selectedConversation.id));
    // Discovery can observe the send whose stream is already owned by this page.
    // Consume it now, so it cannot become a fresh send after that stream settles.
    if (!chatSendRecovery && (attached || stopping)) {
      recoveryDiscovery.clearRecovery();
      return;
    }
    if (attached || stopping || chatSendLocksRef.current[selectedConversation.id]
      || acceptedResponseAttachments.has(key)) return;
    acceptedResponseAttachments.add(key);
    recoveryDiscovery.clearRecovery();
    recoveryDiscovery.clearCompletedNotice();
    setChatSendRecovery(null);
    void sendMessage({
      bodyOverride: recovery.body,
      filesOverride: [],
      inlineAnnotationsOverride: [],
      conversationOverride: selectedConversation,
      forceImmediateSend: true,
      resumeClientMutationId: recovery.clientMutationId,
    });
  }, [activeRecovery, chatSendRecovery, selectedConversation, selectedOrganizationId,
    selectedConversationStreamScopeKey, sendInFlightByChatId, stoppingChatIds, recoveryDiscovery,
    responseReconnectVersion, sendMessage]);

  const isAttached = useCallback((orgId: string, chatId: string, mutationId: string) => (
    acceptedResponseAttachments.has(acceptedResponseKey(orgId, chatId, mutationId))
  ), []);

  const showReconnectProblem = Boolean(activeRecovery && selectedConversation && selectedOrganizationId
    && !activeSendInFlight && !stoppingChatIds.has(selectedConversation.id)
    && !readPendingChatStopRecovery(selectedOrganizationId, selectedConversation.id)
    && isAttached(selectedOrganizationId, selectedConversation.id, activeRecovery.clientMutationId));

  const retry = useCallback(() => {
    if (!activeRecovery || !selectedConversation || !selectedOrganizationId) return;
    acceptedResponseAttachments.delete(acceptedResponseKey(
      selectedOrganizationId,
      selectedConversation.id,
      activeRecovery.clientMutationId,
    ));
    setResponseReconnectVersion((version) => version + 1);
  }, [activeRecovery, selectedConversation, selectedOrganizationId]);

  return { isAttached, showReconnectProblem, retry };
}
