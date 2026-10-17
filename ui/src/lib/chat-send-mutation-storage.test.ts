// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  capturePendingChatSendMutationIdentity,
  preparePendingChatSendMutation,
  readPendingChatSendMutation,
  recoverPendingChatSendMutation,
  settlePendingChatSendMutationIdentity,
  type ChatSendReconciliationResult,
} from "./chat-send-mutation-storage";

function installCryptoStub() {
  let nextId = 0;
  const digest = vi.fn(async (_algorithm: AlgorithmIdentifier, input: BufferSource) => {
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input as ArrayBuffer);
    const output = new Uint8Array(32);
    output.set(bytes.subarray(0, output.length));
    return output.buffer;
  });
  vi.stubGlobal("crypto", {
    randomUUID: vi.fn(() => `mutation-${++nextId}`),
    subtle: { digest },
  } as unknown as Crypto);
}

function installLocksStub() {
  const queues = new Map<string, Promise<void>>();
  const locks = {
    request: async <T>(name: string, _options: LockOptions, callback: (lock: Lock) => T | Promise<T>) => {
      const previous = queues.get(name) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      queues.set(name, previous.then(() => gate));
      await previous;
      try {
        return await callback({ name, mode: "exclusive" } as Lock);
      } finally {
        release();
      }
    },
  } as LockManager;
  const navigatorStub = Object.create(globalThis.navigator) as Navigator;
  Object.defineProperty(navigatorStub, "locks", { configurable: true, value: locks });
  vi.stubGlobal("navigator", navigatorStub);
}

function file(name: string, contents: string, type = "text/plain") {
  const bytes = new TextEncoder().encode(contents);
  return {
    name,
    size: bytes.byteLength,
    type,
    arrayBuffer: async () => bytes.slice().buffer,
  } as File;
}

function scopeDocumentFor(orgId: string, conversationId: string) {
  const prefix = "rudder:chat-send-mutations:v2:scope:";
  const key = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .find((candidate) => candidate?.startsWith(prefix)
      && candidate.endsWith(encodeURIComponent(`${orgId}:${conversationId}:new`)));
  if (!key) throw new Error("Expected persisted scope document");
  return { key, document: JSON.parse(localStorage.getItem(key)!) as {
    version: number;
    nextOrdinal: number;
    settledThrough: number;
    settledRanges: Array<{ start: number; end: number }>;
    mutations: Record<string, { id: string; fingerprint: string; ordinal?: number; status?: string; pageInstanceId?: string }>;
  } };
}

function blockedMarkerFor(orgId: string, conversationId: string) {
  const raw = localStorage.getItem(`rudder:chat-send-mutations:v2:blocked:${encodeURIComponent(
    `${orgId}:${conversationId}:new`,
  )}`);
  return raw ? JSON.parse(raw) as { version: number; clientMutationId: string; fingerprint: string; ordinal: number } : null;
}

function acceptedReceipt(clientMutationId: string, input: { orgId: string; conversationId: string; body: string }, runtimeTerminal = false): Extract<ChatSendReconciliationResult, { outcome: "accepted" }> {
  return {
    outcome: "accepted" as const,
    clientMutationId,
    message: {
      id: `message-${clientMutationId}`,
      orgId: input.orgId,
      conversationId: input.conversationId,
      role: "user" as const,
      kind: "message" as const,
      status: "completed" as const,
      body: input.body,
      runId: "run-1",
      structuredPayload: null,
      approvalId: null,
      approval: null,
      attachments: [],
      replyingAgentId: null,
      chatTurnId: null,
      turnVariant: 0,
      supersededAt: null,
      createdAt: new Date("2026-10-17T00:00:00.000Z"),
      updatedAt: new Date("2026-10-17T00:00:00.000Z"),
    },
    generationId: "generation-1",
    runId: "run-1",
    attemptEpoch: 1,
    generationSeq: 0 as const,
    bodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    generationStatus: runtimeTerminal ? "completed" : "running",
    runStatus: runtimeTerminal ? "succeeded" : "running",
    runtimeTerminal,
  };
}

