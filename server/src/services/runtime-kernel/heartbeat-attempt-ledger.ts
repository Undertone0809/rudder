import type { Db } from "@rudderhq/db";
import { heartbeatRunAttempts } from "@rudderhq/db";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";

type AttemptStatus = "started" | "waiting_for_network" | "succeeded" | "failed" | "cancelled" | "timed_out";
type ResumeSource = "fresh" | "same_session" | "pristine_replay";

const terminalStatuses: AttemptStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];

export type HeartbeatAttemptRef = {
  id: string;
  attemptIndex: number;
  /** The fence held when this worker admitted the attempt. */
  ownerToken?: string | null;
  attemptEpoch?: number | null;
};

export type HeartbeatAttemptOwnerFence = {
  ownerToken: string;
  attemptEpoch: number;
};

export type BeginHeartbeatAttemptInput = {
  orgId: string;
  runId: string;
  agentId: string;
  attemptIndex: number;
  fallbackIndex: number | null;
  runtimeType: string;
  model: string | null;
  isFallback: boolean;
  resumeSource: ResumeSource;
  ownerToken?: string | null;
  attemptEpoch?: number | null;
};

function normalizeJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function costToCents(costUsd: unknown): number | null {
  return typeof costUsd === "number" && Number.isFinite(costUsd)
    ? Math.round(costUsd * 100)
    : null;
}

/**
 * `undefined` means the caller is using the pre-fence API. Such callers may
 * still mutate legacy rows, but can never mutate a row that has an owner
 * fence. This prevents a plain stale ref from bypassing the CAS predicate.
 */
function ownerFenceFromInput(input: {
  ownerToken?: string | null;
  attemptEpoch?: number | null;
}): HeartbeatAttemptOwnerFence | null | undefined {
  if (input.ownerToken === undefined && input.attemptEpoch === undefined) return undefined;
  if (input.ownerToken === null && input.attemptEpoch === null) return null;

  const ownerToken = input.ownerToken?.trim() ?? "";
  if (!ownerToken || !Number.isInteger(input.attemptEpoch) || (input.attemptEpoch ?? 0) <= 0) {
    throw new Error("Heartbeat attempt owner fence requires a non-empty ownerToken and positive attemptEpoch");
  }
  return { ownerToken, attemptEpoch: input.attemptEpoch as number };
}

function attemptWhere(ref: HeartbeatAttemptRef) {
  const fence = ownerFenceFromInput(ref);
  if (fence === undefined || fence === null) {
    return and(
      eq(heartbeatRunAttempts.id, ref.id),
      isNull(heartbeatRunAttempts.ownerToken),
      isNull(heartbeatRunAttempts.attemptEpoch),
    );
  }
  return and(
    eq(heartbeatRunAttempts.id, ref.id),
    eq(heartbeatRunAttempts.ownerToken, fence.ownerToken),
    eq(heartbeatRunAttempts.attemptEpoch, fence.attemptEpoch),
  );
}

function refFromRow(row: {
  id: string;
  attemptIndex: number;
  ownerToken?: string | null;
  attemptEpoch?: number | null;
}): HeartbeatAttemptRef {
  return {
    id: row.id,
    attemptIndex: row.attemptIndex,
    ownerToken: row.ownerToken ?? null,
    attemptEpoch: row.attemptEpoch ?? null,
  };
}

function fencesMatch(
  row: { ownerToken?: string | null; attemptEpoch?: number | null },
  fence: HeartbeatAttemptOwnerFence | null | undefined,
) {
  if (fence === undefined) return true;
  return (row.ownerToken ?? null) === (fence?.ownerToken ?? null)
    && (row.attemptEpoch ?? null) === (fence?.attemptEpoch ?? null);
}

