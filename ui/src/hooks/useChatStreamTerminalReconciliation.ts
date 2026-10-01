import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import { queryKeys } from "@/lib/queryKeys";
import { activeGenerationIdFromSnapshot } from "@/pages/Chat.workspace-helpers";
import type { ChatMessage, ChatQueueSnapshot } from "@rudderhq/shared";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

type UseChatStreamTerminalReconciliationInput = {
  orgId: string | null;
  chatId: string | null;
  scopeKey: string | null;
  queueSnapshot: ChatQueueSnapshot | undefined;
  messages: ChatMessage[];
  stream: ChatStreamDraft | null;
  queryClient: QueryClient;
  setChatSendInFlight: (chatId: string, inFlight: boolean) => void;
  setStreamDraftForChat: (
    chatId: string,
    nextDraft: null | ((current: ChatStreamDraft | null) => ChatStreamDraft | null),
  ) => void;
};

export function useChatStreamTerminalReconciliation({
  orgId,
  chatId,
  scopeKey,
  queueSnapshot,
  messages,
  stream,
  queryClient,
  setChatSendInFlight,
  setStreamDraftForChat,
}: UseChatStreamTerminalReconciliationInput) {
  const currentStreamRef = useRef(stream);
  currentStreamRef.current = stream;

  const activeGenerationId = activeGenerationIdFromSnapshot(queueSnapshot);
  const streamKey = stream?.streamKey ?? null;
  const generationId = stream?.generationId ?? null;
  const hasTerminalAssistantMessage = Boolean(generationId && messages.some((message) => (
    message.role === "assistant"
    && message.generationId === generationId
    && message.status !== "streaming"
  )));
  const hasQueueSnapshot = queueSnapshot !== undefined;
  const awaitingFinalProjection = stream?.state === "waiting_for_network";

  useEffect(() => {
    if (!orgId || !chatId || !scopeKey || !streamKey || !generationId) return;

    const clearCompletedStream = () => {
      if (currentStreamRef.current?.streamKey !== streamKey) return;
      setStreamDraftForChat(scopeKey, (current) => current?.streamKey === streamKey ? null : current);
      setChatSendInFlight(scopeKey, false);
    };

    if (hasTerminalAssistantMessage) {
      clearCompletedStream();
      return;
    }
    if (!hasQueueSnapshot || (activeGenerationId === generationId && !awaitingFinalProjection)) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryIndex = 0;
    const messagesKey = queryKeys.chats.messages(orgId, chatId);
    const terminalMessageIsCached = () => queryClient.getQueryData<ChatMessage[]>(messagesKey)?.some((message) => (
        message.role === "assistant"
        && message.generationId === generationId
        && message.status !== "streaming"
      )) ?? false;

    const reconcile = async () => {
      if (cancelled || currentStreamRef.current?.streamKey !== streamKey) return;
      try {
        await queryClient.invalidateQueries({ queryKey: messagesKey, exact: true });
      } catch {
        // A later bounded refresh may still observe the committed assistant message.
      }
      if (cancelled || currentStreamRef.current?.streamKey !== streamKey) return;
      if (terminalMessageIsCached()) {
        clearCompletedStream();
        return;
      }

      const delays = [250, 500, 1_000, 2_000, 4_000, 8_000];
      const delay = delays[Math.min(retryIndex, delays.length - 1)]!;
      retryIndex += 1;
      retryTimer = setTimeout(() => void reconcile(), delay);
    };

    void reconcile();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [
    activeGenerationId,
    awaitingFinalProjection,
    chatId,
    generationId,
    hasQueueSnapshot,
    hasTerminalAssistantMessage,
    orgId,
    queryClient,
    scopeKey,
    setChatSendInFlight,
    setStreamDraftForChat,
    streamKey,
  ]);
}
