import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, gt, gte, inArray, lte, sql } from "drizzle-orm";
import type { TranscriptEntry } from "@rudder/agent-runtime-utils";
import type { Db } from "@rudder/db";
import type {
  AgentSkillAnalytics,
  BillingType,
  ExecutionObservabilityContext,
  ExecutionObservabilitySurface,
  HeartbeatRecoveryTrigger,
  HeartbeatRunRecoveryContext,
} from "@rudder/shared";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "@rudder/db";
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
import { getServerAdapter, runningProcesses } from "../../agent-runtimes/index.js";
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
import { executionWorkspaceService } from "../execution-workspaces.js";
import { buildObservedRunLangfuseScores } from "../run-intelligence.js";
import { workspaceOperationService } from "../workspace-operations.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "../execution-workspace-policy.js";
import { instanceSettingsService } from "../instance-settings.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../../log-redaction.js";
import {
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "@rudder/agent-runtime-utils";
import {
  buildCreateAgentBenchmarkTags,
  coerceCreateAgentBenchmarkMetadata,
  extractCreateAgentBenchmarkMetadata,
} from "@rudder/run-intelligence-core";

export { prioritizeProjectWorkspaceCandidatesForRun, type ResolvedWorkspaceForRun } from "../agent-run-context.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const DETACHED_PROCESS_ERROR_CODE = "process_detached";
const ORPHANED_PROCESS_TERMINATION_GRACE_MS = 2_000;
const ORPHANED_PROCESS_KILL_WAIT_MS = 500;
const ORPHANED_PROCESS_POLL_INTERVAL_MS = 100;
const startLocksByAgent = new Map<string, Promise<void>>();
const MAX_RECOVERY_CHAIN_DEPTH = 8;
const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

const heartbeatRunListColumns = {
  id: heartbeatRuns.id,
  orgId: heartbeatRuns.orgId,
  agentId: heartbeatRuns.agentId,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  wakeupRequestId: heartbeatRuns.wakeupRequestId,
  exitCode: heartbeatRuns.exitCode,
  signal: heartbeatRuns.signal,
  usageJson: heartbeatRuns.usageJson,
  resultJson: heartbeatRuns.resultJson,
  sessionIdBefore: heartbeatRuns.sessionIdBefore,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  logStore: heartbeatRuns.logStore,
  logRef: heartbeatRuns.logRef,
  logBytes: heartbeatRuns.logBytes,
  logSha256: heartbeatRuns.logSha256,
  logCompressed: heartbeatRuns.logCompressed,
  stdoutExcerpt: sql<string | null>`NULL`.as("stdoutExcerpt"),
  stderrExcerpt: sql<string | null>`NULL`.as("stderrExcerpt"),
  errorCode: heartbeatRuns.errorCode,
  externalRunId: heartbeatRuns.externalRunId,
  processPid: heartbeatRuns.processPid,
  processStartedAt: heartbeatRuns.processStartedAt,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  processLossRetryCount: heartbeatRuns.processLossRetryCount,
  contextSnapshot: heartbeatRuns.contextSnapshot,
  createdAt: heartbeatRuns.createdAt,
  updatedAt: heartbeatRuns.updatedAt,
} as const;

function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

function appendTranscriptEntriesFromChunk(input: {
  buffer: string;
  chunk: string;
  transcript: TranscriptEntry[];
  finalize?: boolean;
  parser?: ((line: string, ts: string) => TranscriptEntry[]) | null;
  kind: "stdout" | "stderr";
}) {
  const combined = `${input.buffer}${input.chunk}`;
  const lines = combined.split(/\r?\n/);
  const trailing = lines.pop() ?? "";
  const completeLines = input.finalize && trailing ? [...lines, trailing] : lines;

  for (const line of completeLines) {
    if (!line.trim()) continue;
    const ts = new Date().toISOString();
    const parsed = input.parser ? input.parser(line, ts) : [];
    if (parsed.length > 0) {
      input.transcript.push(...parsed);
      continue;
    }
    input.transcript.push({
      kind: input.kind,
      ts,
      text: line,
    });
  }

  return input.finalize ? "" : trailing;
}

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  const run = previous.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
  existingWakeupRequestId?: string | null;
}

