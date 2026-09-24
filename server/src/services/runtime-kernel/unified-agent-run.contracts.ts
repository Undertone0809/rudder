import type { Db } from "@rudderhq/db";
import type { HeartbeatRunAttemptStatus } from "@rudderhq/shared";
import type { NativeSegmentRecord, RuntimeBindingRecord } from "./native-session.js";
import type {
  UnifiedAdmissionResult,
  UnifiedAgentRunAdmission,
  UnifiedAgentRunEntry,
  UnifiedFenceResult,
  UnifiedOwnerFence,
  UnifiedRunAttempt,
  UnifiedRunSpan,
  UnifiedRunStatus,
  UnifiedSpanCompleteness,
  UnifiedSubmission,
  UnifiedSubmissionOutcome,
  UnifiedAttemptInput,
} from "./unified-agent-run.js";

export type Awaitable<T> = T | PromiseLike<T>;

export type UnifiedOwnerClaimInput = {
  ownerToken?: string;
  leaseMs?: number;
  observedAt?: Date;
  recoveryCutoff?: Date;
};

export type UnifiedAttemptTerminalStatus = Exclude<
  HeartbeatRunAttemptStatus,
  "started" | "waiting_for_network"
>;

export type UnifiedRunTerminalStatus = Exclude<UnifiedRunStatus, "running">;

export type UnifiedAgentRunPersistenceErrorCode = "unsupported" | "contract";

/**
 * A durable adapter must reject a projection it cannot represent. In
 * particular, it must not silently fall back to a process-local ledger when a
 * heartbeat row, attempt, or native span is missing.
 */
export class UnifiedAgentRunPersistenceContractError extends Error {
  constructor(
    readonly code: UnifiedAgentRunPersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UnifiedAgentRunPersistenceContractError";
  }
}

type UnifiedNativeSpanResolution = {
  binding: RuntimeBindingRecord;
  segment: NativeSegmentRecord;
  inputCorrelationRef?: string | null;
};

export type UnifiedNativeSpanResolverInput = {
  db: Db;
  admission: UnifiedAgentRunAdmission;
  runId: string;
  attemptId: string;
  attemptIndex: number;
  ownerToken: string;
  attemptEpoch: number;
};

export type UnifiedAgentRunPersistenceAdapterOptions = {
  now?: () => Date;
  resolveNativeSpan?: (
    input: UnifiedNativeSpanResolverInput,
  ) => Awaitable<UnifiedNativeSpanResolution | null>;
};

export type UnifiedAcceptanceUnknownInput = UnifiedSubmissionOutcome & {
  phase?: Exclude<UnifiedSubmission["phase"], null>;
};

export type UnifiedAcceptanceReconciliationInput = UnifiedSubmissionOutcome & {
  state: "accepted" | "rejected";
};

export type UnifiedSpanSealInput = {
  completeness: UnifiedSpanCompleteness;
  sourceRevision?: string | null;
  visibilityCutoffRef?: string | null;
};

/**
 * The minimum admission surface that a caller needs to create or recover a
 * common Agent Run. It has no queue, wakeup, polling, or execution operation.
 */
export interface UnifiedAgentRunAdmissionPort {
  admit(input: UnifiedAgentRunAdmission): Awaitable<UnifiedAdmissionResult>;
  get(runId: string): Awaitable<UnifiedAgentRunEntry | null>;
}

/**
 * Owner fencing is deliberately separate from scheduling. A persisted
 * heartbeat implementation can map these calls to its existing run lease and
 * recovery helpers without giving this service another scheduler.
 */
export interface UnifiedAgentRunOwnerFencePort {
  claimOwner(
    runId: string,
    input?: UnifiedOwnerClaimInput,
  ): Awaitable<UnifiedFenceResult<UnifiedOwnerFence>>;
  renewOwner(
    runId: string,
    fence: UnifiedOwnerFence,
  ): Awaitable<UnifiedFenceResult<UnifiedOwnerFence>>;
}

