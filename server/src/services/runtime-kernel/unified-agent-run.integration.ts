import type {
  Awaitable,
  UnifiedAgentRunAdapter,
  UnifiedAgentRunAttemptPort,
  UnifiedAgentRunExecutionService,
  UnifiedAgentRunPersistenceAdapter,
  UnifiedAgentRunService,
} from "./unified-agent-run.contracts.js";
import type {
  UnifiedAgentRunLedger
} from "./unified-agent-run.js";

export * from "./unified-agent-run.contracts.js";
export { createHeartbeatUnifiedAgentRunAdapter } from "./unified-agent-run.heartbeat-persistence.js";
export type { UnifiedSessionIntentInput } from "./unified-agent-run.js";

function delegate<T>(operation: () => Awaitable<T>): Promise<T> {
  return Promise.resolve().then(operation);
}

/**
 * Build the async service facade used by production callers. The facade only
 * delegates persistence and fencing; it never starts work or schedules a run.
 */
export function createUnifiedAgentRunService(
  adapter: UnifiedAgentRunPersistenceAdapter,
): UnifiedAgentRunService {
  return {
    admit: (input) => delegate(() => adapter.admit(input)),
    get: (runId) => delegate(() => adapter.get(runId)),
    claimOwner: (runId, input) => delegate(() => adapter.claimOwner(runId, input)),
    renewOwner: (runId, fence) => delegate(() => adapter.renewOwner(runId, fence)),
  };
}
/**
 * Optional async facade for attempt, provider-submission, span, and terminal
 * mutations. Callers can add it when their persisted adapter supports those
 * records; admission and owner fencing do not depend on this extension.
 */
export function createUnifiedAgentRunExecutionService(
  adapter: UnifiedAgentRunAttemptPort,
): UnifiedAgentRunExecutionService {
  return {
    beginAttempt: (runId, fence, input) => delegate(() => adapter.beginAttempt(runId, fence, input)),
    finishAttempt: (runId, fence, status, input) => delegate(() => adapter.finishAttempt(runId, fence, status, input)),
    markAttemptWaiting: (runId, fence, input) => delegate(() => adapter.markAttemptWaiting(runId, fence, input)),
    recordExecutionResult: (runId, fence, input) => delegate(() => adapter.recordExecutionResult(runId, fence, input)),
    acceptSubmission: (runId, fence, input) => delegate(() => adapter.acceptSubmission(runId, fence, input)),
    markAcceptanceUnknown: (runId, fence, input) => delegate(() => adapter.markAcceptanceUnknown(runId, fence, input)),
    reconcileAcceptance: (runId, fence, input) => delegate(() => adapter.reconcileAcceptance(runId, fence, input)),
    sealSpan: (runId, fence, input) => delegate(() => adapter.sealSpan(runId, fence, input)),
    finishRun: (runId, fence, status, input) => delegate(() => adapter.finishRun(runId, fence, status, input)),
  };
}

/**
 * Adapt the process-local ledger for contract tests. This is not a DB adapter
 * and must not be used as evidence that persisted heartbeat integration exists.
 */
export function createInMemoryUnifiedAgentRunAdapter(
  ledger: UnifiedAgentRunLedger,
): UnifiedAgentRunAdapter {
  return {
    admit: (input) => ledger.submit(input),
    get: (runId) => ledger.get(runId),
    claimOwner: (runId, input) => ledger.claimLease(runId, input),
    renewOwner: (runId, fence) => ledger.renewLease(runId, fence),
    beginAttempt: (runId, fence, input) => ledger.beginAttempt(runId, fence, input),
    finishAttempt: (runId, fence, status, input) => ledger.finishAttempt(runId, fence, status, input),
    markAttemptWaiting: (runId, fence, input) => ledger.markAttemptWaiting(runId, fence, input ?? {}),
    recordExecutionResult: (runId, fence, input) => ledger.recordExecutionResult(runId, fence, input),
    acceptSubmission: (runId, fence, input) => ledger.acceptSubmission(runId, fence, input),
    markAcceptanceUnknown: (runId, fence, input) => ledger.markAcceptanceUnknown(runId, fence, input),
    reconcileAcceptance: (runId, fence, input) => ledger.reconcileAcceptance(runId, fence, input),
    sealSpan: (runId, fence, input) => ledger.sealSpan(runId, fence, input),
    finishRun: (runId, fence, status, input) => ledger.finishRun(runId, fence, status, input),
  };
}
