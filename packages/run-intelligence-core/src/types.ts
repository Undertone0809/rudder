import type { TranscriptEntry } from "@rudder/agent-runtime-utils";
import type { ExecutionLangfuseLink } from "@rudder/shared";
import type { HeartbeatRun, HeartbeatRunEvent } from "@rudder/shared";

export type RunDiagnosisMode = "auto" | "quick" | "error" | "perf" | "full";
export type RunFindingSeverity = "info" | "warn" | "error";

export interface EvalBundle {
  agentRuntimeType: string;
  agentConfigRevisionId: string | null;
  agentConfigRevisionCreatedAt: string | null;
  agentConfigFingerprint: string | null;
  runtimeConfigFingerprint: string | null;
}

export interface RunIssueRef {
  id: string;
  identifier: string | null;
  title: string | null;
}

export interface ObservedRun {
  run: HeartbeatRun;
  agentName: string | null;
  orgName: string | null;
  issue: RunIssueRef | null;
  bundle: EvalBundle;
  langfuse?: ExecutionLangfuseLink | null;
}

export interface RunLogChunk {
  ts: string;
  stream: "stdout" | "stderr" | "system";
  chunk: string;
}

export interface ObservedRunDetail extends ObservedRun {
  events: HeartbeatRunEvent[];
  logContent: string | null;
  logChunks: RunLogChunk[];
  transcript: TranscriptEntry[];
}

export interface ObservedRunStep {
  index: number;
  turnIndex: number | null;
  kind: TranscriptEntry["kind"];
  ts: string;
  label: string;
  preview: string;
  detailPreview: string;
  detailText: string;
  isModelEntry: boolean;
  isPayloadEntry: boolean;
  hasExpandableDetail: boolean;
  isError: boolean;
}

export interface ObservedRunTurn {
  turnIndex: number;
  label: string;
  summary: string;
  startedAt: string | null;
  endedAt: string | null;
  stepCount: number;
  toolCallCount: number;
  hasError: boolean;
  steps: ObservedRunStep[];
}

export interface ObservedRunTrace {
  steps: ObservedRunStep[];
  looseSteps: ObservedRunStep[];
  turns: ObservedRunTurn[];
  turnCount: number;
  payloadStepCount: number;
}

export interface RunFinding {
  id: string;
  severity: RunFindingSeverity;
  category: "health" | "error" | "performance" | "behavior" | "system";
  title: string;
  detail: string;
  evidence: string[];
}

export interface RunMetrics {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  assistantTurns: number;
  toolCalls: number;
  toolResults: number;
  stderrLines: number;
  firstToolCallLatencyMs: number | null;
  firstAssistantOutputLatencyMs: number | null;
  topTools: Array<{ name: string; count: number }>;
}

export interface RunDiagnosis {
  mode: RunDiagnosisMode;
  status: string;
  summary: string;
  failureTaxonomy: string;
  findings: RunFinding[];
  nextSteps: string[];
  metrics: RunMetrics;
}

export interface RunComparison {
  left: RunDiagnosis;
  right: RunDiagnosis;
  summary: string;
  deltas: Array<{
    metric: string;
    left: number | string | null;
    right: number | string | null;
    detail: string;
  }>;
}

export interface RunExportRow {
  run: HeartbeatRun;
  agentName: string | null;
  orgName: string | null;
  issue: RunIssueRef | null;
  bundle: EvalBundle;
  langfuse?: ExecutionLangfuseLink | null;
}
