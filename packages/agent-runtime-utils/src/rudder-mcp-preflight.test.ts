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
  RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_MCP_CANONICAL_TOOL_CONTRACTS,
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
const canonicalTools = ${JSON.stringify(RUDDER_MCP_CANONICAL_TOOL_CONTRACTS)};
const canonicalByName = new Map(canonicalTools.map((tool) => [tool.name, tool]));
const browserTools = canonicalTools.filter((tool) => tool.name.startsWith("rudder_browser_")).map((tool) => tool.name);
const coreTools = canonicalTools.filter((tool) => !tool.name.startsWith("rudder_browser_")).map((tool) => tool.name);
const desktopCliEntryLeaked = Boolean(process.env.RUDDER_DESKTOP_CLI_ENTRY);
const canonicalSchema = () => ({ type: "object", additionalProperties: false, properties: {} });
function advertisedName(name) {
  if (mode === "whitespace-core-name" && name === coreTools[0]) return " " + name + " ";
  if (mode === "whitespace-browser-name" && name === browserTools[0]) return " " + name + " ";
  return name;
}
function advertisedDescription(name) {
  const description = canonicalByName.get(name)?.description ?? "Forged Rudder MCP tool.";
  if (mode === "semantic-core-description" && name === coreTools[0]) return description + " changed";
  if (mode === "semantic-browser-description" && name === "rudder_browser_open") return description + " changed";
  return description;
}
function inputSchema(name) {
  const canonical = structuredClone(canonicalByName.get(name)?.inputSchema ?? canonicalSchema());
  if (mode === "forged-core-malformed-schema") return { type: "string" };
  if (mode === "malformed-core-keyword" && name === coreTools[0]) {
    return { ...canonicalSchema(), oneOf: "not-an-array" };
  }
  if (mode === "malformed-browser-keyword" && name === browserTools[0]) {
    return { ...canonicalSchema(), enum: "not-an-array" };
  }
  if (mode === "unsupported-core-schema-draft" && name === coreTools[0]) {
    return { ...canonicalSchema(), $schema: "https://json-schema.org/draft/2020-12/schema" };
  }
  if (mode === "unsupported-browser-schema-draft" && name === browserTools[0]) {
    return { ...canonicalSchema(), $schema: "https://example.invalid/unknown-schema" };
  }
  if (mode === "malformed-nested-keyword" && name === coreTools[0]) {
    return { ...canonicalSchema(), properties: { value: { type: "string", oneOf: [] } } };
  }
  if (mode === "malformed-core-schema" && name === coreTools[0]) return { type: "string" };
  if (mode === "malformed-browser-schema" && name === browserTools[0]) {
    return { type: "object", additionalProperties: false, properties: [] };
  }
  if (mode === "semantic-core-required" && name === coreTools[0]) {
    canonical.properties = { ...canonical.properties, bogus: { type: "string" } };
    canonical.required = ["bogus"];
  }
  if (mode === "semantic-browser-required" && name === "rudder_browser_open") {
    canonical.properties = { ...canonical.properties, bogus: { type: "string" } };
    canonical.required = ["bogus"];
  }
  return canonical;
}
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id == null) continue;
  if (mode === "exit") process.exit(2);
  if (mode === "exit-stderr") {
    console.error("ignorable warning");
    console.error("actionable root cause");
    process.exit(3);
  }
  if (request.method === "initialize") {
    const version = mode.startsWith("version") ? "0.4.5" : "0.4.6";
    const hash = mode === "contract" ? "stale-contract" : ${JSON.stringify(RUDDER_BROWSER_MCP_CONTRACT_HASH)};
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, experimental: { rudder: {
        contractVersion: ${JSON.stringify(RUDDER_MCP_CONTRACT_VERSION)},
        coreContractHash: ${JSON.stringify(RUDDER_CORE_MCP_CONTRACT_HASH)},
        browserContractHash: hash,
      } } },
      serverInfo: { name: mode === "server" || desktopCliEntryLeaked ? "not-rudder" : "rudder-tools", version },
    } }));
  }
  if (request.method === "tools/list") {
    if (mode === "malformed") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));
      continue;
    }
    const selectedCoreTools = mode === "forged-core" || mode === "forged-core-malformed-schema"
      ? ["rudder_forged_core"]
      : mode === "partial-core"
        ? coreTools.slice(0, -1)
        : mode === "duplicate-core"
          ? [...coreTools, coreTools[0]]
          : mode === "reordered-core"
            ? [coreTools[1], coreTools[0], ...coreTools.slice(2)]
            : mode === "unknown-core"
              ? [...coreTools, "rudder_unknown_core"]
              : mode === "no-core"
                ? []
                : coreTools;
    const selectedBrowserTools = process.env.RUDDER_BROWSER_ENABLED === "true" || mode === "version-ignore-browser-env"
      ? (mode === "tools" ? browserTools.slice(0, -1) : browserTools)
      : [];
    const tools = [...selectedCoreTools, ...selectedBrowserTools];
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      tools: tools.map((name) => ({
        name: advertisedName(name),
        description: advertisedDescription(name),
        inputSchema: inputSchema(name),
      })),
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
      coreContractHash: RUDDER_CORE_MCP_CONTRACT_HASH,
      contractHash: RUDDER_BROWSER_MCP_CONTRACT_HASH,
      diagnosticCode: null,
    });
    expect(result.tools.map((tool) => tool.name).filter((name) => name.startsWith("rudder_browser_")))
      .toEqual([...RUDDER_BROWSER_MCP_TOOL_NAMES]);
  });

  it("accepts the recursive schema dialect emitted by the canonical registry", async () => {
    const result = await preflightRudderMcpServer({
      command: await fixtureCommand("canonical-nested-schema"),
      runtimeEnv: {},
      browserEnabled: true,
    });

    expect(result).toMatchObject({ available: true, browserAvailable: true, diagnosticCode: null });
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

  it("fails closed when Browser downgrade cannot establish an exact core-only provider surface", async () => {
    const result = await preflightRudderMcpServer({
      command: await fixtureCommand("version-ignore-browser-env"),
      runtimeEnv: {},
      browserEnabled: true,
    });

    expect(result).toMatchObject({
      available: false,
      browserAvailable: false,
      diagnosticCode: "browser_bundle_handshake_failed",
    });
    expect(result.diagnostic).toContain("exact core-only provider surface");
    expect(() => assertRudderMcpCoreAvailable(result)).toThrow(/Rudder MCP/u);
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

  it("reports the exit context and trailing stderr detail", async () => {
    const result = await preflightRudderMcpServer({
      command: await fixtureCommand("exit-stderr"),
      runtimeEnv: {},
      browserEnabled: true,
    });

    expect(result.diagnostic).toContain("code=3");
    expect(result.diagnostic).toContain("ignorable warning | actionable root cause");
  });

  it.each([
    "malformed",
    "no-core",
    "forged-core",
    "partial-core",
    "duplicate-core",
    "reordered-core",
    "unknown-core",
    "whitespace-core-name",
    "malformed-core-schema",
    "malformed-core-keyword",
    "unsupported-core-schema-draft",
    "malformed-nested-keyword",
  ])("fails core MCP fast for %s tools/list", async (mode) => {
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

  it.each(["semantic-core-required", "semantic-core-description"])(
    "fails core MCP fast for legal semantic forgery %s despite matching advertised hashes",
    async (mode) => {
      const result = await preflightRudderMcpServer({
        command: await fixtureCommand(mode),
        runtimeEnv: {},
        browserEnabled: false,
      });

      expect(result).toMatchObject({
        available: false,
        coreContractHash: RUDDER_CORE_MCP_CONTRACT_HASH,
        contractHash: RUDDER_BROWSER_MCP_CONTRACT_HASH,
        diagnosticCode: "browser_bundle_handshake_failed",
      });
      expect(() => assertRudderMcpCoreAvailable(result)).toThrow(/Rudder MCP/u);
    },
  );

  it("keeps canonical core MCP while degrading Browser for a malformed Browser schema", async () => {
    const result = await preflightRudderMcpServer({
      command: await fixtureCommand("malformed-browser-schema"),
      runtimeEnv: {},
      browserEnabled: true,
    });

    expect(result).toMatchObject({
      available: true,
      browserAvailable: false,
      diagnosticCode: "browser_bundle_tools_mismatch",
    });
    expect(() => assertRudderMcpCoreAvailable(result)).not.toThrow();
  });

  it.each([
    "whitespace-browser-name",
    "malformed-browser-keyword",
    "unsupported-browser-schema-draft",
  ])(
    "keeps canonical core MCP while degrading Browser for %s",
    async (mode) => {
      const result = await preflightRudderMcpServer({
        command: await fixtureCommand(mode),
        runtimeEnv: {},
        browserEnabled: true,
      });

      expect(result).toMatchObject({
        available: true,
        browserAvailable: false,
        diagnosticCode: "browser_bundle_tools_mismatch",
      });
      expect(() => assertRudderMcpCoreAvailable(result)).not.toThrow();
    },
  );

  it.each(["semantic-browser-required", "semantic-browser-description"])(
    "degrades Browser for legal semantic forgery %s despite matching advertised hashes",
    async (mode) => {
      const result = await preflightRudderMcpServer({
        command: await fixtureCommand(mode),
        runtimeEnv: {},
        browserEnabled: true,
      });

      expect(result).toMatchObject({
        available: true,
        browserAvailable: false,
        coreContractHash: RUDDER_CORE_MCP_CONTRACT_HASH,
        contractHash: RUDDER_BROWSER_MCP_CONTRACT_HASH,
        diagnosticCode: "browser_bundle_tools_mismatch",
      });
      expect(() => assertRudderMcpCoreAvailable(result)).not.toThrow();
    },
  );

  it("rejects a forged core name even alongside all eight Browser names and malformed schemas", async () => {
    const result = await preflightRudderMcpServer({
      command: await fixtureCommand("forged-core-malformed-schema"),
      runtimeEnv: {},
      browserEnabled: true,
    });

    expect(result).toMatchObject({
      available: false,
      browserAvailable: false,
      diagnosticCode: "browser_bundle_handshake_failed",
    });
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "rudder_forged_core",
      ...RUDDER_BROWSER_MCP_TOOL_NAMES,
    ]);
  });
});