/** Optional Attempt/submission/span mutations remain behind a separate port. */
export interface UnifiedAgentRunAttemptPort {
  beginAttempt(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedAttemptInput,
  ): Awaitable<UnifiedFenceResult<UnifiedRunAttempt>>;
  finishAttempt(
    runId: string,
    fence: UnifiedOwnerFence,
    status: UnifiedAttemptTerminalStatus,
    input?: import("./unified-agent-run.js").UnifiedAttemptFinishInput,
  ): Awaitable<UnifiedFenceResult<UnifiedRunAttempt>>;
  markAttemptWaiting(
    runId: string,
    fence: UnifiedOwnerFence,
    input?: import("./unified-agent-run.js").UnifiedAttemptWaitingInput,
  ): Awaitable<UnifiedFenceResult<UnifiedRunAttempt>>;
  recordExecutionResult(
    runId: string,
    fence: UnifiedOwnerFence,
    input: import("./unified-agent-run.js").UnifiedNativeExecutionInput,
  ): Awaitable<UnifiedFenceResult<UnifiedRunSpan>>;
  acceptSubmission(
    runId: string,
    fence: UnifiedOwnerFence,
    input?: UnifiedSubmissionOutcome,
  ): Awaitable<UnifiedFenceResult<UnifiedSubmission>>;
  markAcceptanceUnknown(
    runId: string,
    fence: UnifiedOwnerFence,
    input?: UnifiedAcceptanceUnknownInput,
  ): Awaitable<UnifiedFenceResult<UnifiedSubmission>>;
  reconcileAcceptance(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedAcceptanceReconciliationInput,
  ): Awaitable<UnifiedFenceResult<UnifiedSubmission>>;
  sealSpan(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedSpanSealInput,
  ): Awaitable<UnifiedFenceResult<UnifiedRunSpan>>;
  finishRun(
    runId: string,
    fence: UnifiedOwnerFence,
    status: UnifiedRunTerminalStatus,
    input?: import("./unified-agent-run.js").UnifiedRunTerminalInput,
  ): Awaitable<UnifiedFenceResult<UnifiedAgentRunEntry>>;
}

/**
 * Narrow persistence-only adapter boundary for the common run contract.
 *
 * `createHeartbeatUnifiedAgentRunAdapter` binds this port to the existing
 * heartbeat run, attempt, lease, terminal, and native span persistence. The
 * adapter does not add queue, wakeup, polling, or execution methods.
 */
export type UnifiedAgentRunPersistenceAdapter =
  & UnifiedAgentRunAdmissionPort
  & UnifiedAgentRunOwnerFencePort;

/** Full adapter shape for a persistence layer that also owns attempt/evidence mutations. */
export type UnifiedAgentRunAdapter =
  & UnifiedAgentRunPersistenceAdapter
  & UnifiedAgentRunAttemptPort;

export interface UnifiedAgentRunService extends UnifiedAgentRunAdmissionPort, UnifiedAgentRunOwnerFencePort {
  admit(input: UnifiedAgentRunAdmission): Promise<UnifiedAdmissionResult>;
  get(runId: string): Promise<UnifiedAgentRunEntry | null>;
  claimOwner(
    runId: string,
    input?: UnifiedOwnerClaimInput,
  ): Promise<UnifiedFenceResult<UnifiedOwnerFence>>;
  renewOwner(
    runId: string,
    fence: UnifiedOwnerFence,
  ): Promise<UnifiedFenceResult<UnifiedOwnerFence>>;
}

export interface UnifiedAgentRunExecutionService extends UnifiedAgentRunAttemptPort {
  beginAttempt(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedAttemptInput,
  ): Promise<UnifiedFenceResult<UnifiedRunAttempt>>;
  finishAttempt(
    runId: string,
    fence: UnifiedOwnerFence,
    status: UnifiedAttemptTerminalStatus,
    input?: import("./unified-agent-run.js").UnifiedAttemptFinishInput,
  ): Promise<UnifiedFenceResult<UnifiedRunAttempt>>;
  markAttemptWaiting(
    runId: string,
    fence: UnifiedOwnerFence,
    input?: import("./unified-agent-run.js").UnifiedAttemptWaitingInput,
  ): Promise<UnifiedFenceResult<UnifiedRunAttempt>>;
  recordExecutionResult(
    runId: string,
    fence: UnifiedOwnerFence,
    input: import("./unified-agent-run.js").UnifiedNativeExecutionInput,
  ): Promise<UnifiedFenceResult<UnifiedRunSpan>>;
  finishRun(
    runId: string,
    fence: UnifiedOwnerFence,
    status: UnifiedRunTerminalStatus,
    input?: import("./unified-agent-run.js").UnifiedRunTerminalInput,
  ): Promise<UnifiedFenceResult<UnifiedAgentRunEntry>>;
  acceptSubmission(
    runId: string,
    fence: UnifiedOwnerFence,
    input?: UnifiedSubmissionOutcome,
  ): Promise<UnifiedFenceResult<UnifiedSubmission>>;
  markAcceptanceUnknown(
    runId: string,
    fence: UnifiedOwnerFence,
    input?: UnifiedAcceptanceUnknownInput,
  ): Promise<UnifiedFenceResult<UnifiedSubmission>>;
  reconcileAcceptance(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedAcceptanceReconciliationInput,
  ): Promise<UnifiedFenceResult<UnifiedSubmission>>;
  sealSpan(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedSpanSealInput,
  ): Promise<UnifiedFenceResult<UnifiedRunSpan>>;
}
