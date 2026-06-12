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
import {
  buildCreateAgentBenchmarkTags,
  coerceCreateAgentBenchmarkMetadata,
  extractCreateAgentBenchmarkMetadata,
} from "@rudderhq/run-intelligence-core";
import { executeAdapterWithModelFallbacks } from "./model-fallback.js";

export { prioritizeProjectWorkspaceCandidatesForRun, type ResolvedWorkspaceForRun } from "../agent-run-context.js";

import * as heartbeatCore from "./heartbeat.core.js";
import type { SessionCompactionDecision, UsageTotals } from "./heartbeat.core.js";
import * as heartbeatSessions from "./heartbeat.sessions.js";
const { MAX_LIVE_LOG_CHUNK_BYTES, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, DEFERRED_WAKE_CONTEXT_KEY, DETACHED_PROCESS_ERROR_CODE, ORPHANED_PROCESS_TERMINATION_GRACE_MS, ORPHANED_PROCESS_KILL_WAIT_MS, ORPHANED_PROCESS_POLL_INTERVAL_MS, startLocksByAgent, MAX_RECOVERY_CHAIN_DEPTH, ISSUE_PASSIVE_FOLLOWUP_REASON, ISSUE_PASSIVE_FOLLOWUP_WAKE_SOURCE, ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON, ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS, ISSUE_REVIEW_CLOSEOUT_REASON, ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON, ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS, ISSUE_PASSIVE_FOLLOWUP_COOLDOWN_MS_BY_ATTEMPT, ISSUE_PASSIVE_FOLLOWUP_TIMER_CONTINUITY_MAX_WINDOW_MS, SESSIONED_LOCAL_ADAPTERS, heartbeatRunListColumns, appendExcerpt, appendTranscriptEntriesFromChunk, normalizeMaxConcurrentRuns, withAgentStartLock, readNonEmptyString, isIssueCommentMentionWake, resolveHeartbeatObservabilitySurface, buildHeartbeatObservationName, compactTraceText, buildIssueRunTraceName, buildHeartbeatRuntimeTraceMetadata, buildHeartbeatAdapterInvokePayload, buildRecentDateKeys, buildDateKeysBetween, fallbackSkillLabel, normalizeLoadedSkill, normalizeLoadedSkillForPayload, emptySkillEvidenceCounts, incrementSkillEvidenceCount, strongestSkillEvidence, resolveSkillEvidence, readSkillEvidenceFromPayload, extractSkillSlugFromPath, collectSkillPathsFromText, collectStringValues, normalizeSkillUseFromPath, dedupeSkillUses, collectSkillUsesFromText, readToolCommandInput, isCommandTranscriptTool, isReadTranscriptTool, inferUsedSkillsFromTranscript, normalizeSkillCandidate, addSkillCandidate, readSkillReferenceSlug, collectSkillReferences, inferUsedSkillsFromPrompt, normalizeLedgerBillingType, resolveLedgerBiller, normalizeBilledCostCents, resolveLedgerScopeForRun } = heartbeatCore;
const { buildExplicitResumeSessionOverride, normalizeUsageTotals, readRawUsageTotals, deriveNormalizedUsageDelta, formatCount, parseSessionCompactionPolicy, resolveRuntimeSessionParamsForWorkspace, parseIssueAssigneeAgentRuntimeOverrides, deriveTaskKey, shouldResetTaskSessionForWake, formatRuntimeWorkspaceWarningLog, describeSessionResetReason, deriveCommentId, enrichWakeContextSnapshot, mergeCoalescedContextSnapshot, issueCommentAuthorKind, issueCommentAuthorLabel, buildDeferredWakePayload, readDeferredWakeContext, readDeferredWakePayload, deriveDeferredWakeTaskKey, hydrateWakeContextSnapshot, firstNonEmptyLine, deriveRecoveryFailureKind, deriveRecoveryFailureSummary, mergeMissingRecoveryContextFields, hydrateRecoveryBaseContextSnapshot, buildRecoveryContextSnapshot, normalizePassiveFollowupContext, normalizeReviewCloseoutContext, passiveFollowupCooldownMs, issueHasReviewer, isAgentEligibleForTimerContinuation, hasCredibleTimerContinuation, buildPassiveFollowupContextSnapshot, runTaskKey, isSameTaskScope, isTrackedLocalChildProcessAdapter, isProcessAlive, waitForProcessExit, terminateOrphanedProcess, truncateDisplayId, normalizeAgentNameKey, defaultSessionCodec, getAgentRuntimeSessionCodec, normalizeSessionParams, resolveNextSessionState } = heartbeatSessions;

import { createHeartbeatExecuteHandlers } from "./heartbeat.execute.js";
import { createHeartbeatMiscHandlers } from "./heartbeat.misc.js";
import { createHeartbeatRecoveryHandlers } from "./heartbeat.recovery.js";
import { createHeartbeatReleaseHandlers } from "./heartbeat.release.js";
import { createHeartbeatWakeupHandlers } from "./heartbeat.wakeup.js";

const DEFAULT_HEARTBEAT_RUN_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const DEFAULT_HEARTBEAT_RUN_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

