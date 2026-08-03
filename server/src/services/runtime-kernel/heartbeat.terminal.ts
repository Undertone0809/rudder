import type { Db } from "@rudderhq/db";
import { activityLog, agents, agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issues } from "@rudderhq/db";
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { productAnalyticsRunTerminalEventName, recordProductAnalyticsEvent } from "../product-analytics.js";

const TERMINAL_WAKEUP_STATUSES = ["completed", "failed", "cancelled", "timed_out", "skipped", "coalesced"];
export const RUN_EXECUTION_LEASE_MS = 5 * 60_000;
export const RUN_EXECUTION_LEASE_RENEW_INTERVAL_MS = 60_000;
export const TERMINAL_EFFECT_MAX_ATTEMPTS = 5;
const TERMINAL_EFFECT_BACKOFF_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000] as const;
const MAX_TERMINAL_OUTPUT_CHARS = 32_000;
const MAX_TERMINAL_SESSION_PARAMS_BYTES = 64 * 1024;
export const MAX_TERMINAL_EFFECT_INTENT_BYTES = 96 * 1024;

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

export type TerminalIssueSemanticAudit = {
  sourceRun: Pick<typeof heartbeatRuns.$inferSelect, "id" | "orgId" | "agentId">;
  issue: { id: string; orgId: string };
  eventType: string;
  action: string;
  actorId: string;
  level: "info" | "warn" | "error";
  message: string;
  details: Record<string, unknown>;
  mirrorRun?: {
    run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "orgId" | "agentId">;
    message: string;
    details: Record<string, unknown>;
  };
};

