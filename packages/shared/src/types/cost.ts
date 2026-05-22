import type { AgentRole, BillingType } from "../constants.js";
import type { CachedInputTokenSemantics } from "../token-usage.js";

export interface CostEvent {
  id: string;
  orgId: string;
  agentId: string;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  heartbeatRunId: string | null;
  billingCode: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cachedInputTokenSemantics?: CachedInputTokenSemantics;
  costCents: number;
  occurredAt: Date;
  createdAt: Date;
}

export interface CostSummary {
  orgId: string;
  spendCents: number;
  budgetCents: number;
  utilizationPercent: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cachedInputTokenSemantics?: CachedInputTokenSemantics;
  totalTokens: number;
  eventCount: number;
  tokenEventCount: number;
}

export interface CostTrendPoint {
  /** UTC day bucket formatted as YYYY-MM-DD. */
  date: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cachedInputTokenSemantics?: CachedInputTokenSemantics;
  totalTokens: number;
  eventCount: number;
}

export interface CostByAgent {
  agentId: string;
  agentName: string | null;
  agentIcon: string | null;
  agentRole: AgentRole | null;
  agentStatus: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cachedInputTokenSemantics?: CachedInputTokenSemantics;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByProviderModel {
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cachedInputTokenSemantics?: CachedInputTokenSemantics;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByBiller {
  biller: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cachedInputTokenSemantics?: CachedInputTokenSemantics;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
  providerCount: number;
  modelCount: number;
}

/** per-agent breakdown by provider + model, for identifying token-hungry agents */
export interface CostByAgentModel {
  agentId: string;
  agentName: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cachedInputTokenSemantics?: CachedInputTokenSemantics;
}

/** spend per provider for a fixed rolling time window */
export interface CostWindowSpendRow {
  provider: string;
  biller: string;
  /** duration label, e.g. "5h", "24h", "7d" */
  window: string;
  /** rolling window duration in hours */
  windowHours: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cachedInputTokenSemantics?: CachedInputTokenSemantics;
}

/** cost attributed to a project via heartbeat run → activity log → issue → project chain */
export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}
