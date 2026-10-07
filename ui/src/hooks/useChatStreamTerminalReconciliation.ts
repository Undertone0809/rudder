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

function isTerminalAssistantMessageForStream(
  message: ChatMessage,
  stream: Pick<ChatStreamDraft, "generationId" | "chatTurnId" | "turnVariant">,
) {
  if (message.role !== "assistant" || message.status === "streaming") return false;
  if (stream.generationId) return message.generationId === stream.generationId;
  return Boolean(
    stream.chatTurnId
    && message.chatTurnId === stream.chatTurnId
    && (message.turnVariant ?? 0) === (stream.turnVariant ?? 0),
  );
}

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
  const hasTerminalAssistantMessage = Boolean(
    stream && messages.some((message) => isTerminalAssistantMessageForStream(message, stream)),
  );
  const hasQueueSnapshot = queueSnapshot !== undefined;
  const awaitingFinalProjection = stream?.state === "waiting_for_network" || stream?.state === "finalizing";

  useEffect(() => {
    if (!orgId || !chatId || !scopeKey || !streamKey || !stream) return;

    const clearCompletedStream = () => {
      if (currentStreamRef.current?.streamKey !== streamKey) return;
      setStreamDraftForChat(scopeKey, (current) => current?.streamKey === streamKey ? null : current);
      setChatSendInFlight(scopeKey, false);
    };

    if (hasTerminalAssistantMessage) {
      clearCompletedStream();
      return;
    }
    // A generation-less stream is only safe to reconcile after the transport
    // has entered its terminal-projection recovery states. Polling while an
    // ordinary live stream is still producing events can race its own writer.
    if (!generationId && !awaitingFinalProjection) return;
    if (!hasQueueSnapshot || (generationId && activeGenerationId === generationId && !awaitingFinalProjection)) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryIndex = 0;
    const messagesKey = queryKeys.chats.messages(orgId, chatId);
    const terminalMessageIsCached = () => queryClient.getQueryData<ChatMessage[]>(messagesKey)?.some(
      (message) => isTerminalAssistantMessageForStream(message, stream),
    ) ?? false;

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
    stream,
  ]);
}