export async function beginHeartbeatRunAttempt(
  db: Db,
  input: BeginHeartbeatAttemptInput,
): Promise<HeartbeatAttemptRef | null> {
  const existing = await db
    .select({
      id: heartbeatRunAttempts.id,
      attemptIndex: heartbeatRunAttempts.attemptIndex,
      ownerToken: heartbeatRunAttempts.ownerToken,
      attemptEpoch: heartbeatRunAttempts.attemptEpoch,
    })
    .from(heartbeatRunAttempts)
    .where(and(
      eq(heartbeatRunAttempts.runId, input.runId),
      eq(heartbeatRunAttempts.attemptIndex, input.attemptIndex),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const requestedFence = ownerFenceFromInput(input);
  if (existing) {
    return fencesMatch(existing, requestedFence) ? refFromRow(existing) : null;
  }

  const inserted = await db
    .insert(heartbeatRunAttempts)
    .values({
      orgId: input.orgId,
      runId: input.runId,
      agentId: input.agentId,
      attemptIndex: input.attemptIndex,
      fallbackIndex: input.fallbackIndex,
      runtimeType: input.runtimeType,
      model: input.model,
      isFallback: input.isFallback,
      resumeSource: input.resumeSource,
      ownerToken: requestedFence?.ownerToken ?? null,
      attemptEpoch: requestedFence?.attemptEpoch ?? null,
      status: "started",
    })
    .onConflictDoNothing({
      target: [heartbeatRunAttempts.runId, heartbeatRunAttempts.attemptIndex],
    })
    .returning({
      id: heartbeatRunAttempts.id,
      attemptIndex: heartbeatRunAttempts.attemptIndex,
      ownerToken: heartbeatRunAttempts.ownerToken,
      attemptEpoch: heartbeatRunAttempts.attemptEpoch,
    });
  if (inserted[0]) return refFromRow(inserted[0]);

  // A second executor can win the unique insert while the local lease is
  // being fenced. Re-read rather than turning a durable run into a failure.
  return db
    .select({
      id: heartbeatRunAttempts.id,
      attemptIndex: heartbeatRunAttempts.attemptIndex,
      ownerToken: heartbeatRunAttempts.ownerToken,
      attemptEpoch: heartbeatRunAttempts.attemptEpoch,
    })
    .from(heartbeatRunAttempts)
    .where(and(
      eq(heartbeatRunAttempts.runId, input.runId),
      eq(heartbeatRunAttempts.attemptIndex, input.attemptIndex),
    ))
    .limit(1)
    .then((rows) => {
      const row = rows[0] ?? null;
      return row && fencesMatch(row, requestedFence) ? refFromRow(row) : null;
    });
}

export async function checkpointHeartbeatRunAttempt(
  db: Db,
  ref: HeartbeatAttemptRef | null,
  checkpointJson: unknown,
) {
  if (!ref) return null;
  return db
    .update(heartbeatRunAttempts)
    .set({ checkpointJson: normalizeJsonObject(checkpointJson) ?? undefined })
    .where(and(
      attemptWhere(ref),
      notInArray(heartbeatRunAttempts.status, terminalStatuses),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
}

export async function markHeartbeatRunAttemptWaiting(
  db: Db,
  ref: HeartbeatAttemptRef | null,
  input: {
    submissionPhase?: string | null;
    providerThreadId?: string | null;
    providerTurnId?: string | null;
    sessionDisplayId?: string | null;
    sessionParamsJson?: unknown;
    checkpointJson?: unknown;
    errorCode?: string | null;
    error?: string | null;
    suspendedAt?: Date;
  },
) {
  if (!ref) return null;
  return db
    .update(heartbeatRunAttempts)
    .set({
      status: "waiting_for_network",
      submissionPhase: input.submissionPhase as "pre_submission" | "accepted" | "indeterminate" | null | undefined,
      providerThreadId: input.providerThreadId ?? undefined,
      providerTurnId: input.providerTurnId ?? undefined,
      sessionDisplayId: input.sessionDisplayId ?? undefined,
      sessionParamsJson: normalizeJsonObject(input.sessionParamsJson) ?? undefined,
      checkpointJson: normalizeJsonObject(input.checkpointJson) ?? undefined,
      errorCode: input.errorCode ?? undefined,
      error: input.error ?? undefined,
      suspendedAt: input.suspendedAt ?? new Date(),
    })
    .where(and(
      attemptWhere(ref),
      notInArray(heartbeatRunAttempts.status, terminalStatuses),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
}

export async function finishHeartbeatRunAttempt(
  db: Db,
  ref: HeartbeatAttemptRef | null,
  input: {
    status: Exclude<AttemptStatus, "started" | "waiting_for_network">;
    submissionPhase?: string | null;
    providerThreadId?: string | null;
    providerTurnId?: string | null;
    sessionDisplayId?: string | null;
    sessionParamsJson?: unknown;
    usageDeltaJson?: unknown;
    costUsd?: unknown;
    errorCode?: string | null;
    error?: string | null;
    finishedAt?: Date;
  },
) {
  if (!ref) return null;
  return db
    .update(heartbeatRunAttempts)
    .set({
      status: input.status,
      submissionPhase: input.submissionPhase as "pre_submission" | "accepted" | "indeterminate" | null | undefined,
      providerThreadId: input.providerThreadId ?? undefined,
      providerTurnId: input.providerTurnId ?? undefined,
      sessionDisplayId: input.sessionDisplayId ?? undefined,
      sessionParamsJson: normalizeJsonObject(input.sessionParamsJson) ?? undefined,
      usageDeltaJson: normalizeJsonObject(input.usageDeltaJson) ?? undefined,
      costCents: costToCents(input.costUsd),
      errorCode: input.errorCode ?? undefined,
      error: input.error ?? undefined,
      finishedAt: input.finishedAt ?? new Date(),
    })
    .where(and(
      attemptWhere(ref),
      notInArray(heartbeatRunAttempts.status, terminalStatuses),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
}

export async function finishLatestHeartbeatRunAttempt(
  db: Db,
  runId: string,
  input: Parameters<typeof finishHeartbeatRunAttempt>[2],
  ownerFence?: HeartbeatAttemptOwnerFence | null,
) {
  const fence = ownerFence === undefined
    ? undefined
    : ownerFence === null
      ? null
      : ownerFenceFromInput(ownerFence);
  const latest = await db
    .select({
      id: heartbeatRunAttempts.id,
      attemptIndex: heartbeatRunAttempts.attemptIndex,
      ownerToken: heartbeatRunAttempts.ownerToken,
      attemptEpoch: heartbeatRunAttempts.attemptEpoch,
    })
    .from(heartbeatRunAttempts)
    .where(and(
      eq(heartbeatRunAttempts.runId, runId),
      notInArray(heartbeatRunAttempts.status, terminalStatuses),
      ...(fence === undefined
        ? [isNull(heartbeatRunAttempts.ownerToken), isNull(heartbeatRunAttempts.attemptEpoch)]
        : fence === null
          ? [isNull(heartbeatRunAttempts.ownerToken), isNull(heartbeatRunAttempts.attemptEpoch)]
          : [
              eq(heartbeatRunAttempts.ownerToken, fence.ownerToken),
              eq(heartbeatRunAttempts.attemptEpoch, fence.attemptEpoch),
            ]),
    ))
    .orderBy(desc(heartbeatRunAttempts.attemptIndex))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!latest) return null;
  return finishHeartbeatRunAttempt(db, {
    ...refFromRow(latest),
    ...(fence === undefined ? {} : {
      ownerToken: fence?.ownerToken ?? null,
      attemptEpoch: fence?.attemptEpoch ?? null,
    }),
  }, input);
}
