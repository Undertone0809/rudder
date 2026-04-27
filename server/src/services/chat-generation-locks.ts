type ActiveChatGeneration = {
  token: symbol;
  abortController: AbortController | null;
};

const activeChatGenerations = new Map<string, ActiveChatGeneration>();

export function claimChatGeneration(
  conversationId: string,
  abortController: AbortController | null = null,
): (() => void) | null {
  if (activeChatGenerations.has(conversationId)) return null;

  const token = Symbol(conversationId);
  activeChatGenerations.set(conversationId, { token, abortController });

  return () => {
    if (activeChatGenerations.get(conversationId)?.token === token) {
      activeChatGenerations.delete(conversationId);
    }
  };
}

export function hasActiveChatGeneration(conversationId: string): boolean {
  return activeChatGenerations.has(conversationId);
}

export function cancelActiveChatGeneration(conversationId: string): boolean {
  const active = activeChatGenerations.get(conversationId);
  if (!active?.abortController) return false;
  if (!active.abortController.signal.aborted) {
    active.abortController.abort();
  }
  return true;
}
