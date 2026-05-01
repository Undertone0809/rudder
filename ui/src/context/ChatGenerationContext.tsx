import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type ChatGenerationContextValue = {
  activeChatIds: ReadonlySet<string>;
  setChatGenerationActive: (chatId: string, active: boolean) => void;
  isChatGenerationActive: (chatId: string | null | undefined) => boolean;
};

const emptyActiveChatIds = new Set<string>();

const defaultValue: ChatGenerationContextValue = {
  activeChatIds: emptyActiveChatIds,
  setChatGenerationActive: () => {},
  isChatGenerationActive: () => false,
};

const ChatGenerationContext = createContext<ChatGenerationContextValue>(defaultValue);

export function ChatGenerationProvider({ children }: { children: ReactNode }) {
  const [activeChatIds, setActiveChatIds] = useState<Set<string>>(() => new Set());

  const setChatGenerationActive = useCallback((chatId: string, active: boolean) => {
    setActiveChatIds((current) => {
      const currentlyActive = current.has(chatId);
      if (active === currentlyActive) return current;
      const next = new Set(current);
      if (active) next.add(chatId);
      else next.delete(chatId);
      return next;
    });
  }, []);

  const isChatGenerationActive = useCallback(
    (chatId: string | null | undefined) => Boolean(chatId && activeChatIds.has(chatId)),
    [activeChatIds],
  );

  const value = useMemo(
    () => ({
      activeChatIds,
      setChatGenerationActive,
      isChatGenerationActive,
    }),
    [activeChatIds, isChatGenerationActive, setChatGenerationActive],
  );

  return <ChatGenerationContext.Provider value={value}>{children}</ChatGenerationContext.Provider>;
}

export function useChatGenerations() {
  return useContext(ChatGenerationContext);
}