export async function writeTerminalIssueSemanticAudit(tx: any, input: TerminalIssueSemanticAudit) {
  const eventIdempotencyKey = `terminal-issue-effect:${input.sourceRun.id}:${input.eventType}`;
  const writeRunEvent = async (
    targetRun: Pick<typeof heartbeatRuns.$inferSelect, "id" | "orgId" | "agentId">,
    message: string,
    details: Record<string, unknown>,
  ) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${targetRun.id}))`);
    const [currentSeq] = await tx
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, targetRun.id));
    await tx
      .insert(heartbeatRunEvents)
      .values({
        orgId: targetRun.orgId,
        runId: targetRun.id,
        agentId: targetRun.agentId,
        seq: Number(currentSeq?.maxSeq ?? 0) + 1,
        eventType: input.eventType,
        stream: "system",
        level: input.level,
        message,
        payload: details,
        idempotencyKey: eventIdempotencyKey,
      })
      .onConflictDoNothing();
  };

  await writeRunEvent(input.sourceRun, input.message, input.details);
  if (input.mirrorRun) {
    await writeRunEvent(input.mirrorRun.run, input.mirrorRun.message, input.mirrorRun.details);
  }
  await tx
    .insert(activityLog)
    .values({
      orgId: input.issue.orgId,
      actorType: "system",
      actorId: input.actorId,
      action: input.action,
      entityType: "issue",
      entityId: input.issue.id,
      agentId: input.sourceRun.agentId,
      runId: input.sourceRun.id,
      details: input.details,
      idempotencyKey: `${input.sourceRun.id}:${input.action}`,
    })
    .onConflictDoNothing();
}

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

function serializedBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function normalizeTaskSessionIntent(value: TerminalEffectIntent["taskSession"] | undefined) {
  if (!value || (value.operation !== "clear" && value.operation !== "upsert")) return undefined;
  const orgId = boundedString(value.orgId, 200);
  const agentId = boundedString(value.agentId, 200);
  const agentRuntimeType = boundedString(value.agentRuntimeType, 200);
  const taskKey = boundedString(value.taskKey, 4_000);
  if (!orgId || !agentId || !agentRuntimeType || !taskKey) return undefined;
  return {
    operation: value.operation,
    orgId,
    agentId,
    agentRuntimeType,
    taskKey,
    sessionParamsJson: boundedRecord(value.sessionParamsJson, MAX_TERMINAL_SESSION_PARAMS_BYTES),
    sessionDisplayId: boundedString(value.sessionDisplayId, 4_000),
    lastRunId: boundedString(value.lastRunId, 200),
    lastError: boundedString(value.lastError, 4_000),
  } satisfies NonNullable<TerminalEffectIntent["taskSession"]>;
}

function boundTerminalEffectIntent(intent: TerminalEffectIntent): TerminalEffectIntent {
  if (serializedBytes(intent) <= MAX_TERMINAL_EFFECT_INTENT_BYTES) return intent;
  const withoutSessionParams = intent.taskSession
    ? { ...intent, taskSession: { ...intent.taskSession, sessionParamsJson: null } }
    : intent;
  if (serializedBytes(withoutSessionParams) <= MAX_TERMINAL_EFFECT_INTENT_BYTES) return withoutSessionParams;
  const compact = {
    ...withoutSessionParams,
    ...(withoutSessionParams.automation
      ? { automation: { output: boundedString(withoutSessionParams.automation.output, 8_000) } }
      : {}),
  };
  if (serializedBytes(compact) <= MAX_TERMINAL_EFFECT_INTENT_BYTES) return compact;
  return {
    ...compact,
    ...(compact.automation ? { automation: { output: null } } : {}),
    ...(compact.runtime
      ? { runtime: { ...compact.runtime, errorMessage: null, legacySessionId: null, normalizedUsage: null } }
      : {}),
    ...(compact.taskSession
      ? {
          taskSession: {
            ...compact.taskSession,
            taskKey: boundedString(compact.taskSession.taskKey, 1_000)!,
            sessionDisplayId: null,
            lastError: null,
          },
        }
      : {}),
  };
}

function safeTerminalEffectError(effect: TerminalEffectName, error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const permanent = rawMessage.includes("could not be persisted as actionable work");
  return {
    permanent,
    code: permanent ? "terminal_effect_unactionable" : "terminal_effect_failed",
    summary: permanent
      ? `Terminal effect ${effect} could not create actionable work`
      : `Terminal effect ${effect} failed`,
  };
}

export function normalizeTerminalEffectIntent(intent: TerminalEffectIntent | null | undefined): TerminalEffectIntent {
  const runtimeInput = intent?.runtime;
  const adapterResult = runtimeInput?.adapterResult
    && typeof runtimeInput.adapterResult === "object"
    && !Array.isArray(runtimeInput.adapterResult)
    ? runtimeInput.adapterResult
    : {};
  const normalizedUsage = boundedRecord(runtimeInput?.normalizedUsage, 8 * 1024) as Record<string, number> | null;
  const taskSession = normalizeTaskSessionIntent(intent?.taskSession);
  return boundTerminalEffectIntent({
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
  });
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
    if (!updated) return null;

    const [workIssue] = await tx.select({ id: issues.id }).from(issues).where(or(
      eq(issues.executionRunId, updated.id),
      eq(issues.checkoutRunId, updated.id),
    )).limit(1);
    const workSurface = workIssue ? "issue" : updated.chatConversationId ? "chat" : null;
    const workId = workIssue?.id ?? updated.chatConversationId;
    const workCycleId = workIssue ? `issue:${workIssue.id}` : updated.chatConversationId ? `chat:${updated.chatConversationId}` : null;

    const terminalAnalyticsEvent = productAnalyticsRunTerminalEventName(updated.status);
    if (terminalAnalyticsEvent) {
      await recordProductAnalyticsEvent(tx as unknown as Db, {
        orgId: updated.orgId,
        eventName: terminalAnalyticsEvent,
        occurredAt: updated.finishedAt ?? new Date(),
        sourceTransition: "heartbeat.run.terminal",
        confidence: "exact",
        actorType: updated.invocationSource.includes("automation") ? "automation" : "agent",
        actorId: updated.agentId,
        runId: updated.id,
        rootRunId: updated.retryOfRunId ?? updated.id,
        origin: updated.invocationSource.includes("automation") ? "automation" : updated.retryOfRunId ? "retry" : "human",
        workSurface,
        workId,
        workCycleId,
        entityType: "run",
        entityId: updated.id,
        dedupeKey: terminalAnalyticsEvent === "run_succeeded"
          ? `run_succeeded:${updated.id}`
          : `run_failed:${updated.id}:${updated.status}`,
        properties: {
          run_kind: updated.invocationSource,
          attempt_kind: updated.retryOfRunId ? "retry" : "root",
          ...(terminalAnalyticsEvent === "run_failed" ? { terminal_status: updated.status } : {}),
        },
      });
    }

    if (updated.status === "succeeded" && updated.resultSummaryJson !== null) {
      await recordProductAnalyticsEvent(tx as unknown as Db, {
        orgId: updated.orgId,
        eventName: "output_ready",
        occurredAt: updated.finishedAt ?? new Date(),
        sourceTransition: "heartbeat.run.terminal",
        confidence: "exact",
        actorType: updated.invocationSource.includes("automation") ? "automation" : "agent",
        actorId: updated.agentId,
        entityType: "run",
        entityId: updated.id,
        runId: updated.id,
        rootRunId: updated.retryOfRunId ?? updated.id,
        workSurface,
        workId,
        workCycleId,
        dedupeKey: `output_ready:${updated.chatConversationId ? `chat:${updated.chatConversationId}` : `run:${updated.id}`}:structured_result:${updated.id}`,
        properties: { output_kind: "structured_result" },
      });
    }

    if (!updated.wakeupRequestId) return updated;

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
  const safeError = safeTerminalEffectError(effect, error);
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
    const deadLettered = safeError.permanent || attempt >= TERMINAL_EFFECT_MAX_ATTEMPTS;
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
        terminalEffectsLastError: `${safeError.code}: ${safeError.summary}`,
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
          payload: { effect, attempt, errorCode: safeError.code, errorSummary: safeError.summary },
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
          details: { effect, attempt, errorCode: safeError.code, errorSummary: safeError.summary },
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
  const safeError = safeTerminalEffectError("issue_release", error);
  return db
    .update(heartbeatRuns)
    .set({
      terminalEffectsClaimToken: null,
      terminalEffectsClaimedAt: null,
      terminalEffectsLastError: `${safeError.code}: ${safeError.summary}`,
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
    const merged = boundTerminalEffectIntent({
      ...existing,
      version: 2,
      automation: existing.automation ?? incoming.automation,
      runtime: existing.runtime ?? incoming.runtime,
      taskSession: existing.taskSession ?? incoming.taskSession,
      processLossRetry: existing.processLossRetry ?? incoming.processLossRetry,
    });
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
