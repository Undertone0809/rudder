export type RunDiagnosticFindingKind =
  | "run_failure"
  | "timeout"
  | "tool_call_error"
  | "cli_usage_error"
  | "adapter_error"
  | "runtime_error"
  | "dependency_error"
  | "permission_error"
  | "auth_error"
  | "network_error"
  | "behavior_warning"
  | "cost_warning"
  | "unknown_error";

export type RunDiagnosticFindingSeverity = "info" | "warn" | "error";

export type RunDiagnosticFindingStatus =
  | "open"
  | "acknowledged"
  | "resolved"
  | "ignored"
  | "needs_human"
  | "converted_to_issue";

export interface RunDiagnosticEvidence {
  label: string;
  value: string;
}

export interface RunDiagnosticFinding {
  id: string;
  orgId: string;
  runId: string;
  agentId: string;
  issueId: string | null;
  kind: RunDiagnosticFindingKind;
  severity: RunDiagnosticFindingSeverity;
  status: RunDiagnosticFindingStatus;
  fingerprint: string;
  summary: string;
  detailsJson: Record<string, unknown> | null;
  evidenceJson: RunDiagnosticEvidence[];
  rawExcerpt: string | null;
  source: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrenceCount: number;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunDiagnosticSummary {
  total: number;
  open: number;
  byKind: Record<string, number>;
  bySeverity: Record<string, number>;
}

export interface PatchRunDiagnosticFinding {
  status?: RunDiagnosticFindingStatus;
  resolutionNote?: string | null;
}
