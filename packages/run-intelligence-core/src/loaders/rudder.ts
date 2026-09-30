import type { TranscriptEntry, TranscriptTodoItemStatus } from "@rudderhq/agent-runtime-utils";
import type { HeartbeatRun, HeartbeatRunEvent, RunSummary, RunSummaryPage } from "@rudderhq/shared";
import { diagnoseRun } from "../diagnosis.js";
import { getTranscriptParser } from "../parsers.js";
import { buildTranscript, parseNdjsonLog } from "../transcript.js";
import { getHistoricalTranscriptParser } from "../parsers.js";
import type { ObservedRunDetail, RunDiagnosis, RunDiagnosisMode, RunExportRow } from "../types.js";

class RudderApiError extends Error {
  constructor(readonly status: number, url: string) {
    super(`Request failed (${status}) for ${url}`);
    this.name = "RudderApiError";
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new RudderApiError(response.status, url);
  }
  return response.json() as Promise<T>;
}

export async function listOrganizations(apiBaseUrl: string): Promise<Array<{ id: string; name: string }>> {
  return fetchJson<Array<{ id: string; name: string }>>(`${apiBaseUrl}/orgs`);
}

export async function listObservedRuns(
  apiBaseUrl: string,
  orgId: string,
  params?: URLSearchParams,
): Promise<RunExportRow[]> {
  const query = new URLSearchParams(params);
  query.set("projection", "full");
  return fetchJson<RunExportRow[]>(
    `${apiBaseUrl}/run-intelligence/orgs/${encodeURIComponent(orgId)}/runs?${query.toString()}`,
  );
}

export async function listObservedRunSummaries(
  apiBaseUrl: string,
  orgId: string,
  params?: URLSearchParams,
): Promise<RunSummaryPage> {
  const query = new URLSearchParams(params);
  query.set("projection", "summary");
  return fetchJson<RunSummaryPage>(
    `${apiBaseUrl}/run-intelligence/orgs/${encodeURIComponent(orgId)}/runs?${query.toString()}`,
  );
}

export async function getObservedRun(apiBaseUrl: string, runId: string): Promise<RunExportRow> {
  return fetchJson<RunExportRow>(
    `${apiBaseUrl}/run-intelligence/runs/${encodeURIComponent(runId)}?projection=full`,
  );
}

interface RunEventsPage {
  items: HeartbeatRunEvent[];
  page: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}

interface RunLogPage {
  content: string;
  page: {
    eof: boolean;
    nextOffset: number | null;
  };
}

interface RunTranscriptPage {
  entries?: Array<{ entry: TranscriptEntry | null }>;
  page: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export async function getRunEvents(apiBaseUrl: string, runId: string): Promise<HeartbeatRunEvent[]> {
  const events: HeartbeatRunEvent[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "200", projection: "full" });
    if (cursor) query.set("cursor", cursor);
    const page = await fetchJson<RunEventsPage>(
      `${apiBaseUrl}/run-intelligence/runs/${encodeURIComponent(runId)}/events?${query.toString()}`,
    );
    events.push(...page.items);
    if (!page.page.hasMore || page.page.nextCursor === null) return events;
    cursor = page.page.nextCursor;
  } while (true);
}

export async function getRunLog(apiBaseUrl: string, runId: string): Promise<{ content: string }> {
  const chunks: string[] = [];
  let offset = 0;
  do {
    const page = await fetchJson<RunLogPage>(
      `${apiBaseUrl}/run-intelligence/runs/${encodeURIComponent(runId)}/log?offset=${offset}&limitBytes=1000000`,
    );
    chunks.push(page.content);
    if (page.page.eof || page.page.nextOffset === null) return { content: chunks.join("") };
    offset = page.page.nextOffset;
  } while (true);
}

export async function getRunTranscript(apiBaseUrl: string, runId: string): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({
      output: "full",
      order: "oldest",
      turnLimit: "1000",
      includeOutput: "true",
      maxChars: "20000",
    });
    if (cursor) query.set("cursor", cursor);
    const page = await fetchJson<RunTranscriptPage>(
      `${apiBaseUrl}/run-intelligence/runs/${encodeURIComponent(runId)}/transcript?${query.toString()}`,
    );
    for (const row of page.entries ?? []) {
      if (row.entry) entries.push(row.entry);
    }
    if (!page.page.hasMore) return entries;
    if (page.page.nextCursor === null) {
      throw new Error("Transcript endpoint reported more rows without a cursor");
    }
    if (page.page.nextCursor === cursor) {
      throw new Error("Transcript endpoint cursor made no progress");
    }
    cursor = page.page.nextCursor;
  } while (true);
}

