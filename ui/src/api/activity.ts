import type { ActivityEvent } from "@rudderhq/shared";
import { api } from "./client";

export interface RunForIssue {
  runId: string;
  status: string;
  agentId: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  invocationSource: string;
  triggerDetail: string | null;
  contextSnapshot: Record<string, unknown> | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
}

export interface IssueForRun {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}

export interface ActivityListFilters {
  entityType?: string;
  entityId?: string;
  agentId?: string;
  userId?: string;
  actorType?: "agent" | "user" | "system";
  actorId?: string;
}

export const activityApi = {
  list: (orgId: string, filters?: ActivityListFilters) => {
    const params = new URLSearchParams();
    if (filters?.entityType) params.set("entityType", filters.entityType);
    if (filters?.entityId) params.set("entityId", filters.entityId);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.userId) params.set("userId", filters.userId);
    if (filters?.actorType) params.set("actorType", filters.actorType);
    if (filters?.actorId) params.set("actorId", filters.actorId);
    const qs = params.toString();
    return api.get<ActivityEvent[]>(`/orgs/${orgId}/activity${qs ? `?${qs}` : ""}`);
  },
  forIssue: (issueId: string) => api.get<ActivityEvent[]>(`/issues/${issueId}/activity`),
  runsForIssue: (issueId: string) => api.get<RunForIssue[]>(`/issues/${issueId}/runs`),
  issuesForRun: (runId: string) => api.get<IssueForRun[]>(`/heartbeat-runs/${runId}/issues`),
};
