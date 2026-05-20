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

export { prioritizeProjectWorkspaceCandidatesForRun, type ResolvedWorkspaceForRun } from "../agent-run-context.js";

import * as heartbeatCore from "./heartbeat.core.js";
import * as heartbeatSessions from "./heartbeat.sessions.js";
const { MAX_LIVE_LOG_CHUNK_BYTES, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, DEFERRED_WAKE_CONTEXT_KEY, DETACHED_PROCESS_ERROR_CODE, ORPHANED_PROCESS_TERMINATION_GRACE_MS, ORPHANED_PROCESS_KILL_WAIT_MS, ORPHANED_PROCESS_POLL_INTERVAL_MS, startLocksByAgent, MAX_RECOVERY_CHAIN_DEPTH, ISSUE_PASSIVE_FOLLOWUP_REASON, ISSUE_PASSIVE_FOLLOWUP_WAKE_SOURCE, ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON, ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS, ISSUE_REVIEW_CLOSEOUT_REASON, ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON, ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS, ISSUE_PASSIVE_FOLLOWUP_COOLDOWN_MS_BY_ATTEMPT, ISSUE_PASSIVE_FOLLOWUP_TIMER_CONTINUITY_MAX_WINDOW_MS, SESSIONED_LOCAL_ADAPTERS, heartbeatRunListColumns, appendExcerpt, appendTranscriptEntriesFromChunk, normalizeMaxConcurrentRuns, withAgentStartLock, readNonEmptyString, resolveHeartbeatObservabilitySurface, buildHeartbeatObservationName, compactTraceText, buildIssueRunTraceName, buildHeartbeatRuntimeTraceMetadata, buildHeartbeatAdapterInvokePayload, buildRecentDateKeys, buildDateKeysBetween, fallbackSkillLabel, normalizeLoadedSkill, normalizeLoadedSkillForPayload, emptySkillEvidenceCounts, incrementSkillEvidenceCount, strongestSkillEvidence, resolveSkillEvidence, readSkillEvidenceFromPayload, extractSkillSlugFromPath, collectSkillPathsFromText, collectStringValues, normalizeSkillUseFromPath, dedupeSkillUses, collectSkillUsesFromText, readToolCommandInput, isCommandTranscriptTool, isReadTranscriptTool, inferUsedSkillsFromTranscript, normalizeSkillCandidate, addSkillCandidate, readSkillReferenceSlug, collectSkillReferences, inferUsedSkillsFromPrompt, normalizeLedgerBillingType, resolveLedgerBiller, normalizeBilledCostCents, resolveLedgerScopeForRun } = heartbeatCore;
const { buildExplicitResumeSessionOverride, normalizeUsageTotals, readRawUsageTotals, deriveNormalizedUsageDelta, formatCount, parseSessionCompactionPolicy, resolveRuntimeSessionParamsForWorkspace, parseIssueAssigneeAgentRuntimeOverrides, deriveTaskKey, shouldResetTaskSessionForWake, formatRuntimeWorkspaceWarningLog, describeSessionResetReason, deriveCommentId, enrichWakeContextSnapshot, mergeCoalescedContextSnapshot, issueCommentAuthorKind, issueCommentAuthorLabel, buildDeferredWakePayload, readDeferredWakeContext, readDeferredWakePayload, deriveDeferredWakeTaskKey, hydrateWakeContextSnapshot, firstNonEmptyLine, deriveRecoveryFailureKind, deriveRecoveryFailureSummary, mergeMissingRecoveryContextFields, hydrateRecoveryBaseContextSnapshot, buildRecoveryContextSnapshot, normalizePassiveFollowupContext, normalizeReviewCloseoutContext, passiveFollowupCooldownMs, issueHasReviewer, isAgentEligibleForTimerContinuation, hasCredibleTimerContinuation, buildPassiveFollowupContextSnapshot, runTaskKey, isSameTaskScope, isTrackedLocalChildProcessAdapter, isProcessAlive, waitForProcessExit, terminateOrphanedProcess, truncateDisplayId, normalizeAgentNameKey, defaultSessionCodec, getAgentRuntimeSessionCodec, normalizeSessionParams, resolveNextSessionState } = heartbeatSessions;

