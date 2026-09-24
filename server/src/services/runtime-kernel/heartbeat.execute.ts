// @ts-nocheck
/**
 * @fileoverview Executes claimed heartbeat runs through runtime adapters,
 * workspace realization, transcript persistence, and close-out release.
 *
 * @see doc/product/domains/execution/agent-runs.md - run execution state and evidence
 * @see doc/product/domains/execution/run-admission-and-recovery.md - retry and recovery behavior
 * @see doc/product/domains/agents/instruction-loading.md - AGENT.INSTRUCTIONS.001 runtime instruction frame
 */
import {
  isAgentRuntimeNetworkSuspension,
  type AgentRuntimeApprovalHandle,
  type AgentRuntimeApprovalRequest,
  type TranscriptEntry
} from "@rudderhq/agent-runtime-utils";
import { heartbeatRuns } from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import { createLocalAgentJwt } from "../../agent-auth-jwt.js";
import type {
  AgentRuntimeInvocationMeta,
  UsageSummary
} from "../../agent-runtimes/index.js";
import {
  createProfileBoundRuntimeProviderCapabilityResolverFromConfig,
  findServerAdapter,
  getServerAdapter,
  NATIVE_CHAT_RUNTIME_TYPES,
} from "../../agent-runtimes/index.js";
import { parseObject } from "../../agent-runtimes/utils.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { logger } from "../../middleware/logger.js";
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
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  releaseRuntimeServicesForRun
} from "../workspace-runtime.js";
import {
  ASSIGNMENT_RUN_RECOVERY_BACKOFF_MS,
  formatAssignmentRunGuardrailError
} from "./assignment-run-guardrail.js";
import { createCursorTranscriptSupplementCapture } from "./cursor-transcript-supplement.js";
import {
  beginHeartbeatRunAttempt,
  finishHeartbeatRunAttempt,
  markHeartbeatRunAttemptWaiting,
  type HeartbeatAttemptRef,
} from "./heartbeat-attempt-ledger.js";
import {
  boundNativeHeartbeatTranscriptMemory,
  resolveHeartbeatTranscriptRetention,
  retainNativeHeartbeatResultJson,
  transcriptForHeartbeatRetention,
} from "./heartbeat-transcript-retention.js";
import { createHeartbeatRuntimeDriver } from "./heartbeat.admission.js";
import { prepareHeartbeatRunExecution } from "./heartbeat.execute-context.js";
import {
  executeAdapterWithModelFallbacks,
  resolveExecutionSubmissionPhase,
} from "./model-fallback.js";
import { filterNativeTransportProfile, persistNativeTransportProfile } from "./native-transport-profile.js";
import { createRuntimeApprovalBridge } from "./runtime-approval.js";
import type { RuntimeDriver } from "./runtime-driver.js";
import { markLegacyTranscriptSource } from "./transcript-source.js";
import type { UnifiedAttemptFinishInput } from "./unified-agent-run.js";

export { prioritizeProjectWorkspaceCandidatesForRun, type ResolvedWorkspaceForRun } from "../agent-run-context.js";

import * as heartbeatCore from "./heartbeat.core.js";
import * as heartbeatSessions from "./heartbeat.sessions.js";
const { MAX_LIVE_LOG_CHUNK_BYTES, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, DEFERRED_WAKE_CONTEXT_KEY, DETACHED_PROCESS_ERROR_CODE, ORPHANED_PROCESS_TERMINATION_GRACE_MS, ORPHANED_PROCESS_KILL_WAIT_MS, ORPHANED_PROCESS_POLL_INTERVAL_MS, startLocksByAgent, MAX_RECOVERY_CHAIN_DEPTH, ISSUE_PASSIVE_FOLLOWUP_REASON, ISSUE_PASSIVE_FOLLOWUP_WAKE_SOURCE, ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON, ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS, ISSUE_REVIEW_CLOSEOUT_REASON, ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON, ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS, ISSUE_PASSIVE_FOLLOWUP_COOLDOWN_MS_BY_ATTEMPT, ISSUE_PASSIVE_FOLLOWUP_TIMER_CONTINUITY_MAX_WINDOW_MS, networkWaitBackoffMs, SESSIONED_LOCAL_ADAPTERS, heartbeatRunListColumns, appendExcerpt, appendTranscriptEntriesFromChunk, createHeartbeatTranscriptFinalizer, normalizeMaxConcurrentRuns, withAgentStartLock, readNonEmptyString, buildHeartbeatAdapterInvokePayload, sanitizeStartupContextContextForPersistence, sanitizeStartupContextPromptForPersistence, buildRecentDateKeys, buildDateKeysBetween, fallbackSkillLabel, normalizeLoadedSkill, normalizeLoadedSkillForPayload, emptySkillEvidenceCounts, incrementSkillEvidenceCount, strongestSkillEvidence, resolveSkillEvidence, extractSkillSlugFromPath, collectSkillPathsFromText, collectStringValues, normalizeSkillUseFromPath, dedupeSkillUses, collectSkillUsesFromText, readToolCommandInput, isCommandTranscriptTool, isReadTranscriptTool, inferUsedSkillsFromTranscript, normalizeSkillCandidate, addSkillCandidate, readSkillReferenceSlug, collectSkillReferences, inferUsedSkillsFromPrompt, resolveForbiddenRuntimeSkillMarkers, detectForbiddenRuntimeSkillMarker, normalizeLedgerBillingType, resolveLedgerBiller, normalizeBilledCostCents, resolveLedgerScopeForRun } = heartbeatCore;
const { buildExplicitResumeSessionOverride, selectRunSessionLineage, normalizeUsageTotals, readRawUsageTotals, deriveNormalizedUsageDelta, formatCount, parseSessionCompactionPolicy, resolveRuntimeSessionParamsForWorkspace, parseIssueAssigneeAgentRuntimeOverrides, deriveTaskKey, shouldResetTaskSessionForWake, formatRuntimeWorkspaceWarningLog, describeSessionResetReason, deriveCommentId, enrichWakeContextSnapshot, mergeCoalescedContextSnapshot, issueCommentAuthorKind, issueCommentAuthorLabel, buildDeferredWakePayload, readDeferredWakeContext, readDeferredWakePayload, deriveDeferredWakeTaskKey, hydrateWakeContextSnapshot, firstNonEmptyLine, deriveRecoveryFailureKind, deriveRecoveryFailureSummary, mergeMissingRecoveryContextFields, hydrateRecoveryBaseContextSnapshot, buildRecoveryContextSnapshot, normalizePassiveFollowupContext, normalizeReviewCloseoutContext, passiveFollowupCooldownMs, issueHasReviewer, isAgentEligibleForTimerContinuation, hasCredibleTimerContinuation, buildPassiveFollowupContextSnapshot, runTaskKey, isSameTaskScope, isTrackedLocalChildProcessAdapter, isProcessAlive, waitForProcessExit, terminateOrphanedProcess, truncateDisplayId, normalizeAgentNameKey, defaultSessionCodec, getAgentRuntimeSessionCodec, normalizeSessionParams, resolveNextSessionState } = heartbeatSessions;

function buildPersistableHeartbeatContext(context: Record<string, unknown>) {
  return sanitizeStartupContextContextForPersistence(context) ?? {};
}

