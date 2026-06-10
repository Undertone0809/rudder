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

export const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
export const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = AGENT_RUN_CONCURRENCY_DEFAULT;
export const HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = AGENT_RUN_CONCURRENCY_MIN;
export const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = AGENT_RUN_CONCURRENCY_MAX;
export const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
export const DETACHED_PROCESS_ERROR_CODE = "process_detached";
export const ORPHANED_PROCESS_TERMINATION_GRACE_MS = 2_000;
export const ORPHANED_PROCESS_KILL_WAIT_MS = 500;
export const ORPHANED_PROCESS_POLL_INTERVAL_MS = 100;
export const startLocksByAgent = new Map<string, Promise<void>>();
export const MAX_RECOVERY_CHAIN_DEPTH = 8;
export const ISSUE_PASSIVE_FOLLOWUP_REASON = "issue_passive_followup";
export const ISSUE_PASSIVE_FOLLOWUP_WAKE_SOURCE = "passive_issue_followup";
export const ISSUE_PASSIVE_FOLLOWUP_FAILURE_REASON = "missing_closure";
export const ISSUE_PASSIVE_FOLLOWUP_MAX_ATTEMPTS = 2;
export const ISSUE_REVIEW_CLOSEOUT_REASON = "issue_review_closeout_missing";
export const ISSUE_REVIEW_CLOSEOUT_FAILURE_REASON = "missing_review_decision";
export const ISSUE_REVIEW_CLOSEOUT_MAX_ATTEMPTS = 2;
export const ISSUE_PASSIVE_FOLLOWUP_COOLDOWN_MS_BY_ATTEMPT = new Map<number, number>([
  [1, 2 * 60 * 1000],
  [2, 5 * 60 * 1000],
]);
export const ISSUE_PASSIVE_FOLLOWUP_TIMER_CONTINUITY_MAX_WINDOW_MS = 15 * 60 * 1000;
export const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

export type TimerPreflightResult =
  | { shouldRun: true; reason: string }
  | { shouldRun: false; skipReason: string };

