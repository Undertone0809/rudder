import type {
  CostSummary,
  CostByAgent,
  CostByProviderModel,
  CostByBiller,
  CostByAgentModel,
  CostByProject,
  CostWindowSpendRow,
  FinanceSummary,
  FinanceByBiller,
  FinanceByKind,
  FinanceEvent,
  ProviderQuotaResult,
} from "@rudder/shared";
import { api } from "./client";

function dateParams(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const costsApi = {
  summary: (orgId: string, from?: string, to?: string) =>
    api.get<CostSummary>(`/orgs/${orgId}/costs/summary${dateParams(from, to)}`),
  byAgent: (orgId: string, from?: string, to?: string) =>
    api.get<CostByAgent[]>(`/orgs/${orgId}/costs/by-agent${dateParams(from, to)}`),
  byAgentModel: (orgId: string, from?: string, to?: string) =>
    api.get<CostByAgentModel[]>(`/orgs/${orgId}/costs/by-agent-model${dateParams(from, to)}`),
  byProject: (orgId: string, from?: string, to?: string) =>
    api.get<CostByProject[]>(`/orgs/${orgId}/costs/by-project${dateParams(from, to)}`),
  byProvider: (orgId: string, from?: string, to?: string) =>
    api.get<CostByProviderModel[]>(`/orgs/${orgId}/costs/by-provider${dateParams(from, to)}`),
  byBiller: (orgId: string, from?: string, to?: string) =>
    api.get<CostByBiller[]>(`/orgs/${orgId}/costs/by-biller${dateParams(from, to)}`),
  financeSummary: (orgId: string, from?: string, to?: string) =>
    api.get<FinanceSummary>(`/orgs/${orgId}/costs/finance-summary${dateParams(from, to)}`),
  financeByBiller: (orgId: string, from?: string, to?: string) =>
    api.get<FinanceByBiller[]>(`/orgs/${orgId}/costs/finance-by-biller${dateParams(from, to)}`),
  financeByKind: (orgId: string, from?: string, to?: string) =>
    api.get<FinanceByKind[]>(`/orgs/${orgId}/costs/finance-by-kind${dateParams(from, to)}`),
  financeEvents: (orgId: string, from?: string, to?: string, limit: number = 100) =>
    api.get<FinanceEvent[]>(`/orgs/${orgId}/costs/finance-events${dateParamsWithLimit(from, to, limit)}`),
  windowSpend: (orgId: string) =>
    api.get<CostWindowSpendRow[]>(`/orgs/${orgId}/costs/window-spend`),
  quotaWindows: (orgId: string) =>
    api.get<ProviderQuotaResult[]>(`/orgs/${orgId}/costs/quota-windows`),
};

function dateParamsWithLimit(from?: string, to?: string, limit?: number): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
