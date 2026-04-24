import type { DashboardSummary } from "@rudderhq/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (orgId: string) => api.get<DashboardSummary>(`/orgs/${orgId}/dashboard`),
};