const EXECUTOR_OWNED_CONTEXT_KEYS = [
  "executionWorkspaceId",
  "rudderGitIdentity",
  "rudderScene",
  "rudderWorkspace",
  "rudderWorkspaces",
  "rudderStartupContext",
  "rudderStartupContextMetrics",
  "rudderRuntimeServiceIntents",
  "rudderSessionHandoffMarkdown",
  "rudderSessionRotationReason",
  "rudderPreviousSessionId",
  "rudderRuntimeServices",
  "rudderRuntimePrimaryUrl",
  "managedMcpPolicySnapshot",
] as const;

export function createHeartbeatExecuteHandlers(context: any) {
    const { db, approvalsSvc, instanceSettings, getCurrentUserRedactionOptions, runLogStore, runContextSvc, issuesSvc, executionWorkspacesSvc, workspaceOperationsSvc, activeRunExecutions, runAbortControllers, budgetHooks, budgets, getAgent, getRun, getRuntimeState, getTaskSession, getLatestRunForSession, getOldestRunForSession, resolveNormalizedUsageForSession, evaluateSessionCompaction, resolveSessionBeforeForWakeup, resolveExplicitResumeSessionOverride, upsertTaskSession, clearTaskSessions, ensureRuntimeState, setRunStatus, transitionRunToTerminal, reconcileRunEvidence, reconcileTerminalEffectsIntent, setWakeupStatus, updateWakeupRequestRecord, insertWakeupRequestRecord, appendRunEvent, persistRunProcessMetadata, clearDetachedRunWarning, acknowledgeRunProcessExit, abortRunExecution, renewRunExecutionLease, enqueueRecoveryRun, enqueueProcessLossRetry, parseHeartbeatPolicy, markAgentHeartbeatChecked, evaluateTimerPreflight, runHasIssueClosureComment, runHasIssueReviewDecision, issueHasDeferredWake, passiveFollowupAlreadyRecorded, reviewerCloseoutAlreadyRecorded, issueHasRecordedBlockedReviewerDecision, evaluatePassiveIssueClosureForLockedIssue, countRunningRunsForAgent, claimQueuedRun, finalizeAgentStatus, completeTerminalControlEffects, reapOrphanedRuns, resumeQueuedRuns, updateRuntimeState, startNextQueuedRunForAgent, releaseIssueExecutionAndPromote, enqueueWakeup, resumeDeferredWakeupsForAgent, listProjectScopedRunIds, listProjectScopedWakeupIds, cancelPendingWakeupsForBudgetScope, cancelRunInternal, cancelActiveForAgentInternal, cancelBudgetScopeWork, retryRunInternal, buildSkillAnalytics, beforeAssignmentRecoveryEnqueue, ensureCommonRunExecutionBoundary, resolveHeartbeatNativeResources, unifiedRunAdapter } = context;

  async function persistRunningExecutionContext(
    runId: string,
    desiredContext: Record<string, unknown>,
    patch: Partial<typeof heartbeatRuns.$inferInsert> = {},
  ) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select id from heartbeat_runs where id = ${runId} for update`);
      const currentRun = await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (!currentRun || currentRun.status !== "running") return null;

      const persistableContext = buildPersistableHeartbeatContext(desiredContext);
      const mergedContext = mergeCoalescedContextSnapshot(
        persistableContext,
        parseObject(currentRun.contextSnapshot),
      );
      for (const key of EXECUTOR_OWNED_CONTEXT_KEYS) {
        if (Object.prototype.hasOwnProperty.call(persistableContext, key)) {
          mergedContext[key] = persistableContext[key];
        } else {
          delete mergedContext[key];
        }
      }

      return tx
        .update(heartbeatRuns)
        .set({
          ...patch,
          contextSnapshot: mergedContext,
          updatedAt: new Date(),
        })
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")))
        .returning()
        .then((rows) => rows[0] ?? null);
    });
  }

  async function executeRun(runId: string, opts?: { executionReserved?: boolean }) {
    const executionReserved = opts?.executionReserved === true;
    if (executionReserved && !activeRunExecutions.has(runId)) return;
    let run: Awaited<ReturnType<typeof getRun>>;
    let executionLeaseTimer: ReturnType<typeof setInterval> | null = null;
    let executionOwnerToken: string | null = null;
    let commonAttemptEpoch = 1;
    let commonSpanId: string | null = null;
    let commonOwnerFence: {
      id: string;
      ownerToken: string;
      attemptEpoch: number;
      leaseExpiresAt: Date;
    } | null = null;
    let activeRuntimeDriver: RuntimeDriver | null = null;
    const inspectUnifiedEntry = async (attemptId?: string | null) => {
      if (!unifiedRunAdapter) return null;
      if (activeRuntimeDriver) {
        const inspection = await activeRuntimeDriver.inspectExecution({ runId, attemptId });
        return inspection.status === "supported" && inspection.value.state === "found"
          ? inspection.value.entry ?? null
          : null;
      }
      return unifiedRunAdapter.get(runId);
    };
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

    // A queued run is claimed by startNextQueuedRunForAgent before this
    // reserved execution starts. That claim is not recovery: no native span
    // exists yet and this worker is the current owner. Only an unreserved
    // running run represents a handoff from a previous owner.
    const runWasRunningAtEntry = run.status === "running" && !executionReserved;
    if (executionReserved) {
      if (!activeRunExecutions.has(run.id)) return;
    } else {
      if (activeRunExecutions.has(run.id)) return;
      activeRunExecutions.add(run.id);
    }
    const executionAbortController = runAbortControllers.get(run.id) ?? new AbortController();
    runAbortControllers.set(run.id, executionAbortController);
    let activeAttemptRef: HeartbeatAttemptRef | null = null;
    let adapterResultJsonForTerminal: Record<string, unknown> | null = null;
    let networkSuspended = false;
    const finishActiveAttempt = async (input: Record<string, unknown>) => {
      const ref = activeAttemptRef;
      activeAttemptRef = null;
      if (!ref) return;
      if (unifiedRunAdapter && commonSpanId && executionOwnerToken) {
        const current = await inspectUnifiedEntry(ref.id);
        if (
          current
          && current.ownerFence.ownerToken === executionOwnerToken
          && current.ownerFence.attemptEpoch === commonAttemptEpoch
          && current.attempt.ref.id === ref.id
        ) {
          const { status, ...metadata } = input;
          const finished = await unifiedRunAdapter.finishAttempt(
            run.id,
            current.ownerFence,
            status,
            metadata,
          );
          if (!finished.ok) throw new Error(`Unified Run ${run.id} attempt finish rejected: ${finished.reason}`);
          return;
        }
      }
      try {
        await finishHeartbeatRunAttempt(db, ref, input as any);
      } catch (error) {
        logger.warn({ err: error, runId: runId, attemptIndex: ref.attemptIndex }, "failed to persist heartbeat attempt terminal state");
      }
    };
    const currentUnifiedEntry = async () => {
      if (!unifiedRunAdapter || !commonSpanId || !executionOwnerToken) return null;
      const entry = await inspectUnifiedEntry(activeAttemptRef?.id);
      if (
        !entry
        || entry.ownerFence.ownerToken !== executionOwnerToken
        || entry.ownerFence.attemptEpoch !== commonAttemptEpoch
      ) return null;
      return entry;
    };
    const providerIdentityFromResult = (result: Record<string, unknown>) => {
      const payload = result.resultJson && typeof result.resultJson === "object" && !Array.isArray(result.resultJson)
        ? result.resultJson as Record<string, unknown>
        : {};
      const read = (...values: unknown[]) => values.find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )?.trim() ?? null;
      return {
        providerThreadId: read(
          result.providerThreadId,
          result.sessionDisplayId,
          result.sessionId,
          payload.providerThreadId,
          payload.providerSessionId,
          payload.threadId,
        ),
        providerTurnId: read(
          result.providerTurnId,
          payload.providerTurnId,
          payload.turnId,
          payload.executionId,
          payload.messageId,
        ),
      };
    };
    const recordUnifiedAttemptResult = async (
      result: Record<string, unknown>,
      submissionPhase: "pre_submission" | "accepted" | "indeterminate",
    ) => {
      const current = await currentUnifiedEntry();
      if (!current || current.status !== "running") return;
      const provider = providerIdentityFromResult(result);
      const previousSubmission = current.attempt.submission;
      const resolvesUnknownAcceptance = previousSubmission.state === "acceptance_unknown"
        && (submissionPhase === "accepted" || submissionPhase === "pre_submission");
      if (resolvesUnknownAcceptance) {
        const outcome = {
          ...provider,
          submissionKey: previousSubmission.key,
          state: submissionPhase === "accepted" ? "accepted" as const : "rejected" as const,
          ...(submissionPhase === "pre_submission"
            ? { reason: typeof result.errorMessage === "string" ? result.errorMessage : "provider proved the submission was not accepted" }
            : {}),
        };
        if (activeRuntimeDriver) {
          const reconciled = await activeRuntimeDriver.reconcileExecution({
            runId: run.id,
            attemptId: current.attempt.ref.id,
            fence: current.ownerFence,
            outcome,
          });
          if (reconciled.status !== "supported") {
            throw new Error(`Unified Run ${run.id} submission reconciliation rejected: ${reconciled.reason}`);
          }
          if (!reconciled.value.ok) {
            throw new Error(`Unified Run ${run.id} submission reconciliation rejected: ${reconciled.value.reason}`);
          }
        } else {
          const reconciled = await unifiedRunAdapter.reconcileAcceptance(run.id, current.ownerFence, outcome);
          if (!reconciled.ok) throw new Error(`Unified Run ${run.id} submission reconciliation rejected: ${reconciled.reason}`);
        }
      } else if (submissionPhase === "accepted") {
        const accepted = await unifiedRunAdapter.acceptSubmission(run.id, current.ownerFence, provider);
        if (!accepted.ok) throw new Error(`Unified Run ${run.id} submission acceptance rejected: ${accepted.reason}`);
      } else if (submissionPhase === "indeterminate") {
        const unknown = await unifiedRunAdapter.markAcceptanceUnknown(run.id, current.ownerFence, {
          ...provider,
          phase: submissionPhase,
          reason: typeof result.errorMessage === "string" ? result.errorMessage : null,
        });
        if (!unknown.ok) throw new Error(`Unified Run ${run.id} submission uncertainty rejected: ${unknown.reason}`);
      }
      const suspended = Boolean(result.networkSuspension || result.suspension);
      if (!suspended) return;
      const recorded = await unifiedRunAdapter.recordExecutionResult(run.id, current.ownerFence, {
        spanId: current.span.id,
        result: result as any,
        error: Boolean(result.errorMessage) || result.exitCode !== 0 || result.timedOut === true,
        suspended: true,
      });
      if (!recorded.ok) throw new Error(`Unified Run ${run.id} native execution result rejected: ${recorded.reason}`);
      commonSpanId = recorded.value.id;
    };
    const markUnifiedAttemptWaiting = async (input: Record<string, unknown>) => {
      const ref = activeAttemptRef;
      activeAttemptRef = null;
      const current = await currentUnifiedEntry();
      if (current && ref && current.attempt.ref.id === ref.id) {
        const waiting = await unifiedRunAdapter.markAttemptWaiting(run.id, current.ownerFence, input);
        if (!waiting.ok) throw new Error(`Unified Run ${run.id} network wait rejected: ${waiting.reason}`);
        return;
      }
      if (ref) await markHeartbeatRunAttemptWaiting(db, ref, input as any);
    };
    let assignmentContinuationAttempt = Math.max(
      0,
      Math.floor(Number(parseObject(run.contextSnapshot).assignmentGuardrailContinuationAttempt) || 0),
    );

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
      if (runWasRunningAtEntry) {
        const current = run.scene || run.targetType || run.idempotencyKey
          ? await unifiedRunAdapter.get(run.id)
          : null;
        if (current) {
          if (current.ownerFence.ownerToken !== executionOwnerToken) {
            abortRunExecution(run.id);
            return;
          }
          const renewed = await unifiedRunAdapter.renewOwner(run.id, current.ownerFence);
          if (!renewed.ok) {
            abortRunExecution(run.id);
            return;
          }
          commonOwnerFence = renewed.value;
          commonAttemptEpoch = renewed.value.attemptEpoch;
        } else if (!await renewRunExecutionLease(run.id, executionOwnerToken)) {
          abortRunExecution(run.id);
          return;
        }
      } else if (!await renewRunExecutionLease(run.id, executionOwnerToken)) {
        abortRunExecution(run.id);
        return;
      }
      executionLeaseTimer = setInterval(() => {
        const renewal = commonOwnerFence
          ? unifiedRunAdapter.renewOwner(run.id, commonOwnerFence).then((result) => {
              if (!result.ok) return null;
              commonOwnerFence = result.value;
              return result.value;
            })
          : renewRunExecutionLease(run.id, executionOwnerToken);
        void renewal
          .then((renewed) => {
            if (!renewed) abortRunExecution(run.id);
          })
          .catch(() => undefined);
      }, 60_000);
      executionLeaseTimer.unref?.();
      const commonBoundary = await ensureCommonRunExecutionBoundary(
        db,
        run,
        executionOwnerToken,
        commonAttemptEpoch,
      );
      if (commonBoundary) {
        activeAttemptRef = commonBoundary.attemptRef;
        commonSpanId = commonBoundary.spanId;
      }
      const commonEntry = commonBoundary ? await unifiedRunAdapter.get(run.id) : null;
      if (commonEntry && commonEntry.ownerFence.ownerToken === executionOwnerToken) {
        commonOwnerFence = commonEntry.ownerFence;
        commonAttemptEpoch = commonEntry.ownerFence.attemptEpoch;
      }
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
    const cursorTranscriptCapture = createCursorTranscriptSupplementCapture(db, undefined,
      (error) => logger.warn({ err: error, runId }, "failed to seal Cursor transcript supplement"));
    let transcriptRetention = resolveHeartbeatTranscriptRetention({ hasBinding: false });
    let nativeResources: any = null;
    const stdoutTranscriptBuffer = { pending: "", droppingOverlongLine: false };
    const stderrTranscriptBuffer = { pending: "", droppingOverlongLine: false };
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
    let assignmentRecoveryEligible = false;
    let assignmentRecoveryRequestedAt: Date | null = null;
    let activeAttemptSpec: { index: number; fallbackIndex: number | null } | null = null;
    const finalizeExecutionTranscript = createHeartbeatTranscriptFinalizer({
      transcript: executionTranscript,
      stdoutBuffer: stdoutTranscriptBuffer,
      stderrBuffer: stderrTranscriptBuffer,
      stdoutParser: () => stdoutTranscriptParser,
      appendFinalizedStdoutEntries: async (entries) => {
        if (agent.agentRuntimeType === "cursor" && transcriptRetention.mode === "native" && nativeResources) {
          await cursorTranscriptCapture.append({
            orgId: run.orgId,
            runId: run.id,
            spanId: commonSpanId ?? "",
            ownerToken: executionOwnerToken ?? "",
            attemptEpoch: commonAttemptEpoch,
          }, entries).catch((error) => {
            logger.warn({ err: error, runId }, "failed to append Cursor transcript supplement tail");
          });
        }
      },
    });
    const preparedExecution = await prepareHeartbeatRunExecution({
      db,
      run,
      agent,
      assignmentContinuationAttempt,
      ensureRuntimeState,
      getTaskSession,
      evaluateSessionCompaction,
      runContextSvc,
      executionWorkspacesSvc,
      workspaceOperationsSvc,
      issuesSvc,
      persistRunningExecutionContext,
    });
    run = preparedExecution.run;
    assignmentContinuationAttempt = preparedExecution.assignmentContinuationAttempt;
    let assignmentGuardrailCheckpoint = preparedExecution.assignmentGuardrailCheckpoint;
    const {
      context,
      assignmentGuardrailEnabled,
      assignmentFailureBudget,
      taskKey,
      sessionCodec,
      issueId,
      taskSession,
      previousSessionParams,
      config,
      resolvedConfig,
      runtimeConfig,
      runtimeSkillEntries,
      secretKeys,
      issueRef,
      executionWorkspace,
      persistedExecutionWorkspace,
      runtimeWorkspaceWarnings,
      runtimeSceneContext,
      previousSessionDisplayId,
      sessionCompaction,
      sessionReuseScope,
      runtimeForAdapter,
      attemptResumeSource,
      resolveLedgerAttemptIndex,
      recoveryStartAttemptIndex,
      persistAttempt,
    } = preparedExecution;

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
      const runningWithSession = await persistRunningExecutionContext(
        run.id,
        context,
        {
          startedAt,
          runningSubstate: "executing",
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          sessionParamsBeforeJson: runtimeForAdapter.sessionParams,
          sessionReuseScope,
        },
      );
      if (runningWithSession) run = runningWithSession;

      const currentRun = run;
      await appendRunEvent(currentRun, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
      });
      const adapter = getServerAdapter(agent.agentRuntimeType);
      try {
        nativeResources = await resolveHeartbeatNativeResources(db, {
          run,
          runtimeType: agent.agentRuntimeType,
        });
        if (nativeResources) {
          let capabilityStatus: "supported" | "unsupported" | "unknown" = "unknown";
          try {
            const driver = createHeartbeatRuntimeDriver({ db, unifiedRunAdapter }, agent.agentRuntimeType, {
              adapter,
              providerCapabilityResolver: createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
                runtimeType: agent.agentRuntimeType,
                runtimeConfig,
                cwd: executionWorkspace.cwd,
                resolutionMode: "live",
              }),
              providerBinding: {
                id: nativeResources.binding.id,
                orgId: nativeResources.binding.orgId,
                hostId: nativeResources.binding.hostId,
                profileId: nativeResources.binding.profileId,
                workspaceBindingId: nativeResources.binding.workspaceBindingId,
                capabilityRevision: nativeResources.binding.capabilityRevision,
              },
            });
            capabilityStatus = nativeResources.segment.nativeSessionId
              ? driver.capabilities.transcriptRange.status
              : "unknown";
          } catch (error) {
            logger.warn({ err: error, runId: run.id }, "native transcript retention capability could not be resolved");
          }
          transcriptRetention = resolveHeartbeatTranscriptRetention({
            hasBinding: true,
            bindingContinuity: nativeResources.binding.continuity,
            capabilityStatus,
          });
        }
      } catch (error) {
        logger.warn({ err: error, runId: run.id }, "native transcript retention identity could not be resolved");
      }
      // Unified Run identity spans all runtimes; the native chat Driver does not.
      const executeThroughRuntimeDriver = Boolean(
        nativeResources
        && (NATIVE_CHAT_RUNTIME_TYPES as readonly string[]).includes(agent.agentRuntimeType),
      );

      handle = transcriptRetention.persistRawLog
        ? await runLogStore.begin({
        orgId: run.orgId,
        agentId: run.agentId,
        runId,
        append: Boolean(run.logRef),
          })
        : null;

      if (handle) {
        await db
          .update(heartbeatRuns)
          .set({
            logStore: handle.store,
            logRef: handle.logRef,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, runId));
      }
      stdoutTranscriptParser = adapter.parseStdoutLine ?? null;
      const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        const sanitizedChunk = redactCurrentUserText(chunk, currentUserRedactionOptions);
        if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
        if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
        const ts = new Date().toISOString();

        if (handle && transcriptRetention.persistRawLog) {
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
          const before = executionTranscript.length;
          appendTranscriptEntriesFromChunk({
            buffer: stdoutTranscriptBuffer,
            chunk: sanitizedChunk,
            transcript: executionTranscript,
            parser: stdoutTranscriptParser,
            kind: "stdout",
          });
          if (agent.agentRuntimeType === "cursor" && transcriptRetention.mode === "native" && nativeResources) await cursorTranscriptCapture.append({
            orgId: run.orgId, runId: run.id, spanId: commonSpanId ?? "", ownerToken: executionOwnerToken ?? "", attemptEpoch: commonAttemptEpoch,
          }, executionTranscript.slice(before));
          if (!transcriptRetention.persistRawTranscript) boundNativeHeartbeatTranscriptMemory(executionTranscript);
          const checkpoint = assignmentFailureBudget?.observe(executionTranscript) ?? null;
          if (checkpoint && !assignmentGuardrailCheckpoint) {
            const completedWorkSummary = [...executionTranscript]
              .reverse()
              .find((entry) => entry.kind === "assistant" && entry.text.trim())?.text
              .trim()
              .slice(0, 2_000)
              ?? "No reliable completed-work summary was emitted before the guardrail stopped this run.";
            assignmentGuardrailCheckpoint = { ...checkpoint, completedWorkSummary };
            const continuationRequired = assignmentContinuationAttempt < 1
              && assignmentGuardrailCheckpoint.automaticContinuationAllowed;
            await appendRunEvent(currentRun, {
              eventType: "runtime.assignment_guardrail",
              stream: "system",
              level: "warn",
              message: "assignment run failure budget reached; checkpoint requested",
              payload: {
                ...assignmentGuardrailCheckpoint,
                continuationRequired,
              },
            });
            executionAbortController.abort("assignment_run_failure_budget");
          }
          return;
        }

        appendTranscriptEntriesFromChunk({
          buffer: stderrTranscriptBuffer,
          chunk: sanitizedChunk,
          transcript: executionTranscript,
          kind: "stderr",
        });
        if (!transcriptRetention.persistRawTranscript) boundNativeHeartbeatTranscriptMemory(executionTranscript);
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
        await persistRunningExecutionContext(run.id, context);
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
            transcriptRetention,
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
      const requestApproval = async (request: { type: "agent_runtime"; payload: Record<string, unknown> }) => {
        const approval = await approvalsSvc.create(agent.orgId, {
          type: request.type,
          requestedByAgentId: agent.id,
          payload: {
            ...request.payload,
            runId: run.id,
            agentId: agent.id,
            agentRuntimeType: agent.agentRuntimeType,
          },
          status: "pending",
          requestedByUserId: null,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: new Date(),
        });
        await appendRunEvent(run, {
          eventType: "approval.requested",
          stream: "system",
          level: "info",
          message: "agent runtime approval requested",
          payload: { approvalId: approval.id, type: request.type },
        });
        return { id: approval.id, status: approval.status };
      };
      const waitForApproval = async (approvalId: string, timeoutMs: number) => {
        const deadline = Date.now() + Math.max(1_000, Math.min(timeoutMs, 30 * 60_000));
        while (Date.now() < deadline) {
          const currentRun = await getRun(run.id);
          if (executionAbortController.signal.aborted || currentRun?.status !== "running"
            || currentRun.executionOwnerToken !== executionOwnerToken) {
            return { id: approvalId, status: "cancelled" as const, decisionNote: null };
          }
          const approval = await approvalsSvc.getById(approvalId);
          if (!approval || approval.orgId !== run.orgId || approval.requestedByAgentId !== agent.id
            || approval.payload?.runId !== run.id) {
            return { id: approvalId, status: "cancelled" as const, decisionNote: null };
          }
          if (approval && approval.status !== "pending" && approval.status !== "revision_requested") {
            return { id: approval.id, status: approval.status, decisionNote: approval.decisionNote };
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return { id: approvalId, status: "pending" as const, decisionNote: null };
      };
      let approvalRuntimeType = agent.agentRuntimeType;
      const approvalBridge = commonSpanId ? createRuntimeApprovalBridge({
        db,
        approvals: approvalsSvc,
        execution: {
          runId: run.id,
          orgId: run.orgId,
          agentId: agent.id,
          get runtimeType() { return approvalRuntimeType; },
          abortSignal: executionAbortController.signal,
          getFence: () => ({
            spanId: commonSpanId,
            ownerToken: executionOwnerToken,
            attemptEpoch: commonAttemptEpoch,
            attemptId: activeAttemptRef?.id ?? null,
            attemptIndex: activeAttemptRef?.attemptIndex ?? null,
          }),
        },
        onEvent: async (event) => {
          await appendRunEvent(run, {
            eventType: event.eventType,
            stream: "system",
            level: "info",
            message: "agent runtime approval updated",
            payload: event.payload,
            idempotencyKey: event.idempotencyKey,
          });
        },
      }) : { requestApproval, waitForApproval };
      const approvalHandleByRequest = new WeakMap<object, AgentRuntimeApprovalHandle>();
      const pendingApprovalRequests = new Map<string, { request: AgentRuntimeApprovalRequest; driver: RuntimeDriver }>();
      const driverApprovalBridge = {
        requestApproval: async (request: AgentRuntimeApprovalRequest) => {
          const cached = approvalHandleByRequest.get(request);
          return cached ?? approvalBridge.requestApproval(request);
        },
        waitForApproval: (approvalId: string, timeoutMs: number) =>
          approvalBridge.waitForApproval(approvalId, timeoutMs),
      };
      const requestApprovalThroughDriver = async (request: AgentRuntimeApprovalRequest) => {
        const handle = await approvalBridge.requestApproval(request);
        if (activeRuntimeDriver) {
          approvalHandleByRequest.set(request, handle);
          pendingApprovalRequests.set(handle.id, { request, driver: activeRuntimeDriver });
        }
        return handle;
      };
      const waitForApprovalThroughDriver = async (approvalId: string, timeoutMs: number) => {
        const pending = pendingApprovalRequests.get(approvalId);
        if (!pending) return approvalBridge.waitForApproval(approvalId, timeoutMs);
        pendingApprovalRequests.delete(approvalId);
        const response = await pending.driver.respondToRequest(pending.request, timeoutMs);
        if (response.status === "supported") {
          return response.value.decision as Awaited<ReturnType<typeof approvalBridge.waitForApproval>>;
        }
        return approvalBridge.waitForApproval(approvalId, timeoutMs);
      };
      const adapterResult = await executeAdapterWithModelFallbacks(adapter, {
        runId: run.id,
        agent,
        runtime: runtimeForAdapter,
        config: {
          ...runtimeConfig,
          cwd: executionWorkspace.cwd,
        },
        context,
        onNativeTransportProfile: async (profile) => {
          const attempt = activeAttemptRef;
          if (!commonSpanId || !executionOwnerToken || !attempt?.id || !attempt.attemptEpoch) {
            throw new Error("Native transport profile cannot be persisted without a fenced Run span and attempt");
          }
          await persistNativeTransportProfile(db, {
            orgId: run.orgId,
            runId: run.id,
            spanId: commonSpanId,
            ownerToken: executionOwnerToken,
            attemptEpoch: attempt.attemptEpoch,
            attemptId: attempt.id,
            profile: filterNativeTransportProfile(profile),
          });
        },
        onLog,
        onMeta: onAdapterMeta,
        onSpawn: async (meta) => {
          await persistRunProcessMetadata(run.id, meta);
        },
        abortSignal: executionAbortController.signal,
        authToken: authToken ?? undefined,
        requestApproval: requestApprovalThroughDriver,
        waitForApproval: waitForApprovalThroughDriver,
      }, {
        startAttemptIndex: recoveryStartAttemptIndex,
        resolveAdapter: findServerAdapter,
        resolveDriver: (agentRuntimeType, attemptAdapter, attemptContext) => {
          if (!nativeResources) return null;
          const driver = createHeartbeatRuntimeDriver({ db, unifiedRunAdapter }, agentRuntimeType, {
            adapter: attemptAdapter,
            providerCapabilityResolver: createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
              runtimeType: agentRuntimeType,
              runtimeConfig: parseObject(attemptContext.config),
              cwd: executionWorkspace.cwd,
              resolutionMode: "live",
            }),
            providerBinding: {
              id: nativeResources.binding.id,
              orgId: nativeResources.binding.orgId,
              hostId: nativeResources.binding.hostId,
              profileId: nativeResources.binding.profileId,
              workspaceBindingId: nativeResources.binding.workspaceBindingId,
              capabilityRevision: nativeResources.binding.capabilityRevision,
            },
            approvalBridge: driverApprovalBridge,
          });
          if (driver) activeRuntimeDriver = driver;
          return driver;
        },
        // Every admitted native binding uses the common Driver. Chat and Side
        // Chat additionally use submitInputThroughDriver in their direct path;
        // non-Chat runs must not bypass the same Run/Attempt/Span executor.
        executeThroughDriver: executeThroughRuntimeDriver,
        nativeDriverRequired: executeThroughRuntimeDriver,
        createAuthToken: (agentRuntimeType) =>
          createLocalAgentJwt(agent.id, agent.orgId, agentRuntimeType, run.id) ?? undefined,
        onAttemptStart: async (attempt, attemptAdapter) => {
          approvalRuntimeType = attempt.agentRuntimeType ?? agent.agentRuntimeType;
          activeAttemptSpec = {
            index: attempt.index,
            fallbackIndex: attempt.fallbackIndex,
          };
          const ledgerAttemptIndex = resolveLedgerAttemptIndex(attempt);
          const current = await currentUnifiedEntry();
          if (current && unifiedRunAdapter) {
            let next = current;
            if (current.attempt.ref.attemptIndex !== ledgerAttemptIndex) {
              const begun = await unifiedRunAdapter.beginAttempt(run.id, current.ownerFence, {
                attemptIndex: ledgerAttemptIndex,
                fallbackIndex: attempt.fallbackIndex,
                runtimeType: attempt.agentRuntimeType ?? agent.agentRuntimeType,
                model: attempt.model,
                isFallback: attempt.isFallback,
                resumeSource: attemptResumeSource,
              });
              if (!begun.ok) throw new Error(`Unified Run ${run.id} attempt admission rejected: ${begun.reason}`);
              next = await inspectUnifiedEntry() ?? next;
            }
            commonSpanId = next.span.id;
            activeAttemptRef = {
              id: next.attempt.ref.id,
              attemptIndex: next.attempt.ref.attemptIndex,
              ownerToken: next.ownerFence.ownerToken,
              attemptEpoch: next.ownerFence.attemptEpoch,
            };
          } else {
            activeAttemptRef = await persistAttempt("started", () => beginHeartbeatRunAttempt(db, {
              orgId: run.orgId,
              runId: run.id,
              agentId: run.agentId,
              attemptIndex: ledgerAttemptIndex,
              fallbackIndex: attempt.fallbackIndex,
              runtimeType: attempt.agentRuntimeType ?? agent.agentRuntimeType,
              model: attempt.model,
              isFallback: attempt.isFallback,
              resumeSource: attemptResumeSource,
              ownerToken: executionOwnerToken,
              attemptEpoch: commonAttemptEpoch,
            }));
          }
          stdoutTranscriptParser = attemptAdapter.parseStdoutLine ?? null;
        },
        onAttemptResult: async (_attempt, result, submissionPhase) => {
          await recordUnifiedAttemptResult(result as unknown as Record<string, unknown>, submissionPhase);
        },
        onAttemptFailure: async (_attempt, failure) => {
          const failureRecord = failure && typeof failure === "object" ? failure as Record<string, unknown> : null;
          const failureMessage = failure instanceof Error
            ? failure.message
            : readNonEmptyString(failureRecord?.errorMessage) ?? "Adapter fallback attempt failed";
          await finishActiveAttempt({
            status: "failed",
            submissionPhase: failure instanceof Error
              ? "indeterminate"
              : resolveExecutionSubmissionPhase(failure as any),
            errorCode: readNonEmptyString(failureRecord?.errorCode) ?? "adapter_failed",
            error: failureMessage,
            usageDeltaJson: failureRecord?.usage,
            costUsd: failureRecord?.costUsd,
            sessionDisplayId: readNonEmptyString(failureRecord?.sessionDisplayId)
              ?? readNonEmptyString(failureRecord?.sessionId),
            sessionParamsJson: failureRecord?.sessionParams,
          });
        },
      });
      if (assignmentGuardrailCheckpoint) {
        assignmentRecoveryEligible = assignmentContinuationAttempt < 1
          && assignmentGuardrailCheckpoint.automaticContinuationAllowed;
        adapterResult.errorMessage = formatAssignmentRunGuardrailError(
          assignmentGuardrailCheckpoint,
          assignmentRecoveryEligible,
        );
        adapterResult.errorCode = "assignment_run_failure_budget";
        adapterResult.exitCode = adapterResult.exitCode ?? 1;
        adapterResult.resultJson = {
          ...(adapterResult.resultJson ?? {}),
          assignmentGuardrailCheckpoint,
        };
      }
      adapterResultJsonForTerminal = adapterResult.resultJson ?? null;
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
        await persistRunningExecutionContext(run.id, context);
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

      const networkSuspension = isAgentRuntimeNetworkSuspension(adapterResult.networkSuspension)
        ? adapterResult.networkSuspension
        : isAgentRuntimeNetworkSuspension(adapterResult.suspension)
          ? adapterResult.suspension
          : null;
      if (networkSuspension) {
        // A transport suspension is a non-terminal transition. Persist the
        // provider checkpoint before releasing the local execution lease so a
        // restart or another scheduler tick can safely claim this same Run.
        const now = new Date();
        const currentRunForWait = await getRun(run.id);
        const waitAttempt = (currentRunForWait?.networkWaitAttemptCount ?? 0) + 1;
        const backoff = networkWaitBackoffMs(waitAttempt);
        const jitteredBackoff = Math.max(1_000, Math.round(backoff * (0.9 + Math.random() * 0.2)));
        const nextRetryAt = new Date(now.getTime() + jitteredBackoff);
        const checkpoint = {
          kind: networkSuspension.kind,
          code: networkSuspension.code ?? "provider_transport_unavailable",
          transport: networkSuspension.transport,
          provider: networkSuspension.provider ?? adapterResult.provider ?? null,
          model: networkSuspension.model ?? adapterResult.model ?? null,
          submissionPhase: networkSuspension.submissionPhase,
          continuation: networkSuspension.continuation,
          sessionId: networkSuspension.sessionId ?? adapterResult.sessionDisplayId ?? adapterResult.sessionId ?? null,
          sessionParams: networkSuspension.sessionParams ?? adapterResult.sessionParams ?? null,
          progress: networkSuspension.progress ?? {
            modelOutputObserved: networkSuspension.modelOutputObserved,
            toolActivityObserved: networkSuspension.toolActivityObserved,
          },
          modelOutputObserved: networkSuspension.modelOutputObserved
            ?? networkSuspension.progress?.modelOutputObserved
            ?? false,
          toolActivityObserved: networkSuspension.toolActivityObserved
            ?? networkSuspension.progress?.toolActivityObserved
            ?? false,
          sideEffectRisk: networkSuspension.sideEffectRisk ?? null,
          attemptIndex: activeAttemptSpec?.index ?? 0,
          fallbackIndex: activeAttemptSpec?.fallbackIndex ?? null,
          message: networkSuspension.message,
          observedAt: now.toISOString(),
        } satisfies Record<string, unknown>;
        const resumedSessionId = readNonEmptyString(networkSuspension.sessionId)
          ?? readNonEmptyString(adapterResult.sessionDisplayId)
          ?? readNonEmptyString(adapterResult.sessionId)
          ?? previousSessionDisplayId
          ?? null;
        const resumedSessionParams = networkSuspension.sessionParams
          ?? adapterResult.sessionParams
          ?? runtimeForAdapter.sessionParams
          ?? null;
        const waitingAttemptInput = {
          submissionPhase: networkSuspension.submissionPhase,
          providerThreadId: networkSuspension.providerThreadId ?? adapterResult.providerThreadId,
          providerTurnId: networkSuspension.providerTurnId ?? adapterResult.providerTurnId,
          sessionDisplayId: resumedSessionId,
          sessionParamsJson: resumedSessionParams,
          checkpointJson: checkpoint,
          errorCode: networkSuspension.code ?? "provider_transport_unavailable",
          error: networkSuspension.message ?? null,
          suspendedAt: now,
        };
        // The unified adapter still owns the lease at this point. Mark the
        // Attempt waiting before releasing the Run owner below.
        await markUnifiedAttemptWaiting(waitingAttemptInput);
        const waitingRun = await db
          .update(heartbeatRuns)
          .set({
            runningSubstate: "waiting_for_network",
            networkWaitStartedAt: currentRunForWait?.networkWaitStartedAt ?? now,
            networkWaitNextRetryAt: nextRetryAt,
            networkWaitAttemptCount: waitAttempt,
            recoveryCheckpoint: checkpoint,
            sessionIdBefore: resumedSessionId,
            sessionParamsBeforeJson: resumedSessionParams,
            sessionReuseScope: resumedSessionParams || resumedSessionId ? "explicit" : "none",
            processExitedAt: now,
            processPid: null,
            processStartedAt: null,
            executionOwnerToken: null,
            executionLeaseExpiresAt: null,
            updatedAt: now,
          })
          .where(and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.status, "running"),
            ...(executionOwnerToken ? [eq(heartbeatRuns.executionOwnerToken, executionOwnerToken)] : []),
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!waitingRun) return;
        networkSuspended = true;
        await appendRunEvent(waitingRun, {
          eventType: "network.waiting",
          stream: "system",
          level: "info",
          message: "run waiting for network",
          payload: {
            attempt: waitAttempt,
            nextRetryAt: nextRetryAt.toISOString(),
            backoffMs: jitteredBackoff,
            suspension: checkpoint,
          },
        });
        publishLiveEvent({
          orgId: waitingRun.orgId,
          type: "heartbeat.run.status",
          payload: {
            runId: waitingRun.id,
            agentId: waitingRun.agentId,
            status: waitingRun.status,
            executionPhase: "waiting_for_network",
            networkWaitAttemptCount: waitAttempt,
            networkWaitNextRetryAt: nextRetryAt.toISOString(),
          },
        });
        if (handle) {
          await runLogStore.finalize(handle).catch(() => undefined);
          handle = null;
        }
        return;
      }
      const nextSessionState = adapterResult.clearSession
        ? { displayId: null, legacySessionId: null, params: null }
        : resolveNextSessionState({
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
      const persistedResultJson = transcriptRetention.persistRawResult
        ? markLegacyTranscriptSource(adapterResult.resultJson)
        : retainNativeHeartbeatResultJson(adapterResult.resultJson);
      const persistedAdapterResult = transcriptRetention.persistRawResult
        ? adapterResult
        : {
            ...adapterResult,
            resultJson: persistedResultJson,
          };
      const adapterResultSummary = summarizeHeartbeatRunResultJson(adapterResult.resultJson);
      const persistedResultSummary = summarizeHeartbeatRunResultJson({
        ...(persistedResultJson ?? {}),
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

      await finalizeExecutionTranscript();
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
        resultJson: persistedResultJson,
        resultSummaryJson: persistedResultSummary,
        sessionIdAfter: adapterResult.clearSession
          ? null
          : nextSessionState.displayId ?? nextSessionState.legacySessionId,
        sessionParamsAfterJson: adapterResult.clearSession ? {} : nextSessionState.params,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      };
      const automationTerminalEffect = {
        output: transcriptFallbackResult?.output ?? terminalEvidence.error,
        transcript: transcriptForHeartbeatRetention(transcriptRetention, executionTranscript),
        transcriptSource: transcriptRetention.mode,
      };
      const terminalEffectsIntent = {
        version: 1 as const,
        automation: automationTerminalEffect,
        runtime: {
          adapterResult: persistedAdapterResult as unknown as Record<string, unknown>,
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
      const commonAttemptFinished = Boolean(commonSpanId && executionOwnerToken);
      const terminalAttemptInput: UnifiedAttemptFinishInput = {
        submissionPhase: adapterResult.submissionPhase,
        providerThreadId: adapterResult.providerThreadId,
        providerTurnId: adapterResult.providerTurnId,
        sessionDisplayId: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        sessionParamsJson: adapterResult.clearSession ? {} : nextSessionState.params,
        usageDeltaJson: usageJson ?? adapterResult.usage,
        costUsd: adapterResult.costUsd,
        errorCode: terminalEvidence.errorCode,
        error: terminalEvidence.error,
        finishedAt: terminalEvidence.finishedAt,
      };
      const claimedTerminalRun = await transitionRunToTerminal(run.id, status, terminalEvidence, {
        terminalEffectsIntent,
        processExitedAt: new Date(),
        expectedExecutionOwnerToken: executionOwnerToken,
        ...(commonAttemptFinished && commonSpanId
          ? {
              nativeExecution: {
                spanId: commonSpanId,
                result: adapterResult,
                error: status !== "succeeded",
              },
            }
          : {}),
        ...(commonAttemptFinished ? { attempt: terminalAttemptInput } : {}),
      });
      ownsTerminalState = Boolean(claimedTerminalRun);
      if (ownsTerminalState) await cursorTranscriptCapture.seal();
      if (commonAttemptFinished) activeAttemptRef = null;
      if (!commonAttemptFinished) {
        await finishActiveAttempt({
          status,
          submissionPhase: adapterResult.submissionPhase,
          providerThreadId: adapterResult.providerThreadId,
          providerTurnId: adapterResult.providerTurnId,
          sessionDisplayId: nextSessionState.displayId ?? nextSessionState.legacySessionId,
          sessionParamsJson: adapterResult.clearSession ? {} : nextSessionState.params,
          usageDeltaJson: usageJson ?? adapterResult.usage,
          costUsd: adapterResult.costUsd,
          errorCode: terminalEvidence.errorCode,
          error: terminalEvidence.error,
          finishedAt: terminalEvidence.finishedAt,
        });
      }
      if (!claimedTerminalRun) {
        await reconcileRunEvidence(run.id, terminalEvidence);
        await reconcileTerminalEffectsIntent(run.id, {
          version: 1,
          automation: terminalEffectsIntent.automation,
          runtime: {
            adapterResult: persistedAdapterResult as unknown as Record<string, unknown>,
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
        if (ownsTerminalState && assignmentGuardrailCheckpoint) {
          const continuationRequired = assignmentContinuationAttempt < 1
            && assignmentGuardrailCheckpoint.automaticContinuationAllowed;
          await appendRunEvent(finalizedRun, {
            eventType: "runtime.assignment_checkpoint",
            stream: "system",
            level: "warn",
            message: "assignment run checkpoint created",
            payload: {
              completed: assignmentGuardrailCheckpoint.completedWorkSummary,
              unresolvedError: assignmentGuardrailCheckpoint.unresolvedError,
              nextRecoveryCommand: assignmentGuardrailCheckpoint.nextRecoveryCommand,
              continuationRequired,
              failureCount: assignmentGuardrailCheckpoint.failureCount,
              unresolvedFailureCount: assignmentGuardrailCheckpoint.unresolvedFailureCount,
              failureClass: assignmentGuardrailCheckpoint.failureClass,
              continuationBlockReason: assignmentGuardrailCheckpoint.continuationBlockReason,
              fingerprint: assignmentGuardrailCheckpoint.fingerprint,
            },
          });
          if (continuationRequired) {
            const recoveryRequestedAt = new Date(Date.now() + ASSIGNMENT_RUN_RECOVERY_BACKOFF_MS);
            let recoveryRun = null;
            try {
              await beforeAssignmentRecoveryEnqueue?.(finalizedRun);
              recoveryRun = await enqueueRecoveryRun(finalizedRun, agent, {
                recoveryTrigger: "automatic",
                source: "automation",
                triggerDetail: "system",
                wakeReason: "assignment_failure_budget_continuation",
                requestedByActorType: "system",
                requestedByActorId: null,
                contextPatch: {
                  assignmentGuardrailContinuationAttempt: assignmentContinuationAttempt + 1,
                  assignmentGuardrailCheckpoint,
                  assignmentGuardrailRecovery: {
                    attempt: assignmentContinuationAttempt + 1,
                    maxAttempts: 1,
                    backoffMs: ASSIGNMENT_RUN_RECOVERY_BACKOFF_MS,
                    requestedAt: recoveryRequestedAt.toISOString(),
                  },
                },
                startImmediately: false,
                notBefore: recoveryRequestedAt,
                suppressSourceAutomationOutput: true,
                now: new Date(),
              });
            } catch (recoveryError) {
              const recoveryErrorMessage = recoveryError instanceof Error
                ? recoveryError.message
                : "Unknown recovery enqueue failure";
              await appendRunEvent(finalizedRun, {
                eventType: "runtime.assignment_recovery_request_failed",
                stream: "system",
                level: "error",
                message: "bounded assignment recovery request failed",
                payload: {
                  attempt: assignmentContinuationAttempt + 1,
                  maxAttempts: 1,
                  failureClass: assignmentGuardrailCheckpoint.failureClass,
                  error: recoveryErrorMessage,
                },
              });
              logger.error({ err: recoveryError, runId: finalizedRun.id }, "failed to enqueue bounded assignment recovery");
            }
            if (recoveryRun) {
              assignmentRecoveryRequestedAt = recoveryRequestedAt;
              await appendRunEvent(finalizedRun, {
                eventType: "runtime.assignment_recovery_requested",
                stream: "system",
                level: "warn",
                message: "bounded assignment recovery requested",
                payload: {
                  recoveryRunId: recoveryRun.id,
                  attempt: assignmentContinuationAttempt + 1,
                  maxAttempts: 1,
                  backoffMs: ASSIGNMENT_RUN_RECOVERY_BACKOFF_MS,
                  requestedAt: recoveryRequestedAt.toISOString(),
                  failureClass: assignmentGuardrailCheckpoint.failureClass,
                },
              }).catch((eventError) => {
                logger.error({ err: eventError, runId: finalizedRun.id }, "failed to record bounded assignment recovery request");
              });
            }
          }
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
        ...(transcriptRetention.persistRawResult
          ? { resultJson: markLegacyTranscriptSource(adapterResultJsonForTerminal ?? run.resultJson) }
          : {}),
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      };
      await finalizeExecutionTranscript();
      const failureIntent = {
        version: 1 as const,
        automation: {
          output: message,
          transcript: transcriptForHeartbeatRetention(transcriptRetention, executionTranscript),
          transcriptSource: transcriptRetention.mode,
        },
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
      const commonAttemptFinished = Boolean(commonSpanId && executionOwnerToken);
      const currentCommonEntry = commonAttemptFinished
        ? await currentUnifiedEntry().catch(() => null)
        : null;
      const unifiedFailureAttempt: UnifiedAttemptFinishInput = {
        submissionPhase: isWorkspacePreflightFailure
          ? "pre_submission"
          : currentCommonEntry?.attempt.submission.phase ?? "indeterminate",
        providerThreadId: currentCommonEntry?.attempt.submission.providerThreadId,
        providerTurnId: currentCommonEntry?.attempt.submission.providerTurnId,
        sessionDisplayId: previousSessionDisplayId,
        sessionParamsJson: previousSessionParams,
        errorCode: failureEvidence.errorCode,
        error: failureEvidence.error,
        finishedAt: failureEvidence.finishedAt,
      };
      const claimedFailedRun = await transitionRunToTerminal(run.id, "failed", failureEvidence, {
        terminalEffectsIntent: failureIntent,
        processExitedAt: new Date(),
        expectedExecutionOwnerToken: executionOwnerToken,
        ...(commonAttemptFinished ? { attempt: unifiedFailureAttempt } : {}),
      });
      ownsTerminalState = Boolean(claimedFailedRun);
      if (ownsTerminalState) await cursorTranscriptCapture.seal();
      if (commonAttemptFinished) activeAttemptRef = null;
      if (!commonAttemptFinished) {
        await finishActiveAttempt({
          status: "failed",
          errorCode: failureEvidence.errorCode,
          error: failureEvidence.error,
          sessionDisplayId: previousSessionDisplayId,
          sessionParamsJson: previousSessionParams,
          finishedAt: failureEvidence.finishedAt,
        });
      }
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
            eventType: isWorkspacePreflightFailure
              ? "runtime.workspace_preflight_failed"
              : "error",
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
      await finalizeExecutionTranscript();
      finalRunOutput = transcriptFallbackResult?.output ?? null;
      if (ownsTerminalState || shouldCompleteTerminalEffects) {
        const terminalRun = await getRun(run.id).catch(() => null);
        if (terminalRun?.terminalEffectsPending) {
          await acknowledgeRunProcessExit(terminalRun.id);
          await completeTerminalControlEffects(terminalRun, ownsTerminalState
            ? { automationOutput: finalRunOutput }
            : undefined);
          }
        }
      if (assignmentRecoveryRequestedAt) {
        const delayMs = Math.max(0, assignmentRecoveryRequestedAt.getTime() - Date.now());
        const recoveryTimer = setTimeout(() => {
          void startNextQueuedRunForAgent(agent.id).catch((error) => {
            logger.error({ err: error, runId }, "failed to start bounded assignment recovery");
          });
        }, delayMs);
        recoveryTimer.unref?.();
      }
    }
    } catch (outerErr) {
          // Setup code before adapter.execute threw (e.g. ensureRuntimeState, resolveWorkspaceForRun).
          // The inner catch did not fire, so we must record the failure here.
          const message = outerErr instanceof Error ? outerErr.message : "Unknown setup failure";
          logger.error({ err: outerErr, runId }, "heartbeat execution setup failed");
          await finishActiveAttempt({
            status: "failed",
            errorCode: "adapter_failed",
            error: message,
            finishedAt: new Date(),
          });
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
          if (!networkSuspended) await startNextQueuedRunForAgent(run.agentId);
        }
  }

  return { executeRun };
}
