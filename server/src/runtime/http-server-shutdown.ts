import type { Server } from "node:http";

type HttpServerShutdownOptions = {
  gracePeriodMs?: number;
  onCloseError?: (error: Error) => void;
  onForceClose?: () => void;
};

const DEFAULT_HTTP_SHUTDOWN_GRACE_MS = 5_000;

/**
 * Starts an idempotent HTTP shutdown. Existing requests get a short grace
 * period, then ordinary HTTP connections are closed so downstream runtime
 * disposers (database pool, embedded Postgres, descriptors) cannot be blocked
 * indefinitely by a keep-alive client.
 */
export function createHttpServerShutdown(
  server: Server,
  options: HttpServerShutdownOptions = {},
): () => Promise<void> {
  let closeInFlight: Promise<void> | null = null;
  const reportCloseError = (error: unknown) => {
    try {
      options.onCloseError?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // Cleanup reporting must never interrupt the shutdown boundary.
    }
  };

  return () => {
    if (closeInFlight) return closeInFlight;

    closeInFlight = new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }

      let settled = false;
      let forceTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        resolve();
      };

      const gracePeriodMs = Math.max(0, options.gracePeriodMs ?? DEFAULT_HTTP_SHUTDOWN_GRACE_MS);
      forceTimer = setTimeout(() => {
        try {
          options.onForceClose?.();
        } catch {
          // Cleanup reporting must never interrupt the force-close fallback.
        }
        try {
          server.closeAllConnections();
        } catch (error) {
          reportCloseError(error);
        }
        // Do not let a missing close callback strand the rest of runtime
        // disposal after the force-close boundary has been reached.
        finish();
      }, gracePeriodMs);
      forceTimer.unref?.();

      try {
        server.close((error) => {
          if (error) reportCloseError(error);
          finish();
        });
      } catch (error) {
        reportCloseError(error);
        finish();
      }
    });

    return closeInFlight;
  };
}