function formatDurationMs(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function heartbeatService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  const runLogStore = getRunLogStore();
  const runContextSvc = agentRunContextService(db);
  const issuesSvc = issueService(db);
  const executionWorkspacesSvc = runWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const activeRunExecutions = new Set<string>();
  const budgetHooks = {
    cancelWorkForScope: (scope: BudgetEnforcementScope) => cancelBudgetScopeWork(scope),
  };
  const budgets = budgetService(db, budgetHooks);

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getTaskSession(
    orgId: string,
    agentId: string,
    agentRuntimeType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.orgId, orgId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.agentRuntimeType, agentRuntimeType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function getLatestRunForSession(
    agentId: string,
    sessionId: string,
    opts?: { excludeRunId?: string | null },
  ) {
    const conditions = [
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.sessionIdAfter, sessionId),
    ];
    if (opts?.excludeRunId) {
      conditions.push(sql`${heartbeatRuns.id} <> ${opts.excludeRunId}`);
    }
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getOldestRunForSession(agentId: string, sessionId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function resolveNormalizedUsageForSession(input: {
    agentId: string;
    runId: string;
    sessionId: string | null;
    rawUsage: UsageTotals | null;
  }) {
    const { agentId, runId, sessionId, rawUsage } = input;
    if (!sessionId || !rawUsage) {
      return {
        normalizedUsage: rawUsage,
        previousRawUsage: null as UsageTotals | null,
        derivedFromSessionTotals: false,
      };
    }

    const previousRun = await getLatestRunForSession(agentId, sessionId, { excludeRunId: runId });
    const previousRawUsage = readRawUsageTotals(previousRun?.usageJson);
    return {
      normalizedUsage: deriveNormalizedUsageDelta(rawUsage, previousRawUsage),
      previousRawUsage,
      derivedFromSessionTotals: previousRawUsage !== null,
    };
  }

  async function evaluateSessionCompaction(input: {
    agent: typeof agents.$inferSelect;
    sessionId: string | null;
    issueId: string | null;
  }): Promise<SessionCompactionDecision> {
    const { agent, sessionId, issueId } = input;
    if (!sessionId) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const policy = parseSessionCompactionPolicy(agent);
    if (!policy.enabled || !hasSessionCompactionThresholds(policy)) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const fetchLimit = Math.max(policy.maxSessionRuns > 0 ? policy.maxSessionRuns + 1 : 0, 4);
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
        usageJson: heartbeatRuns.usageJson,
        resultJson: heartbeatRuns.resultJson,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(fetchLimit);

    if (runs.length === 0) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const latestRun = runs[0] ?? null;
    const oldestRun =
      policy.maxSessionAgeHours > 0
        ? await getOldestRunForSession(agent.id, sessionId)
        : runs[runs.length - 1] ?? latestRun;
    const latestRawUsage = readRawUsageTotals(latestRun?.usageJson);
    const sessionAgeHours =
      latestRun && oldestRun
        ? Math.max(
            0,
            (new Date(latestRun.createdAt).getTime() - new Date(oldestRun.createdAt).getTime()) / (1000 * 60 * 60),
          )
        : 0;

    let reason: string | null = null;
    if (policy.maxSessionRuns > 0 && runs.length > policy.maxSessionRuns) {
      reason = `session exceeded ${policy.maxSessionRuns} runs`;
    } else if (
      policy.maxRawInputTokens > 0 &&
      latestRawUsage &&
      latestRawUsage.inputTokens >= policy.maxRawInputTokens
    ) {
      reason =
        `session raw input reached ${formatCount(latestRawUsage.inputTokens)} tokens ` +
        `(threshold ${formatCount(policy.maxRawInputTokens)})`;
    } else if (policy.maxSessionAgeHours > 0 && sessionAgeHours >= policy.maxSessionAgeHours) {
      reason = `session age reached ${Math.floor(sessionAgeHours)} hours`;
    }

    if (!reason || !latestRun) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: latestRun?.id ?? null,
      };
    }

    const latestSummary = summarizeHeartbeatRunResultJson(latestRun.resultJson);
    const latestTextSummary =
      readNonEmptyString(latestSummary?.summary) ??
      readNonEmptyString(latestSummary?.result) ??
      readNonEmptyString(latestSummary?.message) ??
      readNonEmptyString(latestRun.error);

    const handoffMarkdown = [
      "Rudder session handoff:",
      `- Previous session: ${sessionId}`,
      issueId ? `- Issue: ${issueId}` : "",
      `- Rotation reason: ${reason}`,
      latestTextSummary ? `- Last run summary: ${latestTextSummary}` : "",
      "Continue from the current task state. Rebuild only the minimum context you need.",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      rotate: true,
      reason,
      handoffMarkdown,
      previousRunId: latestRun.id,
    };
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ) {
    if (taskKey) {
      const codec = getAgentRuntimeSessionCodec(agent.agentRuntimeType);
      const existingTaskSession = await getTaskSession(
        agent.orgId,
        agent.id,
        agent.agentRuntimeType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      return truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );
    }

    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun?.sessionId ?? null;
  }

  async function resolveExplicitResumeSessionOverride(
    agent: typeof agents.$inferSelect,
    payload: Record<string, unknown> | null,
    taskKey: string | null,
  ) {
    const resumeFromRunId = readNonEmptyString(payload?.resumeFromRunId);
    if (!resumeFromRunId) return null;

    const resumeRun = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        sessionIdBefore: heartbeatRuns.sessionIdBefore,
        sessionIdAfter: heartbeatRuns.sessionIdAfter,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, resumeFromRunId),
          eq(heartbeatRuns.orgId, agent.orgId),
          eq(heartbeatRuns.agentId, agent.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!resumeRun) return null;

    const resumeContext = parseObject(resumeRun.contextSnapshot);
    const resumeTaskKey = deriveTaskKey(resumeContext, null) ?? taskKey;
    const resumeTaskSession = resumeTaskKey
      ? await getTaskSession(agent.orgId, agent.id, agent.agentRuntimeType, resumeTaskKey)
      : null;
    const sessionCodec = getAgentRuntimeSessionCodec(agent.agentRuntimeType);
    const sessionOverride = buildExplicitResumeSessionOverride({
      resumeFromRunId,
      resumeRunSessionIdBefore: resumeRun.sessionIdBefore,
      resumeRunSessionIdAfter: resumeRun.sessionIdAfter,
      taskSession: resumeTaskSession,
      sessionCodec,
    });
    if (!sessionOverride) return null;

    return {
      resumeFromRunId,
      taskKey: resumeTaskKey,
      issueId: readNonEmptyString(resumeContext.issueId),
      taskId: readNonEmptyString(resumeContext.taskId) ?? readNonEmptyString(resumeContext.issueId),
      sessionDisplayId: sessionOverride.sessionDisplayId,
      sessionParams: sessionOverride.sessionParams,
    };
  }

  async function upsertTaskSession(input: {
    orgId: string;
    agentId: string;
    agentRuntimeType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    const existing = await getTaskSession(
      input.orgId,
      input.agentId,
      input.agentRuntimeType,
      input.taskKey,
    );
    if (existing) {
      return db
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    return db
      .insert(agentTaskSessions)
      .values({
        orgId: input.orgId,
        agentId: input.agentId,
        agentRuntimeType: input.agentRuntimeType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearTaskSessions(
    orgId: string,
    agentId: string,
    opts?: { taskKey?: string | null; agentRuntimeType?: string | null },
  ) {
    const conditions = [
      eq(agentTaskSessions.orgId, orgId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) {
      conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
    }
    if (opts?.agentRuntimeType) {
      conditions.push(eq(agentTaskSessions.agentRuntimeType, opts.agentRuntimeType));
    }

    return db
      .delete(agentTaskSessions)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows.length);
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;

    const now = new Date();
    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        orgId: agent.orgId,
        agentRuntimeType: agent.agentRuntimeType,
        stateJson: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agentRuntimeState.agentId,
        set: {
          orgId: agent.orgId,
          agentRuntimeType: agent.agentRuntimeType,
          updatedAt: now,
        },
      })
      .returning()
      .then((rows) => rows[0]);
  }

  function buildHeartbeatObservabilityContext(
    run: typeof heartbeatRuns.$inferSelect,
    overrides: Partial<ExecutionObservabilityContext> = {},
  ): ExecutionObservabilityContext {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const issueSnapshot = parseObject(contextSnapshot.issue);
    const benchmarkMetadata =
      extractCreateAgentBenchmarkMetadata(readNonEmptyString(issueSnapshot.description))
      ?? coerceCreateAgentBenchmarkMetadata(parseObject(contextSnapshot.benchmark));
    const baseMetadata = {
      wakeupRequestId: run.wakeupRequestId,
      errorCode: run.errorCode,
      retryOfRunId: run.retryOfRunId,
      processLossRetryCount: run.processLossRetryCount,
      externalRunId: run.externalRunId,
      executionWorkspaceId: readNonEmptyString(contextSnapshot.executionWorkspaceId),
      ...(benchmarkMetadata ?? {}),
    };
    const benchmarkTags = benchmarkMetadata ? buildCreateAgentBenchmarkTags(benchmarkMetadata) : [];

    return {
      surface: resolveHeartbeatObservabilitySurface(contextSnapshot),
      rootExecutionId: run.id,
      orgId: run.orgId,
      agentId: run.agentId,
      issueId: readNonEmptyString(contextSnapshot.issueId),
      sessionKey:
        run.sessionIdAfter ??
        run.sessionIdBefore ??
        readNonEmptyString(contextSnapshot.sessionKey) ??
        readNonEmptyString(contextSnapshot.taskKey),
      runtime: readNonEmptyString(contextSnapshot.agentRuntimeType),
      trigger: run.triggerDetail ?? run.invocationSource,
      status: run.status,
      metadata: {
        ...baseMetadata,
        ...(overrides.metadata ?? {}),
      },
      tags: [...benchmarkTags, ...(overrides.tags ?? [])],
      ...overrides,
    };
  }

  async function emitHeartbeatObservationEvent(
    run: typeof heartbeatRuns.$inferSelect,
    input: Parameters<typeof observeExecutionEvent>[1],
    overrides: Partial<ExecutionObservabilityContext> = {},
  ) {
    try {
      await observeExecutionEvent(buildHeartbeatObservabilityContext(run, overrides), input);
    } catch (error) {
      logger.warn(
        {
          runId: run.id,
          eventName: input.name,
          err: error instanceof Error ? error.message : String(error),
        },
        "Failed to emit Langfuse heartbeat event",
      );
    }
  }

  async function emitHeartbeatLiveEval(runId: string) {
    try {
      const { detail, scores } = await buildObservedRunLangfuseScores(db, runId);
      await createExecutionScores(
        buildHeartbeatObservabilityContext(detail.run, {
          runtime: detail.bundle.agentRuntimeType,
          metadata: {
            agentName: detail.agentName,
            orgName: detail.orgName,
          },
        }),
        scores.map((score) => ({
          rootExecutionId: detail.run.id,
          name: score.name,
          value: score.value,
          comment: score.comment,
          metadata: score.metadata,
        })),
      );
    } catch (error) {
      logger.warn(
        {
          runId,
          err: error instanceof Error ? error.message : String(error),
        },
        "Failed to emit Langfuse heartbeat scores",
      );
    }
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        orgId: updated.orgId,
        type: "heartbeat.run.status",
        payload: {
          runId: updated.id,
          agentId: updated.agentId,
          status: updated.status,
          invocationSource: updated.invocationSource,
          triggerDetail: updated.triggerDetail,
          error: updated.error ?? null,
          errorCode: updated.errorCode ?? null,
          startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
          finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
        },
      });

      await emitHeartbeatObservationEvent(
        updated,
        {
          name: `heartbeat.status.${status}`,
          asType: "event",
          output: {
            status: updated.status,
            error: updated.error,
            errorCode: updated.errorCode,
            startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
            finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
          },
        },
        {
          status: updated.status,
        },
      );
    }

    return updated;
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
  }

  async function updateWakeupRequestRecord(
    tx: any,
    wakeupRequestId: string,
    patch: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    return tx
      .update(agentWakeupRequests)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .returning()
      .then((rows: Array<typeof agentWakeupRequests.$inferSelect>) => rows[0] ?? null);
  }

  async function insertWakeupRequestRecord(
    tx: any,
    values: typeof agentWakeupRequests.$inferInsert,
  ) {
    return tx
      .insert(agentWakeupRequests)
      .values(values)
      .returning()
      .then((rows: Array<typeof agentWakeupRequests.$inferSelect>) => rows[0] ?? null);
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const sanitizedMessage = event.message
      ? redactCurrentUserText(event.message, currentUserRedactionOptions)
      : event.message;
    const sanitizedPayload = event.payload
      ? redactCurrentUserValue(event.payload, currentUserRedactionOptions)
      : event.payload;

    await db.insert(heartbeatRunEvents).values({
      orgId: run.orgId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: sanitizedMessage,
      payload: sanitizedPayload,
    });

    publishLiveEvent({
      orgId: run.orgId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: sanitizedMessage ?? null,
        payload: sanitizedPayload ?? null,
      },
    });

    await emitHeartbeatObservationEvent(
      run,
      {
        name: `heartbeat.event.${event.eventType}`,
        asType: "event",
        level: event.level === "error" ? "ERROR" : event.level === "warn" ? "WARNING" : "DEFAULT",
        output: {
          seq,
          eventType: event.eventType,
          stream: event.stream ?? null,
          level: event.level ?? null,
          color: event.color ?? null,
          message: sanitizedMessage ?? null,
        },
        metadata: sanitizedPayload ?? undefined,
      },
      {
        status: run.status,
      },
    );
  }

  async function nextRunEventSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

  async function persistRunProcessMetadata(
    runId: string,
    meta: { pid: number; startedAt: string },
  ) {
    const startedAt = new Date(meta.startedAt);
    const updated = await db
      .update(heartbeatRuns)
      .set({
        processPid: meta.pid,
        processStartedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      await emitHeartbeatObservationEvent(updated, {
        name: "heartbeat.process.spawn",
        asType: "event",
        output: {
          pid: meta.pid,
          startedAt: meta.startedAt,
        },
      });
    }

    return updated;
  }

  async function clearDetachedRunWarning(runId: string) {
    const updated = await db
      .update(heartbeatRuns)
      .set({
        error: null,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.errorCode, DETACHED_PROCESS_ERROR_CODE)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;

    await appendRunEvent(updated, await nextRunEventSeq(updated.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Detached child process reported activity; cleared detached warning",
    });
    return updated;
  }

  async function countRunningRunsForAgent(agentId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
    return Number(count ?? 0);
  }

  async function claimQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    if (run.status !== "queued") return run;
    let wakeup: {
      requestedAt: Date;
      reason: string | null;
      payload: unknown;
    } | null = null;
    if (run.wakeupRequestId) {
      wakeup = await db
        .select({
          requestedAt: agentWakeupRequests.requestedAt,
          reason: agentWakeupRequests.reason,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, run.wakeupRequestId))
        .then((rows) => rows[0] ?? null);
      if (wakeup && new Date(wakeup.requestedAt).getTime() > Date.now()) {
        return null;
      }
    }

    async function cancelQueuedRunDuringClaim(reason: string) {
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
      await finalizeAgentStatus(run.agentId, "cancelled");
      return null;
    }

    const agent = await getAgent(run.agentId);
    if (!agent) {
      return await cancelQueuedRunDuringClaim("Cancelled because the agent no longer exists");
    }
    if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
      return await cancelQueuedRunDuringClaim("Cancelled because the agent is not invokable");
    }

    const context = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(context.issueId);
    if (issueId) {
      const issue = await db
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.orgId, run.orgId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) {
        return await cancelQueuedRunDuringClaim("Cancelled because the linked issue no longer exists");
      }
      if ((issue.status === "done" || issue.status === "cancelled") && !isIssueCommentMentionWake({
        reason: readNonEmptyString(context.wakeReason) ?? readNonEmptyString(wakeup?.reason),
        contextSnapshot: context,
        payload: wakeup?.payload,
      })) {
        return await cancelQueuedRunDuringClaim("Cancelled because the linked issue is no longer actionable");
      }
    }
    const budgetBlock = await budgets.getInvocationBlock(run.orgId, run.agentId, {
      issueId,
      projectId: readNonEmptyString(context.projectId),
    });
    if (budgetBlock) {
      return await cancelQueuedRunDuringClaim(budgetBlock.reason);
    }

    const claimedAt = new Date();
    const claimed = await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? claimedAt,
        updatedAt: claimedAt,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    publishLiveEvent({
      orgId: claimed.orgId,
      type: "heartbeat.run.status",
      payload: {
        runId: claimed.id,
        agentId: claimed.agentId,
        status: claimed.status,
        invocationSource: claimed.invocationSource,
        triggerDetail: claimed.triggerDetail,
        error: claimed.error ?? null,
        errorCode: claimed.errorCode ?? null,
        startedAt: claimed.startedAt ? new Date(claimed.startedAt).toISOString() : null,
        finishedAt: claimed.finishedAt ? new Date(claimed.finishedAt).toISOString() : null,
      },
    });

    await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
    return claimed;
  }

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }

    const runningCount = await countRunningRunsForAgent(agentId);
    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" || outcome === "cancelled"
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
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

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const now = new Date();

    // Find all runs stuck in "running" state (queued runs are legitimately waiting; resumeQueuedRuns handles them)
    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        agentRuntimeType: agents.agentRuntimeType,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.status, "running"));

    const reaped: string[] = [];

    for (const { run, agentRuntimeType } of activeRuns) {
      if (runningProcesses.has(run.id) || activeRunExecutions.has(run.id)) continue;

      // Apply staleness threshold to avoid false positives
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      const tracksLocalChild = isTrackedLocalChildProcessAdapter(agentRuntimeType);
      let detachedTerminationMessage: string | null = null;
      if (tracksLocalChild && run.processPid && isProcessAlive(run.processPid)) {
        const termination = await terminateOrphanedProcess(run.processPid);
        if (termination.stillAlive) {
          const detachedMessage = termination.error
            ? `Lost in-memory process handle, child pid ${run.processPid} is still alive, and Rudder could not terminate it: ${termination.error}`
            : `Lost in-memory process handle, but child pid ${run.processPid} is still alive`;
          const detachedRun = await setRunStatus(run.id, "running", {
            error: detachedMessage,
            errorCode: DETACHED_PROCESS_ERROR_CODE,
          });
          if (detachedRun) {
            await appendRunEvent(detachedRun, await nextRunEventSeq(detachedRun.id), {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: detachedMessage,
              payload: {
                processPid: run.processPid,
              },
            });
          }
          continue;
        }
        detachedTerminationMessage = termination.terminationSignal
          ? `Terminated detached child pid ${run.processPid} with ${termination.terminationSignal} after Rudder lost its process handle`
          : `Detached child pid ${run.processPid} exited before Rudder could terminate it`;
      }

      const shouldRetry = tracksLocalChild && !!run.processPid && (run.processLossRetryCount ?? 0) < 1;
      const baseMessage = run.processPid
        ? `Process lost -- child pid ${run.processPid} is no longer running`
        : "Process lost -- server may have restarted";

      let finalizedRun = await setRunStatus(run.id, "failed", {
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
        errorCode: "process_lost",
        finishedAt: now,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
      });
      if (!finalizedRun) finalizedRun = await getRun(run.id);
      if (!finalizedRun) continue;

      if (detachedTerminationMessage) {
        await appendRunEvent(finalizedRun, await nextRunEventSeq(finalizedRun.id), {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: detachedTerminationMessage,
          payload: {
            ...(run.processPid ? { processPid: run.processPid } : {}),
          },
        });
      }

      let retriedRun: typeof heartbeatRuns.$inferSelect | null = null;
      if (shouldRetry) {
        const agent = await getAgent(run.agentId);
        if (agent) {
          retriedRun = await enqueueProcessLossRetry(finalizedRun, agent, now);
        }
      } else {
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      await appendRunEvent(finalizedRun, await nextRunEventSeq(finalizedRun.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: shouldRetry
          ? `${baseMessage}; queued retry ${retriedRun?.id ?? ""}`.trim()
          : baseMessage,
        payload: {
          ...(run.processPid ? { processPid: run.processPid } : {}),
          ...(retriedRun ? { retryRunId: retriedRun.id } : {}),
        },
      });

      await finalizeAgentStatus(run.agentId, "failed");
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
      reaped.push(run.id);
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  async function reapInactiveRuns(opts?: { maxInactivityMs?: number; now?: Date }) {
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
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .leftJoin(heartbeatRunEvents, eq(heartbeatRunEvents.runId, heartbeatRuns.id))
      .where(eq(heartbeatRuns.status, "running"))
      .groupBy(heartbeatRuns.id, agents.agentRuntimeType);

    const timedOut: string[] = [];

    for (const { run, agentRuntimeType, lastEventAt } of activeRuns) {
      const activityTimes = [
        run.updatedAt,
        lastEventAt,
        run.processStartedAt,
        run.startedAt,
        run.createdAt,
      ]
        .map((value) => value ? new Date(value).getTime() : null)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const lastActivityMs = activityTimes.length > 0 ? Math.max(...activityTimes) : null;
      if (!lastActivityMs) continue;

      const inactiveMs = now.getTime() - lastActivityMs;
      if (inactiveMs < maxInactivityMs) continue;

      const message = `Run had no recorded activity for ${formatDurationMs(maxInactivityMs)}`;
      const running = runningProcesses.get(run.id);
      if (running) {
        const pid = running.child.pid;
        running.child.kill("SIGTERM");
        const graceMs = Math.max(1, running.graceSec) * 1000;
        setTimeout(() => {
          if (typeof pid === "number" && isProcessAlive(pid)) {
            running.child.kill("SIGKILL");
          }
        }, graceMs);
      } else if (isTrackedLocalChildProcessAdapter(agentRuntimeType) && run.processPid && isProcessAlive(run.processPid)) {
        await terminateOrphanedProcess(run.processPid);
      }

      const finalizedRun = await setRunStatus(run.id, "timed_out", {
        finishedAt: now,
        error: message,
        errorCode: "inactivity_timeout",
      });
      await setWakeupStatus(run.wakeupRequestId, "timed_out", {
        finishedAt: now,
        error: message,
      });

      const terminalRun = finalizedRun ?? await getRun(run.id);
      if (!terminalRun) continue;

      await appendRunEvent(terminalRun, await nextRunEventSeq(terminalRun.id), {
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
      await releaseIssueExecutionAndPromote(terminalRun);
      await emitHeartbeatLiveEval(terminalRun.id);
      await finalizeAgentStatus(run.agentId, "timed_out");
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
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

  async function reapTimedOutRuns(opts?: { maxRuntimeMs?: number; now?: Date }) {
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
      .where(eq(heartbeatRuns.status, "running"));

    const timedOut: string[] = [];

    for (const { run, agentRuntimeType } of activeRuns) {
      const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : null;
      if (!startedAt || !Number.isFinite(startedAt)) continue;

      const runtimeMs = now.getTime() - startedAt;
      if (runtimeMs < maxRuntimeMs) continue;

      const message = `Run exceeded maximum duration of ${formatDurationMs(maxRuntimeMs)}`;
      const running = runningProcesses.get(run.id);
      if (running) {
        const pid = running.child.pid;
        running.child.kill("SIGTERM");
        const graceMs = Math.max(1, running.graceSec) * 1000;
        setTimeout(() => {
          if (typeof pid === "number" && isProcessAlive(pid)) {
            running.child.kill("SIGKILL");
          }
        }, graceMs);
      } else if (isTrackedLocalChildProcessAdapter(agentRuntimeType) && run.processPid && isProcessAlive(run.processPid)) {
        await terminateOrphanedProcess(run.processPid);
      }

      const finalizedRun = await setRunStatus(run.id, "timed_out", {
        finishedAt: now,
        error: message,
        errorCode: "timeout",
      });
      await setWakeupStatus(run.wakeupRequestId, "timed_out", {
        finishedAt: now,
        error: message,
      });

      const terminalRun = finalizedRun ?? await getRun(run.id);
      if (!terminalRun) continue;

      await appendRunEvent(terminalRun, await nextRunEventSeq(terminalRun.id), {
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
      await releaseIssueExecutionAndPromote(terminalRun);
      await emitHeartbeatLiveEval(terminalRun.id);
      await finalizeAgentStatus(run.agentId, "timed_out");
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
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

  async function resumeQueuedRuns() {
    const queuedRuns = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"));

    const agentIds = [...new Set(queuedRuns.map((r) => r.agentId))];
    for (const agentId of agentIds) {
      await startNextQueuedRunForAgent(agentId);
    }
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AgentRuntimeExecutionResult,
    session: { legacySessionId: string | null },
    normalizedUsage?: UsageTotals | null,
  ) {
    await ensureRuntimeState(agent);
    const usage = normalizedUsage ?? normalizeUsageTotals(result.usage);
    const rawInputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const billingType = normalizeLedgerBillingType(result.billingType);
    const additionalCostCents = normalizeBilledCostCents(result.costUsd, billingType);
    const hasTokenUsage = rawInputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
    const provider = result.provider ?? "unknown";
    const tokenSummary = summarizeTokenUsage({
      provider,
      inputTokens: rawInputTokens,
      cachedInputTokens,
      outputTokens,
    });
    const biller = resolveLedgerBiller(result);
    const ledgerScope = await resolveLedgerScopeForRun(db, agent.orgId, run);

    await db
      .update(agentRuntimeState)
      .set({
        agentRuntimeType: agent.agentRuntimeType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: result.errorMessage ?? null,
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${tokenSummary.promptTokens}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

    if (additionalCostCents > 0 || hasTokenUsage) {
      const costs = costService(db, budgetHooks);
      await costs.createEvent(agent.orgId, {
        heartbeatRunId: run.id,
        agentId: agent.id,
        issueId: ledgerScope.issueId,
        projectId: ledgerScope.projectId,
        provider,
        biller,
        billingType,
        model: result.model ?? "unknown",
        inputTokens: rawInputTokens,
        cachedInputTokens,
        outputTokens,
        costCents: additionalCostCents,
        occurredAt: new Date(),
      });
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
        return [];
      }
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
      if (availableSlots <= 0) return [];

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "queued"),
            sql`(
              ${heartbeatRuns.wakeupRequestId} is null
              or exists (
                select 1
                from ${agentWakeupRequests}
                where ${agentWakeupRequests.id} = ${heartbeatRuns.wakeupRequestId}
                  and ${agentWakeupRequests.requestedAt} <= now()
              )
            )`,
          ),
        )
        .orderBy(asc(heartbeatRuns.createdAt))
        .limit(availableSlots);
      if (queuedRuns.length === 0) return [];

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of queuedRuns) {
        const claimed = await claimQueuedRun(queuedRun);
        if (claimed) claimedRuns.push(claimed);
      }
      if (claimedRuns.length === 0) return [];

      for (const claimedRun of claimedRuns) {
        void executeRun(claimedRun.id).catch((err) => {
          logger.error({ err, runId: claimedRun.id }, "queued heartbeat execution failed");
        });
      }
      return claimedRuns;
    });
  }


  const baseContext = {
    db, instanceSettings, getCurrentUserRedactionOptions, runLogStore, runContextSvc, issuesSvc, executionWorkspacesSvc, workspaceOperationsSvc, activeRunExecutions, budgetHooks, budgets,
    getAgent, getRun, getRuntimeState, getTaskSession, getLatestRunForSession, getOldestRunForSession, resolveNormalizedUsageForSession, evaluateSessionCompaction, resolveSessionBeforeForWakeup, resolveExplicitResumeSessionOverride, upsertTaskSession, clearTaskSessions, ensureRuntimeState, buildHeartbeatObservabilityContext, emitHeartbeatObservationEvent, emitHeartbeatLiveEval, setRunStatus, setWakeupStatus, updateWakeupRequestRecord, insertWakeupRequestRecord, appendRunEvent, nextRunEventSeq, persistRunProcessMetadata, clearDetachedRunWarning, countRunningRunsForAgent, claimQueuedRun, finalizeAgentStatus, reapOrphanedRuns, reapInactiveRuns, reapTimedOutRuns, resumeQueuedRuns, updateRuntimeState, startNextQueuedRunForAgent,
  } as any;
  const recoveryHandlers = createHeartbeatRecoveryHandlers({ ...baseContext, startNextQueuedRunForAgent });
  const wakeupHandlers = createHeartbeatWakeupHandlers({ ...baseContext, ...recoveryHandlers, startNextQueuedRunForAgent });
  const releaseHandlers = createHeartbeatReleaseHandlers({ ...baseContext, ...recoveryHandlers, ...wakeupHandlers });
  const executeHandlers = createHeartbeatExecuteHandlers({ ...baseContext, ...recoveryHandlers, ...releaseHandlers, ...wakeupHandlers });
  const miscHandlers = createHeartbeatMiscHandlers({ ...baseContext, ...recoveryHandlers, ...releaseHandlers, ...wakeupHandlers, ...executeHandlers });
  const { enqueueRecoveryRun, enqueueProcessLossRetry, evaluatePassiveIssueClosureForLockedIssue, parseHeartbeatPolicy } = recoveryHandlers;
  const { enqueueWakeup } = wakeupHandlers;
  const { releaseIssueExecutionAndPromote } = releaseHandlers;
  const { executeRun } = executeHandlers;
  const { resumeDeferredWakeupsForAgent, listProjectScopedRunIds, listProjectScopedWakeupIds, cancelPendingWakeupsForBudgetScope, cancelRunInternal, cancelActiveForAgentInternal, cancelBudgetScopeWork, retryRunInternal, buildSkillAnalytics } = miscHandlers;
  return {
    list: async (orgId: string, agentId?: string, limit?: number) => {
      const query = db
        .select(heartbeatRunListColumns)
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.orgId, orgId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.orgId, orgId),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      const rows = limit ? await query.limit(limit) : await query;
      const runIds = rows.map((row) => row.id);
      const usedSkillsByRun = new Map<string, Map<string, { key: string; label: string }>>();
      if (agentId && runIds.length > 0) {
        const skillEvents = await db
          .select({
            runId: heartbeatRunEvents.runId,
            payload: heartbeatRunEvents.payload,
          })
          .from(heartbeatRunEvents)
          .where(
            and(
              eq(heartbeatRunEvents.orgId, orgId),
              inArray(heartbeatRunEvents.runId, runIds),
              inArray(heartbeatRunEvents.eventType, ["adapter.invoke", "adapter.skill_usage"]),
            ),
          )
          .orderBy(asc(heartbeatRunEvents.createdAt), asc(heartbeatRunEvents.id));

        for (const event of skillEvents) {
          const evidence = readSkillEvidenceFromPayload(parseObject(event.payload));
          if (evidence.evidence !== "used" || evidence.skills.length === 0) continue;
          const runSkills = usedSkillsByRun.get(event.runId) ?? new Map<string, { key: string; label: string }>();
          for (const skill of evidence.skills) {
            const existing = runSkills.get(skill.key);
            if (existing) {
              if (existing.label === fallbackSkillLabel(existing.key) && skill.label !== fallbackSkillLabel(skill.key)) {
                existing.label = skill.label;
              }
            } else {
              runSkills.set(skill.key, skill);
            }
          }
          if (runSkills.size > 0) usedSkillsByRun.set(event.runId, runSkills);
        }
      }

      return rows.map((row) => ({
        ...row,
        resultJson: (() => {
          const summary = summarizeHeartbeatRunResultJson(row.resultJson);
          const usedSkills = Array.from(usedSkillsByRun.get(row.id)?.values() ?? []);
          if (usedSkills.length === 0) return summary;
          const skillPayload = usedSkills.map((skill) => ({
            key: skill.key,
            runtimeName: skill.label,
            name: skill.label,
          }));
          return {
            ...(summary ?? {}),
            usedSkillCount: usedSkills.length,
            usedSkillKeys: usedSkills.map((skill) => skill.key),
            usedSkills: skillPayload,
            skillEvidenceType: "used",
            skillEvidenceCount: usedSkills.length,
            skillEvidenceKeys: usedSkills.map((skill) => skill.key),
            skillEvidenceSkills: skillPayload,
          };
        })(),
      }));
    },

    getAgentSkillAnalytics: async (
      agentId: string,
      opts?: { windowDays?: number; now?: Date; startDate?: string; endDate?: string },
    ): Promise<AgentSkillAnalytics> => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      return buildSkillAnalytics({ orgId: agent.orgId, agentId: agent.id }, opts);
    },

    getOrganizationSkillAnalytics: async (
      orgId: string,
      opts?: { windowDays?: number; now?: Date; startDate?: string; endDate?: string },
    ): Promise<AgentSkillAnalytics> => {
      const org = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!org) throw notFound("Organization not found");
      return buildSkillAnalytics({ orgId }, opts);
    },

    getRun,

    getRuntimeState: async (agentId: string) => {
      const state = await getRuntimeState(agentId);
      const agent = await getAgent(agentId);
      if (!agent) return null;
      const ensured = state ?? (await ensureRuntimeState(agent));
      const latestTaskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.orgId, agent.orgId), eq(agentTaskSessions.agentId, agent.id)))
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        ...ensured,
        sessionDisplayId: latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
        sessionParamsJson: latestTaskSession?.sessionParamsJson ?? null,
      };
    },

    listTaskSessions: async (agentId: string) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.orgId, agent.orgId), eq(agentTaskSessions.agentId, agentId)))
        .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt));
    },

    resetRuntimeSession: async (agentId: string, opts?: { taskKey?: string | null }) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      await ensureRuntimeState(agent);
      const taskKey = readNonEmptyString(opts?.taskKey);
      const clearedTaskSessions = await clearTaskSessions(
        agent.orgId,
        agent.id,
        taskKey ? { taskKey, agentRuntimeType: agent.agentRuntimeType } : undefined,
      );
      const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
        sessionId: null,
        lastError: null,
        updatedAt: new Date(),
      };
      if (!taskKey) {
        runtimePatch.stateJson = {};
      }

      const updated = await db
        .update(agentRuntimeState)
        .set(runtimePatch)
        .where(eq(agentRuntimeState.agentId, agentId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return {
        ...updated,
        sessionDisplayId: null,
        sessionParamsJson: null,
        clearedTaskSessions,
      };
    },

    listEvents: (runId: string, afterSeq = 0, limit = 200) =>
      db
        .select()
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq)))
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(Math.max(1, Math.min(limit, 1000))),

    readLog: async (runId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (!run.logStore || !run.logRef) throw notFound("Run log not found");

      const result = await runLogStore.read(
        {
          store: run.logStore as "local_file",
          logRef: run.logRef,
        },
        opts,
      );

      return {
        runId,
        store: run.logStore,
        logRef: run.logRef,
        ...result,
        content: redactCurrentUserText(result.content, await getCurrentUserRedactionOptions()),
      };
    },

    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "review" | "on_demand" | "automation" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: "manual" | "ping" | "callback" | "system" = "manual",
      actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
    ) =>
      enqueueWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),

    wakeup: enqueueWakeup,
    resumeDeferredWakeupsForAgent,

    retryRun: retryRunInternal,

    reportRunActivity: clearDetachedRunWarning,

    reapOrphanedRuns,

    reapInactiveRuns,

    reapTimedOutRuns,

    resumeQueuedRuns,

    tickTimers: async (now = new Date()) => {
      const allAgents = await db.select().from(agents);
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      for (const agent of allAgents) {
        if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        checked += 1;
        const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
        const elapsedMs = now.getTime() - baseline;
        if (elapsedMs < policy.intervalSec * 1000) continue;

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason: "interval_elapsed",
            now: now.toISOString(),
          },
        });
        if (run) enqueued += 1;
        else skipped += 1;
      }

      return { checked, enqueued, skipped };
    },

    cancelRun: (runId: string) => cancelRunInternal(runId),

    cancelActiveForAgent: (agentId: string) => cancelActiveForAgentInternal(agentId),

    cancelBudgetScopeWork,

    getActiveRunForAgent: async (agentId: string) => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}
