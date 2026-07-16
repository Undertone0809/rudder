import type { ChatClientCheckpointRequest } from "@/api/chats";

export type ChatClientCheckpoint = ChatClientCheckpointRequest & {
  chatId: string;
};

type DispatchState = {
  acknowledgedSeq: number;
  inFlight: ChatClientCheckpoint | null;
  pending: ChatClientCheckpoint | null;
  timer: ReturnType<typeof setTimeout> | null;
};

type ChatClientCheckpointDispatcherOptions = {
  debounceMs?: number;
  retryMs?: number;
  maxGenerations?: number;
};

const DEFAULT_CHECKPOINT_DEBOUNCE_MS = 64;
const DEFAULT_CHECKPOINT_RETRY_MS = 500;
const DEFAULT_MAX_CHECKPOINT_GENERATIONS = 32;

export function chatClientCheckpointKey(
  checkpoint: Pick<ChatClientCheckpoint, "chatId" | "generationId" | "attemptEpoch">,
) {
  return `${checkpoint.chatId}:${checkpoint.generationId}:${checkpoint.attemptEpoch}`;
}

export function createChatClientCheckpointDispatcher(
  submit: (checkpoint: ChatClientCheckpoint) => Promise<unknown>,
  options: ChatClientCheckpointDispatcherOptions = {},
) {
  const debounceMs = options.debounceMs ?? DEFAULT_CHECKPOINT_DEBOUNCE_MS;
  const retryMs = options.retryMs ?? DEFAULT_CHECKPOINT_RETRY_MS;
  const maxGenerations = options.maxGenerations ?? DEFAULT_MAX_CHECKPOINT_GENERATIONS;
  const states = new Map<string, DispatchState>();

  const schedule = (key: string, delayMs: number) => {
    const state = states.get(key);
    if (!state || state.timer || state.inFlight || !state.pending) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      const current = states.get(key);
      const checkpoint = current?.pending ?? null;
      if (!current || !checkpoint || current.inFlight) return;
      current.pending = null;
      current.inFlight = checkpoint;

      void submit(checkpoint)
        .then(() => {
          const latest = states.get(key);
          if (!latest) return;
          latest.acknowledgedSeq = Math.max(latest.acknowledgedSeq, checkpoint.generationSeq);
        })
        .catch(() => {
          const latest = states.get(key);
          if (!latest) return;
          if (!latest.pending || latest.pending.generationSeq < checkpoint.generationSeq) {
            latest.pending = checkpoint;
          }
        })
        .finally(() => {
          const latest = states.get(key);
          if (!latest) return;
          latest.inFlight = null;
          if (latest.pending && latest.pending.generationSeq > latest.acknowledgedSeq) {
            schedule(key, latest.pending === checkpoint ? retryMs : debounceMs);
          }
        });
    }, delayMs);
  };

  const trimIdleStates = () => {
    if (states.size <= maxGenerations) return;
    for (const [key, state] of states) {
      if (states.size <= maxGenerations) break;
      if (state.inFlight || state.pending || state.timer) continue;
      states.delete(key);
    }
  };

  return {
    enqueue(checkpoint: ChatClientCheckpoint) {
      const key = chatClientCheckpointKey(checkpoint);
      let state = states.get(key);
      if (!state) {
        state = {
          acknowledgedSeq: -1,
          inFlight: null,
          pending: null,
          timer: null,
        };
        states.set(key, state);
      }

      const newestKnownSeq = Math.max(
        state.acknowledgedSeq,
        state.inFlight?.generationSeq ?? -1,
        state.pending?.generationSeq ?? -1,
      );
      if (checkpoint.generationSeq <= newestKnownSeq) return;
      state.pending = checkpoint;
      schedule(key, debounceMs);
      trimIdleStates();
    },

    retain(activeKeys: ReadonlySet<string>) {
      for (const [key, state] of states) {
        if (activeKeys.has(key)) continue;
        if (state.timer) clearTimeout(state.timer);
        states.delete(key);
      }
    },

    dispose() {
      for (const state of states.values()) {
        if (state.timer) clearTimeout(state.timer);
      }
      states.clear();
    },
  };
}
