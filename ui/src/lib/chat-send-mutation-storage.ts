import { resolveChatDraftScopeKey } from "./chat-draft-storage";
import { HEARTBEAT_RUN_STATUSES } from "@rudderhq/shared";
import type { ChatGenerationStatus, ChatMessage, HeartbeatRunStatus } from "@rudderhq/shared";

const LEGACY_CHAT_SEND_MUTATIONS_STORAGE_KEY = "rudder:chat-send-mutations:v1";
const CHAT_SEND_MUTATIONS_STORAGE_PREFIX = "rudder:chat-send-mutations:v2:scope:";
const CHAT_SEND_MUTATIONS_BLOCKED_STORAGE_PREFIX = "rudder:chat-send-mutations:v2:blocked:";
const CHAT_SEND_MUTATIONS_LOCK_PREFIX = "rudder:chat-send-mutations:v2:lock:";
const MAX_PENDING_MUTATIONS_PER_SCOPE = 32;
const MAX_SETTLED_RANGES_PER_SCOPE = MAX_PENDING_MUTATIONS_PER_SCOPE + 1;

export type PendingChatSendMutation = {
  fingerprint: string;
  id: string;
  /** Monotonic scope-local identity, captured by every in-flight settlement callback. */
  ordinal?: number;
  /** Missing tokens are treated as a previous page and must be reconciled. */
  pageInstanceId?: string;
  /** Missing status is treated as pending for records written by older builds. */
  status?: "pending" | "unknown" | "accepted" | "recoverable" | "settled";
};

export type ChatSendReconciliationResult =
  | { outcome: "not_found"; clientMutationId: string }
  | {
    outcome: "accepted";
    clientMutationId: string;
    message: ChatMessage;
    generationId: string;
    runId: string;
    attemptEpoch: number;
    generationSeq: 0;
    bodyHash: string;
    generationStatus: ChatGenerationStatus;
    runStatus: HeartbeatRunStatus;
    runtimeTerminal: boolean;
  };

export type PreparedChatSendMutation = {
  clientMutationId: string;
  status: "ready" | "recovered" | "resume_required" | "retry_required";
  /** Exact previously saved body for the explicit recovery action. */
  recoveryBody?: string;
  recoveryModelOverride?: string | null;
  recoveryEffortOverride?: string | null;
  reconciliation?: ChatSendReconciliationResult;
  settle: () => Promise<void>;
  markUnknown: () => Promise<void>;
  markAccepted: () => Promise<void>;
  markRecoverable: () => Promise<void>;
};

export class PendingChatSendAlreadyAcceptedError extends Error {
  constructor() {
    super("This earlier message was already accepted and was not sent again. Your current draft is still here.");
    this.name = "PendingChatSendAlreadyAcceptedError";
  }
}

type ScopeMutationDocument = {
  version: 2;
  nextOrdinal: number;
  settledThrough: number;
  settledRanges: Array<{ start: number; end: number }>;
  mutations: Record<string, PendingChatSendMutation>;
};

type BlockedMutationIdentity = {
  version: 1;
  clientMutationId: string;
  fingerprint: string;
  ordinal: number;
  status?: "unknown" | "accepted" | "recoverable" | "settled";
};

const blockedMutationScopes = new Map<string, BlockedMutationIdentity>();
let cachedPageInstanceId: string | null = null;

function requiredStorage(): Storage {
  try {
    const value = globalThis.localStorage;
    if (value) return value;
  } catch {
    // Continue to the same explicit failure used for a missing storage surface.
  }
  throw new Error("Browser storage is unavailable. Sending is paused because Rudder cannot preserve this chat's retry identity.");
}

function requiredLocks(): LockManager {
  try {
    const value = globalThis.navigator?.locks;
    if (value && typeof value.request === "function") return value;
  } catch {
    // Continue to the explicit unsupported-coordination failure.
  }
  throw new Error("Cross-tab send coordination is unavailable. Sending is paused in this browser.");
}

function mutationScopeKey(
  orgId: string,
  conversationId: string | null | undefined,
  editUserMessageId?: string | null,
) {
  return `${orgId}:${resolveChatDraftScopeKey(conversationId)}:${editUserMessageId ?? "new"}`;
}

type ReplayableSavedInput = {
  body: string;
  modelOverride: string | null;
  effortOverride: string | null;
};

function replayableSavedInput(fingerprint: string): ReplayableSavedInput | null {
  if (fingerprint.length > 512 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fingerprint);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.body !== "string"
    || candidate.editUserMessageId !== null
    || !Array.isArray(candidate.files) || candidate.files.length !== 0
    || !Array.isArray(candidate.inlineAnnotations) || candidate.inlineAnnotations.length !== 0
    || (candidate.modelOverride !== null && typeof candidate.modelOverride !== "string")
    || (candidate.effortOverride !== null && typeof candidate.effortOverride !== "string")) return null;
  const canonical = JSON.stringify({
    body: candidate.body,
    editUserMessageId: null,
    files: [],
    inlineAnnotations: [],
    modelOverride: candidate.modelOverride,
    effortOverride: candidate.effortOverride,
  });
  if (canonical !== fingerprint) return null;
  return {
    body: candidate.body,
    modelOverride: candidate.modelOverride as string | null,
    effortOverride: candidate.effortOverride as string | null,
  };
}

function replayableSavedBody(fingerprint: string): string | null {
  return replayableSavedInput(fingerprint)?.body ?? null;
}

function scopedStorageKey(scopeKey: string) {
  return `${CHAT_SEND_MUTATIONS_STORAGE_PREFIX}${encodeURIComponent(scopeKey)}`;
}

function blockedScopeStorageKey(scopeKey: string) {
  return `${CHAT_SEND_MUTATIONS_BLOCKED_STORAGE_PREFIX}${encodeURIComponent(scopeKey)}`;
}

