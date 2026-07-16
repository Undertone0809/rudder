// @ts-nocheck
import {
  activityLog,
  agents,
  agentWakeupRequests,
  automationRuns,
  automations,
  heartbeatRunEvents,
  heartbeatRuns,
  issues
} from "@rudderhq/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { parseObject } from "../../agent-runtimes/utils.js";
import { logActivity } from "../activity-log.js";
import {
  buildIssueConvergenceReviewWakeupOptions,
  buildIssueReviewCloseoutWakeupOptions,
} from "../issue-review-wakeup.js";
import { publishLiveEvent } from "../live-events.js";

export { prioritizeProjectWorkspaceCandidatesForRun, type ResolvedWorkspaceForRun } from "../agent-run-context.js";

import * as heartbeatCore from "./heartbeat.core.js";
import * as heartbeatSessions from "./heartbeat.sessions.js";
import { writeTerminalIssueSemanticAudit } from "./heartbeat.terminal.js";
const { MAX_LIVE_LOG_CHUNK_BYTES, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, DEFERRED_WAKE_CONTEXT_KEY, DETACHED_PROCESS_ERROR_CODE, ORPHANED_PROCESS_TERMINATION_GRACE_MS, ORPHANED_PROCESS_KILL_WAIT_MS, ORPHANED_PROCESS_POLL_INTERVAL_MS, startLocksByAgent, MAX_RECOVERY_CHAIN_DEPTH, ISSUE_PASSIVE_FOLLOWUP_REASON, ISSUE_PASSIVE_FOLLOWUP_WAKE_SOURCE, ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON, ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS, ISSUE_REVIEW_CLOSEOUT_REASON, ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON, ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS, ISSUE_PASSIVE_FOLLOWUP_COOLDOWN_MS_BY_ATTEMPT, ISSUE_PASSIVE_FOLLOWUP_TIMER_CONTINUITY_MAX_WINDOW_MS, SESSIONED_LOCAL_ADAPTERS, heartbeatRunListColumns, appendExcerpt, appendTranscriptEntriesFromChunk, normalizeMaxConcurrentRuns, withAgentStartLock, readNonEmptyString, resolveHeartbeatObservabilitySurface, buildHeartbeatObservationName, compactTraceText, buildIssueRunTraceName, buildHeartbeatRuntimeTraceMetadata, buildHeartbeatAdapterInvokePayload, buildRecentDateKeys, buildDateKeysBetween, fallbackSkillLabel, normalizeLoadedSkill, normalizeLoadedSkillForPayload, emptySkillEvidenceCounts, incrementSkillEvidenceCount, strongestSkillEvidence, resolveSkillEvidence, readSkillEvidenceFromPayload, extractSkillSlugFromPath, collectSkillPathsFromText, collectStringValues, normalizeSkillUseFromPath, dedupeSkillUses, collectSkillUsesFromText, readToolCommandInput, isCommandTranscriptTool, isReadTranscriptTool, inferUsedSkillsFromTranscript, normalizeSkillCandidate, addSkillCandidate, readSkillReferenceSlug, collectSkillReferences, inferUsedSkillsFromPrompt, normalizeLedgerBillingType, resolveLedgerBiller, normalizeBilledCostCents, resolveLedgerScopeForRun } = heartbeatCore;
const { buildExplicitResumeSessionOverride, normalizeUsageTotals, readRawUsageTotals, deriveNormalizedUsageDelta, formatCount, parseSessionCompactionPolicy, resolveRuntimeSessionParamsForWorkspace, parseIssueAssigneeAgentRuntimeOverrides, deriveTaskKey, shouldResetTaskSessionForWake, formatRuntimeWorkspaceWarningLog, describeSessionResetReason, deriveCommentId, enrichWakeContextSnapshot, mergeCoalescedContextSnapshot, issueCommentAuthorKind, issueCommentAuthorLabel, buildDeferredWakePayload, readDeferredWakeContext, readDeferredWakePayload, deriveDeferredWakeTaskKey, hydrateWakeContextSnapshot, firstNonEmptyLine, deriveRecoveryFailureKind, deriveRecoveryFailureSummary, mergeMissingRecoveryContextFields, hydrateRecoveryBaseContextSnapshot, buildRecoveryContextSnapshot, normalizePassiveFollowupContext, normalizeReviewCloseoutContext, passiveFollowupCooldownMs, issueHasReviewer, isAgentEligibleForTimerContinuation, hasCredibleTimerContinuation, buildPassiveFollowupContextSnapshot, runTaskKey, isSameTaskScope, isTrackedLocalChildProcessAdapter, isProcessAlive, waitForProcessExit, terminateOrphanedProcess, truncateDisplayId, normalizeAgentNameKey, defaultSessionCodec, getAgentRuntimeSessionCodec, normalizeSessionParams, resolveNextSessionState } = heartbeatSessions;

