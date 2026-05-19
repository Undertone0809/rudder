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
import type { ParsedIssueAssigneeAgentRuntimeOverrides, UsageTotals, WakeupOptions } from "./heartbeat.core.js";
const { MAX_LIVE_LOG_CHUNK_BYTES, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, DEFERRED_WAKE_CONTEXT_KEY, DETACHED_PROCESS_ERROR_CODE, ORPHANED_PROCESS_TERMINATION_GRACE_MS, ORPHANED_PROCESS_KILL_WAIT_MS, ORPHANED_PROCESS_POLL_INTERVAL_MS, startLocksByAgent, MAX_RECOVERY_CHAIN_DEPTH, ISSUE_PASSIVE_FOLLOWUP_REASON, ISSUE_PASSIVE_FOLLOWUP_WAKE_SOURCE, ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON, ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS, ISSUE_REVIEW_CLOSEOUT_REASON, ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON, ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS, ISSUE_PASSIVE_FOLLOWUP_COOLDOWN_MS_BY_ATTEMPT, ISSUE_PASSIVE_FOLLOWUP_TIMER_CONTINUITY_MAX_WINDOW_MS, SESSIONED_LOCAL_ADAPTERS, heartbeatRunListColumns, appendExcerpt, appendTranscriptEntriesFromChunk, normalizeMaxConcurrentRuns, withAgentStartLock, readNonEmptyString, resolveHeartbeatObservabilitySurface, buildHeartbeatObservationName, compactTraceText, buildIssueRunTraceName, buildHeartbeatRuntimeTraceMetadata, buildHeartbeatAdapterInvokePayload, buildRecentDateKeys, buildDateKeysBetween, fallbackSkillLabel, normalizeLoadedSkill, normalizeLoadedSkillForPayload, emptySkillEvidenceCounts, incrementSkillEvidenceCount, strongestSkillEvidence, resolveSkillEvidence, readSkillEvidenceFromPayload, extractSkillSlugFromPath, collectSkillPathsFromText, collectStringValues, normalizeSkillUseFromPath, dedupeSkillUses, collectSkillUsesFromText, readToolCommandInput, isCommandTranscriptTool, isReadTranscriptTool, inferUsedSkillsFromTranscript, normalizeSkillCandidate, addSkillCandidate, readSkillReferenceSlug, collectSkillReferences, inferUsedSkillsFromPrompt, normalizeLedgerBillingType, resolveLedgerBiller, normalizeBilledCostCents, resolveLedgerScopeForRun } = heartbeatCore;
export type ResumeSessionRow = {
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
};

export function buildExplicitResumeSessionOverride(input: {
  resumeFromRunId: string;
  resumeRunSessionIdBefore: string | null;
  resumeRunSessionIdAfter: string | null;
  taskSession: ResumeSessionRow | null;
  sessionCodec: AgentRuntimeSessionCodec;
}) {
  const desiredDisplayId = truncateDisplayId(
    input.resumeRunSessionIdAfter ?? input.resumeRunSessionIdBefore,
  );
  const taskSessionParams = normalizeSessionParams(
    input.sessionCodec.deserialize(input.taskSession?.sessionParamsJson ?? null),
  );
  const taskSessionDisplayId = truncateDisplayId(
    input.taskSession?.sessionDisplayId ??
      (input.sessionCodec.getDisplayId ? input.sessionCodec.getDisplayId(taskSessionParams) : null) ??
      readNonEmptyString(taskSessionParams?.sessionId),
  );
  const canReuseTaskSessionParams =
    input.taskSession != null &&
    (
      input.taskSession.lastRunId === input.resumeFromRunId ||
      (!!desiredDisplayId && taskSessionDisplayId === desiredDisplayId)
    );
  const sessionParams =
    canReuseTaskSessionParams
      ? taskSessionParams
      : desiredDisplayId
        ? { sessionId: desiredDisplayId }
        : null;
  const sessionDisplayId = desiredDisplayId ?? (canReuseTaskSessionParams ? taskSessionDisplayId : null);

  if (!sessionDisplayId && !sessionParams) return null;
  return {
    sessionDisplayId,
    sessionParams,
  };
}

export function normalizeUsageTotals(usage: UsageSummary | null | undefined): UsageTotals | null {
  if (!usage) return null;
  return {
    inputTokens: Math.max(0, Math.floor(asNumber(usage.inputTokens, 0))),
    cachedInputTokens: Math.max(0, Math.floor(asNumber(usage.cachedInputTokens, 0))),
    outputTokens: Math.max(0, Math.floor(asNumber(usage.outputTokens, 0))),
  };
}

