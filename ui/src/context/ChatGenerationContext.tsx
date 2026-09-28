import type { TranscriptEntry } from "@/agent-runtimes";
import type { ChatRuntimeSensitiveInputRequest } from "@/api/chats";
import { useActivityCoordinator } from "@/context/ActivityCoordinatorContext";
import { FirstChatTurnProvider } from "@/context/FirstChatTurnContext";
import { setChatFlagState, setChatScopedState } from "@/lib/chat-stream-state";
import { createContext, startTransition, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

export type ChatStreamDraftState = "streaming" | "tool_busy" | "finalizing" | "waiting_for_network" | "stopping" | "stopped" | "failed";

export class ChatGenerationCloseSupersededError extends Error {
  constructor() {
    super("Side Chat close was superseded by a newer generation.");
    this.name = "ChatGenerationCloseSupersededError";
  }
}

export type ChatStreamDraft = {
  // Provisional Side Chats have no backend conversation until their first send is acknowledged.
  chatId: string | null;
  streamKey: string;
  // The generation epoch that owns this local stream attempt.
  generationEpoch?: number;
  generationOwnerKey?: string;
  // Stable per-message id used to replay a request after a lost stream response.
  clientMutationId?: string | null;
  userBody: string;
  // Keep pending blobs visible during the optimistic handoff; they are memory-only.
  userFiles?: File[];
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

export type ChatGenerationScopeStart = {
  epoch: number;
  conversationId: string | null;
  ownerSignal?: AbortSignal;
};

export type ChatGenerationScopeClose = ChatGenerationScopeStart;

export function chatGenerationOwnerStateKey(scopeKey: string, ownerKey: string) {
  return JSON.stringify([scopeKey, ownerKey]);
}

type ChatGenerationScopeState = {
  epoch: number;
  conversationId: string | null;
  closeRequested: boolean;
  sendClaimed: boolean;
  ownerKey: string | null;
  sendStateKey: string;
  ownerController: AbortController | null;
};

type ChatGenerationContextValue = {
  activeChatIds: ReadonlySet<string>;
  streamDrafts: Record<string, ChatStreamDraft>;
  runtimeSensitiveInputs: Record<string, ChatRuntimeSensitiveInputRequest>;
  sendInFlightByChatId: Record<string, true>;
  isChatGenerationActive: (chatId: string | null | undefined) => boolean;
  setChatSendInFlight: (chatId: string, inFlight: boolean) => void;
  setRuntimeSensitiveInputRequest: (chatId: string, request: ChatRuntimeSensitiveInputRequest | null) => void;
  setStreamDraftForChat: (
    chatId: string,
    nextDraft:
      | ChatStreamDraft
      | null
      | ((current: ChatStreamDraft | null) => ChatStreamDraft | null),
  ) => void;
  setStreamAbortController: (chatId: string, controller: AbortController | null) => void;
  abortChatStream: (chatId: string) => void;
  clearChatGenerationProviderState: (
    scopeKey: string,
    epoch: number,
    streamKey?: string | null,
  ) => boolean;
  beginChatGeneration: (scopeKey: string, conversationId: string | null) => ChatGenerationScopeStart;
  tryBeginChatGeneration: (
    scopeKey: string,
    conversationId: string | null,
    ownerKey?: string,
  ) => ChatGenerationScopeStart | null;
  invalidateChatGenerationsForOwner: (ownerKey: string) => void;
  completeChatGenerationOwner: (ownerKey: string, ownerSignal: AbortSignal | undefined) => void;
  rememberChatGenerationConversation: (scopeKey: string, conversationId: string) => void;
  setChatGenerationConversation: (scopeKey: string, epoch: number, conversationId: string) => boolean;
  getChatGenerationEpoch: (scopeKey: string) => number | null;
  isChatGenerationCurrent: (scopeKey: string, epoch: number) => boolean;
  isChatGenerationClosePending: (scopeKey: string, epoch?: number) => boolean;
  releaseChatGenerationScope: (scopeKey: string, epoch: number) => void;
  requestChatGenerationClose: (scopeKey: string, knownConversationId?: string | null) => ChatGenerationScopeClose;
  resetChatGenerationClose: (scopeKey: string, epoch: number) => void;
  clearChatGenerationConversation: (scopeKey: string, conversationId: string) => void;
  destroyChatGenerationConversation: (
    scopeKey: string,
    conversationId: string,
    destroyer: () => Promise<void>,
  ) => Promise<void>;
};

type ChatGenerationActions = Pick<
  ChatGenerationContextValue,
  | "isChatGenerationActive"
  | "setChatSendInFlight"
  | "setRuntimeSensitiveInputRequest"
  | "setStreamDraftForChat"
  | "setStreamAbortController"
  | "abortChatStream"
  | "clearChatGenerationProviderState"
  | "beginChatGeneration"
  | "tryBeginChatGeneration"
  | "invalidateChatGenerationsForOwner"
  | "completeChatGenerationOwner"
  | "rememberChatGenerationConversation"
  | "setChatGenerationConversation"
  | "getChatGenerationEpoch"
  | "isChatGenerationCurrent"
  | "isChatGenerationClosePending"
  | "releaseChatGenerationScope"
  | "requestChatGenerationClose"
  | "resetChatGenerationClose"
  | "clearChatGenerationConversation"
  | "destroyChatGenerationConversation"
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
  runtimeSensitiveInputs: {},
  sendInFlightByChatId: {},
  isChatGenerationActive: () => false,
  setChatSendInFlight: () => {},
  setRuntimeSensitiveInputRequest: () => {},
  setStreamDraftForChat: () => {},
  setStreamAbortController: () => {},
  abortChatStream: () => {},
  clearChatGenerationProviderState: () => false,
  beginChatGeneration: () => ({ epoch: 0, conversationId: null }),
  tryBeginChatGeneration: () => null,
  invalidateChatGenerationsForOwner: () => {},
  completeChatGenerationOwner: () => {},
  rememberChatGenerationConversation: () => {},
  setChatGenerationConversation: () => false,
  getChatGenerationEpoch: () => null,
  isChatGenerationCurrent: () => false,
  isChatGenerationClosePending: () => false,
  releaseChatGenerationScope: () => {},
  requestChatGenerationClose: () => ({ epoch: 0, conversationId: null }),
  resetChatGenerationClose: () => {},
  clearChatGenerationConversation: () => {},
  destroyChatGenerationConversation: async (_scopeKey, _conversationId, destroyer) => {
    await destroyer();
  },
};

const ChatGenerationContext = createContext<ChatGenerationContextValue>(defaultValue);
const ChatGenerationActionsContext = createContext<ChatGenerationActions>(defaultValue);
const fallbackStatusStore = new ChatGenerationStatusStore();
const ChatGenerationStatusStoreContext = createContext<ChatGenerationStatusStore>(fallbackStatusStore);

export function ChatGenerationProvider({ children }: { children: ReactNode }) {
  const activityCoordinator = useActivityCoordinator();
  const [streamDrafts, setStreamDrafts] = useState<Record<string, ChatStreamDraft>>({});
  const [runtimeSensitiveInputs, setRuntimeSensitiveInputs] = useState<Record<string, ChatRuntimeSensitiveInputRequest>>({});
  const [sendInFlightByChatId, setSendInFlightByChatId] = useState<Record<string, true>>({});
  const streamDraftsRef = useRef(streamDrafts);
  const statusStoreRef = useRef<ChatGenerationStatusStore | null>(null);
  if (!statusStoreRef.current) statusStoreRef.current = new ChatGenerationStatusStore();
  const statusStore = statusStoreRef.current;
  const streamAbortControllersRef = useRef<Record<string, AbortController>>({});
  const generationScopesRef = useRef<Record<string, ChatGenerationScopeState>>({});
  const generationEpochRef = useRef(0);
  const ownerControllersRef = useRef<Record<string, AbortController[]>>({});
  const destructionPromisesRef = useRef<Record<string, {
    conversationId: string;
    promise: Promise<void>;
  }>>({});
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

  const setRuntimeSensitiveInputRequest = useCallback((
    chatId: string,
    request: ChatRuntimeSensitiveInputRequest | null,
  ) => {
    setRuntimeSensitiveInputs((current) => setChatScopedState(current, chatId, request));
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

  const clearChatGenerationProviderState = useCallback((
    scopeKey: string,
    epoch: number,
    expectedStreamKey?: string | null,
  ) => {
    const scope = generationScopesRef.current[scopeKey];
    if (!scope || scope.epoch !== epoch) return false;
    const currentDraft = streamDraftsRef.current[scopeKey];
    if (expectedStreamKey && currentDraft && currentDraft.streamKey !== expectedStreamKey) return false;

    streamAbortControllersRef.current[scopeKey]?.abort();
    setStreamAbortController(scopeKey, null);
    setChatSendInFlight(scope.sendStateKey, false);
    if (scope.conversationId) setRuntimeSensitiveInputRequest(scope.conversationId, null);
    setStreamDraftForChat(scopeKey, (current) => (
      expectedStreamKey && current && current.streamKey !== expectedStreamKey
        ? current
        : null
    ));
    return true;
  }, [setChatSendInFlight, setRuntimeSensitiveInputRequest, setStreamAbortController, setStreamDraftForChat]);

  const invalidateChatGenerationsForOwner = useCallback((ownerKey: string) => {
    for (const controller of ownerControllersRef.current[ownerKey] ?? []) {
      controller.abort();
    }
    const { [ownerKey]: _removed, ...remainingControllers } = ownerControllersRef.current;
    ownerControllersRef.current = remainingControllers;

    for (const [scopeKey, scope] of Object.entries(generationScopesRef.current)) {
      if (scope.ownerKey !== ownerKey) continue;
      clearChatGenerationProviderState(scopeKey, scope.epoch);
      scope.epoch = ++generationEpochRef.current;
      scope.conversationId = null;
      scope.closeRequested = false;
      scope.sendClaimed = false;
      scope.ownerKey = null;
      scope.sendStateKey = scopeKey;
      scope.ownerController?.abort();
      scope.ownerController = null;
    }
  }, [clearChatGenerationProviderState]);

  const completeChatGenerationOwner = useCallback((ownerKey: string, ownerSignal: AbortSignal | undefined) => {
    if (!ownerSignal) return;
    const controllers = ownerControllersRef.current[ownerKey];
    if (!controllers) return;
    const remaining = controllers.filter((controller) => controller.signal !== ownerSignal);
    if (remaining.length === controllers.length) return;
    if (remaining.length === 0) {
      const { [ownerKey]: _removed, ...rest } = ownerControllersRef.current;
      ownerControllersRef.current = rest;
      return;
    }
    ownerControllersRef.current = {
      ...ownerControllersRef.current,
      [ownerKey]: remaining,
    };
  }, []);

  const ensureGenerationScope = useCallback((scopeKey: string) => {
    const existing = generationScopesRef.current[scopeKey];
    if (existing) return existing;
    const next: ChatGenerationScopeState = {
      epoch: 0,
      conversationId: null,
      closeRequested: false,
      sendClaimed: false,
      ownerKey: null,
      sendStateKey: scopeKey,
      ownerController: null,
    };
    generationScopesRef.current = {
      ...generationScopesRef.current,
      [scopeKey]: next,
    };
    return next;
  }, []);

  const beginChatGeneration = useCallback((
    scopeKey: string,
    conversationId: string | null,
    ownerKey?: string,
  ): ChatGenerationScopeStart => {
    const scope = ensureGenerationScope(scopeKey);
    const previousConversationId = scope.closeRequested ? null : scope.conversationId;
    if (scope.ownerController && scope.ownerKey !== ownerKey) {
      scope.ownerController.abort();
    }
    const ownerController = ownerKey ? new AbortController() : null;
    if (ownerKey && ownerController) {
      ownerControllersRef.current = {
        ...ownerControllersRef.current,
        [ownerKey]: [...(ownerControllersRef.current[ownerKey] ?? []), ownerController],
      };
    }
    scope.epoch = ++generationEpochRef.current;
    scope.closeRequested = false;
    scope.sendClaimed = true;
    scope.conversationId = conversationId ?? previousConversationId;
    scope.ownerKey = ownerKey ?? null;
    scope.sendStateKey = ownerKey
      ? chatGenerationOwnerStateKey(scopeKey, ownerKey)
      : scopeKey;
    scope.ownerController = ownerController;
    return {
      epoch: scope.epoch,
      conversationId: scope.conversationId,
      ...(ownerController ? { ownerSignal: ownerController.signal } : {}),
    };
  }, [ensureGenerationScope]);

  const tryBeginChatGeneration = useCallback((
    scopeKey: string,
    conversationId: string | null,
    ownerKey?: string,
  ): ChatGenerationScopeStart | null => {
    const scope = ensureGenerationScope(scopeKey);
    if (scope.sendClaimed && !scope.closeRequested) {
      if (!ownerKey || !scope.ownerKey || scope.ownerKey === ownerKey) return null;
      clearChatGenerationProviderState(scopeKey, scope.epoch);
      scope.epoch = ++generationEpochRef.current;
      scope.conversationId = null;
      scope.sendClaimed = false;
      scope.ownerKey = null;
      scope.sendStateKey = scopeKey;
      scope.ownerController?.abort();
      scope.ownerController = null;
    }
    return beginChatGeneration(scopeKey, conversationId, ownerKey);
  }, [beginChatGeneration, clearChatGenerationProviderState, ensureGenerationScope]);

  const rememberChatGenerationConversation = useCallback((scopeKey: string, conversationId: string) => {
    const scope = generationScopesRef.current[scopeKey];
    if (!scope || scope.closeRequested) return;
    if (scope.conversationId === null || scope.conversationId === conversationId) {
      scope.conversationId = conversationId;
    }
  }, []);

  const setChatGenerationConversation = useCallback((
    scopeKey: string,
    epoch: number,
    conversationId: string,
  ) => {
    const scope = generationScopesRef.current[scopeKey];
    if (!scope) return false;
    if (scope.epoch !== epoch || scope.closeRequested) return false;
    scope.conversationId = conversationId;
    return true;
  }, []);

  const getChatGenerationEpoch = useCallback((scopeKey: string) => (
    generationScopesRef.current[scopeKey]?.epoch ?? null
  ), []);

  const isChatGenerationCurrent = useCallback((scopeKey: string, epoch: number) => {
    const scope = generationScopesRef.current[scopeKey];
    return Boolean(scope && scope.epoch === epoch && !scope.closeRequested);
  }, []);

  const isChatGenerationClosePending = useCallback((scopeKey: string, epoch?: number) => {
    const scope = generationScopesRef.current[scopeKey];
    return Boolean(
      scope?.closeRequested
      && (epoch === undefined || scope.epoch === epoch),
    );
  }, []);

  const releaseChatGenerationScope = useCallback((scopeKey: string, epoch: number) => {
    const scope = generationScopesRef.current[scopeKey];
    if (!scope || scope.epoch !== epoch) return;
    const { [scopeKey]: _removed, ...rest } = generationScopesRef.current;
    generationScopesRef.current = rest;
  }, []);

  const requestChatGenerationClose = useCallback((
    scopeKey: string,
    knownConversationId?: string | null,
  ): ChatGenerationScopeClose => {
    const scope = ensureGenerationScope(scopeKey);
    if (knownConversationId && !scope.conversationId) {
      scope.conversationId = knownConversationId;
    }
    scope.epoch = ++generationEpochRef.current;
    scope.closeRequested = true;
    scope.sendClaimed = false;
    return {
      epoch: scope.epoch,
      conversationId: scope.conversationId,
    };
  }, [ensureGenerationScope]);

  const resetChatGenerationClose = useCallback((scopeKey: string, epoch: number) => {
    const scope = generationScopesRef.current[scopeKey];
    if (scope?.epoch === epoch) {
      scope.closeRequested = false;
      scope.sendClaimed = false;
    }
  }, []);

  const clearChatGenerationConversation = useCallback((scopeKey: string, conversationId: string) => {
    const scope = generationScopesRef.current[scopeKey];
    if (scope?.conversationId === conversationId) scope.conversationId = null;
    setRuntimeSensitiveInputRequest(conversationId, null);
  }, [setRuntimeSensitiveInputRequest]);

  const destroyChatGenerationConversation = useCallback((
    scopeKey: string,
    conversationId: string,
    destroyer: () => Promise<void>,
  ) => {
    const existing = destructionPromisesRef.current[scopeKey];
    if (existing?.conversationId === conversationId) return existing.promise;
    let promise!: Promise<void>;
    promise = (async () => {
      try {
        await destroyer();
      } finally {
        const current = destructionPromisesRef.current[scopeKey];
        if (current?.promise === promise) {
          const { [scopeKey]: _removed, ...rest } = destructionPromisesRef.current;
          destructionPromisesRef.current = rest;
        }
      }
    })();
    destructionPromisesRef.current = {
      ...destructionPromisesRef.current,
      [scopeKey]: { conversationId, promise },
    };
    return promise;
  }, []);

  const isChatGenerationActive = useCallback(
    (chatId: string | null | undefined) => Boolean(chatId && statusStore.getSnapshot(chatId)),
    [statusStore],
  );

  const actions = useMemo<ChatGenerationActions>(() => ({
    abortChatStream,
    beginChatGeneration,
    completeChatGenerationOwner,
    clearChatGenerationConversation,
    clearChatGenerationProviderState,
    destroyChatGenerationConversation,
    getChatGenerationEpoch,
    invalidateChatGenerationsForOwner,
    tryBeginChatGeneration,
    isChatGenerationActive,
    isChatGenerationCurrent,
    isChatGenerationClosePending,
    rememberChatGenerationConversation,
    releaseChatGenerationScope,
    requestChatGenerationClose,
    resetChatGenerationClose,
    setChatGenerationConversation,
    setChatSendInFlight,
    setRuntimeSensitiveInputRequest,
    setStreamDraftForChat,
    setStreamAbortController,
  }), [
    abortChatStream,
    beginChatGeneration,
    completeChatGenerationOwner,
    clearChatGenerationConversation,
    clearChatGenerationProviderState,
    destroyChatGenerationConversation,
    getChatGenerationEpoch,
    invalidateChatGenerationsForOwner,
    tryBeginChatGeneration,
    isChatGenerationActive,
    isChatGenerationCurrent,
    isChatGenerationClosePending,
    rememberChatGenerationConversation,
    releaseChatGenerationScope,
    requestChatGenerationClose,
    resetChatGenerationClose,
    setChatGenerationConversation,
    setChatSendInFlight,
    setRuntimeSensitiveInputRequest,
    setStreamAbortController,
    setStreamDraftForChat,
  ]);

  const value = useMemo(
    () => ({
      activeChatIds,
      streamDrafts,
      runtimeSensitiveInputs,
      sendInFlightByChatId,
      beginChatGeneration,
      completeChatGenerationOwner,
      tryBeginChatGeneration,
      clearChatGenerationConversation,
      clearChatGenerationProviderState,
      destroyChatGenerationConversation,
      getChatGenerationEpoch,
      invalidateChatGenerationsForOwner,
      isChatGenerationActive,
      isChatGenerationCurrent,
      isChatGenerationClosePending,
      rememberChatGenerationConversation,
      releaseChatGenerationScope,
      requestChatGenerationClose,
      resetChatGenerationClose,
      setChatGenerationConversation,
      setChatSendInFlight,
      setRuntimeSensitiveInputRequest,
      setStreamDraftForChat,
      setStreamAbortController,
      abortChatStream,
    }),
    [
      abortChatStream,
      activeChatIds,
      beginChatGeneration,
      completeChatGenerationOwner,
      clearChatGenerationConversation,
      clearChatGenerationProviderState,
      destroyChatGenerationConversation,
      getChatGenerationEpoch,
      invalidateChatGenerationsForOwner,
      isChatGenerationActive,
      isChatGenerationCurrent,
      isChatGenerationClosePending,
      rememberChatGenerationConversation,
      releaseChatGenerationScope,
      sendInFlightByChatId,
      requestChatGenerationClose,
      resetChatGenerationClose,
      setChatGenerationConversation,
      setChatSendInFlight,
      setRuntimeSensitiveInputRequest,
      setStreamAbortController,
      setStreamDraftForChat,
      streamDrafts,
      runtimeSensitiveInputs,
      tryBeginChatGeneration,
    ],
  );

  return (
    <ChatGenerationStatusStoreContext.Provider value={statusStore}>
      <ChatGenerationActionsContext.Provider value={actions}>
        <ChatGenerationContext.Provider value={value}><FirstChatTurnProvider>{children}</FirstChatTurnProvider></ChatGenerationContext.Provider>
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
