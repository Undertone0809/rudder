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
import { runWorkspaceService } from "../execution-workspaces.js";
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
const { MAX_LIVE_LOG_CHUNK_BYTES, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, DEFERRED_WAKE_CONTEXT_KEY, DETACHED_PROCESS_ERROR_CODE, ORPHANED_PROCESS_TERMINATION_GRACE_MS, ORPHANED_PROCESS_KILL_WAIT_MS, ORPHANED_PROCESS_POLL_INTERVAL_MS, startLocksByAgent, MAX_RECOVERY_CHAIN_DEPTH, ISSUE_PASSIVE_FOLLOWUP_REASON, ISSUE_PASSIVE_FOLLOWUP_WAKE_SOURCE, ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON, ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS, ISSUE_REVIEW_CLOSEOUT_REASON, ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON, ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS, ISSUE_PASSIVE_FOLLOWUP_COOLDOWN_MS_BY_ATTEMPT, ISSUE_PASSIVE_FOLLOWUP_TIMER_CONTINUITY_MAX_WINDOW_MS, SESSIONED_LOCAL_ADAPTERS, heartbeatRunListColumns, appendExcerpt, appendTranscriptEntriesFromChunk, normalizeMaxConcurrentRuns, withAgentStartLock, readNonEmptyString, isIssueCommentMentionWake, resolveHeartbeatObservabilitySurface, buildHeartbeatObservationName, compactTraceText, buildIssueRunTraceName, buildHeartbeatRuntimeTraceMetadata, buildHeartbeatAdapterInvokePayload, buildRecentDateKeys, buildDateKeysBetween, fallbackSkillLabel, normalizeLoadedSkill, normalizeLoadedSkillForPayload, emptySkillEvidenceCounts, incrementSkillEvidenceCount, strongestSkillEvidence, resolveSkillEvidence, readSkillEvidenceFromPayload, extractSkillSlugFromPath, collectSkillPathsFromText, collectStringValues, normalizeSkillUseFromPath, dedupeSkillUses, collectSkillUsesFromText, readToolCommandInput, isCommandTranscriptTool, isReadTranscriptTool, inferUsedSkillsFromTranscript, normalizeSkillCandidate, addSkillCandidate, readSkillReferenceSlug, collectSkillReferences, inferUsedSkillsFromPrompt, normalizeLedgerBillingType, resolveLedgerBiller, normalizeBilledCostCents, resolveLedgerScopeForRun } = heartbeatCore;
const { buildExplicitResumeSessionOverride, normalizeUsageTotals, readRawUsageTotals, deriveNormalizedUsageDelta, formatCount, parseSessionCompactionPolicy, resolveRuntimeSessionParamsForWorkspace, parseIssueAssigneeAgentRuntimeOverrides, deriveTaskKey, shouldResetTaskSessionForWake, formatRuntimeWorkspaceWarningLog, describeSessionResetReason, deriveCommentId, enrichWakeContextSnapshot, mergeCoalescedContextSnapshot, issueCommentAuthorKind, issueCommentAuthorLabel, buildDeferredWakePayload, readDeferredWakeContext, readDeferredWakePayload, deriveDeferredWakeTaskKey, hydrateWakeContextSnapshot, firstNonEmptyLine, deriveRecoveryFailureKind, deriveRecoveryFailureSummary, mergeMissingRecoveryContextFields, hydrateRecoveryBaseContextSnapshot, buildRecoveryContextSnapshot, normalizePassiveFollowupContext, normalizeReviewCloseoutContext, passiveFollowupCooldownMs, issueHasReviewer, isAgentEligibleForTimerContinuation, hasCredibleTimerContinuation, buildPassiveFollowupContextSnapshot, runTaskKey, isSameTaskScope, isTrackedLocalChildProcessAdapter, isProcessAlive, waitForProcessExit, terminateOrphanedProcess, truncateDisplayId, normalizeAgentNameKey, defaultSessionCodec, getAgentRuntimeSessionCodec, normalizeSessionParams, resolveNextSessionState } = heartbeatSessions;

