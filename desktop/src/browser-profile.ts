import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BROWSER_PARTITION_PREFIX = "persist:rudder-browser-v1-";

export type DesktopBrowserResetEvent = {
  reason: "clear" | "disabled";
  enabled: boolean;
  available: boolean;
};

export type BrowserProfileState = {
  enabled: boolean;
  available: boolean;
  clearing: boolean;
};

export type BrowserProfileSession = {
  clearAuthCache(): Promise<void>;
  clearData(): Promise<void>;
  cookies: {
    flushStore(): Promise<void>;
  };
};

export type BrowserProfileController = {
  getPartition(): string;
  getState(): BrowserProfileState;
  runExclusive<T>(operation: (signal?: AbortSignal) => Promise<T>): Promise<T>;
  clearBrowserData(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
  shutdown(): Promise<void>;
};

export function canonicalizeBrowserInstanceRoot(instanceRoot: string): string {
  if (!instanceRoot.trim()) throw new Error("A Rudder instance root is required for the Browser profile.");
  return path.normalize(fs.realpathSync.native(path.resolve(instanceRoot)));
}

export function deriveBrowserPartition(instanceRoot: string): string {
  const canonicalRoot = canonicalizeBrowserInstanceRoot(instanceRoot);
  const digest = createHash("sha256")
    .update("rudder-browser-v1\0", "utf8")
    .update(canonicalRoot, "utf8")
    .digest("hex");
  return `${BROWSER_PARTITION_PREFIX}${digest}`;
}

type BrowserNetworkEndpoint = {
  protocol: "http:" | "https:";
  hostname: string;
  port: string;
};

function normalizeNetworkProtocol(protocol: string): BrowserNetworkEndpoint["protocol"] | null {
  if (protocol === "http:" || protocol === "ws:") return "http:";
  if (protocol === "https:" || protocol === "wss:") return "https:";
  return null;
}

function normalizeNetworkEndpoint(value: string): BrowserNetworkEndpoint | null {
  try {
    const parsed = new URL(value);
    const protocol = normalizeNetworkProtocol(parsed.protocol);
    if (!protocol) return null;
    return {
      protocol,
      hostname: parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, ""),
      port: parsed.port || (protocol === "http:" ? "80" : "443"),
    };
  } catch {
    return null;
  }
}

function isLoopbackOrUnspecifiedHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "0.0.0.0"
    || hostname === "::"
    || hostname === "::1"
    || hostname === "::ffff:0:0"
    || /^127\./.test(hostname)
    || /^::ffff:7f[0-9a-f]{2}:/.test(hostname);
}

export function isBlockedBrowserControlPlaneUrl(target: string, controlPlaneOrigins: string[]): boolean {
  const targetEndpoint = normalizeNetworkEndpoint(target);
  if (!targetEndpoint) return false;

  return controlPlaneOrigins.some((origin) => {
    const controlEndpoint = normalizeNetworkEndpoint(origin);
    if (!controlEndpoint
      || targetEndpoint.protocol !== controlEndpoint.protocol
      || targetEndpoint.port !== controlEndpoint.port) {
      return false;
    }
    return isLoopbackOrUnspecifiedHostname(controlEndpoint.hostname)
      || targetEndpoint.hostname === controlEndpoint.hostname;
  });
}

export function isAllowedBrowserNavigationUrl(target: string, controlPlaneOrigins: string[]): boolean {
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return !isBlockedBrowserControlPlaneUrl(target, controlPlaneOrigins);
  } catch {
    return false;
  }
}

export function isAllowedBrowserBootstrapUrl(target: string, controlPlaneOrigins: string[]): boolean {
  if (target === "about:blank") return true;
  return isAllowedBrowserNavigationUrl(target, controlPlaneOrigins);
}

export function createBrowserProfileController(options: {
  partition: string;
  session: BrowserProfileSession;
  closeBrowserGuests(): void | Promise<void>;
  broadcastReset(event: DesktopBrowserResetEvent): void | Promise<void>;
}): BrowserProfileController {
  let enabled = true;
  let pendingClears = 0;
  let pendingDisables = 0;
  let pendingEnables = 0;
  let shuttingDown = false;
  let shutdownInFlight: Promise<void> | null = null;
  const admittedControlOperations = new Set<AbortController>();
  let lifecycleQueue: Promise<void> = Promise.resolve();
  let revocationQueue: Promise<void> = Promise.resolve();

  const getState = (): BrowserProfileState => ({
    enabled,
    available: enabled
      && !shuttingDown
      && pendingClears === 0
      && pendingDisables === 0
      && pendingEnables === 0,
    clearing: pendingClears > 0,
  });

  const clearStoredData = async (): Promise<void> => {
    await options.session.clearAuthCache();
    await options.session.clearData();
    await options.session.cookies.flushStore();
  };

  const enqueueLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycleQueue.then(operation);
    lifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const revokeBrowserGuests = (reason: DesktopBrowserResetEvent["reason"]): Promise<void> => {
    const resetEnabled = enabled;
    const operation = revocationQueue.then(async () => {
      await options.broadcastReset({ reason, enabled: resetEnabled, available: false });
      await options.closeBrowserGuests();
    });
    revocationQueue = operation.catch(() => undefined);
    return operation;
  };

  const runExclusive = <T>(operation: (signal?: AbortSignal) => Promise<T>): Promise<T> => {
    if (!getState().available) {
      return Promise.reject(new Error("Rudder Browser is unavailable during a Browser profile lifecycle operation."));
    }
    const abortController = new AbortController();
    admittedControlOperations.add(abortController);
    return enqueueLifecycle(async () => {
      if (abortController.signal.aborted) {
        throw new Error("Rudder Browser control operation was canceled during shutdown.");
      }
      return operation(abortController.signal);
    }).finally(() => {
      admittedControlOperations.delete(abortController);
    });
  };

  const shutdown = (): Promise<void> => {
    if (shutdownInFlight) return shutdownInFlight;
    shuttingDown = true;
    enabled = false;
    for (const operation of admittedControlOperations) operation.abort();
    const revocation = revokeBrowserGuests("disabled");
    shutdownInFlight = Promise.allSettled([lifecycleQueue, revocation]).then((results) => {
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    });
    return shutdownInFlight;
  };

  return {
    getPartition: () => options.partition,
    getState,
    runExclusive,
    clearBrowserData: () => {
      if (shuttingDown) {
        return Promise.reject(new Error("Rudder Browser is unavailable during shutdown."));
      }
      pendingClears += 1;
      const revocation = revokeBrowserGuests("clear");
      const operation = enqueueLifecycle(async () => {
        await revocation;
        await clearStoredData();
      });
      const trackedOperation = operation.finally(() => {
        pendingClears -= 1;
      });
      lifecycleQueue = trackedOperation.catch(() => undefined);
      return trackedOperation;
    },
    setEnabled: (nextEnabled) => {
      if (shuttingDown) return shutdownInFlight ?? Promise.resolve();
      enabled = nextEnabled;
      if (nextEnabled) {
        pendingEnables += 1;
        return Promise.all([lifecycleQueue, revocationQueue])
          .then(() => undefined)
          .finally(() => {
            pendingEnables -= 1;
          });
      }

      pendingDisables += 1;
      const operation = revokeBrowserGuests("disabled");
      const trackedOperation = operation.finally(() => {
        pendingDisables -= 1;
      });
      return trackedOperation;
    },
    shutdown,
  };
}
