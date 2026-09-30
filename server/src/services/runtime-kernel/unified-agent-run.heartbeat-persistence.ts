import type { Db } from "@rudderhq/db";
import {
  agents,
  agentWakeupRequests,
  chatConversations,
  heartbeatRunAttempts,
  heartbeatRuns,
  runRuntimeSpans,
} from "@rudderhq/db";
import {
  AGENT_RUN_CONCURRENCY_DEFAULT,
  AGENT_RUN_CONCURRENCY_MAX,
  AGENT_RUN_CONCURRENCY_MIN,
} from "@rudderhq/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  beginHeartbeatRunAttempt,
  finishHeartbeatRunAttempt,
  markHeartbeatRunAttemptWaiting,
} from "./heartbeat-attempt-ledger.js";
import {
  claimExpiredHeartbeatRunExecution,
  renewHeartbeatRunExecutionLease,
  RUN_EXECUTION_LEASE_MS,
  transitionHeartbeatRunToTerminal,
  type TerminalEffectIntent,
} from "./heartbeat.terminal.js";
import {
  finishRunRuntimeSpan,
  startRunRuntimeSpanInTransaction,
} from "./native-session.js";
import type {
  UnifiedAcceptanceReconciliationInput,
  UnifiedAcceptanceUnknownInput,
  UnifiedAgentRunAdapter,
  UnifiedAgentRunPersistenceAdapterOptions,
  UnifiedAttemptTerminalStatus,
  UnifiedOwnerClaimInput,
  UnifiedRunTerminalStatus,
  UnifiedSpanSealInput,
} from "./unified-agent-run.contracts.js";
import { startHeartbeatRetrySpan } from "./unified-agent-run.heartbeat-retry-persistence.js";
import {
  UnifiedAgentRunContractError,
  type UnifiedAdmissionResult,
  type UnifiedAgentRunAdmission,
  type UnifiedAgentRunEntry,
  type UnifiedAttemptFinishInput,
  type UnifiedAttemptInput,
  type UnifiedAttemptWaitingInput,
  type UnifiedFenceResult,
  type UnifiedNativeExecutionInput,
  type UnifiedOwnerFence,
  type UnifiedRunAttempt,
  type UnifiedRunSpan,
  type UnifiedRunTerminalInput,
  type UnifiedSubmission,
  type UnifiedSubmissionOutcome,
} from "./unified-agent-run.js";
import {
  ACTIVE_RUN_STATUSES,
  admissionDigestForRun,
  admissionMatches,
  assertPersistedRuntimeIdentity,
  checkpointWithSubmission,
  contextWithAdmission,
  defaultNativeSpanResolver,
  findPersistedAdmissionRows,
  invocationSourceForScene,
  legacyAdmissionFingerprintMatches,
  loadNativeSpanIdentity,
  loadPersistedUnifiedEntry,
  normalizePersistenceAdmission,
  persistenceError,
  providerField,
  readPersistedAdmission,
  readSubmission,
  requiredPersistenceString,
  sessionReuseScopeForIntent,
  submissionKeyFor,
  UNIFIED_ADMISSION_CONTEXT_KEY,
  unifiedAttemptFromRow,
  type UnifiedStoredAdmission,
  type UnifiedStoredSubmission,
} from "./unified-agent-run.persistence-support.js";

class UnifiedRunTerminalCasMiss extends Error {
  constructor(readonly result: {
    ok: false;
    reason: "run_not_found" | "run_terminal" | "stale_owner";
  }) {
    super("unified Run terminal compare-and-set did not match");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}


export async function lockUnifiedAgentRunCapacity(database: Db, agentId: string) {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-run-state:${agentId}`}))`);
}

/**
 * Check capacity while holding the per-agent transaction lock. Callers must
 * persist the running row before their transaction releases that lock.
 */
export async function reserveUnifiedAgentRunCapacity(
  database: Db,
  input: { agentId: string; runtimeConfig: unknown; lockHeld?: boolean },
) {
  if (!input.lockHeld) await lockUnifiedAgentRunCapacity(database, input.agentId);

  const runtimeConfig = asRecord(input.runtimeConfig);
  const heartbeat = asRecord(runtimeConfig?.heartbeat);
  const configuredLimit = heartbeat?.maxConcurrentRuns;
  const parsedLimit = typeof configuredLimit === "number" && Number.isFinite(configuredLimit)
    ? Math.floor(configuredLimit)
    : AGENT_RUN_CONCURRENCY_DEFAULT;
  const limit = Math.max(AGENT_RUN_CONCURRENCY_MIN, Math.min(AGENT_RUN_CONCURRENCY_MAX, parsedLimit));
  const [row] = await database
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.agentId, input.agentId),
      or(
        eq(heartbeatRuns.status, "running"),
        eq(heartbeatRuns.terminalEffectsPending, true),
      ),
    ));
  const runningCount = Number(row?.count ?? 0);
  return { admitted: runningCount < limit, runningCount, limit };
}

/**
 * Bind the common Run contract to the existing heartbeat persistence model.
 * This is the production adapter: every value returned by it is read back from
 * heartbeat_runs, heartbeat_run_attempts, or run_runtime_spans.
 */
