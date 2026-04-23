import type { AgentRuntimeType, FinanceDirection, FinanceEventKind, FinanceUnit } from "../constants.js";

export interface FinanceEvent {
  id: string;
  orgId: string;
  agentId: string | null;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  heartbeatRunId: string | null;
  costEventId: string | null;
  billingCode: string | null;
  description: string | null;
  eventKind: FinanceEventKind;
  direction: FinanceDirection;
  biller: string;
  provider: string | null;
  executionAgentRuntimeType: AgentRuntimeType | null;
  pricingTier: string | null;
  region: string | null;
  model: string | null;
  quantity: number | null;
  unit: FinanceUnit | null;
  amountCents: number;
  currency: string;
  estimated: boolean;
  externalInvoiceId: string | null;
  metadataJson: Record<string, unknown> | null;
  occurredAt: Date;
  createdAt: Date;
}

export interface FinanceSummary {
  orgId: string;
  debitCents: number;
  creditCents: number;
  netCents: number;
  estimatedDebitCents: number;
  eventCount: number;
}

export interface FinanceByBiller {
  biller: string;
  debitCents: number;
  creditCents: number;
  netCents: number;
  estimatedDebitCents: number;
  eventCount: number;
  kindCount: number;
}

export interface FinanceByKind {
  eventKind: FinanceEventKind;
  debitCents: number;
  creditCents: number;
  netCents: number;
  estimatedDebitCents: number;
  eventCount: number;
  billerCount: number;
}
