import type {
  AgentRuntimeExecutionResult,
  ModelAttemptSpec,
  NativeProcessAuthority,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  beginHeartbeatRunAttempt,
  finishHeartbeatRunAttempt,
  type HeartbeatAttemptRef,
} from "./heartbeat-attempt-ledger.js";
import {
  issueNativeProcessAuthorityForAttempt,
  selectNativeProcessAuthority,
} from "./native-process-authority.js";
import {
  buildRuntimeAttemptCheckpoint,
  mergeRuntimeAttemptCheckpoint,
  persistRuntimeAttemptCheckpoint,
} from "./runtime-attempt-adapter.js";
import { logger } from "../../middleware/logger.js";

export type HeartbeatActiveAttemptSpec = {
  index: number;
  ledgerIndex: number;
  fallbackIndex: number | null;
  runtimeType: string;
  model: string | null;
  isFallback: boolean;
};

type ResumeSource = "fresh" | "same_session" | "pristine_replay";
type AttemptAdapter = Pick<ServerAgentRuntimeModule, "type" | "parseStdoutLine">;
type StdoutParser = NonNullable<ServerAgentRuntimeModule["parseStdoutLine"]>;
type PersistAttempt = (
  label: string,
  operation: () => Promise<unknown>,
) => Promise<unknown>;
type LifecycleRun = {
  id: string;
  orgId: string;
  agentId: string;
  executionOwnerToken: string | null;
  executionLeaseExpiresAt: Date | null;
};
type AttemptFinishInput = Record<string, unknown> & {
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asAttemptRef(value: unknown): HeartbeatAttemptRef | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<HeartbeatAttemptRef>;
  return typeof candidate.id === "string" && typeof candidate.attemptIndex === "number"
    ? { id: candidate.id, attemptIndex: candidate.attemptIndex }
    : null;
}

