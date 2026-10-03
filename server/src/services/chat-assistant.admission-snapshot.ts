import type { NativeSpanSelector } from "./runtime-kernel/provider-capabilities.js";
import { sha256JsonDigest } from "./runtime-kernel/unified-agent-run.persistence-support.js";
import type { SideChatRuntimeAdmission } from "./side-chat-runtime-admission.js";

export function sideChatRuntimeAdmissionSnapshot(input: {
  admission: SideChatRuntimeAdmission;
  sourceSelectorJson: NativeSpanSelector | null;
  deferredForkDescriptor?: unknown;
}) {
  const { admission } = input;
  return {
    continuity: admission.continuity,
    sourceConversationId: admission.sourceConversationId,
    sourceMessageId: admission.sourceMessageId,
    sourceRunId: admission.sourceRunId,
    sourceBoundaryRef: admission.sourceBoundaryRef,
    sourceSpanId: admission.sourceSpanId,
    sourceSelectorJson: input.sourceSelectorJson,
    span: {
      id: admission.sourceSpanId,
      runId: admission.sourceRunId,
      selectorJson: input.sourceSelectorJson,
    },
    providerCapability: admission.providerCapability,
    downgradeReason: admission.downgradeReason,
    sessionIntentDigest: sha256JsonDigest(admission.sessionIntent),
    ...(input.deferredForkDescriptor
      ? { deferredForkDescriptor: input.deferredForkDescriptor }
      : {}),
  };
}