export function readRawUsageTotals(usageJson: unknown): UsageTotals | null {
  const parsed = parseObject(usageJson);
  if (Object.keys(parsed).length === 0) return null;

  const inputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0))),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawCachedInputTokens, asNumber(parsed.cachedInputTokens, 0))),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0))),
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

export function deriveNormalizedUsageDelta(current: UsageTotals | null, previous: UsageTotals | null): UsageTotals | null {
  if (!current) return null;
  if (!previous) return { ...current };

  const inputTokens = current.inputTokens >= previous.inputTokens
    ? current.inputTokens - previous.inputTokens
    : current.inputTokens;
  const cachedInputTokens = current.cachedInputTokens >= previous.cachedInputTokens
    ? current.cachedInputTokens - previous.cachedInputTokens
    : current.cachedInputTokens;
  const outputTokens = current.outputTokens >= previous.outputTokens
    ? current.outputTokens - previous.outputTokens
    : current.outputTokens;

  return {
    inputTokens: Math.max(0, inputTokens),
    cachedInputTokens: Math.max(0, cachedInputTokens),
    outputTokens: Math.max(0, outputTokens),
  };
}

export function formatCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

export function parseSessionCompactionPolicy(agent: typeof agents.$inferSelect): SessionCompactionPolicy {
  return resolveSessionCompactionPolicy(agent.agentRuntimeType, agent.runtimeConfig).policy;
}

export function resolveRuntimeSessionParamsForWorkspace(input: {
  orgId: string;
  agent: {
    id: string;
    name?: string | null;
    workspaceKey?: string | null;
  };
  previousSessionParams: Record<string, unknown> | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
}) {
  const { orgId, agent, previousSessionParams, resolvedWorkspace } = input;
  const previousSessionId = readNonEmptyString(previousSessionParams?.sessionId);
  if (!previousSessionId) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const canonicalAgentCwd = readNonEmptyString(resolvedWorkspace.cwd) ?? resolveDefaultAgentWorkspaceDir(orgId, agent);
  if (!canonicalAgentCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (previousCwd && path.resolve(previousCwd) === path.resolve(canonicalAgentCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousWorkspaceId = readNonEmptyString(previousSessionParams?.workspaceId);

  const migratedSessionParams: Record<string, unknown> = {
    ...(previousSessionParams ?? {}),
    cwd: canonicalAgentCwd,
  };
  if (
    !previousWorkspaceId ||
    !resolvedWorkspace.workspaceId ||
    previousWorkspaceId === resolvedWorkspace.workspaceId
  ) {
    if (resolvedWorkspace.workspaceId) migratedSessionParams.workspaceId = resolvedWorkspace.workspaceId;
    if (resolvedWorkspace.repoUrl) migratedSessionParams.repoUrl = resolvedWorkspace.repoUrl;
    if (resolvedWorkspace.repoRef) migratedSessionParams.repoRef = resolvedWorkspace.repoRef;
  }

  return {
    sessionParams: migratedSessionParams,
    warning:
      previousCwd
        ? `Agent workspace "${canonicalAgentCwd}" is now the canonical run workspace. ` +
          `Attempting to resume session "${previousSessionId}" that was previously saved in "${previousCwd}".`
        : `Agent workspace "${canonicalAgentCwd}" is now the canonical run workspace. ` +
          `Attempting to resume session "${previousSessionId}" with the canonical agent workspace attached.`,
  };
}

export function parseIssueAssigneeAgentRuntimeOverrides(
  raw: unknown,
): ParsedIssueAssigneeAgentRuntimeOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.agentRuntimeConfig);
  const agentRuntimeConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!agentRuntimeConfig && useProjectWorkspace === null) return null;
  return {
    agentRuntimeConfig,
    useProjectWorkspace,
  };
}

export function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return true;
  return false;
}

export function formatRuntimeWorkspaceWarningLog(warning: string) {
  return {
    stream: "stdout" as const,
    chunk: `[rudder] ${warning}\n`,
  };
}

export function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return "forceFreshSession was requested";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  return null;
}

export function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

