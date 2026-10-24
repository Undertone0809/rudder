// @vitest-environment jsdom

import type { NativeChatCapabilities, NativeFirstSendReconciliation } from "@/api/chats";
import {
  capturePendingChatSendMutationIdentity,
  readPendingChatSendMutation,
  settlePendingChatSendMutationIdentity,
} from "@/lib/chat-send-mutation-storage";
import {
  prepareNativeFirstSendIntent,
  readNativeFirstSendIntent,
  type NativeFirstSendDraft,
} from "@/lib/native-chat-first-send-storage";
import type { ChatConversation, ChatMessage } from "@rudderhq/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeFirstSendRecovery } from "./useNativeFirstSendRecovery";

const api = vi.hoisted(() => ({
  getNativeChatCapabilities: vi.fn(),
  reconcileNativeFirstSend: vi.fn(),
  sendFirstMessageStream: vi.fn(),
  sendMessageStream: vi.fn(),
}));

vi.mock("@/api/chats", () => ({ chatsApi: api }));

const firstDraft: NativeFirstSendDraft = {
  body: "Preserve the exact first message",
  preferredAgentId: "agent-1",
  title: "First conversation",
  issueCreationMode: "manual_approval",
  modelOverride: "provider/model-a",
  effortOverride: "high",
};

const nativeCapabilities: NativeChatCapabilities = {
  executionAuthority: "native_rust",
  firstSend: true,
  readTurn: true,
  nativeControls: true,
};

function createStorageMock() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as Storage;
}

function createLockManager(): LockManager {
  return {
    request: async (
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock) => unknown | Promise<unknown>,
    ) => callback({} as Lock),
  } as LockManager;
}

function acceptedReceipt(clientMutationId: string): Extract<NativeFirstSendReconciliation, { outcome: "accepted" }> {
  return {
    outcome: "accepted",
    clientMutationId,
    conversation: { id: "chat-1" } as ChatConversation,
    message: { id: "message-1", body: firstDraft.body } as ChatMessage,
    generationId: "generation-1",
    runId: "run-1",
    attemptEpoch: 1,
    generationSeq: 0,
    bodyHash: "a".repeat(64),
    generationStatus: "running",
    runStatus: "running",
    runtimeTerminal: false,
  } as Extract<NativeFirstSendReconciliation, { outcome: "accepted" }>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type HookValue = ReturnType<typeof useNativeFirstSendRecovery>;

function RecoveryHarness({
  orgId,
  userId,
  enabled = true,
  children,
}: {
  orgId: string | null;
  userId: string | null;
  enabled?: boolean;
  children?: ReactNode;
}) {
  currentHook = useNativeFirstSendRecovery(orgId, userId, enabled);
  return <>{children}</>;
}

let currentHook: HookValue;
let roots: Root[] = [];

function mount(orgId: string | null, userId: string | null, enabled = true) {
  const element = document.createElement("div");
  const root = createRoot(element);
  roots.push(root);
  const render = (nextOrgId: string | null, nextUserId: string | null, nextEnabled = true) => {
    root.render(<RecoveryHarness orgId={nextOrgId} userId={nextUserId} enabled={nextEnabled} />);
  };
  act(() => render(orgId, userId, enabled));
  return {
    get current() { return currentHook; },
    rerender: async (nextOrgId: string | null, nextUserId: string | null, nextEnabled = true) => {
      await act(async () => {
        render(nextOrgId, nextUserId, nextEnabled);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    flush: async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    },
    unmount: () => act(() => root.unmount()),
  };
}

async function savePending(orgId: string, userId: string) {
  return prepareNativeFirstSendIntent(orgId, userId, firstDraft);
}

beforeEach(() => {
  roots = [];
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("navigator", { locks: createLockManager() });
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "mutation-hook-test") });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.getNativeChatCapabilities.mockReset();
  api.reconcileNativeFirstSend.mockReset();
  api.sendFirstMessageStream.mockReset();
  api.sendMessageStream.mockReset();
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  vi.unstubAllGlobals();
});