export function createHeartbeatWakeupHandlers(context: any) {
  const { db, instanceSettings, getCurrentUserRedactionOptions, runLogStore, runContextSvc, issuesSvc, documentsSvc, executionWorkspacesSvc, workspaceOperationsSvc, activeRunExecutions, budgetHooks, budgets, getAgent, getRun, getRuntimeState, getTaskSession, getLatestRunForSession, getOldestRunForSession, resolveNormalizedUsageForSession, evaluateSessionCompaction, resolveSessionBeforeForWakeup, resolveExplicitResumeSessionOverride, upsertTaskSession, clearTaskSessions, ensureRuntimeState, buildHeartbeatObservabilityContext, emitHeartbeatObservationEvent, emitHeartbeatLiveEval, setRunStatus, setWakeupStatus, updateWakeupRequestRecord, insertWakeupRequestRecord, appendRunEvent, nextRunEventSeq, persistRunProcessMetadata, clearDetachedRunWarning, enqueueRecoveryRun, enqueueProcessLossRetry, parseHeartbeatPolicy, markAgentHeartbeatChecked, evaluateTimerPreflight, runHasIssueClosureComment, runHasIssueReviewDecision, issueHasDeferredWake, passiveFollowupAlreadyRecorded, reviewerCloseoutAlreadyRecorded, issueHasConfirmedBlockedReviewerHandoff, evaluatePassiveIssueClosureForLockedIssue, countRunningRunsForAgent, claimQueuedRun, finalizeAgentStatus, reapOrphanedRuns, resumeQueuedRuns, updateRuntimeState, startNextQueuedRunForAgent, executeRun, releaseIssueExecutionAndPromote, resumeDeferredWakeupsForAgent, listProjectScopedRunIds, listProjectScopedWakeupIds, cancelPendingWakeupsForBudgetScope, cancelRunInternal, cancelActiveForAgentInternal, cancelBudgetScopeWork, retryRunInternal, buildSkillAnalytics } = context;

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = { ...(opts.contextSnapshot ?? {}) };
    const reason = opts.reason ?? null;
    const payload = opts.payload ?? null;
    const existingWakeupRequestId = readNonEmptyString(opts.existingWakeupRequestId);
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    let issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    const explicitResumeSession = await resolveExplicitResumeSessionOverride(agent, payload, taskKey);
    if (explicitResumeSession) {
      enrichedContextSnapshot.resumeFromRunId = explicitResumeSession.resumeFromRunId;
      enrichedContextSnapshot.resumeSessionDisplayId = explicitResumeSession.sessionDisplayId;
      enrichedContextSnapshot.resumeSessionParams = explicitResumeSession.sessionParams;
      if (!readNonEmptyString(enrichedContextSnapshot.issueId) && explicitResumeSession.issueId) {
        enrichedContextSnapshot.issueId = explicitResumeSession.issueId;
      }
      if (!readNonEmptyString(enrichedContextSnapshot.taskId) && explicitResumeSession.taskId) {
        enrichedContextSnapshot.taskId = explicitResumeSession.taskId;
      }
      if (!readNonEmptyString(enrichedContextSnapshot.taskKey) && explicitResumeSession.taskKey) {
        enrichedContextSnapshot.taskKey = explicitResumeSession.taskKey;
      }
      issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueId;
    }
    await hydrateWakeContextSnapshot(db, agent.orgId, enrichedContextSnapshot);
    const effectiveTaskKey = readNonEmptyString(enrichedContextSnapshot.taskKey) ?? taskKey;
    const sessionBefore =
      explicitResumeSession?.sessionDisplayId ??
      await resolveSessionBeforeForWakeup(agent, effectiveTaskKey);

    const writeSkippedRequest = async (skipReason: string, diagnostics?: Record<string, unknown>) => {
      const skippedPayload = diagnostics
        ? {
            ...(payload ?? {}),
            preflight: diagnostics,
          }
        : payload;
      if (existingWakeupRequestId) {
        await setWakeupStatus(existingWakeupRequestId, "skipped", {
          reason: skipReason,
          payload: skippedPayload,
          finishedAt: new Date(),
          runId: null,
          claimedAt: null,
          error: null,
        });
        return;
      }

      await db.insert(agentWakeupRequests).values({
        orgId: agent.orgId,
        agentId,
        source,
        triggerDetail,
        reason: skipReason,
        payload: skippedPayload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
      });
    };

    if (agent.status === "terminated" || agent.status === "pending_approval") {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    let projectId = readNonEmptyString(enrichedContextSnapshot.projectId);
    if (!projectId && issueId) {
      projectId = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.orgId, agent.orgId)))
        .then((rows) => rows[0]?.projectId ?? null);
    }

    const budgetBlock = await budgets.getInvocationBlock(agent.orgId, agentId, {
      issueId,
      projectId,
    });
    if (budgetBlock) {
      await writeSkippedRequest("budget.blocked");
      throw conflict(budgetBlock.reason, {
        scopeType: budgetBlock.scopeType,
        scopeId: budgetBlock.scopeId,
      });
    }

    if (agent.status === "paused") {
      const deferredPayload = buildDeferredWakePayload(payload, enrichedContextSnapshot, issueId);
      if (existingWakeupRequestId) {
        await setWakeupStatus(existingWakeupRequestId, "deferred_agent_paused", {
          reason,
          payload: deferredPayload,
          runId: null,
          claimedAt: null,
          finishedAt: null,
          error: null,
        });
        return null;
      }

      await db.transaction(async (tx) => {
        const deferredRows = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.orgId, agent.orgId),
              eq(agentWakeupRequests.agentId, agentId),
              eq(agentWakeupRequests.status, "deferred_agent_paused"),
              sql`${agentWakeupRequests.runId} is null`,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt));

        const existingDeferred = deferredRows.find((candidate) =>
          isSameTaskScope(deriveDeferredWakeTaskKey(candidate.payload), effectiveTaskKey),
        );

        if (existingDeferred) {
          const mergedDeferredContext = mergeCoalescedContextSnapshot(
            readDeferredWakeContext(existingDeferred.payload),
            enrichedContextSnapshot,
          );
          await updateWakeupRequestRecord(tx, existingDeferred.id, {
            payload: buildDeferredWakePayload(
              {
                ...readDeferredWakePayload(existingDeferred.payload),
                ...(payload ?? {}),
              },
              mergedDeferredContext,
              issueId,
            ),
            coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
            error: null,
            finishedAt: null,
            claimedAt: null,
            runId: null,
          });
          return;
        }

        await insertWakeupRequestRecord(tx, {
          orgId: agent.orgId,
          agentId,
          source,
          triggerDetail,
          reason,
          payload: deferredPayload,
          status: "deferred_agent_paused",
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          idempotencyKey: opts.idempotencyKey ?? null,
        });
      });
      return null;
    }

    const policy = parseHeartbeatPolicy(agent);

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }
    if (source === "timer" && policy.preflightEnabled && !issueId) {
      const recoveredRun = await recoverPendingWakeupForTimer(agent);
      if (recoveredRun) return recoveredRun;

      const preflight = await evaluateTimerPreflight(agent);
      if (!preflight.shouldRun) {
        await writeSkippedRequest(preflight.skipReason, preflight.diagnostics);
        await markAgentHeartbeatChecked(agent, "skipped");
        return null;
      }
    }

    const bypassIssueExecutionLock = isIssueCommentMentionWake({
      reason,
      contextSnapshot: enrichedContextSnapshot,
      payload,
    });

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where id = ${issueId} and org_id = ${agent.orgId} for update`,
        );

        const issue = await tx
          .select({
            id: issues.id,
            orgId: issues.orgId,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.orgId, agent.orgId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          if (existingWakeupRequestId) {
            await updateWakeupRequestRecord(tx, existingWakeupRequestId, {
              status: "skipped",
              reason: "issue_execution_issue_not_found",
              runId: null,
              claimedAt: null,
              finishedAt: new Date(),
              error: null,
            });
          } else {
            await insertWakeupRequestRecord(tx, {
              orgId: agent.orgId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_issue_not_found",
              payload,
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              finishedAt: new Date(),
            });
          }
          return { kind: "skipped" as const };
        }

        let activeExecutionRun = issue.executionRunId
          ? await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, issue.executionRunId))
            .then((rows) => rows[0] ?? null)
          : null;

        if (activeExecutionRun && activeExecutionRun.status !== "queued" && activeExecutionRun.status !== "running") {
          activeExecutionRun = null;
        }

        if (!activeExecutionRun && issue.executionRunId) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }

        if (!activeExecutionRun) {
          const legacyRun = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.orgId, issue.orgId),
                inArray(heartbeatRuns.status, ["queued", "running"]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(
              sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
              asc(heartbeatRuns.createdAt),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (legacyRun) {
            activeExecutionRun = legacyRun;
            const legacyAgent = await tx
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, legacyRun.agentId))
              .then((rows) => rows[0] ?? null);
            await tx
              .update(issues)
              .set({
                executionRunId: legacyRun.id,
                executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
                executionLockedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }
        }

        if (activeExecutionRun) {
          const executionAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, activeExecutionRun.agentId))
            .then((rows) => rows[0] ?? null);
          const executionAgentNameKey =
            normalizeAgentNameKey(issue.executionAgentNameKey) ??
            normalizeAgentNameKey(executionAgent?.name);
          const isSameExecutionAgent =
            Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
          const shouldQueueFollowupForCommentWake =
            Boolean(wakeCommentId) &&
            activeExecutionRun.status === "running" &&
            isSameExecutionAgent;

          if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake) {
            const mergedContextSnapshot = mergeCoalescedContextSnapshot(
              activeExecutionRun.contextSnapshot,
              enrichedContextSnapshot,
            );
            const mergedRun = await tx
              .update(heartbeatRuns)
              .set({
                contextSnapshot: mergedContextSnapshot,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, activeExecutionRun.id))
              .returning()
              .then((rows) => rows[0] ?? activeExecutionRun);

            if (existingWakeupRequestId) {
              await updateWakeupRequestRecord(tx, existingWakeupRequestId, {
                status: "coalesced",
                reason: "issue_execution_same_name",
                runId: mergedRun.id,
                claimedAt: null,
                finishedAt: new Date(),
                error: null,
              });
            } else {
              await insertWakeupRequestRecord(tx, {
                orgId: agent.orgId,
                agentId,
                source,
                triggerDetail,
                reason: "issue_execution_same_name",
                payload,
                status: "coalesced",
                coalescedCount: 1,
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
                runId: mergedRun.id,
                finishedAt: new Date(),
              });
            }

            return { kind: "coalesced" as const, run: mergedRun };
          }

          const deferredPayload = buildDeferredWakePayload(payload, enrichedContextSnapshot, issueId);

          const existingDeferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.orgId, agent.orgId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingDeferred) {
            const mergedDeferredContext = mergeCoalescedContextSnapshot(
              readDeferredWakeContext(existingDeferred.payload),
              enrichedContextSnapshot,
            );
            const mergedDeferredPayload = buildDeferredWakePayload(
              {
                ...readDeferredWakePayload(existingDeferred.payload),
                ...(payload ?? {}),
              },
              mergedDeferredContext,
              issueId,
            );

            if (existingWakeupRequestId && existingDeferred.id !== existingWakeupRequestId) {
              await updateWakeupRequestRecord(tx, existingDeferred.id, {
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
              });
              await updateWakeupRequestRecord(tx, existingWakeupRequestId, {
                status: "coalesced",
                reason: "issue_execution_deferred",
                runId: null,
                claimedAt: null,
                finishedAt: new Date(),
                error: null,
              });
            } else {
              await updateWakeupRequestRecord(tx, existingDeferred.id, {
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
                status: "deferred_issue_execution",
                reason: "issue_execution_deferred",
                runId: null,
                claimedAt: null,
                finishedAt: null,
                error: null,
              });
            }

            return { kind: "deferred" as const };
          }

          if (existingWakeupRequestId) {
            await updateWakeupRequestRecord(tx, existingWakeupRequestId, {
              status: "deferred_issue_execution",
              reason: "issue_execution_deferred",
              payload: deferredPayload,
              runId: null,
              claimedAt: null,
              finishedAt: null,
              error: null,
            });
          } else {
            await insertWakeupRequestRecord(tx, {
              orgId: agent.orgId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_deferred",
              payload: deferredPayload,
              status: "deferred_issue_execution",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
            });
          }

          return { kind: "deferred" as const };
        }

        const wakeupRequest = existingWakeupRequestId
          ? await updateWakeupRequestRecord(tx, existingWakeupRequestId, {
              status: "queued",
              runId: null,
              claimedAt: null,
              finishedAt: null,
              error: null,
            })
          : await insertWakeupRequestRecord(tx, {
              orgId: agent.orgId,
              agentId,
              source,
              triggerDetail,
              reason,
              payload,
              status: "queued",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
            });

        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            orgId: agent.orgId,
            agentId,
            invocationSource: source,
            triggerDetail,
            status: "queued",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: enrichedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await updateWakeupRequestRecord(tx, wakeupRequest.id, {
          runId: newRun.id,
          status: "queued",
          claimedAt: null,
          finishedAt: null,
          error: null,
        });

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: agentNameKey,
            executionLockedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issue.id));

        return { kind: "queued" as const, run: newRun };
      });

      if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
      if (outcome.kind === "coalesced") return outcome.run;

      const newRun = outcome.run;
      publishLiveEvent({
        orgId: newRun.orgId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForCommentWake =
      Boolean(wakeCommentId) && Boolean(sameScopeRunningRun) && !sameScopeQueuedRun;

    const coalescedTargetRun =
      sameScopeQueuedRun ??
      (shouldQueueFollowupForCommentWake ? null : sameScopeRunningRun ?? null);

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        contextSnapshot,
      );
      const mergedRun = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      if (existingWakeupRequestId) {
        await setWakeupStatus(existingWakeupRequestId, "coalesced", {
          runId: mergedRun.id,
          claimedAt: null,
          finishedAt: new Date(),
          error: null,
        });
      } else {
        await db.insert(agentWakeupRequests).values({
          orgId: agent.orgId,
          agentId,
          source,
          triggerDetail,
          reason,
          payload,
          status: "coalesced",
          coalescedCount: 1,
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          idempotencyKey: opts.idempotencyKey ?? null,
          runId: mergedRun.id,
          finishedAt: new Date(),
        });
      }
      return mergedRun;
    }

    const wakeupRequest = existingWakeupRequestId
      ? await updateWakeupRequestRecord(db, existingWakeupRequestId, {
          status: "queued",
          runId: null,
          claimedAt: null,
          finishedAt: null,
          error: null,
        })
      : await insertWakeupRequestRecord(db, {
          orgId: agent.orgId,
          agentId,
          source,
          triggerDetail,
          reason,
          payload,
          status: "queued",
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          idempotencyKey: opts.idempotencyKey ?? null,
        });

    const newRun = await db
      .insert(heartbeatRuns)
      .values({
        orgId: agent.orgId,
        agentId,
        invocationSource: source,
        triggerDetail,
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: enrichedContextSnapshot,
        sessionIdBefore: sessionBefore,
      })
      .returning()
      .then((rows) => rows[0]);

    await updateWakeupRequestRecord(db, wakeupRequest.id, {
      status: "queued",
      runId: newRun.id,
      claimedAt: null,
      finishedAt: null,
      error: null,
    });

    publishLiveEvent({
      orgId: newRun.orgId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(agent.id);

    return newRun;
  }

  async function recoverPendingWakeupForTimer(agent: typeof agents.$inferSelect) {
    const pendingWakeups = await db
      .select()
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
      .orderBy(asc(agentWakeupRequests.requestedAt))
      .limit(25);

    for (const pendingWakeup of pendingWakeups) {
      const pendingPayload = readDeferredWakePayload(pendingWakeup.payload);
      const pendingContext = readDeferredWakeContext(pendingWakeup.payload);
      const pendingIssueId =
        readNonEmptyString(pendingPayload.issueId) ??
        readNonEmptyString(pendingContext.issueId);

      if (pendingWakeup.status === "deferred_issue_execution" && !pendingIssueId) {
        await setWakeupStatus(pendingWakeup.id, "failed", {
          finishedAt: new Date(),
          error: "Deferred issue wake could not be recovered: missing issueId",
          runId: null,
          claimedAt: null,
        });
        continue;
      }

      if (pendingIssueId) {
        const issue = await db
          .select({
            id: issues.id,
            orgId: issues.orgId,
            status: issues.status,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(and(eq(issues.id, pendingIssueId), eq(issues.orgId, agent.orgId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          await setWakeupStatus(pendingWakeup.id, "skipped", {
            reason: "issue_execution_issue_not_found",
            finishedAt: new Date(),
            runId: null,
            claimedAt: null,
            error: null,
          });
          continue;
        }

        if ((issue.status === "done" || issue.status === "cancelled") && !isIssueCommentMentionWake({
          reason: pendingWakeup.reason,
          contextSnapshot: pendingContext,
          payload: pendingPayload,
        })) {
          await setWakeupStatus(pendingWakeup.id, "skipped", {
            reason: "issue_execution_issue_not_actionable",
            finishedAt: new Date(),
            runId: null,
            claimedAt: null,
            error: null,
          });
          continue;
        }

        const liveExecutionRun = issue.executionRunId
          ? await db
              .select({ id: heartbeatRuns.id })
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.id, issue.executionRunId),
                  inArray(heartbeatRuns.status, ["queued", "running"]),
                ),
              )
              .then((rows) => rows[0] ?? null)
          : null;
        if (liveExecutionRun) continue;

        try {
          const recoveredRun = await enqueueWakeup(agent.id, {
            source: (readNonEmptyString(pendingWakeup.source) as WakeupOptions["source"]) ?? "on_demand",
            triggerDetail:
              (readNonEmptyString(pendingWakeup.triggerDetail) as WakeupOptions["triggerDetail"]) ?? undefined,
            reason: readNonEmptyString(pendingWakeup.reason) ?? null,
            payload: pendingPayload,
            idempotencyKey: pendingWakeup.idempotencyKey,
            requestedByActorType:
              (pendingWakeup.requestedByActorType as WakeupOptions["requestedByActorType"]) ?? undefined,
            requestedByActorId: pendingWakeup.requestedByActorId,
            contextSnapshot: pendingContext,
            existingWakeupRequestId: pendingWakeup.id,
          });
          if (recoveredRun) return recoveredRun;
        } catch (error) {
          const current = await db
            .select({ status: agentWakeupRequests.status })
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.id, pendingWakeup.id))
            .then((rows) => rows[0] ?? null);
          if (current?.status === pendingWakeup.status) {
            await setWakeupStatus(pendingWakeup.id, "failed", {
              finishedAt: new Date(),
              error: error instanceof Error ? error.message : String(error),
              runId: null,
              claimedAt: null,
            });
          }
        }
        continue;
      }

      const source = (readNonEmptyString(pendingWakeup.source) as WakeupOptions["source"]) ?? "on_demand";
      const triggerDetail =
        (readNonEmptyString(pendingWakeup.triggerDetail) as WakeupOptions["triggerDetail"]) ?? null;
      const reason = readNonEmptyString(pendingWakeup.reason) ?? null;
      const { contextSnapshot: recoveredContext, taskKey } = enrichWakeContextSnapshot({
        contextSnapshot: pendingContext,
        reason,
        source,
        triggerDetail,
        payload: pendingPayload,
      });
      await hydrateWakeContextSnapshot(db, agent.orgId, recoveredContext);
      const sessionBefore =
        readNonEmptyString(recoveredContext.resumeSessionDisplayId) ??
        await resolveSessionBeforeForWakeup(agent, taskKey);
      const now = new Date();
      const recoveredRun = await db.transaction(async (tx) => {
        const wakeupRequest = await updateWakeupRequestRecord(tx, pendingWakeup.id, {
          status: "queued",
          payload: pendingPayload,
          runId: null,
          claimedAt: null,
          finishedAt: null,
          error: null,
        });
        if (!wakeupRequest || wakeupRequest.runId) return null;

        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            orgId: agent.orgId,
            agentId: agent.id,
            invocationSource: source,
            triggerDetail,
            status: "queued",
            wakeupRequestId: pendingWakeup.id,
            contextSnapshot: recoveredContext,
            sessionIdBefore: sessionBefore,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]);

        await updateWakeupRequestRecord(tx, pendingWakeup.id, {
          status: "queued",
          runId: newRun.id,
          claimedAt: null,
          finishedAt: null,
          error: null,
        });
        return newRun;
      });

      if (recoveredRun) {
        publishLiveEvent({
          orgId: recoveredRun.orgId,
          type: "heartbeat.run.queued",
          payload: {
            runId: recoveredRun.id,
            agentId: recoveredRun.agentId,
            invocationSource: recoveredRun.invocationSource,
            triggerDetail: recoveredRun.triggerDetail,
            wakeupRequestId: recoveredRun.wakeupRequestId,
          },
        });
        await startNextQueuedRunForAgent(agent.id);
        return recoveredRun;
      }
    }

    return null;
  }

  return { enqueueWakeup };
}