function lockName(scopeKey: string) {
  return `${CHAT_SEND_MUTATIONS_LOCK_PREFIX}${encodeURIComponent(scopeKey)}`;
}

function parseMutation(value: unknown): PendingChatSendMutation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const mutation = value as Partial<PendingChatSendMutation>;
  if (typeof mutation.id !== "string" || !mutation.id
    || typeof mutation.fingerprint !== "string" || !mutation.fingerprint
    || (mutation.pageInstanceId !== undefined
      && (typeof mutation.pageInstanceId !== "string" || !mutation.pageInstanceId || mutation.pageInstanceId.length > 128))
    || (mutation.status !== undefined && mutation.status !== "pending"
      && mutation.status !== "unknown" && mutation.status !== "accepted"
      && mutation.status !== "recoverable" && mutation.status !== "settled")) {
    return null;
  }
  return {
    id: mutation.id,
    fingerprint: mutation.fingerprint,
    ...(Number.isSafeInteger(mutation.ordinal) && (mutation.ordinal ?? 0) > 0
      ? { ordinal: mutation.ordinal }
      : {}),
    ...(typeof mutation.pageInstanceId === "string" ? { pageInstanceId: mutation.pageInstanceId } : {}),
    ...(mutation.status ? { status: mutation.status } : {}),
  };
}

function parseLegacyDocument(raw: string | null): Record<string, PendingChatSendMutation> {
  if (raw === null) return Object.create(null) as Record<string, PendingChatSendMutation>;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Saved send identity is unreadable. The send may already exist, so automatic retry is paused. Keep this browser's site data intact; this saved record cannot be reconciled safely.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Saved send identity is unreadable. The send may already exist, so automatic retry is paused. Keep this browser's site data intact; this saved record cannot be reconciled safely.");
  }
  const result = Object.create(null) as Record<string, PendingChatSendMutation>;
  for (const [key, value] of Object.entries(parsed)) {
    const mutation = parseMutation(value);
    if (!key || !mutation) {
      throw new Error("Saved send identity is unreadable. The send may already exist, so automatic retry is paused. Keep this browser's site data intact; this saved record cannot be reconciled safely.");
    }
    result[key] = mutation;
  }
  return result;
}

function unreadableScopeIdentity(): Error {
  return new Error("Saved send identity for this chat is unreadable. The send may already exist, so automatic retry is paused. Keep this browser's site data intact; this saved record cannot be reconciled safely.");
}

function emptyScopeDocument(): ScopeMutationDocument {
  return {
    version: 2,
    nextOrdinal: 1,
    settledThrough: 0,
    settledRanges: [],
    mutations: Object.create(null) as Record<string, PendingChatSendMutation>,
  };
}

function isSettledOrdinal(document: ScopeMutationDocument, ordinal: number): boolean {
  return ordinal <= document.settledThrough
    || document.settledRanges.some((range) => ordinal >= range.start && ordinal <= range.end);
}

function recordSettledOrdinal(document: ScopeMutationDocument, ordinal: number) {
  if (ordinal <= document.settledThrough) return;
  const ranges = [...document.settledRanges, { start: ordinal, end: ordinal }]
    .sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  while (merged[0] && merged[0].start <= document.settledThrough + 1) {
    document.settledThrough = Math.max(document.settledThrough, merged.shift()!.end);
  }
  document.settledRanges = merged;
}

function validateScopeDocument(document: ScopeMutationDocument): ScopeMutationDocument {
  const fail = () => { throw unreadableScopeIdentity(); };
  if (!Number.isSafeInteger(document.nextOrdinal) || document.nextOrdinal < 1
    || !Number.isSafeInteger(document.settledThrough) || document.settledThrough < 0
    || document.settledThrough >= document.nextOrdinal
    || !Array.isArray(document.settledRanges)
    || document.settledRanges.length > MAX_SETTLED_RANGES_PER_SCOPE
    || Object.keys(document.mutations).length > MAX_PENDING_MUTATIONS_PER_SCOPE) fail();

  let previousEnd = document.settledThrough;
  for (const range of document.settledRanges) {
    if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start <= previousEnd + 1 || range.end < range.start
      || range.end >= document.nextOrdinal) fail();
    previousEnd = range.end;
  }

  const ordinals: number[] = [];
  const pendingOrdinals: number[] = [];
  for (const mutation of Object.values(document.mutations)) {
    const ordinal = mutation.ordinal;
    if (!Number.isSafeInteger(ordinal) || (ordinal ?? 0) < 1 || (ordinal ?? 0) >= document.nextOrdinal) fail();
    const settled = isSettledOrdinal(document, ordinal!);
    if ((mutation.status === "settled") !== settled) fail();
    ordinals.push(ordinal!);
    if (!settled) pendingOrdinals.push(ordinal!);
  }
  ordinals.sort((left, right) => left - right);
  for (let index = 1; index < ordinals.length; index += 1) {
    if (ordinals[index] === ordinals[index - 1]) fail();
  }

  // Every allocated ordinal must still be represented by either a mutation
  // identity or compact settled proof. This prevents a malformed floor/range
  // from silently blessing a missing, unresolved identity.
  const represented = [
    ...(document.settledThrough > 0 ? [{ start: 1, end: document.settledThrough }] : []),
    ...document.settledRanges,
    ...pendingOrdinals.map((ordinal) => ({ start: ordinal, end: ordinal })),
  ].sort((left, right) => left.start - right.start);
  let expected = 1;
  for (const range of represented) {
    if (range.start !== expected) fail();
    expected = range.end + 1;
  }
  if (expected !== document.nextOrdinal) fail();
  return document;
}

function migrateVersionOneDocument(source: Record<string, PendingChatSendMutation>): ScopeMutationDocument {
  const document = emptyScopeDocument();
  const entries = Object.values(source);
  document.nextOrdinal = entries.length + 1;
  entries.forEach((mutation, index) => {
    const ordinal = index + 1;
    document.mutations[mutation.id] = { ...mutation, ordinal, status: mutation.status ?? "pending" };
    if (mutation.status === "settled") recordSettledOrdinal(document, ordinal);
  });
  return validateScopeDocument(document);
}

