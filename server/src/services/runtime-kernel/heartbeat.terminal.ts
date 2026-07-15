import type { Db } from "@rudderhq/db";
import { activityLog, agents, agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issues } from "@rudderhq/db";
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const TERMINAL_WAKEUP_STATUSES = ["completed", "failed", "cancelled", "timed_out", "skipped", "coalesced"];
export const RUN_EXECUTION_LEASE_MS = 5 * 60_000;
export const RUN_EXECUTION_LEASE_RENEW_INTERVAL_MS = 60_000;
export const TERMINAL_EFFECT_MAX_ATTEMPTS = 5;
const TERMINAL_EFFECT_BACKOFF_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000] as const;
const MAX_TERMINAL_OUTPUT_CHARS = 32_000;
const MAX_TERMINAL_SESSION_PARAMS_BYTES = 64 * 1024;

export type TerminalEffectName =
  | "automation_chat"
  | "runtime_cost"
  | "task_session"
  | "process_loss_retry"
  | "issue_release";

export type RunActivityWatermark = {
  updatedAt: Date;
  eventCount: number;
};

export type TerminalEffectIntent = {
  version: 1 | 2;
  automation?: {
    output?: string | null;
    /** Legacy input only. It is intentionally not persisted in v2. */
    transcript?: unknown[];
  };
  runtime?: {
    /** Legacy input only. It is normalized to bounded scalar fields. */
    adapterResult?: Record<string, unknown>;
    errorMessage?: string | null;
    provider?: string | null;
    biller?: string | null;
    model?: string | null;
    billingType?: string | null;
    costUsd?: number | null;
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

function boundedString(value: unknown, maxChars = MAX_TERMINAL_OUTPUT_CHARS) {
  if (typeof value !== "string") return null;
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function boundedRecord(value: unknown, maxBytes: number): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > maxBytes) return null;
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function normalizeTerminalEffectIntent(intent: TerminalEffectIntent | null | undefined): TerminalEffectIntent {
  const runtimeInput = intent?.runtime;
  const adapterResult = runtimeInput?.adapterResult
    && typeof runtimeInput.adapterResult === "object"
    && !Array.isArray(runtimeInput.adapterResult)
    ? runtimeInput.adapterResult
    : {};
  const normalizedUsage = boundedRecord(runtimeInput?.normalizedUsage, 8 * 1024) as Record<string, number> | null;
  const taskSession = intent?.taskSession
    ? {
        ...intent.taskSession,
        sessionParamsJson: boundedRecord(intent.taskSession.sessionParamsJson, MAX_TERMINAL_SESSION_PARAMS_BYTES),
        sessionDisplayId: boundedString(intent.taskSession.sessionDisplayId, 4_000),
        lastError: boundedString(intent.taskSession.lastError, 4_000),
      }
    : undefined;
  return {
    version: 2,
    ...(intent?.automation
      ? { automation: { output: boundedString(intent.automation.output) } }
      : {}),
    ...(runtimeInput
      ? {
          runtime: {
            errorMessage: boundedString(runtimeInput.errorMessage ?? adapterResult.errorMessage, 4_000),
            provider: boundedString(runtimeInput.provider ?? adapterResult.provider, 500),
            biller: boundedString(runtimeInput.biller ?? adapterResult.biller, 500),
            model: boundedString(runtimeInput.model ?? adapterResult.model, 500),
            billingType: boundedString(runtimeInput.billingType ?? adapterResult.billingType, 100),
            costUsd: typeof (runtimeInput.costUsd ?? adapterResult.costUsd) === "number"
              ? Number(runtimeInput.costUsd ?? adapterResult.costUsd)
              : null,
            legacySessionId: boundedString(runtimeInput.legacySessionId, 4_000),
            normalizedUsage,
            ownsTerminal: runtimeInput.ownsTerminal !== false,
          },
        }
      : {}),
    ...(taskSession ? { taskSession } : {}),
    ...(intent?.processLossRetry ? { processLossRetry: true } : {}),
  };
}

export function terminalEffectNames(intent: TerminalEffectIntent): TerminalEffectName[] {
  return [
    ...(intent.automation ? ["automation_chat" as const] : []),
    ...(intent.runtime ? ["runtime_cost" as const] : []),
    ...(intent.taskSession ? ["task_session" as const] : []),
    ...(intent.processLossRetry ? ["process_loss_retry" as const] : []),
    "issue_release",
  ];
}

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
    expectedExecutionOwnerToken?: string | null;
  },
) {
  return db.transaction(async (tx) => {
    // Event append and terminal CAS share this lock, establishing one total
    // order between the activity watermark and the terminal transition.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.runId}))`);
    const owner = await tx
      .select({
        agentId: heartbeatRuns.agentId,
        processExitedAt: heartbeatRuns.processExitedAt,
      })
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
    if (input.expectedExecutionOwnerToken) {
      conditions.push(eq(heartbeatRuns.executionOwnerToken, input.expectedExecutionOwnerToken));
    }

    const terminalEffectsPending = input.terminalEffectsPending ?? true;
    const terminalEffectsIntent = normalizeTerminalEffectIntent(input.terminalEffectsIntent);
    const updated = await tx
      .update(heartbeatRuns)
      .set({
        ...input.patch,
        status: input.status,
        ...(input.processExitedAt === undefined
          ? {}
          : { processExitedAt: owner.processExitedAt ?? input.processExitedAt }),
        executionOwnerToken: null,
        executionLeaseExpiresAt: null,
        terminalEffectsPending,
        terminalEffectsJson: terminalEffectsPending ? terminalEffectsIntent : null,
        terminalEffectsCompletedJson: null,
        terminalEffectsDeadLetteredJson: null,
        terminalEffectsAttemptsJson: null,
        terminalEffectsNextAttemptAt: null,
        terminalEffectsDeadLetteredAt: null,
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
      isNull(heartbeatRuns.processExitedAt),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
}

export async function renewHeartbeatRunExecutionLease(
  db: Db,
  runId: string,
  ownerToken: string,
  now = new Date(),
) {
  return db
    .update(heartbeatRuns)
    .set({
      executionLeaseExpiresAt: new Date(now.getTime() + RUN_EXECUTION_LEASE_MS),
      updatedAt: now,
    })
    .where(and(
      eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.status, "running"),
      eq(heartbeatRuns.executionOwnerToken, ownerToken),
    ))
    .returning({ id: heartbeatRuns.id })
    .then((rows) => rows[0] ?? null);
}

export async function claimExpiredHeartbeatRunExecution(
  db: Db,
  runId: string,
  opts?: { now?: Date; recoveryCutoff?: Date },
) {
  const now = opts?.now ?? new Date();
  const recoveryCutoff = opts?.recoveryCutoff ?? now;
  const ownerToken = randomUUID();
  const run = await db
    .update(heartbeatRuns)
    .set({
      executionOwnerToken: ownerToken,
      executionLeaseExpiresAt: new Date(now.getTime() + RUN_EXECUTION_LEASE_MS),
      updatedAt: now,
    })
    .where(and(
      eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.status, "running"),
      lt(heartbeatRuns.createdAt, recoveryCutoff),
      or(
        isNull(heartbeatRuns.executionLeaseExpiresAt),
        lte(heartbeatRuns.executionLeaseExpiresAt, now),
      ),
    ))
    .returning()
    .then((rows) => rows[0] ?? null);
  return run ? { run, ownerToken } : null;
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
        isNull(heartbeatRuns.terminalEffectsNextAttemptAt),
        lte(heartbeatRuns.terminalEffectsNextAttemptAt, now),
      ),
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

export async function checkpointHeartbeatRunTerminalEffect(
  db: Db,
  runId: string,
  claimToken: string,
  effect: TerminalEffectName,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from heartbeat_runs where id = ${runId} for update`);
    const current = await tx
      .select({ completed: heartbeatRuns.terminalEffectsCompletedJson })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.terminalEffectsPending, true),
        eq(heartbeatRuns.terminalEffectsClaimToken, claimToken),
      ))
      .then((rows) => rows[0] ?? null);
    if (!current) return null;
    const completed = [...new Set([...(current.completed ?? []), effect])];
    return tx
      .update(heartbeatRuns)
      .set({
        terminalEffectsCompletedJson: completed,
        terminalEffectsNextAttemptAt: null,
        terminalEffectsLastError: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.terminalEffectsClaimToken, claimToken),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
  });
}

export async function failHeartbeatRunTerminalEffect(
  db: Db,
  runId: string,
  claimToken: string,
  effect: TerminalEffectName,
  error: unknown,
  opts?: { now?: Date },
) {
  const now = opts?.now ?? new Date();
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
    const current = await tx
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.terminalEffectsPending, true),
        eq(heartbeatRuns.terminalEffectsClaimToken, claimToken),
      ))
      .then((rows) => rows[0] ?? null);
    if (!current) return null;

    const attempts = { ...(current.terminalEffectsAttemptsJson ?? {}) };
    const attempt = (attempts[effect] ?? 0) + 1;
    attempts[effect] = attempt;
    const permanentFailure = message.includes("could not be persisted as actionable work");
    const deadLettered = permanentFailure || attempt >= TERMINAL_EFFECT_MAX_ATTEMPTS;
    const nextAttemptAt = deadLettered
      ? null
      : new Date(now.getTime() + TERMINAL_EFFECT_BACKOFF_MS[Math.min(attempt - 1, TERMINAL_EFFECT_BACKOFF_MS.length - 1)]);
    const deadLetteredEffects = deadLettered
      ? [...new Set([...(current.terminalEffectsDeadLetteredJson ?? []), effect])]
      : current.terminalEffectsDeadLetteredJson;

    await tx
      .update(heartbeatRuns)
      .set({
        terminalEffectsAttemptsJson: attempts,
        terminalEffectsDeadLetteredJson: deadLetteredEffects,
        terminalEffectsDeadLetteredAt: deadLettered ? now : current.terminalEffectsDeadLetteredAt,
        terminalEffectsNextAttemptAt: nextAttemptAt,
        terminalEffectsLastError: message,
        terminalEffectsClaimToken: deadLettered ? claimToken : null,
        terminalEffectsClaimedAt: deadLettered ? now : null,
        updatedAt: now,
      })
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.terminalEffectsClaimToken, claimToken),
      ));

    if (deadLettered) {
      if (effect === "issue_release") {
        await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(and(
            eq(issues.orgId, current.orgId),
            eq(issues.executionRunId, runId),
          ));
      }
      const idempotencyKey = `terminal-effect-dead-letter:${effect}`;
      const [currentSeq] = await tx
        .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId));
      await tx
        .insert(heartbeatRunEvents)
        .values({
          orgId: current.orgId,
          runId,
          agentId: current.agentId,
          seq: Number(currentSeq?.maxSeq ?? 0) + 1,
          eventType: "terminal_effect.dead_lettered",
          stream: "system",
          level: "error",
          message: `Terminal effect ${effect} needs operator attention after ${attempt} attempts`,
          payload: { effect, attempt, error: message },
          idempotencyKey,
        })
        .onConflictDoNothing();
      await tx
        .insert(activityLog)
        .values({
          orgId: current.orgId,
          actorType: "system",
          actorId: "terminal_effects",
          action: "heartbeat.terminal_effect_dead_lettered",
          entityType: "heartbeat_run",
          entityId: runId,
          agentId: current.agentId,
          runId,
          details: { effect, attempt, error: message },
          idempotencyKey: `${runId}:${idempotencyKey}`,
        })
        .onConflictDoNothing();
    }

    return { deadLettered, attempt, nextAttemptAt };
  });
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
        terminalEffectsJson: null,
        terminalEffectsCompletedJson: null,
        terminalEffectsDeadLetteredJson: null,
        terminalEffectsAttemptsJson: null,
        terminalEffectsNextAttemptAt: null,
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
    const existing = normalizeTerminalEffectIntent((current.terminalEffectsJson ?? {}) as TerminalEffectIntent);
    const incoming = normalizeTerminalEffectIntent(intent);
    const merged: TerminalEffectIntent = {
      ...existing,
      version: 2,
      automation: existing.automation ?? incoming.automation,
      runtime: existing.runtime ?? incoming.runtime,
      taskSession: existing.taskSession ?? incoming.taskSession,
      processLossRetry: existing.processLossRetry ?? incoming.processLossRetry,
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
