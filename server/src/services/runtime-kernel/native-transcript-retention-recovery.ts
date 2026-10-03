import type { Db } from "@rudderhq/db";
import { heartbeatRuns } from "@rudderhq/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { logger } from "../../middleware/logger.js";
import { getRunLogStore } from "../run-log-store.js";
import { retainNativeHeartbeatResultJson } from "./heartbeat-transcript-retention.js";
import { compactHeartbeatAdapterInvokePayload } from "./heartbeat.execute-native-retention.js";
import { createHistoricalTranscriptReader } from "./historical-transcript-reader.js";
import {
  cleanSealedNativeTranscriptMirrors,
  markNativeTranscriptRetentionIncomplete,
  matchesNativeTranscriptRecoverySnapshot,
  proveSealedNativeRunTranscript,
  selectAndVerifyNativeTranscriptCleanupState,
  type NativeTranscriptRecoveryLocation,
} from "./native-transcript-retention.js";
import { getTranscriptObjectStore } from "./transcript-object-store.js";

const MAX_RECOVERIES_PER_TICK = 3;
const RECOVERY_LEASE_MS = 30 * 60 * 1000;
const MIN_RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseRecovery(value: unknown): NativeTranscriptRecoveryLocation[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: NativeTranscriptRecoveryLocation[] = [];
  for (const entry of value) {
    const item = record(entry);
    if (item?.kind === "transcript_supplement"
      && nonEmpty(item.objectRef) && nonEmpty(item.spanId)) {
      parsed.push({ kind: "transcript_supplement", objectRef: item.objectRef, spanId: item.spanId });
      continue;
    }
    if (item?.kind === "transcript_object"
      && nonEmpty(item.objectRef) && nonEmpty(item.spanId) && nonEmpty(item.stageId)) {
      parsed.push({ kind: "transcript_object", objectRef: item.objectRef, spanId: item.spanId, stageId: item.stageId });
      continue;
    }
    if (item?.kind === "run_log"
      && item.store === "local_file"
      && nonEmpty(item.logRef)
      && nonEmpty(item.sha256)
      && /^[a-f0-9]{64}$/u.test(item.sha256)
      && nonEmpty(item.stageId)) {
      parsed.push({
        kind: "run_log",
        store: "local_file",
        logRef: item.logRef,
        sha256: item.sha256,
        stageId: item.stageId,
      });
      continue;
    }
    return null;
  }
  return parsed;
}

function retryDelay(retryCount: number) {
  return Math.min(MAX_RETRY_DELAY_MS, MIN_RETRY_DELAY_MS * 2 ** Math.min(retryCount, 6));
}

function retryableStateSql() {
  return sql`${heartbeatRuns.contextSnapshot}->'nativeTranscriptRetention'->>'status' in ('cleanup_failed', 'cleanup_pending')`;
}

function retryDueSql(now: Date) {
  const timestamp = now.toISOString();
  return sql`(
    nullif(${heartbeatRuns.contextSnapshot}->'nativeTranscriptRetention'->>'retryAfter', '') is null
    or ${heartbeatRuns.contextSnapshot}->'nativeTranscriptRetention'->>'retryAfter' <= ${timestamp}
  ) and (
    nullif(${heartbeatRuns.contextSnapshot}->'nativeTranscriptRetention'->'cleanupLease'->>'expiresAt', '') is null
    or ${heartbeatRuns.contextSnapshot}->'nativeTranscriptRetention'->'cleanupLease'->>'expiresAt' <= ${timestamp}
  )`;
}

