const CHAT_DRAFT_STORAGE_KEY = "rudder:chat-drafts";
const NEW_CHAT_SCOPE_KEY = "__new__";

type ChatDraftsByOrganization = Record<string, Record<string, string>>;

function chatDraftStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function resolveChatDraftScopeKey(conversationId: string | null | undefined): string {
  const trimmedConversationId = conversationId?.trim() ?? "";
  return trimmedConversationId || NEW_CHAT_SCOPE_KEY;
}

function readAllChatDrafts(): ChatDraftsByOrganization {
  try {
    const raw = chatDraftStorage()?.getItem(CHAT_DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as ChatDraftsByOrganization : {};
  } catch {
    return {};
  }
}

function writeAllChatDrafts(drafts: ChatDraftsByOrganization) {
  chatDraftStorage()?.setItem(CHAT_DRAFT_STORAGE_KEY, JSON.stringify(drafts));
}

export function readChatDraft(orgId: string, conversationId: string | null | undefined): string {
  const orgDrafts = readAllChatDrafts()[orgId];
  if (!orgDrafts || typeof orgDrafts !== "object") return "";

  const draft = orgDrafts[resolveChatDraftScopeKey(conversationId)];
  return typeof draft === "string" ? draft : "";
}

export function saveChatDraft(
  orgId: string,
  conversationId: string | null | undefined,
  body: string,
) {
  const drafts = readAllChatDrafts();
  const scopeKey = resolveChatDraftScopeKey(conversationId);
  const nextOrgDrafts = { ...(drafts[orgId] ?? {}) };

  if (body.length > 0) {
    nextOrgDrafts[scopeKey] = body;
    drafts[orgId] = nextOrgDrafts;
    writeAllChatDrafts(drafts);
    return;
  }

  if (!(scopeKey in nextOrgDrafts)) return;
  delete nextOrgDrafts[scopeKey];
  if (Object.keys(nextOrgDrafts).length === 0) {
    delete drafts[orgId];
  } else {
    drafts[orgId] = nextOrgDrafts;
  }
  writeAllChatDrafts(drafts);
}

export function clearChatDraft(orgId: string, conversationId: string | null | undefined) {
  saveChatDraft(orgId, conversationId, "");
}