type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  previousRunId: string | null;
};

interface ParsedIssueAssigneeAgentRuntimeOverrides {
  agentRuntimeConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function resolveHeartbeatObservabilitySurface(
  contextSnapshot: Record<string, unknown> | null | undefined,
): ExecutionObservabilitySurface {
  return readNonEmptyString(contextSnapshot?.issueId) ? "issue_run" : "heartbeat_run";
}

function buildHeartbeatObservationName(
  run: typeof heartbeatRuns.$inferSelect,
  agentName: string,
): string {
  const contextSnapshot = parseObject(run.contextSnapshot);
  const issueId = readNonEmptyString(contextSnapshot.issueId);
  return issueId ? `issue_run:${issueId}` : `heartbeat:${agentName}`;
}

function compactTraceText(value: string | null | undefined, maxLength = 120) {
  const next = value?.replace(/\s+/g, " ").trim();
  if (!next) return null;
  return next.length > maxLength ? `${next.slice(0, maxLength - 1)}…` : next;
}

export function buildIssueRunTraceName(input: { issueTitle?: string | null; issueId: string }) {
  const issueTitle = compactTraceText(input.issueTitle);
  return issueTitle ? `issue_run:${issueTitle} [${input.issueId}]` : `issue_run:[${input.issueId}]`;
}

export function buildHeartbeatRuntimeTraceMetadata(input: {
  runtimeConfig: Record<string, unknown>;
  runtimeSkills: Array<{
    key: string;
    runtimeName: string;
    name: string | null;
    description: string | null;
  }>;
  adapterMeta?: Pick<AgentRuntimeInvocationMeta, "agentRuntimeType" | "command" | "cwd" | "commandNotes" | "promptMetrics"> | null;
}) {
  const instructionsFilePath = readNonEmptyString(input.runtimeConfig.instructionsFilePath);
  return {
    instructionsConfigured: Boolean(instructionsFilePath),
    instructionsFilePath,
    ...summarizeRuntimeSkillsForTrace(input.runtimeSkills),
    ...(input.adapterMeta
      ? {
        runtimeAgentType: input.adapterMeta.agentRuntimeType,
        runtimeCommand: input.adapterMeta.command,
        runtimeCwd: input.adapterMeta.cwd ?? null,
        runtimeCommandNotes: input.adapterMeta.commandNotes ?? [],
        runtimePromptMetrics: input.adapterMeta.promptMetrics ?? null,
      }
      : {}),
  };
}

function buildRecentDateKeys(windowDays: number, now: Date): string[] {
  return Array.from({ length: windowDays }, (_, index) => {
    const next = new Date(now);
    next.setUTCDate(next.getUTCDate() - (windowDays - 1 - index));
    return next.toISOString().slice(0, 10);
  });
}

function buildDateKeysBetween(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start.getTime() > end.getTime()) {
    return [];
  }