export function createHeartbeatMiscHandlers(context: any) {
  const { db, instanceSettings, getCurrentUserRedactionOptions, runLogStore, runContextSvc, issuesSvc, documentsSvc, executionWorkspacesSvc, workspaceOperationsSvc, activeRunExecutions, budgetHooks, budgets, getAgent, getRun, getRuntimeState, getTaskSession, getLatestRunForSession, getOldestRunForSession, resolveNormalizedUsageForSession, evaluateSessionCompaction, resolveSessionBeforeForWakeup, resolveExplicitResumeSessionOverride, upsertTaskSession, clearTaskSessions, ensureRuntimeState, buildHeartbeatObservabilityContext, emitHeartbeatObservationEvent, emitHeartbeatLiveEval, setRunStatus, setWakeupStatus, updateWakeupRequestRecord, insertWakeupRequestRecord, appendRunEvent, nextRunEventSeq, persistRunProcessMetadata, clearDetachedRunWarning, enqueueRecoveryRun, enqueueProcessLossRetry, parseHeartbeatPolicy, markAgentHeartbeatChecked, evaluateTimerPreflight, runHasIssueClosureComment, runHasIssueReviewDecision, issueHasDeferredWake, passiveFollowupAlreadyRecorded, reviewerCloseoutAlreadyRecorded, issueHasConfirmedBlockedReviewerHandoff, evaluatePassiveIssueClosureForLockedIssue, countRunningRunsForAgent, claimQueuedRun, finalizeAgentStatus, reapOrphanedRuns, resumeQueuedRuns, updateRuntimeState, startNextQueuedRunForAgent, executeRun, releaseIssueExecutionAndPromote, enqueueWakeup } = context;

  async function resumeDeferredWakeupsForAgent(agentId: string) {
    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");

    const replayedRequestIds: string[] = [];

    while (true) {
      const deferred = await db
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
        .orderBy(asc(agentWakeupRequests.requestedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!deferred) break;

      const replayPayload = readDeferredWakePayload(deferred.payload);
      const replayContextSnapshot = readDeferredWakeContext(deferred.payload);

      try {
        await enqueueWakeup(agentId, {
          source: (readNonEmptyString(deferred.source) as WakeupOptions["source"]) ?? "on_demand",
          triggerDetail:
            (readNonEmptyString(deferred.triggerDetail) as WakeupOptions["triggerDetail"]) ?? undefined,
          reason: readNonEmptyString(deferred.reason) ?? null,
          payload: replayPayload,
          idempotencyKey: deferred.idempotencyKey,
          requestedByActorType:
            (deferred.requestedByActorType as WakeupOptions["requestedByActorType"]) ?? undefined,
          requestedByActorId: deferred.requestedByActorId,
          contextSnapshot: replayContextSnapshot,
          existingWakeupRequestId: deferred.id,
        });
      } catch (error) {
        const current = await db
          .select({ status: agentWakeupRequests.status })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, deferred.id))
          .then((rows) => rows[0] ?? null);
        if (current?.status === "deferred_agent_paused") {
          await setWakeupStatus(deferred.id, "failed", {
            finishedAt: new Date(),
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      replayedRequestIds.push(deferred.id);

      const current = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferred.id))
        .then((rows) => rows[0] ?? null);

      if (current?.status === "deferred_agent_paused") break;
    }

    return {
      replayed: replayedRequestIds.length,
      wakeupRequestIds: replayedRequestIds,
    };
  }

  async function listProjectScopedRunIds(orgId: string, projectId: string) {
    const runIssueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([heartbeatRuns.id], { id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .leftJoin(
        issues,
        and(
          eq(issues.orgId, orgId),
          sql`${issues.id}::text = ${runIssueId}`,
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.orgId, orgId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function listProjectScopedWakeupIds(orgId: string, projectId: string) {
    const wakeIssueId = sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${agentWakeupRequests.payload} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([agentWakeupRequests.id], { id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .leftJoin(
        issues,
        and(
          eq(issues.orgId, orgId),
          sql`${issues.id}::text = ${wakeIssueId}`,
        ),
      )
      .where(
        and(
          eq(agentWakeupRequests.orgId, orgId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          sql`${agentWakeupRequests.runId} is null`,
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function cancelPendingWakeupsForBudgetScope(scope: BudgetEnforcementScope) {
    const now = new Date();
    let wakeupIds: string[] = [];

    if (scope.scopeType === "organization") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.orgId, scope.orgId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else if (scope.scopeType === "agent") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.orgId, scope.orgId),
            eq(agentWakeupRequests.agentId, scope.scopeId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else {
      wakeupIds = await listProjectScopedWakeupIds(scope.orgId, scope.scopeId);
    }

    if (wakeupIds.length === 0) return 0;

    await db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: "Cancelled due to budget pause",
        updatedAt: now,
      })
      .where(inArray(agentWakeupRequests.id, wakeupIds));

    return wakeupIds.length;
  }

  async function cancelRunInternal(runId: string, reason = "Cancelled by control plane") {
    const run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (run.status !== "running" && run.status !== "queued") return run;

    const running = runningProcesses.get(run.id);
    if (running) {
      running.child.kill("SIGTERM");
      const graceMs = Math.max(1, running.graceSec) * 1000;
      setTimeout(() => {
        if (!running.child.killed) {
          running.child.kill("SIGKILL");
        }
      }, graceMs);
    }

    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: new Date(),
      error: reason,
      errorCode: "cancelled",
    });

    await setWakeupStatus(run.wakeupRequestId, "cancelled", {
      finishedAt: new Date(),
      error: reason,
    });

    if (cancelled) {
      await appendRunEvent(cancelled, 1, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "run cancelled",
      });
      await releaseIssueExecutionAndPromote(cancelled);
    }

    runningProcesses.delete(run.id);
    await finalizeAgentStatus(run.agentId, "cancelled");
    await startNextQueuedRunForAgent(run.agentId);
    return cancelled;
  }

  async function cancelActiveForAgentInternal(agentId: string, reason = "Cancelled due to agent pause") {
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

    for (const run of runs) {
      await setRunStatus(run.id, "cancelled", {
        finishedAt: new Date(),
        error: reason,
        errorCode: "cancelled",
      });

      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: new Date(),
        error: reason,
      });

      const running = runningProcesses.get(run.id);
      if (running) {
        running.child.kill("SIGTERM");
        runningProcesses.delete(run.id);
      }
      await releaseIssueExecutionAndPromote(run);
    }

    return runs.length;
  }

  async function cancelBudgetScopeWork(scope: BudgetEnforcementScope) {
    if (scope.scopeType === "agent") {
      await cancelActiveForAgentInternal(scope.scopeId, "Cancelled due to budget pause");
      await cancelPendingWakeupsForBudgetScope(scope);
      return;
    }

    const runIds =
      scope.scopeType === "organization"
        ? await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.orgId, scope.orgId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
            ),
          )
          .then((rows) => rows.map((row) => row.id))
        : await listProjectScopedRunIds(scope.orgId, scope.scopeId);

    for (const runId of runIds) {
      await cancelRunInternal(runId, "Cancelled due to budget pause");
    }

    await cancelPendingWakeupsForBudgetScope(scope);
  }

  async function retryRunInternal(
    runId: string,
    opts?: {
      requestedByActorType?: WakeupOptions["requestedByActorType"];
      requestedByActorId?: string | null;
      now?: Date;
    },
  ) {
    const run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (run.status !== "failed" && run.status !== "timed_out" && run.status !== "cancelled") {
      throw conflict("Only failed, timed out, or cancelled runs can be retried", {
        status: run.status,
      });
    }

    const agent = await getAgent(run.agentId);
    if (!agent) throw notFound("Agent not found");
    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    const policy = parseHeartbeatPolicy(agent);
    if (!policy.wakeOnDemand) {
      throw conflict("Agent is not configured for on-demand wakeups");
    }

    const context = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(context.issueId);
    let projectId = readNonEmptyString(context.projectId);
    if (!projectId && issueId) {
      projectId = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.orgId, agent.orgId)))
        .then((rows) => rows[0]?.projectId ?? null);
    }

    const budgetBlock = await budgets.getInvocationBlock(agent.orgId, agent.id, {
      issueId,
      projectId,
    });
    if (budgetBlock) {
      throw conflict(budgetBlock.reason, {
        scopeType: budgetBlock.scopeType,
        scopeId: budgetBlock.scopeId,
      });
    }

    return enqueueRecoveryRun(run, agent, {
      recoveryTrigger: "manual",
      source: "on_demand",
      triggerDetail: "manual",
      wakeReason: "retry_failed_run",
      requestedByActorType: opts?.requestedByActorType ?? "user",
      requestedByActorId: opts?.requestedByActorId ?? null,
      now: opts?.now ?? new Date(),
    });
  }

  async function buildSkillAnalytics(
    scope: { orgId: string; agentId?: string },
    opts?: { windowDays?: number; now?: Date; startDate?: string; endDate?: string },
  ): Promise<AgentSkillAnalytics> {
    const now = opts?.now ?? new Date();
    const customDateKeys = opts?.startDate && opts?.endDate
      ? buildDateKeysBetween(opts.startDate, opts.endDate).slice(0, 120)
      : [];
    const windowDays = customDateKeys.length > 0
      ? customDateKeys.length
      : Math.max(1, Math.min(opts?.windowDays ?? 30, 90));
    const dateKeys = customDateKeys.length > 0
      ? customDateKeys
      : buildRecentDateKeys(windowDays, now);
    const startDate = dateKeys[0]!;
    const endDate = dateKeys.at(-1)!;
    const windowStart = new Date(`${startDate}T00:00:00.000Z`);
    const windowEnd = new Date(`${endDate}T23:59:59.999Z`);

    const rows = await db
      .select({
        runId: heartbeatRunEvents.runId,
        createdAt: heartbeatRunEvents.createdAt,
        eventType: heartbeatRunEvents.eventType,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(
        and(
          eq(heartbeatRunEvents.orgId, scope.orgId),
          ...(scope.agentId ? [eq(heartbeatRunEvents.agentId, scope.agentId)] : []),
          inArray(heartbeatRunEvents.eventType, ["adapter.invoke", "adapter.skill_usage"]),
          gte(heartbeatRunEvents.createdAt, windowStart),
          lte(heartbeatRunEvents.createdAt, windowEnd),
        ),
      )
      .orderBy(asc(heartbeatRunEvents.createdAt), asc(heartbeatRunEvents.id));

    const days = new Map<string, {
      totalCount: number;
      runCount: number;
      evidenceCounts: AgentSkillTelemetryEvidenceCounts;
      skills: Map<string, {
        key: string;
        label: string;
        count: number;
        evidence: AgentSkillTelemetryEvidence;
        evidenceCounts: AgentSkillTelemetryEvidenceCounts;
      }>;
    }>();
    for (const date of dateKeys) {
      days.set(date, { totalCount: 0, runCount: 0, evidenceCounts: emptySkillEvidenceCounts(), skills: new Map() });
    }

    const overallSkills = new Map<string, {
      key: string;
      label: string;
      count: number;
      evidence: AgentSkillTelemetryEvidence;
      evidenceCounts: AgentSkillTelemetryEvidenceCounts;
    }>();
    const runEvidence = new Map<string, {
      date: string;
      skills: Map<string, { key: string; label: string; evidence: AgentSkillTelemetryEvidence }>;
    }>();
    let totalCount = 0;
    let totalRunsWithSkills = 0;
    const evidenceCounts = emptySkillEvidenceCounts();

    function addRunSkillEvidence(
      runId: string,
      date: string,
      evidence: { evidence: AgentSkillTelemetryEvidence; skills: Array<{ key: string; label: string }> },
    ) {
      if (!days.has(date)) return;
      if (evidence.evidence !== "used") return;
      if (evidence.skills.length === 0) return;

      const runBucket = runEvidence.get(runId) ?? { date, skills: new Map() };
      for (const entry of evidence.skills) {
        const normalized = normalizeLoadedSkill(entry);
        if (!normalized) continue;
        const existing = runBucket.skills.get(normalized.key);
        if (existing) {
          existing.evidence = strongestSkillEvidence(existing.evidence, evidence.evidence);
          if (existing.label === fallbackSkillLabel(existing.key) && normalized.label !== fallbackSkillLabel(normalized.key)) {
            existing.label = normalized.label;
          }
        } else {
          runBucket.skills.set(normalized.key, {
            key: normalized.key,
            label: normalized.label,
            evidence: evidence.evidence,
          });
        }
      }
      if (runBucket.skills.size > 0) runEvidence.set(runId, runBucket);
    }

    async function inferUsedSkillsFromStoredRunLog(row: {
      id: string;
      agentRuntimeType: string;
      logStore: string | null;
      logRef: string | null;
      logBytes: number | null;
    }) {
      if (row.logStore !== "local_file" || !row.logRef) return [];
      const adapter = (() => {
        try {
          return getServerAdapter(row.agentRuntimeType);
        } catch {
          return null;
        }
      })();
      if (!adapter) return [];
      const parser = adapter.parseStdoutLine ?? null;
      if (!parser) return [];

      const limitBytes = Math.min(Math.max(row.logBytes ?? 0, 256_000), 2_000_000);
      const read = await runLogStore
        .read({ store: "local_file", logRef: row.logRef }, { limitBytes })
        .catch(() => null);
      if (!read?.content) return [];

      const transcript: TranscriptEntry[] = [];
      let stdoutBuffer = "";
      let stderrBuffer = "";
      for (const line of read.content.split("\n")) {
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = parseObject(raw);
        const stream = parsed.stream === "stderr" ? "stderr" : parsed.stream === "stdout" ? "stdout" : null;
        const chunk = typeof parsed.chunk === "string" ? parsed.chunk : "";
        if (!stream || !chunk) continue;
        if (stream === "stdout") {
          stdoutBuffer = appendTranscriptEntriesFromChunk({
            buffer: stdoutBuffer,
            chunk,
            transcript,
            parser,
            kind: "stdout",
          });
        } else {
          stderrBuffer = appendTranscriptEntriesFromChunk({
            buffer: stderrBuffer,
            chunk,
            transcript,
            kind: "stderr",
          });
        }
      }
      appendTranscriptEntriesFromChunk({
        buffer: stdoutBuffer,
        chunk: "",
        transcript,
        parser,
        kind: "stdout",
        finalize: true,
      });
      appendTranscriptEntriesFromChunk({
        buffer: stderrBuffer,
        chunk: "",
        transcript,
        kind: "stderr",
        finalize: true,
      });
      return inferUsedSkillsFromTranscript(transcript);
    }

    for (const row of rows) {
      const date = new Date(row.createdAt).toISOString().slice(0, 10);
      const payload = parseObject(row.payload);
      addRunSkillEvidence(row.runId, date, readSkillEvidenceFromPayload(payload));
    }

    const runRows = await db
      .select({
        id: heartbeatRuns.id,
        agentRuntimeType: agents.agentRuntimeType,
        createdAt: heartbeatRuns.createdAt,
        logStore: heartbeatRuns.logStore,
        logRef: heartbeatRuns.logRef,
        logBytes: heartbeatRuns.logBytes,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .where(
        and(
          eq(heartbeatRuns.orgId, scope.orgId),
          ...(scope.agentId ? [eq(heartbeatRuns.agentId, scope.agentId)] : []),
          gte(heartbeatRuns.createdAt, windowStart),
          lte(heartbeatRuns.createdAt, windowEnd),
        ),
      );

    for (const row of runRows) {
      const usedSkills = await inferUsedSkillsFromStoredRunLog(row);
      if (usedSkills.length === 0) continue;
      addRunSkillEvidence(row.id, new Date(row.createdAt).toISOString().slice(0, 10), {
        evidence: "used",
        skills: usedSkills,
      });
    }

    for (const runBucket of runEvidence.values()) {
      const bucket = days.get(runBucket.date);
      if (!bucket || runBucket.skills.size === 0) continue;

      bucket.runCount += 1;
      totalRunsWithSkills += 1;
      for (const { key, label, evidence } of runBucket.skills.values()) {
        bucket.totalCount += 1;
        totalCount += 1;
        incrementSkillEvidenceCount(bucket.evidenceCounts, evidence);
        incrementSkillEvidenceCount(evidenceCounts, evidence);

        const existingDaySkill = bucket.skills.get(key);
        if (existingDaySkill) {
          existingDaySkill.count += 1;
          existingDaySkill.evidence = strongestSkillEvidence(existingDaySkill.evidence, evidence);
          incrementSkillEvidenceCount(existingDaySkill.evidenceCounts, evidence);
        } else {
          const skillEvidenceCounts = emptySkillEvidenceCounts();
          incrementSkillEvidenceCount(skillEvidenceCounts, evidence);
          bucket.skills.set(key, { key, label, count: 1, evidence, evidenceCounts: skillEvidenceCounts });
        }

        const existingOverallSkill = overallSkills.get(key);
        if (existingOverallSkill) {
          existingOverallSkill.count += 1;
          existingOverallSkill.evidence = strongestSkillEvidence(existingOverallSkill.evidence, evidence);
          incrementSkillEvidenceCount(existingOverallSkill.evidenceCounts, evidence);
        } else {
          const skillEvidenceCounts = emptySkillEvidenceCounts();
          incrementSkillEvidenceCount(skillEvidenceCounts, evidence);
          overallSkills.set(key, { key, label, count: 1, evidence, evidenceCounts: skillEvidenceCounts });
        }
      }
    }

    return {
      agentId: scope.agentId ?? "__all__",
      orgId: scope.orgId,
      windowDays,
      startDate,
      endDate,
      totalCount,
      totalRunsWithSkills,
      evidenceCounts,
      skills: Array.from(overallSkills.values()).sort((left, right) => (
        right.count - left.count
        || left.label.localeCompare(right.label)
        || left.key.localeCompare(right.key)
      )),
      days: dateKeys.map((date) => {
        const bucket = days.get(date)!;
        return {
          date,
          totalCount: bucket.totalCount,
          runCount: bucket.runCount,
          evidenceCounts: bucket.evidenceCounts,
          skills: Array.from(bucket.skills.values()).sort((left, right) => (
            right.count - left.count
            || left.label.localeCompare(right.label)
            || left.key.localeCompare(right.key)
          )),
        };
      }),
    };
  }

  return { resumeDeferredWakeupsForAgent, listProjectScopedRunIds, listProjectScopedWakeupIds, cancelPendingWakeupsForBudgetScope, cancelRunInternal, cancelActiveForAgentInternal, cancelBudgetScopeWork, retryRunInternal, buildSkillAnalytics };
}
