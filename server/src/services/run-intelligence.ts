import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  agentConfigRevisions,
  agents,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  organizations,
} from "@rudderhq/db";
import {
  diagnoseRun,
  observedRunFromFilesystem,
  type ObservedRunDetail,
  type RunDiagnosis,
  type RunDiagnosisMode,
  type RunExportRow,
  type RunSkillEvidenceMatch,
  type RunSkillEvidenceType,
} from "@rudderhq/run-intelligence-core";
import {
  shortRefFor,
  summarizeTokenUsage,
  toAgentRunOrigin,
  toHeartbeatRun,
  type HeartbeatRun,
  type HeartbeatRunEvent,
  type RunEventCursorPage,
  type RunSummary,
  type RunSummaryPage,
} from "@rudderhq/shared";
import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import path from "node:path";
import { createProfileBoundRuntimeProviderCapabilityResolverFromConfig } from "../agent-runtimes/index.js";
import {
  runtimeConfigFromProviderProfileSnapshot,
  sanitizeRuntimeProviderProfileSnapshot,
} from "../agent-runtimes/runtime-provider-profile-snapshot.js";
import { createHistoricalCodexTranscriptReaderHook } from "../agent-runtimes/verify-codex-transcript-profile.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { notFound } from "../errors.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { redactEventPayload } from "../redaction.js";
import { heartbeatService } from "./heartbeat.js";
import { instanceSettingsService } from "./instance-settings.js";
import { ISSUE_EXECUTION_RELEASED_EVENT_TYPE } from "./operator-event-visibility.js";
import {
  assertRunIntelligenceAccess,
  resolveRunIdReferenceForScope,
  sideChatVisibilityCondition,
  type RunIntelligenceAccessScope
} from "./run-intelligence-access.js";
import { decodeRunEventCursor, decodeRunSummaryCursor, encodeRunEventCursor, encodeRunSummaryCursor } from "./run-intelligence-cursors.js";
import {
  MAX_DIAGNOSTIC_TRANSCRIPT_BYTES,
  MAX_DIAGNOSTIC_TRANSCRIPT_PAGE_BYTES,
  readBoundedRunDiagnosticTranscript,
  type RunDiagnosticEntryPosition,
  type RunDiagnosticProjection,
  type RunDiagnosticReaderPosition,
} from "./run-intelligence-diagnostic-reader.js";
import { getRunLogStore } from "./run-log-store.js";
import { filterNativeTransportProfile } from "./runtime-kernel/native-transport-profile.js";
import {
  type RuntimeProviderCapabilityResolver,
} from "./runtime-kernel/provider-capabilities.js";
import { createTranscriptObjectReader } from "./runtime-kernel/transcript-object-store.js";
import {
  createLegacyTranscriptReader,
  createTranscriptReader,
  type TranscriptItem,
  type TranscriptPage,
  type TranscriptRange,
} from "./runtime-kernel/transcript-reader.js";

export {
  assertRunIntelligenceAccess,
  filterRunsByRunIntelligenceAccess,
  resolveRunIdReferenceForScope
} from "./run-intelligence-access.js";
export type { RunIntelligenceAccessScope } from "./run-intelligence-access.js";

