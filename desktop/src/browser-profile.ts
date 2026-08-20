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
  isOperatorAvailable(): boolean;
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

function isLoopbackIpv4Hostname(hostname: string): boolean {
  const octets = hostname.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.slice(1).every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

function isLoopbackIpv4MappedHostname(hostname: string): boolean {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(hostname);
  if (!match) return false;
  const high = Number.parseInt(match[1]!, 16);
  return (high >> 8) === 0x7f;
}

function isLoopbackOrUnspecifiedHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "0.0.0.0"
    || hostname === "::"
    || hostname === "::1"
    || hostname === "::ffff:0:0"
    || isLoopbackIpv4Hostname(hostname)
    || isLoopbackIpv4MappedHostname(hostname);
}

function isUnspecifiedHostname(hostname: string): boolean {
  return hostname === "0.0.0.0"
    || hostname === "::"
    || hostname === "::ffff:0:0";
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "::1"
    || isLoopbackIpv4Hostname(hostname)
    || isLoopbackIpv4MappedHostname(hostname);
}

function isLoopbackLikeHostname(hostname: string): boolean {
  return hostname.startsWith("127.") || hostname.startsWith("::ffff:");
}

export function isBlockedRudderAppUrl(target: string, rudderAppOrigins: string[]): boolean {
  const targetEndpoint = normalizeNetworkEndpoint(target);
  if (!targetEndpoint) return false;

  return rudderAppOrigins.some((origin) => {
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

export function isAllowedBrowserNavigationUrl(target: string, rudderAppOrigins: string[]): boolean {
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return !isBlockedRudderAppUrl(target, rudderAppOrigins);
  } catch {
    return false;
  }
}

export function isAllowedAgentBrowserNavigationUrl(target: string, rudderAppOrigins: string[]): boolean {
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  } catch {
    return false;
  }
  const targetEndpoint = normalizeNetworkEndpoint(target);
  if (!targetEndpoint || isUnspecifiedHostname(targetEndpoint.hostname)) return false;
  if (isLoopbackLikeHostname(targetEndpoint.hostname) && !isLoopbackHostname(targetEndpoint.hostname)) return false;
  if (isLoopbackHostname(targetEndpoint.hostname)) return true;
  return !isBlockedRudderAppUrl(target, rudderAppOrigins);
}

export function isLocalAbsoluteFileUrl(target: string): boolean {
  if (!/^file:\/\/\//i.test(target)) return false;
  try {
    const parsed = new URL(target);
    const decodedPathname = decodeURIComponent(parsed.pathname);
    return parsed.protocol === "file:"
      && parsed.hostname === ""
      && decodedPathname.startsWith("/")
      && !/^\/[\\/]/.test(decodedPathname);
  } catch {
    return false;
  }
}

export function isAllowedOperatorBrowserNavigationUrl(target: string, rudderAppOrigins: string[]): boolean {
  if (isLocalAbsoluteFileUrl(target)) return true;
  return isAllowedBrowserNavigationUrl(target, rudderAppOrigins);
}

export function isAllowedBrowserBootstrapUrl(target: string, rudderAppOrigins: string[]): boolean {
  if (target === "about:blank") return true;
  return isAllowedOperatorBrowserNavigationUrl(target, rudderAppOrigins);
}

export function createBrowserProfileController(options: {
  partition: string;
  session: BrowserProfileSession;
  closeBrowserGuests(scope: "agent" | "all"): void | Promise<void>;
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
  const isOperatorAvailable = (): boolean => !shuttingDown && pendingClears === 0;

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

  const revokeBrowserGuests = (
    reason: DesktopBrowserResetEvent["reason"],
    scope: "agent" | "all",
  ): Promise<void> => {
    const resetEnabled = enabled;
    const operation = revocationQueue.then(async () => {
      if (scope === "all") {
        await options.broadcastReset({ reason, enabled: resetEnabled, available: false });
      }
      await options.closeBrowserGuests(scope);
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
    const revocation = revokeBrowserGuests("disabled", "all");
    shutdownInFlight = Promise.allSettled([lifecycleQueue, revocation]).then((results) => {
      const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    });
    return shutdownInFlight;
  };

  return {
    getPartition: () => options.partition,
    getState,
    isOperatorAvailable,
    runExclusive,
    clearBrowserData: () => {
      if (shuttingDown) {
        return Promise.reject(new Error("Rudder Browser is unavailable during shutdown."));
      }
      pendingClears += 1;
      const revocation = revokeBrowserGuests("clear", "all");
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
      const operation = revokeBrowserGuests("disabled", "agent");
      const trackedOperation = operation.finally(() => {
        pendingDisables -= 1;
      });
      return trackedOperation;
    },
    shutdown,
  };
}
