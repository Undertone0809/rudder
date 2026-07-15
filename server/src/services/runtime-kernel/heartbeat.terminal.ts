import type { Db } from "@rudderhq/db";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns } from "@rudderhq/db";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

const TERMINAL_WAKEUP_STATUSES = ["completed", "failed", "cancelled", "timed_out", "skipped", "coalesced"];

export type RunActivityWatermark = {
  updatedAt: Date;
  eventCount: number;
};

export async function transitionHeartbeatRunToTerminal(
  db: Db,
  input: {
    runId: string;
    status: "succeeded" | "failed" | "cancelled" | "timed_out";
    patch: Partial<typeof heartbeatRuns.$inferInsert>;
    expectedStatuses?: string[];
    activityWatermark?: RunActivityWatermark;
  },
) {
  const conditions = [
    eq(heartbeatRuns.id, input.runId),
    inArray(heartbeatRuns.status, input.expectedStatuses ?? ["running"]),
  ];

  if (input.activityWatermark) {
    conditions.push(eq(heartbeatRuns.updatedAt, input.activityWatermark.updatedAt));
    conditions.push(sql`(
      select count(*)::int
      from ${heartbeatRunEvents}
      where ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
    ) = ${input.activityWatermark.eventCount}`);
  }

  return db
    .update(heartbeatRuns)
    .set({
      ...input.patch,
      status: input.status,
      terminalEffectsPending: true,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning()
    .then((rows) => rows[0] ?? null);
}

type RunEvidencePatch = Pick<
  typeof heartbeatRuns.$inferInsert,
  | "exitCode"
  | "signal"
  | "usageJson"
  | "resultJson"
  | "resultSummaryJson"
  | "stdoutExcerpt"
  | "stderrExcerpt"
  | "logBytes"
  | "logSha256"
  | "logCompressed"
>;

export async function reconcileHeartbeatRunEvidence(
  db: Db,
  runId: string,
  patch: Partial<RunEvidencePatch>,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from heartbeat_runs where id = ${runId} for update`);
    const current = await tx
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!current) return null;

    const evidencePatch: Partial<typeof heartbeatRuns.$inferInsert> = {};
    const keys = [
      "exitCode",
      "signal",
      "usageJson",
      "resultJson",
      "resultSummaryJson",
      "stdoutExcerpt",
      "stderrExcerpt",
      "logBytes",
      "logSha256",
      "logCompressed",
    ] as const;
    for (const key of keys) {
      const value = patch[key];
      const canFill = current[key] == null || (key === "logCompressed" && current.logCompressed === false && value === true);
      if (value !== undefined && value !== null && canFill) {
        (evidencePatch as Record<string, unknown>)[key] = value;
      }
    }

    if (Object.keys(evidencePatch).length === 0) return current;
    return tx
      .update(heartbeatRuns)
      .set({ ...evidencePatch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? current);
  });
}

export async function setWakeupStatusMonotonic(
  db: Db,
  wakeupRequestId: string | null | undefined,
  status: string,
  patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
) {
  if (!wakeupRequestId) return null;
  return db
    .update(agentWakeupRequests)
    .set({ status, ...patch, updatedAt: new Date() })
    .where(and(
      eq(agentWakeupRequests.id, wakeupRequestId),
      notInArray(agentWakeupRequests.status, TERMINAL_WAKEUP_STATUSES),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
}
