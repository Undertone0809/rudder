import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  nativeFirstSendDraftMatches,
  prepareNativeFirstSendIntent,
  readNativeFirstSendIntent,
  updateNativeFirstSendIntent,
  type NativeFirstSendDraft,
} from "./native-chat-first-send-storage";

const draft: NativeFirstSendDraft = {
  body: "Keep this first message",
  preferredAgentId: "agent-1",
  title: "A draft title",
  issueCreationMode: "manual_approval",
  modelOverride: "openai/gpt-test",
  effortOverride: "high",
};

function createStorageMock() {
  const values = new Map<string, string>();
  const getItem = vi.fn((key: string) => values.get(key) ?? null);
  const setItem = vi.fn((key: string, value: string) => {
    values.set(key, value);
  });
  const storage = {
    getItem,
    setItem,
    removeItem: vi.fn((key: string) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() { return values.size; },
  } as unknown as Storage;
  return { storage, values, getItem, setItem };
}

function createSerializedLocks(): LockManager {
  let tail = Promise.resolve();
  return {
    request: async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock) => unknown | Promise<unknown>,
    ) => {
      const before = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => { release = resolve; });
      await before;
      try {
        return await callback({ name: _name, mode: "exclusive" } as Lock);
      } finally {
        release();
      }
    },
  } as LockManager;
}

function scopeStorageKey(orgId: string, userId: string): string {
  return `rudder:native-chat-first-send:v1:scope:${encodeURIComponent(`${orgId}:${userId}`)}`;
}

let nextMutationId = 0;

