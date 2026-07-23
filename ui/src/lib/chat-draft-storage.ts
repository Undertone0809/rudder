import {
  chatInlineAnnotationsInputSchema,
  type ChatInlineAnnotationInput,
} from "@rudderhq/shared";

const CHAT_DRAFT_STORAGE_KEY = "rudder:chat-drafts";
const CHAT_ASK_USER_DRAFT_STORAGE_KEY = "rudder:chat-ask-user-drafts";
export const NEW_CHAT_SCOPE_KEY = "__new__";

export const CHAT_COMPOSER_DRAFT_VERSION = 1 as const;

export type ChatComposerDraft = {
  version: typeof CHAT_COMPOSER_DRAFT_VERSION;
  body: string;
  inlineAnnotations: ChatInlineAnnotationInput[];
};

type StoredChatDraft = string | ChatComposerDraft;
type ChatDraftsByOrganization = Record<string, Record<string, StoredChatDraft>>;

export type ChatAskUserDraft = {
  selectedByQuestionId: Record<string, string[]>;
  freeformByQuestionId: Record<string, string>;
  currentQuestionIndex: number;
  reviewingAnswers: boolean;
};

type ChatAskUserDraftsByOrganization = Record<string, Record<string, ChatAskUserDraft>>;

function chatDraftStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function resolveChatDraftScopeKey(conversationId: string | null | undefined): string {
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

function emptyChatComposerDraft(body = ""): ChatComposerDraft {
  return {
    version: CHAT_COMPOSER_DRAFT_VERSION,
    body,
    inlineAnnotations: [],
  };
}

function normalizeStoredChatDraft(value: unknown): ChatComposerDraft {
  if (typeof value === "string") return emptyChatComposerDraft(value);
  if (!value || typeof value !== "object") return emptyChatComposerDraft();
  const draft = value as Partial<ChatComposerDraft>;
  if (draft.version !== CHAT_COMPOSER_DRAFT_VERSION || typeof draft.body !== "string") {
    return emptyChatComposerDraft();
  }
  const parsedAnnotations = chatInlineAnnotationsInputSchema.safeParse(draft.inlineAnnotations);
  const inlineAnnotations = parsedAnnotations.success
    ? parsedAnnotations.data.map(({ attachmentFileIndexes: _attachmentFileIndexes, ...annotation }) => annotation)
    : [];
  return {
    version: CHAT_COMPOSER_DRAFT_VERSION,
    body: draft.body,
    inlineAnnotations,
  };
}

function hasMeaningfulChatComposerDraft(draft: ChatComposerDraft) {
  return draft.body.length > 0 || draft.inlineAnnotations.length > 0;
}

function deleteChatDraftScope(
  drafts: ChatDraftsByOrganization,
  orgId: string,
  scopeKey: string,
) {
  const nextOrgDrafts = { ...(drafts[orgId] ?? {}) };
  if (!(scopeKey in nextOrgDrafts)) return false;
  delete nextOrgDrafts[scopeKey];
  if (Object.keys(nextOrgDrafts).length === 0) {
    delete drafts[orgId];
  } else {
    drafts[orgId] = nextOrgDrafts;
  }
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const next: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") next[key] = entry;
  }
  return next;
}

function normalizeStringArrayRecord(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};
  const next: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isStringArray(entry)) next[key] = entry;
  }
  return next;
}

function normalizeChatAskUserDraft(value: unknown): ChatAskUserDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Partial<ChatAskUserDraft>;
  return {
    selectedByQuestionId: normalizeStringArrayRecord(draft.selectedByQuestionId),
    freeformByQuestionId: normalizeStringRecord(draft.freeformByQuestionId),
    currentQuestionIndex: typeof draft.currentQuestionIndex === "number" && Number.isFinite(draft.currentQuestionIndex)
      ? Math.max(0, Math.floor(draft.currentQuestionIndex))
      : 0,
    reviewingAnswers: draft.reviewingAnswers === true,
  };
}