function parseScopeDocument(raw: string): ScopeMutationDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unreadableScopeIdentity();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw unreadableScopeIdentity();
  }
  const source = parsed as {
    version?: unknown;
    mutations?: unknown;
    nextOrdinal?: unknown;
    settledThrough?: unknown;
    settledRanges?: unknown;
  };
  if (!source.mutations || typeof source.mutations !== "object" || Array.isArray(source.mutations)) {
    throw unreadableScopeIdentity();
  }
  const mutations = Object.create(null) as Record<string, PendingChatSendMutation>;
  for (const [id, value] of Object.entries(source.mutations as Record<string, unknown>)) {
    const mutation = parseMutation(value);
    if (!id || !mutation || mutation.id !== id) {
      throw unreadableScopeIdentity();
    }
    mutations[id] = mutation;
  }
  if (source.version === 1) return migrateVersionOneDocument(mutations);
  if (source.version !== 2 || !Array.isArray(source.settledRanges)) throw unreadableScopeIdentity();
  return validateScopeDocument({
    version: 2,
    nextOrdinal: source.nextOrdinal as number,
    settledThrough: source.settledThrough as number,
    settledRanges: source.settledRanges as ScopeMutationDocument["settledRanges"],
    mutations,
  });
}

function readScopeDocument(scopeKey: string): ScopeMutationDocument {
  const target = requiredStorage();
  let raw: string | null;
  try {
    raw = target.getItem(scopedStorageKey(scopeKey));
  } catch {
    throw new Error("Saved send identity could not be read for this chat. Sending is paused until browser storage is available.");
  }
  if (raw !== null) return parseScopeDocument(raw);

  // The old format stored every scope in one map. Read only this scope and
  // leave the legacy key untouched so another still-open old tab cannot have
  // its record erased by a migration read-modify-write.
  let legacyRaw: string | null;
  try {
    legacyRaw = target.getItem(LEGACY_CHAT_SEND_MUTATIONS_STORAGE_KEY);
  } catch {
    throw new Error("Saved send identity could not be read. Sending is paused until browser storage is available.");
  }
  const legacy = parseLegacyDocument(legacyRaw);
  const previous = legacy[scopeKey];
  return migrateVersionOneDocument(previous ? { [previous.id]: previous } : Object.create(null));
}

function writeScopeDocument(scopeKey: string, document: ScopeMutationDocument) {
  const target = requiredStorage();
  const serialized = JSON.stringify(document);
  try {
    target.setItem(scopedStorageKey(scopeKey), serialized);
  } catch {
    throw new Error("Saved send identity could not be saved for this chat. Retry before sending.");
  }
  let retained: string | null;
  try {
    retained = target.getItem(scopedStorageKey(scopeKey));
  } catch {
    throw new Error("Saved send identity could not be verified for this chat. Retry before sending.");
  }
  if (retained !== serialized) {
    throw new Error("Saved send identity could not be confirmed for this chat. Retry before sending.");
  }
}

function withScopeLock<T>(scopeKey: string, callback: () => T): Promise<T> {
  const locks = requiredLocks();
  return locks.request(lockName(scopeKey), { mode: "exclusive" }, callback);
}

function sameMutationIdentity(
  left: Pick<BlockedMutationIdentity, "clientMutationId" | "fingerprint" | "ordinal">,
  right: Pick<BlockedMutationIdentity, "clientMutationId" | "fingerprint" | "ordinal">,
) {
  return left.clientMutationId === right.clientMutationId
    && left.fingerprint === right.fingerprint
    && left.ordinal === right.ordinal;
}

function blockedIdentityFromUnknown(value: unknown): BlockedMutationIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Partial<BlockedMutationIdentity>;
  if (marker.version !== 1
    || typeof marker.clientMutationId !== "string" || !marker.clientMutationId
    || typeof marker.fingerprint !== "string" || !marker.fingerprint
    || !Number.isSafeInteger(marker.ordinal) || (marker.ordinal ?? 0) < 1
    || (marker.status !== undefined && marker.status !== "unknown" && marker.status !== "accepted"
      && marker.status !== "recoverable" && marker.status !== "settled")) return null;
  return {
    version: 1,
    clientMutationId: marker.clientMutationId,
    fingerprint: marker.fingerprint,
    ordinal: marker.ordinal!,
    ...(marker.status ? { status: marker.status } : {}),
  };
}

function readBlockedScope(scopeKey: string): BlockedMutationIdentity | null {
  const memoryMarker = blockedMutationScopes.get(scopeKey);
  if (memoryMarker) return memoryMarker;
  let raw: string | null;
  try {
    raw = requiredStorage().getItem(blockedScopeStorageKey(scopeKey));
  } catch {
    throw new Error("Saved send identity could not be verified. Enable browser storage and retry.");
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("A previous send may already have been accepted, but its recovery identity is incomplete. The current draft is preserved and was not sent.");
  }
  const marker = blockedIdentityFromUnknown(parsed);
  if (!marker) {
    throw new Error("A previous send may already have been accepted, but its recovery identity is incomplete. The current draft is preserved and was not sent.");
  }
  return marker;
}

function persistBlockedScope(
  scopeKey: string,
  identity: BlockedMutationIdentity,
  status?: "unknown" | "accepted" | "recoverable" | "settled",
) {
  const blocked = { ...identity, ...(status ? { status } : {}) };
  blockedMutationScopes.set(scopeKey, blocked);
  try {
    const target = requiredStorage();
    const key = blockedScopeStorageKey(scopeKey);
    const serialized = JSON.stringify(blocked);
    target.setItem(key, serialized);
    if (target.getItem(key) !== serialized) {
      throw new Error("unconfirmed");
    }
  } catch {
    // The in-memory marker can still be reconciled in this page. If storage
    // recovers only after reload, the original pending row remains the source
    // of its exact identity; we never replace it with a new send ID.
  }
}

