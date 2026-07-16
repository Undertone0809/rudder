// @ts-nocheck
/**
 * @fileoverview Executes claimed heartbeat runs through runtime adapters,
 * workspace realization, transcript persistence, and close-out release.
 *
 * @see doc/product/domains/execution/agent-runs.md - run execution state and evidence
 * @see doc/product/domains/execution/run-admission-and-recovery.md - retry and recovery behavior
 * @see doc/product/domains/agents/instruction-loading.md - AGENT.INSTRUCTIONS.001 runtime instruction frame
 */
import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import {
  heartbeatRuns,
  issues,
  projects
} from "@rudderhq/db";
import {
  resolveAgentRunScene,
  type HeartbeatRun,
} from "@rudderhq/shared";
import { and, eq } from "drizzle-orm";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import type {
  AgentRuntimeInvocationMeta,
  UsageSummary
} from "../../agent-runtimes/index.js";
import { findServerAdapter, getServerAdapter } from "../../agent-runtimes/index.js";
import { parseObject } from "../../agent-runtimes/utils.js";
import {
  resolveDefaultAgentWorkspaceDir,
} from "../../home-paths.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { logger } from "../../middleware/logger.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "../execution-workspace-policy.js";
import { summarizeHeartbeatRunResultJson } from "../heartbeat-run-summary.js";
import { publishLiveEvent } from "../live-events.js";
import {
  isManagedWorkspaceConfigurationError,
  isWorkspacePermissionPreflightError,
  preflightManagedAgentWorkspace,
} from "../managed-workspace-preflight.js";
import { type RunLogHandle } from "../run-log-store.js";
import {
  buildWorkspaceReadyComment,
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun
} from "../workspace-runtime.js";
import { executeAdapterWithModelFallbacks } from "./model-fallback.js";

export { prioritizeProjectWorkspaceCandidatesForRun, type ResolvedWorkspaceForRun } from "../agent-run-context.js";

import * as heartbeatCore from "./heartbeat.core.js";
import * as heartbeatSessions from "./heartbeat.sessions.js";
const { MAX_LIVE_LOG_CHUNK_BYTES, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, DEFERRED_WAKE_CONTEXT_KEY, DETACHED_PROCESS_ERROR_CODE, ORPHANED_PROCESS_TERMINATION_GRACE_MS, ORPHANED_PROCESS_KILL_WAIT_MS, ORPHANED_PROCESS_POLL_INTERVAL_MS, startLocksByAgent, MAX_RECOVERY_CHAIN_DEPTH, ISSUE_PASSIVE_FOLLOWUP_REASON, ISSUE_PASSIVE_FOLLOWUP_WAKE_SOURCE, ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON, ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS, ISSUE_REVIEW_CLOSEOUT_REASON, ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON, ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS, ISSUE_PASSIVE_FOLLOWUP_COOLDOWN_MS_BY_ATTEMPT, ISSUE_PASSIVE_FOLLOWUP_TIMER_CONTINUITY_MAX_WINDOW_MS, SESSIONED_LOCAL_ADAPTERS, heartbeatRunListColumns, appendExcerpt, appendTranscriptEntriesFromChunk, normalizeMaxConcurrentRuns, withAgentStartLock, readNonEmptyString, buildHeartbeatAdapterInvokePayload, sanitizeStartupContextContextForPersistence, sanitizeStartupContextPromptForPersistence, buildRecentDateKeys, buildDateKeysBetween, fallbackSkillLabel, normalizeLoadedSkill, normalizeLoadedSkillForPayload, emptySkillEvidenceCounts, incrementSkillEvidenceCount, strongestSkillEvidence, resolveSkillEvidence, readSkillEvidenceFromPayload, extractSkillSlugFromPath, collectSkillPathsFromText, collectStringValues, normalizeSkillUseFromPath, dedupeSkillUses, collectSkillUsesFromText, readToolCommandInput, isCommandTranscriptTool, isReadTranscriptTool, inferUsedSkillsFromTranscript, normalizeSkillCandidate, addSkillCandidate, readSkillReferenceSlug, collectSkillReferences, inferUsedSkillsFromPrompt, resolveForbiddenRuntimeSkillMarkers, detectForbiddenRuntimeSkillMarker, normalizeLedgerBillingType, resolveLedgerBiller, normalizeBilledCostCents, resolveLedgerScopeForRun } = heartbeatCore;
const { buildExplicitResumeSessionOverride, selectRunSessionLineage, normalizeUsageTotals, readRawUsageTotals, deriveNormalizedUsageDelta, formatCount, parseSessionCompactionPolicy, resolveRuntimeSessionParamsForWorkspace, parseIssueAssigneeAgentRuntimeOverrides, deriveTaskKey, shouldResetTaskSessionForWake, formatRuntimeWorkspaceWarningLog, describeSessionResetReason, deriveCommentId, enrichWakeContextSnapshot, mergeCoalescedContextSnapshot, issueCommentAuthorKind, issueCommentAuthorLabel, buildDeferredWakePayload, readDeferredWakeContext, readDeferredWakePayload, deriveDeferredWakeTaskKey, hydrateWakeContextSnapshot, firstNonEmptyLine, deriveRecoveryFailureKind, deriveRecoveryFailureSummary, mergeMissingRecoveryContextFields, hydrateRecoveryBaseContextSnapshot, buildRecoveryContextSnapshot, normalizePassiveFollowupContext, normalizeReviewCloseoutContext, passiveFollowupCooldownMs, issueHasReviewer, isAgentEligibleForTimerContinuation, hasCredibleTimerContinuation, buildPassiveFollowupContextSnapshot, runTaskKey, isSameTaskScope, isTrackedLocalChildProcessAdapter, isProcessAlive, waitForProcessExit, terminateOrphanedProcess, truncateDisplayId, normalizeAgentNameKey, defaultSessionCodec, getAgentRuntimeSessionCodec, normalizeSessionParams, resolveNextSessionState } = heartbeatSessions;

function buildPersistableHeartbeatContext(context: Record<string, unknown>) {
  return sanitizeStartupContextContextForPersistence(context) ?? {};
}

