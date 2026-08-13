import {
  RUDDER_BROWSER_MCP_SERVER_NAME,
  RUDDER_COMPUTER_MCP_SERVER_NAME,
  RUDDER_MCP_SERVER_NAME,
  type AgentRuntimeLoadedMcpServerMeta,
  type ResolvedManagedExternalMcpBinding,
} from "@rudderhq/agent-runtime-utils";

export function buildCodexLoadedMcpServers(input: {
  coreEnabled: boolean;
  browserEnabled: boolean;
  computerEnabled: boolean;
  externalBindings: ResolvedManagedExternalMcpBinding[];
}): AgentRuntimeLoadedMcpServerMeta[] {
  return [
    ...(input.coreEnabled
      ? [{ serverName: RUDDER_MCP_SERVER_NAME, source: "built_in" as const }]
      : []),
    ...(input.browserEnabled
      ? [{ serverName: RUDDER_BROWSER_MCP_SERVER_NAME, source: "built_in" as const }]
      : []),
    ...(input.computerEnabled
      ? [{ serverName: RUDDER_COMPUTER_MCP_SERVER_NAME, source: "built_in" as const }]
      : []),
    ...input.externalBindings.map((binding) => ({
      serverName: binding.serverName,
      source: "managed_external" as const,
    })),
  ];
}