function hashValue(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function fallbackSkillLabel(key: string) {
  const parts = key.split(/[/:]/u).filter(Boolean);
  return parts.at(-1) ?? key;
}

function normalizeSkillEvidenceEntry(value: unknown): { key: string; label: string | null } | null {
  if (typeof value === "string") {
    const key = value.trim();
    return key ? { key, label: fallbackSkillLabel(key) } : null;
  }
  const record = asRecord(value);
  const key = readString(record.key) ?? readString(record.runtimeName) ?? readString(record.name) ?? readString(record.label);
  if (!key) return null;
  return {
    key,
    label: readString(record.label) ?? readString(record.runtimeName) ?? readString(record.name) ?? fallbackSkillLabel(key),
  };
}

function normalizeSkillQuery(value: string) {
  return value.trim().toLocaleLowerCase();
}

function skillEntryMatchesQuery(entry: { key: string; label: string | null }, query: string) {
  return [entry.key, entry.label].some((candidate) => candidate?.trim().toLocaleLowerCase() === query);
}

export function extractSkillEvidenceMatch(input: {
  payload: unknown;
  evidenceType: RunSkillEvidenceType;
  skillQuery: string;
  eventType: string | null;
  eventId: number | null;
  eventCreatedAt: Date | string | null;
}): RunSkillEvidenceMatch | null {
  const payload = asRecord(input.payload);
  const keysField = input.evidenceType === "used" ? "usedSkillKeys" : "loadedSkillKeys";
  const skillsField = input.evidenceType === "used" ? "usedSkills" : "loadedSkills";
  const query = normalizeSkillQuery(input.skillQuery);
  const candidates = [
    ...(Array.isArray(payload[skillsField]) ? payload[skillsField] : []),
    ...(Array.isArray(payload[keysField]) ? payload[keysField] : []),
  ]
    .map((entry) => normalizeSkillEvidenceEntry(entry))
    .filter((entry): entry is { key: string; label: string | null } => Boolean(entry));
  const match = candidates.find((entry) => skillEntryMatchesQuery(entry, query));
  if (!match) return null;
  const eventCreatedAt = input.eventCreatedAt instanceof Date
    ? input.eventCreatedAt.toISOString()
    : input.eventCreatedAt ?? null;
  return {
    evidenceType: input.evidenceType,
    matchedSkillKey: match.key,
    matchedSkillLabel: match.label,
    sourceEventType: input.eventType,
    sourceEventId: input.eventId,
    sourceEventCreatedAt: eventCreatedAt,
  };
}

function extractFirstSkillEvidenceMatch(input: {
  payload: unknown;
  eventType: string | null;
  eventId: number | null;
  eventCreatedAt: Date | string | null;
}): RunSkillEvidenceMatch | null {
  const payload = asRecord(input.payload);
  for (const evidenceType of ["used", "loaded"] as const) {
    const keysField = evidenceType === "used" ? "usedSkillKeys" : "loadedSkillKeys";
    const skillsField = evidenceType === "used" ? "usedSkills" : "loadedSkills";
    const candidate = [
      ...(Array.isArray(payload[skillsField]) ? payload[skillsField] : []),
      ...(Array.isArray(payload[keysField]) ? payload[keysField] : []),
    ]
      .map((entry) => normalizeSkillEvidenceEntry(entry))
      .find((entry): entry is { key: string; label: string | null } => Boolean(entry));
    if (!candidate) continue;
    return {
      evidenceType,
      matchedSkillKey: candidate.key,
      matchedSkillLabel: candidate.label,
      sourceEventType: input.eventType,
      sourceEventId: input.eventId,
      sourceEventCreatedAt: input.eventCreatedAt instanceof Date
        ? input.eventCreatedAt.toISOString()
        : input.eventCreatedAt ?? null,
    };
  }
  return null;
}

function buildSkillExistsCondition(evidenceType: RunSkillEvidenceType, skillQuery: string) {
  const keysField = evidenceType === "used" ? "usedSkillKeys" : "loadedSkillKeys";
  const skillsField = evidenceType === "used" ? "usedSkills" : "loadedSkills";
  const normalized = normalizeSkillQuery(skillQuery);
  return sql`exists (
    select 1
    from heartbeat_run_events skill_events
    where skill_events.run_id = ${heartbeatRuns.id}
      and skill_events.org_id = ${heartbeatRuns.orgId}
      and skill_events.event_type in ('adapter.invoke', 'adapter.skill_usage')
      and (
        exists (
          select 1
          from jsonb_array_elements_text(
            case
              when jsonb_typeof(skill_events.payload -> ${keysField}) = 'array' then skill_events.payload -> ${keysField}
              else '[]'::jsonb
            end
          ) as skill_key(value)
          where lower(skill_key.value) = ${normalized}
        )
        or exists (
          select 1
          from jsonb_array_elements(
            case
              when jsonb_typeof(skill_events.payload -> ${skillsField}) = 'array' then skill_events.payload -> ${skillsField}
              else '[]'::jsonb
            end
          ) as skill_entry(value)
          where lower(coalesce(skill_entry.value ->> 'key', '')) = ${normalized}
             or lower(coalesce(skill_entry.value ->> 'label', '')) = ${normalized}
             or lower(coalesce(skill_entry.value ->> 'runtimeName', '')) = ${normalized}
             or lower(coalesce(skill_entry.value ->> 'name', '')) = ${normalized}
        )
      )
  )`;
}

type RunRow = typeof heartbeatRuns.$inferSelect & {
  agentName: string | null;
  agentWorkspaceKey?: string | null;
  agentRuntimeType: string;
  agentRuntimeConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  orgName: string | null;
  issueId: string | null;
  diagnosticResultJsonOmitted?: boolean;
  diagnosticContextTranscriptOmitted?: boolean;
  diagnosticErrorOriginalLength?: number | null;
};

export interface ListObservedRunsInput {
  orgId: string;
  sideChatOwnerId?: string | null;
  updatedAfter?: Date | null;
  runIdPrefix?: string | null;
  agentId?: string | null;
  status?: string | null;
  runtime?: string | null;
  issueId?: string | null;
  goalId?: string | null;
  usedSkill?: string | null;
  loadedSkill?: string | null;
  createdBefore?: Date | null;
  limit: number;
}

export interface ListRunSummariesInput extends ListObservedRunsInput {
  cursor?: string | null;
}

type SummaryRunRow = {
  id: string;
  orgId: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  status: string;
  sessionReuseScope: HeartbeatRun["sessionReuseScope"];
  startedAt: Date | null;
  finishedAt: Date | null;
  errorText: string | null;
  logBytes: number | null;
  logStore: string | null;
  logRef: string | null;
  chatConversationId: string | null;
  scene: string | null;
  sourceRunId: string | null;
  contextSnapshot: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  agentName: string | null;
  agentRuntimeType: string;
  orgName: string | null;
  issueId: string | null;
  targetType: string | null;
  targetId: string | null;
  outcomeText: string | null;
  usageInputTokens: string | null;
  usageCachedInputTokens: string | null;
  usageOutputTokens: string | null;
  usageCostUsd: string | null;
  resultCostUsd: string | null;
  usageProvider: string | null;
  usageModel: string | null;
};


function clipSummaryText(value: string | null, maxLength = 500) {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function finiteNonNegativeNumber(value: string | null) {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export type HistoricalRunProfileRun = Pick<
  RunRow,
  "id" | "orgId" | "agentId" | "agentWorkspaceKey" | "agentRuntimeType" | "agentRuntimeConfig" | "runtimeConfig" | "contextSnapshot" | "createdAt"
> & {
  sessionParamsBeforeJson?: Record<string, unknown> | null;
  sessionParamsAfterJson?: Record<string, unknown> | null;
};

export type HistoricalRunConfigRevision = Pick<
  typeof agentConfigRevisions.$inferSelect,
  "id" | "createdAt" | "beforeConfig" | "afterConfig"
>;

export interface HistoricalRunRuntimeProfile {
  agentRuntimeType: string;
  runtimeConfig: Record<string, unknown>;
  cwd: string | null;
  agentConfigRevisionId: string | null;
  agentConfigRevisionCreatedAt: string | null;
}

function revisionTime(revision: HistoricalRunConfigRevision) {
  const time = new Date(revision.createdAt).getTime();
  return Number.isFinite(time) ? time : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function dynamicNativeRuntimeConfig(runtimeType: string, profile: Record<string, unknown>): Record<string, unknown> {
  if (runtimeType !== "opencode_local" && runtimeType !== "pi_local") return {};
  try {
    const filtered = filterNativeTransportProfile({ ...profile, runtimeType });
    if (runtimeType === "opencode_local") {
      return typeof filtered.serverUrl === "string" ? { serverUrl: filtered.serverUrl } : {};
    }
    return Array.isArray(filtered.rpcArgs) ? { rpcArgs: [...filtered.rpcArgs] } : {};
  } catch {
    return {};
  }
}

function hermesManagedAgentWorkspaceCwd(
  run: HistoricalRunProfileRun,
  workspace: Record<string, unknown>,
): string | null {
  const cwd = readString(workspace.executionWorkspaceCwd);
  if (readString(workspace.source) !== "agent_home"
    || readString(workspace.executionWorkspaceSource) !== "agent_home"
    || !cwd
    || !path.isAbsolute(cwd)
    || path.resolve(cwd) !== cwd
    || readString(workspace.cwd) !== cwd
    || readString(workspace.agentHome) !== cwd) return null;

  // Session state may corroborate the server-created workspace, but cannot
  // introduce a transport path of its own or override a different workspace.
  const persistedCwd = readString(asRecord(run.sessionParamsAfterJson).cwd)
    ?? readString(asRecord(run.sessionParamsBeforeJson).cwd);
  return persistedCwd === cwd ? cwd : null;
}

export function resolveHistoricalRunRuntimeProfile(
  run: HistoricalRunProfileRun,
  revisions: readonly HistoricalRunConfigRevision[],
): HistoricalRunRuntimeProfile {
  const orderedRevisions = revisions
    .map((revision) => ({ revision, time: revisionTime(revision) }))
    .filter((entry): entry is { revision: HistoricalRunConfigRevision; time: number } => entry.time !== null)
    .sort((left, right) => right.time - left.time)
    .map((entry) => entry.revision);
  const runTime = new Date(run.createdAt).getTime();
  const revisionAtRun = Number.isFinite(runTime)
    ? orderedRevisions.find((revision) => (revisionTime(revision) ?? Number.POSITIVE_INFINITY) <= runTime) ?? null
    : null;
  const selectedRevision = revisionAtRun ?? orderedRevisions.at(-1) ?? null;
  const snapshot = revisionAtRun?.afterConfig ?? selectedRevision?.beforeConfig ?? null;
  const snapshotRecord = asRecord(snapshot);
  const agentRuntimeConfig = recordOrNull(snapshotRecord.agentRuntimeConfig)
    ?? asRecord(run.agentRuntimeConfig);
  const runtimeConfig = recordOrNull(snapshotRecord.runtimeConfig)
    ?? asRecord(run.runtimeConfig);
  const mergedRuntimeConfig = { ...runtimeConfig, ...agentRuntimeConfig };
  const runContext = asRecord(run.contextSnapshot);
  const rawPreparedProfile = asRecord(runContext.runtimeProviderProfile);
  const preparedProfile = sanitizeRuntimeProviderProfileSnapshot(rawPreparedProfile);
  const runtimeType = readString(snapshotRecord.agentRuntimeType)
    ?? readString(run.agentRuntimeType)
    ?? "process";
  // Only the server-authored, bounded profile projection is authoritative.
  // Session payloads never supply commands, environment, or transport paths.
  if (runtimeType === "opencode_local") {
    delete mergedRuntimeConfig.serverUrl;
    delete mergedRuntimeConfig.opencodeServerUrl;
  }
  if (runtimeType === "pi_local") {
    delete mergedRuntimeConfig.rpcArgs;
  }
  if (preparedProfile?.runtimeType === runtimeType) {
    Object.assign(mergedRuntimeConfig, runtimeConfigFromProviderProfileSnapshot(preparedProfile));
    Object.assign(mergedRuntimeConfig, dynamicNativeRuntimeConfig(runtimeType, rawPreparedProfile ?? {}));
  }
  const workspace = asRecord(runContext.rudderWorkspace);
  const hermesWorkspaceCwd = runtimeType === "hermes_gateway"
    ? hermesManagedAgentWorkspaceCwd(run, workspace)
    : null;
  const cwd = [
    hermesWorkspaceCwd,
    preparedProfile?.runtimeType === runtimeType ? preparedProfile.cwd : null,
    workspace.executionWorkspaceCwd,
    workspace.cwd,
    workspace.worktreePath,
    runContext.executionWorkspaceCwd,
    runContext.cwd,
    runContext.worktreePath,
    mergedRuntimeConfig.cwd,
  ].map(readString).find((value): value is string => Boolean(value)) ?? null;

  return {
    agentRuntimeType: runtimeType,
    runtimeConfig: mergedRuntimeConfig,
    cwd,
    agentConfigRevisionId: selectedRevision?.id ?? null,
    agentConfigRevisionCreatedAt: selectedRevision?.createdAt
      ? new Date(selectedRevision.createdAt).toISOString()
      : null,
  };
}

export function createHistoricalRunRuntimeProviderCapabilityResolver(
  run: HistoricalRunProfileRun,
  revisions: readonly HistoricalRunConfigRevision[],
): RuntimeProviderCapabilityResolver {
  const profile = resolveHistoricalRunRuntimeProfile(run, revisions);
  const resolveProfile = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
    runtimeType: profile.agentRuntimeType,
    runtimeConfig: profile.runtimeConfig,
    cwd: profile.cwd,
    resolutionMode: "historical",
  });

  return (runtimeType, binding, context) => {
    if (runtimeType.trim() !== profile.agentRuntimeType) return null;
    const readerInput = context?.readerInput;
    if (readerInput && (
      readerInput.orgId !== run.orgId
      || readerInput.run.id !== run.id
      || readerInput.run.orgId !== run.orgId
    )) return null;
    let effectiveResolver = resolveProfile;
    if (readerInput && profile.agentRuntimeType === "hermes_gateway"
      && !asRecord(run.contextSnapshot).rudderWorkspace
      && readerInput.binding?.workspaceBindingId) {
      const bindingRecord = readerInput.binding;
      const span = readerInput.span;
      const segment = readerInput.segment;
      const workspaceKey = readString(run.agentWorkspaceKey);
      if (!workspaceKey || !run.agentId || bindingRecord.orgId !== run.orgId
        || bindingRecord.agentId !== run.agentId
        || bindingRecord.runtimeType !== "hermes_gateway"
        || bindingRecord.id !== readString(asRecord(run.contextSnapshot).runtimeBindingId)
        || bindingRecord.id !== span.bindingId || span.runId !== run.id || span.orgId !== run.orgId
        || !segment || segment.id !== span.segmentId || segment.bindingId !== bindingRecord.id
        || segment.orgId !== run.orgId || binding?.id !== bindingRecord.id
        || binding.orgId !== run.orgId || binding.workspaceBindingId !== bindingRecord.workspaceBindingId) return null;
      let managedCwd: string;
      try {
        managedCwd = resolveDefaultAgentWorkspaceDir(run.orgId, workspaceKey);
      } catch {
        return null;
      }
      if (bindingRecord.workspaceBindingId !== managedCwd
        || readString(asRecord(run.sessionParamsAfterJson).cwd) !== managedCwd
        || readString(asRecord(readerInput.run.sessionParamsAfterJson).cwd) !== managedCwd) return null;
      effectiveResolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
        runtimeType: profile.agentRuntimeType,
        runtimeConfig: profile.runtimeConfig,
        cwd: managedCwd,
        resolutionMode: "historical",
      });
    }
    const persistedSessionParams = {
      ...asRecord(readerInput?.run.sessionParamsBeforeJson),
      ...asRecord(readerInput?.run.sessionParamsAfterJson),
    };
    const session = context?.session;
    const enrichedContext = session && Object.keys(persistedSessionParams).length > 0
      ? {
        ...context,
        session: {
          ...session,
          sessionParams: {
            ...session.sessionParams,
            ...persistedSessionParams,
          },
        },
      }
      : context;
    return effectiveResolver(runtimeType, binding, enrichedContext);
  };
}

