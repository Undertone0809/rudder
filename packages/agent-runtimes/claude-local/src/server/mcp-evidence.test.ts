import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readClaudeLoadedMcpServers } from "./mcp-evidence.js";

describe("readClaudeLoadedMcpServers", () => {
  it("reads the final realized config without retaining server details", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-claude-mcp-evidence-"));
    const configPath = path.join(dir, "mcp.json");
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { "rudder-tools": { command: "secret" }, external: { url: "https://secret.test" } } }));
    await expect(readClaudeLoadedMcpServers(configPath)).resolves.toEqual([
      { serverName: "rudder-tools", source: "built_in" },
      { serverName: "external", source: "managed_external" },
    ]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("omits unknown evidence when the final config cannot be read", async () => {
    await expect(readClaudeLoadedMcpServers("/missing/rudder-mcp.json")).resolves.toBeNull();
  });
});
