import { acknowledgeUnstartedWriter } from "./heartbeat.execution-state.js";

export async function cleanupHeartbeatExecution(input: {
  run: { id: string; agentId: string };
  executionLeaseTimer: ReturnType<typeof setInterval> | null;
  commonSpanId: string | null;
  runWasRunningAtEntry: boolean;
  providerDispatchStarted: boolean;
  acknowledgeRunProcessExit: Parameters<typeof acknowledgeUnstartedWriter>[0]["acknowledge"];
  releaseRuntimeServicesForRun: (runId: string) => Promise<unknown>;
  runAbortControllers: { delete(runId: string): unknown };
  activeRunExecutions: { delete(runId: string): unknown };
  networkSuspended: boolean;
  startNextQueuedRunForAgent: (agentId: string) => Promise<unknown>;
}) {
  const { run, executionLeaseTimer, commonSpanId, runWasRunningAtEntry,
    providerDispatchStarted, acknowledgeRunProcessExit, releaseRuntimeServicesForRun,
    runAbortControllers, activeRunExecutions, networkSuspended, startNextQueuedRunForAgent } = input;
  if (executionLeaseTimer) clearInterval(executionLeaseTimer);
  await acknowledgeUnstartedWriter({
    runId: run.id, spanId: commonSpanId, runWasRunningAtEntry,
    providerDispatchStarted, acknowledge: acknowledgeRunProcessExit,
  });
  await releaseRuntimeServicesForRun(run.id).catch(() => undefined);
  runAbortControllers.delete(run.id);
  activeRunExecutions.delete(run.id);
  if (!networkSuspended) await startNextQueuedRunForAgent(run.agentId);
}
