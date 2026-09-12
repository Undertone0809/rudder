import type { NativeProcessAuthority } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  checkpointHeartbeatRunAttempt,
  type HeartbeatAttemptRef,
} from "./heartbeat-attempt-ledger.js";

export type RuntimeAttemptCheckpointPhase =
  | "executing"
  | "waiting_for_network"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type RuntimeAttemptCheckpointInput = {
  orgId: string;
  runId: string;
  agentId: string;
  executionOwnerToken: string | null;
  executionLeaseExpiresAt: Date | null;
  attemptIndex: number;
  fallbackIndex: number | null;
  runtimeType: string;
  model: string | null;
  isFallback: boolean;
  recoveryAttemptOrdinal: number;
  resumeSource: "fresh" | "same_session" | "pristine_replay";
  phase: RuntimeAttemptCheckpointPhase;
  authority?: NativeProcessAuthority;
  requestFingerprint?: string | null;
  evidence?: Record<string, unknown>;
};

/**
 * The durable heartbeat-attempt row remains authoritative. This envelope is a
 * private projection of runtime-attempt-core identity/lease/retry fields so a
 * restart can recover the same attempt cursor and owner evidence without a
 * second writer or a public runtime cutover.
 */
export function buildRuntimeAttemptCheckpoint(input: RuntimeAttemptCheckpointInput) {
  const attemptNumber = input.attemptIndex + 1;
  const idempotencyKey = `${input.runId}:${input.attemptIndex}:${input.fallbackIndex ?? "primary"}`;
  return {
    runtimeAttempt: {
      protocolVersion: 1,
      identity: {
        organizationId: input.orgId,
        runId: input.runId,
        agentId: input.agentId,
      },
      attempt: {
        organizationId: input.orgId,
        runId: input.runId,
        agentId: input.agentId,
        attempt: attemptNumber,
      },
      phase: input.phase,
      networkWaitCount: input.recoveryAttemptOrdinal,
      lease: {
        ownerId: input.executionOwnerToken,
        epoch: attemptNumber,
        issuedAtMillis: null,
        expiresAtMillis: input.executionLeaseExpiresAt?.getTime() ?? null,
      },
      idempotencyKey,
      requestFingerprint: input.requestFingerprint ?? idempotencyKey,
      retry: {
        recoveryAttemptOrdinal: input.recoveryAttemptOrdinal,
        resumeSource: input.resumeSource,
        fallbackIndex: input.fallbackIndex,
        runtimeType: input.runtimeType,
        model: input.model,
        isFallback: input.isFallback,
      },
      ownerRecovery: {
        executionOwnerToken: input.executionOwnerToken,
        leaseExpiresAt: input.executionLeaseExpiresAt?.toISOString() ?? null,
      },
      authority: input.authority
        ? {
            authorityVersion: input.authority.authorityVersion,
            requestId: input.authority.requestId,
            bindingDigest: input.authority.bindingDigest,
            ownership: input.authority.ownership,
            lease: input.authority.lease,
            attempt: input.authority.attempt,
            receiptContext: input.authority.receiptContext,
          }
        : null,
      evidence: input.evidence ?? {},
    },
  } satisfies Record<string, unknown>;
}

export function mergeRuntimeAttemptCheckpoint(
  checkpoint: Record<string, unknown> | null,
  runtimeAttempt: ReturnType<typeof buildRuntimeAttemptCheckpoint>,
) {
  return {
    ...(checkpoint ?? {}),
    runtimeAttempt: runtimeAttempt.runtimeAttempt,
  };
}

export async function persistRuntimeAttemptCheckpoint(
  db: Db,
  ref: HeartbeatAttemptRef | null,
  checkpoint: ReturnType<typeof buildRuntimeAttemptCheckpoint>,
) {
  return checkpointHeartbeatRunAttempt(db, ref, checkpoint);
}
