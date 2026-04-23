export const EXECUTION_OBSERVABILITY_SURFACES = [
  "heartbeat_run",
  "issue_run",
  "plugin_job_run",
  "workspace_operation",
  "chat_turn",
  "chat_action",
  "messenger_action",
  "activity_mutation",
  "cost_event",
] as const;

export type ExecutionObservabilitySurface = (typeof EXECUTION_OBSERVABILITY_SURFACES)[number];

export interface ExecutionObservabilityContext {
  surface: ExecutionObservabilitySurface;
  rootExecutionId: string;
  orgId?: string | null;
  agentId?: string | null;
  issueId?: string | null;
  pluginId?: string | null;
  sessionKey?: string | null;
  runtime?: string | null;
  trigger?: string | null;
  status?: string | null;
  environment?: string | null;
  release?: string | null;
  instanceId?: string | null;
  deploymentMode?: string | null;
  localEnv?: string | null;
  metadata?: Record<string, unknown> | null;
  tags?: string[] | null;
}

export interface ExecutionLangfuseLink {
  traceId: string | null;
  traceUrl: string | null;
}