export function createHistoricalRunNativeTranscriptReader(
  run: HistoricalRunProfileRun,
  revisions: readonly HistoricalRunConfigRevision[],
) {
  const profile = resolveHistoricalRunRuntimeProfile(run, revisions);
  return createHistoricalCodexTranscriptReaderHook({
    runtimeType: profile.agentRuntimeType, runtimeConfig: profile.runtimeConfig,
    cwd: profile.cwd, resolutionMode: "historical",
  }, createHistoricalRunRuntimeProviderCapabilityResolver(run, revisions));
}

function resolveBundleForRun(
  run: RunRow,
  revisionsByAgentId: Map<string, Array<typeof agentConfigRevisions.$inferSelect>>,
) {
  const revisions = revisionsByAgentId.get(run.agentId) ?? [];
  const runCreatedAt = new Date(run.createdAt).getTime();
  const revision = revisions.find((candidate) => new Date(candidate.createdAt).getTime() <= runCreatedAt) ?? null;
  const afterConfig = revision?.afterConfig ?? {
    agentRuntimeConfig: run.agentRuntimeConfig,
    runtimeConfig: run.runtimeConfig,
  };
  const afterConfigRecord = typeof afterConfig === "object" && afterConfig !== null ? afterConfig as Record<string, unknown> : {};

  return {
    agentRuntimeType: readString(asRecord(run.contextSnapshot).agentRuntimeType)
      ?? readString(afterConfigRecord.agentRuntimeType)
      ?? run.agentRuntimeType,
    agentConfigRevisionId: revision?.id ?? null,
    agentConfigRevisionCreatedAt: revision?.createdAt ? new Date(revision.createdAt).toISOString() : null,
    agentConfigFingerprint: hashValue(afterConfigRecord.agentRuntimeConfig ?? run.agentRuntimeConfig),
    runtimeConfigFingerprint: hashValue(afterConfigRecord.runtimeConfig ?? run.runtimeConfig),
  };
}

async function loadIssuesForRuns(db: Db, orgId: string, runRows: Array<Pick<RunRow, "issueId">>) {
  const issueIds = [...new Set(runRows.map((row) => row.issueId).filter((value): value is string => Boolean(value)))];
  if (issueIds.length === 0) return new Map<string, { id: string; identifier: string | null; title: string | null }>();

  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
    })
    .from(issues)
    .where(and(eq(issues.orgId, orgId), inArray(issues.id, issueIds)));

  return new Map(rows.map((row) => [row.id, row]));
}

async function loadRevisionsForRuns(db: Db, runRows: RunRow[]) {
  const agentIds = [...new Set(runRows.map((row) => row.agentId))];
  if (agentIds.length === 0) return new Map<string, Array<typeof agentConfigRevisions.$inferSelect>>();
  const rows = await db
    .select()
    .from(agentConfigRevisions)
    .where(inArray(agentConfigRevisions.agentId, agentIds))
    .orderBy(desc(agentConfigRevisions.createdAt));

  const revisionsByAgentId = new Map<string, Array<typeof agentConfigRevisions.$inferSelect>>();
  for (const row of rows) {
    const revisions = revisionsByAgentId.get(row.agentId) ?? [];
    revisions.push(row);
    revisionsByAgentId.set(row.agentId, revisions);
  }
  return revisionsByAgentId;
}

