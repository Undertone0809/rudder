import type { SidePanelTarget } from "./side-panel-targets";

export const BROWSER_SIDE_PANEL_BLANK_URL = "about:blank";

export type BrowserWebviewInputEvent = Event & {
  input?: {
    type?: string;
    key?: string;
    code?: string;
    meta?: boolean;
    control?: boolean;
    alt?: boolean;
    shift?: boolean;
  };
};

export type BrowserLoadError = { code: string; url: string };

function browserErrorHost(url: string) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function browserSidePanelErrorContent(error: BrowserLoadError) {
  const host = browserErrorHost(error.url);
  if (error.code === "ERR_CONNECTION_REFUSED") {
    return { summary: `${host} refused to connect.`, suggestions: ["Checking the connection", "Checking the proxy and firewall"] };
  }
  if (error.code === "ERR_NAME_NOT_RESOLVED") {
    return { summary: `${host}'s server IP address could not be found.`, suggestions: ["Checking the address", "Checking the connection"] };
  }
  if (error.code === "ERR_TIMED_OUT") {
    return { summary: `${host} took too long to respond.`, suggestions: ["Checking the connection", "Trying again later"] };
  }
  return { summary: `The page at ${host} could not be loaded.`, suggestions: ["Checking the address", "Trying again later"] };
}

export function isBrowserSidePanelCloseShortcutInput(input: BrowserWebviewInputEvent["input"]) {
  if (!input || input.type === "keyUp") return false;
  const isCloseKey = input.key?.toLowerCase() === "w" || input.code === "KeyW";
  if (!isCloseKey || input.alt || input.shift) return false;
  const isMac = navigator.platform.toLowerCase().includes("mac");
  return isMac ? Boolean(input.meta) && !input.control : Boolean(input.control) && !input.meta;
}

function searchUrl(value: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function browserTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function browserLinkDedupeKey(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url.trim();
  }
}

function fileUrlLabel(url: URL): string {
  const pathname = decodeURIComponent(url.pathname).replace(/\/+$/g, "");
  return pathname.split("/").filter(Boolean).at(-1) || "File";
}

function isLocalAbsoluteFileUrl(value: string, url: URL): boolean {
  try {
    const decodedPathname = decodeURIComponent(url.pathname);
    return /^file:\/\/\//i.test(value)
      && url.protocol === "file:"
      && url.hostname === ""
      && decodedPathname.startsWith("/")
      && !/^\/[\\/]/.test(decodedPathname);
  } catch {
    return false;
  }
}

export function browserSidePanelLabel(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed === BROWSER_SIDE_PANEL_BLANK_URL) return "New tab";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "file:") return fileUrlLabel(parsed);
    return parsed.hostname || parsed.protocol.replace(":", "") || "Browser";
  } catch {
    return trimmed;
  }
}

export function normalizeBrowserSidePanelUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return BROWSER_SIDE_PANEL_BLANK_URL;
  if (/^about:blank$/i.test(trimmed)) return BROWSER_SIDE_PANEL_BLANK_URL;
  if (/^(https?|file):/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return url.protocol === "http:" || url.protocol === "https:" || isLocalAbsoluteFileUrl(trimmed, url)
        ? url.toString()
        : searchUrl(trimmed);
    } catch {
      return searchUrl(trimmed);
    }
  }
  if (/^(localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || /\s/.test(trimmed)) return searchUrl(trimmed);
  if (trimmed.includes(".")) return `https://${trimmed}`;
  return searchUrl(trimmed);
}

export function createBrowserSidePanelTarget(
  url = BROWSER_SIDE_PANEL_BLANK_URL,
  options: { favicon?: string | null; newTab?: boolean } = { newTab: true },
): Extract<SidePanelTarget, { kind: "browser" }> {
  return {
    kind: "browser",
    url,
    label: browserSidePanelLabel(url),
    tabId: browserTabId(),
    ...(options.favicon ? { favicon: options.favicon } : {}),
    ...(options.newTab === false ? { dedupeKey: browserLinkDedupeKey(url) } : {}),
  };
}