export async function findObservedRunByPrefix(apiBaseUrl: string, runIdPrefix: string): Promise<RunExportRow | null> {
  const match = await findObservedRunSummaryByPrefix(apiBaseUrl, runIdPrefix);
  return match ? getObservedRun(apiBaseUrl, match.id) : null;
}

export async function findObservedRunSummaryByPrefix(apiBaseUrl: string, runIdPrefix: string): Promise<RunSummary | null> {
  const organizations = await listOrganizations(apiBaseUrl);
  for (const organization of organizations) {
    const params = new URLSearchParams({ limit: "100", runIdPrefix });
    const page = await listObservedRunSummaries(apiBaseUrl, organization.id, params);
    const match = page.items.find((row) => row.id.toLowerCase().startsWith(runIdPrefix.toLowerCase()));
    if (match) return match;
  }
  return null;
}

export async function loadObservedRunDetail(apiBaseUrl: string, runId: string): Promise<ObservedRunDetail> {
  const observedRun = await getObservedRun(apiBaseUrl, runId);
  const nativeBacked = isNativeBackedRun(observedRun.run);
  const [events, log, transcript] = await Promise.all([
    getRunEvents(apiBaseUrl, runId),
    nativeBacked ? Promise.resolve(null) : getRunLog(apiBaseUrl, runId),
    getRunTranscript(apiBaseUrl, runId),
  ]);
  const logContent = log?.content ?? null;
  return {
    ...observedRun,
    events,
    logContent,
    logChunks: parseNdjsonLog(logContent),
    transcript,
  };
}

function hasNativeIdentityMarker(value: unknown): boolean {
  const record = objectValue(value);
  if (!record) return false;
  return ["runtimeBindingId", "nativeBindingId", "runtimeSegmentId", "nativeSegmentId"]
    .some((key) => typeof record[key] === "string" && (record[key] as string).trim().length > 0);
}

function isNativeBackedRun(run: HeartbeatRun): boolean {
  const context = objectValue(run.contextSnapshot);
  const retention = objectValue(objectValue(run.resultJson)?.retention);
  if (context?.transcriptSource === "legacy" || retention?.transcriptSource === "legacy") return false;
  if (context?.transcriptSource === "native" || context?.transcriptSource === "native_plus_objects"
    || retention?.transcriptSource === "native" || retention?.transcriptSource === "native_plus_objects") return true;
  return hasNativeIdentityMarker(context) || hasNativeIdentityMarker(context?.unifiedAgentRun);
}

export async function diagnoseObservedRun(
  apiBaseUrl: string,
  runId: string,
  mode: RunDiagnosisMode = "auto",
): Promise<{ detail: ObservedRunDetail; diagnosis: RunDiagnosis }> {
  const detail = await loadObservedRunDetail(apiBaseUrl, runId);
  const diagnosis = diagnoseRun(detail, mode);
  return { detail, diagnosis };
}

function eventDateToIso(value: Date | string | null | undefined) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return new Date().toISOString();
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function todoItemStatusValue(value: unknown): TranscriptTodoItemStatus | null {
  return value === "pending" || value === "in_progress" || value === "completed" ? value : null;
}

