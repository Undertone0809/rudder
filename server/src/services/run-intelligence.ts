import { createHash } from "node:crypto";
import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import { agentConfigRevisions, agents, heartbeatRunEvents, heartbeatRuns, issues, organizations } from "@rudderhq/db";
import {
  buildLangfuseRunScores,
  diagnoseRun,
  observedRunFromFilesystem,
  type ObservedRunDetail,
  type RunDiagnosis,
  type RunDiagnosisMode,
  type RunExportRow,
} from "@rudderhq/run-intelligence-core";
import type { HeartbeatRun, HeartbeatRunEvent } from "@rudderhq/shared";
import { notFound } from "../errors.js";
import { getExecutionLangfuseLink } from "../langfuse.js";
import { getRunLogStore } from "./run-log-store.js";

function hashValue(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

type RunRow = typeof heartbeatRuns.$inferSelect & {
  agentName: string | null;
  agentRuntimeType: string;
  agentRuntimeConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  orgName: string | null;
  issueId: string | null;
};

export interface ListObservedRunsInput {
  orgId: string;
  updatedAfter?: Date | null;
  runIdPrefix?: string | null;
  agentId?: string | null;
  status?: string | null;
  runtime?: string | null;
  issueId?: string | null;
  createdBefore?: Date | null;
  limit: number;
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
    agentRuntimeType: run.agentRuntimeType,
    agentConfigRevisionId: revision?.id ?? null,
    agentConfigRevisionCreatedAt: revision?.createdAt ? new Date(revision.createdAt).toISOString() : null,
    agentConfigFingerprint: hashValue(afterConfigRecord.agentRuntimeConfig ?? run.agentRuntimeConfig),
    runtimeConfigFingerprint: hashValue(afterConfigRecord.runtimeConfig ?? run.runtimeConfig),
  };
}

