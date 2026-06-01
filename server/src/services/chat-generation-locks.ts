type ActiveChatGeneration = {
  generationId: string | null;
  token: symbol;
  abortController: AbortController | null;
};

const activeChatGenerations = new Map<string, ActiveChatGeneration>();

export function claimChatGeneration(
  conversationId: string,
  abortController: AbortController | null = null,
  generationId: string | null = null,
): (() => void) | null {
  if (activeChatGenerations.has(conversationId)) return null;

  const token = Symbol(conversationId);
  activeChatGenerations.set(conversationId, { token, abortController, generationId });

  return () => {
    if (activeChatGenerations.get(conversationId)?.token === token) {
      activeChatGenerations.delete(conversationId);
    }
  };
}

export function hasActiveChatGeneration(conversationId: string): boolean {
  return activeChatGenerations.has(conversationId);
}

export function getActiveChatGeneration(conversationId: string): { generationId: string | null } | null {
  const active = activeChatGenerations.get(conversationId);
  if (!active) return null;
  return { generationId: active.generationId };
}

export function setActiveChatGenerationId(conversationId: string, generationId: string): boolean {
  const active = activeChatGenerations.get(conversationId);
  if (!active) return false;
  active.generationId = generationId;
  return true;
}

export function cancelActiveChatGeneration(conversationId: string): boolean {
  const active = activeChatGenerations.get(conversationId);
  if (!active?.abortController) return false;
  if (!active.abortController.signal.aborted) {
    active.abortController.abort();
  }
  return true;
}

export function clearActiveChatGenerationsForTest() {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") return;
  activeChatGenerations.clear();
}
