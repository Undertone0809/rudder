import type { Db } from "@rudderhq/db";
import { describe, expect, it } from "vitest";
import { persistChatNativeTransport } from "./chat-assistant.native-transcript.js";
import { createChatTranscriptDelivery } from "./chat-assistant.transcript-delivery.js";
import { resolveHeartbeatTranscriptRetention } from "./runtime-kernel/heartbeat-transcript-retention.js";

describe("Chat native transport ownership", () => {
  it("fails closed before persisting a profile when the Run is inactive", async () => {
    const transcript = createChatTranscriptDelivery({
      retention: resolveHeartbeatTranscriptRetention({ hasBinding: true, bindingContinuity: "native", capabilityStatus: "unknown" }),
      runtimeAgentType: "pi_local", runId: "run-1", spanId: "span-1",
      markLegacy: async () => true, isInactive: () => true,
    });
    await expect(persistChatNativeTransport({
      db: {} as Db, profile: { runtimeType: "pi_local" }, runtimeType: "pi_local",
      config: {}, providerProfileCwd: "/workspace",
      binding: { hostId: "local", profileId: "pi-profile" }, continuity: "native",
      resumeSessionId: null, run: { id: "run-1", orgId: "org-1" },
      transcript, isInactive: () => true,
    })).rejects.toThrow("ownership was lost");
    expect(transcript.delivery.source).toBe("legacy");
  });
});
