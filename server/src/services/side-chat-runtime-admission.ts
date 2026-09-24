import type {
  RuntimeDriver,
  RuntimeDriverCapabilityStatus,
  RuntimeDriverSession,
} from "../agent-runtimes/index.js";
import type {
  NativeSpanSelector,
  RuntimeProviderBindingRef,
} from "./runtime-kernel/provider-capabilities.js";

export type SideChatForkSource = {
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  sourceRunId: string | null;
  sourceBoundaryRef: string | null;
  sourceSpanId: string | null;
  selectorJson: NativeSpanSelector | null;
  sourceBinding?: RuntimeProviderBindingRef & { runtimeType: string; principalScopeRef: string };
  sourceProviderProfile?: Record<string, unknown> | null;
  session: RuntimeDriverSession | null;
};

export type SideChatRuntimeAdmission = {
  continuity: "native" | "context_handoff";
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  sourceRunId: string | null;
  sourceBoundaryRef: string | null;
  sourceSpanId: string | null;
  providerCapability: {
    status: RuntimeDriverCapabilityStatus;
    reason: string;
  };
  downgradeReason: string | null;
  session: RuntimeDriverSession | null;
  sessionIntent:
    | { kind: "fresh" }
    | {
      kind: "fork";
      sourceRunId: string;
      sourceBoundaryRef: string;
      sessionId: string | null;
      sessionParams: Record<string, unknown> | null;
  };
};

type SideChatProviderCapability = SideChatRuntimeAdmission["providerCapability"];

export async function retrySideChatTerminalEvidence<T>(input: {
  write: () => Promise<T | null>;
  attempts?: number;
  onFailure?: (error: unknown, attempt: number, willRetry: boolean) => void;
}): Promise<T | null> {
  const attempts = Math.max(1, Math.floor(input.attempts ?? 3));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const evidence = await input.write();
      if (evidence) return evidence;
    } catch (error) {
      input.onFailure?.(error, attempt, attempt < attempts);
    }
  }
  return null;
}

function normalizeProviderCapability(
  capability: RuntimeDriver["capabilities"]["fork"] | null | undefined,
): SideChatProviderCapability {
  return {
    status: capability?.status ?? "unsupported",
    reason: capability?.reason
      || "No explicit provider-native fork capability result was returned.",
  };
}

function contextHandoffAdmission(
  source: SideChatForkSource,
  providerCapability: SideChatRuntimeAdmission["providerCapability"],
  downgradeReason: string,
): SideChatRuntimeAdmission {
  return {
    continuity: "context_handoff",
    sourceConversationId: source.sourceConversationId,
    sourceMessageId: source.sourceMessageId,
    sourceRunId: source.sourceRunId,
    sourceBoundaryRef: source.sourceBoundaryRef,
    sourceSpanId: source.sourceSpanId,
    providerCapability,
    downgradeReason,
    session: null,
    sessionIntent: { kind: "fresh" },
  };
}

export async function admitSideChatRuntimeFork(input: {
  driver: RuntimeDriver | null;
  source: SideChatForkSource;
  targetBinding: RuntimeProviderBindingRef;
  signal?: AbortSignal;
  executeFork?: RuntimeDriver["fork"];
}): Promise<SideChatRuntimeAdmission> {
  const rawDriverCapability = input.driver?.capabilities.fork;
  const providerCapability = normalizeProviderCapability(rawDriverCapability ?? {
    status: "unsupported",
    reason: "No runtime driver is available for the selected Side Chat runtime.",
  });

  if (!input.driver) {
    return contextHandoffAdmission(
      input.source,
      providerCapability,
      "runtime_driver_unavailable",
    );
  }
  if (!input.source.sourceConversationId || !input.source.sourceMessageId) {
    return contextHandoffAdmission(
      input.source,
      providerCapability,
      "source_reply_anchor_unavailable",
    );
  }
  if (!input.source.sourceRunId) {
    return contextHandoffAdmission(
      input.source,
      providerCapability,
      "source_reply_has_no_common_run",
    );
  }
  if (!input.source.sourceBoundaryRef) {
    return contextHandoffAdmission(
      input.source,
      providerCapability,
      "source_reply_has_no_native_boundary",
    );
  }
  if (!input.source.selectorJson || ["pending", "unresolved"].includes(input.source.selectorJson.kind)) {
    return contextHandoffAdmission(
      input.source,
      providerCapability,
      "source_reply_has_no_native_selector",
    );
  }
  if (!input.source.session) {
    return contextHandoffAdmission(
      input.source,
      providerCapability,
      "source_reply_has_no_native_session",
    );
  }
  if (!input.targetBinding.hostId.trim() || !input.targetBinding.profileId.trim()) {
    return contextHandoffAdmission(
      input.source,
      providerCapability,
      "profile_bound_provider_binding_unavailable",
    );
  }
  if (providerCapability.status !== "supported") {
    return contextHandoffAdmission(
      input.source,
      providerCapability,
      `provider_native_fork_unavailable: ${providerCapability.reason}`,
    );
  }

  const operation = await (input.executeFork ?? input.driver.fork.bind(input.driver))({
    session: input.source.session,
    boundary: input.source.sourceBoundaryRef,
    selector: input.source.selectorJson,
    binding: input.targetBinding,
    signal: input.signal,
  });
  if (operation.status !== "supported") {
    throw new Error(
      `Provider-native Side Chat fork ${operation.status}: ${operation.reason}`,
    );
  }

  const sessionId = operation.value.session.sessionId.trim();
  const sourceBoundaryRef = operation.value.sourceBoundary?.trim()
    || input.source.sourceBoundaryRef?.trim()
    || null;
  if (!sessionId || !operation.value.boundary.trim() || !sourceBoundaryRef) {
    throw new Error("Provider-native Side Chat fork returned incomplete session or boundary data");
  }

  return {
    continuity: "native",
    sourceConversationId: input.source.sourceConversationId,
    sourceMessageId: input.source.sourceMessageId,
    sourceRunId: input.source.sourceRunId,
    sourceBoundaryRef,
    sourceSpanId: input.source.sourceSpanId,
    providerCapability,
    downgradeReason: null,
    session: {
      ...operation.value.session,
      sessionId,
      sessionDisplayId: operation.value.session.sessionDisplayId.trim() || sessionId,
    },
    sessionIntent: {
      kind: "fork",
      sourceRunId: input.source.sourceRunId,
      sourceBoundaryRef,
      sessionId,
      sessionParams: { ...operation.value.session.sessionParams },
    },
  };
}
