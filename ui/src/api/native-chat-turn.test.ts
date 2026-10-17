import { afterEach, describe, expect, it, vi } from "vitest";
import { chatsApi } from "./chats";

afterEach(() => vi.unstubAllGlobals());

const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function nativeTurn(overrides: Record<string, unknown> = {}) {
  return {
    executionAuthority: "native_rust",
    generationId: "generation-1",
    runId: "run-1",
    sourceMessage: {
      id: "message-1",
      orgId: "org-1",
      conversationId: "chat-1",
      role: "user",
      kind: "message",
      status: "completed",
      body: "hello",
    },
    assistantMessage: null,
    generationStatus: "running",
    runStatus: "running",
    executionOwnerLive: true,
    attemptEpoch: 1,
    controlVersion: 2,
    runtimeTerminal: false,
    nativeAdmissionHold: true,
    lastSequence: 0,
    lastClientCheckpointSeq: 0,
    lastClientCheckpointHash: emptyHash,
    ...overrides,
  };
}

describe("native Chat Stop target read", () => {
  it("reads the exact scoped generation and validates its persisted checkpoint fence", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(nativeTurn()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatsApi.readNativeChatTurn("chat-1", "org-1", "generation-1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/chats/chat-1/messages/stream/turn?generationId=generation-1",
    );
    expect(result).toMatchObject({
      executionAuthority: "native_rust",
      generationId: "generation-1",
      controlVersion: 2,
      lastClientCheckpointSeq: 0,
      lastClientCheckpointHash: emptyHash,
    });
  });

  it("accepts only an explicit legacy target disposition with a complete generation fence", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      executionAuthority: "legacy_ts",
      generationId: "generation-1",
      attemptEpoch: 3,
      controlVersion: 4,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(chatsApi.readNativeChatTurn("chat-1", "org-1", "generation-1"))
      .resolves.toEqual({
        executionAuthority: "legacy_ts",
        generationId: "generation-1",
        attemptEpoch: 3,
        controlVersion: 4,
      });
  });

  it("fails closed on org, generation, or checkpoint mismatches", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(nativeTurn({
      lastClientCheckpointHash: "not-a-hash",
    })), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chatsApi.readNativeChatTurn("chat-1", "org-1", "generation-1"))
      .rejects.toThrow("Native Chat returned an invalid turn projection");

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(nativeTurn()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await expect(chatsApi.readNativeChatTurn("chat-1", "org-2", "generation-1"))
      .rejects.toThrow("Native Chat returned an invalid turn projection");
  });
});
