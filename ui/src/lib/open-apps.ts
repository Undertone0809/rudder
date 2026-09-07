import { useSyncExternalStore } from "react";
import type { LocalAppOpaqueIdentity } from "./local-apps";

export type OpenApp = {
  key: string;
  title: string;
  path: string;
  identity?: LocalAppOpaqueIdentity;
};

const EVENT = "rudder:open-apps-changed";
const EMPTY: OpenApp[] = [];
const cache = new Map<string, { raw: string | null; entries: OpenApp[]; volatile?: boolean }>();

function storageKey(organizationId: string) {
  return `rudder.openApps:${organizationId}`;
}

export function readOpenApps(organizationId: string | null | undefined): OpenApp[] {
  if (!organizationId || typeof window === "undefined") return EMPTY;
  const previous = cache.get(organizationId);
  if (previous?.volatile) return previous.entries;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(storageKey(organizationId));
  } catch {
    return cache.get(organizationId)?.entries ?? EMPTY;
  }
  if (previous?.raw === raw) return previous.entries;
  let entries: OpenApp[] = EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    if (Array.isArray(parsed)) entries = parsed.filter((item): item is OpenApp => (
      item && typeof item.key === "string" && typeof item.title === "string"
      && typeof item.path === "string" && /^\/apps\/(?:view|saved)\/[^/]+$/.test(item.path)
    ));
  } catch { /* Ignore malformed session state. */ }
  cache.set(organizationId, { raw, entries });
  return entries;
}

function writeOpenApps(organizationId: string, entries: OpenApp[]) {
  const raw = JSON.stringify(entries);
  cache.set(organizationId, { raw, entries });
  try {
    window.sessionStorage.setItem(storageKey(organizationId), raw);
  } catch {
    cache.set(organizationId, { raw, entries, volatile: true });
  }
  window.dispatchEvent(new Event(EVENT));
}

export function openApp(organizationId: string, app: OpenApp) {
  const entries = readOpenApps(organizationId);
  const existing = entries.find((entry) => entry.key === app.key);
  if (existing && JSON.stringify(existing) === JSON.stringify(app)) return;
  writeOpenApps(organizationId, existing
    ? entries.map((entry) => entry.key === app.key ? app : entry)
    : [...entries, app]);
}

export function closeApp(organizationId: string, key: string) {
  const entries = readOpenApps(organizationId);
  if (!entries.some((entry) => entry.key === key)) return;
  writeOpenApps(organizationId, entries.filter((entry) => entry.key !== key));
}

function subscribe(listener: () => void) {
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useOpenApps(organizationId: string | null | undefined) {
  return useSyncExternalStore(subscribe, () => readOpenApps(organizationId), () => EMPTY);
}
