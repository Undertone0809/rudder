import type { Db } from "@rudderhq/db";
import { agents, heartbeatRunAttempts, heartbeatRunEvents, heartbeatRuns } from "@rudderhq/db";
import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import * as heartbeatSessions from "./heartbeat.sessions.js";
import { readSubmission } from "./unified-agent-run.persistence-support.js";

const { isTrackedLocalChildProcessAdapter, isProcessAlive } = heartbeatSessions;
const DEFAULT_HEARTBEAT_RUN_TIMEOUT_MS = 0;
const DEFAULT_HEARTBEAT_RUN_INACTIVITY_TIMEOUT_MS = 0;

export async function ensureProviderWriterStopped(input: {
  run: typeof heartbeatRuns.$inferSelect;
  agentRuntimeType: string;
  activeRunExecutions: Set<string>;
  terminateRunProcessAndWait: (
    run: typeof heartbeatRuns.$inferSelect,
    agentRuntimeType: string,
  ) => Promise<boolean>;
}) {
  if (input.run.processExitedAt) return { ok: true as const, kind: "recorded_exit" as const };
  if (!isTrackedLocalChildProcessAdapter(input.agentRuntimeType)) {
    return { ok: false as const, reason: "unsupported_runtime" as const };
  }
  if (!Number.isInteger(input.run.processPid) || !input.run.processPid || input.run.processPid <= 0) {
    return { ok: false as const, reason: "missing_process_identity" as const };
  }

  const stopped = await input.terminateRunProcessAndWait(input.run, input.agentRuntimeType);
  if (!stopped) return { ok: false as const, reason: "process_still_alive" as const };
  if (input.activeRunExecutions.has(input.run.id)) {
    return { ok: false as const, reason: "execution_not_quiescent" as const };
  }
  return { ok: true as const, kind: "process_stopped" as const };
}

export async function checkProcessLossRetrySubmission(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  const context = run.contextSnapshot as Record<string, unknown> | null;
  const nativeRun = Boolean(run.scene || run.idempotencyKey || context?.unifiedAgentRun);
  const attempt = await db
    .select()
    .from(heartbeatRunAttempts)
    .where(and(
      eq(heartbeatRunAttempts.orgId, run.orgId),
      eq(heartbeatRunAttempts.runId, run.id),
    ))
    .orderBy(desc(heartbeatRunAttempts.attemptIndex))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!attempt) return nativeRun
    ? { allowed: false as const, reason: "submission_evidence_missing" as const }
    : { allowed: true as const, reason: null };
  const checkpoint = attempt.checkpointJson as Record<string, unknown> | null;
  if (!nativeRun && !checkpoint?.unifiedSubmission) return { allowed: true as const, reason: null };

  let submission;
  try {
    submission = readSubmission(attempt);
  } catch {
    return { allowed: false as const, reason: "submission_evidence_invalid" as const };
  }

  if (submission.state !== "rejected" || submission.retry !== "allowed") {
    return { allowed: false as const, reason: `submission_${submission.state}` };
  }
  return { allowed: true as const, reason: null };
}