export function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload = readNonEmptyString(payload?.["issueId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

export function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const commentId = deriveCommentId(incoming, null);
  if (commentId) {
    merged.commentId = commentId;
    merged.wakeCommentId = commentId;
  }
  return merged;
}

export function issueCommentAuthorKind(comment: {
  authorAgentId?: string | null;
  authorUserId?: string | null;
}) {
  if (comment.authorAgentId) return "agent";
  if (comment.authorUserId) return "user";
  return "system";
}

export function issueCommentAuthorLabel(comment: {
  authorAgentId?: string | null;
  authorUserId?: string | null;
  authorAgentName?: string | null;
  authorUserName?: string | null;
}) {
  if (comment.authorAgentId) {
    return comment.authorAgentName?.trim() || `Agent ${comment.authorAgentId.slice(0, 8)}`;
  }
  if (comment.authorUserId) {
    return comment.authorUserName?.trim() || `User ${comment.authorUserId.slice(0, 8)}`;
  }
  return "System";
}

export function buildDeferredWakePayload(
  payload: Record<string, unknown> | null,
  contextSnapshot: Record<string, unknown>,
  issueId?: string | null,
) {
  const deferredPayload: Record<string, unknown> = { ...(payload ?? {}) };
  if (issueId && !readNonEmptyString(deferredPayload.issueId)) {
    deferredPayload.issueId = issueId;
  }
  deferredPayload[DEFERRED_WAKE_CONTEXT_KEY] = contextSnapshot;
  return deferredPayload;
}

export function readDeferredWakeContext(payloadRaw: unknown) {
  const payload = parseObject(payloadRaw);
  return parseObject(payload[DEFERRED_WAKE_CONTEXT_KEY]);
}

export function readDeferredWakePayload(payloadRaw: unknown) {
  const payload = parseObject(payloadRaw);
  delete payload[DEFERRED_WAKE_CONTEXT_KEY];
  return payload;
}

export function deriveDeferredWakeTaskKey(payloadRaw: unknown) {
  const payload = readDeferredWakePayload(payloadRaw);
  const contextSnapshot = readDeferredWakeContext(payloadRaw);
  return deriveTaskKey(contextSnapshot, payload);
}

export async function hydrateWakeContextSnapshot(
  db: Db,
  orgId: string,
  contextSnapshot: Record<string, unknown>,
) {
  const issueId = readNonEmptyString(contextSnapshot.issueId);
  const commentId = deriveCommentId(contextSnapshot, null);
  const issueContext = parseObject(contextSnapshot.issue);
  const commentContext = parseObject(contextSnapshot.comment);
  const needsIssueContext =
    !!issueId &&
    (
      !readNonEmptyString(issueContext.id) ||
      !readNonEmptyString(issueContext.title) ||
      !readNonEmptyString(issueContext.status) ||
      !("priority" in issueContext) ||
      !("description" in issueContext)
    );
  const needsProjectId = !!issueId && !readNonEmptyString(contextSnapshot.projectId);
  const needsCommentContext =
    !!commentId &&
    (
      !readNonEmptyString(commentContext.id) ||
      !readNonEmptyString(commentContext.body) ||
      !readNonEmptyString(commentContext.authorKind) ||
      !readNonEmptyString(commentContext.authorLabel) ||
      !readNonEmptyString(commentContext.createdAt)
    );

  if (!needsIssueContext && !needsProjectId && !needsCommentContext) return;

  if (issueId && (needsIssueContext || needsProjectId)) {
    const issueRow = await db
      .select({
        id: issues.id,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
        projectId: issues.projectId,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.orgId, orgId)))
      .then((rows) => rows[0] ?? null);

    if (issueRow) {
      contextSnapshot.issue = {
        ...issueContext,
        id: readNonEmptyString(issueContext.id) ?? issueRow.id,
        title: readNonEmptyString(issueContext.title) ?? issueRow.title,
        description: "description" in issueContext ? issueContext.description : issueRow.description,
        status: readNonEmptyString(issueContext.status) ?? issueRow.status,
        priority: "priority" in issueContext ? issueContext.priority : issueRow.priority,
      };
      if (!readNonEmptyString(contextSnapshot.projectId) && issueRow.projectId) {
        contextSnapshot.projectId = issueRow.projectId;
      }
    }
  }

  if (commentId && needsCommentContext) {
    const commentConditions = [eq(issueComments.id, commentId), eq(issueComments.orgId, orgId)];
    if (issueId) {
      commentConditions.push(eq(issueComments.issueId, issueId));
    }
    const commentRow = await db
      .select({
        id: issueComments.id,
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        authorAgentName: agents.name,
        authorUserName: authUsers.name,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .leftJoin(agents, eq(issueComments.authorAgentId, agents.id))
      .leftJoin(authUsers, eq(issueComments.authorUserId, authUsers.id))
      .where(and(...commentConditions))
      .then((rows) => rows[0] ?? null);

    if (commentRow) {
      contextSnapshot.comment = {
        ...commentContext,
        id: readNonEmptyString(commentContext.id) ?? commentRow.id,
        body: readNonEmptyString(commentContext.body) ?? commentRow.body,
        authorAgentId: "authorAgentId" in commentContext ? commentContext.authorAgentId : commentRow.authorAgentId,
        authorUserId: "authorUserId" in commentContext ? commentContext.authorUserId : commentRow.authorUserId,
        authorKind: readNonEmptyString(commentContext.authorKind) ?? issueCommentAuthorKind(commentRow),
        authorLabel: readNonEmptyString(commentContext.authorLabel) ?? issueCommentAuthorLabel(commentRow),
        createdAt: readNonEmptyString(commentContext.createdAt) ?? commentRow.createdAt.toISOString(),
      };
    }
  }
}

export function firstNonEmptyLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value
    .split("\n")
    .map((chunk) => chunk.trim())
    .find(Boolean);
  return line ?? null;
}

export function deriveRecoveryFailureKind(run: typeof heartbeatRuns.$inferSelect): string {
  return (
    readNonEmptyString(run.errorCode) ??
    (run.status === "timed_out" ? "timed_out" : null) ??
    run.status
  );
}

export function deriveRecoveryFailureSummary(run: typeof heartbeatRuns.$inferSelect): string {
  return (
    firstNonEmptyLine(run.error) ??
    firstNonEmptyLine(run.stderrExcerpt) ??
    firstNonEmptyLine(run.stdoutExcerpt) ??
    (run.status === "timed_out" ? "The run timed out before it completed." : null) ??
    "The previous run failed before it completed."
  );
}

export function mergeMissingRecoveryContextFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
) {
  const keysToBackfill = [
    "issueId",
    "taskId",
    "taskKey",
    "projectId",
    "projectWorkspaceId",
    "commentId",
    "wakeCommentId",
    "issue",
    "comment",
    "source",
    "wakeSource",
    "wakeTriggerDetail",
  ] as const;

  for (const key of keysToBackfill) {
    if (!(key in target) || target[key] === null || target[key] === undefined || target[key] === "") {
      const value = source[key];
      if (value !== null && value !== undefined && value !== "") {
        target[key] = value;
      }
    }
  }
}

