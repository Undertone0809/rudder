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
  automationRuns,
  automations,
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

export { prioritizeProjectWorkspaceCandidatesForRun, type ResolvedWorkspaceForRun } from "../agent-run-context.js";

import * as heartbeatCore from "./heartbeat.core.js";
import * as heartbeatSessions from "./heartbeat.sessions.js";
const { MAX_LIVE_LOG_CHUNK_BYTES, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, DEFERRED_WAKE_CONTEXT_KEY, DETACHED_PROCESS_ERROR_CODE, ORPHANED_PROCESS_TERMINATION_GRACE_MS, ORPHANED_PROCESS_KILL_WAIT_MS, ORPHANED_PROCESS_POLL_INTERVAL_MS, startLocksByAgent, MAX_RECOVERY_CHAIN_DEPTH, ISSUE_PASSIVE_FOLLOWUP_REASON, ISSUE_PASSIVE_FOLLOWUP_WAKE_SOURCE, ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON, ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS, ISSUE_REVIEW_CLOSEOUT_REASON, ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON, ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS, ISSUE_PASSIVE_FOLLOWUP_COOLDOWN_MS_BY_ATTEMPT, ISSUE_PASSIVE_FOLLOWUP_TIMER_CONTINUITY_MAX_WINDOW_MS, SESSIONED_LOCAL_ADAPTERS, heartbeatRunListColumns, appendExcerpt, appendTranscriptEntriesFromChunk, normalizeMaxConcurrentRuns, withAgentStartLock, readNonEmptyString, resolveHeartbeatObservabilitySurface, buildHeartbeatObservationName, compactTraceText, buildIssueRunTraceName, buildHeartbeatRuntimeTraceMetadata, buildHeartbeatAdapterInvokePayload, buildRecentDateKeys, buildDateKeysBetween, fallbackSkillLabel, normalizeLoadedSkill, normalizeLoadedSkillForPayload, emptySkillEvidenceCounts, incrementSkillEvidenceCount, strongestSkillEvidence, resolveSkillEvidence, readSkillEvidenceFromPayload, extractSkillSlugFromPath, collectSkillPathsFromText, collectStringValues, normalizeSkillUseFromPath, dedupeSkillUses, collectSkillUsesFromText, readToolCommandInput, isCommandTranscriptTool, isReadTranscriptTool, inferUsedSkillsFromTranscript, normalizeSkillCandidate, addSkillCandidate, readSkillReferenceSlug, collectSkillReferences, inferUsedSkillsFromPrompt, normalizeLedgerBillingType, resolveLedgerBiller, normalizeBilledCostCents, resolveLedgerScopeForRun } = heartbeatCore;
const { buildExplicitResumeSessionOverride, normalizeUsageTotals, readRawUsageTotals, deriveNormalizedUsageDelta, formatCount, parseSessionCompactionPolicy, resolveRuntimeSessionParamsForWorkspace, parseIssueAssigneeAgentRuntimeOverrides, deriveTaskKey, shouldResetTaskSessionForWake, formatRuntimeWorkspaceWarningLog, describeSessionResetReason, deriveCommentId, enrichWakeContextSnapshot, mergeCoalescedContextSnapshot, issueCommentAuthorKind, issueCommentAuthorLabel, buildDeferredWakePayload, readDeferredWakeContext, readDeferredWakePayload, deriveDeferredWakeTaskKey, hydrateWakeContextSnapshot, firstNonEmptyLine, deriveRecoveryFailureKind, deriveRecoveryFailureSummary, mergeMissingRecoveryContextFields, hydrateRecoveryBaseContextSnapshot, buildRecoveryContextSnapshot, normalizePassiveFollowupContext, normalizeReviewCloseoutContext, passiveFollowupCooldownMs, issueHasReviewer, isAgentEligibleForTimerContinuation, hasCredibleTimerContinuation, buildPassiveFollowupContextSnapshot, runTaskKey, isSameTaskScope, isTrackedLocalChildProcessAdapter, isProcessAlive, waitForProcessExit, terminateOrphanedProcess, truncateDisplayId, normalizeAgentNameKey, defaultSessionCodec, getAgentRuntimeSessionCodec, normalizeSessionParams, resolveNextSessionState } = heartbeatSessions;

