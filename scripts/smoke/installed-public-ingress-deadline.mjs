const MAX_TOTAL_TIMEOUT_MS = 1_200_000;

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error("workflow deadline reached");
}

/**
 * Owns the workflow deadline and its cleanup reserve. The workflow signal is
 * aborted before the hard deadline so callers can enter teardown while
 * `remainingMs()` and `stepTimeout()` continue to bound cleanup work.
 */
export function createWorkflowDeadline({
  totalTimeoutMs = MAX_TOTAL_TIMEOUT_MS,
  cleanupReserveMs = 60_000,
  signals = process,
} = {}) {
  assertPositiveSafeInteger(totalTimeoutMs, "totalTimeoutMs");
  if (totalTimeoutMs > MAX_TOTAL_TIMEOUT_MS) {
    throw new RangeError(`totalTimeoutMs must not exceed ${MAX_TOTAL_TIMEOUT_MS}ms`);
  }
  if (!Number.isSafeInteger(cleanupReserveMs) || cleanupReserveMs <= 0) {
    throw new TypeError("cleanupReserveMs must be a positive safe integer");
  }
  if (cleanupReserveMs >= totalTimeoutMs) {
    throw new RangeError("cleanupReserveMs must be less than totalTimeoutMs");
  }
  if (signals !== null
    && (typeof signals.on !== "function" || typeof signals.removeListener !== "function")) {
    throw new TypeError("signals must support on() and removeListener(), or be null");
  }

  const startedAt = performance.now();
  const hardDeadlineAt = startedAt + totalTimeoutMs;
  const workflowDeadlineAt = hardDeadlineAt - cleanupReserveMs;
  const controller = new AbortController();
  let cleaningUp = false;
  let disposed = false;
  let workTimer = null;

  const abortWorkflow = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const remainingMs = () => Math.max(0, Math.floor(hardDeadlineAt - performance.now()));
  const remainingWorkflowMs = () => Math.max(0, Math.floor(workflowDeadlineAt - performance.now()));

  const onProcessSignal = (signalName) => {
    abortWorkflow(new Error(`received ${signalName}; entering owned-process teardown`));
  };
  const onSigint = () => onProcessSignal("SIGINT");
  const onSigterm = () => onProcessSignal("SIGTERM");

  if (signals) {
    signals.on("SIGINT", onSigint);
    signals.on("SIGTERM", onSigterm);
  }

  workTimer = setTimeout(() => {
    abortWorkflow(new Error("workflow deadline reached; entering cleanup reserve"));
  }, remainingWorkflowMs());

  return {
    signal: controller.signal,

    remainingMs,

    stepTimeout(ms) {
      if (disposed) throw new Error("workflow deadline has been disposed");
      assertPositiveSafeInteger(ms, "step timeout");

      const remaining = cleaningUp ? remainingMs() : remainingWorkflowMs();
      if (remaining <= 0) {
        if (!cleaningUp) {
          abortWorkflow(new Error("workflow deadline reached; entering cleanup reserve"));
        }
        throw abortError(controller.signal);
      }
      if (!cleaningUp && controller.signal.aborted) throw abortError(controller.signal);
      return Math.min(ms, remaining);
    },

    beginCleanup() {
      if (disposed) throw new Error("workflow deadline has been disposed");
      if (!cleaningUp) {
        cleaningUp = true;
        if (workTimer !== null) clearTimeout(workTimer);
        workTimer = null;
        abortWorkflow(new Error("workflow entered cleanup; only bounded teardown may continue"));
      }
      return remainingMs();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (workTimer !== null) clearTimeout(workTimer);
      workTimer = null;
      if (signals) {
        signals.removeListener("SIGINT", onSigint);
        signals.removeListener("SIGTERM", onSigterm);
      }
    },
  };
}
