import type {
  AgentRun,
  AgentRunInvocationInstructions,
  AgentRunOverview,
  HeartbeatRun,
  HeartbeatRunEvent,
  WorkspaceOperation,
} from "@rudderhq/shared";
import type { TranscriptEntry } from "../agent-runtimes";
import type { ApiRequestOptions } from "./client";
import { api } from "./client";

export interface ActiveRunForIssue extends HeartbeatRun {
  agentId: string;
  agentName: string;
  agentRuntimeType: string;
}

export interface LiveRunForIssue {
  id: string;
  status: string;
  executionPhase?: HeartbeatRun["executionPhase"];
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  stdoutExcerpt?: string | null;
  resultJson?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown> | null;
  agentId: string;
  agentName: string;
  agentRuntimeType: string;
  issueId?: string | null;
  goalId?: string | null;
}

export const AGENT_RUN_LIST_DEFAULT_LIMIT = 100;
export const AGENT_RUN_LIST_COMPACT_LIMIT = 50;
export const AGENT_RUN_LIST_AGENT_LIMIT = 200;
export const AGENT_RUN_LIST_HISTORY_LIMIT = 1000;
export const AGENT_RUN_EVENTS_PAGE_LIMIT = 1000;
export const AGENT_RUN_TRANSCRIPT_TURN_LIMIT = 50;

export type AgentRunTranscriptSource = "native" | "native_plus_objects" | "legacy";
export type AgentRunTranscriptAvailability = "available" | "offline" | "missing" | "expired" | "incompatible";
export type AgentRunTranscriptCompleteness = "complete" | "partial" | "terminal_only" | "unknown";

export interface AgentRunTranscriptEntry {
  id: string;
  index?: number;
  turnIndex?: number | null;
  entry: TranscriptEntry | null;
}

export interface AgentRunTranscriptPage {
  entries?: AgentRunTranscriptEntry[];
  page: {
    cursor?: string | null;
    hasMore: boolean;
    nextCursor: string | null;
    order?: "oldest" | "newest";
  };
  source?: AgentRunTranscriptSource;
  revision?: string;
  availability?: AgentRunTranscriptAvailability;
  completeness?: AgentRunTranscriptCompleteness;
}

export interface AgentRunTranscriptRequest {
  cursor?: string | null;
  turnLimit?: number;
  includeOutput?: boolean;
  maxChars?: number;
}

export interface AgentRunTranscriptResult {
  entries: TranscriptEntry[];
  source: AgentRunTranscriptSource | null;
  revision: string | null;
  availability: AgentRunTranscriptAvailability | null;
  completeness: AgentRunTranscriptCompleteness | null;
  page: AgentRunTranscriptPage["page"];
}

export type { AgentRunInvocationInstructions } from "@rudderhq/shared";

function mergeTranscriptSources(
  left: AgentRunTranscriptSource | null,
  right: AgentRunTranscriptSource | undefined,
): AgentRunTranscriptSource | null {
  if (!right) return left;
  if (!left || left === right) return right;
  return "native_plus_objects";
}

function transcriptPage(
  runId: string,
  request: AgentRunTranscriptRequest = {},
  requestOptions: ApiRequestOptions = {},
) {
  const searchParams = new URLSearchParams({
    output: "full",
    order: "oldest",
    turnLimit: String(request.turnLimit ?? AGENT_RUN_TRANSCRIPT_TURN_LIMIT),
  });
  if (request.cursor) searchParams.set("cursor", request.cursor);
  if (typeof request.includeOutput === "boolean") {
    searchParams.set("includeOutput", String(request.includeOutput));
  }
  if (typeof request.maxChars === "number") searchParams.set("maxChars", String(request.maxChars));
  const path = `/run-intelligence/runs/${encodeURIComponent(runId)}/transcript?${searchParams.toString()}`;
  return requestOptions.signal || requestOptions.timeoutMs
    ? api.get<AgentRunTranscriptPage>(path, { cache: "no-store" }, requestOptions)
    : api.get<AgentRunTranscriptPage>(path, { cache: "no-store" });
}

