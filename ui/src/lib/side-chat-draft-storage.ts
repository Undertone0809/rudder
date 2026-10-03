const SIDE_CHAT_DRAFT_STORAGE_KEY = "rudder:side-chat-send-drafts:v1";

export type SideChatSendDraft = {
  body: string;
  acceptedUserMessageId: string | null;
};

type StoredSideChatSendDraft = SideChatSendDraft & { version: 1 };

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function scopeKey(
  principalId: string | null,
  orgId: string,
  parentConversationId: string,
  clientMutationId: string,
) {
  return [principalId ?? "anonymous", orgId, parentConversationId, clientMutationId]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function readAll(): Record<string, StoredSideChatSendDraft> {
  try {
    const raw = storage()?.getItem(SIDE_CHAT_DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const drafts: Record<string, StoredSideChatSendDraft> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const draft = value as Partial<StoredSideChatSendDraft>;
      if (
        draft.version === 1
        && typeof draft.body === "string"
        && (draft.acceptedUserMessageId === null || typeof draft.acceptedUserMessageId === "string")
      ) {
        drafts[key] = {
          version: 1,
          body: draft.body,
          acceptedUserMessageId: draft.acceptedUserMessageId,
        };
      }
    }
    return drafts;
  } catch {
    return {};
  }
}

export function readSideChatSendDraft(
  principalId: string | null,
  orgId: string,
  parentConversationId: string,
  clientMutationId: string,
): SideChatSendDraft | null {
  const draft = readAll()[scopeKey(principalId, orgId, parentConversationId, clientMutationId)];
  return draft
    ? { body: draft.body, acceptedUserMessageId: draft.acceptedUserMessageId }
    : null;
}

export function saveSideChatSendDraft(
  principalId: string | null,
  orgId: string,
  parentConversationId: string,
  clientMutationId: string,
  draft: SideChatSendDraft,
) {
  const drafts = readAll();
  const key = scopeKey(principalId, orgId, parentConversationId, clientMutationId);
  if (!draft.body && !draft.acceptedUserMessageId) delete drafts[key];
  else drafts[key] = { version: 1, ...draft };
  try {
    const target = storage();
    if (!target) return;
    if (Object.keys(drafts).length === 0) target.removeItem(SIDE_CHAT_DRAFT_STORAGE_KEY);
    else target.setItem(SIDE_CHAT_DRAFT_STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // Keep the in-memory composer usable when local storage is unavailable.
  }
}

export function clearSideChatSendDraft(
  principalId: string | null,
  orgId: string,
  parentConversationId: string,
  clientMutationId: string,
) {
  saveSideChatSendDraft(principalId, orgId, parentConversationId, clientMutationId, {
    body: "",
    acceptedUserMessageId: null,
  });
}