export function createHeartbeatAttemptLifecycle(input: {
  db: Db;
  run: LifecycleRun;
  agentRuntimeType: string;
  attemptStride: number;
  recoveryAttemptOrdinal: number;
  resumeSource: ResumeSource;
  persistAttempt: PersistAttempt;
  setStdoutTranscriptParser: (parser: StdoutParser | null) => void;
}) {
  let activeAttemptRef: HeartbeatAttemptRef | null = null;
  let activeAttemptSpec: HeartbeatActiveAttemptSpec | null = null;
  let activeNativeProcessAuthority: NativeProcessAuthority | undefined;

  const resolveLedgerAttemptIndex = (attemptIndex: number) =>
    input.recoveryAttemptOrdinal * input.attemptStride + attemptIndex;

  const buildAttemptCheckpoint = (
    spec: HeartbeatActiveAttemptSpec,
    phase: "executing" | "succeeded" | "failed" | "cancelled" | "timed_out",
    authority: NativeProcessAuthority | undefined,
    evidence?: Record<string, unknown>,
  ) => buildRuntimeAttemptCheckpoint({
    orgId: input.run.orgId,
    runId: input.run.id,
    agentId: input.run.agentId,
    executionOwnerToken: input.run.executionOwnerToken,
    executionLeaseExpiresAt: input.run.executionLeaseExpiresAt,
    attemptIndex: spec.ledgerIndex,
    fallbackIndex: spec.fallbackIndex,
    runtimeType: spec.runtimeType,
    model: spec.model,
    isFallback: spec.isFallback,
    recoveryAttemptOrdinal: input.recoveryAttemptOrdinal,
    resumeSource: input.resumeSource,
    phase,
    authority,
    evidence,
  });

  const finishActiveAttempt = async (finishInput: AttemptFinishInput) => {
    const ref = activeAttemptRef;
    activeAttemptRef = null;
    if (!ref) return;
    const checkpoint = activeAttemptSpec
      ? buildAttemptCheckpoint(activeAttemptSpec, finishInput.status, activeNativeProcessAuthority, {
          errorCode: finishInput.errorCode ?? null,
          error: finishInput.error ?? null,
        })
      : null;
    try {
      await finishHeartbeatRunAttempt(input.db, ref, {
        ...finishInput,
        ...(checkpoint ? { checkpointJson: checkpoint } : {}),
      } as Parameters<typeof finishHeartbeatRunAttempt>[2]);
    } catch (error) {
      logger.warn(
        { err: error, runId: input.run.id, attemptIndex: ref.attemptIndex },
        "failed to persist heartbeat attempt terminal state",
      );
    }
  };

  const onAttemptStart = async (attempt: ModelAttemptSpec, adapter: AttemptAdapter) => {
    const spec: HeartbeatActiveAttemptSpec = {
      index: attempt.index,
      ledgerIndex: resolveLedgerAttemptIndex(attempt.index),
      fallbackIndex: attempt.fallbackIndex,
      runtimeType: attempt.agentRuntimeType ?? input.agentRuntimeType,
      model: attempt.model,
      isFallback: attempt.isFallback,
    };
    activeAttemptSpec = spec;
    activeNativeProcessAuthority = undefined;
    const initialCheckpoint = buildAttemptCheckpoint(spec, "executing", undefined);
    activeAttemptRef = asAttemptRef(await input.persistAttempt("started", () => beginHeartbeatRunAttempt(input.db, {
      orgId: input.run.orgId,
      runId: input.run.id,
      agentId: input.run.agentId,
      attemptIndex: spec.ledgerIndex,
      fallbackIndex: spec.fallbackIndex,
      runtimeType: spec.runtimeType,
      model: spec.model,
      isFallback: spec.isFallback,
      resumeSource: input.resumeSource,
      checkpointJson: initialCheckpoint,
    })));
    input.setStdoutTranscriptParser(adapter.parseStdoutLine ?? null);
  };

  const issueNativeProcessAuthority = async (
    attempt: ModelAttemptSpec,
    adapter: AttemptAdapter,
  ) => {
    const spec = activeAttemptSpec ?? {
      index: attempt.index,
      ledgerIndex: resolveLedgerAttemptIndex(attempt.index),
      fallbackIndex: attempt.fallbackIndex,
      runtimeType: attempt.agentRuntimeType ?? input.agentRuntimeType,
      model: attempt.model,
      isFallback: attempt.isFallback,
    };
    const authority = adapter.type === "process"
      ? issueNativeProcessAuthorityForAttempt({
          run: input.run,
          attemptIndex: spec.ledgerIndex,
        })
      : undefined;
    activeNativeProcessAuthority = selectNativeProcessAuthority(adapter.type, authority);
    if (activeNativeProcessAuthority && activeAttemptRef) {
      const checkpoint = buildAttemptCheckpoint(spec, "executing", activeNativeProcessAuthority);
      await input.persistAttempt(
        "authority_checkpoint",
        () => persistRuntimeAttemptCheckpoint(input.db, activeAttemptRef, checkpoint),
      );
    }
    return activeNativeProcessAuthority;
  };

  const onAttemptFailure = async (
    _attempt: ModelAttemptSpec,
    failure: AgentRuntimeExecutionResult | Error,
  ) => {
    const failureRecord = failure && typeof failure === "object"
      ? failure as unknown as Record<string, unknown>
      : null;
    const failureMessage = failure instanceof Error
      ? failure.message
      : readNonEmptyString(failureRecord?.errorMessage) ?? "Adapter fallback attempt failed";
    await finishActiveAttempt({
      status: "failed",
      errorCode: readNonEmptyString(failureRecord?.errorCode) ?? "adapter_failed",
      error: failureMessage,
      usageDeltaJson: failureRecord?.usage,
      costUsd: failureRecord?.costUsd,
      sessionDisplayId: readNonEmptyString(failureRecord?.sessionDisplayId)
        ?? readNonEmptyString(failureRecord?.sessionId),
      sessionParamsJson: failureRecord?.sessionParams,
    });
  };

  return {
    finishActiveAttempt,
    onAttemptStart,
    issueNativeProcessAuthority,
    onAttemptFailure,
    getActiveAttemptSpec: () => activeAttemptSpec,
    getActiveNativeProcessAuthority: () => activeNativeProcessAuthority,
    takeActiveAttemptRef: () => {
      const ref = activeAttemptRef;
      activeAttemptRef = null;
      return ref;
    },
    buildWaitingCheckpoint: (waiting: {
      checkpoint: Record<string, unknown>;
      recoveryAttemptOrdinal: number;
      resumeSource: ResumeSource;
      fallbackAttemptIndex: number;
    }) => mergeRuntimeAttemptCheckpoint(
      waiting.checkpoint,
      buildRuntimeAttemptCheckpoint({
        orgId: input.run.orgId,
        runId: input.run.id,
        agentId: input.run.agentId,
        executionOwnerToken: input.run.executionOwnerToken,
        executionLeaseExpiresAt: input.run.executionLeaseExpiresAt,
        attemptIndex: activeAttemptSpec?.ledgerIndex ?? waiting.fallbackAttemptIndex,
        fallbackIndex: activeAttemptSpec?.fallbackIndex ?? null,
        runtimeType: activeAttemptSpec?.runtimeType ?? input.agentRuntimeType,
        model: activeAttemptSpec?.model ?? null,
        isFallback: activeAttemptSpec?.isFallback ?? false,
        recoveryAttemptOrdinal: waiting.recoveryAttemptOrdinal,
        resumeSource: waiting.resumeSource,
        phase: "waiting_for_network",
        authority: activeNativeProcessAuthority,
        evidence: waiting.checkpoint,
      }),
    ),
  };
}