async function claimRecovery(input: {
  db: Db;
  candidate: { orgId: string; id: string; contextSnapshot: unknown };
  now: Date;
}) {
  const snapshot = record(input.candidate.contextSnapshot);
  const retention = record(snapshot?.nativeTranscriptRetention) ?? {};
  const priorCount = Number.isInteger(retention.retryCount) && Number(retention.retryCount) >= 0
    ? Number(retention.retryCount)
    : 0;
  const retryCount = priorCount + 1;
  const retryAfter = new Date(input.now.getTime() + retryDelay(priorCount)).toISOString();
  const lease = {
    token: randomUUID(),
    expiresAt: new Date(input.now.getTime() + RECOVERY_LEASE_MS).toISOString(),
  };
  const [claimed] = await input.db.update(heartbeatRuns).set({
    contextSnapshot: sql`jsonb_set(
      coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb),
      '{nativeTranscriptRetention}',
      coalesce(${heartbeatRuns.contextSnapshot}->'nativeTranscriptRetention', '{}'::jsonb)
        || jsonb_build_object(
          'cleanupLease', ${JSON.stringify(lease)}::jsonb,
          'retryCount', ${retryCount}::int,
          'retryAfter', ${retryAfter}::text
        ),
      true
    )`,
    updatedAt: input.now,
  }).where(and(
    eq(heartbeatRuns.orgId, input.candidate.orgId),
    eq(heartbeatRuns.id, input.candidate.id),
    eq(heartbeatRuns.status, "succeeded"),
    retryableStateSql(),
    retryDueSql(input.now),
  )).returning({ contextSnapshot: heartbeatRuns.contextSnapshot });
  return claimed ? { token: lease.token, contextSnapshot: claimed.contextSnapshot } : null;
}

async function recordRetryFailure(input: {
  db: Db;
  orgId: string;
  runId: string;
  token: string;
  now: Date;
  reason: string;
}) {
  const reason = input.reason.slice(0, 240);
  const [updated] = await input.db.update(heartbeatRuns).set({
    contextSnapshot: sql`jsonb_set(
      coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb),
      '{nativeTranscriptRetention}',
      (coalesce(${heartbeatRuns.contextSnapshot}->'nativeTranscriptRetention', '{}'::jsonb) - 'cleanupLease')
        || jsonb_build_object('status', 'cleanup_failed', 'reason', ${reason}::text),
      true
    )`,
    updatedAt: input.now,
  }).where(and(
    eq(heartbeatRuns.orgId, input.orgId),
    eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.status, "succeeded"),
    sql`${heartbeatRuns.contextSnapshot}->'nativeTranscriptRetention'->'cleanupLease'->>'token' = ${input.token}`,
  )).returning({ id: heartbeatRuns.id });
  return Boolean(updated);
}

function readRetention(contextSnapshot: unknown) {
  return record(record(contextSnapshot)?.nativeTranscriptRetention);
}

async function proveRetryableRun(input: {
  db: Db;
  orgId: string;
  runId: string;
  retention: Record<string, unknown>;
}) {
  const proofResult = await proveSealedNativeRunTranscript({
    db: input.db,
    reader: createHistoricalTranscriptReader(input.db, { includeObjects: false }),
    orgId: input.orgId,
    runId: input.runId,
  });
  if (!proofResult.ok) return { ok: false as const, reason: proofResult.reason };
  const recovery = parseRecovery(input.retention.recovery ?? []);
  if (!recovery || !matchesNativeTranscriptRecoverySnapshot({
    snapshot: input.retention,
    proof: proofResult.proof,
    recovery,
  })) return { ok: false as const, reason: "cleanup_recovery_proof_mismatch" };
  return { ok: true as const, proof: proofResult.proof, recovery };
}

async function retryCleanupFromPrimary(input: {
  db: Db;
  orgId: string;
  runId: string;
  token: string;
  now: Date;
  retention: Record<string, unknown>;
}) {
  const verified = await proveRetryableRun(input);
  if (!verified.ok) return { completed: false, reason: verified.reason };
  const result = await cleanSealedNativeTranscriptMirrors({
    db: input.db,
    proof: verified.proof,
    runLogStore: getRunLogStore(),
    transcriptObjectStore: getTranscriptObjectStore(),
    readerFactory: (database) => createHistoricalTranscriptReader(database, { includeObjects: false }),
    retainResultJson: retainNativeHeartbeatResultJson,
    compactAdapterInvokePayload: compactHeartbeatAdapterInvokePayload,
  });
  if (!result.cleaned) {
    await markNativeTranscriptRetentionIncomplete({
      db: input.db,
      orgId: input.orgId,
      runId: input.runId,
      status: "cleanup_failed",
      reason: result.reason,
      recovery: result.recovery ?? [],
      proof: verified.proof,
    });
    return { completed: false, reason: result.reason };
  }
  return { completed: true as const };
}