describe("chat send mutation storage", () => {
  beforeEach(() => {
    localStorage.clear();
    installLocksStub();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("survives a composer remount and retires only the acknowledged identity", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-1",
      conversationId: "chat-1",
      body: "same logical send",
      files: [],
      inlineAnnotations: [],
    } as const;
    const first = await preparePendingChatSendMutation(input);
    const remounted = await preparePendingChatSendMutation(input);

    expect(remounted.clientMutationId).toBe(first.clientMutationId);
    expect(readPendingChatSendMutation(input.orgId, input.conversationId)?.id).toBe(first.clientMutationId);

    await first.settle();
    expect(readPendingChatSendMutation(input.orgId, input.conversationId)?.status).toBe("settled");

    const intentionalRepeat = await preparePendingChatSendMutation(input);
    expect(intentionalRepeat.clientMutationId).not.toBe(first.clientMutationId);
    expect(readPendingChatSendMutation(input.orgId, input.conversationId)).toMatchObject({
      id: intentionalRepeat.clientMutationId,
      status: "pending",
    });
  });

  it("settles only a captured mutation ID, fingerprint, scope, and ordinal", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-stop-settle",
      conversationId: "chat-stop-settle",
      body: "The exact acknowledged input",
      files: [],
      inlineAnnotations: [],
    } as const;
    const prepared = await preparePendingChatSendMutation(input);
    await prepared.markAccepted();

    const captured = await capturePendingChatSendMutationIdentity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      body: input.body,
    });
    expect(captured).toEqual({
      clientMutationId: prepared.clientMutationId,
      fingerprint: expect.any(String),
      ordinal: 1,
      editUserMessageId: null,
    });

    expect(await settlePendingChatSendMutationIdentity({
      orgId: "org-other",
      conversationId: input.conversationId,
      identity: captured!,
    })).toBe(false);
    expect(await settlePendingChatSendMutationIdentity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      identity: { ...captured!, clientMutationId: "different-id" },
    })).toBe(false);
    expect(readPendingChatSendMutation(input.orgId, input.conversationId)?.status).toBe("accepted");

    expect(await settlePendingChatSendMutationIdentity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      identity: captured!,
    })).toBe(true);
    expect(readPendingChatSendMutation(input.orgId, input.conversationId)?.status).toBe("settled");
    expect(await settlePendingChatSendMutationIdentity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      identity: captured!,
    })).toBe(true);

    const later = await preparePendingChatSendMutation(input);
    expect(later.clientMutationId).not.toBe(captured?.clientMutationId);
  });

  it("does not capture a different body or ambiguous unresolved mutation", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-stop-capture",
      conversationId: "chat-stop-capture",
      body: "First input",
      files: [],
      inlineAnnotations: [],
    } as const;
    await preparePendingChatSendMutation(input);
    expect(await capturePendingChatSendMutationIdentity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      body: "New composer text",
    })).toBeNull();

    const { key, document } = scopeDocumentFor(input.orgId, input.conversationId);
    const second = {
      id: "mutation-ambiguous",
      fingerprint: JSON.stringify({
        body: "Second input",
        editUserMessageId: null,
        files: [],
        inlineAnnotations: [],
        modelOverride: null,
        effortOverride: null,
      }),
      ordinal: 2,
      status: "accepted",
    };
    document.nextOrdinal = 3;
    document.mutations[second.id] = second;
    localStorage.setItem(key, JSON.stringify(document));
    expect(await capturePendingChatSendMutationIdentity({
      orgId: input.orgId,
      conversationId: input.conversationId,
      body: input.body,
    })).toBeNull();
  });

  it("reconciles an accepted nonterminal send but only replays it after an explicit resume", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-reconcile-active",
      conversationId: "chat-reconcile-active",
      body: "Resume this exact response",
      files: [],
      inlineAnnotations: [],
    } as const;
    const firstPage = await preparePendingChatSendMutation(input);
    await firstPage.markAccepted();
    await firstPage.markRecoverable();

    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    const reconcilePendingMutation = vi.fn(async (clientMutationId: string) => acceptedReceipt(clientMutationId, input));
    const reconciling = await reloadedStorage.preparePendingChatSendMutation({
      ...input,
      reconcilePendingMutation,
    });

    expect(reconciling.clientMutationId).toBe(firstPage.clientMutationId);
    expect(reconciling.status).toBe("resume_required");
    expect(reconciling.reconciliation?.outcome).toBe("accepted");
    expect(reconcilePendingMutation).toHaveBeenCalledWith(firstPage.clientMutationId, input.body);

    const resumed = await reloadedStorage.preparePendingChatSendMutation({
      ...input,
      resumeClientMutationId: firstPage.clientMutationId,
      reconcilePendingMutation,
    });
    expect(resumed.status).toBe("ready");
    expect(resumed.clientMutationId).toBe(firstPage.clientMutationId);
    expect(reconcilePendingMutation).toHaveBeenCalledTimes(1);
  });

  it("settles a terminal accepted receipt without replay and gives a later explicit send a fresh ID", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-reconcile-terminal",
      conversationId: "chat-reconcile-terminal",
      body: "Already completed response",
      files: [],
      inlineAnnotations: [],
    } as const;
    const firstPage = await preparePendingChatSendMutation(input);
    await firstPage.markAccepted();

    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    const terminal = await reloadedStorage.preparePendingChatSendMutation({
      ...input,
      reconcilePendingMutation: async (clientMutationId) => acceptedReceipt(clientMutationId, input, true),
    });

    expect(terminal.status).toBe("recovered");
    expect(terminal.clientMutationId).toBe(firstPage.clientMutationId);
    expect(reloadedStorage.readPendingChatSendMutation(input.orgId, input.conversationId)?.status).toBe("settled");
    const intentionalRepeat = await reloadedStorage.preparePendingChatSendMutation(input);
    expect(intentionalRepeat.clientMutationId).not.toBe(firstPage.clientMutationId);
  });

  it("reuses the same identity only when reconciliation explicitly reports not found", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-reconcile-missing",
      conversationId: "chat-reconcile-missing",
      body: "This request was never admitted",
      files: [],
      inlineAnnotations: [],
      modelOverride: "gpt-5.6-terra",
      effortOverride: "xhigh",
    } as const;
    const firstPage = await preparePendingChatSendMutation(input);
    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    const retry = await reloadedStorage.preparePendingChatSendMutation({
      ...input,
      reconcilePendingMutation: async (clientMutationId) => ({ outcome: "not_found", clientMutationId }),
    });
    expect(retry.status).toBe("retry_required");
    expect(retry.clientMutationId).toBe(firstPage.clientMutationId);
    const explicitRetry = await reloadedStorage.preparePendingChatSendMutation({
      ...input,
      resumeClientMutationId: firstPage.clientMutationId,
      modelOverride: null,
      effortOverride: null,
    });
    expect(explicitRetry.status).toBe("ready");
    expect(explicitRetry.clientMutationId).toBe(firstPage.clientMutationId);
    expect(explicitRetry.recoveryModelOverride).toBe("gpt-5.6-terra");
    expect(explicitRetry.recoveryEffortOverride).toBe("xhigh");
  });

  it("reconciles the saved body while preserving a changed composer draft", async () => {
    installCryptoStub();
    const firstInput = {
      orgId: "org-reconcile-changed",
      conversationId: "chat-reconcile-changed",
      body: "The accepted original body",
      files: [],
      inlineAnnotations: [],
    } as const;
    const firstPage = await preparePendingChatSendMutation(firstInput);
    await firstPage.markAccepted();
    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    const reconcilePendingMutation = vi.fn(async (clientMutationId: string, body: string) => acceptedReceipt(clientMutationId, {
      ...firstInput,
      body,
    }));
    const recovery = await reloadedStorage.preparePendingChatSendMutation({
      ...firstInput,
      body: "A new draft that must not replace the prior request",
      reconcilePendingMutation,
    });
    expect(reconcilePendingMutation).toHaveBeenCalledWith(firstPage.clientMutationId, "The accepted original body");
    expect(recovery.status).toBe("resume_required");
    expect(recovery.recoveryBody).toBe("The accepted original body");
    expect(recovery.clientMutationId).toBe(firstPage.clientMutationId);
  });

  it("requires an explicit retry of the saved body when the server confirms it was not admitted", async () => {
    installCryptoStub();
    const original = {
      orgId: "org-reconcile-not-found-changed",
      conversationId: "chat-reconcile-not-found-changed",
      body: "Original unsent message",
      files: [],
      inlineAnnotations: [],
    } as const;
    const firstPage = await preparePendingChatSendMutation(original);
    const firstDocument = scopeDocumentFor(original.orgId, original.conversationId);
    firstDocument.document.mutations[firstPage.clientMutationId].pageInstanceId = "previous-page";
    localStorage.setItem(firstDocument.key, JSON.stringify(firstDocument.document));

    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    const reconcilePendingMutation = vi.fn(async (clientMutationId: string) => ({
      outcome: "not_found" as const,
      clientMutationId,
    }));
    const newDraft = "Keep this different draft";
    const blocked = await reloadedStorage.preparePendingChatSendMutation({
      ...original,
      body: newDraft,
      reconcilePendingMutation,
    });

    expect(reconcilePendingMutation).toHaveBeenCalledWith(firstPage.clientMutationId, original.body);
    expect(blocked.status).toBe("retry_required");
    expect(blocked.recoveryBody).toBe(original.body);
    expect(blocked.clientMutationId).toBe(firstPage.clientMutationId);

    const explicitRetry = await reloadedStorage.preparePendingChatSendMutation({
      ...original,
      body: original.body,
      resumeClientMutationId: firstPage.clientMutationId,
    });
    expect(explicitRetry.status).toBe("ready");
    expect(explicitRetry.clientMutationId).toBe(firstPage.clientMutationId);
  });

  it("does not replay a mutation the prior page recorded as accepted when reconcile says not found", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-reconcile-contradiction",
      conversationId: "chat-reconcile-contradiction",
      body: "Already acknowledged input",
      files: [],
      inlineAnnotations: [],
    } as const;
    const accepted = await preparePendingChatSendMutation(input);
    await accepted.markAccepted();
    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    const reconcilePendingMutation = vi.fn(async (clientMutationId: string) => ({
      outcome: "not_found" as const,
      clientMutationId,
    }));

    await expect(reloadedStorage.preparePendingChatSendMutation({
      ...input,
      reconcilePendingMutation,
    })).rejects.toThrow("previously recorded as accepted");
    expect(reconcilePendingMutation).toHaveBeenCalledOnce();
  });

  it("discovers a prior-page accepted send without dispatching it", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-discovery-resume",
      conversationId: "chat-discovery-resume",
      body: "Resume this exact input",
      files: [],
      inlineAnnotations: [],
    } as const;
    const pending = await preparePendingChatSendMutation(input);
    await pending.markAccepted();
    const { key, document } = scopeDocumentFor(input.orgId, input.conversationId);
    document.mutations[pending.clientMutationId].pageInstanceId = "previous-browser-page";
    localStorage.setItem(key, JSON.stringify(document));
    const reconcile = vi.fn(async (clientMutationId: string, body: string) => acceptedReceipt(clientMutationId, {
      ...input,
      body,
    }));

    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    const discovered = await reloadedStorage.recoverPendingChatSendMutation({
      orgId: input.orgId,
      conversationId: input.conversationId,
      reconcilePendingMutation: reconcile,
    });

    expect(discovered).toMatchObject({
      status: "resume_required",
      clientMutationId: pending.clientMutationId,
      body: input.body,
      reconciliation: { outcome: "accepted", runId: "run-1" },
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(readPendingChatSendMutation(input.orgId, input.conversationId)?.id).toBe(pending.clientMutationId);
  });

  it("discovers a confirmed not-found send as explicit retry without dispatching it", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-discovery-retry",
      conversationId: "chat-discovery-retry",
      body: "Retry only after the user chooses",
      files: [],
      inlineAnnotations: [],
    } as const;
    const pending = await preparePendingChatSendMutation(input);
    const { key, document } = scopeDocumentFor(input.orgId, input.conversationId);
    document.mutations[pending.clientMutationId].pageInstanceId = "previous-browser-page";
    localStorage.setItem(key, JSON.stringify(document));
    const reconcile = vi.fn(async (clientMutationId: string) => ({ outcome: "not_found" as const, clientMutationId }));

    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    const discovered = await reloadedStorage.recoverPendingChatSendMutation({
      orgId: input.orgId,
      conversationId: input.conversationId,
      reconcilePendingMutation: reconcile,
    });

    expect(discovered).toMatchObject({
      status: "retry_required",
      clientMutationId: pending.clientMutationId,
      body: input.body,
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reloadedStorage.readPendingChatSendMutation(input.orgId, input.conversationId)).toMatchObject({
      id: pending.clientMutationId,
      status: "pending",
    });
  });

  it("does not discover same-page pending writes and aborts stale-scope reconciliation without changing storage", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-discovery-abort",
      conversationId: "chat-discovery-abort",
      body: "Still waiting on the original page",
      files: [],
      inlineAnnotations: [],
    } as const;
    const pending = await preparePendingChatSendMutation(input);
    const reconcile = vi.fn(async (clientMutationId: string) => ({ outcome: "not_found" as const, clientMutationId }));
    expect(await recoverPendingChatSendMutation({
      orgId: input.orgId,
      conversationId: input.conversationId,
      reconcilePendingMutation: reconcile,
    })).toBeNull();
    expect(reconcile).not.toHaveBeenCalled();

    await pending.markAccepted();
    const { key, document } = scopeDocumentFor(input.orgId, input.conversationId);
    document.mutations[pending.clientMutationId].pageInstanceId = "previous-browser-page";
    localStorage.setItem(key, JSON.stringify(document));
    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    const controller = new AbortController();
    let finish!: (value: ReturnType<typeof acceptedReceipt>) => void;
    const delayed = new Promise<ReturnType<typeof acceptedReceipt>>((resolve) => { finish = resolve; });
    const reloadReconcile = vi.fn(() => delayed);
    const discovery = reloadedStorage.recoverPendingChatSendMutation({
      orgId: input.orgId,
      conversationId: input.conversationId,
      signal: controller.signal,
      reconcilePendingMutation: reloadReconcile,
    });
    await vi.waitFor(() => expect(reloadReconcile).toHaveBeenCalledOnce());
    controller.abort();
    finish(acceptedReceipt(pending.clientMutationId, input));
    await expect(discovery).resolves.toBeNull();
    expect(reloadedStorage.readPendingChatSendMutation(input.orgId, input.conversationId)).toMatchObject({
      id: pending.clientMutationId,
      status: "accepted",
    });
  });

  it("reconciles a dispatched request with unknown acknowledgement before same-page replay", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-unknown-ack",
      conversationId: "chat-unknown-ack",
      body: "The request was written but its acknowledgement was lost",
      files: [],
      inlineAnnotations: [],
    } as const;
    const first = await preparePendingChatSendMutation(input);
    await first.markUnknown();
    expect(readPendingChatSendMutation(input.orgId, input.conversationId)?.status).toBe("unknown");

    const reconcile = vi.fn(async (clientMutationId: string) => ({
      outcome: "not_found" as const,
      clientMutationId,
    }));
    const retry = await preparePendingChatSendMutation({ ...input, reconcilePendingMutation: reconcile });
    expect(reconcile).toHaveBeenCalledWith(first.clientMutationId, input.body);
    expect(retry.status).toBe("retry_required");
    expect(retry.clientMutationId).toBe(first.clientMutationId);
    const explicitRetry = await preparePendingChatSendMutation({
      ...input,
      resumeClientMutationId: first.clientMutationId,
      reconcilePendingMutation: reconcile,
    });
    expect(explicitRetry.status).toBe("ready");
    expect(explicitRetry.clientMutationId).toBe(first.clientMutationId);
  });

  it("does not replay a locally terminal mutation when reconciliation says not found", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-terminal-marker",
      conversationId: "chat-terminal-marker",
      body: "This stream already reported a terminal event",
      files: [],
      inlineAnnotations: [],
    } as const;
    const terminal = await preparePendingChatSendMutation(input);
    const { key, document } = scopeDocumentFor(input.orgId, input.conversationId);
    localStorage.setItem(`rudder:chat-send-mutations:v2:blocked:${encodeURIComponent(
      `${input.orgId}:${input.conversationId}:new`,
    )}`, JSON.stringify({
      version: 1,
      clientMutationId: terminal.clientMutationId,
      fingerprint: document.mutations[terminal.clientMutationId].fingerprint,
      ordinal: 1,
      status: "settled",
    }));
    // Simulate a terminal response whose local settlement could not be confirmed.
    expect(localStorage.getItem(key)).toBeTruthy();

    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    await expect(reloadedStorage.recoverPendingChatSendMutation({
      orgId: input.orgId,
      conversationId: input.conversationId,
      reconcilePendingMutation: async (clientMutationId) => ({ outcome: "not_found", clientMutationId }),
    })).rejects.toThrow("locally completed send");
  });

  it("reuses only the exact same-page attachment fingerprint while a send is unresolved", async () => {
    installCryptoStub();
    const first = await preparePendingChatSendMutation({
      orgId: "org-1",
      conversationId: "chat-1",
      body: "Review this file",
      files: [file("notes.txt", "version one")],
      inlineAnnotations: [],
    });
    const sameBytesRetry = await preparePendingChatSendMutation({
      orgId: "org-1",
      conversationId: "chat-1",
      body: "Review this file",
      files: [file("notes.txt", "version one")],
      inlineAnnotations: [],
    });
    await expect(preparePendingChatSendMutation({
      orgId: "org-1",
      conversationId: "chat-1",
      body: "Review this file",
      files: [file("notes.txt", "version two")],
      inlineAnnotations: [],
    })).rejects.toThrow("previous send may still be in flight");

    expect(sameBytesRetry.clientMutationId).toBe(first.clientMutationId);
    const scopeRecord = scopeDocumentFor("org-1", "chat-1");
    const document = scopeRecord.document as {
      mutations: Record<string, { id: string; status?: string }>;
    };
    expect(Object.values(document.mutations).map((mutation) => mutation.id))
      .toEqual([first.clientMutationId]);
    expect(readPendingChatSendMutation("org-1", "chat-1", null)?.id).toBe(first.clientMutationId);

    await first.settle();
    const afterFirstSettlement = JSON.parse(localStorage.getItem(scopeRecord.key)!) as {
      mutations: Record<string, { id: string; status?: string }>;
    };
    expect(afterFirstSettlement.mutations[first.clientMutationId]?.status).toBe("settled");
    expect(afterFirstSettlement.mutations[first.clientMutationId]?.status).toBe("settled");
    expect(readPendingChatSendMutation("org-1", "chat-1", null)?.id).toBe(first.clientMutationId);
  });

  it("serializes concurrent same-scope first sends across tabs onto one pending identity", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-lock",
      conversationId: "chat-lock",
      body: "One logical send",
      files: [],
      inlineAnnotations: [],
    } as const;

    const [first, second] = await Promise.all([
      preparePendingChatSendMutation(input),
      preparePendingChatSendMutation(input),
    ]);

    expect(first.clientMutationId).toBe(second.clientMutationId);
  });

  it("accepts a late duplicate acknowledgement after a newer send prunes the settled row", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-late-ack",
      conversationId: "chat-late-ack",
      body: "The same request may be acknowledged by two open tabs",
      files: [],
      inlineAnnotations: [],
    } as const;
    const firstTab = await preparePendingChatSendMutation(input);
    const secondTab = await preparePendingChatSendMutation(input);
    expect(secondTab.clientMutationId).toBe(firstTab.clientMutationId);

    await firstTab.settle();
    const nextSend = await preparePendingChatSendMutation({ ...input, body: "A later intentional send" });
    expect(nextSend.clientMutationId).not.toBe(firstTab.clientMutationId);
    expect(scopeDocumentFor(input.orgId, input.conversationId).document.mutations[firstTab.clientMutationId])
      .toBeUndefined();

    // The second tab retained the original id, fingerprint and ordinal in its
    // closure. Its late acknowledgement is an idempotent no-op, not corruption.
    await secondTab.settle();
    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    const reconcileNotFound = vi.fn(async (clientMutationId: string) => ({
      outcome: "not_found" as const,
      clientMutationId,
    }));
    const retriedNextSend = await reloadedStorage.preparePendingChatSendMutation({
      ...input,
      body: "A later intentional send",
      reconcilePendingMutation: reconcileNotFound,
    });
    expect(retriedNextSend.clientMutationId).toBe(nextSend.clientMutationId);
    expect(reconcileNotFound).toHaveBeenCalledWith(nextSend.clientMutationId, "A later intentional send");
    expect(localStorage.getItem("rudder:chat-send-mutations:v2:blocked:" + encodeURIComponent(
      `${input.orgId}:${input.conversationId}:new`,
    ))).toBeNull();
  });

  it("does not treat a missing ordinal without settled proof as an acknowledgement", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-unproven-missing",
      conversationId: "chat-unproven-missing",
      body: "This identity is still unresolved",
      files: [],
      inlineAnnotations: [],
    } as const;
    const pending = await preparePendingChatSendMutation(input);
    const { key, document } = scopeDocumentFor(input.orgId, input.conversationId);
    delete document.mutations[pending.clientMutationId];
    localStorage.setItem(key, JSON.stringify(document));

    await pending.settle();

    expect(blockedMarkerFor(input.orgId, input.conversationId)).toMatchObject({
      clientMutationId: pending.clientMutationId,
      ordinal: 1,
      status: "settled",
    });
  });

  it("requires the captured ID, fingerprint and ordinal to match a retained row", async () => {
    installCryptoStub();
    const input = {
      orgId: "org-captured-identity",
      conversationId: "chat-captured-identity",
      body: "This acknowledgement belongs to one exact mutation",
      files: [],
      inlineAnnotations: [],
    } as const;
    const pending = await preparePendingChatSendMutation(input);
    const { key, document } = scopeDocumentFor(input.orgId, input.conversationId);
    document.mutations[pending.clientMutationId].fingerprint = "changed-after-dispatch";
    localStorage.setItem(key, JSON.stringify(document));

    await pending.settle();

    expect(blockedMarkerFor(input.orgId, input.conversationId)).toMatchObject({
      clientMutationId: pending.clientMutationId,
      ordinal: 1,
      status: "settled",
    });
  });

  it("keeps the compact settled floor correct across sequential sends", async () => {
    installCryptoStub();
    const base = {
      orgId: "org-range-order",
      conversationId: "chat-range-order",
      files: [],
      inlineAnnotations: [],
    } as const;
    const first = await preparePendingChatSendMutation({ ...base, body: "first" });
    await first.settle();
    const second = await preparePendingChatSendMutation({ ...base, body: "second" });
    await second.settle();
    const third = await preparePendingChatSendMutation({ ...base, body: "third" });
    expect(scopeDocumentFor(base.orgId, base.conversationId).document).toMatchObject({
      nextOrdinal: 4,
      settledThrough: 2,
      settledRanges: [],
    });

    // Pruning removes detail rows but retains proof for the completed prefix.
    await third.settle();
    expect(scopeDocumentFor(base.orgId, base.conversationId).document).toMatchObject({
      nextOrdinal: 4,
      settledThrough: 3,
      settledRanges: [],
      mutations: { [third.clientMutationId]: { status: "settled", ordinal: 3 } },
    });
  });

  it.each([
    ["negative floor", (document: ReturnType<typeof scopeDocumentFor>["document"]) => { document.settledThrough = -1; }],
    ["floor covering a pending ordinal", (document: ReturnType<typeof scopeDocumentFor>["document"]) => { document.settledThrough = 1; }],
    ["overlapping ranges", (document: ReturnType<typeof scopeDocumentFor>["document"]) => {
      document.nextOrdinal = 3;
      document.settledRanges = [{ start: 2, end: 2 }, { start: 2, end: 2 }];
    }],
    ["out-of-bounds range", (document: ReturnType<typeof scopeDocumentFor>["document"]) => {
      document.settledRanges = [{ start: 2, end: 2 }];
    }],
  ])("fails closed when a malformed settled proof has %s", async (_name, corrupt) => {
    installCryptoStub();
    const input = {
      orgId: "org-malformed-range",
      conversationId: `chat-${String(_name).replaceAll(" ", "-")}`,
      body: "An unresolved identity must not be blessed by malformed proof",
      files: [],
      inlineAnnotations: [],
    } as const;
    const pending = await preparePendingChatSendMutation(input);
    const { key, document } = scopeDocumentFor(input.orgId, input.conversationId);
    corrupt(document);
    localStorage.setItem(key, JSON.stringify(document));

    await pending.settle();

    expect(blockedMarkerFor(input.orgId, input.conversationId)).toMatchObject({
      clientMutationId: pending.clientMutationId,
      ordinal: 1,
      status: "settled",
    });
    await expect(preparePendingChatSendMutation(input)).rejects.toThrow();
  });

  it("carries an unresolved legacy identity into its isolated scope record", async () => {
    installCryptoStub();
    const scopeKey = "org-legacy:chat-legacy:new";
    const fingerprint = JSON.stringify({
      body: "legacy pending send",
      editUserMessageId: null,
      files: [],
      inlineAnnotations: [],
      modelOverride: null,
      effortOverride: null,
    });
    const legacy = {
      [scopeKey]: { id: "legacy-mutation", fingerprint },
    };
    localStorage.setItem("rudder:chat-send-mutations:v1", JSON.stringify(legacy));

    const pending = await preparePendingChatSendMutation({
      orgId: "org-legacy",
      conversationId: "chat-legacy",
      body: "legacy pending send",
      files: [],
      inlineAnnotations: [],
      reconcilePendingMutation: vi.fn(async (clientMutationId: string) => ({
        outcome: "not_found" as const,
        clientMutationId,
      })),
    });

    expect(pending.clientMutationId).toBe("legacy-mutation");
    expect(localStorage.getItem("rudder:chat-send-mutations:v1")).toBe(JSON.stringify(legacy));
    expect(readPendingChatSendMutation("org-legacy", "chat-legacy")?.id).toBe("legacy-mutation");
  });

  it("upgrades an existing v1 scope record without changing its pending ID", async () => {
    installCryptoStub();
    const scopeKey = "org-v1-scope:chat-v1-scope:new";
    const fingerprint = JSON.stringify({
      body: "upgrade this retained pending send",
      editUserMessageId: null,
      files: [],
      inlineAnnotations: [],
      modelOverride: null,
      effortOverride: null,
    });
    const storageKey = `rudder:chat-send-mutations:v2:scope:${encodeURIComponent(scopeKey)}`;
    localStorage.setItem(storageKey, JSON.stringify({
      version: 1,
      mutations: {
        "v1-mutation": { id: "v1-mutation", fingerprint },
      },
    }));

    const retry = await preparePendingChatSendMutation({
      orgId: "org-v1-scope",
      conversationId: "chat-v1-scope",
      body: "upgrade this retained pending send",
      files: [],
      inlineAnnotations: [],
      reconcilePendingMutation: vi.fn(async (clientMutationId: string) => ({
        outcome: "not_found" as const,
        clientMutationId,
      })),
    });

    expect(retry.clientMutationId).toBe("v1-mutation");
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
      version: 2,
      nextOrdinal: 2,
      settledThrough: 0,
      mutations: { "v1-mutation": { ordinal: 1, status: "pending" } },
    });
  });

  it("keeps independent scope records and a later settlement cannot clobber another pending send", async () => {
    installCryptoStub();
    const [first, second] = await Promise.all([
      preparePendingChatSendMutation({
        orgId: "org-concurrent",
        conversationId: "chat-one",
        body: "first operation",
        files: [],
        inlineAnnotations: [],
      }),
      preparePendingChatSendMutation({
        orgId: "org-concurrent",
        conversationId: "chat-two",
        body: "second operation",
        files: [],
        inlineAnnotations: [],
      }),
    ]);

    await first.settle();

    expect(readPendingChatSendMutation("org-concurrent", "chat-one")?.status).toBe("settled");
    expect(readPendingChatSendMutation("org-concurrent", "chat-two")).toMatchObject({
      id: second.clientMutationId,
      status: "pending",
    });
    expect(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key) => key?.startsWith("rudder:chat-send-mutations:v2:scope:")).length).toBe(2);
  });

  it("fails closed before preparing a send when cross-tab locking is unavailable", async () => {
    installCryptoStub();
    const navigatorStub = Object.create(globalThis.navigator) as Navigator;
    Object.defineProperty(navigatorStub, "locks", { configurable: true, value: undefined });
    vi.stubGlobal("navigator", navigatorStub);

    await expect(preparePendingChatSendMutation({
      orgId: "org-unlocked",
      conversationId: "chat-unlocked",
      body: "Do not dispatch without a lock",
      files: [],
      inlineAnnotations: [],
    })).rejects.toThrow("Cross-tab send coordination is unavailable");
    expect(localStorage.length).toBe(0);
  });

  it("persists settlement so an acknowledged ID is never reused after reload", async () => {
    installCryptoStub();
    const removeItem = vi.spyOn(localStorage, "removeItem").mockImplementation(() => {
      throw new DOMException("Removal is unavailable", "SecurityError");
    });
    const input = {
      orgId: "org-settled",
      conversationId: "chat-settled",
      body: "Send this exact message again intentionally",
      files: [],
      inlineAnnotations: [],
    } as const;

    const first = await preparePendingChatSendMutation(input);
    await first.settle();

    expect(removeItem).not.toHaveBeenCalled();
    expect(readPendingChatSendMutation(input.orgId, input.conversationId)?.status).toBe("settled");

    // Loading a fresh module instance models a page reload: only the persisted
    // tombstone, not module memory, can prevent reuse of the acknowledged key.
    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    const second = await reloadedStorage.preparePendingChatSendMutation(input);

    expect(second.clientMutationId).not.toBe(first.clientMutationId);
    expect(reloadedStorage.readPendingChatSendMutation(input.orgId, input.conversationId)?.status)
      .toBe("pending");
  });

  it("persists a per-scope fail-closed marker when tombstone readback fails", async () => {
    installCryptoStub();
    const scopePrefix = "rudder:chat-send-mutations:v2:scope:";
    const blockedPrefix = "rudder:chat-send-mutations:v2:blocked:";
    const values = new Map<string, string>();
    let forceStaleMutationReadback = false;
    let stalePendingValue: string | null = null;
    let staleScopeKey: string | null = null;
    const storage = {
      get length() { return values.size; },
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      getItem: (key: string) => {
        if (key === staleScopeKey && forceStaleMutationReadback) return stalePendingValue;
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
    } as Storage;
    vi.stubGlobal("localStorage", storage);
    const input = {
      orgId: "org-readback-failure",
      conversationId: "chat-readback-failure",
      body: "This acknowledged ID must remain blocked",
      files: [],
      inlineAnnotations: [],
    } as const;
    const first = await preparePendingChatSendMutation(input);
    const scopeStorageKey = Array.from(values.keys()).find((key) => key.startsWith(scopePrefix));
    staleScopeKey = scopeStorageKey ?? null;
    stalePendingValue = values.get(scopeStorageKey!) ?? null;
    forceStaleMutationReadback = true;

    await first.settle();

    const blockedMarker = Array.from(values.entries()).find(([key]) => key.startsWith(
      blockedPrefix,
    ));
    expect(JSON.parse(blockedMarker?.[1] ?? "null")).toMatchObject({
      clientMutationId: first.clientMutationId,
      ordinal: 1,
      status: "settled",
    });

    // The new module has no in-memory block state; it must reject from the
    // durable marker before consulting the still-pending old mutation record.
    vi.resetModules();
    const reloadedStorage = await import("./chat-send-mutation-storage");
    const blocked = await reloadedStorage.preparePendingChatSendMutation(input).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(Error);
    expect((blocked as Error).message).toContain("cannot reconcile it safely yet");
    expect((blocked as Error).message).not.toMatch(/clear browser storage/i);

    const unrelatedChat = await reloadedStorage.preparePendingChatSendMutation({
      orgId: input.orgId,
      conversationId: "another-chat",
      body: input.body,
      files: [],
      inlineAnnotations: [],
    });
    expect(unrelatedChat.clientMutationId).toBeTruthy();
  });

  it("blocks a queued different send before releasing the scope lock when settlement fails", async () => {
    installCryptoStub();
    const scopePrefix = "rudder:chat-send-mutations:v2:scope:";
    const blockedPrefix = "rudder:chat-send-mutations:v2:blocked:";
    const values = new Map<string, string>();
    let firstMutationId: string | null = null;
    let queuedDifferentSend: ReturnType<typeof preparePendingChatSendMutation> | undefined;
    const input = {
      orgId: "org-settlement-race",
      conversationId: "chat-settlement-race",
      body: "The server acknowledged this message",
      files: [],
      inlineAnnotations: [],
    } as const;
    const storage = {
      get length() { return values.size; },
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key.startsWith(scopePrefix) && firstMutationId) {
          const document = JSON.parse(value) as {
            mutations: Record<string, { status?: string }>;
          };
          if (document.mutations[firstMutationId]?.status === "settled") {
            // Start another send while settlement owns the lock, then fail
            // the durable acknowledgement write before that lock is released.
            queuedDifferentSend = preparePendingChatSendMutation({
              ...input,
              body: "A second message must wait for reconciliation",
            });
            throw new DOMException("Quota exceeded", "QuotaExceededError");
          }
        }
        values.set(key, value);
      },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
    } as Storage;
    vi.stubGlobal("localStorage", storage);
    const first = await preparePendingChatSendMutation(input);
    firstMutationId = first.clientMutationId;

    await first.settle();

    expect(queuedDifferentSend).toBeDefined();
    await expect(queuedDifferentSend!).rejects.toThrow("cannot reconcile it safely yet");
    expect(Array.from(values.keys()).some((key) => key.startsWith(blockedPrefix))).toBe(true);
  });

  it("fails closed without Web Crypto instead of reusing a metadata-only file identity", async () => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "mutation-unsafe") } as unknown as Crypto);

    await expect(preparePendingChatSendMutation({
      orgId: "org-1",
      conversationId: "chat-1",
      body: "Review this file",
      files: [file("notes.txt", "contents")],
      inlineAnnotations: [],
    })).rejects.toThrow("Secure attachment identity is unavailable");
    expect(readPendingChatSendMutation("org-1", "chat-1", null)).toBeNull();
  });

  it("fails closed when browser storage is unavailable", async () => {
    installCryptoStub();
    vi.stubGlobal("localStorage", undefined);

    await expect(preparePendingChatSendMutation({
      orgId: "org-1",
      conversationId: "chat-1",
      body: "Retry this safely",
      files: [],
      inlineAnnotations: [],
    })).rejects.toThrow("Browser storage is unavailable");
  });

  it("does not return a new identity when storage rejects or fails to retain the write", async () => {
    installCryptoStub();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => { throw new DOMException("Storage is full", "QuotaExceededError"); }),
      removeItem: vi.fn(),
    });

    await expect(preparePendingChatSendMutation({
      orgId: "org-1",
      conversationId: "chat-1",
      body: "Retry this safely",
      files: [],
      inlineAnnotations: [],
    })).rejects.toThrow("could not be saved");

    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    await expect(preparePendingChatSendMutation({
      orgId: "org-1",
      conversationId: "chat-1",
      body: "Retry this safely",
      files: [],
      inlineAnnotations: [],
    })).rejects.toThrow("could not be confirmed");
  });

  it("fails closed instead of replacing malformed retained identity state", async () => {
    installCryptoStub();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => key === "rudder:chat-send-mutations:v1" ? "{invalid" : null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.resetModules();
    const isolatedStorage = await import("./chat-send-mutation-storage");

    const malformed = await isolatedStorage.preparePendingChatSendMutation({
      orgId: "org-1",
      conversationId: "chat-1",
      body: "Retry this safely",
      files: [],
      inlineAnnotations: [],
    }).catch((error: unknown) => error);
    expect(malformed).toBeInstanceOf(Error);
    expect((malformed as Error).message).toContain("Saved send identity is unreadable");
    expect((malformed as Error).message).not.toMatch(/clear browser storage/i);
  });
});
