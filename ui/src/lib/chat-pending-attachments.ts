import { resolveChatDraftScopeKey } from "./chat-draft-storage";

type PendingFilesByScope<T> = Record<string, T[]>;

let pendingFilesByScopeKey: PendingFilesByScope<File> = {};

export function resolveChatPendingAttachmentScopeKey(
  orgId: string,
  conversationId: string | null | undefined,
) {
  return `${orgId}:${resolveChatDraftScopeKey(conversationId)}`;
}

export function readChatScopedPendingFiles<T>(
  pendingFilesByScope: PendingFilesByScope<T>,
  scopeKey: string,
): T[] {
  return pendingFilesByScope[scopeKey] ?? [];
}

export function updateChatScopedPendingFiles<T>(
  pendingFilesByScope: PendingFilesByScope<T>,
  scopeKey: string,
  updater: (current: T[]) => T[],
): PendingFilesByScope<T> {
  const currentFiles = readChatScopedPendingFiles(pendingFilesByScope, scopeKey);
  const nextFiles = updater(currentFiles);

  if (nextFiles.length === 0) {
    if (!(scopeKey in pendingFilesByScope)) return pendingFilesByScope;
    const remainingScopes = { ...pendingFilesByScope };
    delete remainingScopes[scopeKey];
    return remainingScopes;
  }

  if (nextFiles === currentFiles) return pendingFilesByScope;
  return { ...pendingFilesByScope, [scopeKey]: nextFiles };
}

export function readChatPendingAttachmentsForScope(scopeKey: string): File[] {
  return readChatScopedPendingFiles(pendingFilesByScopeKey, scopeKey);
}

export function updateChatPendingAttachmentsForScope(
  scopeKey: string,
  updater: (current: File[]) => File[],
) {
  pendingFilesByScopeKey = updateChatScopedPendingFiles(pendingFilesByScopeKey, scopeKey, updater);
}

export function resetChatPendingAttachmentsForTests() {
  pendingFilesByScopeKey = {};
}
