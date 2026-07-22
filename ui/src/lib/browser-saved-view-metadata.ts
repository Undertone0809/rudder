import type { MessengerSavedViewTarget } from "@rudderhq/shared";

export type BrowserSavedViewMetadata = {
  target: Extract<MessengerSavedViewTarget, { kind: "browser" }>;
  title: string;
  subtitle: string | null;
  favicon: string | null;
};

type ScheduledUpdate = {
  organizationId: string;
  savedViewId: string;
  metadata: BrowserSavedViewMetadata;
  fingerprint: string;
};

type QueueState = {
  timer: ReturnType<typeof setTimeout> | null;
  pending: ScheduledUpdate | null;
  failed: ScheduledUpdate | null;
  running: Promise<void> | null;
};

type PersisterOptions = {
  update: (organizationId: string, savedViewId: string, metadata: BrowserSavedViewMetadata) => Promise<unknown>;
  debounceMs?: number;
  retryDelaysMs?: readonly number[];
  maxRememberedSuccesses?: number;
};

export type BrowserSavedViewMetadataPersister = {
  schedule(input: {
    organizationId: string;
    savedViewId: string;
    metadata: BrowserSavedViewMetadata;
    persistedMetadata: BrowserSavedViewMetadata;
  }): void;
  cancelSavedView(savedViewId: string): void;
  flushSavedView(savedViewId: string): Promise<void>;
  flushAll(): Promise<void>;
};

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableValue(entryValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createBrowserSavedViewMetadataPersister(
  options: PersisterOptions,
): BrowserSavedViewMetadataPersister {
  const debounceMs = Math.max(0, options.debounceMs ?? 350);
  const retryDelaysMs = options.retryDelaysMs ?? [120, 400];
  const maxRememberedSuccesses = Math.max(1, options.maxRememberedSuccesses ?? 32);
  const queues = new Map<string, QueueState>();
  const successfulFingerprints = new Map<string, string>();
  const canceledSavedViewIds = new Set<string>();

  const rememberSuccess = (savedViewId: string, fingerprint: string) => {
    successfulFingerprints.delete(savedViewId);
    successfulFingerprints.set(savedViewId, fingerprint);
    while (successfulFingerprints.size > maxRememberedSuccesses) {
      const oldest = successfulFingerprints.keys().next().value;
      if (oldest === undefined) break;
      successfulFingerprints.delete(oldest);
    }
  };

  const stateFor = (savedViewId: string) => {
    const existing = queues.get(savedViewId);
    if (existing) return existing;
    const state: QueueState = { timer: null, pending: null, failed: null, running: null };
    queues.set(savedViewId, state);
    return state;
  };

  const delay = (milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds));
  });

  const drain = (savedViewId: string): Promise<void> => {
    const state = queues.get(savedViewId);
    if (!state) return Promise.resolve();
    if (canceledSavedViewIds.has(savedViewId)) return state.running ?? Promise.resolve();
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.running) return state.running;
    if (!state.pending && state.failed) {
      state.pending = state.failed;
      state.failed = null;
    }
    if (!state.pending) return Promise.resolve();

    const running = (async () => {
      while (state.pending && !canceledSavedViewIds.has(savedViewId)) {
        let desired = state.pending;
        state.pending = null;
        let completed = false;
        for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
          if (canceledSavedViewIds.has(savedViewId)) break;
          if (state.pending) {
            desired = state.pending;
            state.pending = null;
            attempt = 0;
          }
          try {
            await options.update(desired.organizationId, desired.savedViewId, desired.metadata);
            if (canceledSavedViewIds.has(savedViewId)) break;
            rememberSuccess(savedViewId, desired.fingerprint);
            state.failed = null;
            completed = true;
            break;
          } catch {
            if (canceledSavedViewIds.has(savedViewId)) break;
            if (attempt >= retryDelaysMs.length) {
              state.failed = state.pending ?? desired;
              state.pending = null;
              break;
            }
            await delay(retryDelaysMs[attempt] ?? 0);
          }
        }
        if (canceledSavedViewIds.has(savedViewId)) {
          state.pending = null;
          state.failed = null;
          break;
        }
        if (!completed && !state.pending) break;
      }
    })();
    state.running = running;
    void running.finally(() => {
      if (state.running === running) state.running = null;
      if (canceledSavedViewIds.has(savedViewId)) queues.delete(savedViewId);
    });
    return running;
  };

  const schedule: BrowserSavedViewMetadataPersister["schedule"] = (input) => {
    if (canceledSavedViewIds.has(input.savedViewId)) return;
    const fingerprint = stableValue(input.metadata);
    const successfulFingerprint = successfulFingerprints.get(input.savedViewId);
    const existingState = queues.get(input.savedViewId);
    if (successfulFingerprint
      ? successfulFingerprint === fingerprint
      : !existingState && fingerprint === stableValue(input.persistedMetadata)) return;
    const state = stateFor(input.savedViewId);
    state.pending = {
      organizationId: input.organizationId,
      savedViewId: input.savedViewId,
      metadata: input.metadata,
      fingerprint,
    };
    state.failed = null;
    if (state.running) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      void drain(input.savedViewId);
    }, debounceMs);
  };

  const cancelSavedView = (savedViewId: string) => {
    canceledSavedViewIds.add(savedViewId);
    successfulFingerprints.delete(savedViewId);
    const state = queues.get(savedViewId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.pending = null;
    state.failed = null;
    if (!state.running) queues.delete(savedViewId);
  };

  const flushSavedView = async (savedViewId: string) => {
    const state = queues.get(savedViewId);
    if (!state) return;
    await drain(savedViewId);
    while (state.running || state.pending) {
      if (state.running) await state.running;
      if (state.pending) await drain(savedViewId);
    }
  };

  const flushAll = async () => {
    await Promise.all([...queues.keys()].map(flushSavedView));
  };

  return { schedule, cancelSavedView, flushSavedView, flushAll };
}
