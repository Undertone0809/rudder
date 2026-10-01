import type { AgentRuntimeExecutionResult } from "@rudderhq/agent-runtime-utils";
import { logger } from "../../middleware/logger.js";
import { sanitizeStartupContextContextForPersistence } from "./heartbeat.core.js";

export function buildPersistableHeartbeatContext(context: Record<string, unknown>) {
  return sanitizeStartupContextContextForPersistence(context) ?? {};
}

export async function acknowledgeUnstartedWriter(input: {
  runId: string;
  spanId: string | null;
  runWasRunningAtEntry: boolean;
  providerDispatchStarted: boolean;
  acknowledge: (runId: string, result: AgentRuntimeExecutionResult, spanId: string) => Promise<unknown>;
}) {
  // Only a fresh executor can prove it never called a provider. A recovered
  // running Run may still have a writer from its previous owner.
  if (input.runWasRunningAtEntry || input.providerDispatchStarted || !input.spanId) return;
  await input.acknowledge(input.runId, {
    summary: "",
    exitCode: null,
    signal: null,
    timedOut: false,
    submissionPhase: "pre_submission",
    nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
  }, input.spanId).catch((error) => {
    logger.error({ err: error, runId: input.runId, spanId: input.spanId }, "failed to persist pre-dispatch writer quiescence");
  });
}

export const EXECUTOR_OWNED_CONTEXT_KEYS = [
  "transcriptSource",
  "executionWorkspaceId",
  "rudderGitIdentity",
  "rudderScene",
  "rudderWorkspace",
  "rudderWorkspaces",
  "rudderStartupContext",
  "rudderStartupContextMetrics",
  "rudderRuntimeServiceIntents",
  "rudderSessionHandoffMarkdown",
  "rudderSessionRotationReason",
  "rudderPreviousSessionId",
  "rudderRuntimeServices",
  "rudderRuntimePrimaryUrl",
  "managedMcpPolicySnapshot",
] as const;

export function providerIdentityFromResult(result: Record<string, unknown>) {
  const payload = result.resultJson && typeof result.resultJson === "object" && !Array.isArray(result.resultJson)
    ? result.resultJson as Record<string, unknown>
    : {};
  const read = (...values: unknown[]) => values.find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  )?.trim() ?? null;
  return {
    providerThreadId: read(
      result.providerThreadId,
      result.sessionDisplayId,
      result.sessionId,
      payload.providerThreadId,
      payload.providerSessionId,
      payload.threadId,
    ),
    providerTurnId: read(
      result.providerTurnId,
      payload.providerTurnId,
      payload.turnId,
      payload.executionId,
      payload.messageId,
    ),
  };
}