export async function hydrateRecoveryBaseContextSnapshot(
  run: typeof heartbeatRuns.$inferSelect,
  getRunById: (runId: string) => Promise<typeof heartbeatRuns.$inferSelect | null>,
) {
  const mergedContext = { ...parseObject(run.contextSnapshot) };
  let ancestorRunId = readNonEmptyString(run.retryOfRunId);
  let depth = 0;

  while (ancestorRunId && depth < MAX_RECOVERY_CHAIN_DEPTH) {
    const ancestorRun = await getRunById(ancestorRunId);
    if (!ancestorRun) break;
    mergeMissingRecoveryContextFields(mergedContext, parseObject(ancestorRun.contextSnapshot));
    ancestorRunId = readNonEmptyString(ancestorRun.retryOfRunId);
    depth += 1;
  }

  return mergedContext;
}

export function buildRecoveryContextSnapshot(input: {
  baseContextSnapshot: Record<string, unknown>;
  run: typeof heartbeatRuns.$inferSelect;
  recoveryTrigger: HeartbeatRecoveryTrigger;
  wakeReason: string;
  wakeSource: string;
  triggerDetail: NonNullable<WakeupOptions["triggerDetail"]>;
}): Record<string, unknown> {
  const { baseContextSnapshot, run, recoveryTrigger, wakeReason, wakeSource, triggerDetail } = input;
  const failureKind = deriveRecoveryFailureKind(run);
  const failureSummary = deriveRecoveryFailureSummary(run);
  const recovery: HeartbeatRunRecoveryContext = {
    originalRunId: run.id,
    failureKind,
    failureSummary,
    recoveryTrigger,
    recoveryMode: "continue_preferred",
  };

  return {
    ...baseContextSnapshot,
    wakeReason,
    wakeSource,
    wakeTriggerDetail: triggerDetail,
    retryOfRunId: run.id,
    retryReason: failureKind,
    recovery,
  };
}

export type PassiveFollowupIssueRow = Pick<
  typeof issues.$inferSelect,
  | "id"
  | "orgId"
  | "identifier"
  | "title"
  | "description"
  | "status"
  | "priority"
  | "projectId"
  | "assigneeAgentId"
  | "reviewerAgentId"
  | "reviewerUserId"
