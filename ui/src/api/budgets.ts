import type {
  BudgetIncident,
  BudgetIncidentResolutionInput,
  BudgetOverview,
  BudgetPolicySummary,
  BudgetPolicyUpsertInput,
} from "@rudder/shared";
import { api } from "./client";

export const budgetsApi = {
  overview: (orgId: string) =>
    api.get<BudgetOverview>(`/orgs/${orgId}/budgets/overview`),
  upsertPolicy: (orgId: string, data: BudgetPolicyUpsertInput) =>
    api.post<BudgetPolicySummary>(`/orgs/${orgId}/budgets/policies`, data),
  resolveIncident: (orgId: string, incidentId: string, data: BudgetIncidentResolutionInput) =>
    api.post<BudgetIncident>(
      `/orgs/${orgId}/budget-incidents/${encodeURIComponent(incidentId)}/resolve`,
      data,
    ),
};
