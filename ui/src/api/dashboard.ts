import type { AgentSkillAnalytics, DashboardSummary } from "@rudderhq/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (orgId: string) => api.get<DashboardSummary>(`/orgs/${orgId}/dashboard`),
  skillsAnalytics: (
    orgId: string,
    options?: { windowDays?: number; startDate?: string; endDate?: string },
  ) => {
    const params = new URLSearchParams();
    if (options?.windowDays) params.set("windowDays", String(options.windowDays));
    if (options?.startDate) params.set("startDate", options.startDate);
    if (options?.endDate) params.set("endDate", options.endDate);
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return api.get<AgentSkillAnalytics>(`/orgs/${orgId}/dashboard/skills/analytics${suffix}`);
  },
};
