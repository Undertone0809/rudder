import type { HeartbeatInvocationSource, HeartbeatRunStatus, WakeupTriggerDetail } from "../constants.js";
import type { HeartbeatSessionReuseScope } from "./heartbeat.js";

export interface RunSummaryIssue {
  id: string;
  identifier: string | null;
  title: string | null;
}

export interface RunSummaryTarget {
  type: string;
  id: string;
}

export interface RunSummaryUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  provider: string | null;
  model: string | null;
}

export interface RunSummarySkillEvidence {
  evidenceType: "used" | "loaded";
  matchedSkillKey: string;
  matchedSkillLabel: string | null;
  sourceEventType: string | null;
  sourceEventId: number | null;
  sourceEventCreatedAt: string | null;
}

export interface RunSummary {
  id: string;
  shortRef?: string;
  orgId: string;
  orgName: string | null;
  agentId: string;
  agentName: string | null;
  runtime: string;
  invocationSource: HeartbeatInvocationSource;
  triggerDetail: WakeupTriggerDetail | null;
  status: HeartbeatRunStatus;
  sessionReuseScope: HeartbeatSessionReuseScope;
  issue: RunSummaryIssue | null;
  target: RunSummaryTarget | null;
  chatConversationId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  createdAt: Date;
  updatedAt: Date;
  outcome: string | null;
  error: string | null;
  usage: RunSummaryUsage | null;
  skillEvidence: RunSummarySkillEvidence | null;
  hasLog: boolean;
  logBytes: number;
}

export interface RunSummaryPage {
  items: RunSummary[];
  page: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export interface RunInspectionHeader {
  id: string;
  shortRef?: string;
  orgId: string;
  agentId: string;
  invocationSource: HeartbeatInvocationSource;
  triggerDetail: WakeupTriggerDetail | null;
  status: HeartbeatRunStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  errorCode: string | null;
  exitCode: number | null;
  signal: string | null;
  chatConversationId: string | null;
  logBytes: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunEventCursorPage {
  cursor: string | null;
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** Legacy sequence-only pagination input. New clients must use cursor. */
  afterSeq: number | null;
}
