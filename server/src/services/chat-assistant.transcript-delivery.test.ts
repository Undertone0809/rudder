import { describe, expect, it, vi } from "vitest";
import { createChatTranscriptDelivery } from "./chat-assistant.transcript-delivery.js";
import { resolveHeartbeatTranscriptRetention } from "./runtime-kernel/heartbeat-transcript-retention.js";

function delivery(recoveredRun?: { contextSnapshot?: unknown }) {
  return createChatTranscriptDelivery({
    retention: resolveHeartbeatTranscriptRetention({
      hasBinding: true, bindingContinuity: "native", capabilityStatus: "unknown",
    }),
    recoveredRun,
    runtimeAgentType: "pi_local",
    runId: "run-1",
    spanId: "span-1",
    markLegacy: vi.fn(async () => true),
    isInactive: () => false,
  });
}

describe("Chat transcript source attestation", () => {
  it("switches the fresh Pi run only after the Host witness persists", async () => {
    const transcript = delivery();
    expect(transcript.delivery).toMatchObject({ source: "legacy", persistRaw: true });
    const persist = vi.fn(async () => undefined);
    expect(await transcript.onNativeTranscriptSource(persist)).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
    expect(transcript.delivery).toMatchObject({ source: "native", persistRaw: false, persistSupplement: false });
    expect(transcript.terminalResult({ outcome: "succeeded" })).toEqual({ outcome: "succeeded" });
  });

  it("keeps legacy evidence on failed attestation or an explicitly legacy recovered run", async () => {
    const fresh = delivery();
    await expect(fresh.onNativeTranscriptSource(async () => { throw new Error("stale Run owner"); }))
      .rejects.toThrow("stale Run owner");
    expect(fresh.delivery).toMatchObject({ source: "legacy", persistRaw: true });

    const recovered = delivery({ contextSnapshot: { transcriptSource: "legacy" } });
    const persist = vi.fn(async () => undefined);
    expect(await recovered.onNativeTranscriptSource(persist)).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });
});
