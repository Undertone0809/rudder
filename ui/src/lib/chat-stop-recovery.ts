import type {
  ChatStreamDraft,
  ChatStreamDraftState,
} from "@/context/ChatGenerationContext";

const CHAT_STOP_RECOVERY_STORAGE_PREFIX = "rudder:chat-stop-recovery:v1";
const CHAT_STOP_RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CHAT_STOP_RECOVERY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

export type ChatStopRequest = {
  controlActionId: string;
  expectedGenerationId?: string;
  expectedAttemptEpoch?: number;
  expectedControlVersion?: number;
  lastCommittedRenderSeq?: number;
  renderedBodyHash?: string;
};

export type PendingChatStopRecovery = {
  version: 1;
  orgId: string;
  chatId: string;
  request: ChatStopRequest;
  frozenDraft: ChatStreamDraft | null;
  previousStreamState: ChatStreamDraftState | null;
  requestedAt: string;
};

type SerializedChatStreamDraft = Omit<
  ChatStreamDraft,
  "userCreatedAt" | "editedFromCreatedAt" | "createdAt"
> & {
  userCreatedAt: string;
  editedFromCreatedAt: string | null;
  createdAt: string;
};

type SerializedPendingChatStopRecovery = Omit<PendingChatStopRecovery, "frozenDraft"> & {
  frozenDraft: SerializedChatStreamDraft | null;
};

type PendingChatStopRetryState = {
  recovery: PendingChatStopRecovery;
  retryCount: number;
  timer: ReturnType<typeof setTimeout> | null;
};

type ChatStopRecoveryRetrierOptions = {
  retryDelaysMs?: readonly number[];
};

function stopRecoveryStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function storageKey(orgId: string, chatId: string) {
  return `${CHAT_STOP_RECOVERY_STORAGE_PREFIX}:${encodeURIComponent(orgId)}:${encodeURIComponent(chatId)}`;
}

