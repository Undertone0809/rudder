import type { IssueOriginKind } from "../constants.js";

export interface AutomationProjectSummary {
  id: string;
  name: string;
  description: string | null;
  status: string;
  goalId?: string | null;
}

export interface AutomationAgentSummary {
  id: string;
  name: string;
  role: string;
  title: string | null;
  urlKey?: string | null;
}

export interface AutomationIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  updatedAt: Date;
}

export interface AutomationChatConversationSummary {
  id: string;
  title: string;
  status: string;
  preferredAgentId: string | null;
  lastMessageAt: Date | null;
}

export interface Automation {
  id: string;
  orgId: string;
  projectId: string | null;
  goalId: string | null;
  parentIssueId: string | null;
  title: string;
  description: string | null;
  assigneeAgentId: string;
  outputMode: "track_issue" | "chat_output";
  chatConversationId: string | null;
  priority: string;
  status: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  lastTriggeredAt: Date | null;
  lastEnqueuedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationTrigger {
  id: string;
  orgId: string;
  automationId: string;
  kind: string;
  label: string | null;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string | null;
  nextRunAt: Date | null;
  lastFiredAt: Date | null;
  publicId: string | null;
  secretId: string | null;
  signingMode: string | null;
  replayWindowSec: number | null;
  lastRotatedAt: Date | null;
  lastResult: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationRun {
  id: string;
  orgId: string;
  automationId: string;
  triggerId: string | null;
  source: string;
  status: string;
  triggeredAt: Date;
  idempotencyKey: string | null;
  triggerPayload: Record<string, unknown> | null;
  linkedIssueId: string | null;
  linkedChatConversationId: string | null;
  startedChatMessageId: string | null;
  terminalChatMessageId: string | null;
  lastChatMessageId: string | null;
  coalescedIntoRunId: string | null;
  failureReason: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationTriggerSecretMaterial {
  webhookUrl: string;
  webhookSecret: string;
}

export interface AutomationDetail extends Automation {
  project: AutomationProjectSummary | null;
  assignee: AutomationAgentSummary | null;
  parentIssue: AutomationIssueSummary | null;
  chatConversation: AutomationChatConversationSummary | null;
  triggers: AutomationTrigger[];
  recentRuns: AutomationRunSummary[];
  activeIssue: AutomationIssueSummary | null;
}

export interface AutomationRunSummary extends AutomationRun {
  linkedIssue: AutomationIssueSummary | null;
  linkedChatConversation: AutomationChatConversationSummary | null;
  trigger: Pick<AutomationTrigger, "id" | "kind" | "label"> | null;
}

export interface AutomationExecutionIssueOrigin {
  kind: Extract<IssueOriginKind, "automation_execution">;
  automationId: string;
  runId: string | null;
}

export interface AutomationListItem extends Automation {
  triggers: Pick<AutomationTrigger, "id" | "kind" | "label" | "enabled" | "nextRunAt" | "lastFiredAt" | "lastResult">[];
  lastRun: AutomationRunSummary | null;
  activeIssue: AutomationIssueSummary | null;
}
