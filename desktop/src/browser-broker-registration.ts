import type { BrowserRuntimeIdentity } from "./browser-agent-tabs.js";

export type DesktopBrowserSettings = {
  enabled: boolean;
  openLinksIn: "built_in" | "default_browser";
};

type DesktopBrowserBrokerRegistration = {
  endpoint: string;
  token: string;
  ownerId?: string;
  generation?: number;
};

const DESKTOP_BROWSER_API_TIMEOUT_MS = 5_000;

function boundedFetch(
  fetchImpl: typeof fetch,
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return fetchImpl(input, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(DESKTOP_BROWSER_API_TIMEOUT_MS),
  });
}

function localApiBase(rawApiUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawApiUrl);
  } catch {
    throw new Error("Rudder Browser requires a valid local API URL.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || (hostname !== "127.0.0.1" && hostname !== "::1")) {
    throw new Error("Rudder Browser requires a literal loopback API URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Rudder Browser local API URL is invalid.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/api") ? path : `${path}/api`;
  return url.toString().replace(/\/$/, "");
}

function browserApiUrl(apiUrl: string, path: string): string {
  return `${localApiBase(apiUrl)}${path}`;
}

export async function registerDesktopBrowserBroker(
  apiUrl: string,
  broker: DesktopBrowserBrokerRegistration,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await boundedFetch(fetchImpl, browserApiUrl(apiUrl, "/instance/browser/broker"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(broker),
  });
  if (!response.ok) {
    throw new Error(`Rudder Browser Broker registration failed (${response.status}).`);
  }
}

export async function unregisterDesktopBrowserBroker(
  apiUrl: string,
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const response = await boundedFetch(fetchImpl, browserApiUrl(apiUrl, "/instance/browser/broker"), {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    throw new Error(`Rudder Browser Broker unregister failed (${response.status}).`);
  }
}

export async function readDesktopBrowserSettings(
  apiUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<DesktopBrowserSettings> {
  const response = await boundedFetch(fetchImpl, browserApiUrl(apiUrl, "/instance/settings/browser"));
  if (!response.ok) {
    throw new Error(`Rudder Browser settings request failed (${response.status}).`);
  }
  const value = await response.json() as Record<string, unknown>;
  if (typeof value.enabled !== "boolean"
    || (value.openLinksIn !== "built_in" && value.openLinksIn !== "default_browser")) {
    throw new Error("Rudder Browser settings response was invalid.");
  }
  return { enabled: value.enabled, openLinksIn: value.openLinksIn };
}

export async function isDesktopBrowserRunActive(
  apiUrl: string,
  identity: BrowserRuntimeIdentity,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const response = await boundedFetch(fetchImpl, browserApiUrl(
    apiUrl,
    `/heartbeat-runs/${encodeURIComponent(identity.runId)}`,
  ));
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Rudder Browser run status request failed (${response.status}).`);
  }
  const value = await response.json() as Record<string, unknown>;
  return value.id === identity.runId
    && value.orgId === identity.orgId
    && value.agentId === identity.agentId
    && value.status === "running";
}