export function createHeartbeatUnifiedAgentRunAdapter(
  db: Db,
  options: UnifiedAgentRunPersistenceAdapterOptions = {},
): UnifiedAgentRunAdapter {
  const now = options.now ?? (() => new Date());
  const resolveNativeSpan = options.resolveNativeSpan ?? defaultNativeSpanResolver;

  async function lockRun(database: Db, runId: string) {
    await database.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
  }

  async function selectOwnerState(
    database: Db,
    runId: string,
    fence: UnifiedOwnerFence,
    observedAt: Date,
  ) {
    const run = await database
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run) return { ok: false as const, reason: "run_not_found" as const };
    if (run.status !== "running") return { ok: false as const, reason: "run_terminal" as const };
    if (!run.executionOwnerToken || run.executionOwnerToken !== fence.ownerToken) {
      return { ok: false as const, reason: "stale_owner" as const };
    }
    if (run.executionLeaseExpiresAt && run.executionLeaseExpiresAt.getTime() <= observedAt.getTime()) {
      return { ok: false as const, reason: "lease_expired" as const };
    }
    const span = await database
      .select()
      .from(runRuntimeSpans)
      .where(and(
        eq(runRuntimeSpans.orgId, run.orgId),
        eq(runRuntimeSpans.runId, run.id),
      ))
      .orderBy(desc(runRuntimeSpans.ordinal))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!span) throw persistenceError("contract", `heartbeat run ${run.id} has no native span for owner fencing`);
    if (span.id !== fence.id || span.ownerToken !== fence.ownerToken || span.attemptEpoch !== fence.attemptEpoch) {
      return { ok: false as const, reason: "stale_owner" as const };
    }
    const stored = readPersistedAdmission(run);
    if (!stored) throw persistenceError("contract", `heartbeat run ${run.id} has no unified admission metadata`);
    const attempt = await database
      .select()
      .from(heartbeatRunAttempts)
      .where(and(
        eq(heartbeatRunAttempts.orgId, run.orgId),
        eq(heartbeatRunAttempts.runId, run.id),
      ))
      .orderBy(desc(heartbeatRunAttempts.attemptIndex))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!attempt) throw persistenceError("contract", `heartbeat run ${run.id} has no current attempt for owner fencing`);
    if (!span.attemptId || span.attemptId !== attempt.id) {
      throw persistenceError("contract", `heartbeat run ${run.id} native span is not bound to its current attempt`);
    }
    if (attempt.ownerToken !== fence.ownerToken || attempt.attemptEpoch !== fence.attemptEpoch) {
      return { ok: false as const, reason: "stale_owner" as const };
    }
    if (attempt.runtimeType !== stored.runtimeType) {
      throw persistenceError(
        "contract",
        `heartbeat run ${run.id} attempt.runtimeType=${attempt.runtimeType} does not match admission.runtimeType=${stored.runtimeType}`,
      );
    }
    const nativeIdentity = await loadNativeSpanIdentity(database, {
      span,
      driverRuntimeType: stored.runtimeType,
      context: `heartbeat run ${run.id} owner fence`,
    });
    if (nativeIdentity.binding.agentId !== run.agentId) {
      throw persistenceError("contract", `heartbeat run ${run.id} native binding is owned by a different agent`);
    }
    return { ok: true as const, run, span, attempt, ...nativeIdentity };
  }

  function admissionSnapshot(
    admission: ReturnType<typeof normalizePersistenceAdmission>,
    ownerFence: Partial<Pick<UnifiedStoredAdmission, "ownerFenceId" | "lastOwnerToken" | "attemptEpoch" | "lastLeaseExpiresAt">> = {},
  ): UnifiedStoredAdmission {
    return {
      version: 1,
      fingerprintVersion: 2,
      agentId: admission.agentId,
      runtimeBindingId: admission.runtimeBindingId,
      runtimeSegmentId: admission.runtimeSegmentId,
      scene: admission.scene,
      targetType: admission.target.type,
      targetId: admission.target.id,
      idempotencyKey: admission.idempotencyKey,
      runtimeType: admission.runtimeType,
      model: admission.model,
      sessionIntent: admission.sessionIntent,
      fingerprint: admission.fingerprint,
      ...ownerFence,
    };
  }

  function admissionInputFromStored(
    run: typeof heartbeatRuns.$inferSelect,
    stored: UnifiedStoredAdmission,
    attempt?: typeof heartbeatRunAttempts.$inferSelect,
  ): UnifiedAgentRunAdmission {
    return {
      orgId: run.orgId,
      agentId: run.agentId,
      runtimeBindingId: stored.runtimeBindingId,
      runtimeSegmentId: stored.runtimeSegmentId,
      scene: stored.scene,
      target: { type: stored.targetType, id: stored.targetId },
      idempotencyKey: stored.idempotencyKey,
      runtimeType: attempt?.runtimeType ?? stored.runtimeType,
      model: attempt?.model ?? stored.model,
      sessionIntent: stored.sessionIntent,
      attempt: attempt
        ? {
            attemptIndex: attempt.attemptIndex,
            fallbackIndex: attempt.fallbackIndex,
            isFallback: attempt.isFallback,
            resumeSource: attempt.resumeSource,
          }
        : undefined,
    };
  }

  async function selectCurrentAttempt(database: Db, runId: string, orgId: string) {
    return database
      .select()
      .from(heartbeatRunAttempts)
      .where(and(
        eq(heartbeatRunAttempts.orgId, orgId),
        eq(heartbeatRunAttempts.runId, runId),
      ))
      .orderBy(desc(heartbeatRunAttempts.attemptIndex))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function updateSubmission(
    database: Db,
    attempt: typeof heartbeatRunAttempts.$inferSelect,
    submission: UnifiedStoredSubmission,
  ) {
    const [updated] = await database
      .update(heartbeatRunAttempts)
      .set({
        checkpointJson: checkpointWithSubmission(attempt.checkpointJson, submission),
        submissionPhase: submission.phase,
        providerThreadId: submission.providerThreadId,
        providerTurnId: submission.providerTurnId,
      })
      .where(and(
        eq(heartbeatRunAttempts.id, attempt.id),
        eq(heartbeatRunAttempts.orgId, attempt.orgId),
        eq(heartbeatRunAttempts.runId, attempt.runId),
      ))
      .returning();
    if (!updated) throw persistenceError("contract", `attempt ${attempt.id} disappeared during submission update`);
    return updated;
  }

  async function admit(input: UnifiedAgentRunAdmission): Promise<UnifiedAdmissionResult> {
    const admission = normalizePersistenceAdmission(input);
    const requestedAt = now();
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`unified-agent-run:${admission.orgId}:${admission.idempotencyKey}`}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`unified-agent-run-target:${admission.orgId}:${admission.scene}:${admission.target.type}:${admission.target.id}`}, 0))`);

      const existingRows = await findPersistedAdmissionRows(tx, admission);
      for (const existing of existingRows) {
        const stored = readPersistedAdmission(existing);
        if (!stored) {
          throw persistenceError(
            "contract",
            `heartbeat run ${existing.id} matches the requested idempotency key without a complete durable unified identity`,
          );
        }
        if (!admissionMatches(stored, admission)) {
          throw new UnifiedAgentRunContractError(
            "idempotency_conflict",
            `idempotency key ${admission.idempotencyKey} was already admitted for a different scene or target`,
          );
        }
        const fingerprintMatches = stored.fingerprintVersion === 3
          ? stored.fingerprint === admissionDigestForRun({
            agentId: admission.agentId,
            runtimeBindingId: admission.runtimeBindingId,
            runtimeSegmentId: admission.runtimeSegmentId,
            scene: admission.scene,
            targetType: admission.target.type,
            targetId: admission.target.id,
            idempotencyKey: admission.idempotencyKey,
            runtimeType: admission.runtimeType,
            model: admission.model,
            sessionIntent: admission.sessionIntent,
          })
          : stored.fingerprintVersion === 2
            ? stored.fingerprint === admission.fingerprint
            : legacyAdmissionFingerprintMatches(stored.fingerprint, admission);
        if (!fingerprintMatches) {
          throw new UnifiedAgentRunContractError(
            "idempotency_conflict",
            `idempotency key ${admission.idempotencyKey} was already admitted with different run inputs`,
          );
        }
        if (stored.fingerprintVersion !== 2 && (admission.runtimeBindingId || admission.runtimeSegmentId)) {
          const [originalSpan] = await tx.select().from(runRuntimeSpans)
            .where(and(eq(runRuntimeSpans.orgId, admission.orgId), eq(runRuntimeSpans.runId, existing.id)))
            .orderBy(asc(runRuntimeSpans.ordinal)).limit(1);
          if (!originalSpan
            || (admission.runtimeBindingId && originalSpan.bindingId !== admission.runtimeBindingId)
            || (admission.runtimeSegmentId && originalSpan.segmentId !== admission.runtimeSegmentId)) {
            throw new UnifiedAgentRunContractError("idempotency_conflict", "Native identity differs from the original admission");
          }
        }
        const entry = await loadPersistedUnifiedEntry(tx, existing.id);
        if (!entry) throw persistenceError("contract", `idempotent heartbeat run ${existing.id} disappeared`);
        return { created: false, entry };
      }

      const [agent] = await tx
        .select({ id: agents.id, agentRuntimeType: agents.agentRuntimeType })
        .from(agents)
        .where(and(eq(agents.id, admission.agentId), eq(agents.orgId, admission.orgId)))
        .limit(1);
      if (!agent) {
        throw persistenceError("contract", `agent ${admission.agentId} is not owned by organization ${admission.orgId}`);
      }
      if (agent.agentRuntimeType !== admission.runtimeType) {
        throw persistenceError(
          "contract",
          `agent ${admission.agentId} runtime identity does not match driver.runtimeType=${admission.runtimeType}`,
        );
      }

      const [activeTarget] = await tx
        .select()
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.orgId, admission.orgId),
          or(
            and(
              eq(heartbeatRuns.scene, admission.scene),
              eq(heartbeatRuns.targetType, admission.target.type),
              eq(heartbeatRuns.targetId, admission.target.id),
            ),
            sql`(
              ${heartbeatRuns.contextSnapshot} ->> 'scene' = ${admission.scene}
              and ${heartbeatRuns.contextSnapshot} ->> 'targetType' = ${admission.target.type}
              and ${heartbeatRuns.contextSnapshot} ->> 'targetId' = ${admission.target.id}
            )`,
            sql`(
              ${heartbeatRuns.contextSnapshot} -> ${UNIFIED_ADMISSION_CONTEXT_KEY} ->> 'scene' = ${admission.scene}
              and ${heartbeatRuns.contextSnapshot} -> ${UNIFIED_ADMISSION_CONTEXT_KEY} ->> 'targetType' = ${admission.target.type}
              and ${heartbeatRuns.contextSnapshot} -> ${UNIFIED_ADMISSION_CONTEXT_KEY} ->> 'targetId' = ${admission.target.id}
            )`,
          ),
          or(
            inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
            eq(heartbeatRuns.terminalEffectsPending, true),
          ),
        ))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1);
      if (activeTarget) {
        const stored = readPersistedAdmission(activeTarget);
        if (!stored) {
          throw persistenceError(
            "contract",
            `active heartbeat run ${activeTarget.id} has no complete durable unified target mapping; refusing to create a duplicate`,
          );
        }
        throw persistenceError(
          "contract",
          `active heartbeat run ${activeTarget.id} already owns ${admission.scene}/${admission.target.type}/${admission.target.id}`,
        );
      }

      if (admission.target.type === "chat_conversation") {
        const [conversation] = await tx
          .select({ id: chatConversations.id })
          .from(chatConversations)
          .where(and(
            eq(chatConversations.id, admission.target.id),
            eq(chatConversations.orgId, admission.orgId),
          ))
          .limit(1);
        if (!conversation) {
          throw persistenceError("contract", `chat target ${admission.target.id} is not owned by organization ${admission.orgId}`);
        }
        const [activeChat] = await tx
          .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.orgId, admission.orgId),
            eq(heartbeatRuns.chatConversationId, admission.target.id),
            or(
              inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
              eq(heartbeatRuns.terminalEffectsPending, true),
            ),
          ))
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(1);
        if (activeChat) {
          throw persistenceError(
            "contract",
            `active Chat run ${activeChat.id} has no matching durable unified idempotency mapping; refusing to create a duplicate`,
          );
        }
      }

      const sourceRunId = admission.sessionIntent.kind === "fork"
        ? admission.sessionIntent.sourceRunId
        : admission.sessionIntent.kind === "resume"
          ? admission.sessionIntent.sourceRunId
          : null;
      let persistedSourceRunId: string | null = null;
      if (sourceRunId) {
        const [source] = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, sourceRunId), eq(heartbeatRuns.orgId, admission.orgId)))
          .limit(1);
        if (!source) throw persistenceError("contract", `session source run ${sourceRunId} is not owned by the admitted organization`);
        persistedSourceRunId = source.id;
      }

      await lockUnifiedAgentRunCapacity(tx, admission.agentId);
      await tx.execute(sql`select id from agents where id = ${admission.agentId} and org_id = ${admission.orgId} for update`);
      const [capacityAgent] = await tx
        .select({ agentRuntimeType: agents.agentRuntimeType, runtimeConfig: agents.runtimeConfig, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, admission.agentId), eq(agents.orgId, admission.orgId)))
        .limit(1);
      if (!capacityAgent || capacityAgent.agentRuntimeType !== admission.runtimeType) {
        throw persistenceError("contract", `agent ${admission.agentId} runtime identity changed during admission`);
      }
      const capacity = await reserveUnifiedAgentRunCapacity(tx, {
        agentId: admission.agentId,
        runtimeConfig: capacityAgent.runtimeConfig,
        lockHeld: true,
      });
      if (!capacity.admitted) {
        throw persistenceError(
          "contract",
          `agent ${admission.agentId} is at its concurrent run capacity (${capacity.runningCount}/${capacity.limit})`,
        );
      }
      if (
        (admission.scene === "chat" || admission.scene === "side_chat")
        && !["paused", "terminated", "pending_approval"].includes(capacityAgent.status)
      ) {
        const [olderQueuedRun] = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.orgId, admission.orgId),
            eq(heartbeatRuns.agentId, admission.agentId),
            eq(heartbeatRuns.status, "queued"),
            lte(heartbeatRuns.createdAt, requestedAt),
            sql`(
              ${heartbeatRuns.wakeupRequestId} is null
              or exists (
                select 1 from ${agentWakeupRequests}
                where ${agentWakeupRequests.id} = ${heartbeatRuns.wakeupRequestId}
                  and ${agentWakeupRequests.requestedAt} <= ${requestedAt.toISOString()}::timestamptz
              )
            )`,
          ))
          .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
          .limit(1);
        if (olderQueuedRun) {
          throw persistenceError(
            "contract",
            `older due queued run ${olderQueuedRun.id} has priority over Chat admission for agent ${admission.agentId}`,
          );
        }
      }

      const createdAt = now();
      const runId = randomUUID();
      const ownerToken = randomUUID();
      const leaseExpiresAt = new Date(createdAt.getTime() + RUN_EXECUTION_LEASE_MS);
      const initialStoredAdmission = admissionSnapshot(admission, {
        lastOwnerToken: ownerToken,
        attemptEpoch: 1,
        lastLeaseExpiresAt: leaseExpiresAt.toISOString(),
      });
      const [createdRun] = await tx
        .insert(heartbeatRuns)
        .values({
          id: runId,
          orgId: admission.orgId,
          agentId: admission.agentId,
          invocationSource: invocationSourceForScene(admission.scene),
          triggerDetail: admission.scene === "chat" || admission.scene === "side_chat"
            ? "chat_assistant_reply"
            : "agent_run_created",
          status: "running",
          startedAt: createdAt,
          sessionIdBefore: admission.sessionIntent.sessionId,
          sessionParamsBeforeJson: admission.sessionIntent.sessionParams,
          sessionReuseScope: sessionReuseScopeForIntent(admission.sessionIntent),
          executionOwnerToken: ownerToken,
          executionLeaseExpiresAt: leaseExpiresAt,
          chatConversationId: admission.target.type === "chat_conversation" ? admission.target.id : null,
          sourceRunId: persistedSourceRunId,
          scene: admission.scene,
          targetType: admission.target.type,
          targetId: admission.target.id,
          idempotencyKey: admission.idempotencyKey,
          sessionIntentJson: admission.sessionIntent,
          contextSnapshot: contextWithAdmission(admission.contextSnapshot, initialStoredAdmission),
        })
        .returning();
      if (!createdRun) throw persistenceError("contract", "heartbeat run admission did not return a durable row");

      const attemptIndex = admission.attempt?.attemptIndex ?? 0;
      if (!Number.isInteger(attemptIndex) || attemptIndex < 0) {
        throw new UnifiedAgentRunContractError("invalid_admission", "attemptIndex must be a non-negative integer");
      }
      const attemptRef = await beginHeartbeatRunAttempt(tx, {
        orgId: admission.orgId,
        runId,
        agentId: admission.agentId,
        attemptIndex,
        fallbackIndex: admission.attempt?.fallbackIndex ?? null,
        runtimeType: admission.runtimeType,
        model: admission.model,
        isFallback: admission.attempt?.isFallback ?? false,
        resumeSource: admission.attempt?.resumeSource
          ?? (admission.sessionIntent.kind === "fresh" ? "fresh" : "same_session"),
        ownerToken,
        attemptEpoch: 1,
      });
      if (!attemptRef) throw persistenceError("contract", `heartbeat run ${runId} admission did not create an attempt row`);
      const attempt = await tx
        .select()
        .from(heartbeatRunAttempts)
        .where(and(eq(heartbeatRunAttempts.id, attemptRef.id), eq(heartbeatRunAttempts.orgId, admission.orgId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!attempt) throw persistenceError("contract", `heartbeat run ${runId} attempt row cannot be read back`);

      const nativeSpan = await resolveNativeSpan({
        db: tx,
        admission: input,
        runId,
        attemptId: attempt.id,
        attemptIndex,
        ownerToken,
        attemptEpoch: 1,
      });
      if (!nativeSpan) {
        throw persistenceError(
          "unsupported",
          `no durable native binding/segment is available for ${admission.scene}/${admission.target.type}; admission is fail-closed`,
        );
      }
      if (
        nativeSpan.binding.orgId !== admission.orgId
        || nativeSpan.binding.agentId !== admission.agentId
        || nativeSpan.binding.runtimeType !== admission.runtimeType
        || nativeSpan.segment.orgId !== admission.orgId
        || nativeSpan.segment.bindingId !== nativeSpan.binding.id
      ) {
        throw persistenceError("contract", "native span resolver returned a cross-organization or mismatched binding");
      }
      assertPersistedRuntimeIdentity({
        binding: nativeSpan.binding,
        segment: nativeSpan.segment,
        driverRuntimeType: admission.runtimeType,
        context: "native span admission",
      });
      const span = await startRunRuntimeSpanInTransaction(tx as unknown as Pick<Db, "select" | "insert" | "update" | "execute">, {
        orgId: admission.orgId,
        runId,
        binding: nativeSpan.binding,
        segment: nativeSpan.segment,
        runtimeType: admission.runtimeType,
        attemptRef: `${admission.idempotencyKey}:attempt:${attemptIndex}`,
        attemptId: attempt.id,
        attemptEpoch: 1,
        ownerToken,
        inputCorrelationRef: nativeSpan.inputCorrelationRef ?? admission.idempotencyKey,
      });

      const initialSubmission: UnifiedStoredSubmission = {
        key: admission.idempotencyKey,
        state: "pending",
        phase: "pre_submission",
        retry: "allowed",
        providerThreadId: null,
        providerTurnId: null,
        reason: null,
      };
      await tx
        .update(heartbeatRunAttempts)
        .set({
          checkpointJson: checkpointWithSubmission(attempt.checkpointJson, initialSubmission),
          submissionPhase: "pre_submission",
        })
        .where(and(
          eq(heartbeatRunAttempts.id, attempt.id),
          eq(heartbeatRunAttempts.orgId, admission.orgId),
          eq(heartbeatRunAttempts.runId, runId),
        ));
      const persistedAdmission = admissionSnapshot(admission, {
        ownerFenceId: span.id,
        lastOwnerToken: ownerToken,
        attemptEpoch: span.attemptEpoch,
        lastLeaseExpiresAt: leaseExpiresAt.toISOString(),
      });
      await tx
        .update(heartbeatRuns)
        .set({ contextSnapshot: contextWithAdmission(createdRun.contextSnapshot, persistedAdmission) })
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.orgId, admission.orgId)));
      const entry = await loadPersistedUnifiedEntry(tx, runId);
      if (!entry) throw persistenceError("contract", `heartbeat run ${runId} disappeared after admission`);
      return { created: true, entry };
    });
  }

  async function get(runId: string): Promise<UnifiedAgentRunEntry | null> {
    return loadPersistedUnifiedEntry(db, runId);
  }

  async function renewOwner(
    runId: string,
    fence: UnifiedOwnerFence,
  ): Promise<UnifiedFenceResult<UnifiedOwnerFence>> {
    const observedAt = now();
    const owner = await selectOwnerState(db, runId, fence, observedAt);
    if (!owner.ok) return owner;
    const renewed = await renewHeartbeatRunExecutionLease(db, runId, fence.ownerToken, observedAt);
    if (!renewed) {
      const current = await db
        .select({ status: heartbeatRuns.status, executionOwnerToken: heartbeatRuns.executionOwnerToken })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!current) return { ok: false, reason: "run_not_found" };
      if (current.status !== "running") return { ok: false, reason: "run_terminal" };
      return { ok: false, reason: current.executionOwnerToken === fence.ownerToken ? "lease_expired" : "stale_owner" };
    }
    const currentRun = await db
      .select({ executionLeaseExpiresAt: heartbeatRuns.executionLeaseExpiresAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!currentRun?.executionLeaseExpiresAt) {
      throw persistenceError("contract", `renewed heartbeat run ${runId} has no lease expiry readback`);
    }
    return {
      ok: true,
      value: {
        ...fence,
        leaseExpiresAt: new Date(currentRun.executionLeaseExpiresAt),
      },
    };
  }

  async function claimOwner(
    runId: string,
    input: UnifiedOwnerClaimInput = {},
  ): Promise<UnifiedFenceResult<UnifiedOwnerFence>> {
    const requestedOwnerToken = input.ownerToken?.trim() || null;
    if (input.leaseMs !== undefined && input.leaseMs !== RUN_EXECUTION_LEASE_MS) {
      throw persistenceError(
        "unsupported",
        `custom leaseMs ${input.leaseMs} is unsupported because claimExpiredHeartbeatRunExecution owns the lease duration`,
      );
    }
    const observedAt = input.observedAt ?? now();
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockRun(tx, runId);
      const before = await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!before) return { ok: false, reason: "run_not_found" };
      if (before.status !== "running") return { ok: false, reason: "run_terminal" };
      if (before.executionLeaseExpiresAt && before.executionLeaseExpiresAt.getTime() > observedAt.getTime()) {
        return { ok: false, reason: "lease_held" };
      }
      const claim = await claimExpiredHeartbeatRunExecution(tx, runId, {
        now: observedAt,
        recoveryCutoff: input.recoveryCutoff ?? observedAt,
      });
      if (!claim) {
        const current = await tx
          .select({ status: heartbeatRuns.status, executionLeaseExpiresAt: heartbeatRuns.executionLeaseExpiresAt })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!current) return { ok: false, reason: "run_not_found" };
        if (current.status !== "running") return { ok: false, reason: "run_terminal" };
        if (current.executionLeaseExpiresAt && current.executionLeaseExpiresAt.getTime() > observedAt.getTime()) {
          return { ok: false, reason: "lease_held" };
        }
        throw persistenceError(
          "contract",
          `claimExpiredHeartbeatRunExecution refused heartbeat run ${runId}; its recovery cutoff or durable state is not claimable`,
        );
      }
      const span = await tx
        .select()
        .from(runRuntimeSpans)
        .where(and(
          eq(runRuntimeSpans.orgId, claim.run.orgId),
          eq(runRuntimeSpans.runId, runId),
          or(
            eq(runRuntimeSpans.state, "open"),
            and(inArray(runRuntimeSpans.state, ["sealed", "unresolved"]), isNotNull(runRuntimeSpans.writerLeaseReleasedAt)),
          ),
        ))
        .orderBy(desc(runRuntimeSpans.ordinal))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!span) throw persistenceError("contract", `claimed heartbeat run ${runId} has no quiescent native span to fence`);
      const storedBeforeClaim = readPersistedAdmission(claim.run);
      if (!storedBeforeClaim) throw persistenceError("contract", `claimed heartbeat run ${runId} has no unified admission metadata`);
      const currentAttemptBeforeClaim = await tx
        .select()
        .from(heartbeatRunAttempts)
        .where(and(
          eq(heartbeatRunAttempts.orgId, claim.run.orgId),
          eq(heartbeatRunAttempts.runId, runId),
        ))
        .orderBy(desc(heartbeatRunAttempts.attemptIndex))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!currentAttemptBeforeClaim || span.attemptId !== currentAttemptBeforeClaim.id) {
        throw persistenceError("contract", `claimed heartbeat run ${runId} native span is not bound to its current attempt`);
      }
      if (currentAttemptBeforeClaim.runtimeType !== storedBeforeClaim.runtimeType) {
        throw persistenceError(
          "contract",
          `claimed heartbeat run ${runId} attempt.runtimeType=${currentAttemptBeforeClaim.runtimeType} does not match admission.runtimeType=${storedBeforeClaim.runtimeType}`,
        );
      }
      const submissionBeforeClaim = readSubmission(currentAttemptBeforeClaim);
      await loadNativeSpanIdentity(tx, {
        span,
        driverRuntimeType: storedBeforeClaim.runtimeType,
        context: `heartbeat run ${runId} owner claim`,
      });
      const ownerToken = requestedOwnerToken ?? claim.ownerToken;
      const attemptEpoch = span.attemptEpoch + 1;
      const [fencedSpan] = await tx
        .update(runRuntimeSpans)
        .set({ ownerToken, attemptEpoch, updatedAt: observedAt })
        .where(and(
          eq(runRuntimeSpans.id, span.id),
          eq(runRuntimeSpans.orgId, claim.run.orgId),
          eq(runRuntimeSpans.runId, runId),
          eq(runRuntimeSpans.state, span.state),
          ...(span.writerLeaseReleasedAt ? [isNotNull(runRuntimeSpans.writerLeaseReleasedAt)] : []),
          eq(runRuntimeSpans.ownerToken, span.ownerToken),
        ))
        .returning();
      if (!fencedSpan) throw persistenceError("contract", `claimed heartbeat run ${runId} native span fencing lost its CAS`);
      const [fencedAttempt] = await tx
        .update(heartbeatRunAttempts)
        .set({ ownerToken, attemptEpoch })
        .where(and(
          eq(heartbeatRunAttempts.id, currentAttemptBeforeClaim.id),
          eq(heartbeatRunAttempts.orgId, claim.run.orgId),
          eq(heartbeatRunAttempts.runId, runId),
          currentAttemptBeforeClaim.ownerToken
            ? eq(heartbeatRunAttempts.ownerToken, currentAttemptBeforeClaim.ownerToken)
            : isNull(heartbeatRunAttempts.ownerToken),
          currentAttemptBeforeClaim.attemptEpoch !== null
            ? eq(heartbeatRunAttempts.attemptEpoch, currentAttemptBeforeClaim.attemptEpoch)
            : isNull(heartbeatRunAttempts.attemptEpoch),
        ))
        .returning({ id: heartbeatRunAttempts.id });
      if (!fencedAttempt) throw persistenceError("contract", `claimed heartbeat run ${runId} attempt fencing lost its CAS`);
      if (submissionBeforeClaim.state === "pending") {
        await updateSubmission(tx, currentAttemptBeforeClaim, {
          ...submissionBeforeClaim,
          state: "acceptance_unknown",
          phase: "indeterminate",
          retry: "blocked_until_reconciled",
          reason: "owner lease expired before provider acceptance could be confirmed",
        });
      }
      if (requestedOwnerToken) {
        const [overridden] = await tx
          .update(heartbeatRuns)
          .set({ executionOwnerToken: requestedOwnerToken })
          .where(and(
            eq(heartbeatRuns.id, runId),
            eq(heartbeatRuns.executionOwnerToken, claim.ownerToken),
            eq(heartbeatRuns.status, "running"),
          ))
          .returning({ id: heartbeatRuns.id });
        if (!overridden) throw persistenceError("contract", `claimed heartbeat run ${runId} owner token override lost its CAS`);
      }
      const currentRun = await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!currentRun?.executionLeaseExpiresAt) throw persistenceError("contract", `claimed heartbeat run ${runId} has no lease readback`);
      const stored = readPersistedAdmission(currentRun);
      if (!stored) throw persistenceError("contract", `claimed heartbeat run ${runId} has no unified admission metadata`);
      const nextStored = {
        ...stored,
        ownerFenceId: fencedSpan.id,
        lastOwnerToken: ownerToken,
        attemptEpoch,
        lastLeaseExpiresAt: currentRun.executionLeaseExpiresAt.toISOString(),
      } satisfies UnifiedStoredAdmission;
      await tx
        .update(heartbeatRuns)
        .set({ contextSnapshot: contextWithAdmission(currentRun.contextSnapshot, nextStored) })
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.orgId, currentRun.orgId)));
      return {
        ok: true,
        value: {
          id: fencedSpan.id,
          ownerToken,
          attemptEpoch,
          leaseExpiresAt: new Date(currentRun.executionLeaseExpiresAt),
        },
      };
    });
  }

  async function beginAttempt(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedAttemptInput,
  ): Promise<UnifiedFenceResult<UnifiedRunAttempt>> {
    if (!Number.isInteger(input.attemptIndex) || input.attemptIndex < 0) {
      throw new UnifiedAgentRunContractError("invalid_admission", "attemptIndex must be a non-negative integer");
    }
    const runtimeType = requiredPersistenceString(input.runtimeType, "runtimeType");
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockRun(tx, runId);
      const owner = await selectOwnerState(tx, runId, fence, now());
      if (!owner.ok) return owner;
      const stored = readPersistedAdmission(owner.run);
      if (!stored) throw persistenceError("contract", `heartbeat run ${runId} has no unified admission metadata`);
      if (runtimeType !== stored.runtimeType) {
        throw new UnifiedAgentRunContractError(
          "attempt_conflict",
          `retry runtimeType=${runtimeType} does not match admitted runtimeType=${stored.runtimeType}`,
        );
      }
      const existing = await tx
        .select()
        .from(heartbeatRunAttempts)
        .where(and(
          eq(heartbeatRunAttempts.orgId, owner.run.orgId),
          eq(heartbeatRunAttempts.runId, runId),
          eq(heartbeatRunAttempts.attemptIndex, input.attemptIndex),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) {
        if (
          existing.runtimeType !== runtimeType
          || existing.model !== (input.model?.trim() || null)
          || existing.fallbackIndex !== (input.fallbackIndex ?? null)
          || existing.isFallback !== (input.isFallback ?? false)
        ) {
          throw new UnifiedAgentRunContractError("attempt_conflict", `attempt ${input.attemptIndex} was already admitted differently`);
        }
        return { ok: true, value: unifiedAttemptFromRow(existing) };
      }
      const current = await selectCurrentAttempt(tx, runId, owner.run.orgId);
      if (!current) throw persistenceError("contract", `heartbeat run ${runId} has no current attempt row`);
      const currentSubmission = readSubmission(current);
      if (currentSubmission.state === "acceptance_unknown") {
        throw new UnifiedAgentRunContractError(
          "acceptance_unknown_requires_reconciliation",
          "cannot create a retry attempt before reconciling provider acceptance",
        );
      }
      if (currentSubmission.state !== "rejected" || currentSubmission.retry !== "allowed") {
        throw new UnifiedAgentRunContractError(
          "attempt_conflict",
          "cannot create a retry attempt without a confirmed provider rejection",
        );
      }
      if (!["succeeded", "failed", "cancelled", "timed_out"].includes(current.status)) {
        throw new UnifiedAgentRunContractError("attempt_conflict", "current attempt must be terminal before a retry");
      }
      if (owner.span.attemptId !== current.id) {
        throw persistenceError("contract", `heartbeat run ${runId} native span does not match the current attempt`);
      }
      if (owner.span.state === "open" || !owner.span.writerLeaseReleasedAt) {
        throw new UnifiedAgentRunContractError(
          "attempt_conflict",
          "cannot create a retry attempt until the prior native writer is confirmed quiescent",
        );
      }
      if (input.attemptIndex <= current.attemptIndex) {
        throw new UnifiedAgentRunContractError("attempt_conflict", "attempt index must increase monotonically");
      }
      const ref = await beginHeartbeatRunAttempt(tx, {
        orgId: owner.run.orgId,
        runId,
        agentId: owner.run.agentId,
        attemptIndex: input.attemptIndex,
        fallbackIndex: input.fallbackIndex ?? null,
        runtimeType,
        model: input.model?.trim() || null,
        isFallback: input.isFallback ?? false,
        resumeSource: input.resumeSource,
        ownerToken: fence.ownerToken,
        attemptEpoch: fence.attemptEpoch,
      });
      if (!ref) throw persistenceError("contract", `heartbeat run ${runId} retry attempt was not persisted`);
      const nextAttempt = await tx
        .select()
        .from(heartbeatRunAttempts)
        .where(and(eq(heartbeatRunAttempts.id, ref.id), eq(heartbeatRunAttempts.orgId, owner.run.orgId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!nextAttempt) throw persistenceError("contract", `heartbeat run ${runId} retry attempt cannot be read back`);
      if (nextAttempt.runtimeType !== stored.runtimeType) {
        throw persistenceError(
          "contract",
          `heartbeat run ${runId} retry attempt.runtimeType=${nextAttempt.runtimeType} does not match admission.runtimeType=${stored.runtimeType}`,
        );
      }
      const retryAdmission = admissionInputFromStored(owner.run, stored, nextAttempt);
      const retrySpan = await startHeartbeatRetrySpan({
        tx,
        resolveNativeSpan,
        run: owner.run,
        stored,
        admission: retryAdmission,
        attempt: nextAttempt,
        runtimeType,
        fence,
      });
      const submission: UnifiedStoredSubmission = {
        key: `${stored.idempotencyKey}:attempt:${nextAttempt.attemptIndex}`,
        state: "pending",
        phase: "pre_submission",
        retry: "allowed",
        providerThreadId: null,
        providerTurnId: null,
        reason: null,
      };
      await tx.update(heartbeatRunAttempts)
        .set({
          checkpointJson: checkpointWithSubmission(nextAttempt.checkpointJson, submission),
          submissionPhase: "pre_submission",
        })
        .where(and(
          eq(heartbeatRunAttempts.id, nextAttempt.id),
          eq(heartbeatRunAttempts.orgId, owner.run.orgId),
          eq(heartbeatRunAttempts.runId, runId),
        ));
      const entry = await loadPersistedUnifiedEntry(tx, runId);
      if (!entry) throw persistenceError("contract", `heartbeat run ${runId} disappeared after retry admission`);
      return { ok: true, value: entry.attempt };
    });
  }

  async function markAttemptWaiting(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedAttemptWaitingInput = {},
  ): Promise<UnifiedFenceResult<UnifiedRunAttempt>> {
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockRun(tx, runId);
      const owner = await selectOwnerState(tx, runId, fence, now());
      if (!owner.ok) return owner;
      const attempt = await selectCurrentAttempt(tx, runId, owner.run.orgId);
      if (!attempt) throw persistenceError("contract", `heartbeat run ${runId} has no attempt to suspend`);
      const submission = readSubmission(attempt);
      const updated = await markHeartbeatRunAttemptWaiting(tx, {
        id: attempt.id,
        attemptIndex: attempt.attemptIndex,
        ownerToken: fence.ownerToken,
        attemptEpoch: fence.attemptEpoch,
      }, {
        ...input,
        providerThreadId: providerField(input.providerThreadId) ?? submission.providerThreadId,
        providerTurnId: providerField(input.providerTurnId) ?? submission.providerTurnId,
      });
      if (!updated) {
        const current = await tx
          .select()
          .from(heartbeatRunAttempts)
          .where(eq(heartbeatRunAttempts.id, attempt.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!current || current.status !== "waiting_for_network") {
          throw persistenceError("contract", `attempt ${attempt.id} disappeared while recording network wait`);
        }
      }
      const entry = await loadPersistedUnifiedEntry(tx, runId);
      if (!entry) throw persistenceError("contract", `heartbeat run ${runId} disappeared after attempt suspension`);
      return { ok: true, value: entry.attempt };
    });
  }

  async function finishAttempt(
    runId: string,
    fence: UnifiedOwnerFence,
    status: UnifiedAttemptTerminalStatus,
    input: UnifiedAttemptFinishInput = {},
  ): Promise<UnifiedFenceResult<UnifiedRunAttempt>> {
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockRun(tx, runId);
      const owner = await selectOwnerState(tx, runId, fence, now());
      if (!owner.ok) return owner;
      const attempt = await selectCurrentAttempt(tx, runId, owner.run.orgId);
      if (!attempt) throw persistenceError("contract", `heartbeat run ${runId} has no attempt to finish`);
      const submission = readSubmission(attempt);
      const updated = await finishHeartbeatRunAttempt(tx, {
        id: attempt.id,
        attemptIndex: attempt.attemptIndex,
        ownerToken: fence.ownerToken,
        attemptEpoch: fence.attemptEpoch,
      }, {
        status,
        submissionPhase: input.submissionPhase ?? submission.phase,
        providerThreadId: providerField(input.providerThreadId) ?? submission.providerThreadId,
        providerTurnId: providerField(input.providerTurnId) ?? submission.providerTurnId,
        sessionDisplayId: input.sessionDisplayId,
        sessionParamsJson: input.sessionParamsJson,
        usageDeltaJson: input.usageDeltaJson,
        costUsd: input.costUsd,
        errorCode: input.errorCode,
        error: input.error,
        finishedAt: input.finishedAt ?? now(),
      });
      if (!updated) {
        const current = await tx
          .select()
          .from(heartbeatRunAttempts)
          .where(eq(heartbeatRunAttempts.id, attempt.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!current) throw persistenceError("contract", `attempt ${attempt.id} disappeared while finishing`);
        if (current.status !== status) {
          throw new UnifiedAgentRunContractError("attempt_conflict", `attempt ${attempt.id} is already terminal as ${current.status}`);
        }
      }
      const entry = await loadPersistedUnifiedEntry(tx, runId);
      if (!entry) throw persistenceError("contract", `heartbeat run ${runId} disappeared after attempt finish`);
      return { ok: true, value: entry.attempt };
    });
  }

  async function recordExecutionResult(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedNativeExecutionInput,
  ): Promise<UnifiedFenceResult<UnifiedRunSpan>> {
    const owner = await selectOwnerState(db, runId, fence, now());
    if (!owner.ok) return owner;
    const spanId = input.spanId?.trim() || owner.span.id;
    const attemptId = input.attemptId?.trim() || owner.attempt.id;
    if (spanId !== owner.span.id || attemptId !== owner.attempt.id || owner.span.attemptId !== attemptId) {
      return { ok: false, reason: "stale_owner" };
    }
    const updated = await finishRunRuntimeSpan(db, {
      orgId: owner.run.orgId,
      runId,
      spanId,
      attemptId,
      ownerToken: fence.ownerToken,
      runtimeType: owner.attempt.runtimeType,
      attemptEpoch: fence.attemptEpoch,
      result: input.result,
      error: input.error,
      suspended: input.suspended,
      visibilityCutoffRef: input.visibilityCutoffRef,
    });
    if (!updated) return { ok: false, reason: "stale_owner" };
    const entry = await loadPersistedUnifiedEntry(db, runId);
    if (!entry) throw persistenceError("contract", `heartbeat run ${runId} disappeared after native execution result`);
    return { ok: true, value: entry.span };
  }

  async function mutateSubmission(
    runId: string,
    fence: UnifiedOwnerFence,
    mutation: (current: UnifiedStoredSubmission) => UnifiedStoredSubmission,
  ): Promise<UnifiedFenceResult<UnifiedSubmission>> {
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockRun(tx, runId);
      const owner = await selectOwnerState(tx, runId, fence, now());
      if (!owner.ok) return owner;
      const attempt = await selectCurrentAttempt(tx, runId, owner.run.orgId);
      if (!attempt) throw persistenceError("contract", `heartbeat run ${runId} has no current attempt for submission`);
      const current = readSubmission(attempt);
      const next = mutation(current);
      await updateSubmission(tx, attempt, next);
      const entry = await loadPersistedUnifiedEntry(tx, runId);
      if (!entry) throw persistenceError("contract", `heartbeat run ${runId} disappeared after submission mutation`);
      return { ok: true, value: entry.attempt.submission };
    });
  }

  async function acceptSubmission(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedSubmissionOutcome = {},
  ): Promise<UnifiedFenceResult<UnifiedSubmission>> {
    return mutateSubmission(runId, fence, (current) => {
      submissionKeyFor(current, input);
      if (current.state === "acceptance_unknown") {
        throw new UnifiedAgentRunContractError(
          "acceptance_unknown_requires_reconciliation",
          "provider acceptance is unknown; reconcile before accepting or retrying",
        );
      }
      if (current.state === "accepted") return current;
      if (current.state === "rejected") {
        throw new UnifiedAgentRunContractError("attempt_conflict", "a rejected submission cannot be accepted later");
      }
      return {
        ...current,
        state: "accepted",
        phase: "accepted",
        retry: "not_allowed",
        providerThreadId: providerField(input.providerThreadId) ?? current.providerThreadId,
        providerTurnId: providerField(input.providerTurnId) ?? current.providerTurnId,
        reason: null,
      };
    });
  }

  async function markAcceptanceUnknown(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedAcceptanceUnknownInput = {},
  ): Promise<UnifiedFenceResult<UnifiedSubmission>> {
    return mutateSubmission(runId, fence, (current) => {
      submissionKeyFor(current, input);
      if (current.state === "accepted" || current.state === "acceptance_unknown") return current;
      return {
        ...current,
        state: "acceptance_unknown",
        phase: input.phase ?? "indeterminate",
        retry: "blocked_until_reconciled",
        providerThreadId: providerField(input.providerThreadId) ?? current.providerThreadId,
        providerTurnId: providerField(input.providerTurnId) ?? current.providerTurnId,
        reason: input.reason?.trim() || current.reason || "provider acceptance could not be determined",
      };
    });
  }

  async function reconcileAcceptance(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedAcceptanceReconciliationInput,
  ): Promise<UnifiedFenceResult<UnifiedSubmission>> {
    return mutateSubmission(runId, fence, (current) => {
      submissionKeyFor(current, input);
      const confirmedPreSubmissionRejection = current.state === "pending"
        && current.phase === "pre_submission"
        && input.state === "rejected";
      const confirmedPendingAcceptance = current.state === "pending" && input.state === "accepted";
      if (current.state !== "acceptance_unknown" && current.state !== input.state
        && !confirmedPreSubmissionRejection && !confirmedPendingAcceptance) {
        throw new UnifiedAgentRunContractError("attempt_conflict", "submission reconciliation does not match current state");
      }
      return {
        ...current,
        state: input.state,
        phase: input.state === "accepted"
          ? "accepted"
          : current.phase === "pre_submission" ? "pre_submission" : "indeterminate",
        retry: input.state === "accepted" ? "not_allowed" : "allowed",
        providerThreadId: providerField(input.providerThreadId) ?? current.providerThreadId,
        providerTurnId: providerField(input.providerTurnId) ?? current.providerTurnId,
        reason: input.state === "accepted"
          ? null
          : input.reason?.trim() || current.reason || "provider rejected submission",
      };
    });
  }

  async function sealSpan(
    runId: string,
    fence: UnifiedOwnerFence,
    input: UnifiedSpanSealInput,
  ): Promise<UnifiedFenceResult<UnifiedRunSpan>> {
    const observedAt = now();
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockRun(tx, runId);
      const owner = await selectOwnerState(tx, runId, fence, observedAt);
      if (!owner.ok) return owner;
      const nextState = input.completeness === "complete" ? "sealed" : "unresolved";
      const [updated] = await tx
        .update(runRuntimeSpans)
        .set({
          state: nextState,
          completeness: input.completeness,
          sourceRevision: input.sourceRevision?.trim() || null,
          visibilityCutoffRef: input.visibilityCutoffRef?.trim() || null,
          closedAt: observedAt,
          updatedAt: observedAt,
        })
        .where(and(
          eq(runRuntimeSpans.id, owner.span.id),
          eq(runRuntimeSpans.orgId, owner.run.orgId),
          eq(runRuntimeSpans.runId, runId),
          eq(runRuntimeSpans.ownerToken, fence.ownerToken),
          eq(runRuntimeSpans.attemptEpoch, fence.attemptEpoch),
        ))
        .returning();
      if (!updated) throw persistenceError("contract", `native span ${owner.span.id} seal lost its owner CAS`);
      return {
        ok: true,
        value: {
          id: updated.id,
          runId: updated.runId,
          attemptRef: { id: updated.attemptId!, attemptIndex: (await selectCurrentAttempt(tx, runId, owner.run.orgId))!.attemptIndex },
          ownerFence: fence,
          state: updated.state,
          completeness: updated.completeness,
          sourceRevision: updated.sourceRevision,
          visibilityCutoffRef: updated.visibilityCutoffRef,
        },
      };
    });
  }

  async function finishRun(
    runId: string,
    fence: UnifiedOwnerFence,
    status: UnifiedRunTerminalStatus,
    input: UnifiedRunTerminalInput = {},
  ): Promise<UnifiedFenceResult<UnifiedAgentRunEntry>> {
    const observedAt = now();
    try {
      return await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await lockRun(tx, runId);
      const owner = await selectOwnerState(tx, runId, fence, observedAt);
      if (!owner.ok) return owner;
      const currentRun = await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!currentRun) return { ok: false, reason: "run_not_found" };
      const stored = readPersistedAdmission(currentRun);
      if (!stored) throw persistenceError("contract", `heartbeat run ${runId} has no unified admission metadata`);
      const currentAttempt = await selectCurrentAttempt(tx, runId, owner.run.orgId);
      if (!currentAttempt) throw persistenceError("contract", `heartbeat run ${runId} has no attempt for terminal transition`);
      const currentSubmission = readSubmission(currentAttempt);
      if (input.nativeExecution?.result.submissionPhase === "accepted"
        && input.attempt?.submissionPhase === "accepted") {
        if (currentSubmission.state === "rejected" || currentSubmission.state === "acceptance_unknown") {
          throw new UnifiedAgentRunContractError("attempt_conflict", "accepted native terminal result conflicts with submission state");
        }
        if (currentSubmission.state !== "accepted") {
          await updateSubmission(tx, currentAttempt, {
            ...currentSubmission,
            state: "accepted", phase: "accepted", retry: "not_allowed",
            providerThreadId: input.attempt.providerThreadId?.trim() || currentSubmission.providerThreadId,
            providerTurnId: input.attempt.providerTurnId?.trim() || currentSubmission.providerTurnId,
            reason: null,
          });
        }
      }
      if (input.nativeExecution) {
        if (input.nativeExecution.suspended) {
          throw persistenceError("contract", `terminal heartbeat run ${runId} cannot suspend its native span`);
        }
        const recorded = await finishRunRuntimeSpan(tx, {
          orgId: owner.run.orgId,
          runId,
          spanId: input.nativeExecution.spanId ?? owner.span.id,
          ownerToken: fence.ownerToken,
          runtimeType: owner.attempt.runtimeType,
          attemptEpoch: fence.attemptEpoch,
          result: input.nativeExecution.result,
          error: input.nativeExecution.error,
          visibilityCutoffRef: input.nativeExecution.visibilityCutoffRef,
          touchRunActivity: false,
        });
        if (!recorded) return { ok: false, reason: "stale_owner" };
      }
      const terminalStored = {
        ...stored,
        ownerFenceId: owner.span.id,
        lastOwnerToken: fence.ownerToken,
        attemptEpoch: fence.attemptEpoch,
        lastLeaseExpiresAt: observedAt.toISOString(),
      } satisfies UnifiedStoredAdmission;
      const terminal = await transitionHeartbeatRunToTerminal(tx, {
        runId,
        status,
        patch: {
          finishedAt: input.terminalFields?.finishedAt ?? observedAt,
          ...(input.terminalFields?.exitCode !== undefined ? { exitCode: input.terminalFields.exitCode } : {}),
          ...(input.terminalFields?.signal !== undefined ? { signal: input.terminalFields.signal } : {}),
          ...(input.terminalFields?.sessionIdAfter !== undefined ? { sessionIdAfter: input.terminalFields.sessionIdAfter } : {}),
          ...(input.terminalFields?.sessionParamsAfterJson !== undefined
            ? { sessionParamsAfterJson: input.terminalFields.sessionParamsAfterJson }
            : {}),
          ...(input.terminalFields?.stdoutExcerpt !== undefined ? { stdoutExcerpt: input.terminalFields.stdoutExcerpt } : {}),
          ...(input.terminalFields?.stderrExcerpt !== undefined ? { stderrExcerpt: input.terminalFields.stderrExcerpt } : {}),
          ...(input.terminalFields?.logBytes !== undefined ? { logBytes: input.terminalFields.logBytes } : {}),
          ...(input.terminalFields?.logSha256 !== undefined ? { logSha256: input.terminalFields.logSha256 } : {}),
          ...(input.terminalFields?.logCompressed !== undefined ? { logCompressed: input.terminalFields.logCompressed } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
          ...(input.resultJson !== undefined ? { resultJson: input.resultJson } : {}),
          ...(input.resultSummaryJson !== undefined ? { resultSummaryJson: input.resultSummaryJson } : {}),
          ...(input.usageJson !== undefined ? { usageJson: input.usageJson } : {}),
          contextSnapshot: contextWithAdmission(currentRun.contextSnapshot, terminalStored),
        },
        expectedStatuses: input.expectedStatuses ?? ["running"],
        activityWatermark: input.activityWatermark,
        terminalEffectsPending: input.terminalEffectsPending ?? true,
        terminalEffectsIntent: input.terminalEffectsIntent as TerminalEffectIntent | null | undefined,
        processExitedAt: input.processExitedAt !== undefined ? input.processExitedAt : observedAt,
        expectedExecutionOwnerToken: fence.ownerToken,
      });
      if (!terminal) {
        const latest = await tx
          .select({
            status: heartbeatRuns.status,
            executionOwnerToken: heartbeatRuns.executionOwnerToken,
            updatedAt: heartbeatRuns.updatedAt,
          })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!latest) return { ok: false, reason: "run_not_found" };
        throw new UnifiedRunTerminalCasMiss({
          ok: false,
          reason: latest.status !== "running" ? "run_terminal" : "stale_owner",
        });
      }
      if (!["succeeded", "failed", "cancelled", "timed_out"].includes(currentAttempt.status)) {
        const finishedAttempt = await finishHeartbeatRunAttempt(tx, {
          id: currentAttempt.id,
          attemptIndex: currentAttempt.attemptIndex,
          ownerToken: fence.ownerToken,
          attemptEpoch: fence.attemptEpoch,
        }, {
          status,
          submissionPhase: input.attempt?.submissionPhase
            ?? (input.error || input.errorCode ? "indeterminate" : currentSubmission.phase),
          providerThreadId: input.attempt?.providerThreadId ?? currentSubmission.providerThreadId,
          providerTurnId: input.attempt?.providerTurnId ?? currentSubmission.providerTurnId,
          sessionDisplayId: input.attempt?.sessionDisplayId,
          sessionParamsJson: input.attempt?.sessionParamsJson,
          usageDeltaJson: input.attempt?.usageDeltaJson,
          costUsd: input.attempt?.costUsd,
          errorCode: input.attempt?.errorCode ?? input.errorCode,
          error: input.attempt?.error ?? input.error,
          finishedAt: input.attempt?.finishedAt ?? observedAt,
        });
        if (!finishedAttempt) {
          const latestAttempt = await tx
            .select({ status: heartbeatRunAttempts.status })
            .from(heartbeatRunAttempts)
            .where(eq(heartbeatRunAttempts.id, currentAttempt.id))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (latestAttempt?.status !== status) {
            throw new UnifiedAgentRunContractError(
              "attempt_conflict",
              `attempt ${currentAttempt.id} could not be finalized with its Run`,
            );
          }
        }
      }
      if (owner.span.state === "open" && !input.nativeExecution) {
        const [unresolved] = await tx
          .update(runRuntimeSpans)
          .set({
            state: "unresolved",
            completeness: "unknown",
            closedAt: observedAt,
            updatedAt: observedAt,
          })
          .where(and(
            eq(runRuntimeSpans.id, owner.span.id),
            eq(runRuntimeSpans.orgId, currentRun.orgId),
            eq(runRuntimeSpans.runId, runId),
            eq(runRuntimeSpans.ownerToken, fence.ownerToken),
            eq(runRuntimeSpans.attemptEpoch, fence.attemptEpoch),
            eq(runRuntimeSpans.state, "open"),
          ))
          .returning({ id: runRuntimeSpans.id });
        if (!unresolved) throw persistenceError("contract", `terminal transition for ${runId} could not close its native span`);
      }
      const entry = await loadPersistedUnifiedEntry(tx, runId);
      if (!entry) throw persistenceError("contract", `heartbeat run ${runId} disappeared after terminal transition`);
      return { ok: true, value: entry };
      });
    } catch (error) {
      if (error instanceof UnifiedRunTerminalCasMiss) return error.result;
      throw error;
    }
  }

  return {
    admit,
    get,
    claimOwner,
    renewOwner,
    beginAttempt,
    finishAttempt,
    acceptSubmission,
    markAcceptanceUnknown,
    reconcileAcceptance,
    sealSpan,
    markAttemptWaiting,
    recordExecutionResult,
    finishRun,
  };
}
