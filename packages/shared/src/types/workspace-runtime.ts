export type RunWorkspaceStrategyType =
  | "project_primary"
  | "git_worktree"
  | "adapter_managed"
  | "cloud_sandbox";

export type ProjectRunWorkspaceDefaultMode =
  | "shared_workspace"
  | "isolated_workspace"
  | "operator_branch"
  | "adapter_default";

export type RunWorkspaceMode =
  | "inherit"
  | "shared_workspace"
  | "isolated_workspace"
  | "operator_branch"
  | "reuse_existing"
  | "agent_default";

export type RunWorkspaceProviderType =
  | "local_fs"
  | "git_worktree"
  | "adapter_managed"
  | "cloud_sandbox";

export type RunWorkspaceStatus =
  | "active"
  | "idle"
  | "in_review"
  | "archived"
  | "cleanup_failed";

export interface RunWorkspaceStrategy {
  type: RunWorkspaceStrategyType;
  baseRef?: string | null;
  branchTemplate?: string | null;
  worktreeParentDir?: string | null;
  provisionCommand?: string | null;
  teardownCommand?: string | null;
}

export interface ProjectRunWorkspacePolicy {
  enabled: boolean;
  defaultMode?: ProjectRunWorkspaceDefaultMode;
  allowIssueOverride?: boolean;
  defaultProjectWorkspaceId?: string | null;
  workspaceStrategy?: RunWorkspaceStrategy | null;
  workspaceRuntime?: Record<string, unknown> | null;
  branchPolicy?: Record<string, unknown> | null;
  pullRequestPolicy?: Record<string, unknown> | null;
  runtimePolicy?: Record<string, unknown> | null;
  cleanupPolicy?: Record<string, unknown> | null;
}

export interface IssueRunWorkspaceSettings {
  mode?: RunWorkspaceMode;
  workspaceStrategy?: RunWorkspaceStrategy | null;
  workspaceRuntime?: Record<string, unknown> | null;
}

export interface RunWorkspace {
  id: string;
  orgId: string;
  projectId: string;
  projectWorkspaceId: string | null;
  sourceIssueId: string | null;
  mode: Exclude<RunWorkspaceMode, "inherit" | "reuse_existing" | "agent_default"> | "adapter_managed" | "cloud_sandbox";
  strategyType: RunWorkspaceStrategyType;
  name: string;
  status: RunWorkspaceStatus;
  cwd: string | null;
  repoUrl: string | null;
  baseRef: string | null;
  branchName: string | null;
  providerType: RunWorkspaceProviderType;
  providerRef: string | null;
  derivedFromRunWorkspaceId: string | null;
  /** @deprecated Use derivedFromRunWorkspaceId. */
  derivedFromExecutionWorkspaceId: string | null;
  lastUsedAt: Date;
  openedAt: Date;
  closedAt: Date | null;
  cleanupEligibleAt: Date | null;
  cleanupReason: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

/** @deprecated Use RunWorkspaceStrategyType. */
export type ExecutionWorkspaceStrategyType = RunWorkspaceStrategyType;
/** @deprecated Use ProjectRunWorkspaceDefaultMode. */
export type ProjectExecutionWorkspaceDefaultMode = ProjectRunWorkspaceDefaultMode;
/** @deprecated Use RunWorkspaceMode. */
export type ExecutionWorkspaceMode = RunWorkspaceMode;
/** @deprecated Use RunWorkspaceProviderType. */
export type ExecutionWorkspaceProviderType = RunWorkspaceProviderType;
/** @deprecated Use RunWorkspaceStatus. */
export type ExecutionWorkspaceStatus = RunWorkspaceStatus;
/** @deprecated Use RunWorkspaceStrategy. */
export type ExecutionWorkspaceStrategy = RunWorkspaceStrategy;
/** @deprecated Use ProjectRunWorkspacePolicy. */
export type ProjectExecutionWorkspacePolicy = ProjectRunWorkspacePolicy;
/** @deprecated Use IssueRunWorkspaceSettings. */
export type IssueExecutionWorkspaceSettings = IssueRunWorkspaceSettings;
/** @deprecated Use RunWorkspace. */
export type ExecutionWorkspace = RunWorkspace;

export interface WorkspaceRuntimeService {
  id: string;
  orgId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  issueId: string | null;
  scopeType: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId: string | null;
  serviceName: string;
  status: "starting" | "running" | "stopped" | "failed";
  lifecycle: "shared" | "ephemeral";
  reuseKey: string | null;
  command: string | null;
  cwd: string | null;
  port: number | null;
  url: string | null;
  provider: "local_process" | "adapter_managed";
  providerRef: string | null;
  ownerAgentId: string | null;
  startedByRunId: string | null;
  lastUsedAt: Date;
  startedAt: Date;
  stoppedAt: Date | null;
  stopPolicy: Record<string, unknown> | null;
  healthStatus: "unknown" | "healthy" | "unhealthy";
  createdAt: Date;
  updatedAt: Date;
}
