// ---------------------------------------------------------------------------
// Minimal agent-runtime-facing interfaces (no drizzle dependency)
// ---------------------------------------------------------------------------

export interface AgentRuntimeAgent {
  id: string;
  orgId: string;
  name: string;
  agentRuntimeType: string | null;
  agentRuntimeConfig: unknown;
}

export interface AgentRuntimeState {
  /**
   * Legacy single session id view. Prefer `sessionParams` + `sessionDisplayId`.
   */
  sessionId: string | null;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  taskKey: string | null;
}

// ---------------------------------------------------------------------------
// Execution types (moved from server/src/agent-runtimes/types.ts)
// ---------------------------------------------------------------------------

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export type AgentRuntimeBillingType =
  | "api"
  | "subscription"
  | "metered_api"
  | "subscription_included"
  | "subscription_overage"
  | "credits"
  | "fixed"
  | "unknown";

export interface AgentRuntimeServiceReport {
  id?: string | null;
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  issueId?: string | null;
  scopeType?: "project_workspace" | "execution_workspace" | "run" | "agent";
  scopeId?: string | null;
  serviceName: string;
  status?: "starting" | "running" | "stopped" | "failed";
  lifecycle?: "shared" | "ephemeral";
  reuseKey?: string | null;
  command?: string | null;
  cwd?: string | null;
  port?: number | null;
  url?: string | null;
  providerRef?: string | null;
  ownerAgentId?: string | null;
  stopPolicy?: Record<string, unknown> | null;
  healthStatus?: "unknown" | "healthy" | "unhealthy";
}

export interface AgentRuntimeExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  errorMessage?: string | null;
  errorCode?: string | null;
  errorMeta?: Record<string, unknown>;
  usage?: UsageSummary;
  /**
   * Legacy single session id output. Prefer `sessionParams` + `sessionDisplayId`.
   */
  sessionId?: string | null;
  sessionParams?: Record<string, unknown> | null;
  sessionDisplayId?: string | null;
  provider?: string | null;
  biller?: string | null;
  model?: string | null;
  billingType?: AgentRuntimeBillingType | null;
  costUsd?: number | null;
  resultJson?: Record<string, unknown> | null;
  runtimeServices?: AgentRuntimeServiceReport[];
  summary?: string | null;
  clearSession?: boolean;
  question?: {
    prompt: string;
    choices: Array<{
      key: string;
      label: string;
      description?: string;
    }>;
  } | null;
}

export interface AgentRuntimeSessionCodec {
  deserialize(raw: unknown): Record<string, unknown> | null;
  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null;
  getDisplayId?: (params: Record<string, unknown> | null) => string | null;
}

export interface AgentRuntimeLoadedSkillMeta {
  key: string;
  runtimeName?: string | null;
  name?: string | null;
  description?: string | null;
}

export interface AgentRuntimeInvocationMeta {
  agentRuntimeType: string;
  command: string;
  cwd?: string;
  commandArgs?: string[];
  commandNotes?: string[];
  env?: Record<string, string>;
  prompt?: string;
  promptMetrics?: Record<string, number>;
  loadedSkills?: AgentRuntimeLoadedSkillMeta[];
  context?: Record<string, unknown>;
}

export interface AgentRuntimeExecutionContext {
  runId: string;
  agent: AgentRuntimeAgent;
  runtime: AgentRuntimeState;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onMeta?: (meta: AgentRuntimeInvocationMeta) => Promise<void>;
  onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
  authToken?: string;
  abortSignal?: AbortSignal;
}

export interface AgentRuntimeModel {
  id: string;
  label: string;
}

export type AgentRuntimeEnvironmentCheckLevel = "info" | "warn" | "error";

