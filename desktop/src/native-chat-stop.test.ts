import { describe, expect, it, vi } from "vitest";
import { stopNativeChatRun } from "./native-chat-stop.js";

const target = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  conversationId: "20000000-0000-4000-8000-000000000001",
  generationId: "30000000-0000-4000-8000-000000000001",
};
const control = {
  executionAuthority: "native_rust",
  orgId: target.organizationId,
  conversationId: target.conversationId,
  generationId: target.generationId,
  attemptEpoch: 2,
  controlVersion: 3,
  lastSequence: 12,
  lastClientCheckpointSeq: 7,
  lastClientCheckpointHash: "a".repeat(64),
  runtimeTerminal: false,
};
type Request = Parameters<typeof stopNativeChatRun>[0]["request"];

describe("Desktop Native Chat Stop", () => {
  it("sends the exact Rust fence and waits for terminal readback after intent acceptance", async () => {
    let reads = 0;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({
          controlActionId: expect.any(String),
          expectedGenerationId: target.generationId,
          expectedAttemptEpoch: 2,
          expectedControlVersion: 3,
          lastCommittedRenderSeq: 7,
          renderedBodyHash: "a".repeat(64),
        });
        return { controlActionId: body.controlActionId, generationId: target.generationId, stopped: false };
      }
      expect(path).toBe(`/chats/${target.conversationId}/messages/stream/control?generationId=${target.generationId}`);
      return { ...control, runtimeTerminal: ++reads > 2 };
    });
    await stopNativeChatRun({ target, request: request as Request, signal: new AbortController().signal });
    expect(reads).toBe(3);
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("uses the empty checkpoint before output and performs no Stop for a terminal target", async () => {
    let terminal = false;
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.lastCommittedRenderSeq).toBe(0);
        expect(body.renderedBodyHash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        terminal = true;
        return { controlActionId: body.controlActionId, generationId: target.generationId };
      }
      return { ...control, lastClientCheckpointSeq: null, lastClientCheckpointHash: null, runtimeTerminal: terminal };
    });
    await stopNativeChatRun({ target, request: request as Request, signal: new AbortController().signal });
    request.mockClear();
    await stopNativeChatRun({ target, request: request as Request, signal: new AbortController().signal });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    { orgId: "10000000-0000-4000-8000-000000000002" },
    { generationId: "30000000-0000-4000-8000-000000000002" },
    { executionAuthority: "legacy_ts" },
    { attemptEpoch: 0 },
    { controlVersion: 2_147_483_648 },
    { lastClientCheckpointSeq: 13 },
    { lastClientCheckpointHash: null },
  ])("rejects changed or malformed control metadata before mutation: %j", async (change) => {
    const request = vi.fn(async () => ({ ...control, ...change }));
    await expect(stopNativeChatRun({ target, request: request as Request, signal: new AbortController().signal }))
      .rejects.toThrow("could not verify");
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a different action receipt and aborts unresolved terminal polling", async () => {
    const controller = new AbortController();
    const mismatch = vi.fn(async (_path: string, init?: RequestInit) => init?.method === "POST"
      ? { controlActionId: "different-action", generationId: target.generationId }
      : control);
    await expect(stopNativeChatRun({ target, request: mismatch as Request, signal: controller.signal }))
      .rejects.toThrow("could not confirm");

    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return { controlActionId: body.controlActionId, generationId: target.generationId };
      }
      if (request.mock.calls.length > 2) controller.abort(new Error("quit deadline"));
      return control;
    });
    await expect(stopNativeChatRun({ target, request: request as Request, signal: controller.signal }))
      .rejects.toThrow("quit deadline");
  });

  it("settles lost execution control without treating it as process termination", async () => {
    const request = vi.fn(async (_path: string, init?: RequestInit) => init?.method === "POST"
      ? {
        controlActionId: JSON.parse(String(init.body)).controlActionId,
        generationId: target.generationId,
        disposition: "control_lost",
        stopped: false,
      }
      : control);
    await expect(stopNativeChatRun({ target, request: request as Request, signal: new AbortController().signal }))
      .rejects.toThrow("process cleanup still needs confirmation");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