function readAllChatAskUserDrafts(): ChatAskUserDraftsByOrganization {
  try {
    const raw = chatDraftStorage()?.getItem(CHAT_ASK_USER_DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const drafts: ChatAskUserDraftsByOrganization = {};
    for (const [orgId, orgDrafts] of Object.entries(parsed)) {
      if (!orgDrafts || typeof orgDrafts !== "object") continue;
      const normalizedOrgDrafts: Record<string, ChatAskUserDraft> = {};
      for (const [messageId, draft] of Object.entries(orgDrafts)) {
        const normalized = normalizeChatAskUserDraft(draft);
        if (normalized) normalizedOrgDrafts[messageId] = normalized;
      }
      if (Object.keys(normalizedOrgDrafts).length > 0) drafts[orgId] = normalizedOrgDrafts;
    }
    return drafts;
  } catch {
    return {};
  }
}

function writeAllChatAskUserDrafts(drafts: ChatAskUserDraftsByOrganization) {
  chatDraftStorage()?.setItem(CHAT_ASK_USER_DRAFT_STORAGE_KEY, JSON.stringify(drafts));
}

function hasMeaningfulChatAskUserDraft(draft: ChatAskUserDraft) {
  return Object.values(draft.selectedByQuestionId).some((entries) => entries.length > 0)
    || Object.values(draft.freeformByQuestionId).some((entry) => entry.trim().length > 0)
    || draft.currentQuestionIndex > 0
    || draft.reviewingAnswers;
}

export function readChatDraft(orgId: string, conversationId: string | null | undefined): string {
  return readChatComposerDraft(orgId, conversationId).body;
}

export function readChatComposerDraft(
  orgId: string,
  conversationId: string | null | undefined,
): ChatComposerDraft {
  const orgDrafts = readAllChatDrafts()[orgId];
  if (!orgDrafts || typeof orgDrafts !== "object") return emptyChatComposerDraft();
  return normalizeStoredChatDraft(orgDrafts[resolveChatDraftScopeKey(conversationId)]);
}

export function saveChatComposerDraft(
  orgId: string,
  conversationId: string | null | undefined,
  draft: ChatComposerDraft,
) {
  const drafts = readAllChatDrafts();
  const scopeKey = resolveChatDraftScopeKey(conversationId);
  const normalized = normalizeStoredChatDraft(draft);

  if (hasMeaningfulChatComposerDraft(normalized)) {
    drafts[orgId] = {
      ...(drafts[orgId] ?? {}),
      [scopeKey]: normalized,
    };
    writeAllChatDrafts(drafts);
    return;
  }

  if (deleteChatDraftScope(drafts, orgId, scopeKey)) writeAllChatDrafts(drafts);
}

export function saveChatDraft(
  orgId: string,
  conversationId: string | null | undefined,
  body: string,
) {
  const current = readChatComposerDraft(orgId, conversationId);
  saveChatComposerDraft(orgId, conversationId, { ...current, body });
}

export function clearChatDraft(orgId: string, conversationId: string | null | undefined) {
  const drafts = readAllChatDrafts();
  if (deleteChatDraftScope(drafts, orgId, resolveChatDraftScopeKey(conversationId))) {
    writeAllChatDrafts(drafts);
  }
}

export function readChatAskUserDraft(orgId: string, messageId: string): ChatAskUserDraft | null {
  const orgDrafts = readAllChatAskUserDrafts()[orgId];
  if (!orgDrafts || typeof orgDrafts !== "object") return null;
  return orgDrafts[messageId] ?? null;
}

export function saveChatAskUserDraft(orgId: string, messageId: string, draft: ChatAskUserDraft) {
  const drafts = readAllChatAskUserDrafts();
  const nextOrgDrafts = { ...(drafts[orgId] ?? {}) };

  if (hasMeaningfulChatAskUserDraft(draft)) {
    nextOrgDrafts[messageId] = draft;
    drafts[orgId] = nextOrgDrafts;
    writeAllChatAskUserDrafts(drafts);
    return;
  }

  if (!(messageId in nextOrgDrafts)) return;
  delete nextOrgDrafts[messageId];
  if (Object.keys(nextOrgDrafts).length === 0) {
    delete drafts[orgId];
  } else {
    drafts[orgId] = nextOrgDrafts;
  }
  writeAllChatAskUserDrafts(drafts);
}

export function clearChatAskUserDraft(orgId: string, messageId: string) {
  const drafts = readAllChatAskUserDrafts();
  const nextOrgDrafts = { ...(drafts[orgId] ?? {}) };
  if (!(messageId in nextOrgDrafts)) return;
  delete nextOrgDrafts[messageId];
  if (Object.keys(nextOrgDrafts).length === 0) {
    delete drafts[orgId];
  } else {
    drafts[orgId] = nextOrgDrafts;
  }
  writeAllChatAskUserDrafts(drafts);
}