function clearBlockedScope(scopeKey: string, identity: BlockedMutationIdentity) {
  const memoryMarker = blockedMutationScopes.get(scopeKey);
  if (memoryMarker && !sameMutationIdentity(memoryMarker, identity)) {
    throw new Error("A different send is still awaiting reconciliation. The current draft was not sent.");
  }
  const target = requiredStorage();
  const key = blockedScopeStorageKey(scopeKey);
  let raw: string | null;
  try {
    raw = target.getItem(key);
  } catch {
    throw new Error("Recovered send status could not be saved. The current draft was not sent.");
  }
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Recovered send status could not be verified. The current draft was not sent.");
    }
    const stored = blockedIdentityFromUnknown(parsed);
    if (!stored || !sameMutationIdentity(stored, identity)) {
      throw new Error("A different send is still awaiting reconciliation. The current draft was not sent.");
    }
    try {
      target.removeItem(key);
    } catch {
      throw new Error("Recovered send status could not be saved. The current draft was not sent.");
    }
    try {
      if (target.getItem(key) !== null) throw new Error("unconfirmed");
    } catch {
      throw new Error("Recovered send status could not be confirmed. The current draft was not sent.");
    }
  }
  blockedMutationScopes.delete(scopeKey);
}

function pageInstanceId(cryptoApi: Crypto): string {
  if (cachedPageInstanceId) return cachedPageInstanceId;
  cachedPageInstanceId = cryptoApi.randomUUID();
  if (!cachedPageInstanceId || cachedPageInstanceId.length > 128) {
    throw new Error("Secure send identity is unavailable. Retry after refreshing Rudder.");
  }
  return cachedPageInstanceId;
}

function isCoherentTerminalReceipt(receipt: Extract<ChatSendReconciliationResult, { outcome: "accepted" }>) {
  if (!receipt.runtimeTerminal) return false;
  return (receipt.generationStatus === "completed" && receipt.runStatus === "succeeded")
    || (receipt.generationStatus === "stopped" && receipt.runStatus === "cancelled")
    || (receipt.generationStatus === "failed"
      && (receipt.runStatus === "failed" || receipt.runStatus === "timed_out"));
}

const CHAT_GENERATION_STATUS_VALUES: readonly ChatGenerationStatus[] = [
  "starting", "active", "running", "waiting_for_network", "tool_busy", "closing",
  "stop_requested", "stopping", "completed", "failed", "stopped", "aborted",
  "interrupted_unverified", "control_lost",
];
function validReceiptStatuses(receipt: Extract<ChatSendReconciliationResult, { outcome: "accepted" }>) {
  if (!CHAT_GENERATION_STATUS_VALUES.includes(receipt.generationStatus)
    || !HEARTBEAT_RUN_STATUSES.includes(receipt.runStatus)) return false;
  return receipt.runtimeTerminal
    ? isCoherentTerminalReceipt(receipt)
    : !isTerminalStatusPair(receipt.generationStatus, receipt.runStatus);
}

function isTerminalStatusPair(generationStatus: ChatGenerationStatus, runStatus: HeartbeatRunStatus) {
  return (generationStatus === "completed" && runStatus === "succeeded")
    || (generationStatus === "stopped" && runStatus === "cancelled")
    || (generationStatus === "failed" && (runStatus === "failed" || runStatus === "timed_out"));
}

function isValidReconciliation(
  reconciliation: ChatSendReconciliationResult | null | undefined,
  expected: { clientMutationId: string; orgId: string; conversationId: string; body: string },
): reconciliation is ChatSendReconciliationResult {
  if (!reconciliation || reconciliation.clientMutationId !== expected.clientMutationId) return false;
  if (reconciliation.outcome === "not_found") return true;
  return reconciliation.outcome === "accepted"
    && typeof reconciliation.generationId === "string" && reconciliation.generationId.length > 0
    && typeof reconciliation.runId === "string" && reconciliation.runId.length > 0
    && Number.isSafeInteger(reconciliation.attemptEpoch) && reconciliation.attemptEpoch > 0
    && reconciliation.generationSeq === 0
    && reconciliation.bodyHash === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    && typeof reconciliation.runtimeTerminal === "boolean"
    && validReceiptStatuses(reconciliation)
    && !!reconciliation.message && reconciliation.message.role === "user"
    && reconciliation.message.kind === "message"
    && typeof reconciliation.message.id === "string" && reconciliation.message.id.length > 0
    && reconciliation.message.runId === reconciliation.runId
    && reconciliation.message.orgId === expected.orgId
    && reconciliation.message.conversationId === expected.conversationId
    && reconciliation.message.body === expected.body;
}

async function updateStoredMutationStatus(
  scopeKey: string,
  identity: BlockedMutationIdentity,
  status: "unknown" | "accepted" | "recoverable" | "settled",
) {
  try {
    await withScopeLock(scopeKey, () => {
      try {
        const latest = readScopeDocument(scopeKey);
        const current = latest.mutations[identity.clientMutationId];
        if (!current) {
          if (status === "settled" && isSettledOrdinal(latest, identity.ordinal)) {
            clearBlockedScope(scopeKey, identity);
            return;
          }
          throw new Error("The acknowledged send identity is missing or changed.");
        }
        if (!sameMutationIdentity({
          clientMutationId: current.id,
          fingerprint: current.fingerprint,
          ordinal: current.ordinal ?? 0,
        }, identity)) {
          throw new Error("The acknowledged send identity is missing or changed.");
        }
        if (current.status === "settled") {
          if (status === "settled") clearBlockedScope(scopeKey, identity);
          return;
        }
        const next = { ...current, status };
        if (status === "settled") recordSettledOrdinal(latest, identity.ordinal);
        latest.mutations[identity.clientMutationId] = next;
        writeScopeDocument(scopeKey, latest);
        if (status === "settled") clearBlockedScope(scopeKey, identity);
      } catch {
        // Keep the exact receipt identity. Reconciliation may clear this
        // marker only after the backend confirms its persisted state.
        persistBlockedScope(scopeKey, identity, status);
      }
    });
  } catch {
    persistBlockedScope(scopeKey, identity, status);
  }
}

