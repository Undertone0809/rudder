import type { HeartbeatRun, HeartbeatRunEvent } from "@rudderhq/shared";
import { diagnoseRun } from "../diagnosis.js";
import { getTranscriptParser } from "../parsers.js";
import { buildTranscript, parseNdjsonLog } from "../transcript.js";
import type { ObservedRunDetail, RunDiagnosis, RunDiagnosisMode, RunExportRow } from "../types.js";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
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
  const qs = params && [...params.keys()].length > 0 ? `?${params.toString()}` : "";
  return fetchJson<RunExportRow[]>(`${apiBaseUrl}/run-intelligence/orgs/${encodeURIComponent(orgId)}/runs${qs}`);
}

export async function getObservedRun(apiBaseUrl: string, runId: string): Promise<RunExportRow> {
  return fetchJson<RunExportRow>(`${apiBaseUrl}/run-intelligence/runs/${encodeURIComponent(runId)}`);
}

export async function getRunEvents(apiBaseUrl: string, runId: string): Promise<HeartbeatRunEvent[]> {
  return fetchJson<HeartbeatRunEvent[]>(`${apiBaseUrl}/run-intelligence/runs/${encodeURIComponent(runId)}/events`);
}

export async function getRunLog(apiBaseUrl: string, runId: string): Promise<{ content: string }> {
  return fetchJson<{ content: string }>(`${apiBaseUrl}/run-intelligence/runs/${encodeURIComponent(runId)}/log`);
}

export async function findObservedRunByPrefix(apiBaseUrl: string, runIdPrefix: string): Promise<RunExportRow | null> {
  const organizations = await listOrganizations(apiBaseUrl);
  for (const organization of organizations) {
    const params = new URLSearchParams({ limit: "200", runIdPrefix });
    const rows = await listObservedRuns(apiBaseUrl, organization.id, params);
    const match = rows.find((row) => row.run.id.toLowerCase().startsWith(runIdPrefix.toLowerCase()));
    if (match) return match;
  }
  return null;
}

export async function loadObservedRunDetail(apiBaseUrl: string, runId: string): Promise<ObservedRunDetail> {
  const [observedRun, events, log] = await Promise.all([
    getObservedRun(apiBaseUrl, runId),
    getRunEvents(apiBaseUrl, runId),
    getRunLog(apiBaseUrl, runId).catch(() => ({ content: "" })),
  ]);
  const logChunks = parseNdjsonLog(log.content);
  const transcript = buildTranscript(logChunks, getTranscriptParser(observedRun.bundle.agentRuntimeType));
  return {
    ...observedRun,
    events,
    logContent: log.content,
    logChunks,
    transcript,
  };
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

export function observedRunFromFilesystem(input: {
  run: HeartbeatRun;
  agentName: string | null;
  orgName?: string | null;
  issue?: RunExportRow["issue"];
  bundle?: RunExportRow["bundle"];
  events?: HeartbeatRunEvent[];
  logContent?: string | null;
}): ObservedRunDetail {
  const bundle = input.bundle ?? {
    agentRuntimeType: input.run.contextSnapshot?.agentRuntimeType as string ?? "process",
    agentConfigRevisionId: null,
    agentConfigRevisionCreatedAt: null,
    agentConfigFingerprint: null,
    runtimeConfigFingerprint: null,
  };
  const logChunks = parseNdjsonLog(input.logContent);
  const transcript = buildTranscript(logChunks, getTranscriptParser(bundle.agentRuntimeType));

  return {
    run: input.run,
    agentName: input.agentName,
    orgName: input.orgName ?? null,
    issue: input.issue ?? null,
    bundle,
    events: input.events ?? [],
    logContent: input.logContent ?? null,
    logChunks,
    transcript,
  };
}