function objectValue(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function transcriptEntryFromEvent(event: HeartbeatRunEvent): TranscriptEntry | null {
  if (event.eventType !== "transcript.entry" || event.seq === null) return null;
  const payload = objectValue(event.payload);
  if (!payload) return null;

  const kind = textValue(payload.kind);
  const ts = textValue(payload.ts) ?? eventDateToIso(event.createdAt);
  switch (kind) {
    case "assistant":
    case "thinking": {
      const text = textValue(payload.text);
      if (text === null) return null;
      const delta = booleanValue(payload.delta);
      return delta === null ? { kind, ts, text } : { kind, ts, text, delta };
    }
    case "user":
    case "stderr":
    case "system":
    case "stdout": {
      const text = textValue(payload.text);
      return text === null ? null : { kind, ts, text };
    }
    case "tool_call": {
      const name = textValue(payload.name);
      if (!name) return null;
      const toolUseId = textValue(payload.toolUseId);
      return toolUseId
        ? { kind, ts, name, input: payload.input, toolUseId }
        : { kind, ts, name, input: payload.input };
    }
    case "tool_result": {
      const toolUseId = textValue(payload.toolUseId);
      const content = textValue(payload.content);
      const isError = booleanValue(payload.isError);
      if (!toolUseId || content === null || isError === null) return null;
      const toolName = textValue(payload.toolName);
      return toolName
        ? { kind, ts, toolUseId, toolName, content, isError }
        : { kind, ts, toolUseId, content, isError };
    }
    case "todo_list": {
      const items = Array.isArray(payload.items)
        ? payload.items.flatMap((item) => {
          const record = objectValue(item);
          const text = textValue(record?.text);
          const status = todoItemStatusValue(record?.status);
          return text && status
            ? [{ text, status }]
            : [];
        })
        : null;
      if (!items) return null;
      const todoListId = textValue(payload.todoListId);
      return todoListId ? { kind, ts, todoListId, items } : { kind, ts, items };
    }
    case "init": {
      const model = textValue(payload.model);
      const sessionId = textValue(payload.sessionId);
      return model && sessionId ? { kind, ts, model, sessionId } : null;
    }
    case "result": {
      const text = textValue(payload.text);
      const inputTokens = numberValue(payload.inputTokens);
      const outputTokens = numberValue(payload.outputTokens);
      const cachedTokens = numberValue(payload.cachedTokens);
      const costUsd = numberValue(payload.costUsd);
      const subtype = textValue(payload.subtype);
      const isError = booleanValue(payload.isError);
      const errors = Array.isArray(payload.errors)
        ? payload.errors.filter((error): error is string => typeof error === "string")
        : null;
      return text !== null
        && inputTokens !== null
        && outputTokens !== null
        && cachedTokens !== null
        && costUsd !== null
        && subtype !== null
        && isError !== null
        && errors !== null
        ? { kind, ts, text, inputTokens, outputTokens, cachedTokens, costUsd, subtype, isError, errors }
        : null;
    }
    default:
      return null;
  }
}

function buildTranscriptFromEvents(events: HeartbeatRunEvent[]) {
  return events.flatMap((event) => {
    const entry = transcriptEntryFromEvent(event);
    return entry ? [entry] : [];
  });
}

function buildObservedTranscript(input: {
  logContent?: string | null;
  events?: HeartbeatRunEvent[];
  agentRuntimeType: string;
}) {
  const logChunks = parseNdjsonLog(input.logContent);
  const transcript = buildTranscript(logChunks, getHistoricalTranscriptParser(input.agentRuntimeType));
  return {
    logChunks,
    transcript: transcript.length > 0 ? transcript : buildTranscriptFromEvents(input.events ?? []),
  };
}

export function observedRunFromFilesystem(input: {
  run: HeartbeatRun;
  agentName: string | null;
  orgName?: string | null;
  issue?: RunExportRow["issue"];
  bundle?: RunExportRow["bundle"];
  events?: HeartbeatRunEvent[];
  logContent?: string | null;
  transcript?: TranscriptEntry[];
}): ObservedRunDetail {
  const bundle = input.bundle ?? {
    agentRuntimeType: input.run.contextSnapshot?.agentRuntimeType as string ?? "process",
    agentConfigRevisionId: null,
    agentConfigRevisionCreatedAt: null,
    agentConfigFingerprint: null,
    runtimeConfigFingerprint: null,
  };
  const { logChunks, transcript: derivedTranscript } = buildObservedTranscript({
    logContent: input.logContent,
    events: input.events,
    agentRuntimeType: bundle.agentRuntimeType,
  });

  return {
    run: input.run,
    agentName: input.agentName,
    orgName: input.orgName ?? null,
    issue: input.issue ?? null,
    bundle,
    events: input.events ?? [],
    logContent: input.logContent ?? null,
    logChunks,
    transcript: input.transcript ?? derivedTranscript,
  };
}
