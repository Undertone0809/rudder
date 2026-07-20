import {
  RUDDER_BROWSER_MCP_CONTRACT_HASH,
  RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_MCP_CANONICAL_TOOL_CONTRACTS,
  RUDDER_MCP_CONTRACT_VERSION,
} from "@rudderhq/agent-runtime-utils";
import { spawn } from "node:child_process";
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

export type InstalledVersionMismatchedDesktopMcp = {
  command: string;
  args: string[];
  restore: () => void;
};

export async function installVersionMismatchedDesktopMcp(
  root: string,
): Promise<InstalledVersionMismatchedDesktopMcp> {
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
const coreTools = tools.filter((tool) => !tool.name.startsWith("rudder_browser_"));
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
        serverInfo: { name: "rudder-operating-layer", version: "0.4.5" },
      } }));
    }
    if (request.method === "tools/list") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
        tools: process.env.RUDDER_BROWSER_ENABLED === "false" ? coreTools : tools,
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
  return {
    command: executable,
    args: ["--desktop-cli", "mcp-server"],
    restore: () => {
      if (process.env.RUDDER_DESKTOP_CLI_ENTRY !== cliEntry) return;
      if (previous && !previous.startsWith(FIXTURE_ROOT)) process.env.RUDDER_DESKTOP_CLI_ENTRY = previous;
      else delete process.env.RUDDER_DESKTOP_CLI_ENTRY;
    },
  };
}

export async function readMcpToolNames(input: {
  command: string;
  args: string[];
  env?: Record<string, string>;
}): Promise<string[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      env: { ...process.env, ...(input.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, names?: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(names ?? []);
    };
    const parseLines = () => {
      const lines = stdout.split(/\r?\n/u);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const response = JSON.parse(line) as {
          id?: unknown;
          result?: { tools?: Array<{ name?: unknown }> };
        };
        if (response.id !== "tools-list") continue;
        const tools = response.result?.tools;
        if (!Array.isArray(tools) || tools.some((tool) => typeof tool.name !== "string")) {
          finish(new Error("MCP tools/list returned an invalid test manifest"));
          return;
        }
        finish(undefined, tools.map((tool) => tool.name as string));
      }
    };
    const timer = setTimeout(() => {
      finish(new Error(stderr.trim() || "MCP tools/list test readback timed out"));
    }, 5_000);
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (settled) return;
      finish(new Error(
        stderr.trim() || `MCP server exited before readback (code=${code ?? "null"}, signal=${signal ?? "none"})`,
      ));
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      parseLines();
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "provider-config-readback", version: "1" },
      },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "tools-list", method: "tools/list", params: {} })}\n`);
  });
}
