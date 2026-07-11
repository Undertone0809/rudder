import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BROWSER_PARTITION_PREFIX = "persist:rudder-browser-v1-";

export type BrowserStorageType =
  | "cookies"
  | "filesystem"
  | "indexdb"
  | "localstorage"
  | "shadercache"
  | "websql"
  | "serviceworkers"
  | "cachestorage";

export const BROWSER_STORAGE_TYPES: BrowserStorageType[] = [
  "cookies",
  "filesystem",
  "indexdb",
  "localstorage",
  "shadercache",
  "websql",
  "serviceworkers",
  "cachestorage",
];

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
  clearCache(): Promise<void>;
  clearStorageData(options?: { storages?: BrowserStorageType[] }): Promise<void>;
  cookies: {
    flushStore(): Promise<void>;
  };
};

export type BrowserProfileController = {
  getPartition(): string;
  getState(): BrowserProfileState;
  clearBrowserData(): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
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
  let lifecycleQueue: Promise<void> = Promise.resolve();

  const getState = (): BrowserProfileState => ({
    enabled,
    available: enabled && pendingClears === 0 && pendingDisables === 0,
    clearing: pendingClears > 0,
  });

  const runClear = async (): Promise<void> => {
    await options.broadcastReset({ reason: "clear", enabled, available: false });
    await options.closeBrowserGuests();
    await options.session.clearAuthCache();
    await options.session.clearCache();
    await options.session.clearStorageData({ storages: BROWSER_STORAGE_TYPES });
    await options.session.cookies.flushStore();
  };

  return {
    getPartition: () => options.partition,
    getState,
    clearBrowserData: () => {
      pendingClears += 1;
      const operation = lifecycleQueue.then(runClear);
      const trackedOperation = operation.finally(() => {
        pendingClears -= 1;
      });
      lifecycleQueue = trackedOperation.catch(() => undefined);
      return trackedOperation;
    },
    setEnabled: (nextEnabled) => {
      enabled = nextEnabled;
      if (nextEnabled) return lifecycleQueue;

      pendingDisables += 1;
      const operation = lifecycleQueue.then(async () => {
        await options.broadcastReset({ reason: "disabled", enabled: false, available: false });
        await options.closeBrowserGuests();
      });
      const trackedOperation = operation.finally(() => {
        pendingDisables -= 1;
      });
      lifecycleQueue = trackedOperation.catch(() => undefined);
      return trackedOperation;
    },
  };
}
