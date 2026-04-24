import type {
  AgentRole,
  AgentStatus,
  HeartbeatInvocationSource,
  HeartbeatRunStatus,
  WakeupTriggerDetail,
  WakeupRequestStatus,
} from "../constants.js";

export type HeartbeatRecoveryTrigger = "manual" | "automatic";
export type HeartbeatRecoveryMode = "continue_preferred";

export interface HeartbeatRunRecoveryContext {
  originalRunId: string;
  failureKind: string;
  failureSummary: string;
  recoveryTrigger: HeartbeatRecoveryTrigger;
  recoveryMode: HeartbeatRecoveryMode;
}

export interface HeartbeatRunPassiveFollowupContext {
  originRunId: string;
  previousRunId: string;
  attempt: number;
  maxAttempts: number;
  reason: "missing_closure";
  queuedAt: string;
}

export interface HeartbeatRunContextSnapshot extends Record<string, unknown> {
  recovery?: HeartbeatRunRecoveryContext;
  passiveFollowup?: HeartbeatRunPassiveFollowupContext;
}

export interface HeartbeatRun {
  id: string;
  orgId: string;
  agentId: string;
  invocationSource: HeartbeatInvocationSource;
  triggerDetail: WakeupTriggerDetail | null;
  status: HeartbeatRunStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  wakeupRequestId: string | null;
  exitCode: number | null;
  signal: string | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  sessionIdBefore: string | null;
  sessionIdAfter: string | null;
  logStore: string | null;
  logRef: string | null;
  logBytes: number | null;
  logSha256: string | null;
  logCompressed: boolean;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  errorCode: string | null;
  externalRunId: string | null;
  processPid: number | null;
  processStartedAt: Date | null;
  retryOfRunId: string | null;
  processLossRetryCount: number;
  contextSnapshot: HeartbeatRunContextSnapshot | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface HeartbeatRunEvent {
  id: number;
  orgId: string;
  runId: string;
  agentId: string;
  seq: number;
  eventType: string;
  stream: "system" | "stdout" | "stderr" | null;
  level: "info" | "warn" | "error" | null;
  color: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AgentRuntimeState {
  agentId: string;
  orgId: string;
  agentRuntimeType: string;
  sessionId: string | null;
  sessionDisplayId?: string | null;
  sessionParamsJson?: Record<string, unknown> | null;
  stateJson: Record<string, unknown>;
  lastRunId: string | null;
  lastRunStatus: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCostCents: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentTaskSession {
  id: string;
  orgId: string;
  agentId: string;
  agentRuntimeType: string;
  taskKey: string;
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentWakeupRequest {
  id: string;
  orgId: string;
  agentId: string;
  source: HeartbeatInvocationSource;
  triggerDetail: WakeupTriggerDetail | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  status: WakeupRequestStatus;
  coalescedCount: number;
  requestedByActorType: "user" | "agent" | "system" | null;
  requestedByActorId: string | null;
  idempotencyKey: string | null;
  runId: string | null;
  requestedAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InstanceSchedulerHeartbeatAgent {
  id: string;
  orgId: string;
  organizationName: string;
  organizationIssuePrefix: string;
  agentName: string;
  agentUrlKey: string;
  role: AgentRole;
  title: string | null;
  status: AgentStatus;
  agentRuntimeType: string;
  intervalSec: number;
  heartbeatEnabled: boolean;
  schedulerActive: boolean;
  lastHeartbeatAt: Date | null;
}
