import type { Db } from "@rudderhq/db";
import { heartbeatRunAttempts } from "@rudderhq/db";
import { and, desc, eq, notInArray } from "drizzle-orm";

type AttemptStatus = "started" | "waiting_for_network" | "succeeded" | "failed" | "cancelled" | "timed_out";
type ResumeSource = "fresh" | "same_session" | "pristine_replay";

const terminalStatuses: AttemptStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];

export type HeartbeatAttemptRef = {
  id: string;
  attemptIndex: number;
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

function attemptWhere(ref: HeartbeatAttemptRef) {
  return eq(heartbeatRunAttempts.id, ref.id);
}

export async function beginHeartbeatRunAttempt(
  db: Db,
  input: BeginHeartbeatAttemptInput,
): Promise<HeartbeatAttemptRef | null> {
  const existing = await db
    .select({ id: heartbeatRunAttempts.id, attemptIndex: heartbeatRunAttempts.attemptIndex })
    .from(heartbeatRunAttempts)
    .where(and(
      eq(heartbeatRunAttempts.runId, input.runId),
      eq(heartbeatRunAttempts.attemptIndex, input.attemptIndex),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return existing;

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
      status: "started",
    })
    .onConflictDoNothing({
      target: [heartbeatRunAttempts.runId, heartbeatRunAttempts.attemptIndex],
    })
    .returning({ id: heartbeatRunAttempts.id, attemptIndex: heartbeatRunAttempts.attemptIndex });
  if (inserted[0]) return inserted[0];

  // A second executor can win the unique insert while the local lease is
  // being fenced. Re-read rather than turning a durable run into a failure.
  return db
    .select({ id: heartbeatRunAttempts.id, attemptIndex: heartbeatRunAttempts.attemptIndex })
    .from(heartbeatRunAttempts)
    .where(and(
      eq(heartbeatRunAttempts.runId, input.runId),
      eq(heartbeatRunAttempts.attemptIndex, input.attemptIndex),
    ))
    .limit(1)
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
    .where(attemptWhere(ref))
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
) {
  const latest = await db
    .select({ id: heartbeatRunAttempts.id, attemptIndex: heartbeatRunAttempts.attemptIndex })
    .from(heartbeatRunAttempts)
    .where(and(
      eq(heartbeatRunAttempts.runId, runId),
      notInArray(heartbeatRunAttempts.status, terminalStatuses),
    ))
    .orderBy(desc(heartbeatRunAttempts.attemptIndex))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return finishHeartbeatRunAttempt(db, latest, input);
}
