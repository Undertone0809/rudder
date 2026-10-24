import { afterEach, describe, expect, it, vi } from "vitest";
import { chatsApi } from "./chats";

afterEach(() => vi.unstubAllGlobals());

function recoveryRead(recovery: unknown = null, overrides: Record<string, unknown> = {}) {
  return {
    executionAuthority: "native_rust",
    orgId: "org-1",
    conversationId: "chat-1",
    recovery,
    ...overrides,
  };
}

function pointer(overrides: Record<string, unknown> = {}) {
  return {
    generationId: "generation-1",
    runId: "run-1",
    attemptEpoch: 2,
    generationStatus: "interrupted_unverified",
    controlState: "control_lost",
    cleanupState: "unknown",
    ...overrides,
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Native Chat recovery read", () => {
  it("reads a chat-scoped durable recovery pointer without request data", async () => {
    const body = recoveryRead(pointer());
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatsApi.readNativeChatRecovery("chat-1", "org-1")).resolves.toEqual(body);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/chats/chat-1/messages/stream/recovery");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it("accepts the bounded no-recovery result and rejects scope or projection mismatches", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(recoveryRead()));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatsApi.readNativeChatRecovery("chat-1", "org-1"))
      .resolves.toMatchObject({ recovery: null });

    fetchMock.mockResolvedValueOnce(jsonResponse(recoveryRead(null, { orgId: "org-2" })));
    await expect(chatsApi.readNativeChatRecovery("chat-1", "org-1"))
      .rejects.toThrow("Native Chat returned an invalid recovery projection");

    fetchMock.mockResolvedValueOnce(jsonResponse(recoveryRead(pointer({ cleanupState: "stopped" }))));
    await expect(chatsApi.readNativeChatRecovery("chat-1", "org-1"))
      .rejects.toThrow("Native Chat returned an invalid recovery projection");

    fetchMock.mockResolvedValueOnce(jsonResponse(recoveryRead(pointer({ providerThreadId: "private" }))));
    await expect(chatsApi.readNativeChatRecovery("chat-1", "org-1"))
      .rejects.toThrow("Native Chat returned an invalid recovery projection");
  });
});
