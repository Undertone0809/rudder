import type {
  CostSummary,
  CostTrendPoint,
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
} from "@rudderhq/shared";
import { api } from "./client";

function dateParams(from?: string, to?: string, extra?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const costsApi = {
  summary: (orgId: string, from?: string, to?: string) =>
    api.get<CostSummary>(`/orgs/${orgId}/costs/summary${dateParams(from, to)}`),
  byAgent: (orgId: string, from?: string, to?: string) =>
    api.get<CostByAgent[]>(`/orgs/${orgId}/costs/by-agent${dateParams(from, to)}`),
  trend: (orgId: string, from?: string, to?: string, filter?: { agentId?: string; projectId?: string }) =>
    api.get<CostTrendPoint[]>(`/orgs/${orgId}/costs/trend${dateParams(from, to, filter)}`),
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
