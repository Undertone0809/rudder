import {
  clearSideChatSendDraft,
  readSideChatSendDraft,
  saveSideChatSendDraft,
} from "@/lib/side-chat-draft-storage";
import { useCallback, useEffect, useRef, useState } from "react";

type SideChatDraftScope = {
  principalId: string | null;
  organizationId: string;
  sourceConversationId: string;
  clientMutationId: string;
};

export function useSideChatSendDraft({
  principalId,
  organizationId,
  sourceConversationId,
  clientMutationId,
}: SideChatDraftScope) {
  const [persistedDraft] = useState(() => readSideChatSendDraft(
    principalId,
    organizationId,
    sourceConversationId,
    clientMutationId,
  ));
  const [draft, setDraft] = useState(() => persistedDraft?.body ?? "");
  const retryUserMessageIdRef = useRef<string | null>(persistedDraft?.acceptedUserMessageId ?? null);
  const submissionInFlightRef = useRef(false);

  useEffect(() => {
    if (submissionInFlightRef.current) return;
    saveSideChatSendDraft(principalId, organizationId, sourceConversationId, clientMutationId, {
      body: draft,
      acceptedUserMessageId: retryUserMessageIdRef.current,
    });
  }, [clientMutationId, draft, organizationId, principalId, sourceConversationId]);

  const saveDraft = useCallback((body: string, acceptedUserMessageId: string | null) => {
    saveSideChatSendDraft(principalId, organizationId, sourceConversationId, clientMutationId, {
      body,
      acceptedUserMessageId,
    });
  }, [clientMutationId, organizationId, principalId, sourceConversationId]);
  const clearDraft = useCallback(() => {
    retryUserMessageIdRef.current = null;
    setDraft("");
    clearSideChatSendDraft(principalId, organizationId, sourceConversationId, clientMutationId);
  }, [clientMutationId, organizationId, principalId, sourceConversationId]);

  return { draft, setDraft, retryUserMessageIdRef, submissionInFlightRef, saveDraft, clearDraft };
}