  const days: string[] = [];
  const cursor = new Date(start);
  while (cursor.getTime() <= end.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function fallbackSkillLabel(key: string) {
  const trimmed = key.trim();
  if (!trimmed) return "unknown";
  const slashSegments = trimmed.split("/").filter(Boolean);
  const lastSlashSegment = slashSegments.at(-1);
  if (lastSlashSegment) return lastSlashSegment;
  const colonSegments = trimmed.split(":").filter(Boolean);
  return colonSegments.at(-1) ?? trimmed;
}

function normalizeLoadedSkill(value: unknown): { key: string; label: string } | null {
  const skill = parseObject(value);
  const rawKey = readNonEmptyString(skill.key);
  const rawRuntimeName = readNonEmptyString(skill.runtimeName);
  const rawName = readNonEmptyString(skill.name);
  const key = rawKey ?? rawRuntimeName ?? rawName;
  if (!key) return null;
  const label = rawRuntimeName ?? rawName ?? fallbackSkillLabel(key);
  return { key, label };
}

function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = readNonEmptyString(value);
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

function resolveLedgerBiller(result: AgentRuntimeExecutionResult): string {
  return readNonEmptyString(result.biller) ?? readNonEmptyString(result.provider) ?? "unknown";
}

function normalizeBilledCostCents(costUsd: number | null | undefined, billingType: BillingType): number {
  if (billingType === "subscription_included") return 0;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
}

async function resolveLedgerScopeForRun(
  db: Db,
  orgId: string,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const context = parseObject(run.contextSnapshot);
  const contextIssueId = readNonEmptyString(context.issueId);
  const contextProjectId = readNonEmptyString(context.projectId);

  if (!contextIssueId) {
    return {
      issueId: null,
      projectId: contextProjectId,
    };
  }

  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(and(eq(issues.id, contextIssueId), eq(issues.orgId, orgId)))
    .then((rows) => rows[0] ?? null);

  return {
    issueId: issue?.id ?? null,
    projectId: issue?.projectId ?? contextProjectId,
  };
}

type ResumeSessionRow = {
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

function normalizeUsageTotals(usage: UsageSummary | null | undefined): UsageTotals | null {
  if (!usage) return null;
  return {
    inputTokens: Math.max(0, Math.floor(asNumber(usage.inputTokens, 0))),
    cachedInputTokens: Math.max(0, Math.floor(asNumber(usage.cachedInputTokens, 0))),
    outputTokens: Math.max(0, Math.floor(asNumber(usage.outputTokens, 0))),
  };
}

function readRawUsageTotals(usageJson: unknown): UsageTotals | null {
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

function deriveNormalizedUsageDelta(current: UsageTotals | null, previous: UsageTotals | null): UsageTotals | null {
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

function formatCount(value: number | null | undefined) {
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

function parseIssueAssigneeAgentRuntimeOverrides(
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

function deriveTaskKey(
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

function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return "forceFreshSession was requested";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  return null;
}

function deriveCommentId(
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

function enrichWakeContextSnapshot(input: {
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

function mergeCoalescedContextSnapshot(
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

function buildDeferredWakePayload(
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

function readDeferredWakeContext(payloadRaw: unknown) {
  const payload = parseObject(payloadRaw);
  return parseObject(payload[DEFERRED_WAKE_CONTEXT_KEY]);
}

function readDeferredWakePayload(payloadRaw: unknown) {
  const payload = parseObject(payloadRaw);
  delete payload[DEFERRED_WAKE_CONTEXT_KEY];
  return payload;
}

function deriveDeferredWakeTaskKey(payloadRaw: unknown) {
  const payload = readDeferredWakePayload(payloadRaw);
  const contextSnapshot = readDeferredWakeContext(payloadRaw);
  return deriveTaskKey(contextSnapshot, payload);
}

async function hydrateWakeContextSnapshot(
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
      !readNonEmptyString(commentContext.body)
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
      })
      .from(issueComments)
      .where(and(...commentConditions))
      .then((rows) => rows[0] ?? null);

    if (commentRow) {
      contextSnapshot.comment = {
        ...commentContext,
        id: readNonEmptyString(commentContext.id) ?? commentRow.id,
        body: readNonEmptyString(commentContext.body) ?? commentRow.body,
        authorAgentId: "authorAgentId" in commentContext ? commentContext.authorAgentId : commentRow.authorAgentId,
        authorUserId: "authorUserId" in commentContext ? commentContext.authorUserId : commentRow.authorUserId,
      };
    }
  }
}

function firstNonEmptyLine(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value
    .split("\n")
    .map((chunk) => chunk.trim())
    .find(Boolean);
  return line ?? null;
}

function deriveRecoveryFailureKind(run: typeof heartbeatRuns.$inferSelect): string {
  return (
    readNonEmptyString(run.errorCode) ??
    (run.status === "timed_out" ? "timed_out" : null) ??
    run.status
  );
}

function deriveRecoveryFailureSummary(run: typeof heartbeatRuns.$inferSelect): string {
  return (
    firstNonEmptyLine(run.error) ??
    firstNonEmptyLine(run.stderrExcerpt) ??
    firstNonEmptyLine(run.stdoutExcerpt) ??
    (run.status === "timed_out" ? "The run timed out before it completed." : null) ??
    "The previous run failed before it completed."
  );
}

function mergeMissingRecoveryContextFields(
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

async function hydrateRecoveryBaseContextSnapshot(
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

function buildRecoveryContextSnapshot(input: {
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

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

function isTrackedLocalChildProcessAdapter(agentRuntimeType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(agentRuntimeType);
}

// A positive liveness check means some process currently owns the PID.
// On Linux, PIDs can be recycled, so this is a best-effort signal rather
// than proof that the original child is still alive.
function isProcessAlive(pid: number | null | undefined) {
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

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, ORPHANED_PROCESS_POLL_INTERVAL_MS));
  }
  return !isProcessAlive(pid);
}

async function terminateOrphanedProcess(pid: number): Promise<{
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

function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

const defaultSessionCodec: AgentRuntimeSessionCodec = {
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

function getAgentRuntimeSessionCodec(agentRuntimeType: string) {
  const adapter = getServerAdapter(agentRuntimeType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

function resolveNextSessionState(input: {
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

export function heartbeatService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  const runLogStore = getRunLogStore();
  const runContextSvc = agentRunContextService(db);
  const issuesSvc = issueService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const activeRunExecutions = new Set<string>();
  const budgetHooks = {
    cancelWorkForScope: cancelBudgetScopeWork,
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

    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        orgId: agent.orgId,
        agentRuntimeType: agent.agentRuntimeType,
        stateJson: {},
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
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
    };
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
    const agent = await getAgent(run.agentId);
    if (!agent) {
      await cancelRunInternal(run.id, "Cancelled because the agent no longer exists");
      return null;
    }
    if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
      await cancelRunInternal(run.id, "Cancelled because the agent is not invokable");
      return null;
    }

    const context = parseObject(run.contextSnapshot);
    const budgetBlock = await budgets.getInvocationBlock(run.orgId, run.agentId, {
      issueId: readNonEmptyString(context.issueId),
      projectId: readNonEmptyString(context.projectId),
    });
    if (budgetBlock) {
      await cancelRunInternal(run.id, budgetBlock.reason);
      return null;
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
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const billingType = normalizeLedgerBillingType(result.billingType);
    const additionalCostCents = normalizeBilledCostCents(result.costUsd, billingType);
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
    const provider = result.provider ?? "unknown";
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
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
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
        inputTokens,
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
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
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

  async function executeRun(runId: string) {
    let run = await getRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (run.status === "queued") {
      const claimed = await claimQueuedRun(run);
      if (!claimed) {
        // Another worker has already claimed or finalized this run.
        return;
      }
      run = claimed;
    }

    activeRunExecutions.add(run.id);

    try {
    const agent = await getAgent(run.agentId);
    if (!agent) {
      await setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      const failedRun = await getRun(runId);
      if (failedRun) await releaseIssueExecutionAndPromote(failedRun);
      return;
    }

    const heartbeatObservationContext = buildHeartbeatObservabilityContext(run, {
      runtime: agent.agentRuntimeType,
      metadata: {
        agentName: agent.name,
        invocationSource: run.invocationSource,
        triggerDetail: run.triggerDetail,
      },
    });

    await withExecutionObservation(
      heartbeatObservationContext,
      {
        name: buildHeartbeatObservationName(run, agent.name),
        asType: "agent",
        input: {
          agentId: agent.id,
          agentName: agent.name,
          invocationSource: run.invocationSource,
          triggerDetail: run.triggerDetail,
          issueId: readNonEmptyString(parseObject(run.contextSnapshot).issueId),
        },
      },
      async (observation) => {
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
    let finalObservationOutput: string | null = null;
    let finalObservationStatus: string | null = run.status;
    let finalObservationSessionId: string | null = heartbeatObservationContext.sessionKey ?? null;
    const runtime = await ensureRuntimeState(agent);
    const context = parseObject(run.contextSnapshot);
    const taskKey = deriveTaskKey(context, null);
    const sessionCodec = getAgentRuntimeSessionCodec(agent.agentRuntimeType);
    const issueId = readNonEmptyString(context.issueId);
    const issueContext = issueId
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
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
    const previousSessionParams =
      explicitResumeSessionParams ??
      (explicitResumeSessionDisplayId ? { sessionId: explicitResumeSessionDisplayId } : null) ??
      normalizeSessionParams(sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null));
    const config = parseObject(agent.agentRuntimeConfig);
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
    heartbeatObservationContext.metadata = {
      ...(heartbeatObservationContext.metadata ?? {}),
      ...buildHeartbeatRuntimeTraceMetadata({
        runtimeConfig,
        runtimeSkills: runtimeSkillEntries,
      }),
    };
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
    const rootObservationInput = {
      agentId: agent.id,
      agentName: agent.name,
      invocationSource: run.invocationSource,
      triggerDetail: run.triggerDetail,
      issue: issueRef
        ? {
          id: issueRef.id,
          identifier: issueRef.identifier ?? null,
          title: issueRef.title ?? null,
        }
        : null,
    };
    updateExecutionObservation(observation, heartbeatObservationContext, {
      input: rootObservationInput,
    });
    updateExecutionTraceIO(observation, { input: rootObservationInput });
    if (issueRef) {
      updateExecutionTraceName(
        observation,
        buildIssueRunTraceName({
          issueTitle: issueRef.title,
          issueId: issueRef.id,
        }),
      );
    }
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
            "Failed to cleanup realized execution workspace after persistence failure",
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
          contextSnapshot: context,
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
    const runtimeSceneContext = await runContextSvc.buildSceneContext({
      scene: "heartbeat",
      agent,
      resolvedWorkspace,
      runtimeConfig,
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
    if (runtimeSceneContext.rudderRuntimeServiceIntents) {
      context.rudderRuntimeServiceIntents = runtimeSceneContext.rudderRuntimeServiceIntents;
    } else {
      delete context.rudderRuntimeServiceIntents;
    }
    if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = executionWorkspace.projectId;
    }
    const runtimeSessionFallback = taskKey || resetTaskSession ? null : runtime.sessionId;
    let previousSessionDisplayId = truncateDisplayId(
      explicitResumeSessionDisplayId ??
        taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    let runtimeSessionIdForAdapter =
      readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback;
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

    const runtimeForAdapter = {
      sessionId: runtimeSessionIdForAdapter,
      sessionParams: runtimeSessionParamsForAdapter,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };

    let seq = 1;
    let handle: RunLogHandle | null = null;
    let stdoutExcerpt = "";
    let stderrExcerpt = "";
    try {
      const startedAt = run.startedAt ?? new Date();
      const runningWithSession = await db
        .update(heartbeatRuns)
        .set({
          startedAt,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (runningWithSession) run = runningWithSession;

      const runningAgent = await db
        .update(agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (runningAgent) {
        publishLiveEvent({
          orgId: runningAgent.orgId,
          type: "agent.status",
          payload: {
            agentId: runningAgent.id,
            status: runningAgent.status,
            outcome: "running",
          },
        });
      }

      const currentRun = run;
      await appendRunEvent(currentRun, seq++, {
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
            contextSnapshot: context,
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
        if (meta.env && secretKeys.size > 0) {
          for (const key of secretKeys) {
            if (key in meta.env) meta.env[key] = "***REDACTED***";
          }
        }
        heartbeatObservationContext.metadata = {
          ...(heartbeatObservationContext.metadata ?? {}),
          ...buildHeartbeatRuntimeTraceMetadata({
            runtimeConfig,
            runtimeSkills: runtimeSkillEntries,
            adapterMeta: meta,
          }),
        };
        updateExecutionObservation(observation, heartbeatObservationContext, {
          input: rootObservationInput,
        });
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: meta as unknown as Record<string, unknown>,
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
      const adapterResult = await adapter.execute({
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
        authToken: authToken ?? undefined,
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
            contextSnapshot: context,
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

      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const latestRun = await getRun(run.id);
      if (latestRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (adapterResult.timedOut) {
        outcome = "timed_out";
      } else if ((adapterResult.exitCode ?? 0) === 0 && !adapterResult.errorMessage) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }

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
      heartbeatObservationContext.status = status;
      finalObservationStatus = status;
      finalObservationSessionId = nextSessionState.displayId ?? nextSessionState.legacySessionId ?? finalObservationSessionId;

      const adapterResultSummary = summarizeHeartbeatRunResultJson(adapterResult.resultJson);
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
              sessionReused: runtimeForAdapter.sessionId != null || runtimeForAdapter.sessionDisplayId != null,
              taskSessionReused: taskSessionForRun != null,
              freshSession: runtimeForAdapter.sessionId == null && runtimeForAdapter.sessionDisplayId == null,
              sessionRotated: sessionCompaction.rotate,
              sessionRotationReason: sessionCompaction.reason,
              provider: readNonEmptyString(adapterResult.provider) ?? "unknown",
              biller: resolveLedgerBiller(adapterResult),
              model: readNonEmptyString(adapterResult.model) ?? "unknown",
              ...(adapterResult.costUsd != null ? { costUsd: adapterResult.costUsd } : {}),
              billingType: normalizeLedgerBillingType(adapterResult.billingType),
            } as Record<string, unknown>)
          : null;

      await setRunStatus(run.id, status, {
        finishedAt: new Date(),
        error:
          outcome === "succeeded"
            ? null
            : redactCurrentUserText(
                adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
                currentUserRedactionOptions,
              ),
        errorCode:
          outcome === "timed_out"
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
        sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });

      await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
        finishedAt: new Date(),
        error: adapterResult.errorMessage ?? null,
      });

      const finalizedRun = await getRun(run.id);
      if (finalizedRun) {
        await appendRunEvent(finalizedRun, seq++, {
          eventType: "lifecycle",
          stream: "system",
          level: outcome === "succeeded" ? "info" : "error",
          message: `run ${outcome}`,
          payload: {
            status,
            exitCode: adapterResult.exitCode,
          },
        });
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      if (finalizedRun) {
        await updateRuntimeState(agent, finalizedRun, adapterResult, {
          legacySessionId: nextSessionState.legacySessionId,
        }, normalizedUsage);
        if (taskKey) {
          if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
            await clearTaskSessions(agent.orgId, agent.id, {
              taskKey,
              agentRuntimeType: agent.agentRuntimeType,
            });
          } else {
            await upsertTaskSession({
              orgId: agent.orgId,
              agentId: agent.id,
              agentRuntimeType: agent.agentRuntimeType,
              taskKey,
              sessionParamsJson: nextSessionState.params,
              sessionDisplayId: nextSessionState.displayId,
              lastRunId: finalizedRun.id,
              lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
            });
          }
        }
        await emitHeartbeatLiveEval(finalizedRun.id);
      }
      await finalizeAgentStatus(agent.id, outcome);
    } catch (err) {
      const message = redactCurrentUserText(
        err instanceof Error ? err.message : "Unknown adapter failure",
        await getCurrentUserRedactionOptions(),
      );
      heartbeatObservationContext.status = "failed";
      finalObservationStatus = "failed";
      transcriptFallbackResult = {
        ts: new Date().toISOString(),
        output: message,
        subtype: "failed",
        isError: true,
        errors: [message],
      };
      logger.error({ err, runId }, "heartbeat execution failed");

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        try {
          logSummary = await runLogStore.finalize(handle);
        } catch (finalizeErr) {
          logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
        }
      }

      const failedRun = await setRunStatus(run.id, "failed", {
        error: message,
        errorCode: "adapter_failed",
        finishedAt: new Date(),
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: message,
      });

      if (failedRun) {
        await appendRunEvent(failedRun, seq++, {
          eventType: "error",
          stream: "system",
          level: "error",
          message,
        });
        await releaseIssueExecutionAndPromote(failedRun);

        await updateRuntimeState(agent, failedRun, {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: message,
        }, {
          legacySessionId: runtimeForAdapter.sessionId,
        });

        if (taskKey && (previousSessionParams || previousSessionDisplayId || taskSession)) {
          await upsertTaskSession({
            orgId: agent.orgId,
            agentId: agent.id,
            agentRuntimeType: agent.agentRuntimeType,
            taskKey,
            sessionParamsJson: previousSessionParams,
            sessionDisplayId: previousSessionDisplayId,
            lastRunId: failedRun.id,
            lastError: message,
          });
        }
        await emitHeartbeatLiveEval(failedRun.id);
      }

      await finalizeAgentStatus(agent.id, "failed");
    } finally {
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
      try {
        const transcriptStats = emitExecutionTranscriptTree({
          context: heartbeatObservationContext,
          parentObservation: observation,
          transcript: executionTranscript,
          fallbackResult: transcriptFallbackResult,
        });
        finalObservationOutput = transcriptStats.finalOutput ?? transcriptFallbackResult?.output ?? null;
        finalObservationSessionId = transcriptStats.finalSessionId ?? finalObservationSessionId;
      } catch (error) {
        logger.warn(
          {
            runId: run.id,
            err: error instanceof Error ? error.message : String(error),
          },
          "Failed to export heartbeat transcript tree to Langfuse",
        );
      }
      updateExecutionObservation(observation, heartbeatObservationContext, {
        input: rootObservationInput,
        output: finalObservationOutput,
        level:
          finalObservationStatus === "failed" || finalObservationStatus === "timed_out" ? "ERROR" : "DEFAULT",
        statusMessage: finalObservationStatus ?? undefined,
      });
      updateExecutionTraceIO(observation, {
        input: rootObservationInput,
        output: finalObservationOutput,
      });
      updateExecutionTraceSession(observation, finalObservationSessionId);
    }
      },
    );
    } catch (outerErr) {
          // Setup code before adapter.execute threw (e.g. ensureRuntimeState, resolveWorkspaceForRun).
          // The inner catch did not fire, so we must record the failure here.
          const message = outerErr instanceof Error ? outerErr.message : "Unknown setup failure";
          logger.error({ err: outerErr, runId }, "heartbeat execution setup failed");
          await setRunStatus(runId, "failed", {
            error: message,
            errorCode: "adapter_failed",
            finishedAt: new Date(),
          }).catch(() => undefined);
          await setWakeupStatus(run.wakeupRequestId, "failed", {
            finishedAt: new Date(),
            error: message,
          }).catch(() => undefined);
          const failedRun = await getRun(runId).catch(() => null);
          if (failedRun) {
            // Emit a run-log event so the failure is visible in the run timeline,
            // consistent with what the inner catch block does for adapter failures.
            await appendRunEvent(failedRun, 1, {
              eventType: "error",
              stream: "system",
              level: "error",
              message,
            }).catch(() => undefined);
            await emitHeartbeatLiveEval(failedRun.id).catch(() => undefined);
            await releaseIssueExecutionAndPromote(failedRun).catch(() => undefined);
          }
          // Ensure the agent is not left stuck in "running" if the inner catch handler's
          // DB calls threw (e.g. a transient DB error in finalizeAgentStatus).
          await finalizeAgentStatus(run.agentId, "failed").catch(() => undefined);
        } finally {
          await releaseRuntimeServicesForRun(run.id).catch(() => undefined);
          activeRunExecutions.delete(run.id);
          await startNextQueuedRunForAgent(run.agentId);
        }
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect) {
    const promotedRun = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where org_id = ${run.orgId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({
          id: issues.id,
          orgId: issues.orgId,
        })
        .from(issues)
        .where(and(eq(issues.orgId, run.orgId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);

      if (!issue) return;

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
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

        if (!deferred) return null;

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

        return newRun;
      }
    });

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

    const writeSkippedRequest = async (skipReason: string) => {
      if (existingWakeupRequestId) {
        await setWakeupStatus(existingWakeupRequestId, "skipped", {
          reason: skipReason,
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
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
      });
    };

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

    if (agent.status === "terminated" || agent.status === "pending_approval") {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
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

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

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
    if (run.status !== "failed" && run.status !== "timed_out") {
      throw conflict("Only failed or timed out runs can be retried", {
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
      return rows.map((row) => ({
        ...row,
        resultJson: summarizeHeartbeatRunResultJson(row.resultJson),
      }));
    },

    getAgentSkillAnalytics: async (
      agentId: string,
      opts?: { windowDays?: number; now?: Date; startDate?: string; endDate?: string },
    ): Promise<AgentSkillAnalytics> => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

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
          createdAt: heartbeatRunEvents.createdAt,
          payload: heartbeatRunEvents.payload,
        })
        .from(heartbeatRunEvents)
        .where(
          and(
            eq(heartbeatRunEvents.orgId, agent.orgId),
            eq(heartbeatRunEvents.agentId, agent.id),
            eq(heartbeatRunEvents.eventType, "adapter.invoke"),
            gte(heartbeatRunEvents.createdAt, windowStart),
            lte(heartbeatRunEvents.createdAt, windowEnd),
          ),
        )
        .orderBy(asc(heartbeatRunEvents.createdAt), asc(heartbeatRunEvents.id));

      const days = new Map<string, {
        totalCount: number;
        runCount: number;
        skills: Map<string, { key: string; label: string; count: number }>;
      }>();
      for (const date of dateKeys) {
        days.set(date, { totalCount: 0, runCount: 0, skills: new Map() });
      }

      const overallSkills = new Map<string, { key: string; label: string; count: number }>();
      let totalCount = 0;
      let totalRunsWithSkills = 0;

      for (const row of rows) {
        const date = new Date(row.createdAt).toISOString().slice(0, 10);
        const bucket = days.get(date);
        if (!bucket) continue;

        const payload = parseObject(row.payload);
        const loadedSkills = Array.isArray(payload.loadedSkills) ? payload.loadedSkills : [];
        if (loadedSkills.length === 0) continue;

        const eventSkills = new Map<string, string>();
        for (const entry of loadedSkills) {
          const normalized = normalizeLoadedSkill(entry);
          if (!normalized) continue;
          if (!eventSkills.has(normalized.key)) {
            eventSkills.set(normalized.key, normalized.label);
          }
        }
        if (eventSkills.size === 0) continue;

        bucket.runCount += 1;
        totalRunsWithSkills += 1;
        for (const [key, label] of eventSkills) {
          bucket.totalCount += 1;
          totalCount += 1;

          const existingDaySkill = bucket.skills.get(key);
          if (existingDaySkill) {
            existingDaySkill.count += 1;
          } else {
            bucket.skills.set(key, { key, label, count: 1 });
          }

          const existingOverallSkill = overallSkills.get(key);
          if (existingOverallSkill) {
            existingOverallSkill.count += 1;
          } else {
            overallSkills.set(key, { key, label, count: 1 });
          }
        }
      }

      return {
        agentId: agent.id,
        orgId: agent.orgId,
        windowDays,
        startDate,
        endDate,
        totalCount,
        totalRunsWithSkills,
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
            skills: Array.from(bucket.skills.values()).sort((left, right) => (
              right.count - left.count
              || left.label.localeCompare(right.label)
              || left.key.localeCompare(right.key)
            )),
          };
        }),
      };
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
      source: "timer" | "assignment" | "on_demand" | "automation" = "on_demand",
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
