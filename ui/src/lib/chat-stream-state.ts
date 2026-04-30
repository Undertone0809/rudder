import type { ChatMessage } from "@rudderhq/shared";

export type ActiveChatStreamVisibilityState = {
  userCreatedAt: Date;
  chatTurnId: string | null;
};

export function setChatFlagState(
  current: Record<string, true>,
  chatId: string,
  inFlight: boolean,
): Record<string, true> {
  if (inFlight) {
    if (current[chatId]) return current;
    return { ...current, [chatId]: true };
  }
  if (!current[chatId]) return current;
  const { [chatId]: _removed, ...rest } = current;
  return rest;
}

export function setChatScopedState<T>(
  current: Record<string, T>,
  chatId: string,
  value: T | null,
): Record<string, T> {
  if (value === null) {
    if (!(chatId in current)) return current;
    const { [chatId]: _removed, ...rest } = current;
    return rest;
  }
  return { ...current, [chatId]: value };
}

export function readChatScopedFlag(
  current: Record<string, true>,
  chatId: string | null | undefined,
): boolean {
  return Boolean(chatId && current[chatId]);
}

export function readChatScopedState<T>(
  current: Record<string, T>,
  chatId: string | null | undefined,
): T | null {
  if (!chatId) return null;
  return current[chatId] ?? null;
}

export function shouldShowMessageDuringActiveStream(
  message: Pick<ChatMessage, "role" | "chatTurnId" | "createdAt">,
  activeStream: ActiveChatStreamVisibilityState,
): boolean {
  if (message.role === "user") return true;
  if (activeStream.chatTurnId && message.chatTurnId === activeStream.chatTurnId) return false;
  return new Date(message.createdAt).getTime() < activeStream.userCreatedAt.getTime();
}
