// @ts-nocheck
import { agentWakeupRequests, heartbeatRuns } from "@rudderhq/db";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";

export async function claimAvailableQueuedRuns(input: {
  db: any;
  agentId: string;
  availableSlots: number;
  activeRunExecutions: Set<string>;
  runAbortControllers: Map<string, AbortController>;
  claimQueuedRun: (run: any) => Promise<any>;
  executeRun: (runId: string, opts: { executionReserved: boolean }) => Promise<unknown>;
  beforeRunClaim?: (run: any) => Promise<void> | void;
}) {
  const claimedRuns: any[] = [];
  const attemptedRunIds = new Set<string>();
  let remainingSlots = input.availableSlots;
  while (remainingSlots > 0) {
    const queuedRuns = await input.db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, input.agentId),
          eq(heartbeatRuns.status, "queued"),
          sql`(
            ${heartbeatRuns.wakeupRequestId} is null
            or exists (
              select 1
              from ${agentWakeupRequests}
              where ${agentWakeupRequests.id} = ${heartbeatRuns.wakeupRequestId}
                and ${agentWakeupRequests.requestedAt} <= now()
            )
          )`,
          ...(attemptedRunIds.size > 0 ? [notInArray(heartbeatRuns.id, [...attemptedRunIds])] : []),
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt))
      .limit(remainingSlots);
    if (queuedRuns.length === 0) break;

    let madeProgress = false;
    for (const queuedRun of queuedRuns) {
      attemptedRunIds.add(queuedRun.id);
      if (input.activeRunExecutions.has(queuedRun.id)) continue;
      input.activeRunExecutions.add(queuedRun.id);
      input.runAbortControllers.set(queuedRun.id, new AbortController());
      try {
        await input.beforeRunClaim?.(queuedRun);
        const claimed = await input.claimQueuedRun(queuedRun);
        if (claimed) {
          claimedRuns.push(claimed);
          remainingSlots -= 1;
          madeProgress = true;
          void input.executeRun(claimed.id, { executionReserved: true }).catch((error) => {
            logger.error({ err: error, runId: claimed.id }, "queued heartbeat execution failed");
          });
        } else {
          input.runAbortControllers.delete(queuedRun.id);
          input.activeRunExecutions.delete(queuedRun.id);
          const stillQueued = await input.db
            .select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, queuedRun.id))
            .then((rows: Array<{ status: string }>) => rows[0]?.status === "queued");
          madeProgress = madeProgress || !stillQueued;
          if (stillQueued) break;
        }
      } catch (error) {
        input.runAbortControllers.delete(queuedRun.id);
        input.activeRunExecutions.delete(queuedRun.id);
        throw error;
      }
    }
    if (!madeProgress) break;
  }
  return claimedRuns;
}
