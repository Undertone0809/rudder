import type { DashboardSummary } from "@rudder/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (orgId: string) => api.get<DashboardSummary>(`/orgs/${orgId}/dashboard`),
};
