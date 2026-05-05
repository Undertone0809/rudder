import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { TranscriptEntry } from "@/agent-runtimes";
import { setChatFlagState, setChatScopedState } from "@/lib/chat-stream-state";

export type ChatStreamDraftState = "streaming" | "finalizing" | "stopped" | "failed";

export type ChatStreamDraft = {
  chatId: string;
  userBody: string;
  userCreatedAt: Date;
  userMessageId: string | null;
  chatTurnId: string | null;
  editedFromCreatedAt: Date | null;
  body: string;
  state: ChatStreamDraftState;
  createdAt: Date;
  transcript: TranscriptEntry[];
  replyingAgentId: string | null;
};

type ChatGenerationContextValue = {
  activeChatIds: ReadonlySet<string>;
  streamDrafts: Record<string, ChatStreamDraft>;
  sendInFlightByChatId: Record<string, true>;
  isChatGenerationActive: (chatId: string | null | undefined) => boolean;
  setChatSendInFlight: (chatId: string, inFlight: boolean) => void;
  setStreamDraftForChat: (
    chatId: string,
    nextDraft:
      | ChatStreamDraft
      | null
      | ((current: ChatStreamDraft | null) => ChatStreamDraft | null),
  ) => void;
  setStreamAbortController: (chatId: string, controller: AbortController | null) => void;
  abortChatStream: (chatId: string) => void;
};

const emptyActiveChatIds = new Set<string>();

const defaultValue: ChatGenerationContextValue = {
  activeChatIds: emptyActiveChatIds,
  streamDrafts: {},
  sendInFlightByChatId: {},
  isChatGenerationActive: () => false,
  setChatSendInFlight: () => {},
  setStreamDraftForChat: () => {},
  setStreamAbortController: () => {},
  abortChatStream: () => {},
};

const ChatGenerationContext = createContext<ChatGenerationContextValue>(defaultValue);

export function ChatGenerationProvider({ children }: { children: ReactNode }) {
  const [streamDrafts, setStreamDrafts] = useState<Record<string, ChatStreamDraft>>({});
  const [sendInFlightByChatId, setSendInFlightByChatId] = useState<Record<string, true>>({});
  const streamAbortControllersRef = useRef<Record<string, AbortController>>({});

  const activeChatIds = useMemo(
    () => new Set(Object.keys(streamDrafts)),
    [streamDrafts],
  );

  const setChatSendInFlight = useCallback((chatId: string, inFlight: boolean) => {
    setSendInFlightByChatId((current) => setChatFlagState(current, chatId, inFlight));
  }, []);

  const setStreamDraftForChat = useCallback((
    chatId: string,
    nextDraft:
      | ChatStreamDraft
      | null
      | ((current: ChatStreamDraft | null) => ChatStreamDraft | null),
  ) => {
    setStreamDrafts((current) => {
      const existing = current[chatId] ?? null;
      const resolved =
        typeof nextDraft === "function"
          ? nextDraft(existing)
          : nextDraft;
      return setChatScopedState(current, chatId, resolved);
    });
  }, []);

  const setStreamAbortController = useCallback((chatId: string, controller: AbortController | null) => {
    if (controller) {
      streamAbortControllersRef.current = {
        ...streamAbortControllersRef.current,
        [chatId]: controller,
      };
      return;
    }
    if (!(chatId in streamAbortControllersRef.current)) return;
    const { [chatId]: _removed, ...rest } = streamAbortControllersRef.current;
    streamAbortControllersRef.current = rest;
  }, []);

  const abortChatStream = useCallback((chatId: string) => {
    streamAbortControllersRef.current[chatId]?.abort();
  }, []);

  const isChatGenerationActive = useCallback(
    (chatId: string | null | undefined) => Boolean(chatId && activeChatIds.has(chatId)),
    [activeChatIds],
  );

  const value = useMemo(
    () => ({
      activeChatIds,
      streamDrafts,
      sendInFlightByChatId,
      isChatGenerationActive,
      setChatSendInFlight,
      setStreamDraftForChat,
      setStreamAbortController,
      abortChatStream,
    }),
    [
      abortChatStream,
      activeChatIds,
      isChatGenerationActive,
      sendInFlightByChatId,
      setChatSendInFlight,
      setStreamAbortController,
      setStreamDraftForChat,
      streamDrafts,
    ],
  );

  return <ChatGenerationContext.Provider value={value}>{children}</ChatGenerationContext.Provider>;
}

export function useChatGenerations() {
  return useContext(ChatGenerationContext);
}