export const heartbeatRunListColumns = {
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

export function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

export function appendTranscriptEntriesFromChunk(input: {
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

export function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_MIN, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

export async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
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

export interface WakeupOptions {
  source?: "timer" | "assignment" | "review" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
  existingWakeupRequestId?: string | null;
}

export type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  previousRunId: string | null;
};

export interface ParsedIssueAssigneeAgentRuntimeOverrides {
  agentRuntimeConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

export function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function resolveHeartbeatObservabilitySurface(
  contextSnapshot: Record<string, unknown> | null | undefined,
): ExecutionObservabilitySurface {
  return readNonEmptyString(contextSnapshot?.issueId) ? "issue_run" : "heartbeat_run";
}

export function buildHeartbeatObservationName(
  run: typeof heartbeatRuns.$inferSelect,
  agentName: string,
): string {
  const contextSnapshot = parseObject(run.contextSnapshot);
  const issueId = readNonEmptyString(contextSnapshot.issueId);
  return issueId ? `issue_run:${issueId}` : `heartbeat:${agentName}`;
}

export function compactTraceText(value: string | null | undefined, maxLength = 120) {
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

export function buildHeartbeatAdapterInvokePayload(input: {
  meta: AgentRuntimeInvocationMeta;
  runtimeSkills: Array<{
    key: string;
    runtimeName: string;
    name: string | null;
    description: string | null;
  }>;
}): Record<string, unknown> {
  const explicitUsedSkills = Array.isArray(input.meta.usedSkills)
    ? input.meta.usedSkills
      .map((entry) => normalizeLoadedSkill(entry))
      .filter((entry): entry is { key: string; label: string } => Boolean(entry))
    : [];
  const promptRequestedSkills = inferUsedSkillsFromPrompt(input.meta.prompt, input.runtimeSkills);
  const loadedSkills = Array.isArray(input.meta.loadedSkills) && input.meta.loadedSkills.length > 0
    ? input.meta.loadedSkills
      .map((entry) => normalizeLoadedSkillForPayload(entry))
      .filter((entry): entry is { key: string; runtimeName: string | null; name: string | null; description: string | null } => Boolean(entry))
    : input.runtimeSkills
      .map((entry) => ({
        key: entry.key,
        runtimeName: entry.runtimeName ?? null,
        name: entry.name ?? null,
        description: entry.description ?? null,
      }));
  const loadedSkillEvidence = loadedSkills
    .map((entry) => normalizeLoadedSkill(entry))
    .filter((entry): entry is { key: string; label: string } => Boolean(entry));
  const skillEvidence = resolveSkillEvidence({
    usedSkills: explicitUsedSkills,
    requestedSkills: promptRequestedSkills,
    loadedSkills: loadedSkillEvidence,
  });

  return {
    ...input.meta,
    ...summarizeRuntimeSkillsForTrace(input.runtimeSkills),
    loadedSkillCount: loadedSkills.length,
    loadedSkillKeys: loadedSkills.map((entry) => entry.key),
    loadedSkills,
    usedSkillCount: explicitUsedSkills.length,
    usedSkillKeys: explicitUsedSkills.map((entry) => entry.key),
    usedSkills: explicitUsedSkills,
    promptRequestedSkillCount: promptRequestedSkills.length,
    promptRequestedSkillKeys: promptRequestedSkills.map((entry) => entry.key),
    promptRequestedSkills,
    skillEvidenceType: skillEvidence.evidence,
    skillEvidenceCount: skillEvidence.skills.length,
    skillEvidenceKeys: skillEvidence.skills.map((entry) => entry.key),
    skillEvidenceSkills: skillEvidence.skills,
  } as Record<string, unknown>;
}

export function buildRecentDateKeys(windowDays: number, now: Date): string[] {
  return Array.from({ length: windowDays }, (_, index) => {
    const next = new Date(now);
    next.setUTCDate(next.getUTCDate() - (windowDays - 1 - index));
    return next.toISOString().slice(0, 10);
  });
}

export function buildDateKeysBetween(startDate: string, endDate: string): string[] {
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

export function fallbackSkillLabel(key: string) {
  const trimmed = key.trim();
  if (!trimmed) return "unknown";
  const slashSegments = trimmed.split("/").filter(Boolean);
  const lastSlashSegment = slashSegments.at(-1);
  if (lastSlashSegment) return lastSlashSegment;
  const colonSegments = trimmed.split(":").filter(Boolean);
  return colonSegments.at(-1) ?? trimmed;
}

export function normalizeLoadedSkill(value: unknown): { key: string; label: string } | null {
  const skill = parseObject(value);
  const rawKey = readNonEmptyString(skill.key);
  const rawRuntimeName = readNonEmptyString(skill.runtimeName);
  const rawName = readNonEmptyString(skill.name);
  const key = rawKey ?? rawRuntimeName ?? rawName;
  if (!key) return null;
  const label = rawRuntimeName ?? rawName ?? fallbackSkillLabel(key);
  return { key, label };
}

export function normalizeLoadedSkillForPayload(value: unknown): {
  key: string;
  runtimeName: string | null;
  name: string | null;
  description: string | null;
} | null {
  const skill = parseObject(value);
  const rawKey = readNonEmptyString(skill.key);
  const rawRuntimeName = readNonEmptyString(skill.runtimeName);
  const rawName = readNonEmptyString(skill.name);
  const key = rawKey ?? rawRuntimeName ?? rawName;
  if (!key) return null;
  return {
    key,
    runtimeName: rawRuntimeName ?? null,
    name: rawName ?? null,
    description: readNonEmptyString(skill.description) ?? null,
  };
}

export function emptySkillEvidenceCounts(): AgentSkillTelemetryEvidenceCounts {
  return { used: 0, requested: 0, loaded: 0 };
}

export function incrementSkillEvidenceCount(
  counts: AgentSkillTelemetryEvidenceCounts,
  evidence: AgentSkillTelemetryEvidence,
) {
  counts[evidence] += 1;
}

export function strongestSkillEvidence(
  left: AgentSkillTelemetryEvidence,
  right: AgentSkillTelemetryEvidence,
): AgentSkillTelemetryEvidence {
  const rank: Record<AgentSkillTelemetryEvidence, number> = {
    used: 3,
    requested: 2,
    loaded: 1,
  };
  return rank[right] > rank[left] ? right : left;
}

export function resolveSkillEvidence(input: {
  usedSkills: Array<{ key: string; label: string }>;
  requestedSkills: Array<{ key: string; label: string }>;
  loadedSkills: Array<{ key: string; label: string }>;
}): { evidence: AgentSkillTelemetryEvidence; skills: Array<{ key: string; label: string }> } {
  if (input.usedSkills.length > 0) return { evidence: "used", skills: input.usedSkills };
  if (input.requestedSkills.length > 0) return { evidence: "requested", skills: input.requestedSkills };
  return { evidence: "loaded", skills: [] };
}

export function readSkillEvidenceFromPayload(payload: Record<string, unknown>): {
  evidence: AgentSkillTelemetryEvidence;
  skills: Array<{ key: string; label: string }>;
} {
  const loadedSkills = Array.isArray(payload.loadedSkills)
    ? payload.loadedSkills
      .map((entry) => normalizeLoadedSkill(entry))
      .filter((entry): entry is { key: string; label: string } => Boolean(entry))
    : [];
  const usedSkills = Array.isArray(payload.usedSkills)
    ? payload.usedSkills
      .map((entry) => normalizeLoadedSkill(entry))
      .filter((entry): entry is { key: string; label: string } => Boolean(entry))
    : [];
  const requestedSkills = Array.isArray(payload.promptRequestedSkills)
    ? payload.promptRequestedSkills
      .map((entry) => normalizeLoadedSkill(entry))
      .filter((entry): entry is { key: string; label: string } => Boolean(entry))
    : inferUsedSkillsFromPrompt(payload.prompt, loadedSkills);

  return resolveSkillEvidence({ usedSkills, requestedSkills, loadedSkills });
}

export function extractSkillSlugFromPath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/").replace(/[?#].*$/u, "").replace(/\/+$/u, "");
  if (!normalized.endsWith("/SKILL.md")) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const slug = parts.at(-2);
  if (!slug || slug === "." || slug === "..") return null;
  return slug;
}

export function collectSkillPathsFromText(value: string): string[] {
  const paths: string[] = [];
  const pattern = /(?:^|[\s"'`(=])((?:\.{1,2}\/|~\/|\/)?(?:[^\s"'`()<>|;&/]+\/)+SKILL\.md(?:[?#][^\s"'`()<>|;&]*)?)(?=$|[\s"'`()<>|;&])/giu;
  for (const match of value.matchAll(pattern)) {
    const pathValue = match[1]?.trim();
    if (pathValue) paths.push(pathValue);
  }
  return paths;
}

export function collectStringValues(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => collectStringValues(entry, depth + 1));
  const record = parseObject(value);
  return Object.values(record).flatMap((entry) => collectStringValues(entry, depth + 1));
}

export function normalizeSkillUseFromPath(value: string): { key: string; label: string } | null {
  const slug = extractSkillSlugFromPath(value);
  if (!slug) return null;
  return { key: slug, label: slug };
}

export function dedupeSkillUses(skills: Array<{ key: string; label: string }>) {
  const seen = new Set<string>();
  const result: Array<{ key: string; label: string }> = [];
  for (const skill of skills) {
    const normalized = normalizeLoadedSkill(skill);
    if (!normalized || seen.has(normalized.key)) continue;
    seen.add(normalized.key);
    result.push(normalized);
  }
  return result;
}

export function collectSkillUsesFromText(value: string) {
  return collectSkillPathsFromText(value)
    .map((entry) => normalizeSkillUseFromPath(entry))
    .filter((entry): entry is { key: string; label: string } => Boolean(entry));
}

export function readToolCommandInput(input: unknown): string | null {
  if (typeof input === "string") return input;
  const record = parseObject(input);
  return readNonEmptyString(record.command) ?? readNonEmptyString(record.cmd);
}

export function isCommandTranscriptTool(name: string) {
  const normalized = name.trim().toLowerCase();
  const terminalName = normalized.split(".").filter(Boolean).at(-1) ?? normalized;
  const compact = terminalName.replace(/[\s_-]+/gu, "");
  return ["commandexecution", "shell", "shelltoolcall", "bash", "execcommand"].includes(compact);
}

export function isReadTranscriptTool(name: string) {
  const normalized = name.trim().toLowerCase();
  if (isCommandTranscriptTool(normalized)) return true;
  if (/(?:^|[_-])(read|fetch|open|cat)(?:$|[_-])/.test(normalized)) return true;
  return false;
}

export function isSkillTranscriptTool(name: string) {
  const normalized = name.trim().toLowerCase().replace(/[\s_-]+/gu, "");
  return ["skill", "activateskill", "loadskill", "useskill"].includes(normalized);
}

export function readSkillToolInput(input: unknown): { key: string; label: string } | null {
  if (typeof input === "string") {
    const value = input.trim();
    return value ? { key: value, label: fallbackSkillLabel(value) } : null;
  }

  const record = parseObject(input);
  const rawValue =
    readNonEmptyString(record.skill) ??
    readNonEmptyString(record.skillName) ??
    readNonEmptyString(record.skill_name) ??
    readNonEmptyString(record.name) ??
    readNonEmptyString(record.slug);
  if (rawValue) return { key: rawValue, label: fallbackSkillLabel(rawValue) };

  const nestedSkill = normalizeLoadedSkill(record.skill);
  if (nestedSkill) return nestedSkill;

  return null;
}

export function inferUsedSkillsFromTranscript(transcript: TranscriptEntry[]) {
  const skills: Array<{ key: string; label: string }> = [];
  for (const entry of transcript) {
    if (entry.kind !== "tool_call") continue;
    if (isSkillTranscriptTool(entry.name)) {
      const skill = readSkillToolInput(entry.input);
      if (skill) skills.push(skill);
      continue;
    }
    if (!isReadTranscriptTool(entry.name)) continue;

    const command = readToolCommandInput(entry.input);
    if (command) {
      skills.push(...collectSkillUsesFromText(command));
      continue;
    }

    for (const value of collectStringValues(entry.input)) {
      skills.push(...collectSkillUsesFromText(value));
    }
  }
  return dedupeSkillUses(skills);
}

export function normalizeSkillCandidate(value: string | null | undefined) {
  return value
    ?.trim()
    .replace(/^\$/u, "")
    .replace(/[?#].*$/u, "")
    .replace(/\/+$/u, "")
    .toLowerCase() || "";
}

export function addSkillCandidate(candidates: Set<string>, value: string | null | undefined) {
  const normalized = normalizeSkillCandidate(value);
  if (!normalized) return;
  candidates.add(normalized);
  const lastSegment = normalized.split(/[/:]/u).filter(Boolean).at(-1);
  if (lastSegment) candidates.add(lastSegment);
}

export function readSkillReferenceSlug(href: string) {
  const normalized = href.trim().replace(/[?#].*$/u, "").replace(/\/+$/u, "");
  if (!normalized) return null;
  if (normalized.endsWith("/SKILL.md")) {
    return normalized.slice(0, -"/SKILL.md".length).split("/").filter(Boolean).at(-1) ?? null;
  }
  if (normalized.toLowerCase().endsWith(".md")) {
    const fileName = normalized.split("/").filter(Boolean).at(-1) ?? "";
    return fileName.replace(/\.md$/iu, "") || null;
  }
  return null;
}

export function collectSkillReferences(prompt: string) {
  const references: Array<{ key: string; label: string; candidates: Set<string> }> = [];
  const pattern = /\[([^\]\n]+)\]\(([^)\n]+(?:\/SKILL\.md|\.md)(?:[?#][^)\n]*)?)\)/giu;
  for (const match of prompt.matchAll(pattern)) {
    const rawLabel = match[1]?.trim() ?? "";
    const href = match[2]?.trim() ?? "";
    if (!rawLabel || !href) continue;
    const labelWithoutPrefix = rawLabel.replace(/^\$/u, "").trim();
    const slug = readSkillReferenceSlug(href);
    const isExplicitSkillToken = rawLabel.startsWith("$") || href.replace(/[?#].*$/u, "").endsWith("/SKILL.md");
    if (!isExplicitSkillToken) continue;

    const key = labelWithoutPrefix || slug;
    if (!key) continue;
    const label = slug ?? fallbackSkillLabel(key);
    const candidates = new Set<string>();
    addSkillCandidate(candidates, labelWithoutPrefix);
    addSkillCandidate(candidates, slug);
    addSkillCandidate(candidates, href);
    references.push({ key, label, candidates });
  }
  return references;
}

export function inferUsedSkillsFromPrompt(
  prompt: unknown,
  loadedSkills: unknown[],
): Array<{ key: string; label: string }> {
  const promptText = readNonEmptyString(prompt);
  if (!promptText) return [];

  const references = collectSkillReferences(promptText);
  if (references.length === 0) return [];

  const loaded = loadedSkills
    .map((entry) => normalizeLoadedSkill(entry))
    .filter((entry): entry is { key: string; label: string } => Boolean(entry))
    .map((entry) => {
      const candidates = new Set<string>();
      addSkillCandidate(candidates, entry.key);
      addSkillCandidate(candidates, entry.label);
      return { ...entry, candidates };
    });

  const used = new Map<string, { key: string; label: string }>();
  for (const reference of references) {
    const matched = loaded.find((entry) => {
      for (const candidate of reference.candidates) {
        if (entry.candidates.has(candidate)) return true;
      }
      return false;
    });
    const normalized = matched ?? { key: reference.key, label: reference.label };
    if (!used.has(normalized.key)) used.set(normalized.key, normalized);
  }

  return Array.from(used.values());
}

export function normalizeLedgerBillingType(value: unknown): BillingType {
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

export function resolveLedgerBiller(result: AgentRuntimeExecutionResult): string {
  return readNonEmptyString(result.biller) ?? readNonEmptyString(result.provider) ?? "unknown";
}

export function normalizeBilledCostCents(costUsd: number | null | undefined, billingType: BillingType): number {
  if (billingType === "subscription_included") return 0;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
}

export async function resolveLedgerScopeForRun(
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
