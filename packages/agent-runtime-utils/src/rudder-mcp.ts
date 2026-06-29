export const RUDDER_MCP_SERVER_NAME = "rudder-control-plane";
export const RUDDER_MCP_TOOL_COUNT = 69;

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

export function rudderMcpCliCommand(): { command: string; args: string[] } {
  return {
    command: "rudder",
    args: ["mcp-server"],
  };
}
