import type { AppEntry } from "@/lib/apps-workspace";
import type { LocalAppOpaqueIdentity } from "@/lib/local-apps";

const STORAGE_KEY = "rudder.openAppsPrimaryRail.v1";
const EMPTY_ITEMS: readonly OpenAppRailItem[] = [];

export type OpenAppRailItem = {
  key: string;
  title: string;
  iconDataUrl: string | null;
  identity: LocalAppOpaqueIdentity | null;
};

type StoredOpenApps = Record<string, OpenAppRailItem[]>;

const listeners = new Set<() => void>();
let storageListenerAttached = false;
let cachedRaw: string | null | undefined;
let cachedStored: StoredOpenApps = {};

function isIdentity(value: unknown): value is LocalAppOpaqueIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<LocalAppOpaqueIdentity>;
  return typeof identity.desktopInstallationId === "string"
    && typeof identity.appPublicId === "string"
    && typeof identity.localBindingId === "string";
}

function isItem(value: unknown): value is OpenAppRailItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<OpenAppRailItem>;
  return typeof item.key === "string"
    && item.key.length > 0
    && typeof item.title === "string"
    && item.title.length > 0
    && (item.iconDataUrl === null || typeof item.iconDataUrl === "string")
    && (item.identity === null || isIdentity(item.identity));
}

function readStored(): StoredOpenApps {
  if (typeof window === "undefined") return {};
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === cachedRaw) return cachedStored;
  cachedRaw = raw;
  if (!raw) {
    cachedStored = {};
    return cachedStored;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid open Apps state");
    cachedStored = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, items]) => Array.isArray(items))
        .map(([organizationId, items]) => [
          organizationId,
          (items as unknown[]).filter(isItem),
        ]),
    );
  } catch {
    cachedStored = {};
  }
  return cachedStored;
}

function emitChange() {
  listeners.forEach((listener) => listener());
}

function writeStored(stored: StoredOpenApps) {
  if (typeof window === "undefined") return;
  const raw = JSON.stringify(stored);
  try {
    window.localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    return;
  }
  cachedRaw = raw;
  cachedStored = stored;
  emitChange();
}

function handleStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== STORAGE_KEY) return;
  cachedRaw = undefined;
  emitChange();
}

export function subscribeOpenAppRailItems(listener: () => void) {
  listeners.add(listener);
  if (!storageListenerAttached && typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
    storageListenerAttached = true;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && storageListenerAttached && typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
      storageListenerAttached = false;
    }
  };
}

export function readOpenAppRailItems(
  organizationId: string | null | undefined,
): readonly OpenAppRailItem[] {
  if (!organizationId) return EMPTY_ITEMS;
  return readStored()[organizationId] ?? EMPTY_ITEMS;
}

export function openAppRailItem(organizationId: string, item: OpenAppRailItem) {
  const stored = readStored();
  const current = stored[organizationId] ?? [];
  const existingIndex = current.findIndex((candidate) => candidate.key === item.key);
  const next = existingIndex >= 0
    ? current.map((candidate, index) => index === existingIndex ? item : candidate)
    : [...current, item];
  writeStored({ ...stored, [organizationId]: next });
}

export function removeOpenAppRailItem(organizationId: string, key: string) {
  const stored = readStored();
  const current = stored[organizationId] ?? [];
  const next = current.filter((candidate) => candidate.key !== key);
  if (next.length === current.length) return;
  writeStored({ ...stored, [organizationId]: next });
}

export function reconcileOpenAppRailItems(
  organizationId: string,
  availableItems: readonly OpenAppRailItem[],
) {
  const stored = readStored();
  const current = stored[organizationId] ?? [];
  const availableByKey = new Map(availableItems.map((item) => [item.key, item]));
  const next = current.flatMap((item) => {
    const available = availableByKey.get(item.key);
    return available ? [available] : [];
  });
  if (
    next.length === current.length
    && next.every((item, index) => JSON.stringify(item) === JSON.stringify(current[index]))
  ) {
    return;
  }
  writeStored({ ...stored, [organizationId]: next });
}

export function openAppRailItemFromEntry(entry: AppEntry): OpenAppRailItem {
  const definition = entry.definition;
  return {
    key: entry.key,
    title: entry.kind === "managed" ? entry.app.name : entry.definition.title,
    iconDataUrl: definition?.iconDataUrl ?? null,
    identity: definition
      ? {
          desktopInstallationId: definition.desktopInstallationId,
          appPublicId: definition.appPublicId,
          localBindingId: definition.localBindingId,
        }
      : null,
  };
}