export function createHeartbeatReleaseHandlers(context: any) {
  const { db, instanceSettings, getCurrentUserRedactionOptions, runLogStore, runContextSvc, issuesSvc, documentsSvc, executionWorkspacesSvc, workspaceOperationsSvc, activeRunExecutions, budgetHooks, budgets, getAgent, getRun, getRuntimeState, getTaskSession, getLatestRunForSession, getOldestRunForSession, resolveNormalizedUsageForSession, evaluateSessionCompaction, resolveSessionBeforeForWakeup, resolveExplicitResumeSessionOverride, upsertTaskSession, clearTaskSessions, ensureRuntimeState, buildHeartbeatObservabilityContext, emitHeartbeatObservationEvent, emitHeartbeatLiveEval, setRunStatus, setWakeupStatus, updateWakeupRequestRecord, insertWakeupRequestRecord, appendRunEvent, nextRunEventSeq, persistRunProcessMetadata, clearDetachedRunWarning, enqueueRecoveryRun, enqueueProcessLossRetry, parseHeartbeatPolicy, markAgentHeartbeatChecked, evaluateTimerPreflight, runHasIssueClosureComment, runHasIssueReviewDecision, issueHasDeferredWake, passiveFollowupAlreadyRecorded, reviewerCloseoutAlreadyRecorded, issueHasConfirmedBlockedReviewerHandoff, evaluatePassiveIssueClosureForLockedIssue, countRunningRunsForAgent, claimQueuedRun, finalizeAgentStatus, reapOrphanedRuns, resumeQueuedRuns, updateRuntimeState, startNextQueuedRunForAgent, executeRun, enqueueWakeup, resumeDeferredWakeupsForAgent, listProjectScopedRunIds, listProjectScopedWakeupIds, cancelPendingWakeupsForBudgetScope, cancelRunInternal, cancelActiveForAgentInternal, cancelBudgetScopeWork, retryRunInternal, buildSkillAnalytics } = context;

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

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect) {
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
        return { promotedRun: passiveClosure.run, passiveClosure, chatOutputCompletion };
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

        if (!deferred) return { promotedRun: null, passiveClosure, chatOutputCompletion };

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

        return { promotedRun: newRun, passiveClosure };
      }
    });

    const passiveClosure = outcome.passiveClosure;
    if (passiveClosure?.kind === "queued") {
      await appendRunEvent(run, await nextRunEventSeq(run.id), {
        eventType: "issue.passive_followup_queued",
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
      await appendRunEvent(passiveClosure.run, await nextRunEventSeq(passiveClosure.run.id), {
        eventType: "issue.passive_followup_queued",
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
      await appendRunEvent(run, await nextRunEventSeq(run.id), {
        eventType: "issue.closure_needs_operator_review",
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
      await appendRunEvent(run, await nextRunEventSeq(run.id), {
        eventType: "issue.convergence_review_requested",
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
      if (passiveClosure.issue.reviewerAgentId) {
        await enqueueWakeup(passiveClosure.issue.reviewerAgentId, {
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
          idempotencyKey: `issue_convergence_review_requested:${passiveClosure.originRunId}`,
        }).catch((err) => {
          logger.warn({ err, issueId: passiveClosure.issue.id }, "failed to wake reviewer after passive issue close-out exhaustion");
          return null;
        });
      }
    } else if (passiveClosure?.kind === "reviewer_closeout") {
      await appendRunEvent(run, await nextRunEventSeq(run.id), {
        eventType: "issue.review_closeout_missing",
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
        actorId: "issue_review_closeout_governance",
        action: "issue.review_closeout_missing",
        entityType: "issue",
        entityId: passiveClosure.issue.id,
        agentId: run.agentId,
        runId: run.id,
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
      if (passiveClosure.issue.reviewerAgentId) {
        await enqueueWakeup(passiveClosure.issue.reviewerAgentId, {
          ...buildIssueReviewCloseoutWakeupOptions({
            issue: passiveClosure.issue,
            contextSource: "issue.review_closeout_missing",
            originRunId: passiveClosure.originRunId,
            previousRunId: passiveClosure.previousRunId,
            attempts: passiveClosure.attempts,
            maxAttempts: passiveClosure.maxAttempts,
            requestedByActorType: "system",
            requestedByActorId: "issue_review_closeout_governance",
          }),
          idempotencyKey: `${ISSUE_REVIEW_CLOSEOUT_REASON}:${run.id}`,
        }).catch((err) => {
          logger.warn({ err, issueId: passiveClosure.issue.id }, "failed to wake reviewer after missing review close-out");
          return null;
        });
      }
    } else if (passiveClosure?.kind === "reviewer_closeout_operator_review") {
      await appendRunEvent(run, await nextRunEventSeq(run.id), {
        eventType: "issue.review_closure_needs_operator_review",
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
        actorId: "issue_review_closeout_governance",
        action: "issue.review_closure_needs_operator_review",
        entityType: "issue",
        entityId: passiveClosure.issue.id,
        agentId: run.agentId,
        runId: run.id,
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

    await startNextQueuedRunForAgent(promotedRun.agentId);
  }

  return { releaseIssueExecutionAndPromote };
}