export function readPendingChatSendMutation(
  orgId: string,
  conversationId: string | null | undefined,
  editUserMessageId?: string | null,
) {
  const scopeKey = mutationScopeKey(orgId, conversationId, editUserMessageId);
  const mutations = Object.values(readScopeDocument(scopeKey).mutations);
  return [...mutations].reverse().find((mutation) => mutation.status !== "settled")
    ?? [...mutations].reverse()[0]
    ?? null;
}

export type DiscoveredChatSendRecovery = {
  status: "resume_required" | "retry_required" | "recovered";
  clientMutationId: string;
  body: string;
  modelOverride: string | null;
  effortOverride: string | null;
  reconciliation?: ChatSendReconciliationResult;
};

/**
 * Reconcile a saved send when a conversation becomes active. This function
 * never allocates an ID or dispatches a message; an explicit UI action must
 * call preparePendingChatSendMutation with the returned exact ID and body.
 */
export async function recoverPendingChatSendMutation(input: {
  orgId: string;
  conversationId: string;
  signal?: AbortSignal;
  reconcilePendingMutation: (
    clientMutationId: string,
    body: string,
    signal?: AbortSignal,
  ) => Promise<ChatSendReconciliationResult>;
}): Promise<DiscoveredChatSendRecovery | null> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.randomUUID) throw new Error("Secure send identity is unavailable. Retry after refreshing Rudder.");
  requiredStorage();
  requiredLocks();
  const currentPageId = pageInstanceId(cryptoApi);
  const scopeKey = mutationScopeKey(input.orgId, input.conversationId);
  type Candidate = {
    identity: BlockedMutationIdentity;
    body: string;
    modelOverride: string | null;
    effortOverride: string | null;
    acceptedPreviously: boolean;
    settledPreviously: boolean;
  };
  const inspection = await withScopeLock(scopeKey, () => {
    const document = readScopeDocument(scopeKey);
    const blocked = readBlockedScope(scopeKey);
    const unresolved = Object.values(document.mutations).filter((mutation) => mutation.status !== "settled");
    if (unresolved.length > 1) throw new Error("More than one earlier send is unresolved for this chat. Automatic recovery is paused.");
    const mutation = blocked
      ? document.mutations[blocked.clientMutationId] ?? null
      : unresolved[0] ?? null;
    if (!blocked && !mutation) return { kind: "none" as const };
    if (blocked && mutation && !sameMutationIdentity({
      clientMutationId: mutation.id,
      fingerprint: mutation.fingerprint,
      ordinal: mutation.ordinal ?? 0,
    }, blocked)) throw new Error("The saved recovery marker does not match this chat's send history.");
    const identity: BlockedMutationIdentity = blocked ?? {
      version: 1,
      clientMutationId: mutation!.id,
      fingerprint: mutation!.fingerprint,
      ordinal: mutation!.ordinal ?? 0,
      ...(mutation?.status && mutation.status !== "pending" ? { status: mutation.status } : {}),
    };
    if (!Number.isSafeInteger(identity.ordinal) || identity.ordinal < 1) throw unreadableScopeIdentity();
    if (!mutation && !isSettledOrdinal(document, identity.ordinal)) {
      throw new Error("The saved recovery identity is missing. Automatic recovery is paused.");
    }
    const savedInput = replayableSavedInput(identity.fingerprint);
    if (!savedInput) throw new Error("A previous send may already have been accepted, but its original content cannot be replayed safely. Keep this browser's site data intact.");
    const acceptedPreviously = identity.status === "accepted" || identity.status === "recoverable"
      || mutation?.status === "accepted" || mutation?.status === "recoverable";
    const settledPreviously = identity.status === "settled" || mutation?.status === "settled"
      || isSettledOrdinal(document, identity.ordinal);
    if (!blocked && mutation?.pageInstanceId === currentPageId) {
      if (mutation.status === "pending") return { kind: "none" as const };
      if (acceptedPreviously) {
        return { kind: "ready" as const, identity, savedInput, status: "resume_required" as const };
      }
    }
    return { kind: "candidate" as const, candidate: {
      identity,
      ...savedInput,
      acceptedPreviously,
      settledPreviously,
    } satisfies Candidate };
  });
  if (inspection.kind === "none") return null;
  if (inspection.kind === "ready") {
    return {
      status: inspection.status,
      clientMutationId: inspection.identity.clientMutationId,
      body: inspection.savedInput.body,
      modelOverride: inspection.savedInput.modelOverride,
      effortOverride: inspection.savedInput.effortOverride,
    };
  }
  if (input.signal?.aborted) return null;

  let reconciliation: ChatSendReconciliationResult;
  try {
    reconciliation = await input.reconcilePendingMutation(
      inspection.candidate.identity.clientMutationId,
      inspection.candidate.body,
      input.signal,
    );
  } catch {
    if (input.signal?.aborted) return null;
    throw new Error("Rudder could not confirm whether the previous send was accepted. The current draft is preserved; no new message was sent.");
  }
  if (input.signal?.aborted) return null;
  if (!isValidReconciliation(reconciliation, {
    clientMutationId: inspection.candidate.identity.clientMutationId,
    orgId: input.orgId,
    conversationId: input.conversationId,
    body: inspection.candidate.body,
  })) throw new Error("Rudder returned an invalid send-recovery result. The current draft is preserved; no new message was sent.");

  const result = await withScopeLock(scopeKey, () => {
    const latest = readScopeDocument(scopeKey);
    const latestBlocked = readBlockedScope(scopeKey);
    if (latestBlocked && !sameMutationIdentity(latestBlocked, inspection.candidate.identity)) {
      throw new Error("A different send is still awaiting reconciliation.");
    }
    const current = latest.mutations[inspection.candidate.identity.clientMutationId] ?? null;
    if (current && !sameMutationIdentity({
      clientMutationId: current.id,
      fingerprint: current.fingerprint,
      ordinal: current.ordinal ?? 0,
    }, inspection.candidate.identity)) throw new Error("The saved send changed while it was being reconciled.");
    const locallySettled = isSettledOrdinal(latest, inspection.candidate.identity.ordinal);

    if (reconciliation.outcome === "accepted") {
      if (!current && !locallySettled) throw new Error("The accepted send no longer has a matching local identity.");
      if (current?.status === "settled" || locallySettled || inspection.candidate.settledPreviously) {
        if (!isCoherentTerminalReceipt(reconciliation)) throw new Error("Rudder returned an inconsistent recovery receipt for a locally settled send.");
        clearBlockedScope(scopeKey, inspection.candidate.identity);
        return { status: "recovered" as const };
      }
      if (isCoherentTerminalReceipt(reconciliation)) {
        if (current) {
          latest.mutations[inspection.candidate.identity.clientMutationId] = { ...current, status: "settled" };
          recordSettledOrdinal(latest, inspection.candidate.identity.ordinal);
          writeScopeDocument(scopeKey, latest);
        }
        clearBlockedScope(scopeKey, inspection.candidate.identity);
        return { status: "recovered" as const };
      }
      if (reconciliation.runtimeTerminal || !current) throw new Error("Rudder returned an inconsistent recovery receipt.");
      latest.mutations[inspection.candidate.identity.clientMutationId] = {
        ...current,
        pageInstanceId: currentPageId,
        status: "recoverable",
      };
      writeScopeDocument(scopeKey, latest);
      clearBlockedScope(scopeKey, inspection.candidate.identity);
      return { status: "resume_required" as const };
    }

    if (!current || locallySettled || current.status === "settled") {
      throw new Error("Rudder could not confirm a locally settled send.");
    }
    if (inspection.candidate.acceptedPreviously || current.status === "accepted" || current.status === "recoverable") {
      throw new Error("Rudder could not find a message this browser previously recorded as accepted. The original send remains paused.");
    }
    if (inspection.candidate.settledPreviously) {
      throw new Error("Rudder could not confirm the terminal state of a locally completed send. The original identity remains paused.");
    }
    latest.mutations[inspection.candidate.identity.clientMutationId] = {
      ...current,
      pageInstanceId: currentPageId,
      status: "pending",
    };
    writeScopeDocument(scopeKey, latest);
    clearBlockedScope(scopeKey, inspection.candidate.identity);
    return { status: "retry_required" as const };
  });
  return {
    ...result,
    clientMutationId: inspection.candidate.identity.clientMutationId,
    body: inspection.candidate.body,
    modelOverride: inspection.candidate.modelOverride,
    effortOverride: inspection.candidate.effortOverride,
    reconciliation,
  };
}

