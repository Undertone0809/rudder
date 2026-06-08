// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import type {
  AgentSkillAnalytics,
  AgentSkillTelemetryEvidence,
  AgentSkillTelemetryEvidenceCounts,
  BillingType,
  ExecutionObservabilityContext,
  ExecutionObservabilitySurface,
  HeartbeatRecoveryTrigger,
  HeartbeatRunRecoveryContext,
} from "@rudderhq/shared";
import {
  AGENT_RUN_CONCURRENCY_DEFAULT,
  AGENT_RUN_CONCURRENCY_MAX,
  AGENT_RUN_CONCURRENCY_MIN,
  summarizeTokenUsage,
} from "@rudderhq/shared";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  authUsers,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  organizations,
  projects,
} from "@rudderhq/db";
import { conflict, notFound } from "../../errors.js";
import {
  createExecutionScores,
  observeExecutionEvent,
  updateExecutionObservation,
  updateExecutionTraceIO,
  updateExecutionTraceName,
  updateExecutionTraceSession,
  withExecutionObservation,
} from "../../langfuse.js";
import { emitExecutionTranscriptTree } from "../../langfuse-transcript.js";
import { logger } from "../../middleware/logger.js";
import { publishLiveEvent } from "../live-events.js";
import { getRunLogStore, type RunLogHandle } from "../run-log-store.js";
import { findServerAdapter, getServerAdapter, runningProcesses } from "../../agent-runtimes/index.js";
import type {
  AgentRuntimeExecutionResult,
  AgentRuntimeInvocationMeta,
  AgentRuntimeSessionCodec,
  UsageSummary,
} from "../../agent-runtimes/index.js";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import { parseObject, asBoolean, asNumber, appendWithCap, MAX_EXCERPT_BYTES } from "../../agent-runtimes/utils.js";
import { costService } from "../costs.js";
import { budgetService, type BudgetEnforcementScope } from "../budgets.js";
import {
  agentRunContextService,
  type ResolvedWorkspaceForRun,
} from "../agent-run-context.js";
import {
  resolveDefaultAgentWorkspaceDir,
} from "../../home-paths.js";
import { summarizeHeartbeatRunResultJson } from "../heartbeat-run-summary.js";
import { summarizeRuntimeSkillsForTrace } from "../runtime-trace-metadata.js";
import {
  buildWorkspaceReadyComment,
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  sanitizeRuntimeServiceBaseEnv,
} from "../workspace-runtime.js";
import { issueService } from "../issues.js";
import { documentService } from "../documents.js";
import {
  buildIssueConvergenceReviewWakeupOptions,
  buildIssueReviewCloseoutWakeupOptions,
} from "../issue-review-wakeup.js";
import { executionWorkspaceService } from "../execution-workspaces.js";
import { buildObservedRunLangfuseScores } from "../run-intelligence.js";
import { workspaceOperationService } from "../workspace-operations.js";
import {
  isManagedWorkspaceConfigurationError,
  isWorkspacePermissionPreflightError,
  preflightManagedAgentWorkspace,
} from "../managed-workspace-preflight.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "../execution-workspace-policy.js";
import { instanceSettingsService } from "../instance-settings.js";
import { logActivity } from "../activity-log.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../../log-redaction.js";
import {
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "@rudderhq/agent-runtime-utils";
import { buildIssueDocumentsPrompt } from "@rudderhq/agent-runtime-utils/server-utils";
import {
  buildCreateAgentBenchmarkTags,
  coerceCreateAgentBenchmarkMetadata,
  extractCreateAgentBenchmarkMetadata,
} from "@rudderhq/run-intelligence-core";
import { executeAdapterWithModelFallbacks } from "./model-fallback.js";
import { issueMaterialUpdateActivitySql } from "../issue-activity-filters.js";

export { prioritizeProjectWorkspaceCandidatesForRun, type ResolvedWorkspaceForRun } from "../agent-run-context.js";

import * as heartbeatCore from "./heartbeat.core.js";
import * as heartbeatSessions from "./heartbeat.sessions.js";
const { MAX_LIVE_LOG_CHUNK_BYTES, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, DEFERRED_WAKE_CONTEXT_KEY, DETACHED_PROCESS_ERROR_CODE, ORPHANED_PROCESS_TERMINATION_GRACE_MS, ORPHANED_PROCESS_KILL_WAIT_MS, ORPHANED_PROCESS_POLL_INTERVAL_MS, startLocksByAgent, MAX_RECOVERY_CHAIN_DEPTH, ISSUE_PASSIVE_FOLLOWUP_REASON, ISSUE_PASSIVE_FOLLOWUP_WAKE_SOURCE, ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON, ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS, ISSUE_REVIEW_CLOSEOUT_REASON, ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON, ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS, ISSUE_PASSIVE_FOLLOWUP_COOLDOWN_MS_BY_ATTEMPT, ISSUE_PASSIVE_FOLLOWUP_TIMER_CONTINUITY_MAX_WINDOW_MS, SESSIONED_LOCAL_ADAPTERS, heartbeatRunListColumns, appendExcerpt, appendTranscriptEntriesFromChunk, normalizeMaxConcurrentRuns, withAgentStartLock, readNonEmptyString, resolveHeartbeatObservabilitySurface, buildHeartbeatObservationName, compactTraceText, buildIssueRunTraceName, buildHeartbeatRuntimeTraceMetadata, buildHeartbeatAdapterInvokePayload, buildRecentDateKeys, buildDateKeysBetween, fallbackSkillLabel, normalizeLoadedSkill, normalizeLoadedSkillForPayload, emptySkillEvidenceCounts, incrementSkillEvidenceCount, strongestSkillEvidence, resolveSkillEvidence, readSkillEvidenceFromPayload, extractSkillSlugFromPath, collectSkillPathsFromText, collectStringValues, normalizeSkillUseFromPath, dedupeSkillUses, collectSkillUsesFromText, readToolCommandInput, isCommandTranscriptTool, isReadTranscriptTool, inferUsedSkillsFromTranscript, normalizeSkillCandidate, addSkillCandidate, readSkillReferenceSlug, collectSkillReferences, inferUsedSkillsFromPrompt, normalizeLedgerBillingType, resolveLedgerBiller, normalizeBilledCostCents, resolveLedgerScopeForRun } = heartbeatCore;
const { buildExplicitResumeSessionOverride, normalizeUsageTotals, readRawUsageTotals, deriveNormalizedUsageDelta, formatCount, parseSessionCompactionPolicy, resolveRuntimeSessionParamsForWorkspace, parseIssueAssigneeAgentRuntimeOverrides, deriveTaskKey, shouldResetTaskSessionForWake, formatRuntimeWorkspaceWarningLog, describeSessionResetReason, deriveCommentId, enrichWakeContextSnapshot, mergeCoalescedContextSnapshot, issueCommentAuthorKind, issueCommentAuthorLabel, buildDeferredWakePayload, readDeferredWakeContext, readDeferredWakePayload, deriveDeferredWakeTaskKey, hydrateWakeContextSnapshot, firstNonEmptyLine, deriveRecoveryFailureKind, deriveRecoveryFailureSummary, mergeMissingRecoveryContextFields, hydrateRecoveryBaseContextSnapshot, buildRecoveryContextSnapshot, normalizePassiveFollowupContext, normalizeReviewCloseoutContext, passiveFollowupCooldownMs, issueHasReviewer, isAgentEligibleForTimerContinuation, hasCredibleTimerContinuation, buildPassiveFollowupContextSnapshot, runTaskKey, isSameTaskScope, isTrackedLocalChildProcessAdapter, isProcessAlive, waitForProcessExit, terminateOrphanedProcess, truncateDisplayId, normalizeAgentNameKey, defaultSessionCodec, getAgentRuntimeSessionCodec, normalizeSessionParams, resolveNextSessionState } = heartbeatSessions;

export function createHeartbeatRecoveryHandlers(context: any) {
  const { db, instanceSettings, getCurrentUserRedactionOptions, runLogStore, runContextSvc, issuesSvc, documentsSvc, executionWorkspacesSvc, workspaceOperationsSvc, activeRunExecutions, budgetHooks, budgets, getAgent, getRun, getRuntimeState, getTaskSession, getLatestRunForSession, getOldestRunForSession, resolveNormalizedUsageForSession, evaluateSessionCompaction, resolveSessionBeforeForWakeup, resolveExplicitResumeSessionOverride, upsertTaskSession, clearTaskSessions, ensureRuntimeState, buildHeartbeatObservabilityContext, emitHeartbeatObservationEvent, emitHeartbeatLiveEval, setRunStatus, setWakeupStatus, updateWakeupRequestRecord, insertWakeupRequestRecord, appendRunEvent, nextRunEventSeq, persistRunProcessMetadata, clearDetachedRunWarning, countRunningRunsForAgent, claimQueuedRun, finalizeAgentStatus, reapOrphanedRuns, resumeQueuedRuns, updateRuntimeState, startNextQueuedRunForAgent, executeRun, releaseIssueExecutionAndPromote, enqueueWakeup, resumeDeferredWakeupsForAgent, listProjectScopedRunIds, listProjectScopedWakeupIds, cancelPendingWakeupsForBudgetScope, cancelRunInternal, cancelActiveForAgentInternal, cancelBudgetScopeWork, retryRunInternal, buildSkillAnalytics } = context;

  async function enqueueRecoveryRun(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    opts: {
      recoveryTrigger: HeartbeatRecoveryTrigger;
      source: NonNullable<WakeupOptions["source"]>;
      triggerDetail: NonNullable<WakeupOptions["triggerDetail"]>;
      wakeReason: string;
      requestedByActorType: WakeupOptions["requestedByActorType"];
      requestedByActorId: string | null;
      startImmediately?: boolean;
      now: Date;
    },
  ) {
    /**
     * Recovery runs intentionally clone the prior run's task context and then
     * layer explicit recovery metadata on top. This keeps retries visible and
     * auditable while preserving "continue preferred" semantics for issue work.
     *
     * Reasoning:
     * - Manual retry and automatic process-loss retry must assemble the same
     *   recovery contract so prompts/runtime behavior stay aligned.
     * - We backfill missing context from the retry chain to recover from older
     *   lossy retry runs without mutating the historical source run rows.
     *
     * Traceability:
     * - doc/developing/RUN-RECOVERY.md
     * - doc/DEVELOPING.md
     */
    const baseContextSnapshot = await hydrateRecoveryBaseContextSnapshot(run, getRun);
    const recoveryContextSnapshot = buildRecoveryContextSnapshot({
      baseContextSnapshot,
      run,
      recoveryTrigger: opts.recoveryTrigger,
      wakeReason: opts.wakeReason,
      wakeSource: `recovery.${opts.recoveryTrigger}`,
      triggerDetail: opts.triggerDetail,
    });
    const issueId = readNonEmptyString(recoveryContextSnapshot.issueId);
    const taskKey = deriveTaskKey(recoveryContextSnapshot, null);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    const recovery = recoveryContextSnapshot.recovery as HeartbeatRunRecoveryContext;
    const requestPayload: Record<string, unknown> = {
      originalRunId: run.id,
      failureKind: recovery.failureKind,
      recoveryTrigger: recovery.recoveryTrigger,
      ...(issueId ? { issueId } : {}),
    };

    const outcome = await db.transaction(async (tx) => {
      let issueRow:
        | {
          id: string;
          orgId: string;
          executionRunId: string | null;
          executionAgentNameKey: string | null;
        }
        | null = null;

      if (issueId) {
        await tx.execute(
          sql`select id from issues where id = ${issueId} and org_id = ${run.orgId} for update`,
        );
        issueRow = await tx
          .select({
            id: issues.id,
            orgId: issues.orgId,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.orgId, run.orgId)))
          .then((rows) => rows[0] ?? null);
      }

      if (issueRow?.executionRunId) {
        const activeExecutionRun = await tx
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, issueRow.executionRunId))
          .then((rows) => rows[0] ?? null);
        const isActiveExecutionRun =
          activeExecutionRun &&
          (activeExecutionRun.status === "queued" || activeExecutionRun.status === "running");

        if (!isActiveExecutionRun) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: opts.now,
            })
            .where(eq(issues.id, issueRow.id));
          issueRow = {
            ...issueRow,
            executionRunId: null,
            executionAgentNameKey: null,
          };
        } else if (activeExecutionRun) {
          const activeContext = parseObject(activeExecutionRun.contextSnapshot);
          const activeRecovery = parseObject(activeContext.recovery);
          if (
            activeExecutionRun.agentId === run.agentId &&
            (
              activeExecutionRun.retryOfRunId === run.id ||
              readNonEmptyString(activeRecovery.originalRunId) === run.id
            )
          ) {
            return { kind: "existing" as const, run: activeExecutionRun };
          }
          throw conflict("Issue already has an active execution run", {
            issueId: issueRow.id,
            executionRunId: activeExecutionRun.id,
          });
        }
      }

      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          orgId: run.orgId,
          agentId: run.agentId,
          source: opts.source,
          triggerDetail: opts.triggerDetail,
          reason: opts.wakeReason,
          payload: requestPayload,
          status: "queued",
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          updatedAt: opts.now,
        })
        .returning()
        .then((rows) => rows[0]);

      const recoveryRun = await tx
        .insert(heartbeatRuns)
        .values({
          orgId: run.orgId,
          agentId: run.agentId,
          invocationSource: opts.source,
          triggerDetail: opts.triggerDetail,
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: recoveryContextSnapshot,
          sessionIdBefore: sessionBefore,
          retryOfRunId: run.id,
          processLossRetryCount:
            opts.recoveryTrigger === "automatic"
              ? (run.processLossRetryCount ?? 0) + 1
              : (run.processLossRetryCount ?? 0),
          updatedAt: opts.now,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: recoveryRun.id,
          updatedAt: opts.now,
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      if (issueRow) {
        await tx
          .update(issues)
          .set({
            executionRunId: recoveryRun.id,
            executionAgentNameKey: normalizeAgentNameKey(agent.name),
            executionLockedAt: opts.now,
            updatedAt: opts.now,
          })
          .where(eq(issues.id, issueRow.id));
      }

      return { kind: "queued" as const, run: recoveryRun };
    });

    if (outcome.kind === "existing") return outcome.run;

    const recoveryRun = outcome.run;
    await appendRunEvent(recoveryRun, await nextRunEventSeq(recoveryRun.id), {
      eventType: "lifecycle",
      stream: "system",
      level: opts.recoveryTrigger === "automatic" ? "warn" : "info",
      message: `Recovery queued from run ${run.id}`,
      payload: {
        originalRunId: run.id,
        failureKind: recovery.failureKind,
        failureSummary: recovery.failureSummary,
        recoveryTrigger: recovery.recoveryTrigger,
        recoveryMode: recovery.recoveryMode,
      },
    });

    publishLiveEvent({
      orgId: recoveryRun.orgId,
      type: "heartbeat.run.queued",
      payload: {
        runId: recoveryRun.id,
        agentId: recoveryRun.agentId,
        invocationSource: recoveryRun.invocationSource,
        triggerDetail: recoveryRun.triggerDetail,
        wakeupRequestId: recoveryRun.wakeupRequestId,
      },
    });

    if (opts.startImmediately !== false) {
      await startNextQueuedRunForAgent(agent.id);
    }
    return recoveryRun;
  }

  async function enqueueProcessLossRetry(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    now: Date,
  ) {
    return enqueueRecoveryRun(run, agent, {
      recoveryTrigger: "automatic",
      source: "automation",
      triggerDetail: "system",
      wakeReason: "process_lost_retry",
      requestedByActorType: "system",
      requestedByActorId: null,
      startImmediately: false,
      now,
    });
  }

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, true),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      preflightEnabled: asBoolean(heartbeat.preflightEnabled ?? heartbeat.timerPreflightEnabled, true),
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    };
  }

  async function markAgentHeartbeatChecked(agent: typeof agents.$inferSelect, outcome: "skipped") {
    const now = new Date();
    const updated = await db
      .update(agents)
      .set({
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(agents.id, agent.id))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        orgId: updated.orgId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt
            ? new Date(updated.lastHeartbeatAt).toISOString()
            : null,
          outcome,
        },
      });
    }
  }

  async function evaluateTimerPreflight(agent: typeof agents.$inferSelect): Promise<TimerPreflightResult> {
    const pendingWakeup = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.orgId, agent.orgId),
          eq(agentWakeupRequests.agentId, agent.id),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          sql`${agentWakeupRequests.runId} is null`,
          lte(agentWakeupRequests.requestedAt, new Date()),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (pendingWakeup) {
      return { shouldRun: false, skipReason: "heartbeat.preflight.pending_wakeup_request" };
    }

    const assigneeIssues = await issuesSvc.list(agent.orgId, {
      assigneeAgentId: agent.id,
      status: "todo,in_progress,blocked",
    });
    if (assigneeIssues.length > 0) {
      return { shouldRun: true, reason: "assignee_issue" };
    }

    // Timer admission must match the compact inbox contract. Otherwise hidden
    // control-plane rows can wake an agent that immediately sees no work.
    // Traceability: doc/plans/2026-05-30-heartbeat-inbox-admission.md
    const reviewerIssues = await issuesSvc.list(agent.orgId, {
      reviewerAgentId: agent.id,
      status: "in_review,blocked",
      excludeReviewerConfirmedBlockedHandoff: true,
    });
    if (reviewerIssues.length > 0) {
      return { shouldRun: true, reason: "reviewer_issue" };
    }

    return { shouldRun: false, skipReason: "heartbeat.preflight.no_actionable_work" };
  }

  async function runHasIssueClosureComment(tx: any, run: typeof heartbeatRuns.$inferSelect, issueId: string) {
    const commentActivity = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.orgId, run.orgId),
          eq(activityLog.action, "issue.comment_added"),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          eq(activityLog.runId, run.id),
        ),
      )
      .limit(1)
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    return Boolean(commentActivity);
  }

  async function runHasIssueReviewDecision(tx: any, run: typeof heartbeatRuns.$inferSelect, issueId: string) {
    const decisionActivity = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.orgId, run.orgId),
          eq(activityLog.action, "issue.review_decision_recorded"),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          eq(activityLog.runId, run.id),
        ),
      )
      .limit(1)
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    return Boolean(decisionActivity);
  }

  async function issueHasDeferredWake(tx: any, orgId: string, issueId: string) {
    const deferred = await tx
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.orgId, orgId),
          eq(agentWakeupRequests.status, "deferred_issue_execution"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      )
      .limit(1)
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    return Boolean(deferred);
  }

  async function passiveFollowupAlreadyRecorded(tx: any, runId: string) {
    const idempotencyKey = `${ISSUE_PASSIVE_FOLLOWUP_REASON}:${runId}`;
    const existingWake = await tx
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey))
      .limit(1)
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (existingWake) return true;

    const existingReview = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.runId, runId),
          inArray(activityLog.action, [
            "issue.closure_needs_operator_review",
            "issue.convergence_review_requested",
          ]),
        ),
      )
      .limit(1)
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    return Boolean(existingReview);
  }

  async function reviewerCloseoutAlreadyRecorded(tx: any, runId: string) {
    const existingWake = await tx
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `${ISSUE_REVIEW_CLOSEOUT_REASON}:${runId}`))
      .limit(1)
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (existingWake) return true;

    const existingReview = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.runId, runId),
          eq(activityLog.action, "issue.review_closure_needs_operator_review"),
        ),
      )
      .limit(1)
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    return Boolean(existingReview);
  }

  async function issueHasConfirmedBlockedReviewerHandoff(tx: any, issue: PassiveFollowupIssueRow, reviewerAgentId: string) {
    if (issue.status !== "blocked") return false;
    const existingHandoff = await tx
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.orgId, issue.orgId),
          eq(activityLog.action, "issue.review_decision_recorded"),
          eq(activityLog.entityType, "issue"),
          sql`${activityLog.entityId} = ${issue.id}::text`,
          eq(activityLog.actorType, "agent"),
          sql`${activityLog.actorId} = ${reviewerAgentId}::text`,
          sql`${activityLog.details} ->> 'decision' = 'blocked'`,
          sql`${activityLog.createdAt} >= COALESCE((
            SELECT MAX(material_activity.created_at)
            FROM activity_log material_activity
            WHERE material_activity.org_id = ${issue.orgId}
              AND material_activity.entity_type = 'issue'
              AND material_activity.entity_id = ${issue.id}::text
              AND (
                ${issueMaterialUpdateActivitySql("material_activity")}
                OR (
                  material_activity.action = 'issue.comment_added'
                  AND NOT (
                    material_activity.actor_type = 'agent'
                    AND material_activity.actor_id = ${reviewerAgentId}::text
                  )
                )
              )
          ), to_timestamp(0))`,
        ),
      )
      .limit(1)
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    return Boolean(existingHandoff);
  }

  async function evaluatePassiveIssueClosureForLockedIssue(input: {
    tx: any;
    run: typeof heartbeatRuns.$inferSelect;
    issue: PassiveFollowupIssueRow;
    now: Date;
  }): Promise<PassiveIssueClosureOutcome> {
    const { tx, run, issue, now } = input;
    const context = parseObject(run.contextSnapshot);
    const runIssueId = readNonEmptyString(context.issueId);
    if (!runIssueId || runIssueId !== issue.id) return { kind: "none", reason: "run_not_issue_backed" };
    if (run.status !== "succeeded") return { kind: "none", reason: "run_not_successful" };
    const reviewerRun =
      (issue.status === "in_review" || issue.status === "blocked") &&
      issue.reviewerAgentId === run.agentId &&
      (
        run.invocationSource === "review" ||
        readNonEmptyString(context.role) === "reviewer" ||
        readNonEmptyString(context.wakeSource) === "review"
      );
    if (reviewerRun) {
      if (await runHasIssueReviewDecision(tx, run, issue.id)) {
        return { kind: "none", reason: "review_decision_recorded" };
      }
      if (await issueHasConfirmedBlockedReviewerHandoff(tx, issue, run.agentId)) {
        return { kind: "none", reason: "blocked_reviewer_handoff_confirmed" };
      }
      if (await issueHasDeferredWake(tx, issue.orgId, issue.id)) {
        return { kind: "none", reason: "deferred_issue_wake_exists" };
      }
      if (await reviewerCloseoutAlreadyRecorded(tx, run.id)) {
        return { kind: "none", reason: "reviewer_closeout_already_recorded" };
      }

      const reviewCloseout = normalizeReviewCloseoutContext(context.reviewCloseout);
      const currentAttempt = reviewCloseout?.attempt ?? 0;
      const maxAttempts = reviewCloseout?.maxAttempts ?? ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS;
      const originRunId = reviewCloseout?.originRunId ?? run.id;
      if (currentAttempt >= maxAttempts) {
        return {
          kind: "reviewer_closeout_operator_review",
          issue,
          originRunId,
          previousRunId: run.id,
          attempts: currentAttempt,
          maxAttempts,
          reason: ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON,
        };
      }

      return {
        kind: "reviewer_closeout",
        issue,
        originRunId,
        previousRunId: run.id,
        attempts: currentAttempt + 1,
        maxAttempts,
        reason: ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON,
      };
    }
    if (issue.status !== "todo" && issue.status !== "in_progress") {
      return { kind: "none", reason: "issue_has_closure_status" };
    }
    if (issue.assigneeAgentId !== run.agentId) {
      return { kind: "none", reason: "issue_no_longer_assigned_to_run_agent" };
    }

    if (!issueHasReviewer(issue) && await runHasIssueClosureComment(tx, run, issue.id)) {
      return { kind: "none", reason: "run_authored_issue_comment" };
    }
    if (await issueHasDeferredWake(tx, issue.orgId, issue.id)) {
      return { kind: "none", reason: "deferred_issue_wake_exists" };
    }
    if (await passiveFollowupAlreadyRecorded(tx, run.id)) {
      return { kind: "none", reason: "passive_followup_already_recorded" };
    }

    const agent = await tx
      .select()
      .from(agents)
      .where(eq(agents.id, run.agentId))
      .then((rows: Array<typeof agents.$inferSelect>) => rows[0] ?? null);
    if (!agent || agent.orgId !== run.orgId) {
      return { kind: "none", reason: "agent_not_found" };
    }

    const policy = parseHeartbeatPolicy(agent);
    if (hasCredibleTimerContinuation({ agent, policy, run, now })) {
      return { kind: "none", reason: "timer_continuity_expected" };
    }

    const passiveContext = normalizePassiveFollowupContext(context.passiveFollowup);
    const currentAttempt = passiveContext?.attempt ?? 0;
    const originRunId = passiveContext?.originRunId ?? run.id;
    if (currentAttempt >= ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS) {
      if (issueHasReviewer(issue)) {
        return {
          kind: "reviewer_convergence",
          issue,
          originRunId,
          previousRunId: run.id,
          attempts: currentAttempt,
          reason: ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON,
        };
      }
      return {
        kind: "operator_review",
        issue,
        originRunId,
        previousRunId: run.id,
        attempts: currentAttempt,
        reason: ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON,
      };
    }

    const nextAttempt = currentAttempt + 1;
    const requestedAt = new Date(now.getTime() + passiveFollowupCooldownMs(nextAttempt));
    const contextSnapshot = buildPassiveFollowupContextSnapshot({
      run,
      issue,
      originRunId,
      attempt: nextAttempt,
      now,
    });
    const taskKey = deriveTaskKey(contextSnapshot, { issueId: issue.id });
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    const requestPayload = {
      issueId: issue.id,
      originRunId,
      previousRunId: run.id,
      attempt: nextAttempt,
      reason: ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON,
    };

    const wakeupRequest = await tx
      .insert(agentWakeupRequests)
      .values({
        orgId: run.orgId,
        agentId: run.agentId,
        source: "automation",
        triggerDetail: "system",
        reason: ISSUE_PASSIVE_FOLLOWUP_REASON,
        payload: requestPayload,
        status: "queued",
        requestedByActorType: "system",
        requestedByActorId: "issue_closure_governance",
        idempotencyKey: `${ISSUE_PASSIVE_FOLLOWUP_REASON}:${run.id}`,
        requestedAt,
        updatedAt: now,
      })
      .returning()
      .then((rows: Array<typeof agentWakeupRequests.$inferSelect>) => rows[0]);

    const followupRun = await tx
      .insert(heartbeatRuns)
      .values({
        orgId: run.orgId,
        agentId: run.agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot,
        sessionIdBefore: sessionBefore,
        updatedAt: now,
      })
      .returning()
      .then((rows: Array<typeof heartbeatRuns.$inferSelect>) => rows[0]);

    await tx
      .update(agentWakeupRequests)
      .set({
        runId: followupRun.id,
        updatedAt: now,
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    await tx
      .update(issues)
      .set({
        executionRunId: followupRun.id,
        executionAgentNameKey: normalizeAgentNameKey(agent.name),
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(eq(issues.id, issue.id));

    return {
      kind: "queued",
      run: followupRun,
      issue,
      originRunId,
      previousRunId: run.id,
      attempt: nextAttempt,
      requestedAt,
    };
  }

  return { enqueueRecoveryRun, enqueueProcessLossRetry, parseHeartbeatPolicy, markAgentHeartbeatChecked, evaluateTimerPreflight, runHasIssueClosureComment, runHasIssueReviewDecision, issueHasDeferredWake, passiveFollowupAlreadyRecorded, reviewerCloseoutAlreadyRecorded, issueHasConfirmedBlockedReviewerHandoff, evaluatePassiveIssueClosureForLockedIssue };
}
