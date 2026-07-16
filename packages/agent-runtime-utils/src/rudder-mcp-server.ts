import { rudderMcpCliCommand, type RudderMcpCliCommand } from "./rudder-mcp.js";
import { materializeRudderCliShim, resolveRudderCliShimTarget } from "./server-utils.cli.js";

export async function resolveRudderMcpCliCommand(moduleDir: string): Promise<RudderMcpCliCommand> {
  const target = await resolveRudderCliShimTarget(moduleDir);
  if (!target) return rudderMcpCliCommand();
  const cliShim = await materializeRudderCliShim(target);

  return {
    command: target.command,
    args: [...target.args, "mcp-server"],
    env: {
      RUDDER_MCP_RUDDER_BIN: cliShim,
    },
    provenance: target.provenance,
    expectedVersion: target.version,
  };
}