>;

export type PassiveFollowupContext = {
  originRunId: string;
  previousRunId: string | null;
  attempt: number;
  maxAttempts: number;
  reason: typeof ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON;
  queuedAt: string | null;
};

export type ReviewCloseoutContext = {
  originRunId: string;
  previousRunId: string | null;
  attempt: number;
  maxAttempts: number;
  reason: typeof ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON;
};

export type PassiveIssueClosureOutcome =
  | { kind: "none"; reason: string }
  | {
      kind: "queued";
      run: typeof heartbeatRuns.$inferSelect;
      issue: PassiveFollowupIssueRow;
      originRunId: string;
      previousRunId: string;
      attempt: number;
      requestedAt: Date;
    }
  | {
      kind: "operator_review";
      issue: PassiveFollowupIssueRow;
      originRunId: string;
      previousRunId: string;
      attempts: number;
      reason: typeof ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON;
    }
  | {
      kind: "reviewer_convergence";
      issue: PassiveFollowupIssueRow;
      originRunId: string;
      previousRunId: string;
      attempts: number;
      reason: typeof ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON;
    }
  | {
      kind: "reviewer_closeout";
      issue: PassiveFollowupIssueRow;
      originRunId: string;
      previousRunId: string;
      attempts: number;
      maxAttempts: number;
      reason: typeof ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON;
    }
  | {
      kind: "reviewer_closeout_operator_review";
      issue: PassiveFollowupIssueRow;
      originRunId: string;
      previousRunId: string;
      attempts: number;
      maxAttempts: number;
      reason: typeof ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON;
    };

export function normalizePassiveFollowupContext(raw: unknown): PassiveFollowupContext | null {
  const parsed = parseObject(raw);
  const originRunId = readNonEmptyString(parsed.originRunId);
  if (!originRunId) return null;
  const attempt = Math.max(0, Math.floor(asNumber(parsed.attempt, 0)));
  return {
    originRunId,
    previousRunId: readNonEmptyString(parsed.previousRunId),
    attempt,
    maxAttempts: Math.max(1, Math.floor(asNumber(parsed.maxAttempts, ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS))),
    reason: ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON,
    queuedAt: readNonEmptyString(parsed.queuedAt),
  };
}

export function normalizeReviewCloseoutContext(raw: unknown): ReviewCloseoutContext | null {
  const parsed = parseObject(raw);
  const originRunId = readNonEmptyString(parsed.originRunId);
  if (!originRunId) return null;
  const attempt = Math.max(0, Math.floor(asNumber(parsed.attempt, 0)));
  return {
    originRunId,
    previousRunId: readNonEmptyString(parsed.previousRunId),
    attempt,
    maxAttempts: Math.max(1, Math.floor(asNumber(parsed.maxAttempts, ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS))),
    reason: ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON,
  };
}

export function passiveFollowupCooldownMs(attempt: number) {
  return ISSUE_PASSIVE_FOLLOWUP_COOLDOWN_MS_BY_ATTEMPT.get(attempt) ?? 5 * 60 * 1000;
}

export function issueHasReviewer(issue: Pick<PassiveFollowupIssueRow, "reviewerAgentId" | "reviewerUserId">) {
  return Boolean(issue.reviewerAgentId || issue.reviewerUserId);
}

export function isAgentEligibleForTimerContinuation(agent: typeof agents.$inferSelect) {
  return (
    agent.status !== "paused" &&
    agent.status !== "terminated" &&
    agent.status !== "pending_approval"
  );
}

export function hasCredibleTimerContinuation(input: {
  agent: typeof agents.$inferSelect;
  policy: { enabled: boolean; intervalSec: number };
  run: typeof heartbeatRuns.$inferSelect;
  now: Date;
}) {
  if (!input.policy.enabled || input.policy.intervalSec <= 0) return false;
  if (!isAgentEligibleForTimerContinuation(input.agent)) return false;

  const intervalMs = input.policy.intervalSec * 1000;
  const nearTermWindowMs = Math.min(
    intervalMs * 2,
    ISSUE_PASSIVE_FOLLOWUP_TIMER_CONTINUITY_MAX_WINDOW_MS,
  );
  const lastHeartbeatMs = input.agent.lastHeartbeatAt
    ? new Date(input.agent.lastHeartbeatAt).getTime()
    : new Date(input.agent.createdAt).getTime();
  const runFinishedMs = input.run.finishedAt
    ? new Date(input.run.finishedAt).getTime()
    : input.now.getTime();
  const baselineMs = Math.max(lastHeartbeatMs, runFinishedMs);
  const nextTimerMs = baselineMs + intervalMs;
  return Math.max(0, nextTimerMs - input.now.getTime()) <= nearTermWindowMs;
}

