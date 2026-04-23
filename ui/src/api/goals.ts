import type { Goal } from "@rudder/shared";
import { api } from "./client";

export const goalsApi = {
  list: (orgId: string) => api.get<Goal[]>(`/orgs/${orgId}/goals`),
  get: (id: string) => api.get<Goal>(`/goals/${id}`),
  create: (orgId: string, data: Record<string, unknown>) =>
    api.post<Goal>(`/orgs/${orgId}/goals`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch<Goal>(`/goals/${id}`, data),
  remove: (id: string) => api.delete<Goal>(`/goals/${id}`),
};