async function suppressUnsafePendingProcessLossRetry(db: Db, runId: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from heartbeat_runs where id = ${runId} for update`);
    const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    if (!current?.terminalEffectsPending || current.terminalEffectsJson?.processLossRetry !== true) return current;
    const safety = await checkProcessLossRetrySubmission(tx as unknown as Db, current);
    if (safety.allowed) return current;
    const [updated] = await tx.update(heartbeatRuns).set({
      terminalEffectsJson: { ...current.terminalEffectsJson, processLossRetry: false },
      updatedAt: new Date(),
    }).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.terminalEffectsPending, true)))
      .returning();
    return updated ?? current;
  });
}

export function createHeartbeatReaperHandlers(context: { db: Db; [key: string]: any }) {
  const {
    db,
    agentIssueCreationSvc,
    activeRunExecutions,
    DETACHED_PROCESS_ERROR_CODE,
    runningProcesses,
    pruneLocalExecutionLeaseStates,
    localExecutionOwnerMatches,
    renewRunExecutionLease,
    abortRunExecution,
    claimRunForRecovery,
    setRunStatus,
    appendRunEvent,
    completeTerminalControlEffects,
    terminateRunProcessAndWait,
    acknowledgeRunProcessExit,
    transitionRunToTerminal,
    setWakeupStatus,
    preserveLiveExecutionAfterSleep,
    withHeartbeatRecoveryLock,
    formatDurationMs,
    onOrphanedClaudeForkRun,
  } = context;
  async function reapOrphanedRunsLocked(opts?: { staleThresholdMs?: number; now?: Date; recoveryCutoff?: Date }) {
    pruneLocalExecutionLeaseStates();
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const now = opts?.now ?? new Date();
    const recoveryCutoff = opts?.recoveryCutoff ?? now;
    const reaped: string[] = [];

    try {
      // Find all runs stuck in "running" state (queued runs are legitimately waiting; resumeQueuedRuns handles them)
      const activeRuns = await db
        .select({
          run: heartbeatRuns,
          agentRuntimeType: agents.agentRuntimeType,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(or(
          and(
            eq(heartbeatRuns.status, "running"),
            or(isNull(heartbeatRuns.runningSubstate), ne(heartbeatRuns.runningSubstate, "waiting_for_network")),
          ),
          eq(heartbeatRuns.terminalEffectsPending, true),
        ));

      for (const { run, agentRuntimeType } of activeRuns) {
      if (run.terminalEffectsPending) {
        const pendingRun = await suppressUnsafePendingProcessLossRetry(db, run.id);
        if (!pendingRun) continue;
        if (!pendingRun.processExitedAt) {
          const exited = await terminateRunProcessAndWait(pendingRun, agentRuntimeType);
          if (!exited || activeRunExecutions.has(pendingRun.id)) continue;
          await acknowledgeRunProcessExit(pendingRun.id);
        }
        const completed = await completeTerminalControlEffects(pendingRun);
        if (!completed) continue;
        reaped.push(run.id);
        continue;
      }

      // Apply staleness threshold to avoid false positives
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      // The lease timer pauses while the host sleeps, but the child process
      // and this server's execution registry can remain alive. Preserve that
      // local execution instead of turning it into a process-loss retry.
      if (activeRunExecutions.has(run.id) || runningProcesses.has(run.id)) {
        if (!localExecutionOwnerMatches(run.id, run.executionOwnerToken)) {
          abortRunExecution(run.id);
          continue;
        }
        if (run.executionOwnerToken) {
          const renewed = await renewRunExecutionLease(run.id, run.executionOwnerToken, now);
          if (!renewed) abortRunExecution(run.id);
        }
        continue;
      }

      const recoveryClaim = await claimRunForRecovery(run, { now, recoveryCutoff });
      if (!recoveryClaim) continue;
      const claimedRun = recoveryClaim.run;
      const recoveryOwnerToken = recoveryClaim.ownerToken;

      const tracksLocalChild = isTrackedLocalChildProcessAdapter(agentRuntimeType);
      let detachedTerminationMessage: string | null = null;
      const writerStop = await ensureProviderWriterStopped({
        run: claimedRun,
        agentRuntimeType,
        activeRunExecutions,
        terminateRunProcessAndWait,
      });
      if (!writerStop.ok) {
        const reason = writerStop.reason;
        const detachedMessage = reason === "missing_process_identity"
          ? "Recovery is blocked because the prior provider writer has no persisted process identity"
          : reason === "unsupported_runtime"
            ? `Recovery is blocked because Rudder cannot terminate provider writers for runtime ${agentRuntimeType}`
            : reason === "execution_not_quiescent"
              ? "Recovery is blocked because the prior provider execution has not quiesced after process termination"
              : `Recovery is blocked because the prior provider process could not be confirmed stopped (pid ${claimedRun.processPid})`;
        const detachedRun = await setRunStatus(claimedRun.id, "running", {
          error: detachedMessage,
          errorCode: DETACHED_PROCESS_ERROR_CODE,
        });
        if (detachedRun) {
          await appendRunEvent(detachedRun, {
            eventType: "lifecycle",
            stream: "system",
            level: "warn",
            message: detachedMessage,
            payload: {
              processPid: claimedRun.processPid,
              providerWriterStopReason: reason,
            },
          });
        }
        continue;
      }
      if (writerStop.kind === "process_stopped") {
        detachedTerminationMessage = `Confirmed prior provider writer process ${claimedRun.processPid} stopped before heartbeat recovery`;
      }

      const admission = (claimedRun.contextSnapshot as Record<string, unknown> | null)?.sideChatRuntimeAdmission;
      const isClaudeDeferredFork = agentRuntimeType === "claude_local" && claimedRun.scene === "side_chat"
        && admission && typeof admission === "object" && !Array.isArray(admission)
        && Boolean((admission as Record<string, unknown>).deferredForkDescriptor);
      if (isClaudeDeferredFork && onOrphanedClaudeForkRun) {
        try {
          if (await onOrphanedClaudeForkRun(claimedRun)) {
            reaped.push(claimedRun.id);
            continue;
          }
        } catch (error) {
          logger.warn({ err: error, runId: claimedRun.id }, "Claude fork orphan recovery will retry after lease expiry");
          continue;
        }
      }

      const retryCandidate = !isClaudeDeferredFork && tracksLocalChild && !!claimedRun.processPid
        && (claimedRun.processLossRetryCount ?? 0) < 1;
      const submissionSafety = retryCandidate
        ? await checkProcessLossRetrySubmission(db, claimedRun)
        : null;
      const shouldRetry = retryCandidate && submissionSafety?.allowed === true;
      const baseMessage = claimedRun.processPid
        ? `Process lost -- child pid ${claimedRun.processPid} is no longer running`
        : "Process lost -- server may have restarted";
      const retrySuppressedMessage = retryCandidate && !shouldRetry
        ? `; automatic retry suppressed because ${submissionSafety?.reason ?? "provider submission safety was not established"}`
        : "";

      let finalizedRun = await transitionRunToTerminal(claimedRun.id, "failed", {
        error: shouldRetry
          ? baseMessage
          : `${baseMessage}${retrySuppressedMessage}`,
        errorCode: retryCandidate && !shouldRetry ? "process_lost_acceptance_unresolved" : "process_lost",
        finishedAt: now,
      }, {
        processExitedAt: now,
        terminalEffectsIntent: shouldRetry ? { version: 1, processLossRetry: true } : { version: 1 },
        expectedExecutionOwnerToken: recoveryOwnerToken,
      });
      if (!finalizedRun) continue;
      if (shouldRetry) {
        finalizedRun = await suppressUnsafePendingProcessLossRetry(db, finalizedRun.id);
        if (!finalizedRun) continue;
      }
      const retryCommitted = shouldRetry && finalizedRun.terminalEffectsJson?.processLossRetry === true;
      const finalSubmissionSafety = shouldRetry && !retryCommitted
        ? await checkProcessLossRetrySubmission(db, finalizedRun)
        : submissionSafety;
      const finalRetrySuppressedMessage = retryCandidate && !retryCommitted
        ? `; automatic retry suppressed because ${finalSubmissionSafety?.reason ?? "provider submission safety was not established"}`
        : "";
      await setWakeupStatus(claimedRun.wakeupRequestId, "failed", {
        finishedAt: now,
        error: retryCommitted
          ? `${baseMessage}; retrying once`
          : `${baseMessage}${finalRetrySuppressedMessage}`,
      });
      if (detachedTerminationMessage) {
        await appendRunEvent(finalizedRun, {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: detachedTerminationMessage,
          payload: {
            ...(claimedRun.processPid ? { processPid: claimedRun.processPid } : {}),
          },
        });
      }

      await appendRunEvent(finalizedRun, {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: retryCommitted
          ? `${baseMessage}; retry will be queued after terminal effects complete`
          : `${baseMessage}${finalRetrySuppressedMessage}`,
        payload: {
          ...(claimedRun.processPid ? { processPid: claimedRun.processPid } : {}),
          ...(retryCandidate && !retryCommitted
            ? { processLossRetrySuppressedReason: finalSubmissionSafety?.reason ?? "unknown" }
            : {}),
        },
      });
      const completed = await completeTerminalControlEffects(finalizedRun);
      runningProcesses.delete(claimedRun.id);
      if (!completed) continue;
      reaped.push(claimedRun.id);
      }
    } finally {
      // Terminal effects are the fast path. Keep a request-scoped sweep as a
      // second durable path for runs whose effect was lost or dead-lettered.
      await agentIssueCreationSvc.reconcileTerminalSettlements().catch((error: unknown) => {
        logger.warn({ err: error }, "failed to reconcile terminal Agent Issue creation requests");
      });
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  async function reapInactiveRunsLocked(opts?: { maxInactivityMs?: number; now?: Date; recoveryCutoff?: Date }) {
    pruneLocalExecutionLeaseStates();
    const maxInactivityMs = opts?.maxInactivityMs ?? DEFAULT_HEARTBEAT_RUN_INACTIVITY_TIMEOUT_MS;
    if (!Number.isFinite(maxInactivityMs) || maxInactivityMs <= 0) {
      return { timedOut: 0, runIds: [] };
    }

    const now = opts?.now ?? new Date();
    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        agentRuntimeType: agents.agentRuntimeType,
        lastEventAt: sql<Date | null>`max(${heartbeatRunEvents.createdAt})`,
        eventCount: sql<number>`count(${heartbeatRunEvents.id})::int`,
        updatedAtExact: sql<string>`to_char(${heartbeatRuns.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .leftJoin(heartbeatRunEvents, eq(heartbeatRunEvents.runId, heartbeatRuns.id))
      .where(and(
        eq(heartbeatRuns.status, "running"),
        or(isNull(heartbeatRuns.runningSubstate), ne(heartbeatRuns.runningSubstate, "waiting_for_network")),
      ))
      .groupBy(heartbeatRuns.id, agents.agentRuntimeType);

    const timedOut: string[] = [];

    for (const { run, agentRuntimeType, lastEventAt, eventCount, updatedAtExact } of activeRuns) {
      if (opts?.recoveryCutoff && new Date(run.createdAt).getTime() >= opts.recoveryCutoff.getTime()) continue;
      if (await preserveLiveExecutionAfterSleep(run, now)) continue;
      let activityTimes = [
        run.updatedAt,
        lastEventAt,
        run.processStartedAt,
        run.startedAt,
        run.createdAt,
      ]
        .map((value) => value ? new Date(value).getTime() : null)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      let lastActivityMs = activityTimes.length > 0 ? Math.max(...activityTimes) : null;
      if (!lastActivityMs) continue;

      let inactiveMs = now.getTime() - lastActivityMs;
      if (inactiveMs < maxInactivityMs) continue;

      const message = `Run had no recorded activity for ${formatDurationMs(maxInactivityMs)}`;
      let processExitPending =
        activeRunExecutions.has(run.id)
        || runningProcesses.has(run.id)
        || (!run.processExitedAt && isTrackedLocalChildProcessAdapter(agentRuntimeType) && !!run.processPid && isProcessAlive(run.processPid));
      let finalizedRun = await transitionRunToTerminal(run.id, "timed_out", {
        finishedAt: now,
        error: message,
        errorCode: "inactivity_timeout",
        terminalEffectsPending: true,
      }, {
        activityWatermark: {
          updatedAt: run.updatedAt,
          updatedAtExact,
          eventCount: Number(eventCount ?? 0),
        },
        processExitedAt: processExitPending ? null : now,
        expectedExecutionOwnerToken: run.executionOwnerToken,
      });
      if (!finalizedRun) {
        // A live executor can renew or persist its run between the watchdog
        // query and the terminal CAS. Re-read the watermark once: genuine
        // recent activity still wins, while an already stale run keeps the
        // watchdog's terminal ownership instead of being stranded forever.
        const current = await db
          .select({
            run: heartbeatRuns,
            lastEventAt: sql<Date | null>`max(${heartbeatRunEvents.createdAt})`,
            eventCount: sql<number>`count(${heartbeatRunEvents.id})::int`,
            updatedAtExact: sql<string>`to_char(${heartbeatRuns.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(heartbeatRuns)
          .leftJoin(heartbeatRunEvents, eq(heartbeatRunEvents.runId, heartbeatRuns.id))
          .where(eq(heartbeatRuns.id, run.id))
          .groupBy(heartbeatRuns.id)
          .then((rows) => rows[0] ?? null);
        if (
          current?.run.status === "running"
          && current.run.executionOwnerToken === run.executionOwnerToken
        ) {
          activityTimes = [
            current.run.updatedAt,
            current.lastEventAt,
            current.run.processStartedAt,
            current.run.startedAt,
            current.run.createdAt,
          ]
            .map((value) => value ? new Date(value).getTime() : null)
            .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
          lastActivityMs = activityTimes.length > 0 ? Math.max(...activityTimes) : null;
          inactiveMs = lastActivityMs === null ? 0 : now.getTime() - lastActivityMs;
          if (lastActivityMs !== null && inactiveMs >= maxInactivityMs) {
            processExitPending =
              activeRunExecutions.has(current.run.id)
              || runningProcesses.has(current.run.id)
              || (!current.run.processExitedAt
                && isTrackedLocalChildProcessAdapter(agentRuntimeType)
                && !!current.run.processPid
                && isProcessAlive(current.run.processPid));
            finalizedRun = await transitionRunToTerminal(current.run.id, "timed_out", {
              finishedAt: now,
              error: message,
              errorCode: "inactivity_timeout",
              terminalEffectsPending: true,
            }, {
              activityWatermark: {
                updatedAt: current.run.updatedAt,
                updatedAtExact: current.updatedAtExact,
                eventCount: Number(current.eventCount ?? 0),
              },
              processExitedAt: processExitPending ? null : now,
              expectedExecutionOwnerToken: current.run.executionOwnerToken,
            });
          }
        }
      }
      if (!finalizedRun || lastActivityMs === null) continue;
      await setWakeupStatus(run.wakeupRequestId, "timed_out", {
        finishedAt: now,
        error: message,
      });

      await appendRunEvent(finalizedRun, {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message,
        payload: {
          maxInactivityMs,
          inactiveMs,
          lastActivityAt: new Date(lastActivityMs).toISOString(),
          timedOutAt: now.toISOString(),
          ...(run.processPid ? { processPid: run.processPid } : {}),
        },
      });
      const processExited = !processExitPending || await terminateRunProcessAndWait(finalizedRun, agentRuntimeType);
      if (processExited && !activeRunExecutions.has(finalizedRun.id)) {
        await acknowledgeRunProcessExit(finalizedRun.id);
        await completeTerminalControlEffects(finalizedRun);
        runningProcesses.delete(run.id);
      }
      timedOut.push(run.id);
    }

    if (timedOut.length > 0) {
      logger.warn(
        { timedOutCount: timedOut.length, runIds: timedOut, maxInactivityMs },
        "timed out inactive heartbeat runs",
      );
    }

    return { timedOut: timedOut.length, runIds: timedOut };
  }

  async function reapTimedOutRunsLocked(opts?: { maxRuntimeMs?: number; now?: Date; recoveryCutoff?: Date }) {
    pruneLocalExecutionLeaseStates();
    const maxRuntimeMs = opts?.maxRuntimeMs ?? DEFAULT_HEARTBEAT_RUN_TIMEOUT_MS;
    if (!Number.isFinite(maxRuntimeMs) || maxRuntimeMs <= 0) {
      return { timedOut: 0, runIds: [] };
    }

    const now = opts?.now ?? new Date();
    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        agentRuntimeType: agents.agentRuntimeType,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(and(
        eq(heartbeatRuns.status, "running"),
        or(isNull(heartbeatRuns.runningSubstate), ne(heartbeatRuns.runningSubstate, "waiting_for_network")),
      ));

    const timedOut: string[] = [];

    for (const { run, agentRuntimeType } of activeRuns) {
      if (opts?.recoveryCutoff && new Date(run.createdAt).getTime() >= opts.recoveryCutoff.getTime()) continue;
      if (await preserveLiveExecutionAfterSleep(run, now)) continue;
      const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : null;
      if (!startedAt || !Number.isFinite(startedAt)) continue;

      const runtimeMs = Math.max(0, now.getTime() - startedAt - (run.networkWaitDurationMs ?? 0));
      if (runtimeMs < maxRuntimeMs) continue;

      const message = `Run exceeded maximum duration of ${formatDurationMs(maxRuntimeMs)}`;
      const processExitPending =
        activeRunExecutions.has(run.id)
        || runningProcesses.has(run.id)
        || (!run.processExitedAt && isTrackedLocalChildProcessAdapter(agentRuntimeType) && !!run.processPid && isProcessAlive(run.processPid));
      const finalizedRun = await transitionRunToTerminal(run.id, "timed_out", {
        finishedAt: now,
        error: message,
        errorCode: "timeout",
        terminalEffectsPending: true,
      }, {
        processExitedAt: processExitPending ? null : now,
        expectedExecutionOwnerToken: run.executionOwnerToken,
      });
      if (!finalizedRun) continue;
      await setWakeupStatus(run.wakeupRequestId, "timed_out", {
        finishedAt: now,
        error: message,
      });

      await appendRunEvent(finalizedRun, {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message,
        payload: {
          maxRuntimeMs,
          runtimeMs,
          startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
          timedOutAt: now.toISOString(),
          ...(run.processPid ? { processPid: run.processPid } : {}),
        },
      });
      const processExited = !processExitPending || await terminateRunProcessAndWait(finalizedRun, agentRuntimeType);
      if (processExited && !activeRunExecutions.has(finalizedRun.id)) {
        await acknowledgeRunProcessExit(finalizedRun.id);
        await completeTerminalControlEffects(finalizedRun);
        runningProcesses.delete(run.id);
      }
      timedOut.push(run.id);
    }

    if (timedOut.length > 0) {
      logger.warn(
        { timedOutCount: timedOut.length, runIds: timedOut, maxRuntimeMs },
        "timed out long-running heartbeat runs",
      );
    }

    return { timedOut: timedOut.length, runIds: timedOut };
  }

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number; now?: Date; recoveryCutoff?: Date }) {
    return withHeartbeatRecoveryLock(() => reapOrphanedRunsLocked(opts));
  }

  async function reapInactiveRuns(opts?: { maxInactivityMs?: number; now?: Date; recoveryCutoff?: Date }) {
    return withHeartbeatRecoveryLock(() => reapInactiveRunsLocked(opts));
  }

  async function reapTimedOutRuns(opts?: { maxRuntimeMs?: number; now?: Date; recoveryCutoff?: Date }) {
    return withHeartbeatRecoveryLock(() => reapTimedOutRunsLocked(opts));
  }

  return {
    reapOrphanedRuns,
    reapInactiveRuns,
    reapTimedOutRuns,
  };
}