async function allTranscript(
  runId: string,
  request: Omit<AgentRunTranscriptRequest, "cursor"> = {},
  requestOptions: ApiRequestOptions = {},
): Promise<AgentRunTranscriptResult> {
  const entriesById = new Map<string, TranscriptEntry>();
  let cursor: string | null = null;
  let pageCount = 0;
  let source: AgentRunTranscriptSource | null = null;
  let revision: string | null = null;
  let availability: AgentRunTranscriptAvailability | null = null;
  let completeness: AgentRunTranscriptCompleteness | null = null;
  let lastPage: AgentRunTranscriptPage["page"] = {
    cursor: null,
    hasMore: false,
    nextCursor: null,
    order: "oldest",
  };

  while (true) {
    pageCount += 1;
    if (pageCount > 2_000) throw new Error("Transcript pagination exceeded the page limit");
    const page = await transcriptPage(runId, { ...request, cursor }, requestOptions);
    if (!page.page || typeof page.page.hasMore !== "boolean") {
      throw new Error("Transcript API returned invalid page metadata");
    }
    source = mergeTranscriptSources(source, page.source);
    if (page.revision && revision && page.revision !== revision) revision = null;
    else revision = page.revision ?? revision;
    availability = page.availability ?? availability;
    completeness = page.completeness ?? completeness;
    lastPage = page.page;
    for (const row of page.entries ?? []) {
      const entry = row?.entry;
      if (!entry || typeof entry !== "object" || typeof entry.kind !== "string" || typeof entry.ts !== "string") continue;
      entriesById.set(
        row.id,
        typeof entry.sourceEntryId === "string"
          ? entry
          : { ...entry, sourceEntryId: row.id },
      );
    }

    if (!page.page.hasMore) break;
    const nextCursor = page.page.nextCursor;
    if (!nextCursor || nextCursor === cursor) throw new Error("Transcript API returned a non-advancing cursor");
    cursor = nextCursor;
  }

  return {
    entries: [...entriesById.values()],
    source,
    revision,
    availability,
    completeness,
    page: lastPage,
  };
}

export interface AgentRunListFilters {
  startDate?: string;
  endDate?: string;
  goalId?: string;
}

export const agentRunsApi = {
  overview: (orgId: string) =>
    api.get<AgentRunOverview>(`/orgs/${orgId}/agent-runs/overview`),
  list: (
    orgId: string,
    agentId?: string,
    limit: number | null = AGENT_RUN_LIST_DEFAULT_LIMIT,
    filters: AgentRunListFilters = {},
  ) => {
    const searchParams = new URLSearchParams();
    if (agentId) searchParams.set("agentId", agentId);
    if (limit !== null) searchParams.set("limit", String(limit));
    if (filters.startDate) searchParams.set("startDate", filters.startDate);
    if (filters.endDate) searchParams.set("endDate", filters.endDate);
    if (filters.goalId) searchParams.set("goalId", filters.goalId);
    const qs = searchParams.toString();
    return api.get<AgentRun[]>(`/orgs/${orgId}/agent-runs${qs ? `?${qs}` : ""}`);
  },
  get: (runId: string) => api.get<AgentRun>(`/agent-runs/${runId}`),
  events: (runId: string, afterSeq = 0, limit = 200) =>
    api.get<HeartbeatRunEvent[]>(
      `/agent-runs/${runId}/events?afterSeq=${encodeURIComponent(String(afterSeq))}&limit=${encodeURIComponent(String(limit))}`,
    ),
  invocationInstructions: (runId: string, eventId: number) =>
    api.get<AgentRunInvocationInstructions>(
      `/agent-runs/${encodeURIComponent(runId)}/events/${encodeURIComponent(String(eventId))}/invocation-instructions`,
      { cache: "no-store" },
    ),
  allEvents: async (runId: string) => {
    const events: HeartbeatRunEvent[] = [];
    let afterSeq = 0;

    while (true) {
      const page = await api.get<HeartbeatRunEvent[]>(
        `/agent-runs/${runId}/events?afterSeq=${encodeURIComponent(String(afterSeq))}&limit=${AGENT_RUN_EVENTS_PAGE_LIMIT}`,
      );
      events.push(...page);
      if (page.length < AGENT_RUN_EVENTS_PAGE_LIMIT) return events;

      const nextAfterSeq = page[page.length - 1]?.seq;
      if (typeof nextAfterSeq !== "number" || nextAfterSeq <= afterSeq) return events;
      afterSeq = nextAfterSeq;
    }
  },
  log: (runId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ runId: string; store: string; logRef: string; content: string; endOffset?: number; eof?: boolean; nextOffset?: number }>(
      `/agent-runs/${runId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
      { cache: "no-store" },
    ),
  transcript: transcriptPage,
  allTranscript,
  workspaceOperations: (runId: string) =>
    api.get<WorkspaceOperation[]>(`/agent-runs/${runId}/workspace-operations`),
  workspaceOperationLog: (operationId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ operationId: string; store: string; logRef: string; content: string; endOffset?: number; eof?: boolean; nextOffset?: number }>(
      `/workspace-operations/${operationId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
      { cache: "no-store" },
    ),
  cancel: (runId: string) => api.post<AgentRun>(`/agent-runs/${runId}/cancel`, {}),
  retry: (runId: string) => api.post<AgentRun>(`/agent-runs/${runId}/retry`, {}),
  liveRunsForIssue: (issueId: string) =>
    api.get<LiveRunForIssue[]>(`/issues/${issueId}/live-runs`),
  activeRunForIssue: (issueId: string) =>
    api.get<ActiveRunForIssue | null>(`/issues/${issueId}/active-run`),
  liveRunsForCompany: (orgId: string, minCount?: number) =>
    api.get<LiveRunForIssue[]>(`/orgs/${orgId}/live-runs${minCount ? `?minCount=${minCount}` : ""}`),
  liveRunsForGoal: (orgId: string, goalId: string) =>
    api.get<LiveRunForIssue[]>(`/orgs/${orgId}/live-runs?goalId=${encodeURIComponent(goalId)}`),
};
