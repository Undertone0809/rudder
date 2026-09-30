import {
  RUDDER_AGENT_V1_MCP_SERVER_NAME,
  RUDDER_BROWSER_MCP_SERVER_NAME,
  RUDDER_BROWSER_MCP_TOOL_NAMES,
  RUDDER_CORE_MCP_TOOL_NAMES,
  type AgentBrowserToolSummary,
  type AgentRudderToolSummary,
} from "@rudderhq/shared";

export function buildAgentRudderTools(browserAvailable: boolean): Array<AgentRudderToolSummary | AgentBrowserToolSummary> {
  return [
    {
      id: RUDDER_AGENT_V1_MCP_SERVER_NAME,
      displayName: "Rudder MCP tools",
      kind: "rudder_mcp",
      status: "available",
      scope: "runtime",
      serverName: RUDDER_AGENT_V1_MCP_SERVER_NAME,
      contract: "agent-v1",
      toolCount: RUDDER_CORE_MCP_TOOL_NAMES.length,
      tools: [...RUDDER_CORE_MCP_TOOL_NAMES],
      authMode: "runtime_managed",
      cliFallbackAvailable: true,
    },
    {
      id: RUDDER_BROWSER_MCP_SERVER_NAME,
      displayName: "Rudder Browser",
      kind: "rudder_browser_mcp",
      status: browserAvailable ? "available" : "disabled",
      scope: "runtime",
      serverName: RUDDER_BROWSER_MCP_SERVER_NAME,
      contract: "browser-v1",
      toolCount: browserAvailable ? RUDDER_BROWSER_MCP_TOOL_NAMES.length : 0,
      tools: browserAvailable ? [...RUDDER_BROWSER_MCP_TOOL_NAMES] : [],
      authMode: "runtime_managed",
      cliFallbackAvailable: false,
    },
  ];
}