async function retryStagedRecovery(input: {
  db: Db;
  orgId: string;
  runId: string;
  token: string;
  now: Date;
  retention: Record<string, unknown>;
}) {
  const objectStore = getTranscriptObjectStore();
  const runLogStore = getRunLogStore();
  const result = await input.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.runId}))`);
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.orgId, input.orgId),
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.status, "succeeded"),
    )).for("update").limit(1);
    const retention = readRetention(run?.contextSnapshot);
    if (!run || !retention || !["cleanup_failed", "cleanup_pending"].includes(String(retention.status))
      || record(retention.cleanupLease)?.token !== input.token
      || run.executionOwnerToken !== null || run.terminalEffectsPending || !run.processExitedAt) {
      return { completed: false as const, reason: "cleanup_recovery_identity_changed" };
    }
    const recovery = parseRecovery(retention.recovery);
    if (!recovery || recovery.length === 0) {
      return { completed: false as const, reason: "cleanup_recovery_location_missing" };
    }

    const verified = await proveRetryableRun({
      db: tx as unknown as Db,
      orgId: run.orgId,
      runId: run.id,
      retention,
    });
    if (!verified.ok) return { completed: false as const, reason: verified.reason };
    const prepared = await selectAndVerifyNativeTranscriptCleanupState(tx, verified.proof);
    if (!prepared) return { completed: false as const, reason: "cleanup_recovery_identity_changed" };

    const spanById = new Map(verified.proof.spans.map((span) => [span.spanId, span] as const));
    const attachedObjects = verified.proof.spans.filter((span) => span.supplementalObjectRef);
    const stagedRecoveryWasNotCommitted = Boolean(run.logRef || run.logStore)
      || attachedObjects.length > 0;
    if (stagedRecoveryWasNotCommitted) {
      for (const item of recovery) {
        if (item.kind === "transcript_supplement") {
          const span = spanById.get(item.spanId);
          if (!span || span.supplementalObjectRef !== item.objectRef) {
            return { completed: false as const, reason: "cleanup_recovery_supplement_identity_changed" };
          }
          continue;
        }
        if (item.kind === "transcript_object") {
          const span = spanById.get(item.spanId);
          if (!span || span.supplementalObjectRef !== item.objectRef || !objectStore.restoreStagedRemoval) {
            return { completed: false as const, reason: "cleanup_recovery_object_identity_changed" };
          }
          await objectStore.restoreStagedRemoval({
            objectRef: item.objectRef,
            orgId: run.orgId,
            runId: run.id,
            spanId: span.spanId,
            ownerToken: span.ownerToken,
            allowOwnerRecovery: true,
            stageId: item.stageId,
          });
          continue;
        }
        if (run.logStore !== item.store || run.logRef !== item.logRef
          || run.logSha256 !== item.sha256 || !runLogStore.restoreStagedRunRemoval) {
          return { completed: false as const, reason: "cleanup_recovery_run_log_identity_changed" };
        }
        await runLogStore.restoreStagedRunRemoval({
          orgId: run.orgId,
          agentId: run.agentId,
          runId: run.id,
          handle: { store: item.store, logRef: item.logRef },
          expectedSha256: item.sha256!,
          stageId: item.stageId,
        });
      }
      return { completed: false as const, restored: true, reason: "cleanup_staging_restored_for_retry" };
    }

    for (const item of recovery) {
      if (item.kind === "transcript_supplement") {
        return { completed: false, reason: "cleanup_recovery_supplement_not_staged" };
      }
      if (item.kind === "transcript_object") {
        const span = spanById.get(item.spanId);
        if (!span || !objectStore.purgeStagedRemoval) {
          return { completed: false as const, reason: "cleanup_recovery_object_identity_changed" };
        }
        await objectStore.purgeStagedRemoval({
          objectRef: item.objectRef,
          orgId: run.orgId,
          runId: run.id,
          spanId: span.spanId,
          ownerToken: span.ownerToken,
          allowOwnerRecovery: true,
          stageId: item.stageId,
        });
        continue;
      }
      if (run.logStore !== null || run.logRef !== null || run.logSha256 !== item.sha256
        || item.store !== "local_file" || !runLogStore.purgeStagedRunRemoval) {
        return { completed: false as const, reason: "cleanup_recovery_run_log_identity_changed" };
      }
      await runLogStore.purgeStagedRunRemoval({
        orgId: run.orgId,
        agentId: run.agentId,
        runId: run.id,
        handle: { store: item.store, logRef: item.logRef },
        expectedSha256: item.sha256!,
        stageId: item.stageId,
      });
    }

    const [updated] = await tx.update(heartbeatRuns).set({
      contextSnapshot: sql`jsonb_set(
        coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb),
        '{nativeTranscriptRetention}',
        (coalesce(${heartbeatRuns.contextSnapshot}->'nativeTranscriptRetention', '{}'::jsonb)
          - 'reason' - 'cleanupLease' - 'retryAfter')
          || jsonb_build_object(
            'status', 'reference_only',
            'recovery', '[]'::jsonb,
            'cleanedAt', ${input.now.toISOString()}::text
          ),
        true
      )`,
      updatedAt: input.now,
    }).where(and(
      eq(heartbeatRuns.orgId, input.orgId),
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.status, "succeeded"),
      isNull(heartbeatRuns.executionOwnerToken),
      sql`${heartbeatRuns.contextSnapshot}->'nativeTranscriptRetention'->'cleanupLease'->>'token' = ${input.token}`,
    )).returning({ id: heartbeatRuns.id });
    return updated ? { completed: true as const } : { completed: false as const, reason: "cleanup_completion_identity_changed" };
  });

  if (result.restored) {
    return retryCleanupFromPrimary({ ...input, retention: input.retention });
  }
  return result;
}

export async function retryFailedNativeTranscriptCleanup(
  db: Db,
  options: { now?: Date; limit?: number } = {},
) {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(MAX_RECOVERIES_PER_TICK, Math.floor(options.limit ?? MAX_RECOVERIES_PER_TICK)));
  const candidates = await db.select({
    orgId: heartbeatRuns.orgId,
    id: heartbeatRuns.id,
    contextSnapshot: heartbeatRuns.contextSnapshot,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.status, "succeeded"),
    retryableStateSql(),
    retryDueSql(now),
  )).orderBy(asc(heartbeatRuns.updatedAt)).limit(limit);

  let attempted = 0;
  let recovered = 0;
  for (const candidate of candidates) {
    const claim = await claimRecovery({ db, candidate, now });
    if (!claim) continue;
    attempted += 1;
    const retention = readRetention(claim.contextSnapshot);
    let outcome: { completed: boolean; reason?: string };
    try {
      if (!retention) {
        outcome = { completed: false, reason: "cleanup_recovery_state_missing" };
      } else if (retention.recovery === undefined || Array.isArray(retention.recovery)) {
        const recovery = parseRecovery(retention.recovery ?? []);
        if (!recovery) {
          outcome = { completed: false, reason: "cleanup_recovery_state_invalid" };
        } else if (recovery.length > 0) {
          outcome = await retryStagedRecovery({
            db,
            orgId: candidate.orgId,
            runId: candidate.id,
            token: claim.token,
            now,
            retention,
          });
        } else {
          outcome = await retryCleanupFromPrimary({
            db,
            orgId: candidate.orgId,
            runId: candidate.id,
            token: claim.token,
            now,
            retention,
          });
        }
      } else {
        outcome = { completed: false, reason: "cleanup_recovery_state_invalid" };
      }
    } catch (error) {
      outcome = {
        completed: false,
        reason: error instanceof Error ? error.message : "cleanup_recovery_failed",
      };
    }
    if (outcome.completed) {
      recovered += 1;
      continue;
    }
    const reason = outcome.reason ?? "cleanup_recovery_failed";
    await recordRetryFailure({
      db,
      orgId: candidate.orgId,
      runId: candidate.id,
      token: claim.token,
      now,
      reason,
    });
    logger.warn({ runId: candidate.id, reason }, "Native transcript cleanup recovery did not complete");
  }
  return { attempted, recovered };
}
