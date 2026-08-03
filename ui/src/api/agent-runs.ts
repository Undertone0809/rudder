import type {
  AgentRun,
  AgentRunOverview,
  HeartbeatRun,
  HeartbeatRunEvent,
  WorkspaceOperation,
} from "@rudderhq/shared";
import { api } from "./client";

export interface ActiveRunForIssue extends HeartbeatRun {
  agentId: string;
  agentName: string;
  agentRuntimeType: string;
}

export interface LiveRunForIssue {
  id: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  stdoutExcerpt?: string | null;
  resultJson?: Record<string, unknown> | null;
  agentId: string;
  agentName: string;
  agentRuntimeType: string;
  issueId?: string | null;
}

export const AGENT_RUN_LIST_DEFAULT_LIMIT = 100;
export const AGENT_RUN_LIST_COMPACT_LIMIT = 50;
export const AGENT_RUN_LIST_AGENT_LIMIT = 200;
export const AGENT_RUN_LIST_HISTORY_LIMIT = 1000;
export const AGENT_RUN_EVENTS_PAGE_LIMIT = 1000;

export interface AgentRunListFilters {
  startDate?: string;
  endDate?: string;
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
    const qs = searchParams.toString();
    return api.get<AgentRun[]>(`/orgs/${orgId}/agent-runs${qs ? `?${qs}` : ""}`);
  },
  get: (runId: string) => api.get<AgentRun>(`/agent-runs/${runId}`),
  events: (runId: string, afterSeq = 0, limit = 200) =>
    api.get<HeartbeatRunEvent[]>(
      `/agent-runs/${runId}/events?afterSeq=${encodeURIComponent(String(afterSeq))}&limit=${encodeURIComponent(String(limit))}`,
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
  workspaceOperations: (runId: string) =>
    api.get<WorkspaceOperation[]>(`/agent-runs/${runId}/workspace-operations`),
  workspaceOperationLog: (operationId: string, offset = 0, limitBytes = 256000) =>
    api.get<{ operationId: string; store: string; logRef: string; content: string; endOffset?: number; eof?: boolean; nextOffset?: number }>(
      `/workspace-operations/${operationId}/log?offset=${encodeURIComponent(String(offset))}&limitBytes=${encodeURIComponent(String(limitBytes))}`,
      { cache: "no-store" },
    ),
  cancel: (runId: string) => api.post<void>(`/agent-runs/${runId}/cancel`, {}),
  retry: (runId: string) => api.post<AgentRun>(`/agent-runs/${runId}/retry`, {}),
  liveRunsForIssue: (issueId: string) =>
    api.get<LiveRunForIssue[]>(`/issues/${issueId}/live-runs`),
  activeRunForIssue: (issueId: string) =>
    api.get<ActiveRunForIssue | null>(`/issues/${issueId}/active-run`),
  liveRunsForCompany: (orgId: string, minCount?: number) =>
    api.get<LiveRunForIssue[]>(`/orgs/${orgId}/live-runs${minCount ? `?minCount=${minCount}` : ""}`),
};
