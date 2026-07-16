import {
  RUDDER_BROWSER_MCP_CONTRACT_HASH,
  RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_MCP_CANONICAL_TOOL_CONTRACTS,
  RUDDER_MCP_CONTRACT_VERSION,
} from "@rudderhq/agent-runtime-utils";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const FIXTURE_ROOT = path.join(os.tmpdir(), "rudder-browser-mismatch-mcp-fixtures");

export async function createRuntimeSkillFixture(
  root: string,
  runtimeName: string,
  marker: string,
): Promise<string> {
  const source = path.join(root, "runtime-skills", runtimeName);
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(
    path.join(source, "SKILL.md"),
    `---\nname: ${runtimeName}\ndescription: ${runtimeName} test skill\n---\n\n${marker}\n`,
    "utf8",
  );
  return source;
}

export async function installVersionMismatchedDesktopMcp(root: string): Promise<() => void> {
  const fixtureDir = path.join(FIXTURE_ROOT, path.basename(root));
  const cliDir = path.join(fixtureDir, "Contents", "Resources", "app");
  const cliEntry = path.join(cliDir, "desktop-cli.js");
  const appRoot = path.dirname(path.dirname(cliDir));
  const executable = process.platform === "darwin"
    ? path.join(appRoot, "MacOS", "Rudder")
    : path.join(appRoot, process.platform === "win32" ? "Rudder.exe" : "Rudder");
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.mkdir(cliDir, { recursive: true });
  await fs.writeFile(cliEntry, "// Fake packaged Desktop CLI entry for resolver provenance.\n", "utf8");
  await fs.writeFile(
    path.join(cliDir, "rudder-cli-package.json"),
    `${JSON.stringify({ name: "@rudderhq/cli", version: "0.4.6" })}\n`,
    "utf8",
  );
  await fs.writeFile(executable, `#!/usr/bin/env node
const readline = require("node:readline");
const tools = ${JSON.stringify(RUDDER_MCP_CANONICAL_TOOL_CONTRACTS)};
const lines = readline.createInterface({ input: process.stdin });
(async () => {
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.id == null) continue;
    if (request.method === "initialize") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, experimental: { rudder: {
          contractVersion: ${JSON.stringify(RUDDER_MCP_CONTRACT_VERSION)},
          coreContractHash: ${JSON.stringify(RUDDER_CORE_MCP_CONTRACT_HASH)},
          browserContractHash: ${JSON.stringify(RUDDER_BROWSER_MCP_CONTRACT_HASH)},
        } } },
        serverInfo: { name: "rudder-control-plane", version: "0.4.5" },
      } }));
    }
    if (request.method === "tools/list") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
        tools,
      } }));
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`, "utf8");
  await fs.chmod(executable, 0o755);

  const previous = process.env.RUDDER_DESKTOP_CLI_ENTRY;
  process.env.RUDDER_DESKTOP_CLI_ENTRY = cliEntry;
  return () => {
    if (process.env.RUDDER_DESKTOP_CLI_ENTRY !== cliEntry) return;
    if (previous && !previous.startsWith(FIXTURE_ROOT)) process.env.RUDDER_DESKTOP_CLI_ENTRY = previous;
    else delete process.env.RUDDER_DESKTOP_CLI_ENTRY;
  };
}