export function buildPassiveFollowupContextSnapshot(input: {
  run: typeof heartbeatRuns.$inferSelect;
  issue: PassiveFollowupIssueRow;
  originRunId: string;
  attempt: number;
  now: Date;
}) {
  const baseContext = { ...parseObject(input.run.contextSnapshot) };
  delete baseContext.recovery;
  delete baseContext.retryOfRunId;
  delete baseContext.retryReason;

  const taskKey = deriveTaskKey(baseContext, { issueId: input.issue.id }) ?? input.issue.id;
  return {
    ...baseContext,
    issueId: input.issue.id,
    taskId: input.issue.id,
    taskKey,
    projectId: readNonEmptyString(baseContext.projectId) ?? input.issue.projectId ?? undefined,
    wakeReason: ISSUE_PASSIVE_FOLLOWUP_REASON,
    wakeSource: ISSUE_PASSIVE_FOLLOWUP_WAKE_SOURCE,
    wakeTriggerDetail: "system",
    issue: {
      id: input.issue.id,
      title: input.issue.title,
      description: input.issue.description,
      status: input.issue.status,
      priority: input.issue.priority,
    },
    passiveFollowup: {
      originRunId: input.originRunId,
      previousRunId: input.run.id,
      attempt: input.attempt,
      maxAttempts: ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS,
      reason: ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON,
      queuedAt: input.now.toISOString(),
    },
    ...(issueHasReviewer(input.issue)
      ? {
          reviewGate: {
            reviewerAgentId: input.issue.reviewerAgentId,
            reviewerUserId: input.issue.reviewerUserId,
            closeOutRequirement:
              "Move the issue to in_review when work is ready, or to blocked/cancelled if it cannot proceed.",
          },
        }
      : {}),
  };
}

export function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

export function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

export function isTrackedLocalChildProcessAdapter(agentRuntimeType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(agentRuntimeType);
}

// A positive liveness check means some process currently owns the PID.
// On Linux, PIDs can be recycled, so this is a best-effort signal rather
// than proof that the original child is still alive.
export function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

export async function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, ORPHANED_PROCESS_POLL_INTERVAL_MS));
  }
  return !isProcessAlive(pid);
}

export async function terminateOrphanedProcess(pid: number): Promise<{
  stillAlive: boolean;
  terminationSignal: NodeJS.Signals | null;
  error: string | null;
}> {
  if (!isProcessAlive(pid)) {
    return {
      stillAlive: false,
      terminationSignal: null,
      error: null,
    };
  }

  let terminationSignal: NodeJS.Signals | null = null;

  try {
    process.kill(pid, "SIGTERM");
    terminationSignal = "SIGTERM";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") {
      return {
        stillAlive: false,
        terminationSignal: null,
        error: null,
      };
    }
    return {
      stillAlive: isProcessAlive(pid),
      terminationSignal,
      error: `SIGTERM failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (await waitForProcessExit(pid, ORPHANED_PROCESS_TERMINATION_GRACE_MS)) {
    return {
      stillAlive: false,
      terminationSignal,
      error: null,
    };
  }

  try {
    process.kill(pid, "SIGKILL");
    terminationSignal = "SIGKILL";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ESRCH") {
      return {
        stillAlive: false,
        terminationSignal,
        error: null,
      };
    }
    return {
      stillAlive: isProcessAlive(pid),
      terminationSignal,
      error: `SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const exitedAfterKill = await waitForProcessExit(pid, ORPHANED_PROCESS_KILL_WAIT_MS);
  return {
    stillAlive: !exitedAfterKill,
    terminationSignal,
    error: exitedAfterKill ? null : `Timed out waiting for child pid ${pid} to exit after ${terminationSignal}`,
  };
}

export function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

export function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export const defaultSessionCodec: AgentRuntimeSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

export function getAgentRuntimeSessionCodec(agentRuntimeType: string) {
  const adapter = getServerAdapter(agentRuntimeType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

export function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

export function resolveNextSessionState(input: {
  codec: AgentRuntimeSessionCodec;
  adapterResult: AgentRuntimeExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

