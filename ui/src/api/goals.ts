import type {
  Goal,
  GoalActivity,
  GoalChangeProposal,
  GoalDependencies,
  GoalFeedbackEntry,
  GoalHistoryPage,
  GoalOwnerAssignment,
  GoalPlan,
  GoalResultProposal,
  GoalStartPreview,
  GoalWorkspaceCard,
  GoalWorkspaceSummary,
} from "@rudderhq/shared";
import { api } from "./client";

export type GoalDetail = Goal & {
  ownerAssignment: GoalOwnerAssignment | null;
  plan: GoalPlan | null;
  activities: GoalActivity[];
};

export const goalsApi = {
  list: (orgId: string) => api.get<Goal[]>(`/orgs/${orgId}/goals`),
  listWorkspace: (orgId: string) =>
    api.get<GoalWorkspaceCard[] | { cards: GoalWorkspaceCard[] }>(`/orgs/${orgId}/goals/workspace`),
  get: (id: string) => api.get<GoalDetail>(`/goals/${id}`),
  getWorkspace: (id: string) => api.get<GoalWorkspaceSummary>(`/goals/${id}/workspace`),
  getHistory: (id: string, cursor: string, limit = 50) =>
    api.get<GoalHistoryPage>(`/goals/${id}/history?limit=${limit}&cursor=${encodeURIComponent(cursor)}`),
  create: (orgId: string, data: Record<string, unknown>) =>
    api.post<Goal>(`/orgs/${orgId}/goals`, data),
  previewStart: (orgId: string, data: Record<string, unknown>) =>
    api.post<GoalStartPreview>(`/orgs/${orgId}/goals/start-preview`, data),
  start: (orgId: string, data: Record<string, unknown>) =>
    api.post<Goal>(`/orgs/${orgId}/goals/start`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch<Goal>(`/goals/${id}`, data),
  activate: (id: string, data: Record<string, unknown>) => api.post<Goal>(`/goals/${id}/activate`, data),
  updatePlan: (id: string, data: Record<string, unknown>) => api.post<GoalPlan>(`/goals/${id}/plan`, data),
  listActivities: (id: string) => api.get<GoalActivity[]>(`/goals/${id}/activities`),
  createActivity: (id: string, data: Record<string, unknown>) => api.post<GoalActivity>(`/goals/${id}/activities`, data),
  assignOwner: (id: string, data: Record<string, unknown>) => api.post<GoalOwnerAssignment>(`/goals/${id}/owner`, data),
  setFocus: (id: string, focus: boolean) => api.post<Goal>(`/goals/${id}/focus`, { focus }),
  evaluate: (id: string, data: Record<string, unknown>) => api.post<Goal>(`/goals/${id}/evaluate`, data),
  feedback: (id: string, data: Record<string, unknown>) =>
    api.post<GoalFeedbackEntry>(`/goals/${id}/feedback`, data),
  decideChangeProposal: (id: string, data: Record<string, unknown>) =>
    api.post<GoalChangeProposal>(`/goal-change-proposals/${id}/decide`, data),
  acceptResultProposal: (id: string, data: Record<string, unknown>) =>
    api.post<Goal>(`/goal-result-proposals/${id}/accept`, data),
  rejectResultProposal: (id: string, data: Record<string, unknown>) =>
    api.post<GoalResultProposal>(`/goal-result-proposals/${id}/reject`, data),
  dependencies: (id: string) => api.get<GoalDependencies>(`/goals/${id}/dependencies`),
  remove: (id: string) => api.delete<Goal>(`/goals/${id}`),
};
