import type { Goal, GoalActivity, GoalDependencies, GoalOwnerAssignment, GoalPlan } from "@rudderhq/shared";
import { api } from "./client";

export type GoalDetail = Goal & {
  ownerAssignment: GoalOwnerAssignment | null;
  plan: GoalPlan | null;
  activities: GoalActivity[];
};

export const goalsApi = {
  list: (orgId: string) => api.get<Goal[]>(`/orgs/${orgId}/goals`),
  get: (id: string) => api.get<GoalDetail>(`/goals/${id}`),
  create: (orgId: string, data: Record<string, unknown>) =>
    api.post<Goal>(`/orgs/${orgId}/goals`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch<Goal>(`/goals/${id}`, data),
  activate: (id: string, data: Record<string, unknown>) => api.post<Goal>(`/goals/${id}/activate`, data),
  updatePlan: (id: string, data: Record<string, unknown>) => api.post<GoalPlan>(`/goals/${id}/plan`, data),
  listActivities: (id: string) => api.get<GoalActivity[]>(`/goals/${id}/activities`),
  createActivity: (id: string, data: Record<string, unknown>) => api.post<GoalActivity>(`/goals/${id}/activities`, data),
  assignOwner: (id: string, data: Record<string, unknown>) => api.post<GoalOwnerAssignment>(`/goals/${id}/owner`, data),
  setFocus: (id: string, focus: boolean) => api.post<Goal>(`/goals/${id}/focus`, { focus }),
  evaluate: (id: string, data: Record<string, unknown>) => api.post<Goal>(`/goals/${id}/evaluate`, data),
  dependencies: (id: string) => api.get<GoalDependencies>(`/goals/${id}/dependencies`),
  remove: (id: string) => api.delete<Goal>(`/goals/${id}`),
};
