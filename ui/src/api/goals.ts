import type {
  GoalActivityTimelinePage,
  GoalDependencies,
  GoalFeedbackEntry,
  GoalHistoryPage,
  GoalStartPreview,
  GoalWorkspaceCard,
  GoalWorkspaceSummary,
  PublicGoal,
  PublicGoalActivity,
  PublicGoalChangeProposal,
  PublicGoalOwnerAssignment,
  PublicGoalPlan,
  PublicGoalResultProposal,
} from "@rudderhq/shared";
import { api } from "./client";

export type GoalDetail = PublicGoal & {
  ownerAssignment: Pick<PublicGoalOwnerAssignment, "agentId" | "assignmentRevision" | "startsAt" | "endsAt"> | null;
  plan: Pick<PublicGoalPlan, "revision" | "summary"> | null;
  activities: PublicGoalActivity[];
};

export const goalsApi = {
  list: (orgId: string) => api.get<PublicGoal[]>(`/orgs/${orgId}/goals`),
  listWorkspace: (orgId: string) =>
    api.get<GoalWorkspaceCard[] | { cards: GoalWorkspaceCard[] }>(`/orgs/${orgId}/goals/workspace`),
  get: (id: string) => api.get<GoalDetail>(`/goals/${id}`),
  getWorkspace: (id: string) => api.get<GoalWorkspaceSummary>(`/goals/${id}/workspace`),
  getHistory: (id: string, cursor: string, limit = 50) =>
    api.get<GoalHistoryPage>(`/goals/${id}/history?limit=${limit}&cursor=${encodeURIComponent(cursor)}`),
  getTimeline: (id: string, cursor?: string | null, limit = 50) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    return api.get<GoalActivityTimelinePage>(`/goals/${id}/timeline?${params.toString()}`);
  },
  create: (orgId: string, data: Record<string, unknown>) =>
    api.post<PublicGoal>(`/orgs/${orgId}/goals`, data),
  previewStart: (orgId: string, data: Record<string, unknown>) =>
    api.post<GoalStartPreview>(`/orgs/${orgId}/goals/start-preview`, data),
  start: (orgId: string, data: Record<string, unknown>) =>
    api.post<PublicGoal>(`/orgs/${orgId}/goals/start`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch<PublicGoal>(`/goals/${id}`, data),
  activate: (id: string, data: Record<string, unknown>) => api.post<PublicGoal>(`/goals/${id}/activate`, data),
  updatePlan: (id: string, data: Record<string, unknown>) => api.post<PublicGoalPlan>(`/goals/${id}/plan`, data),
  listActivities: (id: string) => api.get<PublicGoalActivity[]>(`/goals/${id}/activities`),
  createActivity: (id: string, data: Record<string, unknown>) => api.post<PublicGoalActivity>(`/goals/${id}/activities`, data),
  assignOwner: (id: string, data: Record<string, unknown>) => api.post<PublicGoalOwnerAssignment>(`/goals/${id}/owner`, data),
  setFocus: (id: string, focus: boolean) => api.post<PublicGoal>(`/goals/${id}/focus`, { focus }),
  evaluate: (id: string, data: Record<string, unknown>) => api.post<PublicGoal>(`/goals/${id}/evaluate`, data),
  feedback: (id: string, data: Record<string, unknown>) =>
    api.post<GoalFeedbackEntry>(`/goals/${id}/feedback`, data),
  decideChangeProposal: (id: string, data: Record<string, unknown>) =>
    api.post<PublicGoalChangeProposal>(`/goal-change-proposals/${id}/decide`, data),
  acceptResultProposal: (id: string, data: Record<string, unknown>) =>
    api.post<PublicGoal>(`/goal-result-proposals/${id}/accept`, data),
  rejectResultProposal: (id: string, data: Record<string, unknown>) =>
    api.post<PublicGoalResultProposal>(`/goal-result-proposals/${id}/reject`, data),
  dependencies: (id: string) => api.get<GoalDependencies>(`/goals/${id}/dependencies`),
  remove: (id: string) => api.delete<PublicGoal>(`/goals/${id}`),
};
