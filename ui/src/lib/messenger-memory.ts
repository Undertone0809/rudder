import type { MessengerThreadSummary } from "@rudder/shared";

const STORAGE_KEY = "rudder.messengerLastPaths";

type MessengerPathsByOrganization = Record<string, string>;

function readStoredMessengerPaths(): MessengerPathsByOrganization {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as MessengerPathsByOrganization : {};
  } catch {
    return {};
  }
}

function writeStoredMessengerPaths(paths: MessengerPathsByOrganization) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
  } catch {
    // Ignore storage failures so Messenger still works without persistence.
  }
}

export function sanitizeRememberedMessengerPath(path: string | null | undefined): string | null {
  const pathname = path?.split("?")[0]?.split("#")[0] ?? "";

  if (/^\/messenger\/chat(?:\/[^/]+)?$/.test(pathname)) return pathname;
  if (pathname === "/messenger/issues" || pathname === "/messenger/approvals") return pathname;
  if (/^\/messenger\/system\/(failed-runs|budget-alerts|join-requests)$/.test(pathname)) {
    return pathname;
  }

  return null;
}

export function rememberMessengerPath(orgId: string, path: string) {
  const sanitizedPath = sanitizeRememberedMessengerPath(path);
  if (!sanitizedPath) return;

  const paths = readStoredMessengerPaths();
  paths[orgId] = sanitizedPath;
  writeStoredMessengerPaths(paths);
}

export function getRememberedMessengerPath(orgId: string): string | null {
  return sanitizeRememberedMessengerPath(readStoredMessengerPaths()[orgId]);
}

function rememberedChatExists(path: string, threadSummaries: MessengerThreadSummary[]): boolean {
  const match = path.match(/^\/messenger\/chat\/([^/]+)$/);
  if (!match) return true;
  if (threadSummaries.length === 0) return false;
  return threadSummaries.some((thread) =>
    thread.threadKey === `chat:${match[1]}` || thread.href === path,
  );
}

export function resolveRememberedMessengerEntry(params: {
  orgId: string;
  threadSummaries: MessengerThreadSummary[];
}): string {
  const rememberedPath = getRememberedMessengerPath(params.orgId);
  if (rememberedPath && rememberedChatExists(rememberedPath, params.threadSummaries)) {
    return rememberedPath;
  }
  return "/messenger/chat";
}
