const STORAGE_PREFIX = "rudder:native-chat-first-send:v1:scope:";
const LOCK_PREFIX = "rudder:native-chat-first-send:v1:lock:";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 200;

export type NativeFirstSendDraft = {
  body: string;
  preferredAgentId: string | null;
  title: string | null;
  issueCreationMode: "manual_approval" | "auto_create";
  modelOverride: string | null;
  effortOverride: string | null;
};

export type NativeFirstSendIntent = {
  version: 1;
  orgId: string;
  userId: string;
  clientMutationId: string;
  status: "pending" | "unknown" | "not_found" | "accepted" | "settled";
  draft: NativeFirstSendDraft;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PreparedNativeFirstSend =
  | { created: true; intent: NativeFirstSendIntent }
  | { created: false; intent: NativeFirstSendIntent };

function identityKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

function storageKey(orgId: string, userId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(identityKey(orgId, userId))}`;
}

function lockKey(orgId: string, userId: string): string {
  return `${LOCK_PREFIX}${encodeURIComponent(identityKey(orgId, userId))}`;
}

function requiredStorage(): Storage {
  try {
    const storage = globalThis.localStorage;
    if (storage) return storage;
  } catch {
    // Use the same fail-closed error as a missing storage surface.
  }
  throw new Error("Browser storage is unavailable. Native Chat cannot preserve this first message's retry identity.");
}

function requiredLocks(): LockManager {
  try {
    const locks = globalThis.navigator?.locks;
    if (locks && typeof locks.request === "function") return locks;
  } catch {
    // Use the explicit unsupported-coordination error below.
  }
  throw new Error("Cross-tab coordination is unavailable. Native Chat cannot safely start this first message.");
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function parseDraft(value: unknown): NativeFirstSendDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "body,effortOverride,issueCreationMode,modelOverride,preferredAgentId,title"
    || !boundedString(candidate.body, MAX_BODY_BYTES)
    || new TextEncoder().encode(candidate.body).byteLength > MAX_BODY_BYTES
    || (candidate.title !== null && !boundedString(candidate.title, MAX_TITLE_LENGTH))
    || (candidate.preferredAgentId !== null && !boundedString(candidate.preferredAgentId, 128))
    || (candidate.modelOverride !== null && !boundedString(candidate.modelOverride, 256))
    || (candidate.effortOverride !== null && !boundedString(candidate.effortOverride, 64))
    || (candidate.issueCreationMode !== "manual_approval" && candidate.issueCreationMode !== "auto_create")) {
    return null;
  }
  return {
    body: candidate.body,
    title: candidate.title as string | null,
    preferredAgentId: candidate.preferredAgentId as string | null,
    modelOverride: candidate.modelOverride as string | null,
    effortOverride: candidate.effortOverride as string | null,
    issueCreationMode: candidate.issueCreationMode,
  };
}

function parseIntent(value: unknown, orgId: string, userId: string): NativeFirstSendIntent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "clientMutationId,conversationId,createdAt,draft,orgId,status,updatedAt,userId,version"
    || candidate.version !== 1
    || candidate.orgId !== orgId
    || candidate.userId !== userId
    || !boundedString(candidate.clientMutationId, 120)
    || candidate.clientMutationId.trim() === ""
    || !["pending", "unknown", "not_found", "accepted", "settled"].includes(String(candidate.status))
    || (candidate.conversationId !== null && !boundedString(candidate.conversationId, 64))
    || !boundedString(candidate.createdAt, 64)
    || !boundedString(candidate.updatedAt, 64)) return null;
  const draft = parseDraft(candidate.draft);
  if (!draft) return null;
  if ((candidate.status === "accepted" || candidate.status === "settled") !== (typeof candidate.conversationId === "string")) {
    return null;
  }
  return {
    version: 1,
    orgId,
    userId,
    clientMutationId: candidate.clientMutationId,
    status: candidate.status as NativeFirstSendIntent["status"],
    draft,
    conversationId: candidate.conversationId as string | null,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function readRaw(orgId: string, userId: string): NativeFirstSendIntent | null {
  const storage = requiredStorage();
  const raw = storage.getItem(storageKey(orgId, userId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Saved Native Chat first-message identity is unreadable. Check status before sending another message.");
  }
  const intent = parseIntent(parsed, orgId, userId);
  if (!intent) {
    throw new Error("Saved Native Chat first-message identity is invalid. Check status before sending another message.");
  }
  return intent;
}

async function withScopeLock<T>(orgId: string, userId: string, work: () => Promise<T>): Promise<T> {
  return requiredLocks().request(lockKey(orgId, userId), { mode: "exclusive" }, async () => work());
}

function writeChecked(intent: NativeFirstSendIntent): void {
  const storage = requiredStorage();
  const key = storageKey(intent.orgId, intent.userId);
  const serialized = JSON.stringify(intent);
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) {
    throw new Error("Browser storage could not confirm the Native Chat first-message identity. Sending is paused.");
  }
}

function comparableDraft(value: unknown, allowTransportIdentity: boolean): NativeFirstSendDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = { ...(value as Record<string, unknown>) };
  if (allowTransportIdentity) delete fields.clientMutationId;
  return parseDraft(fields);
}

function sameDraft(left: unknown, right: unknown): boolean {
  const saved = comparableDraft(left, false);
  const current = comparableDraft(right, true);
  return saved !== null
    && current !== null
    && saved.body === current.body
    && saved.preferredAgentId === current.preferredAgentId
    && saved.title === current.title
    && saved.issueCreationMode === current.issueCreationMode
    && saved.modelOverride === current.modelOverride
    && saved.effortOverride === current.effortOverride;
}

export function readNativeFirstSendIntent(orgId: string, userId: string): NativeFirstSendIntent | null {
  return readRaw(orgId, userId);
}

export async function prepareNativeFirstSendIntent(
  orgId: string,
  userId: string,
  draft: NativeFirstSendDraft,
): Promise<PreparedNativeFirstSend> {
  if (!orgId || !userId || !draft.body.trim() || new TextEncoder().encode(draft.body).byteLength > MAX_BODY_BYTES) {
    throw new Error("Native Chat first-message input is invalid.");
  }
  return withScopeLock(orgId, userId, async () => {
    const previous = readRaw(orgId, userId);
    if (previous && previous.status !== "settled") {
      // An unresolved identity is never replaced, even when the visible draft
      // has changed. It must be reconciled or explicitly settled first.
      return { created: false, intent: previous };
    }
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID !== "function") {
      throw new Error("Secure first-message identity generation is unavailable.");
    }
    const now = new Date().toISOString();
    const intent: NativeFirstSendIntent = {
      version: 1,
      orgId,
      userId,
      clientMutationId: randomUUID.call(globalThis.crypto),
      status: "pending",
      draft,
      conversationId: null,
      createdAt: now,
      updatedAt: now,
    };
    writeChecked(intent);
    return { created: true, intent };
  });
}

export async function updateNativeFirstSendIntent(
  orgId: string,
  userId: string,
  clientMutationId: string,
  status: NativeFirstSendIntent["status"],
  conversationId: string | null = null,
): Promise<NativeFirstSendIntent> {
  return withScopeLock(orgId, userId, async () => {
    const current = readRaw(orgId, userId);
    if (!current || current.clientMutationId !== clientMutationId) {
      throw new Error("Native Chat first-message identity changed in another tab. Check status before continuing.");
    }
    const transitionAllowed = current.status === "pending"
      ? status === "unknown" || status === "not_found" || status === "accepted"
      : current.status === "unknown"
        ? status === "unknown" || status === "not_found" || status === "accepted"
        : current.status === "not_found"
          ? status === "pending" || status === "unknown" || status === "not_found" || status === "accepted"
          : current.status === "accepted"
            ? (status === "accepted" || status === "settled")
            : status === "settled";
    if (!transitionAllowed
      || ((status === "accepted" || status === "settled") && !conversationId && !current.conversationId)
      || ((current.status === "accepted" || current.status === "settled")
        && conversationId !== null && current.conversationId !== conversationId)) {
      throw new Error("Native Chat first-message recovery state changed unexpectedly.");
    }
    const updated: NativeFirstSendIntent = {
      ...current,
      status,
      conversationId: status === "accepted" || status === "settled" ? conversationId ?? current.conversationId : null,
      updatedAt: new Date().toISOString(),
    };
    writeChecked(updated);
    return updated;
  });
}

export function nativeFirstSendDraftMatches(left: unknown, right: unknown): boolean {
  return sameDraft(left, right);
}
