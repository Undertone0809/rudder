import type { AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import type { chatAgentRunService } from "./chat-agent-runs.js";

type ChatRunService = ReturnType<typeof chatAgentRunService>;
type NativeSpanFence = Parameters<ChatRunService["recordNativeExecutionResult"]>[2];
type RecordedSpan = Pick<NonNullable<Awaited<ReturnType<ChatRunService["recordNativeExecutionResult"]>>>, "id" | "attemptRef"> | null;
type CurrentFence = {
  orgId: string;
  spanId?: string | null;
  attemptId?: string | null;
  ownerToken?: string | null;
  attemptEpoch?: number | null;
};
type ObservedEvidence = {
  spanId: string;
  attemptId: string;
  ownerToken: string;
  attemptEpoch: number;
  payload: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function matchesCurrent(evidence: ObservedEvidence, current: CurrentFence): boolean {
  return evidence.spanId === current.spanId && evidence.attemptId === current.attemptId
    && evidence.ownerToken === current.ownerToken && evidence.attemptEpoch === current.attemptEpoch;
}

/** Execution-local projection only; the caller must first await fenced recording. */
export function createChatNativeStopEvidence(input: {
  runId: string;
  runtimeType: string;
  signal: AbortSignal;
  getCurrentFence: () => CurrentFence;
}) {
  let observed: ObservedEvidence | null = null;
  return {
    observe({ recorded, result, fence }: {
      recorded: RecordedSpan;
      result: AgentRuntimeExecutionResult;
      fence: NativeSpanFence;
    }) {
      const current = input.getCurrentFence();
      if (!recorded || input.signal.aborted || fence.orgId !== current.orgId
        || recorded.id !== fence.spanId || recorded.attemptRef?.id !== fence.attemptId
        || fence.spanId !== current.spanId || fence.attemptId !== current.attemptId
        || fence.ownerToken !== current.ownerToken || fence.attemptEpoch !== current.attemptEpoch
        || !fence.spanId || !fence.attemptId || !fence.attemptEpoch) return;
      if (observed && observed.spanId === fence.spanId && observed.attemptId === fence.attemptId
        && observed.ownerToken === fence.ownerToken && observed.attemptEpoch === fence.attemptEpoch
        && record(observed.payload.control)?.stopConfirmed === true) return;
      const providerResult = record(result.resultJson);
      const rawControl = record(providerResult?.control);
      const control: Record<string, boolean> = {};
      if (typeof rawControl?.interruptRequested === "boolean") control.interruptRequested = rawControl.interruptRequested;
      const quiescence = result.nativeWriterQuiescence;
      const writer = quiescence?.status === "confirmed"
        && ["not_started", "provider_terminal", "provider_stop_ack", "process_exit"].includes(quiescence.source)
        ? { status: "confirmed", source: quiescence.source }
        : quiescence?.status === "unconfirmed" ? { status: "unconfirmed" } : null;
      const providerStatus = typeof providerResult?.providerStatus === "string"
        && ["interrupted", "complete", "settled", "unknown", "error", "failed", "cancelled"].includes(providerResult.providerStatus)
        ? providerResult.providerStatus : null;
      if (rawControl?.stopConfirmed === false) control.stopConfirmed = false;
      else if (rawControl?.stopConfirmed === true && writer?.status === "confirmed"
        && writer.source !== "not_started"
        && (input.runtimeType !== "hermes_gateway"
          || (providerStatus === "interrupted" && writer.source === "provider_stop_ack" && control.interruptRequested === true))) {
        control.stopConfirmed = true;
      }
      observed = {
        spanId: fence.spanId, attemptId: fence.attemptId, ownerToken: fence.ownerToken, attemptEpoch: fence.attemptEpoch,
        payload: {
          ...(Object.keys(control).length > 0 ? { control } : {}),
          ...(providerStatus ? { providerStatus } : {}),
          ...(writer ? { nativeWriterQuiescence: writer } : {}),
          nativeStopEvidence: { orgId: current.orgId, runId: input.runId, spanId: fence.spanId,
            attemptId: fence.attemptId, attemptEpoch: fence.attemptEpoch },
        },
      };
    },
    stoppedRunState(partialBody: string): Parameters<ChatRunService["finalizeRun"]>[1] {
      return {
        status: "cancelled",
        error: "Chat run stopped before completion",
        errorCode: "chat_stopped",
        resultJson: {
          outcome: "stopped", partialBody,
          ...(!input.signal.aborted && observed && matchesCurrent(observed, input.getCurrentFence())
            ? observed.payload : {}),
        },
      };
    },
  };
}
