import type { Db } from "@rudderhq/db";
import { agents, agentWakeupRequests, heartbeatRunEvents, heartbeatRuns } from "@rudderhq/db";
import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const TERMINAL_WAKEUP_STATUSES = ["completed", "failed", "cancelled", "timed_out", "skipped", "coalesced"];

export type RunActivityWatermark = {
  updatedAt: Date;
  eventCount: number;
};

export type TerminalEffectIntent = {
  version: 1;
  automation?: {
    output?: string | null;
    transcript?: unknown[];
  };
  runtime?: {
    adapterResult: Record<string, unknown>;
    legacySessionId: string | null;
    normalizedUsage?: Record<string, number> | null;
    ownsTerminal?: boolean;
  };
  taskSession?: {
    operation: "clear" | "upsert";
    orgId: string;
    agentId: string;
    agentRuntimeType: string;
    taskKey: string;
    sessionParamsJson?: Record<string, unknown> | null;
    sessionDisplayId?: string | null;
    lastRunId?: string | null;
    lastError?: string | null;
  };
  processLossRetry?: boolean;
};

export async function transitionHeartbeatRunToTerminal(
  db: Db,
  input: {
    runId: string;
    status: "succeeded" | "failed" | "cancelled" | "timed_out";
    patch: Partial<typeof heartbeatRuns.$inferInsert>;
    expectedStatuses?: string[];
    activityWatermark?: RunActivityWatermark;
    terminalEffectsPending?: boolean;
    terminalEffectsIntent?: TerminalEffectIntent | null;
    processExitedAt?: Date | null;
  },
) {
  return db.transaction(async (tx) => {
    // Event append and terminal CAS share this lock, establishing one total
    // order between the activity watermark and the terminal transition.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.runId}))`);
    const owner = await tx
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .then((rows) => rows[0] ?? null);
    if (!owner) return null;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-run-state:${owner.agentId}`}))`);
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

    const terminalEffectsPending = input.terminalEffectsPending ?? true;
    const updated = await tx
      .update(heartbeatRuns)
      .set({
        ...input.patch,
        status: input.status,
        processExitedAt: input.processExitedAt,
        terminalEffectsPending,
        terminalEffectsJson: input.terminalEffectsIntent ?? null,
        terminalEffectsClaimToken: null,
        terminalEffectsClaimedAt: null,
        terminalEffectsLastError: null,
        updatedAt: new Date(),
      })
      .where(and(...conditions))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated?.wakeupRequestId) return updated;

    const wakeupStatus = input.status === "succeeded" ? "completed" : input.status;
    await tx
      .update(agentWakeupRequests)
      .set({
        status: wakeupStatus,
        finishedAt: updated.finishedAt ?? new Date(),
        error: updated.error ?? null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentWakeupRequests.id, updated.wakeupRequestId),
        notInArray(agentWakeupRequests.status, TERMINAL_WAKEUP_STATUSES),
      ));
    return updated;
  });
}

