import type { SidePanelTarget } from "./side-panel-targets";

export const BROWSER_SIDE_PANEL_BLANK_URL = "about:blank";

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

export function browserSidePanelLabel(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed === BROWSER_SIDE_PANEL_BLANK_URL) return "New tab";
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || parsed.protocol.replace(":", "") || "Browser";
  } catch {
    return trimmed;
  }
}

export function normalizeBrowserSidePanelUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return BROWSER_SIDE_PANEL_BLANK_URL;
  if (/^about:blank$/i.test(trimmed)) return BROWSER_SIDE_PANEL_BLANK_URL;
  if (/^https?:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : searchUrl(trimmed);
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
  options: { newTab?: boolean } = { newTab: true },
): Extract<SidePanelTarget, { kind: "browser" }> {
  return {
    kind: "browser",
    url,
    label: browserSidePanelLabel(url),
    tabId: browserTabId(),
    ...(options.newTab === false ? { dedupeKey: browserLinkDedupeKey(url) } : {}),
  };
}