export function createHeartbeatReleaseHandlers(context: any) {
  const { db, instanceSettings, getCurrentUserRedactionOptions, runLogStore, runContextSvc, issuesSvc, executionWorkspacesSvc, workspaceOperationsSvc, activeRunExecutions, budgetHooks, budgets, getAgent, getRun, getRuntimeState, getTaskSession, getLatestRunForSession, getOldestRunForSession, resolveNormalizedUsageForSession, evaluateSessionCompaction, resolveSessionBeforeForWakeup, resolveExplicitResumeSessionOverride, upsertTaskSession, clearTaskSessions, ensureRuntimeState, buildHeartbeatObservabilityContext, emitHeartbeatObservationEvent, emitHeartbeatLiveEval, setRunStatus, setWakeupStatus, updateWakeupRequestRecord, insertWakeupRequestRecord, appendRunEvent, persistRunProcessMetadata, clearDetachedRunWarning, enqueueRecoveryRun, enqueueProcessLossRetry, parseHeartbeatPolicy, markAgentHeartbeatChecked, evaluateTimerPreflight, runHasIssueClosureComment, runHasIssueReviewDecision, issueHasDeferredWake, passiveFollowupAlreadyRecorded, reviewerCloseoutAlreadyRecorded, issueHasRecordedBlockedReviewerDecision, evaluatePassiveIssueClosureForLockedIssue, countRunningRunsForAgent, claimQueuedRun, finalizeAgentStatus, reapOrphanedRuns, resumeQueuedRuns, updateRuntimeState, startNextQueuedRunForAgent, executeRun, enqueueWakeup, resumeDeferredWakeupsForAgent, listProjectScopedRunIds, listProjectScopedWakeupIds, cancelPendingWakeupsForBudgetScope, cancelRunInternal, cancelActiveForAgentInternal, cancelBudgetScopeWork, retryRunInternal, buildSkillAnalytics } = context;

  async function completeChatOutputAutomationIssueIfEligible(input: {
    tx: any;
    run: typeof heartbeatRuns.$inferSelect;
    issue: typeof issues.$inferSelect;
    now: Date;
  }) {
    const { tx, run, issue, now } = input;
    if (
      run.status !== "succeeded" ||
      issue.originKind !== "automation_execution" ||
      !issue.originRunId ||
      (issue.status !== "todo" && issue.status !== "in_progress")
    ) {
      return null;
    }

    const execution = await tx
      .select({
        automationId: automations.id,
        automationTitle: automations.title,
        outputMode: automations.outputMode,
        runId: automationRuns.id,
      })
      .from(automationRuns)
      .innerJoin(automations, eq(automationRuns.automationId, automations.id))
      .where(
        and(
          eq(automationRuns.orgId, issue.orgId),
          sql`${automationRuns.id}::text = ${issue.originRunId}`,
        ),
      )
      .limit(1)
      .then((rows: Array<{
        automationId: string;
        automationTitle: string;
        outputMode: string;
        runId: string;
      }>) => rows[0] ?? null);

    if (!execution || execution.outputMode !== "chat_output") return null;

    await tx
      .update(issues)
      .set({
        status: "done",
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(issues.id, issue.id));

    await tx
      .update(automationRuns)
      .set({
        status: "completed",
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(automationRuns.id, execution.runId));

    await tx.insert(activityLog).values({
      orgId: issue.orgId,
      actorType: "system",
      actorId: "automation_chat_output",
      agentId: run.agentId,
      runId: run.id,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: {
        status: "done",
        identifier: issue.identifier,
        automationId: execution.automationId,
        automationTitle: execution.automationTitle,
        automationRunId: execution.runId,
        closeoutReason: "chat_output_run_succeeded",
        _previous: { status: issue.status },
      },
    });

    return {
      issueId: issue.id,
      automationId: execution.automationId,
      automationRunId: execution.runId,
      previousStatus: issue.status,
    };
  }

  async function releaseIssueExecutionAndPromote(
    run: typeof heartbeatRuns.$inferSelect,
    opts?: { startNext?: boolean },
  ) {
    const writeDurableReleaseAudit = async (
      tx: any,
      action: "issue.execution_released" | "issue.execution_promoted",
      issue: { id: string; orgId: string },
      details: Record<string, unknown>,
    ) => {
      const idempotencyKey = `${action}:${run.id}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${run.id}))`);
      const [currentSeq] = await tx
        .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, run.id));
      await tx
        .insert(heartbeatRunEvents)
        .values({
          orgId: run.orgId,
          runId: run.id,
          agentId: run.agentId,
          seq: Number(currentSeq?.maxSeq ?? 0) + 1,
          eventType: action,
          stream: "system",
          level: "info",
          message: action === "issue.execution_promoted"
            ? "Issue execution promoted after terminal run"
            : "Issue execution released after terminal run",
          payload: details,
          idempotencyKey,
        })
        .onConflictDoNothing();
      await tx
        .insert(activityLog)
        .values({
          orgId: issue.orgId,
          actorType: "system",
          actorId: "terminal_effects",
          action,
          entityType: "issue",
          entityId: issue.id,
          agentId: run.agentId,
          runId: run.id,
          details,
          idempotencyKey: `${run.id}:${idempotencyKey}`,
        })
        .onConflictDoNothing();
    };
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where org_id = ${run.orgId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({
          id: issues.id,
          orgId: issues.orgId,
          identifier: issues.identifier,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
          projectId: issues.projectId,
          originKind: issues.originKind,
          originId: issues.originId,
          originRunId: issues.originRunId,
          assigneeAgentId: issues.assigneeAgentId,
          reviewerAgentId: issues.reviewerAgentId,
          reviewerUserId: issues.reviewerUserId,
        })
        .from(issues)
        .where(and(eq(issues.orgId, run.orgId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);

      if (!issue) return { promotedRun: null, passiveClosure: null };

      const now = new Date();
      const chatOutputCompletion = await completeChatOutputAutomationIssueIfEligible({ tx, run, issue, now });
      const passiveClosure = chatOutputCompletion
        ? { kind: "none", reason: "chat_output_run_succeeded" }
        : await evaluatePassiveIssueClosureForLockedIssue({
            tx,
            run,
            issue,
            now,
          });

      if (passiveClosure.kind === "queued") {
        const passiveFollowupDetails = {
          issueId: passiveClosure.issue.id,
          issueTitle: passiveClosure.issue.title,
          followupRunId: passiveClosure.run.id,
          originRunId: passiveClosure.originRunId,
          previousRunId: passiveClosure.previousRunId,
          attempt: passiveClosure.attempt,
          maxAttempts: ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS,
          reason: ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON,
          requestedAt: passiveClosure.requestedAt.toISOString(),
        };
        await writeTerminalIssueSemanticAudit(tx, {
          sourceRun: run,
          issue: passiveClosure.issue,
          eventType: "issue.passive_followup_queued",
          action: "issue.passive_followup_queued",
          actorId: "issue_closure_governance",
          level: "warn",
          message: `Queued passive issue follow-up ${passiveClosure.run.id}`,
          details: passiveFollowupDetails,
          mirrorRun: {
            run: passiveClosure.run,
            message: `Passive follow-up queued because run ${run.id} ended without issue close-out`,
            details: {
              issueId: passiveClosure.issue.id,
              originRunId: passiveClosure.originRunId,
              previousRunId: passiveClosure.previousRunId,
              attempt: passiveClosure.attempt,
              maxAttempts: ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS,
              reason: ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON,
              requestedAt: passiveClosure.requestedAt.toISOString(),
            },
          },
        });
        await writeDurableReleaseAudit(tx, "issue.execution_promoted", issue, {
          issueId: issue.id,
          sourceRunId: run.id,
          promotedRunId: passiveClosure.run.id,
          reason: "passive_followup",
        });
        return { promotedRun: passiveClosure.run, passiveClosure, chatOutputCompletion };
      }
      if (
        passiveClosure.kind === "operator_review"
        || passiveClosure.kind === "reviewer_closeout_operator_review"
        || (passiveClosure.kind === "reviewer_convergence" && !passiveClosure.issue.reviewerAgentId)
      ) {
        // Retain source ownership until the durable attention event/activity is
        // written. A crash can then replay the outcome from this terminal run.
        return {
          promotedRun: null,
          passiveClosure,
          chatOutputCompletion,
          releaseSourceAfterEffects: true,
        };
      }
      if (
        (passiveClosure.kind === "reviewer_convergence" || passiveClosure.kind === "reviewer_closeout")
        && passiveClosure.issue.reviewerAgentId
      ) {
        // Keep the source run as issue owner until the durable reviewer wake is
        // inserted. A failed enqueue can then be replayed from terminal effects
        // without losing the follow-up intent.
        return { promotedRun: null, passiveClosure, chatOutputCompletion };
      }

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        })
        .where(eq(issues.id, issue.id));

      while (true) {
        const deferred = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.orgId, issue.orgId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!deferred) {
          await writeDurableReleaseAudit(tx, "issue.execution_released", issue, {
            issueId: issue.id,
            sourceRunId: run.id,
          });
          return { promotedRun: null, passiveClosure, chatOutputCompletion };
        }

        const deferredAgent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, deferred.agentId))
          .then((rows) => rows[0] ?? null);

        if (
          !deferredAgent ||
          deferredAgent.orgId !== issue.orgId ||
          deferredAgent.status === "paused" ||
          deferredAgent.status === "terminated" ||
          deferredAgent.status === "pending_approval"
        ) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: "Deferred wake could not be promoted: agent is not invokable",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, deferred.id));
          continue;
        }

        const deferredPayload = parseObject(deferred.payload);
        const deferredContextSeed = parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
        const promotedContextSeed: Record<string, unknown> = { ...deferredContextSeed };
        const promotedReason = readNonEmptyString(deferred.reason) ?? "issue_execution_promoted";
        const promotedSource =
          (readNonEmptyString(deferred.source) as WakeupOptions["source"]) ?? "automation";
        const promotedTriggerDetail =
          (readNonEmptyString(deferred.triggerDetail) as WakeupOptions["triggerDetail"]) ?? null;
        const promotedPayload = deferredPayload;
        delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

        const {
          contextSnapshot: promotedContextSnapshot,
          taskKey: promotedTaskKey,
        } = enrichWakeContextSnapshot({
          contextSnapshot: promotedContextSeed,
          reason: promotedReason,
          source: promotedSource,
          triggerDetail: promotedTriggerDetail,
          payload: promotedPayload,
        });

        const sessionBefore =
          readNonEmptyString(promotedContextSnapshot.resumeSessionDisplayId) ??
          await resolveSessionBeforeForWakeup(deferredAgent, promotedTaskKey);
        const now = new Date();
        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            orgId: deferredAgent.orgId,
            agentId: deferredAgent.id,
            invocationSource: promotedSource,
            triggerDetail: promotedTriggerDetail,
            status: "queued",
            wakeupRequestId: deferred.id,
            contextSnapshot: promotedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            reason: "issue_execution_promoted",
            runId: newRun.id,
            claimedAt: null,
            finishedAt: null,
            error: null,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, deferred.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: normalizeAgentNameKey(deferredAgent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));

        await writeDurableReleaseAudit(tx, "issue.execution_promoted", issue, {
          issueId: issue.id,
          sourceRunId: run.id,
          promotedRunId: newRun.id,
          wakeupRequestId: deferred.id,
        });
        return { promotedRun: newRun, passiveClosure };
      }
    });
    if (outcome.promotedRun) {
      await context.afterIssuePromotionCommitted?.(outcome);
    }

    const passiveClosure = outcome.passiveClosure;
    const assertDurableReviewerWake = async (input: {
      agentId: string;
      idempotencyKey: string;
      run: unknown;
    }) => {
      if (input.run) return;
      const durableWake = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.agentId, input.agentId),
          eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
          inArray(agentWakeupRequests.status, [
            "queued",
            "claimed",
            "deferred_agent_paused",
            "deferred_issue_execution",
          ]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!durableWake) {
        throw new Error("Reviewer follow-up could not be persisted as actionable work");
      }
    };
    if (passiveClosure?.kind === "queued") {
      await appendRunEvent(run, {
        eventType: "issue.passive_followup_queued",
        idempotencyKey: `terminal-issue-effect:${run.id}:issue.passive_followup_queued`,
        stream: "system",
        level: "warn",
        message: `Queued passive issue follow-up ${passiveClosure.run.id}`,
        payload: {
          issueId: passiveClosure.issue.id,
          followupRunId: passiveClosure.run.id,
          originRunId: passiveClosure.originRunId,
          previousRunId: passiveClosure.previousRunId,
          attempt: passiveClosure.attempt,
          maxAttempts: ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS,
          reason: ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON,
          requestedAt: passiveClosure.requestedAt.toISOString(),
        },
      });
      await appendRunEvent(passiveClosure.run, {
        eventType: "issue.passive_followup_queued",
        idempotencyKey: `terminal-issue-effect:${run.id}:issue.passive_followup_queued`,
        stream: "system",
        level: "warn",
        message: `Passive follow-up queued because run ${run.id} ended without issue close-out`,
        payload: {
          issueId: passiveClosure.issue.id,
          originRunId: passiveClosure.originRunId,
          previousRunId: passiveClosure.previousRunId,
          attempt: passiveClosure.attempt,
          maxAttempts: ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS,
          reason: ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON,
          requestedAt: passiveClosure.requestedAt.toISOString(),
        },
      });
      await logActivity(db, {
        orgId: passiveClosure.issue.orgId,
        actorType: "system",
        actorId: "issue_closure_governance",
        action: "issue.passive_followup_queued",
        entityType: "issue",
        entityId: passiveClosure.issue.id,
        agentId: run.agentId,
        runId: run.id,
        idempotencyKey: `${run.id}:issue.passive_followup_queued`,
        details: {
          issueId: passiveClosure.issue.id,
          issueTitle: passiveClosure.issue.title,
          followupRunId: passiveClosure.run.id,
          originRunId: passiveClosure.originRunId,
          previousRunId: passiveClosure.previousRunId,
          attempt: passiveClosure.attempt,
          maxAttempts: ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS,
          reason: ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON,
          requestedAt: passiveClosure.requestedAt.toISOString(),
        },
      });
    } else if (passiveClosure?.kind === "operator_review") {
      await appendRunEvent(run, {
        eventType: "issue.closure_needs_operator_review",
        idempotencyKey: `terminal-issue-effect:${run.id}:issue.closure_needs_operator_review`,
        stream: "system",
        level: "warn",
        message: "Passive issue follow-up stopped and needs operator review",
        payload: {
          issueId: passiveClosure.issue.id,
          originRunId: passiveClosure.originRunId,
          previousRunId: passiveClosure.previousRunId,
          attempts: passiveClosure.attempts,
          maxAttempts: ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS,
          reason: passiveClosure.reason,
        },
      });
      await logActivity(db, {
        orgId: passiveClosure.issue.orgId,
        actorType: "system",
        actorId: "issue_closure_governance",
        action: "issue.closure_needs_operator_review",
        entityType: "issue",
        entityId: passiveClosure.issue.id,
        agentId: run.agentId,
        runId: run.id,
        idempotencyKey: `${run.id}:issue.closure_needs_operator_review`,
        details: {
          issueId: passiveClosure.issue.id,
          issueTitle: passiveClosure.issue.title,
          originRunId: passiveClosure.originRunId,
          previousRunId: passiveClosure.previousRunId,
          attempts: passiveClosure.attempts,
          maxAttempts: ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS,
          reason: passiveClosure.reason,
        },
      });
    } else if (passiveClosure?.kind === "reviewer_convergence") {
      if (passiveClosure.issue.reviewerAgentId) {
        const idempotencyKey = `issue_convergence_review_requested:${passiveClosure.originRunId}`;
        const reviewerRun = await enqueueWakeup(passiveClosure.issue.reviewerAgentId, {
          ...buildIssueConvergenceReviewWakeupOptions({
            issue: passiveClosure.issue,
            contextSource: "issue.passive_followup_exhausted",
            originRunId: passiveClosure.originRunId,
            previousRunId: passiveClosure.previousRunId,
            attempts: passiveClosure.attempts,
            maxAttempts: ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS,
            requestedByActorType: "system",
            requestedByActorId: "issue_closure_governance",
          }),
          idempotencyKey,
          originTerminalRunId: run.id,
          terminalIssueAudit: {
            sourceRun: run,
            issue: passiveClosure.issue,
            eventType: "issue.convergence_review_requested",
            action: "issue.convergence_review_requested",
            actorId: "issue_closure_governance",
            level: "warn",
            message: "Passive issue follow-up stopped and needs reviewer convergence",
            details: {
              issueId: passiveClosure.issue.id,
              issueTitle: passiveClosure.issue.title,
              reviewerAgentId: passiveClosure.issue.reviewerAgentId,
              reviewerUserId: passiveClosure.issue.reviewerUserId,
              originRunId: passiveClosure.originRunId,
              previousRunId: passiveClosure.previousRunId,
              attempts: passiveClosure.attempts,
              maxAttempts: ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS,
              reason: passiveClosure.reason,
            },
          },
          startImmediately: false,
        });
        await assertDurableReviewerWake({
          agentId: passiveClosure.issue.reviewerAgentId,
          idempotencyKey,
          run: reviewerRun,
        });
      }
      await appendRunEvent(run, {
        eventType: "issue.convergence_review_requested",
        idempotencyKey: `terminal-issue-effect:${run.id}:issue.convergence_review_requested`,
        stream: "system",
        level: "warn",
        message: "Passive issue follow-up stopped and needs reviewer convergence",
        payload: {
          issueId: passiveClosure.issue.id,
          reviewerAgentId: passiveClosure.issue.reviewerAgentId,
          reviewerUserId: passiveClosure.issue.reviewerUserId,
          originRunId: passiveClosure.originRunId,
          previousRunId: passiveClosure.previousRunId,
          attempts: passiveClosure.attempts,
          maxAttempts: ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS,
          reason: passiveClosure.reason,
        },
      });
      await logActivity(db, {
        orgId: passiveClosure.issue.orgId,
        actorType: "system",
        actorId: "issue_closure_governance",
        action: "issue.convergence_review_requested",
        entityType: "issue",
        entityId: passiveClosure.issue.id,
        agentId: run.agentId,
        runId: run.id,
        idempotencyKey: `${run.id}:issue.convergence_review_requested`,
        details: {
          issueId: passiveClosure.issue.id,
          issueTitle: passiveClosure.issue.title,
          reviewerAgentId: passiveClosure.issue.reviewerAgentId,
          reviewerUserId: passiveClosure.issue.reviewerUserId,
          originRunId: passiveClosure.originRunId,
          previousRunId: passiveClosure.previousRunId,
          attempts: passiveClosure.attempts,
          maxAttempts: ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS,
          reason: passiveClosure.reason,
        },
      });
    } else if (passiveClosure?.kind === "reviewer_closeout") {
      if (passiveClosure.issue.reviewerAgentId) {
        const idempotencyKey = `${ISSUE_REVIEW_CLOSEOUT_REASON}:${run.id}`;
        const reviewerRun = await enqueueWakeup(passiveClosure.issue.reviewerAgentId, {
          ...buildIssueReviewCloseoutWakeupOptions({
            issue: passiveClosure.issue,
            contextSource: "issue.review_closeout_missing",
            originRunId: passiveClosure.originRunId,
            previousRunId: passiveClosure.previousRunId,
            attempts: passiveClosure.attempts,
            maxAttempts: passiveClosure.maxAttempts,
            requestedByActorType: "system",
            requestedByActorId: "issue_review_followup",
          }),
          idempotencyKey,
          originTerminalRunId: run.id,
          terminalIssueAudit: {
            sourceRun: run,
            issue: passiveClosure.issue,
            eventType: "issue.review_closeout_missing",
            action: "issue.review_closeout_missing",
            actorId: "issue_review_followup",
            level: "warn",
            message: "Reviewer run finished without a structured review decision",
            details: {
              issueId: passiveClosure.issue.id,
              issueTitle: passiveClosure.issue.title,
              reviewerAgentId: passiveClosure.issue.reviewerAgentId,
              originRunId: passiveClosure.originRunId,
              previousRunId: passiveClosure.previousRunId,
              attempts: passiveClosure.attempts,
              maxAttempts: passiveClosure.maxAttempts,
              reason: passiveClosure.reason,
            },
          },
          startImmediately: false,
        });
        await assertDurableReviewerWake({
          agentId: passiveClosure.issue.reviewerAgentId,
          idempotencyKey,
          run: reviewerRun,
        });
      }
      await appendRunEvent(run, {
        eventType: "issue.review_closeout_missing",
        idempotencyKey: `terminal-issue-effect:${run.id}:issue.review_closeout_missing`,
        stream: "system",
        level: "warn",
        message: "Reviewer run finished without a structured review decision",
        payload: {
          issueId: passiveClosure.issue.id,
          originRunId: passiveClosure.originRunId,
          previousRunId: passiveClosure.previousRunId,
          attempts: passiveClosure.attempts,
          maxAttempts: passiveClosure.maxAttempts,
          reason: passiveClosure.reason,
        },
      });
      await logActivity(db, {
        orgId: passiveClosure.issue.orgId,
        actorType: "system",
        actorId: "issue_review_followup",
        action: "issue.review_closeout_missing",
        entityType: "issue",
        entityId: passiveClosure.issue.id,
        agentId: run.agentId,
        runId: run.id,
        idempotencyKey: `${run.id}:issue.review_closeout_missing`,
        details: {
          issueId: passiveClosure.issue.id,
          issueTitle: passiveClosure.issue.title,
          reviewerAgentId: passiveClosure.issue.reviewerAgentId,
          originRunId: passiveClosure.originRunId,
          previousRunId: passiveClosure.previousRunId,
          attempts: passiveClosure.attempts,
          maxAttempts: passiveClosure.maxAttempts,
          reason: passiveClosure.reason,
        },
      });
    } else if (passiveClosure?.kind === "reviewer_closeout_operator_review") {
      await appendRunEvent(run, {
        eventType: "issue.review_closure_needs_operator_review",
        idempotencyKey: `terminal-issue-effect:${run.id}:issue.review_closure_needs_operator_review`,
        stream: "system",
        level: "warn",
        message: "Reviewer close-out attempts stopped and need operator review",
        payload: {
          issueId: passiveClosure.issue.id,
          originRunId: passiveClosure.originRunId,
          previousRunId: passiveClosure.previousRunId,
          attempts: passiveClosure.attempts,
          maxAttempts: passiveClosure.maxAttempts,
          reason: passiveClosure.reason,
        },
      });
      await logActivity(db, {
        orgId: passiveClosure.issue.orgId,
        actorType: "system",
        actorId: "issue_review_followup",
        action: "issue.review_closure_needs_operator_review",
        entityType: "issue",
        entityId: passiveClosure.issue.id,
        agentId: run.agentId,
        runId: run.id,
        idempotencyKey: `${run.id}:issue.review_closure_needs_operator_review`,
        details: {
          issueId: passiveClosure.issue.id,
          issueTitle: passiveClosure.issue.title,
          reviewerAgentId: passiveClosure.issue.reviewerAgentId,
          originRunId: passiveClosure.originRunId,
          previousRunId: passiveClosure.previousRunId,
          attempts: passiveClosure.attempts,
          maxAttempts: passiveClosure.maxAttempts,
          reason: passiveClosure.reason,
        },
      });
    }

    if (outcome.releaseSourceAfterEffects && passiveClosure?.issue) {
      await db.transaction(async (tx) => {
        const released = await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(issues.id, passiveClosure.issue.id),
            eq(issues.executionRunId, run.id),
          ))
          .returning({ id: issues.id })
          .then((rows: Array<{ id: string }>) => rows[0] ?? null);
        if (released) {
          await writeDurableReleaseAudit(tx, "issue.execution_released", passiveClosure.issue, {
            issueId: passiveClosure.issue.id,
            sourceRunId: run.id,
            reason: passiveClosure.kind,
          });
        }
      });
    }

    const promotedRun = outcome.promotedRun;
    if (!promotedRun) return;

    publishLiveEvent({
      orgId: promotedRun.orgId,
      type: "heartbeat.run.queued",
      payload: {
        runId: promotedRun.id,
        agentId: promotedRun.agentId,
        invocationSource: promotedRun.invocationSource,
        triggerDetail: promotedRun.triggerDetail,
        wakeupRequestId: promotedRun.wakeupRequestId,
      },
    });

    if (opts?.startNext !== false) await startNextQueuedRunForAgent(promotedRun.agentId);
  }

  return { releaseIssueExecutionAndPromote };
}