describe("useNativeFirstSendRecovery", () => {
  it("keeps a normal first send in flight without exposing blocked recovery, then offers recovery only on failure", async () => {
    api.getNativeChatCapabilities.mockResolvedValue(nativeCapabilities);
    const hook = mount("org-1", "user-1");
    await hook.flush();

    let input: Awaited<ReturnType<typeof hook.current.prepare>> = null;
    await act(async () => { input = await hook.current.prepare(firstDraft); });
    expect(hook.current.recovery).toEqual({ kind: "sending" });
    expect(readNativeFirstSendIntent("org-1", "user-1")).toMatchObject({
      status: "pending", draft: firstDraft, clientMutationId: input!.clientMutationId,
    });
    await expect(hook.current.prepare(firstDraft)).rejects.toThrow("previous first message");

    await act(async () => { await hook.current.markUnknown(input!.clientMutationId); });
    expect(hook.current.recovery).toMatchObject({ kind: "blocked" });
    expect(readNativeFirstSendIntent("org-1", "user-1")?.status).toBe("unknown");
  });
  it("reconciles an accepted receipt, then settles only when the user opens it", async () => {
    const saved = await savePending("org-1", "user-1");
    api.getNativeChatCapabilities.mockResolvedValue(nativeCapabilities);
    api.reconcileNativeFirstSend.mockResolvedValue(acceptedReceipt(saved.intent.clientMutationId));
    const hook = mount("org-1", "user-1");
    await hook.flush();

    expect(hook.current.recovery.kind).toBe("accepted");
    expect(readNativeFirstSendIntent("org-1", "user-1")).toMatchObject({
      clientMutationId: saved.intent.clientMutationId,
      status: "accepted",
      draft: firstDraft,
      conversationId: "chat-1",
    });
    expect(readPendingChatSendMutation("org-1", "chat-1")).toMatchObject({
      id: saved.intent.clientMutationId,
      status: "accepted",
    });
    expect(api.sendFirstMessageStream).not.toHaveBeenCalled();
    expect(api.sendMessageStream).not.toHaveBeenCalled();

    await act(async () => { await hook.current.openAccepted(); });
    expect(readNativeFirstSendIntent("org-1", "user-1")?.status).toBe("settled");
  });

  it("hands off the acknowledged ID before releasing New Chat and lets Stop settle it after a newer first send", async () => {
    const saved = await savePending("org-1", "user-1");
    api.getNativeChatCapabilities.mockResolvedValue(nativeCapabilities);
    api.reconcileNativeFirstSend.mockResolvedValue({
      outcome: "not_found",
      clientMutationId: saved.intent.clientMutationId,
    } satisfies NativeFirstSendReconciliation);
    const hook = mount("org-1", "user-1");
    await hook.flush();

    expect(hook.current.recovery.kind).toBe("not_found");
    let acceptedIdentity: Awaited<ReturnType<typeof hook.current.markAccepted>> | undefined;
    await act(async () => {
      acceptedIdentity = await hook.current.markAccepted(saved.intent.clientMutationId, "chat-1");
    });
    expect(hook.current.recovery).toEqual({ kind: "sending" });
    expect(readPendingChatSendMutation("org-1", "chat-1")).toMatchObject({
      id: saved.intent.clientMutationId,
      status: "accepted",
      fingerprint: JSON.stringify({
        body: firstDraft.body,
        editUserMessageId: null,
        files: [],
        inlineAnnotations: [],
        modelOverride: firstDraft.modelOverride,
        effortOverride: firstDraft.effortOverride,
      }),
    });

    await act(async () => {
      await hook.current.markSettled(saved.intent.clientMutationId, "chat-1");
    });
    expect(readNativeFirstSendIntent("org-1", "user-1")).toMatchObject({
      clientMutationId: saved.intent.clientMutationId,
      status: "settled",
      conversationId: "chat-1",
    });

    vi.mocked(crypto.randomUUID).mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
    let next: unknown;
    await act(async () => {
      next = await hook.current.prepare({
        ...firstDraft,
        body: "A separate new conversation",
      });
    });
    expect(next).toMatchObject({
      clientMutationId: "00000000-0000-4000-8000-000000000002",
      body: "A separate new conversation",
    });
    expect(readNativeFirstSendIntent("org-1", "user-1")).toMatchObject({
      clientMutationId: "00000000-0000-4000-8000-000000000002",
      status: "pending",
    });

    // A late terminal event for the first chat only owns its per-chat ledger;
    // it must not settle the newly allocated global first-send intent.
    await act(async () => {
      await hook.current.markSettled(saved.intent.clientMutationId, "chat-1");
    });
    expect(readNativeFirstSendIntent("org-1", "user-1")).toMatchObject({
      clientMutationId: "00000000-0000-4000-8000-000000000002",
      status: "pending",
    });

    const stopIdentity = await capturePendingChatSendMutationIdentity({
      orgId: "org-1",
      conversationId: "chat-1",
      body: firstDraft.body,
    });
    expect(stopIdentity).toEqual(acceptedIdentity);
    expect(await settlePendingChatSendMutationIdentity({
      orgId: "org-1",
      conversationId: "chat-1",
      identity: stopIdentity!,
    })).toBe(true);
    expect(readPendingChatSendMutation("org-1", "chat-1")?.status).toBe("settled");
    expect(readNativeFirstSendIntent("org-1", "user-1")).toMatchObject({
      clientMutationId: "00000000-0000-4000-8000-000000000002",
      status: "pending",
    });
    expect(api.sendFirstMessageStream).not.toHaveBeenCalled();
    expect(api.sendMessageStream).not.toHaveBeenCalled();
  });

  it("exposes not-found and explicit retry returns the exact saved payload without dispatch", async () => {
    const saved = await savePending("org-1", "user-1");
    api.getNativeChatCapabilities.mockResolvedValue(nativeCapabilities);
    api.reconcileNativeFirstSend.mockResolvedValue({
      outcome: "not_found",
      clientMutationId: saved.intent.clientMutationId,
    } satisfies NativeFirstSendReconciliation);
    const hook = mount("org-1", "user-1");
    await hook.flush();

    expect(hook.current.recovery.kind).toBe("not_found");
    expect(readNativeFirstSendIntent("org-1", "user-1")?.status).toBe("not_found");
    let retryInput: unknown;
    await act(async () => { retryInput = await hook.current.retryOriginal(); });
    expect(hook.current.recovery).toEqual({ kind: "sending" });
    expect(retryInput).toEqual({ ...firstDraft, clientMutationId: saved.intent.clientMutationId });
    expect(readNativeFirstSendIntent("org-1", "user-1")).toMatchObject({
      status: "pending",
      clientMutationId: saved.intent.clientMutationId,
      draft: firstDraft,
    });
    expect(api.reconcileNativeFirstSend).toHaveBeenCalledTimes(1);
    expect(api.sendFirstMessageStream).not.toHaveBeenCalled();
  });

  it("keeps an unknown first send blocked after reconciliation failure", async () => {
    const saved = await savePending("org-1", "user-1");
    api.getNativeChatCapabilities.mockResolvedValue(nativeCapabilities);
    api.reconcileNativeFirstSend.mockRejectedValue(new Error("server offline"));
    const hook = mount("org-1", "user-1");
    await hook.flush();

    expect(hook.current.recovery.kind).toBe("blocked");
    expect(readNativeFirstSendIntent("org-1", "user-1")).toMatchObject({
      status: "unknown",
      clientMutationId: saved.intent.clientMutationId,
      draft: firstDraft,
    });
    await expect(hook.current.prepare(firstDraft)).rejects.toThrow();
    expect(api.sendFirstMessageStream).not.toHaveBeenCalled();
    expect(api.sendMessageStream).not.toHaveBeenCalled();
  });

  it("does not fall back when a saved Native identity sees capability 404", async () => {
    const saved = await savePending("org-1", "user-1");
    api.getNativeChatCapabilities.mockResolvedValue(null);
    const hook = mount("org-1", "user-1");
    await hook.flush();

    expect(hook.current.recovery.kind).toBe("blocked");
    expect(readNativeFirstSendIntent("org-1", "user-1")).toMatchObject({
      status: "pending",
      clientMutationId: saved.intent.clientMutationId,
      draft: firstDraft,
    });
    await expect(hook.current.prepare(firstDraft)).rejects.toThrow("previous first message");
    expect(api.reconcileNativeFirstSend).not.toHaveBeenCalled();
    expect(api.sendFirstMessageStream).not.toHaveBeenCalled();
    expect(api.sendMessageStream).not.toHaveBeenCalled();
  });

  it("fails closed on capability service errors while an identity is unresolved", async () => {
    const saved = await savePending("org-1", "user-1");
    api.getNativeChatCapabilities.mockRejectedValue(new Error("server offline"));
    const hook = mount("org-1", "user-1");
    await hook.flush();

    expect(hook.current.capabilityState).toBe("error");
    expect(hook.current.recovery.kind).toBe("blocked");
    expect(readNativeFirstSendIntent("org-1", "user-1")).toMatchObject({
      status: "unknown",
      clientMutationId: saved.intent.clientMutationId,
      draft: firstDraft,
    });
    await act(async () => {
      await expect(hook.current.prepare(firstDraft)).rejects.toThrow("server offline");
    });
    expect(api.sendFirstMessageStream).not.toHaveBeenCalled();
    expect(api.sendMessageStream).not.toHaveBeenCalled();
  });

  it("keeps the ordinary legacy first-send path available when no Native intent exists and capability is absent", async () => {
    api.getNativeChatCapabilities.mockResolvedValue(null);
    const hook = mount("org-1", "user-1");
    await hook.flush();

    expect(hook.current.capabilityState).toBe("ready");
    expect(hook.current.capabilities).toBeNull();
    expect(hook.current.recovery.kind).toBe("idle");
    await expect(hook.current.prepare(firstDraft)).resolves.toBeNull();
    expect(readNativeFirstSendIntent("org-1", "user-1")).toBeNull();
  });

  it("discards an old organization response without blocking the new scope", async () => {
    const orgOne = await savePending("org-1", "user-1");
    const orgTwo = await savePending("org-2", "user-1");
    const oldResponse = deferred<NativeFirstSendReconciliation>();
    const newResponse = deferred<NativeFirstSendReconciliation>();
    api.getNativeChatCapabilities.mockResolvedValue(nativeCapabilities);
    api.reconcileNativeFirstSend.mockImplementation((orgId: string) => (
      orgId === "org-1" ? oldResponse.promise : newResponse.promise
    ));
    const hook = mount("org-1", "user-1");
    await hook.flush();
    expect(api.reconcileNativeFirstSend).toHaveBeenCalledTimes(1);

    await hook.rerender("org-2", "user-1");
    expect(api.getNativeChatCapabilities).toHaveBeenCalledTimes(2);
    expect(api.reconcileNativeFirstSend).toHaveBeenCalledTimes(2);

    await act(async () => { oldResponse.resolve(acceptedReceipt(orgOne.intent.clientMutationId)); });
    await hook.flush();
    expect(readNativeFirstSendIntent("org-1", "user-1")?.status).toBe("pending");
    expect(readNativeFirstSendIntent("org-2", "user-1")?.clientMutationId).toBe(orgTwo.intent.clientMutationId);
    expect(hook.current.recovery.kind).toBe("checking");

    await act(async () => {
      newResponse.resolve({ outcome: "not_found", clientMutationId: orgTwo.intent.clientMutationId });
    });
    await hook.flush();
    expect(readNativeFirstSendIntent("org-1", "user-1")?.status).toBe("pending");
    expect(readNativeFirstSendIntent("org-2", "user-1")?.status).toBe("not_found");
    expect(hook.current.recovery.kind).toBe("not_found");
    expect(api.sendFirstMessageStream).not.toHaveBeenCalled();
  });
});
