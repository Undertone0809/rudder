import {
  RUDDER_BROWSER_MCP_SERVER_NAME,
  RUDDER_MCP_SERVER_NAME,
  type AgentRuntimeLoadedMcpServerMeta,
} from "@rudderhq/agent-runtime-utils";
import { parseJson, parseObject } from "@rudderhq/agent-runtime-utils/server-utils";
import fs from "node:fs/promises";

export async function readClaudeLoadedMcpServers(configPath: string): Promise<AgentRuntimeLoadedMcpServerMeta[] | null> {
  try {
    const content = await fs.readFile(configPath, "utf8");
    const servers = parseObject(parseJson(content)?.mcpServers);
    return Object.keys(servers ?? {}).map((serverName) => ({
      serverName,
      source: serverName === RUDDER_MCP_SERVER_NAME || serverName === RUDDER_BROWSER_MCP_SERVER_NAME
        ? "built_in"
        : "managed_external",
    }));
  } catch {
    return null;
  }
}
