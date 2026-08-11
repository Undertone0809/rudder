import type { AssistanceRequest, RudderRequest } from "@rudderhq/shared";
import { api } from "./client";

export const requestsApi = {
  list: (orgId: string, filters?: { status?: string; kind?: string }) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.kind) params.set("kind", filters.kind);
    const query = params.size ? `?${params.toString()}` : "";
    return api.get<RudderRequest[]>(`/orgs/${orgId}/requests${query}`);
  },
  get: (id: string) => api.get<RudderRequest>(`/requests/${id}`),
  resolveAssistance: (
    id: string,
    resolution: "answered" | "action_completed" | "cannot_help",
    response: string,
  ) => api.post<AssistanceRequest>(`/requests/${id}/resolve`, { resolution, response }),
  cancelAssistance: (id: string, reason?: string) =>
    api.post<AssistanceRequest>(`/requests/${id}/cancel`, { reason }),
};