async function loadIssuesForRuns(db: Db, runRows: RunRow[]) {
  const issueIds = [...new Set(runRows.map((row) => row.issueId).filter((value): value is string => Boolean(value)))];
  if (issueIds.length === 0) return new Map<string, { id: string; identifier: string | null; title: string | null }>();

  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
    })
    .from(issues)
    .where(inArray(issues.id, issueIds));

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
): Promise<RunExportRow> {
  return {
    run: {
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
      exitCode: row.exitCode,
      signal: row.signal,
      usageJson: row.usageJson,
      resultJson: row.resultJson,
      sessionIdBefore: row.sessionIdBefore,
      sessionIdAfter: row.sessionIdAfter,
      logStore: row.logStore,
      logRef: row.logRef,
      logBytes: row.logBytes,
      logSha256: row.logSha256,
      logCompressed: row.logCompressed,
      stdoutExcerpt: row.stdoutExcerpt,
      stderrExcerpt: row.stderrExcerpt,
      errorCode: row.errorCode,
      externalRunId: row.externalRunId,
      processPid: row.processPid,
      processStartedAt: row.processStartedAt,
      retryOfRunId: row.retryOfRunId,
      processLossRetryCount: row.processLossRetryCount,
      contextSnapshot: row.contextSnapshot,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    agentName: row.agentName,
    orgName: row.orgName,
    issue: row.issueId ? issueMap.get(row.issueId) ?? null : null,
    bundle: resolveBundleForRun(row, revisionsByAgentId),
    langfuse: await getExecutionLangfuseLink(row.id),
  };
}

async function loadRunRows(db: Db, input: ListObservedRunsInput): Promise<RunRow[]> {
  const conditions = [eq(heartbeatRuns.orgId, input.orgId)];
  if (input.updatedAfter) conditions.push(gt(heartbeatRuns.updatedAt, input.updatedAfter));
  if (input.createdBefore) conditions.push(lt(heartbeatRuns.createdAt, input.createdBefore));
  if (input.agentId) conditions.push(eq(heartbeatRuns.agentId, input.agentId));
  if (input.status) conditions.push(eq(heartbeatRuns.status, input.status));
  if (input.runtime) conditions.push(eq(agents.agentRuntimeType, input.runtime));
  if (input.runIdPrefix) conditions.push(sql`${heartbeatRuns.id}::text ilike ${`${input.runIdPrefix}%`}`);
  if (input.issueId) conditions.push(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`);

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
      logStore: heartbeatRuns.logStore,
      logRef: heartbeatRuns.logRef,
      logBytes: heartbeatRuns.logBytes,
      logSha256: heartbeatRuns.logSha256,
      logCompressed: heartbeatRuns.logCompressed,
      stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
      stderrExcerpt: heartbeatRuns.stderrExcerpt,
      errorCode: heartbeatRuns.errorCode,
      externalRunId: heartbeatRuns.externalRunId,
      processPid: heartbeatRuns.processPid,
      processStartedAt: heartbeatRuns.processStartedAt,
      retryOfRunId: heartbeatRuns.retryOfRunId,
      processLossRetryCount: heartbeatRuns.processLossRetryCount,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      createdAt: heartbeatRuns.createdAt,
      updatedAt: heartbeatRuns.updatedAt,
      agentName: agents.name,
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

async function loadRunRowById(db: Db, runId: string): Promise<RunRow | null> {
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
      stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
      stderrExcerpt: heartbeatRuns.stderrExcerpt,
      errorCode: heartbeatRuns.errorCode,
      externalRunId: heartbeatRuns.externalRunId,
      processPid: heartbeatRuns.processPid,
      processStartedAt: heartbeatRuns.processStartedAt,
      retryOfRunId: heartbeatRuns.retryOfRunId,
      processLossRetryCount: heartbeatRuns.processLossRetryCount,
      contextSnapshot: heartbeatRuns.contextSnapshot,
      createdAt: heartbeatRuns.createdAt,
      updatedAt: heartbeatRuns.updatedAt,
      agentName: agents.name,
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
    .where(eq(heartbeatRunEvents.runId, runId))
    .orderBy(heartbeatRunEvents.seq, heartbeatRunEvents.id);
  return rows.map((row) => ({
    ...row,
    stream: row.stream as HeartbeatRunEvent["stream"],
    level: row.level as HeartbeatRunEvent["level"],
  }));
}

async function loadRunLogContent(run: typeof heartbeatRuns.$inferSelect) {
  if (!run.logStore || !run.logRef) return "";
  const logStore = getRunLogStore();
  const result = await logStore.read(
    {
      store: run.logStore as "local_file",
      logRef: run.logRef,
    },
    {
      offset: 0,
      limitBytes: Math.max(256_000, Number(run.logBytes ?? 0) || 256_000),
    },
  );
  return result.content;
}

export async function listObservedRuns(db: Db, input: ListObservedRunsInput): Promise<RunExportRow[]> {
  const rows = await loadRunRows(db, input);
  const [issueMap, revisionsByAgentId] = await Promise.all([
    loadIssuesForRuns(db, rows),
    loadRevisionsForRuns(db, rows),
  ]);
  return Promise.all(rows.map((row) => serializeRunRow(row, issueMap, revisionsByAgentId)));
}

export async function getObservedRun(db: Db, runId: string): Promise<RunExportRow | null> {
  const row = await loadRunRowById(db, runId);
  if (!row) return null;
  const [issueMap, revisionsByAgentId] = await Promise.all([
    loadIssuesForRuns(db, [row]),
    loadRevisionsForRuns(db, [row]),
  ]);
  return serializeRunRow(row, issueMap, revisionsByAgentId);
}

export async function getObservedRunEvents(db: Db, runId: string) {
  const run = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run) throw notFound("Heartbeat run not found");
  return loadRunEvents(db, runId);
}

export async function getObservedRunLog(db: Db, runId: string) {
  const run = await db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!run) throw notFound("Heartbeat run not found");
  return { content: await loadRunLogContent(run) };
}

export async function getObservedRunDetail(db: Db, runId: string): Promise<ObservedRunDetail | null> {
  const [observedRun, events] = await Promise.all([
    getObservedRun(db, runId),
    loadRunEvents(db, runId),
  ]);
  if (!observedRun) return null;

  const logContent = await loadRunLogContent(observedRun.run).catch(() => "");
  return observedRunFromFilesystem({
    run: observedRun.run,
    agentName: observedRun.agentName,
    orgName: observedRun.orgName,
    issue: observedRun.issue,
    bundle: observedRun.bundle,
    events,
    logContent,
  });
}

export async function diagnoseObservedRun(
  db: Db,
  runId: string,
  mode: RunDiagnosisMode = "auto",
): Promise<{ detail: ObservedRunDetail; diagnosis: RunDiagnosis }> {
  const detail = await getObservedRunDetail(db, runId);
  if (!detail) throw notFound("Heartbeat run not found");
  return {
    detail,
    diagnosis: diagnoseRun(detail, mode),
  };
}

export async function buildObservedRunLangfuseScores(db: Db, runId: string) {
  const { detail, diagnosis } = await diagnoseObservedRun(db, runId);
  return {
    detail,
    diagnosis,
    scores: buildLangfuseRunScores(detail, diagnosis),
  };
}
