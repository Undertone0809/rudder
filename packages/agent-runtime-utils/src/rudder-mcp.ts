export const RUDDER_MCP_SERVER_NAME = "rudder-control-plane";
export const RUDDER_CORE_MCP_TOOL_NAMES = [
  "rudder_agent_me",
  "rudder_agent_inbox",
  "rudder_agent_capabilities",
  "rudder_agent_update",
  "rudder_agent_skills_create",
  "rudder_agent_skills_enable",
  "rudder_agent_skills_sync",
  "rudder_issue_get",
  "rudder_issue_search",
  "rudder_issue_context",
  "rudder_issue_checkout",
  "rudder_issue_comment",
  "rudder_issue_comments_list",
  "rudder_issue_comments_get",
  "rudder_issue_update",
  "rudder_issue_review",
  "rudder_issue_commit",
  "rudder_issue_done",
  "rudder_issue_block",
  "rudder_project_list",
  "rudder_project_get",
  "rudder_project_create",
  "rudder_project_update",
  "rudder_user_activity",
  "rudder_library_file_list",
  "rudder_library_file_get",
  "rudder_library_file_ref",
  "rudder_library_file_link",
  "rudder_library_file_put",
  "rudder_approval_get",
  "rudder_approval_issues",
  "rudder_approval_comment",
  "rudder_skill_list",
  "rudder_skill_get",
  "rudder_skill_file",
  "rudder_skill_import",
  "rudder_skill_scan_local",
  "rudder_skill_scan_projects",
  "rudder_automation_list",
  "rudder_automation_get",
  "rudder_automation_runs",
  "rudder_automation_triggers_list",
  "rudder_automation_triggers_create",
  "rudder_automation_triggers_update",
  "rudder_automation_triggers_delete",
  "rudder_automation_triggers_rotate_secret",
  "rudder_automation_create",
  "rudder_automation_update",
  "rudder_automation_enable",
  "rudder_automation_disable",
  "rudder_automation_run",
  "rudder_chat_list",
  "rudder_chat_search",
  "rudder_chat_get",
  "rudder_chat_messages",
  "rudder_chat_transcript",
  "rudder_chat_read",
  "rudder_chat_create",
  "rudder_chat_send",
  "rudder_chat_archive",
  "rudder_runs_list",
  "rudder_runs_by_skill",
  "rudder_runs_get",
  "rudder_runs_events",
  "rudder_runs_log",
  "rudder_runs_transcript",
  "rudder_runs_errors",
  "rudder_runs_cancel",
  "rudder_runs_retry",
] as const;
export const RUDDER_MCP_TOOL_COUNT = RUDDER_CORE_MCP_TOOL_NAMES.length;
export const RUDDER_BROWSER_MCP_TOOL_COUNT = 8;
export const RUDDER_MCP_CONTRACT_VERSION = "rudder.agent-mcp-tools/v1";
export const RUDDER_BROWSER_MCP_TOOL_NAMES = [
  "rudder_browser_tabs",
  "rudder_browser_open",
  "rudder_browser_navigate",
  "rudder_browser_read",
  "rudder_browser_click",
  "rudder_browser_type",
  "rudder_browser_screenshot",
  "rudder_browser_close",
] as const;
export const RUDDER_BROWSER_MCP_CONTRACT_HASH = "1dfd1106f49a0ac6f9a0bafadad40eecd17f2ef18d26b96117b85aab7f25089d";
export const RUDDER_MCP_MANAGED_ENV_KEYS = [
  "RUDDER_API_URL",
  "RUDDER_API_KEY",
  "RUDDER_ORG_ID",
  "RUDDER_AGENT_ID",
  "RUDDER_RUN_ID",
  "RUDDER_BROWSER_ENABLED",
  "RUDDER_PROJECT_LIBRARY_PATH",
] as const;

export type RudderMcpManagedEnvKey = typeof RUDDER_MCP_MANAGED_ENV_KEYS[number];
export type RudderMcpManagedEnv = Partial<Record<RudderMcpManagedEnvKey, string>>;

export interface RudderMcpCliCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
  provenance: RudderMcpCliProvenance;
  expectedVersion?: string | null;
}

export type RudderMcpCliProvenance = "desktop_bundle" | "external_runtime" | "repo" | "path";

export type RudderMcpPreflightDiagnosticCode =
  | "browser_bundle_handshake_failed"
  | "browser_bundle_server_mismatch"
  | "browser_bundle_version_mismatch"
  | "browser_bundle_contract_mismatch"
  | "browser_bundle_tools_mismatch";

export interface RudderMcpPreflightResult {
  available: boolean;
  browserAvailable: boolean;
  provenance: RudderMcpCliProvenance;
  version: string | null;
  contractVersion: string | null;
  contractHash: string | null;
  diagnosticCode: RudderMcpPreflightDiagnosticCode | null;
  diagnostic: string | null;
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

export interface RudderMcpRuntimeMetadata {
  available: boolean;
  serverName: typeof RUDDER_MCP_SERVER_NAME;
  toolCount: number;
  provenance?: RudderMcpCliProvenance | null;
  version?: string | null;
  contractVersion?: string | null;
  contractHash?: string | null;
  browserAvailable?: boolean;
  diagnosticCode?: RudderMcpPreflightDiagnosticCode | null;
  fallbackReason?: string | null;
}

export function rudderMcpRuntimeMetadata(
  input: {
    available?: boolean;
    browserEnabled?: boolean;
    preflight?: RudderMcpPreflightResult | null;
    fallbackReason?: string | null;
  } = {},
): RudderMcpRuntimeMetadata {
  const browserAvailable = input.browserEnabled === true && input.preflight?.browserAvailable !== false;
  const metadata: RudderMcpRuntimeMetadata = {
    available: input.available ?? input.preflight?.available ?? true,
    serverName: RUDDER_MCP_SERVER_NAME,
    toolCount: RUDDER_MCP_TOOL_COUNT + (browserAvailable ? RUDDER_BROWSER_MCP_TOOL_COUNT : 0),
    fallbackReason: input.fallbackReason ?? input.preflight?.diagnostic ?? null,
  };
  if (input.preflight) {
    metadata.provenance = input.preflight.provenance;
    metadata.version = input.preflight.version;
    metadata.contractVersion = input.preflight.contractVersion;
    metadata.contractHash = input.preflight.contractHash;
    metadata.browserAvailable = browserAvailable;
    metadata.diagnosticCode = input.preflight.diagnosticCode;
  }
  return metadata;
}

export function applyRudderBrowserCapabilityEnv(
  env: Record<string, string>,
  config: Record<string, unknown>,
): boolean {
  const browserEnabled = config.rudderBrowserEnabled === true;
  env.RUDDER_BROWSER_ENABLED = browserEnabled ? "true" : "false";
  return browserEnabled;
}

export function filterRudderMcpToolsForBrowserCapability<T extends { name: string }>(
  tools: readonly T[],
  browserEnabled: boolean,
): T[] {
  if (browserEnabled) return [...tools];
  return tools.filter((tool) => !tool.name.startsWith("rudder_browser_"));
}

export function rudderMcpCliCommand(): RudderMcpCliCommand {
  return {
    command: "rudder",
    args: ["mcp-server"],
    provenance: "path",
  };
}

export function pickRudderMcpManagedEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RudderMcpManagedEnv {
  const managedEnv: RudderMcpManagedEnv = {};
  for (const key of RUDDER_MCP_MANAGED_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    managedEnv[key] = trimmed;
  }
  return managedEnv;
}
