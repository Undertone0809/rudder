import { resolveChatDraftScopeKey } from "./chat-draft-storage";

const CHAT_SEND_MUTATIONS_STORAGE_KEY = "rudder:chat-send-mutations:v1";

export type PendingChatSendMutation = {
  fingerprint: string;
  id: string;
};

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function mutationScopeKey(
  orgId: string,
  conversationId: string | null | undefined,
  editUserMessageId?: string | null,
) {
  return `${orgId}:${resolveChatDraftScopeKey(conversationId)}:${editUserMessageId ?? "new"}`;
}

function readAll(): Record<string, PendingChatSendMutation> {
  try {
    const raw = storage()?.getItem(CHAT_SEND_MUTATIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, PendingChatSendMutation> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const mutation = value as Partial<PendingChatSendMutation>;
      if (typeof mutation.id === "string" && typeof mutation.fingerprint === "string") {
        result[key] = { id: mutation.id, fingerprint: mutation.fingerprint };
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function readPendingChatSendMutation(
  orgId: string,
  conversationId: string | null | undefined,
  editUserMessageId?: string | null,
) {
  return readAll()[mutationScopeKey(orgId, conversationId, editUserMessageId)] ?? null;
}

export function savePendingChatSendMutation(
  orgId: string,
  conversationId: string | null | undefined,
  editUserMessageId: string | null | undefined,
  mutation: PendingChatSendMutation,
) {
  const mutations = readAll();
  mutations[mutationScopeKey(orgId, conversationId, editUserMessageId)] = mutation;
  storage()?.setItem(CHAT_SEND_MUTATIONS_STORAGE_KEY, JSON.stringify(mutations));
}

export function clearPendingChatSendMutation(
  orgId: string,
  conversationId: string | null | undefined,
  editUserMessageId: string | null | undefined,
  expectedId: string,
) {
  const mutations = readAll();
  const key = mutationScopeKey(orgId, conversationId, editUserMessageId);
  if (mutations[key]?.id !== expectedId) return;
  delete mutations[key];
  const target = storage();
  if (Object.keys(mutations).length === 0) target?.removeItem(CHAT_SEND_MUTATIONS_STORAGE_KEY);
  else target?.setItem(CHAT_SEND_MUTATIONS_STORAGE_KEY, JSON.stringify(mutations));
}