export async function preparePendingChatSendMutation(input: {
  orgId: string;
  conversationId: string;
  editUserMessageId?: string | null;
  queuedMessageId?: string | null;
  body: string;
  files: readonly Pick<File, "name" | "size" | "type" | "arrayBuffer">[];
  inlineAnnotations: unknown;
  modelOverride?: string | null;
  effortOverride?: string | null;
  /** Only an explicit Resume control may replay a known-accepted mutation. */
  resumeClientMutationId?: string | null;
  reconcilePendingMutation?: (clientMutationId: string, body: string) => Promise<ChatSendReconciliationResult>;
}): Promise<PreparedChatSendMutation> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.randomUUID) {
    throw new Error("Secure send identity is unavailable. Retry after refreshing Rudder.");
  }
  if (input.files.length > 0 && !cryptoApi.subtle) {
    throw new Error("Secure attachment identity is unavailable. Retry after refreshing Rudder.");
  }
  // Fail before asynchronous hashing or dispatch if storage/coordination is unavailable.
  requiredStorage();
  requiredLocks();
  const currentPageId = pageInstanceId(cryptoApi);
  const scopeKey = mutationScopeKey(input.orgId, input.conversationId, input.editUserMessageId);
  const fileIdentities = await Promise.all(input.files.map(async (file, index) => {
    const digest = await cryptoApi.subtle!.digest("SHA-256", await file.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return {
      index,
      name: file.name || null,
      size: file.size,
      type: file.type.toLowerCase(),
      sha256,
    };
  }));
  const fingerprintInput = {
    body: input.body,
    editUserMessageId: input.editUserMessageId ?? null,
    files: fileIdentities,
    inlineAnnotations: input.inlineAnnotations,
    modelOverride: input.modelOverride ?? null,
    effortOverride: input.effortOverride ?? null,
  };
  const mutationFingerprint = JSON.stringify(fingerprintInput);
  const matchesSavedReplay = (fingerprint: string, saved: ReplayableSavedInput | null) => Boolean(saved
    && JSON.stringify({
      ...fingerprintInput,
      modelOverride: saved.modelOverride,
      effortOverride: saved.effortOverride,
    }) === fingerprint);
  type RecoveryCandidate = {
    identity: BlockedMutationIdentity;
    body: string;
    modelOverride: string | null;
    effortOverride: string | null;
    acceptedPreviously: boolean;
    settledPreviously: boolean;
  };
  const inspected = await withScopeLock(scopeKey, () => {
    const document = readScopeDocument(scopeKey);
    const blocked = readBlockedScope(scopeKey);
    const unresolved = Object.values(document.mutations).filter((mutation) => mutation.status !== "settled");
    if (unresolved.length > 1) {
      throw new Error("More than one earlier send is unresolved for this chat. Your current draft is preserved and was not sent.");
    }

    if (blocked) {
      const mutation = document.mutations[blocked.clientMutationId] ?? null;
      if (mutation && !sameMutationIdentity({
        clientMutationId: mutation.id,
        fingerprint: mutation.fingerprint,
        ordinal: mutation.ordinal ?? 0,
      }, blocked)) {
        throw new Error("The saved recovery marker does not match this chat's send history. Your current draft was not sent.");
      }
      if (!mutation && !isSettledOrdinal(document, blocked.ordinal)) {
        throw new Error("The saved recovery identity is missing. Your current draft was not sent.");
      }
      const savedInput = replayableSavedInput(blocked.fingerprint);
      if (!savedInput) {
        throw new Error("A previous send may already have been accepted, but its original content cannot be replayed safely. Your current draft is preserved and was not sent.");
      }
      return {
        kind: "reconcile" as const,
        candidate: {
          identity: blocked,
          ...savedInput,
          acceptedPreviously: blocked.status === "accepted" || blocked.status === "recoverable"
            || mutation?.status === "accepted" || mutation?.status === "recoverable",
          settledPreviously: blocked.status === "settled" || mutation?.status === "settled"
            || isSettledOrdinal(document, blocked.ordinal),
        },
      };
    }

    const pending = unresolved[0];
    if (pending) {
      const identity = {
        version: 1 as const,
        clientMutationId: pending.id,
        fingerprint: pending.fingerprint,
        ordinal: pending.ordinal ?? 0,
      };
      if (identity.ordinal < 1) throw unreadableScopeIdentity();
      const sameContent = pending.fingerprint === mutationFingerprint;
      if (pending.status === "unknown") {
        const savedInput = replayableSavedInput(pending.fingerprint);
        if (!savedInput) {
          throw new Error("A previous send may already have been accepted, but its original content cannot be reconciled safely. Your current draft is preserved and was not sent.");
        }
        return { kind: "reconcile" as const, candidate: { identity, ...savedInput, acceptedPreviously: false, settledPreviously: false } };
      }
      if (pending.status === "accepted" || pending.status === "recoverable") {
        const savedInput = replayableSavedInput(pending.fingerprint);
        if (!savedInput) throw new Error("An earlier message was accepted with content this build cannot safely replay. Keep its recovery identity and current draft; no new message was sent.");
        if (pending.pageInstanceId === currentPageId) {
          if (input.resumeClientMutationId === pending.id) {
            if (!matchesSavedReplay(pending.fingerprint, savedInput)) throw new Error("The explicit recovery action no longer matches the saved message. Your current draft was not sent.");
            return { kind: "ready" as const, identity, ...savedInput };
          }
          return { kind: "resume_required" as const, identity, ...savedInput };
        }
        return { kind: "reconcile" as const, candidate: { identity, ...savedInput, acceptedPreviously: true, settledPreviously: false } };
      }
      if (pending.pageInstanceId === currentPageId) {
        if (input.resumeClientMutationId === pending.id) {
          const savedInput = replayableSavedInput(pending.fingerprint);
          if (!matchesSavedReplay(pending.fingerprint, savedInput)) throw new Error("The explicit recovery action no longer matches the saved message. Your current draft was not sent.");
          return { kind: "ready" as const, identity, ...savedInput };
        }
        if (!sameContent) {
          throw new Error("A previous send may still be in flight. Restore its exact body before retrying; your current draft is preserved and was not sent.");
        }
        return { kind: "ready" as const, identity };
      }
      const savedInput = replayableSavedInput(pending.fingerprint);
      if (!savedInput) throw new Error("A previous send may already have been accepted, but its original content cannot be replayed safely. Your current draft is preserved and was not sent.");
      return { kind: "reconcile" as const, candidate: { identity, ...savedInput, acceptedPreviously: false, settledPreviously: false } };
    }

    // Settled rows can be compacted only after any durable recovery marker has
    // been reconciled. This preserves a safe fresh ID for a later explicit send.
    for (const [id, mutation] of Object.entries(document.mutations)) {
      if (mutation.status === "settled") delete document.mutations[id];
    }
    if (Object.keys(document.mutations).length >= MAX_PENDING_MUTATIONS_PER_SCOPE) {
      throw new Error("This chat has too many unresolved sends to retry safely. Reconcile earlier sends before sending again.");
    }
    if (!Number.isSafeInteger(document.nextOrdinal) || document.nextOrdinal >= Number.MAX_SAFE_INTEGER) {
      throw new Error("This chat has exhausted its safe local send history. Reconcile earlier sends before sending again.");
    }
    const identity = {
      version: 1 as const,
      clientMutationId: cryptoApi.randomUUID(),
      fingerprint: mutationFingerprint,
      ordinal: document.nextOrdinal,
    };
    document.nextOrdinal += 1;
    document.mutations[identity.clientMutationId] = {
      id: identity.clientMutationId,
      fingerprint: mutationFingerprint,
      ordinal: identity.ordinal,
      pageInstanceId: currentPageId,
      status: "pending",
    };
    writeScopeDocument(scopeKey, document);
    return { kind: "ready" as const, identity };
  });

  const updateStatus = (identity: BlockedMutationIdentity, status: "unknown" | "accepted" | "recoverable" | "settled") =>
    updateStoredMutationStatus(scopeKey, identity, status);

  const createReadyResult = (
    identity: BlockedMutationIdentity,
    status: "ready" | "resume_required" | "retry_required" = "ready",
    reconciliation?: ChatSendReconciliationResult,
    recoveryBody?: string,
    recoveryModelOverride?: string | null,
    recoveryEffortOverride?: string | null,
  ): PreparedChatSendMutation => ({
    status,
    clientMutationId: identity.clientMutationId,
    reconciliation,
    recoveryBody,
    recoveryModelOverride,
    recoveryEffortOverride,
    markAccepted: () => updateStatus(identity, "accepted"),
    markUnknown: () => updateStatus(identity, "unknown"),
    markRecoverable: () => updateStatus(identity, "recoverable"),
    settle: () => updateStatus(identity, "settled"),
  });

  if (inspected.kind === "resume_required") {
    return createReadyResult(inspected.identity, "resume_required", undefined, inspected.body, inspected.modelOverride, inspected.effortOverride);
  }

  if (inspected.kind === "ready") return createReadyResult(
    inspected.identity,
    "ready",
    undefined,
    undefined,
    "modelOverride" in inspected ? inspected.modelOverride : undefined,
    "effortOverride" in inspected ? inspected.effortOverride : undefined,
  );

  const candidate = inspected.candidate;
  if (!input.reconcilePendingMutation) throw new Error("A previous send may already have been accepted, but this chat cannot reconcile it safely yet. Your current draft is preserved and was not sent.");

  let reconciliation: ChatSendReconciliationResult;
  try {
    reconciliation = await input.reconcilePendingMutation(candidate.identity.clientMutationId, candidate.body);
  } catch {
    throw new Error("Rudder could not confirm whether the previous send was accepted. Your current draft is preserved and was not sent. Retry reconciliation when the connection is available.");
  }
  if (!isValidReconciliation(reconciliation, {
    clientMutationId: candidate.identity.clientMutationId,
    orgId: input.orgId,
    conversationId: input.conversationId,
    body: candidate.body,
  })) {
    throw new Error("Rudder returned an invalid send-recovery result. Your current draft is preserved and was not sent.");
  }

  const recovered = await withScopeLock(scopeKey, () => {
    const latest = readScopeDocument(scopeKey);
    const latestBlocked = readBlockedScope(scopeKey);
    if (latestBlocked && !sameMutationIdentity(latestBlocked, candidate.identity)) {
      throw new Error("A different send is still awaiting reconciliation. Your current draft was not sent.");
    }
    const current = latest.mutations[candidate.identity.clientMutationId] ?? null;
    if (current && !sameMutationIdentity({
      clientMutationId: current.id,
      fingerprint: current.fingerprint,
      ordinal: current.ordinal ?? 0,
    }, candidate.identity)) {
      throw new Error("The saved send changed while it was being reconciled. Your current draft was not sent.");
    }
    const locallySettled = isSettledOrdinal(latest, candidate.identity.ordinal);

    if (reconciliation.outcome === "accepted") {
      if (!current && !locallySettled) {
        throw new Error("The accepted send no longer has a matching local identity. Your current draft was not sent.");
      }
      if (reconciliation.outcome === "accepted" && isCoherentTerminalReceipt(reconciliation)) {
        if (current && current.status !== "settled") {
          latest.mutations[candidate.identity.clientMutationId] = { ...current, status: "settled" };
          recordSettledOrdinal(latest, candidate.identity.ordinal);
          writeScopeDocument(scopeKey, latest);
        }
        clearBlockedScope(scopeKey, candidate.identity);
        return { status: "recovered" as const };
      }
      if (candidate.settledPreviously) {
        throw new Error("Rudder returned an inconsistent recovery receipt for a locally completed send. The original identity remains paused.");
      }
      if (reconciliation.outcome === "accepted" && reconciliation.runtimeTerminal) {
        throw new Error("Rudder returned an inconsistent terminal recovery receipt. The original send remains unresolved; your draft was not sent.");
      }
      if (!current) throw new Error("The accepted send no longer has a matching recovery identity.");
      latest.mutations[candidate.identity.clientMutationId] = {
        ...current,
        pageInstanceId: currentPageId,
        status: "recoverable",
      };
      writeScopeDocument(scopeKey, latest);
      clearBlockedScope(scopeKey, candidate.identity);
      return { status: input.resumeClientMutationId === candidate.identity.clientMutationId
        ? "ready" as const
        : "resume_required" as const };
    }

    if (!current || locallySettled || current.status === "settled") {
      throw new Error("Rudder could not confirm a locally settled send. Your current draft was not sent.");
    }
    if (candidate.acceptedPreviously || current.status === "accepted" || current.status === "recoverable") {
      throw new Error("Rudder could not find a message that this browser previously recorded as accepted. The original send remains paused; your current draft was not sent.");
    }
    if (candidate.settledPreviously) {
      throw new Error("Rudder could not confirm the terminal state of a locally completed send. The original identity remains paused; your current draft was not sent.");
    }
    latest.mutations[candidate.identity.clientMutationId] = {
      ...current,
      pageInstanceId: currentPageId,
      status: "pending",
    };
    writeScopeDocument(scopeKey, latest);
    clearBlockedScope(scopeKey, candidate.identity);
    // Reconciliation proves only that the earlier ID is not currently
    // admitted. Require a separate user action before replaying it.
    return { status: "retry_required" as const };
  });

  if (recovered.status === "recovered") {
    return {
      status: "recovered",
      clientMutationId: candidate.identity.clientMutationId,
      reconciliation,
      markUnknown: async () => undefined,
      markAccepted: async () => undefined,
      markRecoverable: async () => undefined,
      settle: async () => undefined,
    };
  }
  if (recovered.status === "resume_required") {
    return createReadyResult(candidate.identity, "resume_required", reconciliation, candidate.body, candidate.modelOverride, candidate.effortOverride);
  }
  if (recovered.status === "retry_required") {
    return createReadyResult(candidate.identity, "retry_required", reconciliation, candidate.body, candidate.modelOverride, candidate.effortOverride);
  }
  return createReadyResult(candidate.identity, "ready", undefined, undefined,
    input.resumeClientMutationId === candidate.identity.clientMutationId ? candidate.modelOverride : undefined,
    input.resumeClientMutationId === candidate.identity.clientMutationId ? candidate.effortOverride : undefined);
}
