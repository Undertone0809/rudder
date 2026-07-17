import type { Db } from "@rudderhq/db";
import { entityCleanupJobs } from "@rudderhq/db";
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";
import { getRunLogStore } from "./run-log-store.js";
import { getWorkspaceOperationLogStore } from "./workspace-operation-log-store.js";
import { stopRuntimeServiceForDeletion } from "./workspace-runtime.services.js";

export type EntityCleanupArtifactType =
  | "storage_object"
  | "run_log"
  | "workspace_operation_log"
  | "runtime_service";

export type EntityCleanupArtifact = {
  artifactType: EntityCleanupArtifactType;
  artifactRef: string;
};

const DEFAULT_BATCH_SIZE = 100;
const CLAIM_TIMEOUT_MS = 60_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;

export async function enqueueEntityCleanupJobs(
  db: Db,
  orgId: string,
  artifacts: EntityCleanupArtifact[],
) {
  const uniqueArtifacts = [...new Map(
    artifacts
      .filter((artifact) => artifact.artifactRef.length > 0)
      .map((artifact) => [`${artifact.artifactType}:${artifact.artifactRef}`, artifact]),
  ).values()];
  if (uniqueArtifacts.length === 0) return [];
  return db
    .insert(entityCleanupJobs)
    .values(uniqueArtifacts.map((artifact) => ({ orgId, ...artifact })))
    .onConflictDoNothing({
      target: [
        entityCleanupJobs.orgId,
        entityCleanupJobs.artifactType,
        entityCleanupJobs.artifactRef,
      ],
    })
    .returning();
}

export function completeEntityCleanupJob(
  db: Db,
  orgId: string,
  artifact: EntityCleanupArtifact,
) {
  return db
    .delete(entityCleanupJobs)
    .where(and(
      eq(entityCleanupJobs.orgId, orgId),
      eq(entityCleanupJobs.artifactType, artifact.artifactType),
      eq(entityCleanupJobs.artifactRef, artifact.artifactRef),
    ));
}

async function processArtifact(storage: StorageService, job: typeof entityCleanupJobs.$inferSelect) {
  switch (job.artifactType as EntityCleanupArtifactType) {
    case "storage_object":
      await storage.deleteObject(job.orgId, job.artifactRef);
      return;
    case "run_log":
      await getRunLogStore().remove({ store: "local_file", logRef: job.artifactRef });
      return;
    case "workspace_operation_log":
      await getWorkspaceOperationLogStore().remove({ store: "local_file", logRef: job.artifactRef });
      return;
    case "runtime_service":
      await stopRuntimeServiceForDeletion(job.artifactRef);
      return;
    default:
      throw new Error(`Unsupported entity cleanup artifact type: ${job.artifactType}`);
  }
}

export async function processEntityCleanupJobs(
  db: Db,
  storage: StorageService,
  options: { limit?: number; now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_BATCH_SIZE, DEFAULT_BATCH_SIZE));
  const jobs = await db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(entityCleanupJobs)
      .where(lte(entityCleanupJobs.nextAttemptAt, now))
      .orderBy(asc(entityCleanupJobs.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    const claimedUntil = new Date(now.getTime() + CLAIM_TIMEOUT_MS);
    await tx
      .update(entityCleanupJobs)
      .set({
        nextAttemptAt: claimedUntil,
        updatedAt: now,
      })
      .where(inArray(entityCleanupJobs.id, due.map((job) => job.id)));
    return due;
  });

  let processed = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await processArtifact(storage, job);
      await db.delete(entityCleanupJobs).where(eq(entityCleanupJobs.id, job.id));
      processed += 1;
    } catch (error) {
      const attemptCount = job.attemptCount + 1;
      const retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, 1_000 * (2 ** Math.min(attemptCount, 12)));
      await db
        .update(entityCleanupJobs)
        .set({
          attemptCount,
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
          nextAttemptAt: new Date(now.getTime() + retryDelayMs),
          updatedAt: now,
        })
        .where(eq(entityCleanupJobs.id, job.id));
      failed += 1;
    }
  }
  return { processed, failed };
}

export function startEntityCleanupWorker(
  db: Db,
  storage: StorageService,
  intervalMs = 30_000,
) {
  let stopped = false;
  let running = false;
  const sweep = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const result = await processEntityCleanupJobs(db, storage);
      if (result.failed > 0) {
        logger.warn(result, "entity cleanup jobs remain pending after retry");
      }
    } catch (error) {
      logger.warn({ err: error }, "entity cleanup job sweep failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void sweep(); }, intervalMs);
  timer.unref?.();
  void sweep();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