beforeEach(() => {
  nextMutationId = 0;
  vi.stubGlobal("localStorage", createStorageMock().storage);
  vi.stubGlobal("navigator", { locks: createSerializedLocks() });
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => `mutation-${++nextMutationId}`) });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native first-send draft identity", () => {
  it("matches parsed drafts when the transport adds an id and object key order changes", () => {
    const request = {
      clientMutationId: "mutation-1",
      ...draft,
    };
    const parsed = JSON.parse(JSON.stringify({
      effortOverride: draft.effortOverride,
      modelOverride: draft.modelOverride,
      issueCreationMode: draft.issueCreationMode,
      title: draft.title,
      preferredAgentId: draft.preferredAgentId,
      body: draft.body,
    })) as NativeFirstSendDraft;

    expect(nativeFirstSendDraftMatches(draft, request)).toBe(true);
    expect(nativeFirstSendDraftMatches(draft, parsed)).toBe(true);
  });

  it("does not match a changed body or user-selected choice", () => {
    expect(nativeFirstSendDraftMatches(draft, { ...draft, body: "Changed message" })).toBe(false);
    expect(nativeFirstSendDraftMatches(draft, { ...draft, preferredAgentId: "agent-2" })).toBe(false);
    expect(nativeFirstSendDraftMatches(draft, { ...draft, modelOverride: "openai/other" })).toBe(false);
    expect(nativeFirstSendDraftMatches(draft, { ...draft, effortOverride: "low" })).toBe(false);
    expect(nativeFirstSendDraftMatches(draft, { ...draft, issueCreationMode: "auto_create" })).toBe(false);
    expect(nativeFirstSendDraftMatches(draft, { ...draft, title: "Other title" })).toBe(false);
  });

  it("keeps a pending or unknown identity and its exact payload instead of replacing it", async () => {
    const first = await prepareNativeFirstSendIntent("org-1", "user-1", draft);
    expect(first.created).toBe(true);
    await updateNativeFirstSendIntent("org-1", "user-1", first.intent.clientMutationId, "unknown");

    const retry = await prepareNativeFirstSendIntent("org-1", "user-1", { ...draft, body: "A newer draft" });

    expect(retry.created).toBe(false);
    expect(retry.intent.clientMutationId).toBe(first.intent.clientMutationId);
    expect(retry.intent.status).toBe("unknown");
    expect(retry.intent.draft).toEqual(draft);
    expect(readNativeFirstSendIntent("org-1", "user-1")).toEqual(retry.intent);
  });

  it("isolates the saved identity by both organization and creator", async () => {
    const orgOneUserOne = await prepareNativeFirstSendIntent("org-1", "user-1", draft);
    const orgOneUserTwo = await prepareNativeFirstSendIntent("org-1", "user-2", draft);
    const orgTwoUserOne = await prepareNativeFirstSendIntent("org-2", "user-1", draft);

    expect(orgOneUserOne.intent.clientMutationId).not.toBe(orgOneUserTwo.intent.clientMutationId);
    expect(orgOneUserOne.intent.clientMutationId).not.toBe(orgTwoUserOne.intent.clientMutationId);
    expect(readNativeFirstSendIntent("org-1", "user-1")?.clientMutationId).toBe(orgOneUserOne.intent.clientMutationId);
    expect(readNativeFirstSendIntent("org-1", "user-2")?.clientMutationId).toBe(orgOneUserTwo.intent.clientMutationId);
    expect(readNativeFirstSendIntent("org-2", "user-1")?.clientMutationId).toBe(orgTwoUserOne.intent.clientMutationId);
  });

  it("serializes concurrent tabs to one first-message identity", async () => {
    const [first, second] = await Promise.all([
      prepareNativeFirstSendIntent("org-1", "user-1", draft),
      prepareNativeFirstSendIntent("org-1", "user-1", draft),
    ]);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(first.intent.clientMutationId).toBe(second.intent.clientMutationId);
    expect(readNativeFirstSendIntent("org-1", "user-1")?.clientMutationId).toBe(first.intent.clientMutationId);
  });

  it("allows an explicit not-found retry without changing the mutation id or payload", async () => {
    const first = await prepareNativeFirstSendIntent("org-1", "user-1", draft);
    await updateNativeFirstSendIntent("org-1", "user-1", first.intent.clientMutationId, "not_found");
    const retried = await updateNativeFirstSendIntent("org-1", "user-1", first.intent.clientMutationId, "pending");

    expect(retried.status).toBe("pending");
    expect(retried.clientMutationId).toBe(first.intent.clientMutationId);
    expect(retried.draft).toEqual(draft);
  });

  it("does not allow late unknown or not-found results to downgrade accepted or settled state", async () => {
    const first = await prepareNativeFirstSendIntent("org-1", "user-1", draft);
    const accepted = await updateNativeFirstSendIntent(
      "org-1",
      "user-1",
      first.intent.clientMutationId,
      "accepted",
      "chat-1",
    );

    await expect(updateNativeFirstSendIntent("org-1", "user-1", first.intent.clientMutationId, "unknown"))
      .rejects.toThrow("recovery state changed");
    const settled = await updateNativeFirstSendIntent(
      "org-1",
      "user-1",
      first.intent.clientMutationId,
      "settled",
      "chat-1",
    );
    await expect(updateNativeFirstSendIntent("org-1", "user-1", first.intent.clientMutationId, "not_found"))
      .rejects.toThrow("recovery state changed");

    expect(accepted.conversationId).toBe("chat-1");
    expect(settled.status).toBe("settled");
    expect(readNativeFirstSendIntent("org-1", "user-1")?.status).toBe("settled");
  });

  it("fails closed on corrupt saved state instead of replacing its identity", async () => {
    const storage = createStorageMock();
    vi.stubGlobal("localStorage", storage.storage);
    storage.setItem(scopeStorageKey("org-1", "user-1"), "{broken");

    expect(() => readNativeFirstSendIntent("org-1", "user-1")).toThrow("unreadable");
    await expect(prepareNativeFirstSendIntent("org-1", "user-1", draft)).rejects.toThrow("unreadable");
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("fails closed when storage cannot write or confirm the saved identity", async () => {
    const writeFailure = createStorageMock();
    writeFailure.setItem.mockImplementation(() => { throw new Error("quota exceeded"); });
    vi.stubGlobal("localStorage", writeFailure.storage);
    await expect(prepareNativeFirstSendIntent("org-1", "user-1", draft)).rejects.toThrow("quota exceeded");

    const readbackFailure = createStorageMock();
    readbackFailure.getItem.mockImplementation(() => null);
    vi.stubGlobal("localStorage", readbackFailure.storage);
    await expect(prepareNativeFirstSendIntent("org-1", "user-1", draft)).rejects.toThrow("could not confirm");
  });
});