export interface AgentRuntimeEnvironmentCheck {
  code: string;
  level: AgentRuntimeEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export type AgentRuntimeEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AgentRuntimeEnvironmentTestResult {
  agentRuntimeType: string;
  status: AgentRuntimeEnvironmentTestStatus;
  checks: AgentRuntimeEnvironmentCheck[];
  testedAt: string;
}

export type AgentRuntimeSkillSyncMode = "unsupported" | "persistent" | "ephemeral";

export type AgentRuntimeSkillState =
  | "available"
  | "configured"
  | "installed"
  | "missing"
  | "stale"
  | "external";

export type AgentRuntimeSkillOrigin =
  | "organization_managed"
  | "user_installed"
  | "external_unknown";

export interface AgentRuntimeSkillEntry {
  key: string;
  runtimeName: string | null;
  description?: string | null;
  desired: boolean;
  managed: boolean;
  state: AgentRuntimeSkillState;
  origin?: AgentRuntimeSkillOrigin;
  originLabel?: string | null;
  locationLabel?: string | null;
  readOnly?: boolean;
  sourcePath?: string | null;
  targetPath?: string | null;
  detail?: string | null;
}

export interface AgentRuntimeSkillSnapshot {
  agentRuntimeType: string;
  supported: boolean;
  mode: AgentRuntimeSkillSyncMode;
  desiredSkills: string[];
  entries: AgentRuntimeSkillEntry[];
  warnings: string[];
}

export interface AgentRuntimeSkillContext {
  agentId: string;
  orgId: string;
  agentRuntimeType: string;
  config: Record<string, unknown>;
}

export interface AgentRuntimeEnvironmentTestContext {
  orgId: string;
  agentRuntimeType: string;
  config: Record<string, unknown>;
  deployment?: {
    mode?: "local_trusted" | "authenticated";
    exposure?: "private" | "public";
    bindHost?: string | null;
    allowedHostnames?: string[];
  };
}

/** Payload for the onHireApproved adapter lifecycle hook (e.g. join-request or hire_agent approval). */
export interface HireApprovedPayload {
  orgId: string;
  agentId: string;
  agentName: string;
  agentRuntimeType: string;
  /** "join_request" | "approval" */
  source: "join_request" | "approval";
  sourceId: string;
  approvedAt: string;
  /** Canonical operator-facing message for cloud adapters to show the user. */
  message: string;
}

/** Result of onHireApproved hook; failures are non-fatal to the approval flow. */
export interface HireApprovedHookResult {
  ok: boolean;
  error?: string;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Quota window types — used by adapters that can report provider quota/rate-limit state
// ---------------------------------------------------------------------------

/** a single rate-limit or usage window returned by a provider quota API */
export interface QuotaWindow {
  /** human label, e.g. "5h", "7d", "Sonnet 7d", "Credits" */
  label: string;
  /** percent of the window already consumed (0-100), null when not reported */
  usedPercent: number | null;
  /** iso timestamp when this window resets, null when not reported */
  resetsAt: string | null;
  /** free-form value label for credit-style windows, e.g. "$4.20 remaining" */
  valueLabel: string | null;
  /** optional supporting text, e.g. reset details or provider-specific notes */
  detail?: string | null;
}

/** result for one provider from getQuotaWindows() */
export interface ProviderQuotaResult {
  /** provider slug, e.g. "anthropic", "openai" */
  provider: string;
  /** source label when the provider reports where the quota data came from */
  source?: string | null;
  /** true when the fetch succeeded and windows is populated */
  ok: boolean;
  /** error message when ok is false */
  error?: string;
  windows: QuotaWindow[];
}

export interface ServerAgentRuntimeModule {
  type: string;
  execute(ctx: AgentRuntimeExecutionContext): Promise<AgentRuntimeExecutionResult>;
  testEnvironment(ctx: AgentRuntimeEnvironmentTestContext): Promise<AgentRuntimeEnvironmentTestResult>;
  parseStdoutLine?: StdoutLineParser;
  listSkills?: (ctx: AgentRuntimeSkillContext) => Promise<AgentRuntimeSkillSnapshot>;
  syncSkills?: (ctx: AgentRuntimeSkillContext, desiredSkills: string[]) => Promise<AgentRuntimeSkillSnapshot>;
  sessionCodec?: AgentRuntimeSessionCodec;
  sessionManagement?: import("./session-compaction.js").AgentRuntimeSessionManagement;
  supportsLocalAgentJwt?: boolean;
  models?: AgentRuntimeModel[];
  listModels?: () => Promise<AgentRuntimeModel[]>;
  agentConfigurationDoc?: string;
  /**
   * Optional lifecycle hook when an agent is approved/hired (join-request or hire_agent approval).
   * agentRuntimeConfig is the agent's runtime config so the runtime can e.g. send a callback to a configured URL.
   */
  onHireApproved?: (
    payload: HireApprovedPayload,
    agentRuntimeConfig: Record<string, unknown>,
  ) => Promise<HireApprovedHookResult>;
  /**
   * Optional: fetch live provider quota/rate-limit windows for this agent runtime.
   * Returns a ProviderQuotaResult so the server can aggregate across runtimes
   * without knowing provider-specific credential paths or API shapes.
   */
  getQuotaWindows?: () => Promise<ProviderQuotaResult>;
}

// ---------------------------------------------------------------------------
// UI types (moved from ui/src/agent-runtimes/types.ts)
// ---------------------------------------------------------------------------

export type TranscriptEntry =
  | { kind: "assistant"; ts: string; text: string; delta?: boolean }
  | { kind: "thinking"; ts: string; text: string; delta?: boolean }
  | { kind: "user"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; toolName?: string; content: string; isError: boolean }
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | { kind: "result"; ts: string; text: string; inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number; subtype: string; isError: boolean; errors: string[] }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string };

export type StdoutLineParser = (line: string, ts: string) => TranscriptEntry[];

// ---------------------------------------------------------------------------
// CLI types (moved from cli/src/agent-runtimes/types.ts)
// ---------------------------------------------------------------------------

export interface CLIAgentRuntimeModule {
  type: string;
  formatStdoutEvent: (line: string, debug: boolean) => void;
}

// ---------------------------------------------------------------------------
// UI config form values (moved from ui/src/components/AgentConfigForm.tsx)
// ---------------------------------------------------------------------------

export interface CreateConfigValues {
  agentRuntimeType: string;
  cwd: string;
  instructionsFilePath?: string;
  promptTemplate: string;
  model: string;
  thinkingEffort: string;
  chrome: boolean;
  dangerouslySkipPermissions: boolean;
  search: boolean;
  dangerouslyBypassSandbox: boolean;
  command: string;
  args: string;
  extraArgs: string;
  envVars: string;
  envBindings: Record<string, unknown>;
  url: string;
  bootstrapPrompt: string;
  payloadTemplateJson?: string;
  workspaceStrategyType?: string;
  workspaceBaseRef?: string;
  workspaceBranchTemplate?: string;
  worktreeParentDir?: string;
  runtimeServicesJson?: string;
  maxTurnsPerRun: number;
  heartbeatEnabled: boolean;
  intervalSec: number;
}