export async function markHeartbeatRunProcessExited(db: Db, runId: string, exitedAt = new Date()) {
  return db
    .update(heartbeatRuns)
    .set({ processExitedAt: exitedAt, updatedAt: new Date() })
    .where(and(
      eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.terminalEffectsPending, true),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
}

export async function claimHeartbeatRunTerminalEffects(
  db: Db,
  runId: string,
  opts?: { now?: Date; leaseMs?: number },
) {
  const now = opts?.now ?? new Date();
  const leaseCutoff = new Date(now.getTime() - (opts?.leaseMs ?? 5 * 60_000));
  const claimToken = randomUUID();
  const run = await db
    .update(heartbeatRuns)
    .set({
      terminalEffectsClaimToken: claimToken,
      terminalEffectsClaimedAt: now,
      terminalEffectsAttemptCount: sql`${heartbeatRuns.terminalEffectsAttemptCount} + 1`,
      terminalEffectsLastError: null,
      updatedAt: now,
    })
    .where(and(
      eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.terminalEffectsPending, true),
      isNotNull(heartbeatRuns.processExitedAt),
      or(
        isNull(heartbeatRuns.terminalEffectsClaimToken),
        isNull(heartbeatRuns.terminalEffectsClaimedAt),
        lt(heartbeatRuns.terminalEffectsClaimedAt, leaseCutoff),
      ),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
  return run ? { run, claimToken } : null;
}

export async function renewHeartbeatRunTerminalEffectsClaim(db: Db, runId: string, claimToken: string) {
  return db
    .update(heartbeatRuns)
    .set({ terminalEffectsClaimedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.terminalEffectsPending, true),
      eq(heartbeatRuns.terminalEffectsClaimToken, claimToken),
    ))
    .returning({ id: heartbeatRuns.id })
    .then((rows) => rows[0] ?? null);
}

export async function completeHeartbeatRunTerminalEffects(db: Db, runId: string, claimToken: string) {
  return db.transaction(async (tx) => {
    const current = await tx
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.terminalEffectsPending, true),
        eq(heartbeatRuns.terminalEffectsClaimToken, claimToken),
      ))
      .then((rows) => rows[0] ?? null);
    if (!current) return null;

    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-run-state:${current.agentId}`}))`);
    await tx.execute(sql`select id from agents where id = ${current.agentId} for update`);
    const completedRun = await tx
      .update(heartbeatRuns)
      .set({
        terminalEffectsPending: false,
        terminalEffectsClaimToken: null,
        terminalEffectsClaimedAt: null,
        terminalEffectsLastError: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.terminalEffectsPending, true),
        eq(heartbeatRuns.terminalEffectsClaimToken, claimToken),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!completedRun) return null;

    const [{ activeCount }] = await tx
      .select({ activeCount: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, current.agentId),
        or(
          eq(heartbeatRuns.status, "running"),
          eq(heartbeatRuns.terminalEffectsPending, true),
        ),
      ));
    const latestTerminal = await tx
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, current.agentId),
        inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out"]),
      ))
      .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const currentAgent = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, current.agentId))
      .then((rows) => rows[0] ?? null);
    let updatedAgent = currentAgent;
    if (
      currentAgent
      && currentAgent.status !== "paused"
      && currentAgent.status !== "terminated"
      && currentAgent.status !== "pending_approval"
    ) {
      const nextStatus = Number(activeCount ?? 0) > 0
        ? "running"
        : latestTerminal?.status === "succeeded" || latestTerminal?.status === "cancelled"
          ? "idle"
          : "error";
      updatedAgent = await tx
        .update(agents)
        .set({ status: nextStatus, lastHeartbeatAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(agents.id, current.agentId),
          notInArray(agents.status, ["paused", "terminated", "pending_approval"]),
        ))
        .returning()
        .then(async (rows) => rows[0] ?? await tx
          .select()
          .from(agents)
          .where(eq(agents.id, current.agentId))
          .then((currentRows) => currentRows[0] ?? currentAgent));
    }
    return { run: completedRun, agent: updatedAgent };
  });
}

export async function releaseHeartbeatRunTerminalEffectsClaim(
  db: Db,
  runId: string,
  claimToken: string,
  error: unknown,
) {
  const message = error instanceof Error ? error.message : String(error);
  return db
    .update(heartbeatRuns)
    .set({
      terminalEffectsClaimToken: null,
      terminalEffectsClaimedAt: null,
      terminalEffectsLastError: message.slice(0, 4_000),
      updatedAt: new Date(),
    })
    .where(and(
      eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.terminalEffectsClaimToken, claimToken),
    ));
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

export async function reconcileHeartbeatRunTerminalEffectsIntent(
  db: Db,
  runId: string,
  intent: TerminalEffectIntent,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from heartbeat_runs where id = ${runId} for update`);
    const current = await tx
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!current?.terminalEffectsPending) return current;
    const existing = (current.terminalEffectsJson ?? {}) as TerminalEffectIntent;
    const merged: TerminalEffectIntent = {
      ...existing,
      version: 1,
      automation: existing.automation ?? intent.automation,
      runtime: existing.runtime ?? intent.runtime,
      taskSession: existing.taskSession ?? intent.taskSession,
      processLossRetry: existing.processLossRetry ?? intent.processLossRetry,
    };
    return tx
      .update(heartbeatRuns)
      .set({ terminalEffectsJson: merged, updatedAt: new Date() })
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.terminalEffectsPending, true),
      ))
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
