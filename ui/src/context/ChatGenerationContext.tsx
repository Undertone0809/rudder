import type { TranscriptEntry } from "@/agent-runtimes";
import { useActivityCoordinator } from "@/context/ActivityCoordinatorContext";
import { setChatFlagState, setChatScopedState } from "@/lib/chat-stream-state";
import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

export type ChatStreamDraftState = "streaming" | "finalizing" | "stopping" | "stopped" | "failed";

export type ChatStreamDraft = {
  chatId: string;
  streamKey: string;
  userBody: string;
  userCreatedAt: Date;
  userMessageId: string | null;
  chatTurnId: string | null;
  turnVariant: number;
  editedFromCreatedAt: Date | null;
  body: string;
  generationId?: string | null;
  attemptEpoch?: number | null;
  lastCommittedRenderSeq?: number;
  renderedBodyHash?: string;
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

type ChatGenerationActions = Pick<
  ChatGenerationContextValue,
  | "isChatGenerationActive"
  | "setChatSendInFlight"
  | "setStreamDraftForChat"
  | "setStreamAbortController"
  | "abortChatStream"
>;

class ChatGenerationStatusStore {
  private readonly activeByChatId = new Map<string, boolean>();
  private readonly listenersByChatId = new Map<string, Set<() => void>>();

  getSnapshot = (chatId: string): boolean => this.activeByChatId.get(chatId) === true;

  subscribe = (chatId: string, listener: () => void): (() => void) => {
    const listeners = this.listenersByChatId.get(chatId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listenersByChatId.set(chatId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listenersByChatId.delete(chatId);
    };
  };

  setActive(chatId: string, active: boolean) {
    if (this.getSnapshot(chatId) === active) return;
    if (active) this.activeByChatId.set(chatId, true);
    else this.activeByChatId.delete(chatId);
    for (const listener of this.listenersByChatId.get(chatId) ?? []) listener();
  }
}

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
const ChatGenerationActionsContext = createContext<ChatGenerationActions>(defaultValue);
const fallbackStatusStore = new ChatGenerationStatusStore();
const ChatGenerationStatusStoreContext = createContext<ChatGenerationStatusStore>(fallbackStatusStore);

export function ChatGenerationProvider({ children }: { children: ReactNode }) {
  const activityCoordinator = useActivityCoordinator();
  const [streamDrafts, setStreamDrafts] = useState<Record<string, ChatStreamDraft>>({});
  const [sendInFlightByChatId, setSendInFlightByChatId] = useState<Record<string, true>>({});
  const streamDraftsRef = useRef(streamDrafts);
  const statusStoreRef = useRef<ChatGenerationStatusStore | null>(null);
  if (!statusStoreRef.current) statusStoreRef.current = new ChatGenerationStatusStore();
  const statusStore = statusStoreRef.current;
  const streamAbortControllersRef = useRef<Record<string, AbortController>>({});
  const presentationTimerRef = useRef<number | null>(null);
  const scrollStopTimerRef = useRef<number | null>(null);
  const scrollingUntilRef = useRef(0);

  const flushStreamDraftPresentation = useCallback(() => {
    if (presentationTimerRef.current !== null) {
      window.clearTimeout(presentationTimerRef.current);
      presentationTimerRef.current = null;
    }
    setStreamDrafts(streamDraftsRef.current);
  }, []);

  const scheduleStreamDraftPresentation = useCallback((immediate: boolean) => {
    if (immediate) {
      flushStreamDraftPresentation();
      return;
    }
    if (presentationTimerRef.current !== null) return;
    const scrolling = Date.now() < scrollingUntilRef.current;
    presentationTimerRef.current = window.setTimeout(() => {
      presentationTimerRef.current = null;
      if (scrolling) {
        startTransition(() => setStreamDrafts(streamDraftsRef.current));
      } else {
        setStreamDrafts(streamDraftsRef.current);
      }
    }, scrolling ? 200 : 50);
  }, [flushStreamDraftPresentation]);

  useEffect(() => {
    const markScrolling = () => {
      scrollingUntilRef.current = Date.now() + 120;
      if (scrollStopTimerRef.current !== null) {
        window.clearTimeout(scrollStopTimerRef.current);
      }
      scrollStopTimerRef.current = window.setTimeout(() => {
        scrollStopTimerRef.current = null;
        flushStreamDraftPresentation();
      }, 120);
    };
    window.addEventListener("scroll", markScrolling, { capture: true, passive: true });
    window.addEventListener("wheel", markScrolling, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", markScrolling, true);
      window.removeEventListener("wheel", markScrolling, true);
      if (presentationTimerRef.current !== null) {
        window.clearTimeout(presentationTimerRef.current);
      }
      if (scrollStopTimerRef.current !== null) {
        window.clearTimeout(scrollStopTimerRef.current);
      }
    };
  }, [flushStreamDraftPresentation]);

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
    const current = streamDraftsRef.current;
    const existing = current[chatId] ?? null;
    const resolved =
      typeof nextDraft === "function"
        ? nextDraft(existing)
        : nextDraft;
    const next = setChatScopedState(current, chatId, resolved);
    if (next === current) return;
    streamDraftsRef.current = next;
    statusStore.setActive(chatId, resolved !== null);
    if (existing?.state !== resolved?.state || (existing === null) !== (resolved === null)) {
      activityCoordinator.updateSummary(`chat:${chatId}`, {
        status: resolved?.state ?? (existing ? "completed" : null),
      });
    }
    if (resolved === null && existing) {
      if (presentationTimerRef.current !== null) {
        window.clearTimeout(presentationTimerRef.current);
        presentationTimerRef.current = null;
      }
      // Publish the exact final raw snapshot for one render so checkpoint and
      // persistence consumers observe it before the presentation row leaves.
      setStreamDrafts(current);
      window.setTimeout(() => setStreamDrafts(streamDraftsRef.current), 0);
      return;
    }
    const terminal = resolved === null
      || resolved.state === "failed"
      || resolved.state === "stopped";
    scheduleStreamDraftPresentation(terminal);
  }, [activityCoordinator, scheduleStreamDraftPresentation, statusStore]);

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
    (chatId: string | null | undefined) => Boolean(chatId && statusStore.getSnapshot(chatId)),
    [statusStore],
  );

  const actions = useMemo<ChatGenerationActions>(() => ({
    abortChatStream,
    isChatGenerationActive,
    setChatSendInFlight,
    setStreamDraftForChat,
    setStreamAbortController,
  }), [
    abortChatStream,
    isChatGenerationActive,
    setChatSendInFlight,
    setStreamAbortController,
    setStreamDraftForChat,
  ]);

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

  return (
    <ChatGenerationStatusStoreContext.Provider value={statusStore}>
      <ChatGenerationActionsContext.Provider value={actions}>
        <ChatGenerationContext.Provider value={value}>{children}</ChatGenerationContext.Provider>
      </ChatGenerationActionsContext.Provider>
    </ChatGenerationStatusStoreContext.Provider>
  );
}

export function useChatGenerations() {
  return useContext(ChatGenerationContext);
}

export function useChatGenerationActions() {
  return useContext(ChatGenerationActionsContext);
}

export function useChatGenerationActive(chatId: string) {
  const store = useContext(ChatGenerationStatusStoreContext);
  return useSyncExternalStore(
    (listener) => store.subscribe(chatId, listener),
    () => store.getSnapshot(chatId),
    () => store.getSnapshot(chatId),
  );
}
