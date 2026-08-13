import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readOpenCodeLoadedMcpServers } from "./mcp-evidence.js";

describe("readOpenCodeLoadedMcpServers", () => {
  it("reads the final realized config without retaining server details", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-opencode-mcp-evidence-"));
    const configPath = path.join(dir, "opencode.json");
    await fs.writeFile(configPath, JSON.stringify({ mcp: { "rudder-browser": { command: ["secret"] }, external: { url: "https://secret.test" } } }));
    await expect(readOpenCodeLoadedMcpServers(configPath)).resolves.toEqual([
      { serverName: "rudder-browser", source: "built_in" },
      { serverName: "external", source: "managed_external" },
    ]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("omits unknown evidence when the final config cannot be read", async () => {
    await expect(readOpenCodeLoadedMcpServers("/missing/opencode.json")).resolves.toBeNull();
  });
});
