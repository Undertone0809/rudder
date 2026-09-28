import type { AgentRuntimeExecutionResult } from "./types.js";

export function hasConfirmedNativeWriterQuiescence(
  result: AgentRuntimeExecutionResult,
): result is AgentRuntimeExecutionResult & {
  nativeWriterQuiescence: Extract<NonNullable<AgentRuntimeExecutionResult["nativeWriterQuiescence"]>, { status: "confirmed" }>;
} {
  const evidence = result.nativeWriterQuiescence;
  if (!evidence || evidence.status !== "confirmed") return false;
  if (result.networkSuspension || result.suspension) return false;
  if (/(?:cancel|stop)_unverified/iu.test(result.errorCode ?? "")) return false;
  if (evidence.source === "not_started") {
    return result.submissionPhase === "pre_submission" && !result.timedOut;
  }
  if (result.timedOut && evidence.source === "provider_terminal") return false;
  if (evidence.source === "process_exit" && result.exitCode === null && !result.signal) return false;
  return true;
}
