type DesktopRuntimeHandle = {
  runtime: { mode: "owned" | "attached" };
  stop(): Promise<void>;
};

type DesktopRuntimeShutdownOptions = {
  browserDisconnect?: () => Promise<void>;
  browserDisconnectTimeoutMs?: number;
  onBrowserDisconnectTimeout?: () => void;
  runtimeHandle: DesktopRuntimeHandle | null;
  onWarning?: (message: string, error?: unknown) => void;
};

const DEFAULT_BROWSER_DISCONNECT_TIMEOUT_MS = 5_000;

function warn(options: DesktopRuntimeShutdownOptions, message: string, error?: unknown): void {
  try {
    if (error === undefined) {
      options.onWarning?.(message);
    } else {
      options.onWarning?.(message, error);
    }
  } catch {
    // Cleanup reporting must never interrupt owned runtime shutdown.
  }
}

async function disconnectBrowserWithDeadline(options: DesktopRuntimeShutdownOptions): Promise<boolean> {
  if (!options.browserDisconnect) return false;

  const timeoutMs = Math.max(1, options.browserDisconnectTimeoutMs ?? DEFAULT_BROWSER_DISCONNECT_TIMEOUT_MS);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const disconnect = Promise.resolve()
    .then(options.browserDisconnect)
    .catch((error) => {
      warn(options, "Browser runtime disconnect failed; continuing with runtime shutdown.", error);
    })
    .then(() => false);
  const deadline = new Promise<true>((resolve) => {
    timeout = setTimeout(() => {
      warn(
        options,
        `Browser runtime disconnect timed out after ${timeoutMs}ms; continuing with runtime shutdown.`,
      );
      resolve(true);
    }, timeoutMs);
    timeout.unref?.();
  });

  const timedOut = await Promise.race([disconnect, deadline]);
  if (timeout) clearTimeout(timeout);
  return timedOut;
}

export async function stopDesktopRuntime(options: DesktopRuntimeShutdownOptions): Promise<void> {
  const browserDisconnectTimedOut = await disconnectBrowserWithDeadline(options);
  if (browserDisconnectTimedOut) {
    try {
      options.onBrowserDisconnectTimeout?.();
    } catch (error) {
      warn(options, "Browser runtime recovery failed; continuing with runtime shutdown.", error);
    }
  }

  // An attached server belongs to another local process. Desktop only tears
  // down its own Browser broker/tabs and never invokes the external handle.
  if (options.runtimeHandle?.runtime.mode !== "owned") return;
  await options.runtimeHandle.stop();
}
