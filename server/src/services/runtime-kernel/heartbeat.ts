import {
  hasSessionCompactionThresholds
} from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  agentRuntimeState,
  agents,
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  organizations
} from "@rudderhq/db";
import type { AgentSkillAnalytics, HeartbeatRun } from "@rudderhq/shared";
import {
  summarizeTokenUsage,
  toHeartbeatRun
} from "@rudderhq/shared";
import { and, asc, desc, eq, gt, gte, inArray, lte, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type {
  AgentRuntimeExecutionResult
} from "../../agent-runtimes/index.js";
import { runningProcesses } from "../../agent-runtimes/index.js";
import { killChildProcessTree, parseObject } from "../../agent-runtimes/utils.js";
import { notFound } from "../../errors.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../../log-redaction.js";
import { logger } from "../../middleware/logger.js";
import {
  agentRunContextService
} from "../agent-run-context.js";
import { publishAutomationRunOutputToChat } from "../automation-chat-output.js";
import { budgetService, type BudgetEnforcementScope } from "../budgets.js";
import { costService } from "../costs.js";
import { runWorkspaceService } from "../execution-workspaces.js";
import { summarizeHeartbeatRunResultJson } from "../heartbeat-run-summary.js";
import { instanceSettingsService } from "../instance-settings.js";
import { issueService } from "../issues.js";
import { publishLiveEvent } from "../live-events.js";
import { ISSUE_EXECUTION_RELEASED_EVENT_TYPE } from "../operator-event-visibility.js";
import { recordProductAnalyticsEvent } from "../product-analytics.js";
import { appendHeartbeatRunEvent } from "../run-events.js";
import { getRunLogStore } from "../run-log-store.js";
import { workspaceOperationService } from "../workspace-operations.js";

export { prioritizeProjectWorkspaceCandidatesForRun, type ResolvedWorkspaceForRun } from "../agent-run-context.js";

import type { SessionCompactionDecision, UsageTotals } from "./heartbeat.core.js";
import * as heartbeatCore from "./heartbeat.core.js";
import * as heartbeatSessions from "./heartbeat.sessions.js";
const { MAX_LIVE_LOG_CHUNK_BYTES, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, DEFERRED_WAKE_CONTEXT_KEY, DETACHED_PROCESS_ERROR_CODE, ORPHANED_PROCESS_TERMINATION_GRACE_MS, ORPHANED_PROCESS_KILL_WAIT_MS, ORPHANED_PROCESS_POLL_INTERVAL_MS, startLocksByAgent, MAX_RECOVERY_CHAIN_DEPTH, ISSUE_PASSIVE_FOLLOWUP_REASON, ISSUE_PASSIVE_FOLLOWUP_WAKE_SOURCE, ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON, ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS, ISSUE_REVIEW_CLOSEOUT_REASON, ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON, ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS, ISSUE_PASSIVE_FOLLOWUP_COOLDOWN_MS_BY_ATTEMPT, ISSUE_PASSIVE_FOLLOWUP_TIMER_CONTINUITY_MAX_WINDOW_MS, SESSIONED_LOCAL_ADAPTERS, heartbeatRunListColumns, appendExcerpt, appendTranscriptEntriesFromChunk, normalizeMaxConcurrentRuns, withAgentStartLock, readNonEmptyString, isIssueCommentMentionWake, buildHeartbeatAdapterInvokePayload, buildRecentDateKeys, buildDateKeysBetween, fallbackSkillLabel, normalizeLoadedSkill, normalizeLoadedSkillForPayload, emptySkillEvidenceCounts, incrementSkillEvidenceCount, strongestSkillEvidence, resolveSkillEvidence, readSkillEvidenceFromPayload, extractSkillSlugFromPath, collectSkillPathsFromText, collectStringValues, normalizeSkillUseFromPath, dedupeSkillUses, collectSkillUsesFromText, readToolCommandInput, isCommandTranscriptTool, isReadTranscriptTool, inferUsedSkillsFromTranscript, normalizeSkillCandidate, addSkillCandidate, readSkillReferenceSlug, collectSkillReferences, inferUsedSkillsFromPrompt, normalizeLedgerBillingType, resolveLedgerBiller, normalizeBilledCostCents, resolveLedgerScopeForRun } = heartbeatCore;
const { buildExplicitResumeSessionOverride, normalizeUsageTotals, readRawUsageTotals, deriveNormalizedUsageDelta, formatCount, parseSessionCompactionPolicy, resolveRuntimeSessionParamsForWorkspace, parseIssueAssigneeAgentRuntimeOverrides, deriveTaskKey, shouldResetTaskSessionForWake, formatRuntimeWorkspaceWarningLog, describeSessionResetReason, deriveCommentId, enrichWakeContextSnapshot, mergeCoalescedContextSnapshot, issueCommentAuthorKind, issueCommentAuthorLabel, buildDeferredWakePayload, readDeferredWakeContext, readDeferredWakePayload, deriveDeferredWakeTaskKey, hydrateWakeContextSnapshot, firstNonEmptyLine, deriveRecoveryFailureKind, deriveRecoveryFailureSummary, mergeMissingRecoveryContextFields, hydrateRecoveryBaseContextSnapshot, buildRecoveryContextSnapshot, normalizePassiveFollowupContext, normalizeReviewCloseoutContext, passiveFollowupCooldownMs, issueHasReviewer, isAgentEligibleForTimerContinuation, hasCredibleTimerContinuation, buildPassiveFollowupContextSnapshot, runTaskKey, isSameTaskScope, isTrackedLocalChildProcessAdapter, isProcessAlive, waitForProcessExit, terminateOrphanedProcess, truncateDisplayId, normalizeAgentNameKey, defaultSessionCodec, getAgentRuntimeSessionCodec, normalizeSessionParams, resolveNextSessionState } = heartbeatSessions;

import { createHeartbeatExecuteHandlers } from "./heartbeat.execute.js";
import { createHeartbeatMiscHandlers } from "./heartbeat.misc.js";
import { createHeartbeatRecoveryHandlers } from "./heartbeat.recovery.js";
import { createHeartbeatReleaseHandlers } from "./heartbeat.release.js";
import {
  checkpointHeartbeatRunTerminalEffect,
  claimExpiredHeartbeatRunExecution,
  claimHeartbeatRunTerminalEffects,
  completeHeartbeatRunTerminalEffects,
  failHeartbeatRunTerminalEffect,
  markHeartbeatRunProcessExited,
  reconcileHeartbeatRunEvidence,
  reconcileHeartbeatRunTerminalEffectsIntent,
  releaseHeartbeatRunTerminalEffectsClaim,
  renewHeartbeatRunExecutionLease,
  renewHeartbeatRunTerminalEffectsClaim,
  RUN_EXECUTION_LEASE_MS,
  setWakeupStatusMonotonic,
  terminalEffectNames,
  transitionHeartbeatRunToTerminal,
  type RunActivityWatermark,
  type TerminalEffectIntent,
  type TerminalEffectName,
} from "./heartbeat.terminal.js";
import { createHeartbeatWakeupHandlers } from "./heartbeat.wakeup.js";

const DEFAULT_HEARTBEAT_RUN_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const DEFAULT_HEARTBEAT_RUN_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const TERMINAL_EFFECT_CLAIM_RENEW_INTERVAL_MS = 60_000;

// heartbeatService is instantiated by routes and the scheduler. Execution
// ownership must therefore be shared across every service instance in this
// server process.
const activeRunExecutions = new Set<string>();
const runAbortControllers = new Map<string, AbortController>();

function formatDurationMs(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function heartbeatService(
  db: Db,
  testHooks?: {
    afterIssuePromotionCommitted?: (outcome: unknown) => Promise<void> | void;
  },
) {
  const instanceSettings = instanceSettingsService(db);
  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  const runLogStore = getRunLogStore();
  const runContextSvc = agentRunContextService(db);
  const issuesSvc = issueService(db);
  const executionWorkspacesSvc = runWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
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

    return null;
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
        sessionParamsBeforeJson: heartbeatRuns.sessionParamsBeforeJson,
        sessionParamsAfterJson: heartbeatRuns.sessionParamsAfterJson,
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
    const persistedSessionSuppression = heartbeatSessions.readSessionReuseSuppression(resumeContext);
    const resumeRunHasSessionAfter =
      Boolean(readNonEmptyString(resumeRun.sessionIdAfter)) ||
      Boolean(resumeRun.sessionParamsAfterJson && Object.keys(resumeRun.sessionParamsAfterJson).length > 0);
    const sessionOverride = buildExplicitResumeSessionOverride({
      resumeFromRunId,
      resumeRunSessionIdBefore: resumeRun.sessionIdBefore,
      resumeRunSessionIdAfter: resumeRun.sessionIdAfter,
      resumeRunSessionParamsBefore: resumeRun.sessionParamsBeforeJson,
      resumeRunSessionParamsAfter: resumeRun.sessionParamsAfterJson,
      resumeRunSessionCleared:
        resumeRun.sessionIdAfter == null &&
        resumeRun.sessionParamsAfterJson != null &&
        Object.keys(resumeRun.sessionParamsAfterJson).length === 0,
      resumeRunSessionSuppression: resumeRunHasSessionAfter ? null : persistedSessionSuppression,
      resumeContextSessionParams: parseObject(resumeContext.resumeSessionParams),
      resumeContextSessionDisplayId: readNonEmptyString(resumeContext.resumeSessionDisplayId),
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
      sessionCleared: "sessionCleared" in sessionOverride && sessionOverride.sessionCleared === true,
      sessionReuseSuppression:
        "sessionReuseSuppression" in sessionOverride
          ? sessionOverride.sessionReuseSuppression
          : null,
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
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`task-session:${input.orgId}:${input.agentId}:${input.agentRuntimeType}:${input.taskKey}`}))`);
      const existing = await tx
        .select()
        .from(agentTaskSessions)
        .where(and(
          eq(agentTaskSessions.orgId, input.orgId),
          eq(agentTaskSessions.agentId, input.agentId),
          eq(agentTaskSessions.agentRuntimeType, input.agentRuntimeType),
          eq(agentTaskSessions.taskKey, input.taskKey),
        ))
        .then((rows) => rows[0] ?? null);
      if (existing) {
        if (existing.lastRunId && input.lastRunId && existing.lastRunId !== input.lastRunId) {
          const runDates = await tx
            .select({ id: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt })
            .from(heartbeatRuns)
            .where(inArray(heartbeatRuns.id, [existing.lastRunId, input.lastRunId]));
          const existingDate = runDates.find((row) => row.id === existing.lastRunId)?.createdAt;
          const incomingDate = runDates.find((row) => row.id === input.lastRunId)?.createdAt;
          if (
            existingDate
            && incomingDate
            && (
              existingDate.getTime() > incomingDate.getTime()
              || (
                existingDate.getTime() === incomingDate.getTime()
                && existing.lastRunId.localeCompare(input.lastRunId) > 0
              )
            )
          ) {
            return existing;
          }
        }
        return tx
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

      return tx
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
    });
  }

  async function clearTaskSessions(
    orgId: string,
    agentId: string,
    opts?: { taskKey?: string | null; agentRuntimeType?: string | null; sourceRunId?: string | null },
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
    if (opts?.sourceRunId) {
      const sourceRun = await getRun(opts.sourceRunId);
      if (sourceRun) {
        conditions.push(sql`(
          ${agentTaskSessions.lastRunId} is null
          or ${agentTaskSessions.lastRunId} = ${opts.sourceRunId}
          or not exists (
            select 1
            from heartbeat_runs previous_run
            where previous_run.id = ${agentTaskSessions.lastRunId}
              and (
                previous_run.created_at > ${sourceRun.createdAt.toISOString()}::timestamptz
                or (
                  previous_run.created_at = ${sourceRun.createdAt.toISOString()}::timestamptz
                  and previous_run.id > ${sourceRun.id}
                )
              )
          )
        )`);
      }
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

  function publishRunStatus(updated: typeof heartbeatRuns.$inferSelect) {
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
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(status)) {
      throw new Error("Terminal heartbeat run updates must use transitionRunToTerminal");
    }
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) publishRunStatus(updated);

    return updated;
  }

  async function transitionRunToTerminal(
    runId: string,
    status: "succeeded" | "failed" | "cancelled" | "timed_out",
    patch: Partial<typeof heartbeatRuns.$inferInsert>,
    opts?: {
      expectedStatuses?: string[];
      activityWatermark?: RunActivityWatermark;
      terminalEffectsPending?: boolean;
      terminalEffectsIntent?: TerminalEffectIntent | null;
      processExitedAt?: Date | null;
      expectedExecutionOwnerToken?: string | null;
    },
  ) {
    const updated = await transitionHeartbeatRunToTerminal(db, {
      runId,
      status,
      patch,
      expectedStatuses: opts?.expectedStatuses,
      activityWatermark: opts?.activityWatermark,
      terminalEffectsPending: opts?.terminalEffectsPending,
      terminalEffectsIntent: opts?.terminalEffectsIntent,
      processExitedAt: opts?.processExitedAt,
      expectedExecutionOwnerToken: opts?.expectedExecutionOwnerToken,
    });
    if (updated) publishRunStatus(updated);
    return updated;
  }

  async function reconcileRunEvidence(
    runId: string,
    patch: Parameters<typeof reconcileHeartbeatRunEvidence>[2],
  ) {
    return reconcileHeartbeatRunEvidence(db, runId, patch);
  }

  async function reconcileTerminalEffectsIntent(runId: string, intent: TerminalEffectIntent) {
    return reconcileHeartbeatRunTerminalEffectsIntent(db, runId, intent);
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    return setWakeupStatusMonotonic(db, wakeupRequestId, status, patch);
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
    const inserted = await tx
      .insert(agentWakeupRequests)
      .values(values)
      .onConflictDoNothing()
      .returning()
      .then((rows: Array<typeof agentWakeupRequests.$inferSelect>) => rows[0] ?? null);
    if (inserted || !values.idempotencyKey) return inserted;
    return tx
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.orgId, values.orgId),
        eq(agentWakeupRequests.agentId, values.agentId),
        eq(agentWakeupRequests.idempotencyKey, values.idempotencyKey),
      ))
      .then((rows: Array<typeof agentWakeupRequests.$inferSelect>) => rows[0] ?? null);
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
      idempotencyKey?: string | null;
    },
  ) {
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const sanitizedMessage = event.message
      ? redactCurrentUserText(event.message, currentUserRedactionOptions)
      : event.message;
    const sanitizedPayload = event.payload
      ? redactCurrentUserValue(event.payload, currentUserRedactionOptions)
      : event.payload;

    const inserted = await appendHeartbeatRunEvent(db, {
      orgId: run.orgId,
      runId: run.id,
      agentId: run.agentId,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: sanitizedMessage,
      payload: sanitizedPayload,
      idempotencyKey: event.idempotencyKey ?? null,
    });

    publishLiveEvent({
      orgId: run.orgId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq: inserted.seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: sanitizedMessage ?? null,
        payload: sanitizedPayload ?? null,
      },
    });

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
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")))
      .returning()
      .then((rows) => rows[0] ?? null);

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

    await appendRunEvent(updated, {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Detached child process reported activity; cleared detached warning",
    });
    return updated;
  }

  async function terminateRunProcessAndWait(
    run: typeof heartbeatRuns.$inferSelect,
    agentRuntimeType: string,
  ) {
    if (run.processExitedAt) return true;
    runAbortControllers.get(run.id)?.abort();
    const tracked = runningProcesses.get(run.id);
    if (tracked) {
      const pid = tracked.child.pid;
      killChildProcessTree(tracked.child, false);
      if (typeof pid !== "number" || pid <= 0) return true;
      const graceMs = Math.max(1, tracked.graceSec) * 1000;
      if (await waitForProcessExit(pid, graceMs)) return true;
      killChildProcessTree(tracked.child, true);
      return waitForProcessExit(pid, ORPHANED_PROCESS_KILL_WAIT_MS);
    }

    if (isTrackedLocalChildProcessAdapter(agentRuntimeType) && run.processPid && isProcessAlive(run.processPid)) {
      return !(await terminateOrphanedProcess(run.processPid)).stillAlive;
    }
    return !activeRunExecutions.has(run.id);
  }

  async function acknowledgeRunProcessExit(runId: string) {
    return markHeartbeatRunProcessExited(db, runId);
  }

  async function renewRunExecutionLease(runId: string, ownerToken: string) {
    return renewHeartbeatRunExecutionLease(db, runId, ownerToken);
  }

  async function countRunningRunsForAgent(agentId: string, excludeRunId?: string) {
    const pendingExecutionIds = [...activeRunExecutions].filter((runId) => runId !== excludeRunId);
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, agentId),
        or(
          eq(heartbeatRuns.status, "running"),
          eq(heartbeatRuns.terminalEffectsPending, true),
          ...(pendingExecutionIds.length > 0 ? [inArray(heartbeatRuns.id, pendingExecutionIds)] : []),
        ),
        ...(excludeRunId ? [sql`${heartbeatRuns.id} <> ${excludeRunId}`] : []),
      ));
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
      const cancelled = await transitionRunToTerminal(run.id, "cancelled", {
        finishedAt: new Date(),
        error: reason,
        errorCode: "cancelled",
      }, { expectedStatuses: ["queued"], processExitedAt: new Date() });
      if (!cancelled) return null;
      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: new Date(),
        error: reason,
      });
      if (cancelled) {
        await appendRunEvent(cancelled, {
          eventType: "lifecycle",
          stream: "system",
          level: "warn",
          message: "run cancelled",
        });
        await completeTerminalControlEffects(cancelled, { startNext: false });
      }
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
    const claimed = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-run-state:${run.agentId}`}))`);
      await tx.execute(sql`select id from agents where id = ${run.agentId} for update`);
      const currentAgent = await tx
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, run.agentId))
        .then((rows) => rows[0] ?? null);
      if (!currentAgent || ["paused", "terminated", "pending_approval"].includes(currentAgent.status)) {
        return null;
      }
      const pendingTerminalEffects = await tx
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.agentId, run.agentId),
          eq(heartbeatRuns.terminalEffectsPending, true),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (pendingTerminalEffects) return null;
      await tx.execute(sql`select id from heartbeat_runs where id = ${run.id} for update`);
      const currentRun = await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id))
        .then((rows) => rows[0] ?? null);
      if (!currentRun || currentRun.status !== "queued") return null;

      const currentContext = parseObject(currentRun.contextSnapshot);
      const currentTaskKey = deriveTaskKey(currentContext, null);
      const resetTaskSession = shouldResetTaskSessionForWake(currentContext);
      const sessionCodec = getAgentRuntimeSessionCodec(agent.agentRuntimeType);
      const explicitSessionParams = normalizeSessionParams(
        sessionCodec.deserialize(parseObject(currentContext.resumeSessionParams)),
      );
      const explicitSessionDisplayId = truncateDisplayId(
        readNonEmptyString(currentContext.resumeSessionDisplayId) ??
          (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(explicitSessionParams) : null) ??
          readNonEmptyString(explicitSessionParams?.sessionId),
      );
      const taskSession = currentTaskKey && !resetTaskSession
        ? await tx
            .select()
            .from(agentTaskSessions)
            .where(and(
              eq(agentTaskSessions.orgId, currentRun.orgId),
              eq(agentTaskSessions.agentId, currentRun.agentId),
              eq(agentTaskSessions.agentRuntimeType, agent.agentRuntimeType),
              eq(agentTaskSessions.taskKey, currentTaskKey),
            ))
            .then((rows) => rows[0] ?? null)
        : null;
      const taskSessionParams = normalizeSessionParams(
        sessionCodec.deserialize(taskSession?.sessionParamsJson ?? null),
      );
      const taskSessionDisplayId = truncateDisplayId(
        taskSession?.sessionDisplayId ??
          (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(taskSessionParams) : null) ??
          readNonEmptyString(taskSessionParams?.sessionId),
      );
      const sessionSelection = heartbeatSessions.selectRunSessionLineage({
        forceFresh: Boolean(heartbeatSessions.readSessionReuseSuppression(currentContext)),
        explicitSessionParams,
        explicitSessionDisplayId,
        taskSessionParams,
        taskSessionDisplayId,
      });
      const claimedRun = await tx
        .update(heartbeatRuns)
        .set({
          status: "running",
          startedAt: currentRun.startedAt ?? claimedAt,
          sessionIdBefore:
            sessionSelection.sessionDisplayId ?? readNonEmptyString(sessionSelection.sessionParams?.sessionId),
          sessionParamsBeforeJson: sessionSelection.sessionParams,
          sessionReuseScope: sessionSelection.reuseScope,
          executionOwnerToken: randomUUID(),
          executionLeaseExpiresAt: new Date(claimedAt.getTime() + RUN_EXECUTION_LEASE_MS),
          updatedAt: claimedAt,
        })
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!claimedRun) return null;
      await tx
        .update(agents)
        .set({ status: "running", updatedAt: claimedAt })
        .where(eq(agents.id, run.agentId));
      const [workIssue] = await tx.select({ id: issues.id }).from(issues).where(or(
        eq(issues.executionRunId, claimedRun.id),
        eq(issues.checkoutRunId, claimedRun.id),
      )).limit(1);
      const workSurface = workIssue ? "issue" : claimedRun.chatConversationId ? "chat" : null;
      const workId = workIssue?.id ?? claimedRun.chatConversationId;
      const workCycleId = workIssue ? `issue:${workIssue.id}` : claimedRun.chatConversationId ? `chat:${claimedRun.chatConversationId}` : null;
      await recordProductAnalyticsEvent(tx as unknown as Db, {
        orgId: claimedRun.orgId,
        eventName: "run_started",
        occurredAt: claimedRun.startedAt ?? claimedAt,
        sourceTransition: "heartbeat.run.claim",
        confidence: "exact",
        actorType: claimedRun.invocationSource.includes("automation") ? "automation" : "agent",
        actorId: claimedRun.agentId,
        runId: claimedRun.id,
        rootRunId: claimedRun.retryOfRunId ?? claimedRun.id,
        origin: claimedRun.invocationSource.includes("automation") ? "automation" : claimedRun.retryOfRunId ? "retry" : "human",
        workSurface,
        workId,
        workCycleId,
        entityType: "run",
        entityId: claimedRun.id,
        dedupeKey: `run_started:${claimedRun.id}`,
        properties: {
          run_kind: claimedRun.invocationSource,
          attempt_kind: claimedRun.retryOfRunId ? "retry" : "root",
        },
      });
      return claimedRun;
    });
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
    runId?: string,
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }

    const runningCount = await countRunningRunsForAgent(agentId, runId);
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

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number; now?: Date; recoveryCutoff?: Date }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const now = opts?.now ?? new Date();
    const recoveryCutoff = opts?.recoveryCutoff ?? now;

    // Find all runs stuck in "running" state (queued runs are legitimately waiting; resumeQueuedRuns handles them)
    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        agentRuntimeType: agents.agentRuntimeType,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(or(eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.terminalEffectsPending, true)));

    const reaped: string[] = [];

    for (const { run, agentRuntimeType } of activeRuns) {
      if (run.terminalEffectsPending) {
        if (!run.processExitedAt) {
          const exited = await terminateRunProcessAndWait(run, agentRuntimeType);
          if (!exited || activeRunExecutions.has(run.id)) continue;
          await acknowledgeRunProcessExit(run.id);
        }
        const completed = await completeTerminalControlEffects(run);
        if (!completed) continue;
        reaped.push(run.id);
        continue;
      }

      // Apply staleness threshold to avoid false positives
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      const recoveryClaim = await claimExpiredHeartbeatRunExecution(db, run.id, { now, recoveryCutoff });
      if (!recoveryClaim) continue;
      const claimedRun = recoveryClaim.run;

      const tracksLocalChild = isTrackedLocalChildProcessAdapter(agentRuntimeType);
      let detachedTerminationMessage: string | null = null;
      if (!claimedRun.processExitedAt && tracksLocalChild && claimedRun.processPid && isProcessAlive(claimedRun.processPid)) {
        const termination = await terminateOrphanedProcess(claimedRun.processPid);
        if (termination.stillAlive) {
          const detachedMessage = termination.error
            ? `Lost in-memory process handle, child pid ${claimedRun.processPid} is still alive, and Rudder could not terminate it: ${termination.error}`
            : `Lost in-memory process handle, but child pid ${claimedRun.processPid} is still alive`;
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
              },
            });
          }
          continue;
        }
        detachedTerminationMessage = termination.terminationSignal
          ? `Terminated detached child pid ${claimedRun.processPid} with ${termination.terminationSignal} after Rudder lost its process handle`
          : `Detached child pid ${claimedRun.processPid} exited before Rudder could terminate it`;
      }

      const shouldRetry = tracksLocalChild && !!claimedRun.processPid && (claimedRun.processLossRetryCount ?? 0) < 1;
      const baseMessage = claimedRun.processPid
        ? `Process lost -- child pid ${claimedRun.processPid} is no longer running`
        : "Process lost -- server may have restarted";

      let finalizedRun = await transitionRunToTerminal(claimedRun.id, "failed", {
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
        errorCode: "process_lost",
        finishedAt: now,
      }, {
        processExitedAt: now,
        terminalEffectsIntent: shouldRetry ? { version: 1, processLossRetry: true } : { version: 1 },
        expectedExecutionOwnerToken: recoveryClaim.ownerToken,
      });
      if (!finalizedRun) continue;
      await setWakeupStatus(claimedRun.wakeupRequestId, "failed", {
        finishedAt: now,
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
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
        message: shouldRetry
          ? `${baseMessage}; retry will be queued after terminal effects complete`
          : baseMessage,
        payload: {
          ...(claimedRun.processPid ? { processPid: claimedRun.processPid } : {}),
        },
      });
      const completed = await completeTerminalControlEffects(finalizedRun);
      runningProcesses.delete(claimedRun.id);
      if (!completed) continue;
      reaped.push(claimedRun.id);
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  async function reapInactiveRuns(opts?: { maxInactivityMs?: number; now?: Date; recoveryCutoff?: Date }) {
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
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .leftJoin(heartbeatRunEvents, eq(heartbeatRunEvents.runId, heartbeatRuns.id))
      .where(eq(heartbeatRuns.status, "running"))
      .groupBy(heartbeatRuns.id, agents.agentRuntimeType);

    const timedOut: string[] = [];

    for (const { run, agentRuntimeType, lastEventAt, eventCount } of activeRuns) {
      if (opts?.recoveryCutoff && new Date(run.createdAt).getTime() >= opts.recoveryCutoff.getTime()) continue;
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
      const processExitPending =
        activeRunExecutions.has(run.id)
        || runningProcesses.has(run.id)
        || (!run.processExitedAt && isTrackedLocalChildProcessAdapter(agentRuntimeType) && !!run.processPid && isProcessAlive(run.processPid));
      const finalizedRun = await transitionRunToTerminal(run.id, "timed_out", {
        finishedAt: now,
        error: message,
        errorCode: "inactivity_timeout",
        terminalEffectsPending: true,
      }, {
        activityWatermark: {
          updatedAt: run.updatedAt,
          eventCount: Number(eventCount ?? 0),
        },
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

  async function reapTimedOutRuns(opts?: { maxRuntimeMs?: number; now?: Date; recoveryCutoff?: Date }) {
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
      if (opts?.recoveryCutoff && new Date(run.createdAt).getTime() >= opts.recoveryCutoff.getTime()) continue;
      const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : null;
      if (!startedAt || !Number.isFinite(startedAt)) continue;

      const runtimeMs = now.getTime() - startedAt;
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
    opts?: { ownsTerminal?: boolean },
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

    if (opts?.ownsTerminal) {
      await db
        .update(agentRuntimeState)
        .set({
        agentRuntimeType: agent.agentRuntimeType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: result.errorMessage ?? null,
        updatedAt: new Date(),
      })
        .where(and(
          eq(agentRuntimeState.agentId, agent.id),
          sql`(
            ${agentRuntimeState.lastRunId} is null
            or ${agentRuntimeState.lastRunId} = ${run.id}
            or not exists (
              select 1
              from heartbeat_runs previous_run
              where previous_run.id = ${agentRuntimeState.lastRunId}
                and (
                  previous_run.created_at > ${run.createdAt.toISOString()}::timestamptz
                  or (
                    previous_run.created_at = ${run.createdAt.toISOString()}::timestamptz
                    and previous_run.id > ${run.id}
                  )
                )
            )
          )`,
        ));
    }

    if (additionalCostCents > 0 || hasTokenUsage) {
      const costs = costService(db, budgetHooks);
      await costs.createHeartbeatRunEventOnce(agent.orgId, {
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
      }, async (tx) => {
        await tx
          .update(agentRuntimeState)
          .set({
            totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${tokenSummary.promptTokens}`,
            totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
            totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
            totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
            updatedAt: new Date(),
          })
          .where(eq(agentRuntimeState.agentId, agent.id));
      });
    }
  }

  async function completeTerminalControlEffects(
    run: typeof heartbeatRuns.$inferSelect,
    opts?: {
      startNext?: boolean;
      automationOutput?: string | null;
      automationTranscript?: Parameters<typeof publishAutomationRunOutputToChat>[1]["transcript"];
    },
  ) {
    const claim = await claimHeartbeatRunTerminalEffects(db, run.id);
    if (!claim) return;
    const current = claim.run;
    let claimReleased = false;
    try {
      const runContext = parseObject(current.contextSnapshot);
      const intent = parseObject(current.terminalEffectsJson) as TerminalEffectIntent;
      const completedEffects = new Set(current.terminalEffectsCompletedJson ?? []);
      const deadLetteredEffects = new Set(current.terminalEffectsDeadLetteredJson ?? []);
      const runClaimedEffect = async <T>(effectName: TerminalEffectName, effect: () => Promise<T>) => {
        if (completedEffects.has(effectName) || deadLetteredEffects.has(effectName)) return undefined;
        const renewClaim = async () => {
          if (!await renewHeartbeatRunTerminalEffectsClaim(db, current.id, claim.claimToken)) {
            throw new Error("Heartbeat terminal effects claim was lost");
          }
        };
        await renewClaim();
        let renewalError: unknown = null;
        let renewal = Promise.resolve();
        const renewalTimer = setInterval(() => {
          renewal = renewal
            .then(renewClaim)
            .catch((error) => {
              renewalError ??= error;
            });
        }, TERMINAL_EFFECT_CLAIM_RENEW_INTERVAL_MS);
        renewalTimer.unref?.();
        try {
          const result = await effect();
          await renewal;
          if (renewalError) throw renewalError;
          await renewClaim();
          if (!await checkpointHeartbeatRunTerminalEffect(db, current.id, claim.claimToken, effectName)) {
            throw new Error(`Heartbeat terminal effect ${effectName} checkpoint was lost`);
          }
          completedEffects.add(effectName);
          return result;
        } catch (error) {
          const failure = await failHeartbeatRunTerminalEffect(
            db,
            current.id,
            claim.claimToken,
            effectName,
            error,
          );
          if (!failure) throw error;
          if (failure.deadLettered) {
            deadLetteredEffects.add(effectName);
            return undefined;
          }
          claimReleased = true;
          throw error;
        } finally {
          clearInterval(renewalTimer);
        }
      };
      if (intent.automation) {
        await runClaimedEffect("automation_chat", () => publishAutomationRunOutputToChat(db, {
          issueId: readNonEmptyString(runContext.issueId),
          output: opts?.automationOutput ?? intent.automation?.output ?? current.error,
          status: current.status,
          transcript: opts?.automationTranscript ?? [],
        }));
      }

      const agent = await getAgent(current.agentId);
      const runtimeIntent = intent.runtime;
      if (runtimeIntent) {
        await runClaimedEffect("runtime_cost", () => {
          if (!agent) throw new Error("Agent not found while replaying runtime terminal effect");
          return updateRuntimeState(
            agent,
            current,
            {
              exitCode: null,
              signal: null,
              timedOut: false,
              errorMessage: runtimeIntent.errorMessage,
              provider: runtimeIntent.provider,
              biller: runtimeIntent.biller,
              model: runtimeIntent.model,
              billingType: runtimeIntent.billingType as AgentRuntimeExecutionResult["billingType"],
              costUsd: runtimeIntent.costUsd,
            },
            { legacySessionId: runtimeIntent.legacySessionId },
            runtimeIntent.normalizedUsage as UsageTotals | null | undefined,
            { ownsTerminal: runtimeIntent.ownsTerminal !== false },
          );
        });
      }
      const taskSessionIntent = intent.taskSession;
      if (taskSessionIntent?.operation === "clear") {
        await runClaimedEffect("task_session", () => clearTaskSessions(taskSessionIntent.orgId, taskSessionIntent.agentId, {
          taskKey: taskSessionIntent.taskKey,
          agentRuntimeType: taskSessionIntent.agentRuntimeType,
          sourceRunId: taskSessionIntent.lastRunId ?? current.id,
        }));
      } else if (taskSessionIntent?.operation === "upsert") {
        await runClaimedEffect("task_session", () => upsertTaskSession({
          orgId: taskSessionIntent.orgId,
          agentId: taskSessionIntent.agentId,
          agentRuntimeType: taskSessionIntent.agentRuntimeType,
          taskKey: taskSessionIntent.taskKey,
          sessionParamsJson: taskSessionIntent.sessionParamsJson ?? null,
          sessionDisplayId: taskSessionIntent.sessionDisplayId ?? null,
          lastRunId: taskSessionIntent.lastRunId ?? current.id,
          lastError: taskSessionIntent.lastError ?? null,
        }));
      }

      if (intent.processLossRetry) {
        await runClaimedEffect("process_loss_retry", () => {
          if (!agent) throw new Error("Agent not found while replaying process-loss retry");
          return enqueueProcessLossRetry(current, agent, current.finishedAt ?? new Date());
        });
      }

      await runClaimedEffect("issue_release", () => releaseIssueExecutionAndPromote(current, { startNext: false }));
      const requiredEffects = terminalEffectNames(intent);
      if (!requiredEffects.every((effect) => completedEffects.has(effect) || deadLetteredEffects.has(effect))) {
        throw new Error("Heartbeat terminal effects did not converge");
      }
      const completed = await completeHeartbeatRunTerminalEffects(db, current.id, claim.claimToken);
      if (!completed) return;
      if (completed.agent) {
        publishLiveEvent({
          orgId: completed.agent.orgId,
          type: "agent.status",
          payload: {
            agentId: completed.agent.id,
            status: completed.agent.status,
            lastHeartbeatAt: completed.agent.lastHeartbeatAt
              ? new Date(completed.agent.lastHeartbeatAt).toISOString()
              : null,
          },
        });
      }
      if (opts?.startNext !== false) await resumeQueuedRuns();
      return completed;
    } catch (error) {
      if (!claimReleased) {
        await releaseHeartbeatRunTerminalEffectsClaim(db, current.id, claim.claimToken, error);
      }
      throw error;
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
        return [];
      }
      const pendingTerminalEffects = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.terminalEffectsPending, true),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (pendingTerminalEffects) return [];
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
        if (activeRunExecutions.has(queuedRun.id)) continue;
        activeRunExecutions.add(queuedRun.id);
        runAbortControllers.set(queuedRun.id, new AbortController());
        try {
          const claimed = await claimQueuedRun(queuedRun);
          if (claimed) {
            claimedRuns.push(claimed);
            void executeRun(claimed.id, { executionReserved: true }).catch((err) => {
              logger.error({ err, runId: claimed.id }, "queued heartbeat execution failed");
            });
          } else {
            runAbortControllers.delete(queuedRun.id);
            activeRunExecutions.delete(queuedRun.id);
          }
        } catch (error) {
          runAbortControllers.delete(queuedRun.id);
          activeRunExecutions.delete(queuedRun.id);
          throw error;
        }
      }
      if (claimedRuns.length === 0) return [];
      return claimedRuns;
    });
  }


  const baseContext = {
    db, instanceSettings, getCurrentUserRedactionOptions, runLogStore, runContextSvc, issuesSvc, executionWorkspacesSvc, workspaceOperationsSvc, activeRunExecutions, runAbortControllers, budgetHooks, budgets,
    getAgent, getRun, getRuntimeState, getTaskSession, getLatestRunForSession, getOldestRunForSession, resolveNormalizedUsageForSession, evaluateSessionCompaction, resolveSessionBeforeForWakeup, resolveExplicitResumeSessionOverride, upsertTaskSession, clearTaskSessions, ensureRuntimeState, setRunStatus, transitionRunToTerminal, reconcileRunEvidence, reconcileTerminalEffectsIntent, setWakeupStatus, updateWakeupRequestRecord, insertWakeupRequestRecord, appendRunEvent, persistRunProcessMetadata, clearDetachedRunWarning, terminateRunProcessAndWait, acknowledgeRunProcessExit, renewRunExecutionLease, countRunningRunsForAgent, claimQueuedRun, finalizeAgentStatus, completeTerminalControlEffects, reapOrphanedRuns, reapInactiveRuns, reapTimedOutRuns, resumeQueuedRuns, updateRuntimeState, startNextQueuedRunForAgent,
  } as any;
  const recoveryHandlers = createHeartbeatRecoveryHandlers({ ...baseContext, startNextQueuedRunForAgent });
  const wakeupHandlers = createHeartbeatWakeupHandlers({
    ...baseContext,
    ...recoveryHandlers,
    startNextQueuedRunForAgent,
    afterIssuePromotionCommitted: testHooks?.afterIssuePromotionCommitted,
  });
  const releaseHandlers = createHeartbeatReleaseHandlers({
    ...baseContext,
    ...recoveryHandlers,
    ...wakeupHandlers,
    afterIssuePromotionCommitted: testHooks?.afterIssuePromotionCommitted,
  });
  const executeHandlers = createHeartbeatExecuteHandlers({ ...baseContext, ...recoveryHandlers, ...releaseHandlers, ...wakeupHandlers });
  const miscHandlers = createHeartbeatMiscHandlers({ ...baseContext, ...recoveryHandlers, ...releaseHandlers, ...wakeupHandlers, ...executeHandlers });
  const { enqueueRecoveryRun, enqueueProcessLossRetry, evaluatePassiveIssueClosureForLockedIssue, parseHeartbeatPolicy } = recoveryHandlers;
  const { enqueueWakeup } = wakeupHandlers;
  const { releaseIssueExecutionAndPromote } = releaseHandlers;
  const { executeRun } = executeHandlers;
  const { resumeDeferredWakeupsForAgent, listProjectScopedRunIds, listProjectScopedWakeupIds, cancelPendingWakeupsForBudgetScope, cancelRunInternal, cancelActiveForAgentInternal, cancelBudgetScopeWork, retryRunInternal, buildSkillAnalytics } = miscHandlers;
  return {
    overview: async (orgId: string) => {
      const [latestRows, recentRows] = await Promise.all([
        db
          .selectDistinctOn([heartbeatRuns.agentId], heartbeatRunListColumns)
          .from(heartbeatRuns)
          .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
          .where(and(
            eq(heartbeatRuns.orgId, orgId),
            eq(agents.orgId, orgId),
            ne(agents.status, "terminated"),
          ))
          .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)),
        db
          .select(heartbeatRunListColumns)
          .from(heartbeatRuns)
          .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
          .where(and(eq(heartbeatRuns.orgId, orgId), eq(agents.orgId, orgId)))
          .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
          .limit(6),
      ]);

      const projectSummary = (row: (typeof latestRows)[number]) => toHeartbeatRun({
        ...row,
        resultJson: summarizeHeartbeatRunResultJson(row.resultJson),
      } as HeartbeatRun);

      return {
        latestByAgent: latestRows.map(projectSummary),
        recent: recentRows.map(projectSummary),
      };
    },

    list: async (
      orgId: string,
      agentId?: string,
      limit?: number,
      filters: { startDate?: Date; endDate?: Date } = {},
    ) => {
      const conditions = [eq(heartbeatRuns.orgId, orgId)];
      if (agentId) conditions.push(eq(heartbeatRuns.agentId, agentId));
      if (filters.startDate) conditions.push(gte(heartbeatRuns.createdAt, filters.startDate));
      if (filters.endDate) conditions.push(lte(heartbeatRuns.createdAt, filters.endDate));

      const query = db
        .select(heartbeatRunListColumns)
        .from(heartbeatRuns)
        .where(and(...conditions))
        .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));

      const rows = limit !== undefined ? await query.limit(limit) : await query;
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

      return rows.map((row) => toHeartbeatRun({
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
      } as HeartbeatRun));
    },

    getAgentSkillAnalytics: async (
      agentId: string,
      opts?: {
        windowDays?: number;
        now?: Date;
        startDate?: string;
        endDate?: string;
        from?: string;
        to?: string;
        timezoneOffsetMinutes?: number;
      },
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
        .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq), ne(heartbeatRunEvents.eventType, ISSUE_EXECUTION_RELEASED_EVENT_TYPE)))
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(Math.max(1, Math.min(limit, 1000))),
    readLog: async (runId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const run = await db
        .select({
          id: heartbeatRuns.id,
          logStore: heartbeatRuns.logStore,
          logRef: heartbeatRuns.logRef,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
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
            or(
              eq(heartbeatRuns.status, "running"),
              eq(heartbeatRuns.terminalEffectsPending, true),
            ),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}
