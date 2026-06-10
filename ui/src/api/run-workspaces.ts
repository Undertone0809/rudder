import type { RunWorkspace } from "@rudderhq/shared";
import { api } from "./client";

export const runWorkspacesApi = {
  list: (
    orgId: string,
    filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.projectId) params.set("projectId", filters.projectId);
    if (filters?.projectWorkspaceId) params.set("projectWorkspaceId", filters.projectWorkspaceId);
    if (filters?.issueId) params.set("issueId", filters.issueId);
    if (filters?.status) params.set("status", filters.status);
    if (filters?.reuseEligible) params.set("reuseEligible", "true");
    const qs = params.toString();
    return api.get<RunWorkspace[]>(`/orgs/${orgId}/run-workspaces${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => api.get<RunWorkspace>(`/run-workspaces/${id}`),
  update: (id: string, data: Record<string, unknown>) => api.patch<RunWorkspace>(`/run-workspaces/${id}`, data),
};