function resolveRuntimeSceneForRun(run: typeof heartbeatRuns.$inferSelect) {
  return resolveAgentRunScene({
    ...run,
    invocationSource: run.invocationSource as HeartbeatRun["invocationSource"],
    triggerDetail: run.triggerDetail as HeartbeatRun["triggerDetail"],
    status: run.status as HeartbeatRun["status"],
    contextSnapshot: run.contextSnapshot as HeartbeatRun["contextSnapshot"],
  });
}

export function createHeartbeatExecuteHandlers(context: any) {
  const { db, instanceSettings, getCurrentUserRedactionOptions, runLogStore, runContextSvc, issuesSvc, executionWorkspacesSvc, workspaceOperationsSvc, activeRunExecutions, runAbortControllers, budgetHooks, budgets, getAgent, getRun, getRuntimeState, getTaskSession, getLatestRunForSession, getOldestRunForSession, resolveNormalizedUsageForSession, evaluateSessionCompaction, resolveSessionBeforeForWakeup, resolveExplicitResumeSessionOverride, upsertTaskSession, clearTaskSessions, ensureRuntimeState, setRunStatus, transitionRunToTerminal, reconcileRunEvidence, reconcileTerminalEffectsIntent, setWakeupStatus, updateWakeupRequestRecord, insertWakeupRequestRecord, appendRunEvent, persistRunProcessMetadata, clearDetachedRunWarning, acknowledgeRunProcessExit, renewRunExecutionLease, enqueueRecoveryRun, enqueueProcessLossRetry, parseHeartbeatPolicy, markAgentHeartbeatChecked, evaluateTimerPreflight, runHasIssueClosureComment, runHasIssueReviewDecision, issueHasDeferredWake, passiveFollowupAlreadyRecorded, reviewerCloseoutAlreadyRecorded, issueHasRecordedBlockedReviewerDecision, evaluatePassiveIssueClosureForLockedIssue, countRunningRunsForAgent, claimQueuedRun, finalizeAgentStatus, completeTerminalControlEffects, reapOrphanedRuns, resumeQueuedRuns, updateRuntimeState, startNextQueuedRunForAgent, releaseIssueExecutionAndPromote, enqueueWakeup, resumeDeferredWakeupsForAgent, listProjectScopedRunIds, listProjectScopedWakeupIds, cancelPendingWakeupsForBudgetScope, cancelRunInternal, cancelActiveForAgentInternal, cancelBudgetScopeWork, retryRunInternal, buildSkillAnalytics } = context;

  async function executeRun(runId: string, opts?: { executionReserved?: boolean }) {
    const executionReserved = opts?.executionReserved === true;
    if (executionReserved && !activeRunExecutions.has(runId)) return;
    let run: Awaited<ReturnType<typeof getRun>>;
    let executionLeaseTimer: ReturnType<typeof setInterval> | null = null;
    let executionOwnerToken: string | null = null;
    try {
      run = await getRun(runId);
    } catch (error) {
      if (executionReserved) {
        runAbortControllers.delete(runId);
        activeRunExecutions.delete(runId);
      }
      throw error;
    }
    if (!run || (run.status !== "queued" && run.status !== "running")) {
      if (executionReserved) {
        runAbortControllers.delete(runId);
        activeRunExecutions.delete(runId);
        if (run?.terminalEffectsPending) {
          await acknowledgeRunProcessExit(run.id);
          await completeTerminalControlEffects(run);
        }
        if (run) await startNextQueuedRunForAgent(run.agentId);
      }
      return;
    }

    if (executionReserved) {
      if (!activeRunExecutions.has(run.id)) return;
    } else {
      if (activeRunExecutions.has(run.id)) return;
      activeRunExecutions.add(run.id);
    }
    const executionAbortController = runAbortControllers.get(run.id) ?? new AbortController();
    runAbortControllers.set(run.id, executionAbortController);

    try {
    if (run.status === "queued") {
      const claimed = await claimQueuedRun(run);
      if (!claimed) {
        // Another worker has already claimed or finalized this run.
        return;
      }
      run = claimed;
    }

    executionOwnerToken = run.executionOwnerToken;
    if (executionOwnerToken) {
      await renewRunExecutionLease(run.id, executionOwnerToken);
      executionLeaseTimer = setInterval(() => {
        void renewRunExecutionLease(run.id, executionOwnerToken).catch(() => undefined);
      }, 60_000);
      executionLeaseTimer.unref?.();
    }

    const agent = await getAgent(run.agentId);
    if (!agent) {
      const failed = await transitionRunToTerminal(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      }, {
        processExitedAt: new Date(),
        expectedExecutionOwnerToken: executionOwnerToken,
      });
      if (failed) {
        await setWakeupStatus(run.wakeupRequestId, "failed", {
          finishedAt: new Date(),
          error: "Agent not found",
        });
        await completeTerminalControlEffects(failed);
      }
      return;
    }

    const executionTranscript: TranscriptEntry[] = [];
    let stdoutTranscriptBuffer = "";
    let stderrTranscriptBuffer = "";
    let stdoutTranscriptParser: ((line: string, ts: string) => TranscriptEntry[]) | null = null;
    let transcriptFallbackResult: {
      ts?: string | null;
      model?: string | null;
      output?: string | null;
      usage?: UsageSummary | null;
      costUsd?: number | null;
      subtype?: string | null;
      isError?: boolean;
      errors?: string[];
    } | null = null;
    let latestAdapterMeta: AgentRuntimeInvocationMeta | null = null;
    let adapterForbiddenMarkerObserved = false;
    let finalRunOutput: string | null = null;
    let ownsTerminalState = false;
    let shouldCompleteTerminalEffects = false;
    const finalizeExecutionTranscript = () => {
      stdoutTranscriptBuffer = appendTranscriptEntriesFromChunk({
        buffer: stdoutTranscriptBuffer,
        chunk: "",
        transcript: executionTranscript,
        parser: stdoutTranscriptParser,
        finalize: true,
        kind: "stdout",
      });
      stderrTranscriptBuffer = appendTranscriptEntriesFromChunk({
        buffer: stderrTranscriptBuffer,
        chunk: "",
        transcript: executionTranscript,
        finalize: true,
        kind: "stderr",
      });
    };
    await ensureRuntimeState(agent);
    const context = parseObject(run.contextSnapshot);
    delete context.rudderGitIdentity;
    const taskKey = deriveTaskKey(context, null);
    const sessionCodec = getAgentRuntimeSessionCodec(agent.agentRuntimeType);
    const issueId = readNonEmptyString(context.issueId);
    const issueContext = issueId
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            description: issues.description,
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
            executionWorkspaceId: issues.executionWorkspaceId,
            executionWorkspacePreference: issues.executionWorkspacePreference,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAgentRuntimeOverrides: issues.assigneeAgentRuntimeOverrides,
            executionWorkspaceSettings: issues.executionWorkspaceSettings,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.orgId, agent.orgId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueAssigneeOverrides =
      issueContext && issueContext.assigneeAgentId === agent.id
        ? parseIssueAssigneeAgentRuntimeOverrides(
            issueContext.assigneeAgentRuntimeOverrides,
          )
        : null;
    const issueExecutionWorkspaceSettings = parseIssueExecutionWorkspaceSettings(issueContext?.executionWorkspaceSettings);
    const contextProjectId = readNonEmptyString(context.projectId);
    const executionProjectId = issueContext?.projectId ?? contextProjectId;
    const projectExecutionWorkspacePolicy = executionProjectId
      ? await db
          .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
          .from(projects)
          .where(and(eq(projects.id, executionProjectId), eq(projects.orgId, agent.orgId)))
          .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
      : null;
    const taskSession = taskKey
      ? await getTaskSession(agent.orgId, agent.id, agent.agentRuntimeType, taskKey)
      : null;
    const resetTaskSession = shouldResetTaskSessionForWake(context);
    const sessionResetReason = describeSessionResetReason(context);
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const explicitResumeSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(parseObject(context.resumeSessionParams)),
    );
    const explicitResumeSessionDisplayId = truncateDisplayId(
      readNonEmptyString(context.resumeSessionDisplayId) ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(explicitResumeSessionParams) : null) ??
        readNonEmptyString(explicitResumeSessionParams?.sessionId),
    );
    const taskSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null),
    );
    const taskSessionDisplayId = truncateDisplayId(
      taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(taskSessionParams) : null) ??
        readNonEmptyString(taskSessionParams?.sessionId),
    );
    const sessionSelection = selectRunSessionLineage({
      forceFresh: context.forceFreshSession === true,
      explicitSessionParams: explicitResumeSessionParams,
      explicitSessionDisplayId: explicitResumeSessionDisplayId,
      taskSessionParams,
      taskSessionDisplayId,
    });
    const previousSessionParams = sessionSelection.sessionParams;
    const selectedRunningRun = await db
      .update(heartbeatRuns)
      .set({
        sessionIdBefore: sessionSelection.sessionDisplayId ?? readNonEmptyString(sessionSelection.sessionParams?.sessionId),
        sessionParamsBeforeJson: sessionSelection.sessionParams,
        sessionReuseScope: sessionSelection.reuseScope,
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (selectedRunningRun) run = selectedRunningRun;
    const config = await runContextSvc.materializeManagedInstructionsForRun({
      ...agent,
      agentRuntimeConfig: parseObject(agent.agentRuntimeConfig),
    });
    const executionWorkspaceMode = resolveExecutionWorkspaceMode({
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const resolvedWorkspace = await runContextSvc.resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: executionWorkspaceMode !== "agent_default" },
    );
    const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig({
      agentConfig: config,
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      mode: executionWorkspaceMode,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const mergedConfig = issueAssigneeOverrides?.agentRuntimeConfig
      ? { ...workspaceManagedConfig, ...issueAssigneeOverrides.agentRuntimeConfig }
      : workspaceManagedConfig;
    const { resolvedConfig, runtimeConfig, runtimeSkillEntries, secretKeys } =
      await runContextSvc.prepareRuntimeConfig({
        scene: "heartbeat",
        agent,
        baseConfig: mergedConfig,
      });
    const issueRef = issueContext
      ? {
          id: issueContext.id,
          identifier: issueContext.identifier,
          title: issueContext.title,
          projectId: issueContext.projectId,
          projectWorkspaceId: issueContext.projectWorkspaceId,
          executionWorkspaceId: issueContext.executionWorkspaceId,
          executionWorkspacePreference: issueContext.executionWorkspacePreference,
        }
      : null;
    const existingExecutionWorkspace =
      issueRef?.executionWorkspaceId ? await executionWorkspacesSvc.getById(issueRef.executionWorkspaceId) : null;
    const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
      orgId: agent.orgId,
      heartbeatRunId: run.id,
      executionWorkspaceId: existingExecutionWorkspace?.id ?? null,
    });
    const executionWorkspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: resolvedWorkspace.cwd,
        source: resolvedWorkspace.source,
        projectId: resolvedWorkspace.projectId,
        workspaceId: resolvedWorkspace.workspaceId,
        repoUrl: resolvedWorkspace.repoUrl,
        repoRef: resolvedWorkspace.repoRef,
      },
      config: runtimeConfig,
      issue: issueRef,
      agent: {
        id: agent.id,
        name: agent.name,
        orgId: agent.orgId,
      },
      recorder: workspaceOperationRecorder,
    });
    const resolvedProjectId = executionWorkspace.projectId ?? issueRef?.projectId ?? executionProjectId ?? null;
    const resolvedProjectWorkspaceId = issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
    const shouldReuseExisting =
      issueRef?.executionWorkspacePreference === "reuse_existing" &&
      existingExecutionWorkspace &&
      existingExecutionWorkspace.status !== "archived";
    let persistedExecutionWorkspace = null;
    try {
      persistedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
        ? await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
            cwd: executionWorkspace.cwd,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            branchName: executionWorkspace.branchName,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            status: "active",
            lastUsedAt: new Date(),
            metadata: {
              ...(existingExecutionWorkspace.metadata ?? {}),
              source: executionWorkspace.source,
              createdByRuntime: executionWorkspace.created,
            },
          })
        : resolvedProjectId
          ? await executionWorkspacesSvc.create({
              orgId: agent.orgId,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              mode:
                executionWorkspaceMode === "isolated_workspace"
                  ? "isolated_workspace"
                  : executionWorkspaceMode === "operator_branch"
                    ? "operator_branch"
                    : executionWorkspaceMode === "agent_default"
                      ? "adapter_managed"
                      : "shared_workspace",
              strategyType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
              name: executionWorkspace.branchName ?? issueRef?.identifier ?? `workspace-${agent.id.slice(0, 8)}`,
              status: "active",
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: executionWorkspace.branchName,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              lastUsedAt: new Date(),
              openedAt: new Date(),
              metadata: {
                source: executionWorkspace.source,
                createdByRuntime: executionWorkspace.created,
              },
            })
          : null;
    } catch (error) {
      if (executionWorkspace.created) {
        try {
          await cleanupExecutionWorkspaceArtifacts({
            workspace: {
              id: existingExecutionWorkspace?.id ?? `transient-${run.id}`,
              cwd: executionWorkspace.cwd,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              branchName: executionWorkspace.branchName,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              metadata: {
                createdByRuntime: true,
                source: executionWorkspace.source,
              },
            },
            projectWorkspace: {
              cwd: resolvedWorkspace.cwd,
              cleanupCommand: null,
            },
            teardownCommand: projectExecutionWorkspacePolicy?.workspaceStrategy?.teardownCommand ?? null,
            recorder: workspaceOperationRecorder,
          });
        } catch (cleanupError) {
          logger.warn(
            {
              runId: run.id,
              issueId,
              executionWorkspaceCwd: executionWorkspace.cwd,
              cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            },
            "Failed to cleanup realized run workspace after persistence failure",
          );
        }
      }
      throw error;
    }
    await workspaceOperationRecorder.attachExecutionWorkspaceId(persistedExecutionWorkspace?.id ?? null);
    if (
      existingExecutionWorkspace &&
      persistedExecutionWorkspace &&
      existingExecutionWorkspace.id !== persistedExecutionWorkspace.id &&
      existingExecutionWorkspace.status === "active"
    ) {
      await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
        status: "idle",
        cleanupReason: null,
      });
    }
    if (issueId && persistedExecutionWorkspace) {
      const nextIssueWorkspaceMode = issueExecutionWorkspaceModeForPersistedWorkspace(persistedExecutionWorkspace.mode);
      const shouldSwitchIssueToExistingWorkspace =
        issueRef?.executionWorkspacePreference === "reuse_existing" ||
        executionWorkspaceMode === "isolated_workspace" ||
        executionWorkspaceMode === "operator_branch";
      const nextIssuePatch: Record<string, unknown> = {};
      if (issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
        nextIssuePatch.executionWorkspaceId = persistedExecutionWorkspace.id;
      }
      if (resolvedProjectWorkspaceId && issueRef?.projectWorkspaceId !== resolvedProjectWorkspaceId) {
        nextIssuePatch.projectWorkspaceId = resolvedProjectWorkspaceId;
      }
      if (shouldSwitchIssueToExistingWorkspace) {
        nextIssuePatch.executionWorkspacePreference = "reuse_existing";
        nextIssuePatch.executionWorkspaceSettings = {
          ...(issueExecutionWorkspaceSettings ?? {}),
          mode: nextIssueWorkspaceMode,
        };
      }
      if (Object.keys(nextIssuePatch).length > 0) {
        await issuesSvc.update(issueId, nextIssuePatch);
      }
    }
    if (persistedExecutionWorkspace) {
      context.executionWorkspaceId = persistedExecutionWorkspace.id;
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: buildPersistableHeartbeatContext(context),
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
    }
    const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
      orgId: agent.orgId,
      agent,
      previousSessionParams,
      resolvedWorkspace: {
        ...resolvedWorkspace,
        cwd: resolveDefaultAgentWorkspaceDir(agent.orgId, agent),
        source: "agent_home",
      },
    });
    const runtimeSessionParams = runtimeSessionResolution.sessionParams;
    const runtimeWorkspaceWarnings = [
      ...resolvedWorkspace.warnings,
      ...executionWorkspace.warnings,
      ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
      ...(resetTaskSession && sessionResetReason
        ? [
            taskKey
              ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
              : `Skipping saved session resume because ${sessionResetReason}.`,
          ]
        : []),
    ];
    const runtimeScene = resolveRuntimeSceneForRun(run);
    const runtimeSceneContext = await runContextSvc.buildSceneContext({
      scene: runtimeScene,
      agent,
      resolvedWorkspace,
      runtimeConfig,
      issueId,
      executionWorkspaceMode,
      executionWorkspace: {
        cwd: executionWorkspace.cwd,
        source: executionWorkspace.source,
        strategy: executionWorkspace.strategy,
        projectId: executionWorkspace.projectId,
        workspaceId: executionWorkspace.workspaceId,
        repoUrl: executionWorkspace.repoUrl,
        repoRef: executionWorkspace.repoRef,
        branchName: executionWorkspace.branchName,
        worktreePath: executionWorkspace.worktreePath,
      },
    });
    context.rudderScene = runtimeSceneContext.rudderScene;
    context.rudderWorkspace = runtimeSceneContext.rudderWorkspace;
    context.rudderWorkspaces = runtimeSceneContext.rudderWorkspaces;
    context.rudderStartupContext = runtimeSceneContext.rudderStartupContext;
    context.rudderStartupContextMetrics = runtimeSceneContext.rudderStartupContextMetrics;
    if (runtimeSceneContext.rudderRuntimeServiceIntents) {
      context.rudderRuntimeServiceIntents = runtimeSceneContext.rudderRuntimeServiceIntents;
    } else {
      delete context.rudderRuntimeServiceIntents;
    }
    if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = executionWorkspace.projectId;
    }
    let previousSessionDisplayId = truncateDisplayId(
      sessionSelection.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId),
    );
    let runtimeSessionIdForAdapter =
      readNonEmptyString(runtimeSessionParams?.sessionId);
    let runtimeSessionParamsForAdapter = runtimeSessionParams;

    const sessionCompaction = await evaluateSessionCompaction({
      agent,
      sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
      issueId,
    });
    if (sessionCompaction.rotate) {
      context.rudderSessionHandoffMarkdown = sessionCompaction.handoffMarkdown;
      context.rudderSessionRotationReason = sessionCompaction.reason;
      context.rudderPreviousSessionId = previousSessionDisplayId ?? runtimeSessionIdForAdapter;
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      if (sessionCompaction.reason) {
        runtimeWorkspaceWarnings.push(
          `Starting a fresh session because ${sessionCompaction.reason}.`,
        );
      }
    } else {
      delete context.rudderSessionHandoffMarkdown;
      delete context.rudderSessionRotationReason;
      delete context.rudderPreviousSessionId;
    }
    const sessionReuseScope = sessionCompaction.rotate ? "none" : sessionSelection.reuseScope;

    const runtimeForAdapter = {
      sessionId: runtimeSessionIdForAdapter,
      sessionParams: runtimeSessionParamsForAdapter,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };

    let handle: RunLogHandle | null = null;
    let stdoutExcerpt = "";
    let stderrExcerpt = "";
    let lastRunActivityTouchMs = 0;
    const buildForbiddenMarkerScan = (resultJson: Record<string, unknown> | null = null) => detectForbiddenRuntimeSkillMarker({
      markers: resolveForbiddenRuntimeSkillMarkers(runtimeConfig),
      meta: adapterForbiddenMarkerObserved ? { forbiddenMarkerObserved: true } : latestAdapterMeta,
      stdoutExcerpt,
      stderrExcerpt,
      resultJson,
      transcript: executionTranscript,
    });
    const appendForbiddenMarkerEvent = async (
      eventRun: typeof heartbeatRuns.$inferSelect,
      scan: ReturnType<typeof detectForbiddenRuntimeSkillMarker>,
    ) => {
      if (!scan.observed) return;
      await appendRunEvent(eventRun, {
        eventType: "adapter.forbidden_marker",
        stream: "system",
        level: "error",
        message: "forbidden runtime skill marker observed",
        payload: {
          source: "runtime_skill_isolation",
          forbiddenMarkerObserved: true,
          forbiddenMarkerCount: scan.evidence.length,
          forbiddenMarkerEvidence: scan.evidence,
        },
      });
    };
    try {
      await preflightManagedAgentWorkspace({
        agentHome: readNonEmptyString(runtimeSceneContext.rudderWorkspace.agentHome) ?? "",
        instructionsDir: readNonEmptyString(runtimeSceneContext.rudderWorkspace.instructionsDir) ?? "",
        memoryDir: readNonEmptyString(runtimeSceneContext.rudderWorkspace.memoryDir) ?? "",
        lifeDir: readNonEmptyString(runtimeSceneContext.rudderWorkspace.lifeDir) ?? "",
        skillsDir: readNonEmptyString(runtimeSceneContext.rudderWorkspace.agentSkillsDir) ?? "",
      });

      const startedAt = run.startedAt ?? new Date();
      const runningWithSession = await db
        .update(heartbeatRuns)
        .set({
          startedAt,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          sessionParamsBeforeJson: runtimeForAdapter.sessionParams,
          sessionReuseScope,
          contextSnapshot: buildPersistableHeartbeatContext(context),
          updatedAt: new Date(),
        })
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running")))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (runningWithSession) run = runningWithSession;

      const currentRun = run;
      await appendRunEvent(currentRun, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
      });

      handle = await runLogStore.begin({
        orgId: run.orgId,
        agentId: run.agentId,
        runId,
      });

      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));

      const adapter = getServerAdapter(agent.agentRuntimeType);
      stdoutTranscriptParser = adapter.parseStdoutLine ?? null;
      const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        const sanitizedChunk = redactCurrentUserText(chunk, currentUserRedactionOptions);
        if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
        if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
        const ts = new Date().toISOString();

        if (handle) {
          await runLogStore.append(handle, {
            stream,
            chunk: sanitizedChunk,
            ts,
          });
        }
        const nowMs = Date.now();
        if (nowMs - lastRunActivityTouchMs >= 30_000) {
          lastRunActivityTouchMs = nowMs;
          await db
            .update(heartbeatRuns)
            .set({ updatedAt: new Date(nowMs) })
            .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running")));
        }

        const payloadChunk =
          sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : sanitizedChunk;

        publishLiveEvent({
          orgId: run.orgId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            ts,
            stream,
            chunk: payloadChunk,
            truncated: payloadChunk.length !== sanitizedChunk.length,
          },
        });

        if (stream === "stdout") {
          stdoutTranscriptBuffer = appendTranscriptEntriesFromChunk({
            buffer: stdoutTranscriptBuffer,
            chunk: sanitizedChunk,
            transcript: executionTranscript,
            parser: stdoutTranscriptParser,
            kind: "stdout",
          });
          return;
        }

        stderrTranscriptBuffer = appendTranscriptEntriesFromChunk({
          buffer: stderrTranscriptBuffer,
          chunk: sanitizedChunk,
          transcript: executionTranscript,
          kind: "stderr",
        });
      };
      for (const warning of runtimeWorkspaceWarnings) {
        const logEntry = formatRuntimeWorkspaceWarningLog(warning);
        await onLog(logEntry.stream, logEntry.chunk);
      }
      const adapterEnv = Object.fromEntries(
        Object.entries(parseObject(resolvedConfig.env)).filter(
          (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      );
      const runtimeServices = await ensureRuntimeServicesForRun({
        db,
        runId: run.id,
        agent: {
          id: agent.id,
          name: agent.name,
          orgId: agent.orgId,
        },
        issue: issueRef,
        workspace: executionWorkspace,
        executionWorkspaceId: persistedExecutionWorkspace?.id ?? issueRef?.executionWorkspaceId ?? null,
        config: resolvedConfig,
        adapterEnv,
        onLog,
      });
      if (runtimeServices.length > 0) {
        context.rudderRuntimeServices = runtimeServices;
        context.rudderRuntimePrimaryUrl =
          runtimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: buildPersistableHeartbeatContext(context),
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
      }
      if (issueId && (executionWorkspace.created || runtimeServices.some((service) => !service.reused))) {
        try {
          await issuesSvc.addComment(
            issueId,
            buildWorkspaceReadyComment({
              workspace: executionWorkspace,
              runtimeServices,
            }),
            { agentId: agent.id },
          );
        } catch (err) {
          await onLog(
            "stderr",
            `[rudder] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      const onAdapterMeta = async (meta: AgentRuntimeInvocationMeta) => {
        latestAdapterMeta = meta;
        adapterForbiddenMarkerObserved ||= meta.forbiddenMarkerObserved === true;
        if (meta.env && secretKeys.size > 0) {
          for (const key of secretKeys) {
            if (key in meta.env) meta.env[key] = "***REDACTED***";
          }
        }
        await appendRunEvent(currentRun, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: buildHeartbeatAdapterInvokePayload({
            meta,
            runtimeSkills: runtimeSkillEntries,
          }),
        });
      };

      const authToken = adapter.supportsLocalAgentJwt
        ? createLocalAgentJwt(agent.id, agent.orgId, agent.agentRuntimeType, run.id)
        : null;
      if (adapter.supportsLocalAgentJwt && !authToken) {
        logger.warn(
          {
            orgId: agent.orgId,
            agentId: agent.id,
            runId: run.id,
            agentRuntimeType: agent.agentRuntimeType,
          },
          "local agent jwt secret missing or invalid; running without injected RUDDER_API_KEY",
        );
      }
      const runBeforeAdapter = await getRun(run.id);
      if (runBeforeAdapter?.status !== "running") {
        throw new Error("Run was finalized before adapter invocation");
      }
      const adapterResult = await executeAdapterWithModelFallbacks(adapter, {
        runId: run.id,
        agent,
        runtime: runtimeForAdapter,
        config: runtimeConfig,
        context,
        onLog,
        onMeta: onAdapterMeta,
        onSpawn: async (meta) => {
          await persistRunProcessMetadata(run.id, meta);
        },
        abortSignal: executionAbortController.signal,
        authToken: authToken ?? undefined,
      }, {
        resolveAdapter: findServerAdapter,
        createAuthToken: (agentRuntimeType) =>
          createLocalAgentJwt(agent.id, agent.orgId, agentRuntimeType, run.id) ?? undefined,
        onAttemptStart: (_attempt, attemptAdapter) => {
          stdoutTranscriptParser = attemptAdapter.parseStdoutLine ?? null;
        },
      });
      const adapterManagedRuntimeServices = adapterResult.runtimeServices
        ? await persistAdapterManagedRuntimeServices({
            db,
            agentRuntimeType: agent.agentRuntimeType,
            runId: run.id,
            agent: {
              id: agent.id,
              name: agent.name,
              orgId: agent.orgId,
            },
            issue: issueRef,
            workspace: executionWorkspace,
            reports: adapterResult.runtimeServices,
          })
        : [];
      if (adapterManagedRuntimeServices.length > 0) {
        const combinedRuntimeServices = [
          ...runtimeServices,
          ...adapterManagedRuntimeServices,
        ];
        context.rudderRuntimeServices = combinedRuntimeServices;
        context.rudderRuntimePrimaryUrl =
          combinedRuntimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: buildPersistableHeartbeatContext(context),
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
        if (issueId) {
          try {
            await issuesSvc.addComment(
              issueId,
              buildWorkspaceReadyComment({
                workspace: executionWorkspace,
                runtimeServices: adapterManagedRuntimeServices,
              }),
              { agentId: agent.id },
            );
          } catch (err) {
            await onLog(
              "stderr",
              `[rudder] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
      }
      const nextSessionState = resolveNextSessionState({
        codec: sessionCodec,
        adapterResult,
        previousParams: previousSessionParams,
        previousDisplayId: runtimeForAdapter.sessionDisplayId,
        previousLegacySessionId: runtimeForAdapter.sessionId,
      });
      const rawUsage = normalizeUsageTotals(adapterResult.usage);
      const sessionUsageResolution = await resolveNormalizedUsageForSession({
        agentId: agent.id,
        runId: run.id,
        sessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        rawUsage,
      });
      const normalizedUsage = sessionUsageResolution.normalizedUsage;
      const forbiddenMarkerScan = buildForbiddenMarkerScan(adapterResult.resultJson ?? null);

      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const adapterWouldHaveSucceeded = (adapterResult.exitCode ?? 0) === 0 && !adapterResult.errorMessage;
      const latestRun = await getRun(run.id);
      if (latestRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (latestRun?.status === "timed_out") {
        outcome = "timed_out";
      } else if (adapterResult.timedOut) {
        outcome = "timed_out";
      } else if (forbiddenMarkerScan.observed && adapterWouldHaveSucceeded) {
        outcome = "failed";
      } else if (adapterWouldHaveSucceeded) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }
      const failureCausedByForbiddenMarker = outcome === "failed" && forbiddenMarkerScan.observed && adapterWouldHaveSucceeded;

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        logSummary = await runLogStore.finalize(handle);
      }

      const status =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "timed_out"
            ? "timed_out"
              : "failed";
      const adapterResultSummary = summarizeHeartbeatRunResultJson(adapterResult.resultJson);
      const persistedResultSummary = summarizeHeartbeatRunResultJson({
        ...(adapterResult.resultJson ?? {}),
        ...(readNonEmptyString(adapterResult.summary) ? { summary: adapterResult.summary } : {}),
      });
      transcriptFallbackResult = {
        ts: new Date().toISOString(),
        model: readNonEmptyString(adapterResult.model),
        output:
          readNonEmptyString(adapterResult.summary)
          ?? readNonEmptyString(adapterResultSummary?.result)
          ?? readNonEmptyString(adapterResultSummary?.summary)
          ?? readNonEmptyString(adapterResultSummary?.message)
          ?? null,
        usage: adapterResult.usage ?? null,
        costUsd: typeof adapterResult.costUsd === "number" ? adapterResult.costUsd : null,
        subtype: status,
        isError: outcome !== "succeeded",
        errors: adapterResult.errorMessage ? [adapterResult.errorMessage] : [],
      };

      const usageJson =
        normalizedUsage || adapterResult.costUsd != null
          ? ({
              ...(normalizedUsage ?? {}),
              ...(rawUsage ? {
                rawInputTokens: rawUsage.inputTokens,
                rawCachedInputTokens: rawUsage.cachedInputTokens,
                rawOutputTokens: rawUsage.outputTokens,
              } : {}),
              ...(sessionUsageResolution.derivedFromSessionTotals ? { usageSource: "session_delta" } : {}),
              ...((nextSessionState.displayId ?? nextSessionState.legacySessionId)
                ? { persistedSessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId }
                : {}),
              sessionReused: sessionReuseScope !== "none",
              taskSessionReused: sessionReuseScope === "task",
              freshSession: sessionReuseScope === "none",
              sessionReuseScope,
              sessionRotated: sessionCompaction.rotate,
              sessionRotationReason: sessionCompaction.reason,
              provider: readNonEmptyString(adapterResult.provider) ?? "unknown",
              biller: resolveLedgerBiller(adapterResult),
              model: readNonEmptyString(adapterResult.model) ?? "unknown",
              ...(adapterResult.costUsd != null ? { costUsd: adapterResult.costUsd } : {}),
              billingType: normalizeLedgerBillingType(adapterResult.billingType),
            } as Record<string, unknown>)
          : null;

      finalizeExecutionTranscript();
      const terminalEvidence = {
        finishedAt: new Date(),
        error:
          outcome === "succeeded"
            ? null
            : redactCurrentUserText(
                failureCausedByForbiddenMarker
                  ? "Forbidden runtime skill marker observed"
                  : adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
                currentUserRedactionOptions,
              ),
        errorCode:
          failureCausedByForbiddenMarker
            ? "runtime_skill_isolation_failed"
            : outcome === "timed_out"
            ? "timeout"
            : outcome === "cancelled"
              ? "cancelled"
              : outcome === "failed"
                ? (adapterResult.errorCode ?? "adapter_failed")
                : null,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        usageJson,
        resultJson: adapterResult.resultJson ?? null,
        resultSummaryJson: persistedResultSummary,
        sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        sessionParamsAfterJson: adapterResult.clearSession ? {} : nextSessionState.params,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      };
      const terminalEffectsIntent = {
        version: 1 as const,
        automation: {
          output: transcriptFallbackResult?.output ?? terminalEvidence.error,
          transcript: executionTranscript,
        },
        runtime: {
          adapterResult: adapterResult as unknown as Record<string, unknown>,
          legacySessionId: nextSessionState.legacySessionId,
          normalizedUsage: normalizedUsage as unknown as Record<string, number> | null,
          ownsTerminal: true,
        },
        ...(taskKey
          ? {
              taskSession: adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)
                ? {
                    operation: "clear" as const,
                    orgId: agent.orgId,
                    agentId: agent.id,
                    agentRuntimeType: agent.agentRuntimeType,
                    taskKey,
                    lastRunId: run.id,
                  }
                : {
                    operation: "upsert" as const,
                    orgId: agent.orgId,
                    agentId: agent.id,
                    agentRuntimeType: agent.agentRuntimeType,
                    taskKey,
                    sessionParamsJson: nextSessionState.params,
                    sessionDisplayId: nextSessionState.displayId,
                    lastRunId: run.id,
                    lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
                  },
            }
          : {}),
      };
      const claimedTerminalRun = await transitionRunToTerminal(run.id, status, terminalEvidence, {
        terminalEffectsIntent,
        processExitedAt: new Date(),
        expectedExecutionOwnerToken: executionOwnerToken,
      });
      ownsTerminalState = Boolean(claimedTerminalRun);
      if (!claimedTerminalRun) {
        await reconcileRunEvidence(run.id, terminalEvidence);
        await reconcileTerminalEffectsIntent(run.id, {
          version: 1,
          automation: terminalEffectsIntent.automation,
          runtime: {
            adapterResult: adapterResult as unknown as Record<string, unknown>,
            legacySessionId: null,
            normalizedUsage: normalizedUsage as unknown as Record<string, number> | null,
            ownsTerminal: false,
          },
        });
      }

      const finalizedRun = claimedTerminalRun ?? await getRun(run.id);
      if (finalizedRun) {
        transcriptFallbackResult.subtype = finalizedRun.status;
        transcriptFallbackResult.isError = finalizedRun.status !== "succeeded";
        if (ownsTerminalState) {
          await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
            finishedAt: new Date(),
            error: failureCausedByForbiddenMarker
              ? "Forbidden runtime skill marker observed"
              : adapterResult.errorMessage ?? null,
          });
        }
        await appendForbiddenMarkerEvent(finalizedRun, forbiddenMarkerScan);
        const transcriptUsedSkills = inferUsedSkillsFromTranscript(executionTranscript);
        if (transcriptUsedSkills.length > 0) {
          await appendRunEvent(finalizedRun, {
            eventType: "adapter.skill_usage",
            stream: "system",
            level: "info",
            message: "skill usage inferred from transcript",
            payload: {
              source: "transcript.skill_usage",
              usedSkillCount: transcriptUsedSkills.length,
              usedSkillKeys: transcriptUsedSkills.map((entry) => entry.key),
              usedSkills: transcriptUsedSkills,
              skillEvidenceType: "used",
              skillEvidenceCount: transcriptUsedSkills.length,
              skillEvidenceKeys: transcriptUsedSkills.map((entry) => entry.key),
              skillEvidenceSkills: transcriptUsedSkills,
            },
          });
        }
        if (ownsTerminalState) {
          await appendRunEvent(finalizedRun, {
            eventType: "lifecycle",
            stream: "system",
            level: outcome === "succeeded" ? "info" : "error",
            message: `run ${outcome}`,
            payload: {
              status,
              exitCode: adapterResult.exitCode,
            },
          });
        }
      }

      if (finalizedRun) {
        if (ownsTerminalState || finalizedRun.terminalEffectsPending) {
          shouldCompleteTerminalEffects = true;
        }
      }
    } catch (err) {
      const isWorkspacePreflightFailure =
        isWorkspacePermissionPreflightError(err) ||
        isManagedWorkspaceConfigurationError(err);
      const message = redactCurrentUserText(
        err instanceof Error ? err.message : "Unknown adapter failure",
        await getCurrentUserRedactionOptions(),
      );
      transcriptFallbackResult = {
        ts: new Date().toISOString(),
        output: message,
        subtype: "failed",
        isError: true,
        errors: [message],
      };
      logger.error({ err, runId }, "heartbeat execution failed");

      const latestRun = await getRun(run.id);
      if (
        latestRun?.status === "succeeded"
        || latestRun?.status === "failed"
        || latestRun?.status === "cancelled"
        || latestRun?.status === "timed_out"
      ) {
        const terminalStatus = latestRun.status as "succeeded" | "failed" | "cancelled" | "timed_out";
        transcriptFallbackResult = {
          ts: new Date().toISOString(),
          output: latestRun.error ?? message,
          subtype: terminalStatus,
          isError: terminalStatus !== "succeeded",
          errors: latestRun.error ? [latestRun.error] : [],
        };
        let lateLogSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
        if (handle) {
          lateLogSummary = await runLogStore.finalize(handle).catch(() => null);
        }
        await reconcileRunEvidence(run.id, {
          stdoutExcerpt,
          stderrExcerpt,
          logBytes: lateLogSummary?.bytes,
          logSha256: lateLogSummary?.sha256,
          logCompressed: lateLogSummary?.compressed,
        });
        if (latestRun.terminalEffectsPending) {
          shouldCompleteTerminalEffects = true;
        }
        return;
      }

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        try {
          logSummary = await runLogStore.finalize(handle);
        } catch (finalizeErr) {
          logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
        }
      }

      const failureEvidence = {
        error: message,
        errorCode: isWorkspacePreflightFailure ? err.errorCode : "adapter_failed",
        finishedAt: new Date(),
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      };
      finalizeExecutionTranscript();
      const failureIntent = {
        version: 1 as const,
        automation: { output: message, transcript: executionTranscript },
        ...(!isWorkspacePreflightFailure
          ? {
              runtime: {
                adapterResult: {
                  exitCode: null,
                  signal: null,
                  timedOut: false,
                  errorMessage: message,
                },
                legacySessionId: runtimeForAdapter.sessionId,
              },
            }
          : {}),
        ...(taskKey && !isWorkspacePreflightFailure && (previousSessionParams || previousSessionDisplayId || taskSession)
          ? {
              taskSession: {
                operation: "upsert" as const,
                orgId: agent.orgId,
                agentId: agent.id,
                agentRuntimeType: agent.agentRuntimeType,
                taskKey,
                sessionParamsJson: previousSessionParams,
                sessionDisplayId: previousSessionDisplayId,
                lastRunId: run.id,
                lastError: message,
              },
            }
          : {}),
      };
      const claimedFailedRun = await transitionRunToTerminal(run.id, "failed", failureEvidence, {
        terminalEffectsIntent: failureIntent,
        processExitedAt: new Date(),
        expectedExecutionOwnerToken: executionOwnerToken,
      });
      ownsTerminalState = Boolean(claimedFailedRun);
      if (!claimedFailedRun) await reconcileRunEvidence(run.id, failureEvidence);
      const failedRun = claimedFailedRun ?? await getRun(run.id);
      if (ownsTerminalState) {
        await setWakeupStatus(run.wakeupRequestId, "failed", {
          finishedAt: new Date(),
          error: message,
        });
      }

      if (failedRun) {
        if (ownsTerminalState) {
          await appendForbiddenMarkerEvent(failedRun, buildForbiddenMarkerScan(null));
          await appendRunEvent(failedRun, {
            eventType: isWorkspacePreflightFailure ? "runtime.workspace_preflight_failed" : "error",
            stream: "system",
            level: "error",
            message,
            ...(isWorkspacePreflightFailure
              ? {
                  payload: {
                    errorCode: err.errorCode,
                    failure: err.failure,
                  },
                }
              : {}),
          });
        }

        if (ownsTerminalState || failedRun.terminalEffectsPending) {
          shouldCompleteTerminalEffects = true;
        }
      }

    } finally {
      finalizeExecutionTranscript();
      finalRunOutput = transcriptFallbackResult?.output ?? null;
      if (ownsTerminalState || shouldCompleteTerminalEffects) {
        const terminalRun = await getRun(run.id).catch(() => null);
        if (terminalRun?.terminalEffectsPending) {
          await acknowledgeRunProcessExit(terminalRun.id);
          await completeTerminalControlEffects(terminalRun, ownsTerminalState
            ? {
                automationOutput: finalRunOutput,
                automationTranscript: executionTranscript,
              }
            : undefined);
        }
      }
    }
    } catch (outerErr) {
          // Setup code before adapter.execute threw (e.g. ensureRuntimeState, resolveWorkspaceForRun).
          // The inner catch did not fire, so we must record the failure here.
          const message = outerErr instanceof Error ? outerErr.message : "Unknown setup failure";
          logger.error({ err: outerErr, runId }, "heartbeat execution setup failed");
          const latestRun = await getRun(runId).catch(() => null);
          const claimedFailedRun = latestRun?.status === "running"
            ? await transitionRunToTerminal(runId, "failed", {
                error: message,
                errorCode: "adapter_failed",
                finishedAt: new Date(),
              }, {
                processExitedAt: new Date(),
                expectedExecutionOwnerToken: executionOwnerToken,
              }).catch(() => undefined)
            : null;
          const terminalRun = claimedFailedRun ?? await getRun(runId).catch(() => latestRun);
          if (claimedFailedRun) {
            await setWakeupStatus(run.wakeupRequestId, "failed", {
              finishedAt: new Date(),
              error: message,
            }).catch(() => undefined);
            // Emit a run-log event so the failure is visible in the run timeline,
            // consistent with what the inner catch block does for adapter failures.
            await appendRunEvent(claimedFailedRun, {
              eventType: "error",
              stream: "system",
              level: "error",
              message,
            }).catch(() => undefined);
          }
          if (terminalRun?.terminalEffectsPending) {
            await acknowledgeRunProcessExit(terminalRun.id).catch(() => undefined);
            await completeTerminalControlEffects(terminalRun).catch(() => undefined);
          }
        } finally {
          if (executionLeaseTimer) clearInterval(executionLeaseTimer);
          await releaseRuntimeServicesForRun(run.id).catch(() => undefined);
          runAbortControllers.delete(run.id);
          activeRunExecutions.delete(run.id);
          await startNextQueuedRunForAgent(run.agentId);
        }
  }

  return { executeRun };
}
