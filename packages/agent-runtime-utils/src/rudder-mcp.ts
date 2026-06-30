export const RUDDER_MCP_SERVER_NAME = "rudder-control-plane";
export const RUDDER_MCP_TOOL_COUNT = 69;
export const RUDDER_MCP_MANAGED_ENV_KEYS = [
  "RUDDER_API_URL",
  "RUDDER_API_KEY",
  "RUDDER_ORG_ID",
  "RUDDER_AGENT_ID",
  "RUDDER_RUN_ID",
  "RUDDER_PROJECT_LIBRARY_PATH",
] as const;

export type RudderMcpManagedEnvKey = typeof RUDDER_MCP_MANAGED_ENV_KEYS[number];
export type RudderMcpManagedEnv = Partial<Record<RudderMcpManagedEnvKey, string>>;

export interface RudderMcpCliCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface RudderMcpRuntimeMetadata {
  available: boolean;
  serverName: typeof RUDDER_MCP_SERVER_NAME;
  toolCount: number;
  fallbackReason?: string | null;
}

export function rudderMcpRuntimeMetadata(
  input: { available?: boolean; fallbackReason?: string | null } = {},
): RudderMcpRuntimeMetadata {
  return {
    available: input.available ?? true,
    serverName: RUDDER_MCP_SERVER_NAME,
    toolCount: RUDDER_MCP_TOOL_COUNT,
    fallbackReason: input.fallbackReason ?? null,
  };
}

export function rudderMcpCliCommand(): RudderMcpCliCommand {
  return {
    command: "rudder",
    args: ["mcp-server"],
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
