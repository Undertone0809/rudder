import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRudderMcpCoreAvailable,
  preflightRudderMcpServer,
} from "./rudder-mcp-preflight.js";
import {
  RUDDER_BROWSER_MCP_CONTRACT_HASH,
  RUDDER_BROWSER_MCP_TOOL_NAMES,
  RUDDER_MCP_CONTRACT_VERSION,
} from "./rudder-mcp.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixtureCommand(mode: string, expectedVersion = "0.4.6") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-mcp-preflight-"));
  roots.push(root);
  const script = path.join(root, "server.mjs");
  await fs.writeFile(script, `
import readline from "node:readline";
const mode = process.env.RUDDER_PREFLIGHT_FIXTURE_MODE;
const browserTools = ${JSON.stringify([...RUDDER_BROWSER_MCP_TOOL_NAMES])};
const coreTools = ["rudder_agent_me"];
const desktopCliEntryLeaked = Boolean(process.env.RUDDER_DESKTOP_CLI_ENTRY);
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id == null) continue;
  if (mode === "exit") process.exit(2);
  if (request.method === "initialize") {
    const version = mode === "version" ? "0.4.5" : "0.4.6";
    const hash = mode === "contract" ? "stale-contract" : ${JSON.stringify(RUDDER_BROWSER_MCP_CONTRACT_HASH)};
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, experimental: { rudder: {
        contractVersion: ${JSON.stringify(RUDDER_MCP_CONTRACT_VERSION)},
        browserContractHash: hash,
      } } },
      serverInfo: { name: mode === "server" || desktopCliEntryLeaked ? "not-rudder" : "rudder-control-plane", version },
    } }));
  }
  if (request.method === "tools/list") {
    if (mode === "malformed") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));
      continue;
    }
    const tools = mode === "core" ? browserTools : [
      ...coreTools,
      ...(mode === "tools" ? browserTools.slice(0, -1) : browserTools),
    ];
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      tools: tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })),
    } }));
  }
}
`, "utf8");
  return {
    command: process.execPath,
    args: [script],
    env: { RUDDER_PREFLIGHT_FIXTURE_MODE: mode },
    provenance: "repo" as const,
    expectedVersion,
  };
}

describe("preflightRudderMcpServer", () => {
  it("accepts the exact version, contract hash, and eight Browser tools", async () => {
    const result = await preflightRudderMcpServer({
      command: await fixtureCommand("ok"),
      runtimeEnv: {},
      browserEnabled: true,
    });

    expect(result).toMatchObject({
      available: true,
      browserAvailable: true,
      provenance: "repo",
      version: "0.4.6",
      contractVersion: RUDDER_MCP_CONTRACT_VERSION,
      contractHash: RUDDER_BROWSER_MCP_CONTRACT_HASH,
      diagnosticCode: null,
    });
    expect(result.tools.map((tool) => tool.name).filter((name) => name.startsWith("rudder_browser_")))
      .toEqual([...RUDDER_BROWSER_MCP_TOOL_NAMES]);
  });

  it.each([
    ["server", "browser_bundle_server_mismatch"],
    ["version", "browser_bundle_version_mismatch"],
    ["contract", "browser_bundle_contract_mismatch"],
    ["tools", "browser_bundle_tools_mismatch"],
    ["exit", "browser_bundle_handshake_failed"],
  ])("degrades Browser with a stable diagnostic for %s mismatch", async (mode, diagnosticCode) => {
    const result = await preflightRudderMcpServer({
      command: await fixtureCommand(mode),
      runtimeEnv: {},
      browserEnabled: true,
    });

    expect(result.browserAvailable).toBe(false);
    expect(result.diagnosticCode).toBe(diagnosticCode);
  });

  it("does not expose the private Desktop CLI entry to the preflight child", async () => {
    const result = await preflightRudderMcpServer({
      command: await fixtureCommand("ok"),
      runtimeEnv: { RUDDER_DESKTOP_CLI_ENTRY: "/private/Desktop.app/desktop-cli.js" },
      browserEnabled: true,
    });

    expect(result).toMatchObject({ available: true, browserAvailable: true, diagnosticCode: null });
  });

  it.each(["server", "exit"])("fails core MCP fast for %s failure", async (mode) => {
    const result = await preflightRudderMcpServer({
      command: await fixtureCommand(mode),
      runtimeEnv: {},
      browserEnabled: true,
    });

    expect(result.available).toBe(false);
    expect(() => assertRudderMcpCoreAvailable(result)).toThrow(/Rudder MCP/u);
  });

  it.each(["malformed", "core"])("fails core MCP fast for %s tools/list", async (mode) => {
    const result = await preflightRudderMcpServer({
      command: await fixtureCommand(mode),
      runtimeEnv: { RUDDER_DESKTOP_CLI_ENTRY: "/private/Desktop.app/desktop-cli.js" },
      browserEnabled: false,
    });

    expect(result).toMatchObject({
      available: false,
      browserAvailable: false,
      diagnosticCode: "browser_bundle_handshake_failed",
    });
    expect(() => assertRudderMcpCoreAvailable(result)).toThrow(/Rudder MCP/u);
  });
});
