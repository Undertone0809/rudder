export type AgentSkillSyncMode = "unsupported" | "persistent" | "ephemeral";

export type AgentSkillState =
  | "available"
  | "configured"
  | "installed"
  | "missing"
  | "stale"
  | "external";

export type AgentSkillOrigin =
  | "organization_managed"
  | "user_installed"
  | "external_unknown";

export type AgentSkillSourceClass =
  | "bundled"
  | "organization"
  | "agent_home"
  | "global"
  | "adapter_home";

export interface AgentSkillEntry {
  key: string;
  selectionKey: string;
  runtimeName: string | null;
  description?: string | null;
  desired: boolean;
  configurable: boolean;
  alwaysEnabled: boolean;
  managed: boolean;
  state: AgentSkillState;
  sourceClass: AgentSkillSourceClass;
  origin?: AgentSkillOrigin;
  originLabel?: string | null;
  locationLabel?: string | null;
  readOnly?: boolean;
  sourcePath?: string | null;
  targetPath?: string | null;
  workspaceEditPath?: string | null;
  detail?: string | null;
}

export interface AgentSkillSnapshot {
  agentRuntimeType: string;
  supported: boolean;
  mode: AgentSkillSyncMode;
  desiredSkills: string[];
  entries: AgentSkillEntry[];
  warnings: string[];
}

export interface AgentSkillSyncRequest {
  desiredSkills: string[];
}

export type AgentSkillTelemetryEvidence = "used" | "requested" | "loaded";

export interface AgentSkillTelemetryEvidenceCounts {
  used: number;
  requested: number;
  loaded: number;
}

export interface AgentSkillAnalyticsSkillTotal {
  key: string;
  label: string;
  count: number;
  evidence: AgentSkillTelemetryEvidence;
  evidenceCounts: AgentSkillTelemetryEvidenceCounts;
}

export interface AgentSkillAnalyticsDay {
  date: string;
  totalCount: number;
  runCount: number;
  evidenceCounts: AgentSkillTelemetryEvidenceCounts;
  skills: AgentSkillAnalyticsSkillTotal[];
}

export interface AgentSkillAnalytics {
  agentId: string;
  orgId: string;
  windowDays: number;
  startDate: string;
  endDate: string;
  totalCount: number;
  totalRunsWithSkills: number;
  evidenceCounts: AgentSkillTelemetryEvidenceCounts;
  skills: AgentSkillAnalyticsSkillTotal[];
  days: AgentSkillAnalyticsDay[];
}
