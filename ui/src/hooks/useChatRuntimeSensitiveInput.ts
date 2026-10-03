import type { ChatRuntimeSensitiveInputRequest } from "@/api/chats";
import { chatsApi } from "@/api/chats";
import { useChatGenerations } from "@/context/ChatGenerationContext";
import { useCallback, useEffect } from "react";

export function useChatRuntimeSensitiveInput(chatId: string | null | undefined) {
  const { runtimeSensitiveInputs, setRuntimeSensitiveInputRequest } = useChatGenerations();
  const request = chatId ? runtimeSensitiveInputs[chatId] ?? null : null;

  const setRequest = useCallback((next: ChatRuntimeSensitiveInputRequest | null) => {
    if (chatId) setRuntimeSensitiveInputRequest(chatId, next);
  }, [chatId, setRuntimeSensitiveInputRequest]);

  useEffect(() => {
    if (!chatId) return;
    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const result = await chatsApi.listRuntimeSensitiveInputs(chatId);
        if (!disposed) setRuntimeSensitiveInputRequest(chatId, result.requests[0] ?? null);
      } catch {
        // Keep the last in-memory request while reconnect lookup is unavailable.
      } finally {
        refreshing = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1_500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      setRuntimeSensitiveInputRequest(chatId, null);
    };
  }, [chatId, setRuntimeSensitiveInputRequest]);

  const respond = useCallback(async (
    target: ChatRuntimeSensitiveInputRequest,
    value: string,
  ) => {
    if (!chatId) return;
    await chatsApi.respondToRuntimeSensitiveInput(chatId, target.requestId, value);
    setRuntimeSensitiveInputRequest(chatId, null);
  }, [chatId, setRuntimeSensitiveInputRequest]);

  const cancel = useCallback(async (target: ChatRuntimeSensitiveInputRequest) => {
    if (!chatId) return;
    await chatsApi.cancelRuntimeSensitiveInput(chatId, target.requestId);
    setRuntimeSensitiveInputRequest(chatId, null);
  }, [chatId, setRuntimeSensitiveInputRequest]);

  return { request, setRequest, respond, cancel };
}