async function serializeRunRow(
  row: RunRow,
  issueMap: Map<string, { id: string; identifier: string | null; title: string | null }>,
  revisionsByAgentId: Map<string, Array<typeof agentConfigRevisions.$inferSelect>>,
  skillEvidenceMap?: Map<string, RunSkillEvidenceMatch>,
): Promise<RunExportRow> {
  const errorSummary = row.errorCode ?? row.error ?? row.stderrExcerpt ?? null;
  return {
    run: toHeartbeatRun({
      id: row.id,
      orgId: row.orgId,
      agentId: row.agentId,
      invocationSource: row.invocationSource as HeartbeatRun["invocationSource"],
      triggerDetail: row.triggerDetail as HeartbeatRun["triggerDetail"],
      status: row.status as HeartbeatRun["status"],
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      error: row.error,
      wakeupRequestId: row.wakeupRequestId,
      sourceRunId: row.sourceRunId,
      exitCode: row.exitCode,
      signal: row.signal,
      usageJson: row.usageJson,
      resultJson: row.resultJson,
      sessionIdBefore: row.sessionIdBefore,
      sessionIdAfter: row.sessionIdAfter,
      sessionReuseScope: row.sessionReuseScope,
      logStore: row.logStore,
      logRef: row.logRef,
      logBytes: row.logBytes,
      logSha256: row.logSha256,
      logCompressed: row.logCompressed,
      stdoutExcerpt: row.stdoutExcerpt,
      stderrExcerpt: row.stderrExcerpt,
      errorCode: row.errorCode,
      externalRunId: row.externalRunId,
      chatConversationId: row.chatConversationId,
      goalId: row.goalId,
      processPid: row.processPid,
      processStartedAt: row.processStartedAt,
      retryOfRunId: row.retryOfRunId,
      processLossRetryCount: row.processLossRetryCount,
      contextSnapshot: row.contextSnapshot,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    agentName: row.agentName,
    orgName: row.orgName,
    issue: row.issueId ? issueMap.get(row.issueId) ?? null : null,
    bundle: resolveBundleForRun(row, revisionsByAgentId),
    errorSummary,
    skillEvidence: skillEvidenceMap?.get(row.id) ?? null,
  };
}

async function loadRunRows(db: Db, input: ListObservedRunsInput): Promise<RunRow[]> {
  const conditions = [eq(heartbeatRuns.orgId, input.orgId)];
  if (input.sideChatOwnerId !== undefined) {
    conditions.push(sideChatVisibilityCondition(input.sideChatOwnerId));
  }
  if (input.updatedAfter) conditions.push(gt(heartbeatRuns.updatedAt, input.updatedAfter));
  if (input.createdBefore) conditions.push(lt(heartbeatRuns.createdAt, input.createdBefore));
  if (input.agentId) conditions.push(eq(heartbeatRuns.agentId, input.agentId));
  if (input.status) conditions.push(eq(heartbeatRuns.status, input.status));
  if (input.runtime) conditions.push(eq(agents.agentRuntimeType, input.runtime));
  if (input.runIdPrefix) {
    const runIdPrefix = input.runIdPrefix.replace(/-/g, "").toLowerCase();
    conditions.push(sql`replace(${heartbeatRuns.id}::text, '-', '') like ${`${runIdPrefix}%`}`);
  }
  if (input.issueId) conditions.push(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`);
  if (input.goalId) conditions.push(eq(heartbeatRuns.goalId, input.goalId));
  if (input.usedSkill) conditions.push(buildSkillExistsCondition("used", input.usedSkill));
  if (input.loadedSkill) conditions.push(buildSkillExistsCondition("loaded", input.loadedSkill));

  return await db
    .select({
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
      sessionReuseScope: heartbeatRuns.sessionReuseScope,
      logStore: heartbeatRuns.logStore,
      logRef: heartbeatRuns.logRef,
      logBytes: heartbeatRuns.logBytes,
      logSha256: heartbeatRuns.logSha256,
      logCompressed: heartbeatRuns.logCompressed,
      stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
      stderrExcerpt: heartbeatRuns.stderrExcerpt,
      errorCode: heartbeatRuns.errorCode,
      externalRunId: heartbeatRuns.externalRunId,
      chatConversationId: heartbeatRuns.chatConversationId,
      scene: heartbeatRuns.scene,
      goalId: heartbeatRuns.goalId,
      sourceRunId: heartbeatRuns.sourceRunId,
      processPid: heartbeatRuns.processPid,
      processStartedAt: heartbeatRuns.processStartedAt,
      retryOfRunId: heartbeatRuns.retryOfRunId,
      processLossRetryCount: heartbeatRuns.processLossRetryCount,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      createdAt: heartbeatRuns.createdAt,
      updatedAt: heartbeatRuns.updatedAt,
      agentName: agents.name,
      agentWorkspaceKey: agents.workspaceKey,
      agentRuntimeType: agents.agentRuntimeType,
      agentRuntimeConfig: agents.agentRuntimeConfig,
      runtimeConfig: agents.runtimeConfig,
      orgName: organizations.name,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .innerJoin(organizations, eq(heartbeatRuns.orgId, organizations.id))
    .where(and(...conditions))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(input.limit) as RunRow[];
}

async function loadSummaryRunRows(db: Db, input: ListRunSummariesInput): Promise<SummaryRunRow[]> {
  const conditions = [eq(heartbeatRuns.orgId, input.orgId)];
  if (input.sideChatOwnerId !== undefined) {
    conditions.push(sideChatVisibilityCondition(input.sideChatOwnerId));
  }
  if (input.updatedAfter) conditions.push(gt(heartbeatRuns.updatedAt, input.updatedAfter));
  if (input.createdBefore) conditions.push(lt(heartbeatRuns.createdAt, input.createdBefore));
  if (input.agentId) conditions.push(eq(heartbeatRuns.agentId, input.agentId));
  if (input.status) conditions.push(eq(heartbeatRuns.status, input.status));
  if (input.runtime) conditions.push(eq(agents.agentRuntimeType, input.runtime));
  if (input.runIdPrefix) {
    const runIdPrefix = input.runIdPrefix.replace(/-/g, "").toLowerCase();
    conditions.push(sql`replace(${heartbeatRuns.id}::text, '-', '') like ${`${runIdPrefix}%`}`);
  }
  if (input.issueId) conditions.push(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`);
  if (input.goalId) conditions.push(eq(heartbeatRuns.goalId, input.goalId));
  if (input.usedSkill) conditions.push(buildSkillExistsCondition("used", input.usedSkill));
  if (input.loadedSkill) conditions.push(buildSkillExistsCondition("loaded", input.loadedSkill));
  if (input.cursor) {
    const cursor = decodeRunSummaryCursor(input.cursor);
    conditions.push(or(
      lt(heartbeatRuns.createdAt, cursor.createdAt),
      and(eq(heartbeatRuns.createdAt, cursor.createdAt), lt(heartbeatRuns.id, cursor.id)),
    )!);
  }

  return await db
    .select({
      id: heartbeatRuns.id,
      orgId: heartbeatRuns.orgId,
      agentId: heartbeatRuns.agentId,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      status: heartbeatRuns.status,
      sessionReuseScope: heartbeatRuns.sessionReuseScope,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      errorText: sql<string | null>`left(coalesce(
        ${heartbeatRuns.errorCode},
        ${heartbeatRuns.error}
      ), 501)`.as("errorText"),
      logBytes: heartbeatRuns.logBytes,
      logStore: heartbeatRuns.logStore,
      logRef: heartbeatRuns.logRef,
      chatConversationId: heartbeatRuns.chatConversationId,
      scene: heartbeatRuns.scene,
      sourceRunId: heartbeatRuns.sourceRunId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      createdAt: heartbeatRuns.createdAt,
      updatedAt: heartbeatRuns.updatedAt,
      agentName: agents.name,
      agentRuntimeType: agents.agentRuntimeType,
      orgName: organizations.name,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
      targetType: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'targetType'`.as("targetType"),
      targetId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'targetId'`.as("targetId"),
      outcomeText: sql<string | null>`left(coalesce(
        ${heartbeatRuns.resultSummaryJson} ->> 'summary',
        ${heartbeatRuns.resultSummaryJson} ->> 'result',
        ${heartbeatRuns.resultSummaryJson} ->> 'message',
        ${heartbeatRuns.resultSummaryJson} ->> 'userMessage'
      ), 501)`.as("outcomeText"),
      usageInputTokens: sql<string | null>`${heartbeatRuns.usageJson} ->> 'inputTokens'`.as("usageInputTokens"),
      usageCachedInputTokens: sql<string | null>`coalesce(
        ${heartbeatRuns.usageJson} ->> 'cachedInputTokens',
        ${heartbeatRuns.usageJson} ->> 'cacheReadTokens'
      )`.as("usageCachedInputTokens"),
      usageOutputTokens: sql<string | null>`${heartbeatRuns.usageJson} ->> 'outputTokens'`.as("usageOutputTokens"),
      usageCostUsd: sql<string | null>`coalesce(
        ${heartbeatRuns.usageJson} ->> 'costUsd',
        ${heartbeatRuns.usageJson} ->> 'totalCostUsd'
      )`.as("usageCostUsd"),
      resultCostUsd: sql<string | null>`coalesce(
        ${heartbeatRuns.resultSummaryJson} ->> 'total_cost_usd',
        ${heartbeatRuns.resultSummaryJson} ->> 'cost_usd',
        ${heartbeatRuns.resultSummaryJson} ->> 'costUsd'
      )`.as("resultCostUsd"),
      usageProvider: sql<string | null>`${heartbeatRuns.usageJson} ->> 'provider'`.as("usageProvider"),
      usageModel: sql<string | null>`${heartbeatRuns.usageJson} ->> 'model'`.as("usageModel"),
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .innerJoin(organizations, eq(heartbeatRuns.orgId, organizations.id))
    .where(and(...conditions))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(input.limit + 1) as SummaryRunRow[];
}

async function loadSkillEvidenceForRuns(
  db: Db,
  runRows: Array<Pick<RunRow, "id" | "orgId">>,
  input: Pick<ListObservedRunsInput, "usedSkill" | "loadedSkill">,
  includeFirstEvidence = false,
) {
  const skillQuery = input.usedSkill ?? input.loadedSkill ?? null;
  const evidenceType: RunSkillEvidenceType = input.usedSkill ? "used" : "loaded";
  if ((!skillQuery && !includeFirstEvidence) || runRows.length === 0) return new Map<string, RunSkillEvidenceMatch>();

  const runIds = runRows.map((row) => row.id);
  const rows = await db
    .select({
      id: heartbeatRunEvents.id,
      runId: heartbeatRunEvents.runId,
      eventType: heartbeatRunEvents.eventType,
      payload: heartbeatRunEvents.payload,
      createdAt: heartbeatRunEvents.createdAt,
    })
    .from(heartbeatRunEvents)
    .where(
      and(
        eq(heartbeatRunEvents.orgId, runRows[0]!.orgId),
        inArray(heartbeatRunEvents.runId, runIds),
        inArray(heartbeatRunEvents.eventType, ["adapter.invoke", "adapter.skill_usage"]),
      ),
    )
    .orderBy(asc(heartbeatRunEvents.createdAt), asc(heartbeatRunEvents.id));

  const evidenceByRunId = new Map<string, RunSkillEvidenceMatch>();
  for (const row of rows) {
    const match = skillQuery
      ? extractSkillEvidenceMatch({
        payload: row.payload,
        evidenceType,
        skillQuery,
        eventType: row.eventType,
        eventId: row.id,
        eventCreatedAt: row.createdAt,
      })
      : extractFirstSkillEvidenceMatch({
        payload: row.payload,
        eventType: row.eventType,
        eventId: row.id,
        eventCreatedAt: row.createdAt,
      });
    if (!match) continue;
    const current = evidenceByRunId.get(row.runId);
    if (!current || (current.evidenceType === "loaded" && match.evidenceType === "used")) {
      evidenceByRunId.set(row.runId, match);
    }
  }
  return evidenceByRunId;
}

async function loadRunRowById(
  db: Db,
  runId: string,
  options: { diagnosticProjection?: boolean } = {},
): Promise<RunRow | null> {
  const diagnosticContextSnapshot = sql<Record<string, unknown> | null>`jsonb_strip_nulls(jsonb_build_object(
    'agentRuntimeType', ${heartbeatRuns.contextSnapshot}->'agentRuntimeType',
    'agent_runtime_type', ${heartbeatRuns.contextSnapshot}->'agent_runtime_type',
    'scene', ${heartbeatRuns.contextSnapshot}->'scene',
    'rudderScene', ${heartbeatRuns.contextSnapshot}->'rudderScene',
    'unifiedAgentRun', case
      when jsonb_typeof(${heartbeatRuns.contextSnapshot}->'unifiedAgentRun') = 'object'
        then jsonb_strip_nulls(jsonb_build_object('scene', ${heartbeatRuns.contextSnapshot}->'unifiedAgentRun'->'scene'))
      else null
    end,
    'issueId', ${heartbeatRuns.contextSnapshot}->'issueId',
    'targetType', ${heartbeatRuns.contextSnapshot}->'targetType',
    'targetId', ${heartbeatRuns.contextSnapshot}->'targetId'
  ))`.as("contextSnapshot");
  const contextTranscriptArrayOmitted = (key: string) => sql`case
    when jsonb_typeof(${heartbeatRuns.contextSnapshot}->${key}) = 'array'
      then jsonb_array_length(${heartbeatRuns.contextSnapshot}->${key}) > 0
    else false
  end`;
  const diagnosticContextTranscriptOmitted = sql<boolean>`(
    ${contextTranscriptArrayOmitted("__chatTranscript")}
    or ${contextTranscriptArrayOmitted("transcript")}
    or ${contextTranscriptArrayOmitted("entries")}
    or ${contextTranscriptArrayOmitted("items")}
  )`.as("diagnosticContextTranscriptOmitted");
  const diagnosticResultJson = sql<Record<string, unknown> | null>`null::jsonb`.as("resultJson");
  const diagnosticOmitted = sql<boolean>`coalesce(${heartbeatRuns.resultJson} <> '{}'::jsonb, false)`.as("diagnosticResultJsonOmitted");
  const diagnosticError = sql<string | null>`left(${heartbeatRuns.error}, 8_192)`.as("error");
  const diagnosticErrorLength = sql<number | null>`char_length(${heartbeatRuns.error})`.as("diagnosticErrorOriginalLength");
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      orgId: heartbeatRuns.orgId,
      agentId: heartbeatRuns.agentId,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      error: options.diagnosticProjection ? diagnosticError : heartbeatRuns.error,
      wakeupRequestId: heartbeatRuns.wakeupRequestId,
      exitCode: heartbeatRuns.exitCode,
      signal: heartbeatRuns.signal,
      usageJson: options.diagnosticProjection ? sql`null::jsonb`.as("usageJson") : heartbeatRuns.usageJson,
      resultJson: options.diagnosticProjection ? diagnosticResultJson : heartbeatRuns.resultJson,
      sessionIdBefore: heartbeatRuns.sessionIdBefore,
      sessionIdAfter: heartbeatRuns.sessionIdAfter,
      sessionParamsBeforeJson: heartbeatRuns.sessionParamsBeforeJson,
      sessionParamsAfterJson: heartbeatRuns.sessionParamsAfterJson,
      sessionReuseScope: heartbeatRuns.sessionReuseScope,
      logStore: heartbeatRuns.logStore,
      logRef: heartbeatRuns.logRef,
      logBytes: heartbeatRuns.logBytes,
      logSha256: heartbeatRuns.logSha256,
      logCompressed: heartbeatRuns.logCompressed,
      stdoutExcerpt: options.diagnosticProjection
        ? sql<string | null>`left(${heartbeatRuns.stdoutExcerpt}, 8_192)`.as("stdoutExcerpt")
        : heartbeatRuns.stdoutExcerpt,
      stderrExcerpt: options.diagnosticProjection
        ? sql<string | null>`left(${heartbeatRuns.stderrExcerpt}, 8_192)`.as("stderrExcerpt")
        : heartbeatRuns.stderrExcerpt,
      errorCode: heartbeatRuns.errorCode,
      externalRunId: heartbeatRuns.externalRunId,
      chatConversationId: heartbeatRuns.chatConversationId,
      scene: heartbeatRuns.scene,
      sourceRunId: heartbeatRuns.sourceRunId,
      processPid: heartbeatRuns.processPid,
      processStartedAt: heartbeatRuns.processStartedAt,
      retryOfRunId: heartbeatRuns.retryOfRunId,
      processLossRetryCount: heartbeatRuns.processLossRetryCount,
      contextSnapshot: options.diagnosticProjection ? diagnosticContextSnapshot : heartbeatRuns.contextSnapshot,
      ...(options.diagnosticProjection ? {
        diagnosticResultJsonOmitted: diagnosticOmitted,
        diagnosticContextTranscriptOmitted,
        diagnosticErrorOriginalLength: diagnosticErrorLength,
      } : {}),
      createdAt: heartbeatRuns.createdAt,
      updatedAt: heartbeatRuns.updatedAt,
      agentName: agents.name,
      agentWorkspaceKey: agents.workspaceKey,
      agentRuntimeType: agents.agentRuntimeType,
      agentRuntimeConfig: agents.agentRuntimeConfig,
      runtimeConfig: agents.runtimeConfig,
      orgName: organizations.name,
      issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`.as("issueId"),
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .innerJoin(organizations, eq(heartbeatRuns.orgId, organizations.id))
    .where(eq(heartbeatRuns.id, runId))
    .limit(1) as RunRow[];

  return rows[0] ?? null;
}

async function loadRunEvents(db: Db, runId: string): Promise<HeartbeatRunEvent[]> {
  const rows = await db
    .select()
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.runId, runId),
      ne(heartbeatRunEvents.eventType, ISSUE_EXECUTION_RELEASED_EVENT_TYPE),
    ))
    .orderBy(heartbeatRunEvents.seq, heartbeatRunEvents.id);
  return rows.map((row) => ({
    ...row,
    stream: row.stream as HeartbeatRunEvent["stream"],
    level: row.level as HeartbeatRunEvent["level"],
  }));
}

const TRANSCRIPT_ENTRY_FIELDS: Record<string, readonly string[]> = {
  assistant: ["text", "delta", "phase", "segmentId"],
  thinking: ["text", "delta", "segmentId"],
  user: ["text", "source", "messageId", "controlActionId"],
  tool_call: ["name", "input", "toolUseId"],
  tool_result: ["toolUseId", "toolName", "content", "isError"],
  todo_list: ["todoListId", "items"],
  init: ["model", "sessionId"],
  result: ["text", "inputTokens", "outputTokens", "cachedTokens", "costUsd", "subtype", "isError", "errors"],
  stderr: ["text"],
  system: ["text"],
  stdout: ["text"],
};

const TRANSCRIPT_TEXT_KINDS = new Set(["assistant", "thinking", "user", "result", "stderr", "system", "stdout"]);

function transcriptEntryFromReaderItem(item: TranscriptItem): TranscriptEntry | null {
  const entry = item.entry && typeof item.entry === "object" && !Array.isArray(item.entry)
    ? item.entry as Record<string, unknown>
    : null;
  const payload = asRecord(item.payload);
  const source = entry ?? payload;
  const projected: Record<string, unknown> = { kind: item.kind, ts: item.ts };
  const fields = TRANSCRIPT_ENTRY_FIELDS[item.kind] ?? ["text"];

  for (const field of fields) {
    const value = field === "text" && typeof item.text === "string"
      ? item.text
      : source?.[field];
    if (value !== undefined) projected[field] = value;
  }

  const sourceEntryId = typeof item.sourceEntryId === "string" && item.sourceEntryId.length > 0
    ? item.sourceEntryId
    : source?.sourceEntryId;
  if (typeof sourceEntryId === "string") projected.sourceEntryId = sourceEntryId;
  const originalLengths = asRecord(source?.__rudderOriginalLengths);
  if (originalLengths) {
    const validLengths = Object.fromEntries(
      Object.entries(originalLengths)
        .filter(([, length]) => typeof length === "number" && Number.isFinite(length) && length > 0),
    );
    if (Object.keys(validLengths).length > 0) projected.__rudderOriginalLengths = validLengths;
  }
  const truncatedFields = source?.__rudderTruncatedFields;
  if (Array.isArray(truncatedFields)) {
    const validFields = truncatedFields
      .filter((field): field is string => typeof field === "string" && field.length > 0)
      .slice(0, 32)
      .map((field) => field.slice(0, 128));
    if (validFields.length > 0) projected.__rudderTruncatedFields = validFields;
  }

  // Native items carry useful structured data outside the legacy entry shape.
  // Keep it nested, without promoting unrelated reader metadata into the entry.
  if (!entry && item.payload !== undefined) projected.payload = item.payload;
  if (TRANSCRIPT_TEXT_KINDS.has(item.kind) && typeof projected.text !== "string") return null;

  return projected as unknown as TranscriptEntry;
}

async function createHistoricalRunTranscriptReader(
  db: Db,
  run: RunRow,
  options: {
    diagnosticProjection?: boolean;
    maxLegacyReadBytes?: number;
    maxLegacyItemBytes?: number;
  } = {},
) {
  const revisionsByAgentId = await loadRevisionsForRuns(db, [run]);
  const logStore = getRunLogStore();
  const legacyReader = createLegacyTranscriptReader({
    logStore,
    ...(options.diagnosticProjection ? {
      maxReadBytes: MAX_DIAGNOSTIC_TRANSCRIPT_PAGE_BYTES,
      maxTotalBytes: MAX_DIAGNOSTIC_TRANSCRIPT_BYTES,
      maxItemBytes: MAX_DIAGNOSTIC_TRANSCRIPT_PAGE_BYTES,
    } : {
      ...(options.maxLegacyReadBytes === undefined ? {} : { maxReadBytes: options.maxLegacyReadBytes }),
      ...(options.maxLegacyItemBytes === undefined ? {} : { maxItemBytes: options.maxLegacyItemBytes }),
    }),
  });
  return createTranscriptReader(db, {
    nativeReader: createHistoricalRunNativeTranscriptReader(run, revisionsByAgentId.get(run.agentId) ?? []),
    objectReader: createTranscriptObjectReader(),
    logStore,
    legacyReader: {
      readRun(input) {
        return legacyReader.readRun({ ...input, runtimeType: run.agentRuntimeType });
      },
    },
    ...(options.diagnosticProjection ? {
      diagnosticProjection: true,
      maxLegacyReadBytes: MAX_DIAGNOSTIC_TRANSCRIPT_PAGE_BYTES,
      maxLegacyTotalBytes: MAX_DIAGNOSTIC_TRANSCRIPT_BYTES,
      maxLegacyItemBytes: MAX_DIAGNOSTIC_TRANSCRIPT_PAGE_BYTES,
    } : {
      ...(options.maxLegacyReadBytes === undefined ? {} : { maxLegacyReadBytes: options.maxLegacyReadBytes }),
      ...(options.maxLegacyItemBytes === undefined ? {} : { maxLegacyItemBytes: options.maxLegacyItemBytes }),
    }),
  });
}

type RunTranscriptRead = { entries: TranscriptEntry[] };

async function loadRunTranscriptFromReader(db: Db, orgId: string, runId: string): Promise<RunTranscriptRead> {
  const run = await loadRunRowById(db, runId);
  if (!run || run.orgId !== orgId) return { entries: [] };
  const reader = await createHistoricalRunTranscriptReader(db, run);
  const entries: TranscriptEntry[] = [];
  let cursor: string | null = null;
  for (let pageCount = 0; pageCount < 100_000; pageCount += 1) {
    const page = await reader.readRun({
      orgId,
      runId,
      principal: { type: "board", orgId, authorized: true },
      cursor,
      limit: 200,
    });
    for (const item of page.items) {
      const entry = transcriptEntryFromReaderItem(item);
      if (entry) entries.push(entry);
    }
    if (!page.nextCursor) return { entries };
    if (page.nextCursor === cursor) throw new Error("Transcript reader cursor made no progress");
    cursor = page.nextCursor;
  }
  throw new Error("Transcript reader exceeded the page limit");
}

export interface ObservedRunTranscriptPageInput {
  cursor?: string | null;
  limit?: number;
  maxLegacyReadBytes?: number;
  maxLegacyItemBytes?: number;
  spanId?: string | null;
  range?: TranscriptRange | null;
  visibilityCutoffRef?: string | null;
}

export async function getObservedRunTranscript(
  db: Db,
  runId: string,
  scope: RunIdResolutionScope = {},
  input: ObservedRunTranscriptPageInput = {},
): Promise<{ orgId: string; run: RunExportRow; page: TranscriptPage }> {
  const resolvedRunId = await resolveRunIdReferenceForScope(db, runId, scope);
  const runAccess = await loadRunAccess(db, resolvedRunId);
  if (!runAccess) throw notFound("Agent run not found");
  await assertRunIntelligenceAccess(db, runAccess, scope);
  const orgId = runAccess.orgId;

  const [run, observedRun] = await Promise.all([
    loadRunRowById(db, resolvedRunId),
    getObservedRun(db, resolvedRunId, scope),
  ]);
  if (!run || !observedRun) throw notFound("Agent run not found");

  const reader = await createHistoricalRunTranscriptReader(db, run, {
    maxLegacyReadBytes: input.maxLegacyReadBytes,
    maxLegacyItemBytes: input.maxLegacyItemBytes,
  });
  const page = await reader.readRun({
    orgId,
    runId: resolvedRunId,
    principal: { type: "board", orgId, authorized: true },
    cursor: input.cursor ?? null,
    limit: input.limit,
    spanId: input.spanId ?? null,
    range: input.range ?? null,
    visibilityCutoffRef: input.visibilityCutoffRef ?? null,
  });
  return { orgId, run: observedRun, page };
}

export async function listObservedRuns(db: Db, input: ListObservedRunsInput): Promise<RunExportRow[]> {
  const rows = await loadRunRows(db, input);
  const [issueMap, revisionsByAgentId, skillEvidenceMap] = await Promise.all([
    loadIssuesForRuns(db, input.orgId, rows),
    loadRevisionsForRuns(db, rows),
    loadSkillEvidenceForRuns(db, rows, input),
  ]);
  return Promise.all(rows.map((row) => serializeRunRow(row, issueMap, revisionsByAgentId, skillEvidenceMap)));
}

export async function listRunSummaries(db: Db, input: ListRunSummariesInput): Promise<RunSummaryPage> {
  const fetchedRows = await loadSummaryRunRows(db, input);
  const hasMore = fetchedRows.length > input.limit;
  const rows = hasMore ? fetchedRows.slice(0, input.limit) : fetchedRows;
  const [issueMap, skillEvidenceMap] = await Promise.all([
    loadIssuesForRuns(db, input.orgId, rows),
    loadSkillEvidenceForRuns(db, rows, input, true),
  ]);

  const items: RunSummary[] = rows.map((row) => {
    const inputTokens = finiteNonNegativeNumber(row.usageInputTokens);
    const cachedInputTokens = finiteNonNegativeNumber(row.usageCachedInputTokens);
    const outputTokens = finiteNonNegativeNumber(row.usageOutputTokens);
    const costUsd = finiteNonNegativeNumber(row.usageCostUsd) ?? finiteNonNegativeNumber(row.resultCostUsd);
    const hasUsage = inputTokens !== null || cachedInputTokens !== null || outputTokens !== null
      || costUsd !== null || Boolean(row.usageProvider) || Boolean(row.usageModel);
    const tokenSummary = summarizeTokenUsage({
      inputTokens,
      cachedInputTokens,
      outputTokens,
      provider: row.usageProvider,
    });
    const durationMs = row.startedAt && row.finishedAt
      ? Math.max(0, row.finishedAt.getTime() - row.startedAt.getTime())
      : null;

    return {
      id: row.id,
      shortRef: shortRefFor("run", row.id),
      orgId: row.orgId,
      orgName: row.orgName,
      agentId: row.agentId,
      agentName: row.agentName,
      runtime: row.agentRuntimeType,
      invocationSource: row.invocationSource as RunSummary["invocationSource"],
      triggerDetail: row.triggerDetail as RunSummary["triggerDetail"],
      status: row.status as RunSummary["status"],
      sessionReuseScope: row.sessionReuseScope,
      sourceRunId: row.sourceRunId,
      scene: toAgentRunOrigin({
        id: row.id,
        invocationSource: row.invocationSource,
        triggerDetail: row.triggerDetail,
        wakeupRequestId: null,
        sourceRunId: row.sourceRunId,
        contextSnapshot: row.contextSnapshot,
      }).scene,
      issue: row.issueId ? issueMap.get(row.issueId) ?? null : null,
      target: row.targetType && row.targetId ? { type: row.targetType, id: row.targetId } : null,
      chatConversationId: row.chatConversationId,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      outcome: clipSummaryText(row.outcomeText),
      error: clipSummaryText(row.errorText),
      usage: hasUsage ? {
        inputTokens: tokenSummary.inputTokens,
        cachedInputTokens: tokenSummary.cachedInputTokens,
        outputTokens: tokenSummary.outputTokens,
        totalTokens: tokenSummary.totalTokens,
        costUsd,
        provider: row.usageProvider,
        model: row.usageModel,
      } : null,
      skillEvidence: skillEvidenceMap.get(row.id) ?? null,
      hasLog: Boolean(row.logStore && row.logRef),
      logBytes: Math.max(0, Number(row.logBytes ?? 0) || 0),
    };
  });

  return {
    items,
    page: {
      limit: input.limit,
      hasMore,
      nextCursor: hasMore && rows.length > 0 ? encodeRunSummaryCursor(rows[rows.length - 1]!) : null,
    },
  };
}

export async function getRunSummary(
  db: Db,
  runId: string,
  scope: RunIdResolutionScope = {},
): Promise<RunSummary | null> {
  const resolvedRunId = await resolveRunIdReferenceForScope(db, runId, scope);
  const runAccess = await loadRunAccess(db, resolvedRunId);
  if (!runAccess) return null;
  await assertRunIntelligenceAccess(db, runAccess, scope);
  const page = await listRunSummaries(db, {
    orgId: runAccess.orgId,
    runIdPrefix: resolvedRunId,
    sideChatOwnerId: scope.sideChatOwnerId,
    limit: 1,
  });
  return page.items.find((row) => row.id === resolvedRunId) ?? null;
}

type RunIdResolutionScope = RunIntelligenceAccessScope;

type RunAccessRow = {
  orgId: string;
  chatConversationId: string | null;
  scene: string | null;
  contextSnapshot: Record<string, unknown> | null;
};

async function loadRunAccess(db: Db, runId: string): Promise<RunAccessRow | null> {
  return db
    .select({
      orgId: heartbeatRuns.orgId,
      chatConversationId: heartbeatRuns.chatConversationId,
      scene: heartbeatRuns.scene,
      contextSnapshot: sql<Record<string, unknown> | null>`jsonb_strip_nulls(jsonb_build_object(
        'scene', ${heartbeatRuns.contextSnapshot}->'scene',
        'rudderScene', ${heartbeatRuns.contextSnapshot}->'rudderScene',
        'unifiedAgentRun', case
          when jsonb_typeof(${heartbeatRuns.contextSnapshot}->'unifiedAgentRun') = 'object'
            then jsonb_strip_nulls(jsonb_build_object('scene', ${heartbeatRuns.contextSnapshot}->'unifiedAgentRun'->'scene'))
          else null
        end
      ))`.as("contextSnapshot"),
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function getObservedRun(db: Db, runId: string, scope: RunIdResolutionScope = {}): Promise<RunExportRow | null> {
  const resolvedRunId = await resolveRunIdReferenceForScope(db, runId, scope);
  const runAccess = await loadRunAccess(db, resolvedRunId);
  if (!runAccess) return null;
  await assertRunIntelligenceAccess(db, runAccess, scope);
  const row = await loadRunRowById(db, resolvedRunId);
  if (!row) return null;
  const [issueMap, revisionsByAgentId] = await Promise.all([
    loadIssuesForRuns(db, runAccess.orgId, [row]),
    loadRevisionsForRuns(db, [row]),
  ]);
  return serializeRunRow(row, issueMap, revisionsByAgentId);
}

export async function getObservedRunEvents(
  db: Db,
  runId: string,
  scope: RunIdResolutionScope = {},
  input: {
    cursor?: string | null;
    afterSeq?: number;
    limit?: number;
    includePayload?: boolean;
    maxPayloadChars?: number;
  } = {},
) {
  const resolvedRunId = await resolveRunIdReferenceForScope(db, runId, scope);
  const runAccess = await loadRunAccess(db, resolvedRunId);
  if (!runAccess) throw notFound("Agent run not found");
  await assertRunIntelligenceAccess(db, runAccess, scope);
  const orgId = runAccess.orgId;
  const afterSeq = Math.max(0, Math.floor(input.afterSeq ?? 0));
  const cursor = input.cursor ? decodeRunEventCursor(input.cursor) : null;
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 200)));
  const conditions = [
    eq(heartbeatRunEvents.runId, resolvedRunId),
    ne(heartbeatRunEvents.eventType, ISSUE_EXECUTION_RELEASED_EVENT_TYPE),
  ];
  if (cursor) {
    conditions.push(or(
      gt(heartbeatRunEvents.seq, cursor.seq),
      and(eq(heartbeatRunEvents.seq, cursor.seq), gt(heartbeatRunEvents.id, cursor.id)),
    )!);
  } else if (afterSeq > 0) {
    conditions.push(gt(heartbeatRunEvents.seq, afterSeq));
  }
  const fetched = await db
    .select()
    .from(heartbeatRunEvents)
    .where(and(...conditions))
    .orderBy(asc(heartbeatRunEvents.seq), asc(heartbeatRunEvents.id))
    .limit(limit + 1);
  const hasMore = fetched.length > limit;
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const maxPayloadChars = Math.max(100, Math.min(4_000, Math.floor(input.maxPayloadChars ?? 1_200)));
  const items = (hasMore ? fetched.slice(0, limit) : fetched).map((event) => {
    const redacted = redactCurrentUserValue({
      ...event,
      stream: event.stream as HeartbeatRunEvent["stream"],
      level: event.level as HeartbeatRunEvent["level"],
      payload: redactEventPayload(event.payload),
    }, currentUserRedactionOptions);
    const payloadText = redacted.payload == null ? "" : JSON.stringify(redacted.payload);
    return {
      ...redacted,
      payload: input.includePayload ? redacted.payload : null,
      payloadPreview: payloadText
        ? {
          text: payloadText.length <= maxPayloadChars
            ? payloadText
            : `${payloadText.slice(0, maxPayloadChars - 1)}…`,
          clipped: payloadText.length > maxPayloadChars,
          originalLength: payloadText.length,
        }
        : null,
    };
  });
  const nextCursor = hasMore && items.length > 0
    ? encodeRunEventCursor(items[items.length - 1]!)
    : null;
  const page: RunEventCursorPage = {
    cursor: input.cursor ?? null,
    afterSeq: input.cursor ? null : afterSeq,
    limit,
    hasMore,
    nextCursor,
  };
  return {
    orgId,
    response: {
      items,
      page: {
        ...page,
        nextAfterSeq: hasMore && items.length > 0 ? items[items.length - 1]!.seq : null,
      },
    },
  };
}

export async function getObservedRunLog(
  db: Db,
  runId: string,
  scope: RunIdResolutionScope = {},
  input: { offset?: number; limitBytes?: number; signal?: AbortSignal } = {},
) {
  const resolvedRunId = await resolveRunIdReferenceForScope(db, runId, scope);
  const runAccess = await loadRunAccess(db, resolvedRunId);
  if (!runAccess) throw notFound("Agent run not found");
  await assertRunIntelligenceAccess(db, runAccess, scope);
  const orgId = runAccess.orgId;
  const heartbeat = heartbeatService(db);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const limitBytes = Math.max(4, Math.min(1_000_000, Math.floor(input.limitBytes ?? 256_000)));
  const result = await heartbeat.readLog(resolvedRunId, { offset, limitBytes, signal: input.signal });
  return {
    orgId,
    response: {
      ...result,
      page: {
        offset,
        limitBytes,
        endOffset: result.endOffset,
        eof: result.eof,
        nextOffset: result.nextOffset ?? null,
      },
    },
  };
}

export async function getObservedRunDetail(db: Db, runId: string, scope: RunIdResolutionScope = {}): Promise<ObservedRunDetail | null> {
  const resolvedRunId = await resolveRunIdReferenceForScope(db, runId, scope);
  const observedRun = await getObservedRun(db, resolvedRunId, scope);
  if (!observedRun) return null;
  const [events, readerTranscript] = await Promise.all([
    loadRunEvents(db, resolvedRunId),
    loadRunTranscriptFromReader(db, observedRun.run.orgId, resolvedRunId)
      .catch((): RunTranscriptRead => ({ entries: [] })),
  ]);

  const run = { ...observedRun.run, chatConversationId: observedRun.run.chatConversationId ?? null };
  const detail = observedRunFromFilesystem({
    run,
    agentName: observedRun.agentName,
    orgName: observedRun.orgName,
    issue: observedRun.issue,
    bundle: observedRun.bundle,
    events,
    logContent: null,
    transcript: readerTranscript.entries.length > 0 ? readerTranscript.entries : undefined,
  });
  return detail;
}

export async function getObservedRunDiagnosticDetail(
  db: Db,
  runId: string,
  scope: RunIdResolutionScope = {},
  options: { position?: RunDiagnosticReaderPosition } = {},
): Promise<{
  detail: ObservedRunDetail;
  projection: RunDiagnosticProjection;
  entryPositions: RunDiagnosticEntryPosition[];
  nextPosition: RunDiagnosticReaderPosition | null;
  revision: string | null;
} | null> {
  const resolvedRunId = await resolveRunIdReferenceForScope(db, runId, scope);
  const runAccess = await loadRunAccess(db, resolvedRunId);
  if (!runAccess) return null;
  await assertRunIntelligenceAccess(db, runAccess, scope);

  const row = await loadRunRowById(db, resolvedRunId, { diagnosticProjection: true });
  if (!row || row.orgId !== runAccess.orgId) return null;
  const revisionsByAgentId = new Map<string, Array<typeof agentConfigRevisions.$inferSelect>>([[row.agentId, []]]);
  const observedRun = await serializeRunRow(row, new Map(), revisionsByAgentId);
  const reader = await createHistoricalRunTranscriptReader(db, row, { diagnosticProjection: true });
  const omittedSources = [
    ...(row.diagnosticResultJsonOmitted ? ["resultJson"] : []),
    ...(row.diagnosticContextTranscriptOmitted ? ["contextSnapshot.transcriptCandidates"] : []),
  ];
  const transcript = await readBoundedRunDiagnosticTranscript({
    readPage: (cursor, limit) => reader.readRun({
      orgId: runAccess.orgId,
      runId: resolvedRunId,
      principal: { type: "board", orgId: runAccess.orgId, authorized: true },
      cursor,
      limit,
    }),
    toEntry: transcriptEntryFromReaderItem,
    position: options.position,
    omittedSources,
  });
  if (row.diagnosticErrorOriginalLength && row.diagnosticErrorOriginalLength > (row.error?.length ?? 0)) {
    (observedRun.run as HeartbeatRun & { __rudderOriginalLengths?: Record<string, number> })
      .__rudderOriginalLengths = { error: row.diagnosticErrorOriginalLength };
  }

  return {
    detail: observedRunFromFilesystem({
      run: observedRun.run,
      agentName: observedRun.agentName,
      orgName: observedRun.orgName,
      issue: observedRun.issue,
      bundle: observedRun.bundle,
      transcript: transcript.entries,
    }),
    projection: transcript.projection,
    entryPositions: transcript.entryPositions,
    nextPosition: transcript.nextPosition,
    revision: transcript.revision,
  };
}

export async function diagnoseObservedRun(
  db: Db,
  runId: string,
  mode: RunDiagnosisMode = "auto",
): Promise<{ detail: ObservedRunDetail; diagnosis: RunDiagnosis }> {
  const detail = await getObservedRunDetail(db, runId);
  if (!detail) throw notFound("Agent run not found");
  return {
    detail,
    diagnosis: diagnoseRun(detail, mode),
  };
}