export function chatStopRecoveryActionKey(
  recovery: Pick<PendingChatStopRecovery, "orgId" | "chatId" | "request">,
) {
  return `${recovery.orgId}\u0000${recovery.chatId}\u0000${recovery.request.controlActionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function normalizeRequest(value: unknown): ChatStopRequest | null {
  if (!isRecord(value) || typeof value.controlActionId !== "string" || !value.controlActionId.trim()) {
    return null;
  }
  if (
    !isOptionalString(value.expectedGenerationId)
    || !isOptionalFiniteNumber(value.expectedAttemptEpoch)
    || !isOptionalFiniteNumber(value.expectedControlVersion)
    || !isOptionalFiniteNumber(value.lastCommittedRenderSeq)
    || !isOptionalString(value.renderedBodyHash)
  ) {
    return null;
  }
  return {
    controlActionId: value.controlActionId,
    ...(typeof value.expectedGenerationId === "string"
      ? { expectedGenerationId: value.expectedGenerationId }
      : {}),
    ...(typeof value.expectedAttemptEpoch === "number"
      ? { expectedAttemptEpoch: value.expectedAttemptEpoch }
      : {}),
    ...(typeof value.expectedControlVersion === "number"
      ? { expectedControlVersion: value.expectedControlVersion }
      : {}),
    ...(typeof value.lastCommittedRenderSeq === "number"
      ? { lastCommittedRenderSeq: value.lastCommittedRenderSeq }
      : {}),
    ...(typeof value.renderedBodyHash === "string"
      ? { renderedBodyHash: value.renderedBodyHash }
      : {}),
  };
}

const STREAM_STATES = new Set<ChatStreamDraftState>([
  "streaming",
  "finalizing",
  "stopping",
  "stopped",
  "failed",
]);

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeFrozenDraft(value: unknown, chatId: string): ChatStreamDraft | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  const userCreatedAt = parseDate(value.userCreatedAt);
  const createdAt = parseDate(value.createdAt);
  const editedFromCreatedAt = value.editedFromCreatedAt === null
    ? null
    : parseDate(value.editedFromCreatedAt);
  if (
    value.chatId !== chatId
    || typeof value.streamKey !== "string"
    || typeof value.userBody !== "string"
    || !userCreatedAt
    || !(typeof value.userMessageId === "string" || value.userMessageId === null)
    || !(typeof value.chatTurnId === "string" || value.chatTurnId === null)
    || typeof value.turnVariant !== "number"
    || (value.editedFromCreatedAt !== null && !editedFromCreatedAt)
    || typeof value.body !== "string"
    || typeof value.state !== "string"
    || !STREAM_STATES.has(value.state as ChatStreamDraftState)
    || !createdAt
    || !Array.isArray(value.transcript)
    || !(typeof value.replyingAgentId === "string" || value.replyingAgentId === null)
  ) {
    return null;
  }
  return {
    ...(value as unknown as ChatStreamDraft),
    chatId,
    userCreatedAt,
    editedFromCreatedAt,
    createdAt,
    state: value.state as ChatStreamDraftState,
  };
}

function serializeFrozenDraft(draft: ChatStreamDraft | null): SerializedChatStreamDraft | null {
  if (!draft) return null;
  return {
    ...draft,
    userCreatedAt: draft.userCreatedAt.toISOString(),
    editedFromCreatedAt: draft.editedFromCreatedAt?.toISOString() ?? null,
    createdAt: draft.createdAt.toISOString(),
  };
}

export function createPendingChatStopRecovery(input: {
  orgId: string;
  chatId: string;
  request: ChatStopRequest;
  frozenDraft: ChatStreamDraft | null;
  now?: Date;
}): PendingChatStopRecovery {
  return {
    version: 1,
    orgId: input.orgId,
    chatId: input.chatId,
    request: input.request,
    frozenDraft: input.frozenDraft,
    previousStreamState: input.frozenDraft?.state ?? null,
    requestedAt: (input.now ?? new Date()).toISOString(),
  };
}

export function savePendingChatStopRecovery(recovery: PendingChatStopRecovery) {
  try {
    const serialized: SerializedPendingChatStopRecovery = {
      ...recovery,
      frozenDraft: serializeFrozenDraft(recovery.frozenDraft),
    };
    stopRecoveryStorage()?.setItem(
      storageKey(recovery.orgId, recovery.chatId),
      JSON.stringify(serialized),
    );
  } catch {
    // Stop remains usable when browser storage is unavailable.
  }
}

export function readPendingChatStopRecovery(
  orgId: string,
  chatId: string,
  now = new Date(),
): PendingChatStopRecovery | null {
  try {
    const raw = stopRecoveryStorage()?.getItem(storageKey(orgId, chatId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || value.orgId !== orgId || value.chatId !== chatId) {
      clearPendingChatStopRecovery(orgId, chatId);
      return null;
    }
    const request = normalizeRequest(value.request);
    const requestedAt = parseDate(value.requestedAt);
    const previousStreamState = value.previousStreamState === null
      ? null
      : typeof value.previousStreamState === "string"
        && STREAM_STATES.has(value.previousStreamState as ChatStreamDraftState)
        ? value.previousStreamState as ChatStreamDraftState
        : undefined;
    if (
      !request
      || !requestedAt
      || previousStreamState === undefined
      || now.getTime() - requestedAt.getTime() > CHAT_STOP_RECOVERY_MAX_AGE_MS
    ) {
      clearPendingChatStopRecovery(orgId, chatId);
      return null;
    }
    const frozenDraft = normalizeFrozenDraft(value.frozenDraft, chatId);
    if (value.frozenDraft !== null && !frozenDraft) {
      clearPendingChatStopRecovery(orgId, chatId);
      return null;
    }
    return {
      version: 1,
      orgId,
      chatId,
      request,
      frozenDraft,
      previousStreamState,
      requestedAt: requestedAt.toISOString(),
    };
  } catch {
    clearPendingChatStopRecovery(orgId, chatId);
    return null;
  }
}

export function clearPendingChatStopRecovery(
  orgId: string,
  chatId: string,
  expectedControlActionId?: string,
) {
  try {
    const storage = stopRecoveryStorage();
    if (!storage) return false;
    const key = storageKey(orgId, chatId);
    if (expectedControlActionId) {
      const raw = storage.getItem(key);
      if (!raw) return false;
      try {
        const value: unknown = JSON.parse(raw);
        const request = isRecord(value) ? normalizeRequest(value.request) : null;
        if (request && request.controlActionId !== expectedControlActionId) return false;
      } catch {
        // A corrupt record cannot own a newer valid Stop action.
      }
    }
    storage.removeItem(key);
    return true;
  } catch {
    // Nothing else can safely recover inaccessible browser storage.
    return false;
  }
}

export function createChatStopRecoveryRetrier(
  retry: (recovery: PendingChatStopRecovery) => void,
  options: ChatStopRecoveryRetrierOptions = {},
) {
  const retryDelaysMs = options.retryDelaysMs?.length
    ? [...options.retryDelaysMs]
    : [...DEFAULT_CHAT_STOP_RECOVERY_RETRY_DELAYS_MS];
  const states = new Map<string, PendingChatStopRetryState>();

  const clearRetryTimer = (state: PendingChatStopRetryState) => {
    if (!state.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  };

  const stateFor = (recovery: PendingChatStopRecovery) => {
    const key = chatStopRecoveryActionKey(recovery);
    let state = states.get(key);
    if (!state) {
      state = { recovery, retryCount: 0, timer: null };
      states.set(key, state);
    } else {
      state.recovery = recovery;
    }
    return { key, state };
  };

  return {
    schedule(recovery: PendingChatStopRecovery) {
      const { key, state } = stateFor(recovery);
      if (state.timer) return;
      const delayMs = retryDelaysMs[Math.min(state.retryCount, retryDelaysMs.length - 1)] ?? 0;
      state.retryCount += 1;
      state.timer = setTimeout(() => {
        const current = states.get(key);
        if (!current) return;
        current.timer = null;
        retry(current.recovery);
      }, delayMs);
    },

    retryNow(recovery: PendingChatStopRecovery) {
      const { state } = stateFor(recovery);
      clearRetryTimer(state);
      retry(state.recovery);
    },

    resolve(recovery: PendingChatStopRecovery) {
      const key = chatStopRecoveryActionKey(recovery);
      const state = states.get(key);
      if (state) clearRetryTimer(state);
      states.delete(key);
    },

    dispose() {
      for (const state of states.values()) clearRetryTimer(state);
      states.clear();
    },
  };
}
