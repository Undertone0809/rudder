const activeChatGenerations = new Map<string, symbol>();

export function claimChatGeneration(conversationId: string): (() => void) | null {
  if (activeChatGenerations.has(conversationId)) return null;

  const token = Symbol(conversationId);
  activeChatGenerations.set(conversationId, token);

  return () => {
    if (activeChatGenerations.get(conversationId) === token) {
      activeChatGenerations.delete(conversationId);
    }
  };
}

export function hasActiveChatGeneration(conversationId: string): boolean {
  return activeChatGenerations.has(conversationId);
}
