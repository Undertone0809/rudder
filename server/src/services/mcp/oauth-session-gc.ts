export interface ManagedMcpOAuthSessionCleanup {
  cleanupExpiredSessions(orgId?: string, limit?: number): Promise<number>;
}

export interface ManagedMcpOAuthSessionGcOptions {
  intervalMs?: number;
  batchSize?: number;
  onError?: (error: unknown) => void;
  setIntervalFn?: (
    callback: () => void,
    intervalMs: number,
  ) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 100;

export function startManagedMcpOAuthSessionGc(
  service: ManagedMcpOAuthSessionCleanup,
  options: ManagedMcpOAuthSessionGcOptions = {},
) {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  let stopped = false;
  let sweepInFlight: Promise<void> | null = null;

  const sweep = () => {
    if (stopped || sweepInFlight) return;
    sweepInFlight = service.cleanupExpiredSessions(undefined, batchSize)
      .then(() => undefined)
      .catch((error) => {
        options.onError?.(error);
      })
      .finally(() => {
        sweepInFlight = null;
      });
  };

  sweep();
  const timer = setIntervalFn(sweep, intervalMs);
  timer.unref?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}
