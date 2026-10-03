import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { ChatTranscriptDelivery } from "./chat-assistant.helpers.js";
import { resolveHeartbeatTranscriptRetention, type HeartbeatTranscriptRetentionInput, type HeartbeatTranscriptRetentionPolicy } from "./runtime-kernel/heartbeat-transcript-retention.js";
import { isExplicitLegacyTranscriptSource, markLegacyTranscriptSource } from "./runtime-kernel/transcript-source.js";

/** Reuse exactly the host proof that selected native retention, not a user flag. */
export function resolveChatTranscriptRetention(input: HeartbeatTranscriptRetentionInput) {
  const retention = resolveHeartbeatTranscriptRetention(input);
  return { retention, profileCapability: retention.mode === "native" ? input.profileCapability : null };
}

export function withNativeSupplementProfile(
  append: (entry: TranscriptEntry, delivery: ChatTranscriptDelivery & {
    persistSupplement?: boolean;
    nativeProfileCapability?: HeartbeatTranscriptRetentionInput["profileCapability"];
  }) => Promise<unknown>,
  profileCapability: HeartbeatTranscriptRetentionInput["profileCapability"],
) {
  return (entry: TranscriptEntry, delivery: ChatTranscriptDelivery & { persistSupplement?: boolean }) =>
    append(entry, { ...delivery, nativeProfileCapability: profileCapability });
}

export function createChatTranscriptDelivery(input: {
  retention: HeartbeatTranscriptRetentionPolicy;
  recoveredRun?: { contextSnapshot?: unknown; resultJson?: unknown } | null;
  runtimeAgentType: string;
  runId: string;
  spanId: string | null;
  markLegacy: () => Promise<boolean>;
  isInactive: () => boolean;
}) {
  const recoveredLegacy = Boolean(input.recoveredRun && isExplicitLegacyTranscriptSource(input.recoveredRun));
  let isLegacy = input.retention.mode === "legacy" || recoveredLegacy;
  const delivery = {
    source: isLegacy ? "legacy" as "legacy" | "native" : "native" as "legacy" | "native",
    // A capability can select the native source, but only terminal Reader
    // proof may retire the complete recovery transcript.
    persistRaw: isLegacy,
    persistSupplement: !isLegacy,
    runId: input.runId,
    spanId: input.spanId,
  };
  return {
    delivery,
    get isLegacy() { return isLegacy; },
    terminalResult(resultJson: Record<string, unknown> | null | undefined) {
      return isLegacy ? markLegacyTranscriptSource(resultJson) : resultJson;
    },
    async onNativeTranscriptSource(attestAndPersist: () => Promise<void>) {
      if (!isLegacy || recoveredLegacy) return false;
      if (input.isInactive()) throw new Error("Chat runtime lost ownership before attesting native transcript source");
      await attestAndPersist();
      if (input.isInactive()) throw new Error("Chat runtime lost ownership after attesting native transcript source");
      isLegacy = false;
      delivery.source = "native";
      delivery.persistRaw = false;
      delivery.persistSupplement = true;
      return true;
    },
    async onTranscriptSource(source: "legacy") {
      if (source !== "legacy" || isLegacy) return;
      if (input.isInactive() || !await input.markLegacy()) {
        throw new Error("Chat runtime lost ownership before switching transcript source");
      }
      isLegacy = true;
      delivery.source = "legacy";
      delivery.persistRaw = true;
      delivery.persistSupplement = false;
    },
  };
}
