export const RUDDER_MCP_SERVER_NAME = "rudder-control-plane";
export const RUDDER_MCP_TOOL_COUNT = 69;
export const RUDDER_BROWSER_MCP_TOOL_COUNT = 8;
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
}

export interface RudderMcpRuntimeMetadata {
  available: boolean;
  serverName: typeof RUDDER_MCP_SERVER_NAME;
  toolCount: number;
  fallbackReason?: string | null;
}

export function rudderMcpRuntimeMetadata(
  input: {
    available?: boolean;
    browserEnabled?: boolean;
    fallbackReason?: string | null;
  } = {},
): RudderMcpRuntimeMetadata {
  return {
    available: input.available ?? true,
    serverName: RUDDER_MCP_SERVER_NAME,
    toolCount: RUDDER_MCP_TOOL_COUNT + (input.browserEnabled === true ? RUDDER_BROWSER_MCP_TOOL_COUNT : 0),
    fallbackReason: input.fallbackReason ?? null,
  };
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
