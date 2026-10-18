import { afterEach, describe, expect, it, vi } from "vitest";
import { chatsApi } from "./chats";

afterEach(() => vi.unstubAllGlobals());

const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function nativeControl(overrides: Record<string, unknown> = {}) {
  return {
    executionAuthority: "native_rust",
    orgId: "org-1",
    conversationId: "chat-1",
    generationId: "generation-1",
    attemptEpoch: 2,
    controlVersion: 4,
    lastClientCheckpointSeq: 0,
    lastClientCheckpointHash: emptyHash,
    lastSequence: 7,
    runtimeTerminal: false,
    ...overrides,
  };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Native Chat control target read", () => {
  it("reads only the bounded current-control fence needed by Stop", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(nativeControl()));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatsApi.readNativeChatControl("chat-1", "org-1", "generation-1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/chats/chat-1/messages/stream/control?generationId=generation-1",
    );
    expect(result).toEqual(nativeControl());
  });

  it("accepts a positively identified legacy target with a null checkpoint pair", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(nativeControl({
      executionAuthority: "legacy_ts",
      lastClientCheckpointSeq: null,
      lastClientCheckpointHash: null,
    }))));

    await expect(chatsApi.readNativeChatControl("chat-1", "org-1", "generation-1"))
      .resolves.toMatchObject({ executionAuthority: "legacy_ts", attemptEpoch: 2, controlVersion: 4 });
  });

  it("rejects wrong scope, mismatched checkpoint metadata, and extra authority fields", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(nativeControl({ orgId: "org-2" })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatsApi.readNativeChatControl("chat-1", "org-1", "generation-1"))
      .rejects.toThrow("Native Chat returned an invalid control fence");

    fetchMock.mockResolvedValueOnce(jsonResponse(nativeControl({ conversationId: "chat-2" })));
    await expect(chatsApi.readNativeChatControl("chat-1", "org-1", "generation-1"))
      .rejects.toThrow("Native Chat returned an invalid control fence");

    fetchMock.mockResolvedValueOnce(jsonResponse(nativeControl({ generationId: "generation-2" })));
    await expect(chatsApi.readNativeChatControl("chat-1", "org-1", "generation-1"))
      .rejects.toThrow("Native Chat returned an invalid control fence");

    fetchMock.mockResolvedValueOnce(jsonResponse(nativeControl({
      lastClientCheckpointSeq: null,
      lastClientCheckpointHash: emptyHash,
    })));
    await expect(chatsApi.readNativeChatControl("chat-1", "org-1", "generation-1"))
      .rejects.toThrow("Native Chat returned an invalid control fence");

    fetchMock.mockResolvedValueOnce(jsonResponse(nativeControl({ providerThreadId: "must-not-be-exposed" })));
    await expect(chatsApi.readNativeChatControl("chat-1", "org-1", "generation-1"))
      .rejects.toThrow("Native Chat returned an invalid control fence");
  });

  it("rejects invalid checkpoint ranges, malformed hashes, and legacy checkpoints", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(nativeControl({
      lastClientCheckpointSeq: 8,
      lastClientCheckpointHash: emptyHash,
    })));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatsApi.readNativeChatControl("chat-1", "org-1", "generation-1"))
      .rejects.toThrow("Native Chat returned an invalid control fence");

    fetchMock.mockResolvedValueOnce(jsonResponse(nativeControl({
      lastClientCheckpointHash: "A".repeat(64),
    })));
    await expect(chatsApi.readNativeChatControl("chat-1", "org-1", "generation-1"))
      .rejects.toThrow("Native Chat returned an invalid control fence");

    fetchMock.mockResolvedValueOnce(jsonResponse(nativeControl({
      executionAuthority: "legacy_ts",
    })));
    await expect(chatsApi.readNativeChatControl("chat-1", "org-1", "generation-1"))
      .rejects.toThrow("Native Chat returned an invalid control fence");
  });
});
