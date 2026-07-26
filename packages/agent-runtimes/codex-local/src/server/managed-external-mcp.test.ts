import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  realizeManagedCodexSkillEntries,
  renderManagedExternalMcpCodexConfig,
} from "./codex-home.js";

const bindings = [
  {
    bindingId: "11111111-1111-4111-8111-111111111111",
    serverName: "supabase-memos",
    accessMode: "read_only",
    toolPolicy: {
      mode: "allowlist",
      allowedToolNames: ["external.supabase-memos.list_tables"],
    },
    required: true,
    startupTimeoutMs: 10_000,
    toolTimeoutMs: 60_000,
  },
  {
    bindingId: "22222222-2222-4222-8222-222222222222",
    serverName: "linear-product",
    accessMode: "read_write",
    toolPolicy: {
      mode: "allowlist",
      allowedToolNames: ["external.linear-product.list_issues"],
    },
    required: false,
    startupTimeoutMs: 15_000,
    toolTimeoutMs: 45_000,
  },
];

describe("Codex managed external MCP config", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })));
  });

  it("renders two independent Streamable HTTP servers with env-based run auth", () => {
    const config = renderManagedExternalMcpCodexConfig(
      { managedExternalMcpBindings: bindings },
      {
        RUDDER_API_URL: "https://rudder.example.test",
        RUDDER_API_KEY: "run-secret",
      },
    );

    expect(config).toContain("[mcp_servers.supabase-memos]");
    expect(config).toContain("[mcp_servers.linear-product]");
    expect(config).toContain(
      'url = "https://rudder.example.test/api/mcp/runtime/bindings/11111111-1111-4111-8111-111111111111"',
    );
    expect(config).toContain(
      'url = "https://rudder.example.test/api/mcp/runtime/bindings/22222222-2222-4222-8222-222222222222"',
    );
    expect(config.match(/bearer_token_env_var = "RUDDER_API_KEY"/g)).toHaveLength(2);
    expect(config).not.toContain("required = true");
    expect(config.match(/required = false/g)).toHaveLength(2);
    expect(config.match(/startup_timeout_sec = 3/g)).toHaveLength(2);
    expect(config).toContain("tool_timeout_sec = 60");
    expect(config).toContain(
      'enabled_tools = ["external.supabase-memos.list_tables"]',
    );
    expect(config).not.toContain("run-secret");
    expect(config).not.toContain("[mcp_servers.rudder-tools.env]");
  });

  it("keeps the rudder-tools table byte-identical when external servers are added", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-codex-external-mcp-"));
    tempRoots.push(root);
    const env = {
      CODEX_HOME: path.join(root, "operator"),
      RUDDER_API_URL: "https://rudder.example.test",
      RUDDER_API_KEY: "run-secret",
    };
    const command = {
      command: "node",
      args: ["rudder-mcp.js"],
      env: { RUDDER_MCP_RUDDER_BIN: "/safe/rudder" },
      provenance: "repo" as const,
    };
    const readCoreTable = (config: string) =>
      config.match(/\[mcp_servers\.rudder-tools\][\s\S]*?(?=\n\[mcp_servers\.|$)/)?.[0];

    const baselineHome = path.join(root, "baseline");
    await realizeManagedCodexSkillEntries(
      env,
      baselineHome,
      [],
      async () => {},
      { disabledSkillPaths: [] },
      root,
      env,
      command,
    );
    const externalHome = path.join(root, "external");
    await realizeManagedCodexSkillEntries(
      env,
      externalHome,
      [],
      async () => {},
      { disabledSkillPaths: [] },
      root,
      env,
      command,
      undefined,
      { managedExternalMcpBindings: bindings },
    );
    const baseline = await readFile(path.join(baselineHome, "config.toml"), "utf8");
    const external = await readFile(path.join(externalHome, "config.toml"), "utf8");

    expect(readCoreTable(external)).toBe(readCoreTable(baseline));
    expect(external).toContain("[mcp_servers.supabase-memos]");
    expect(external).toContain("[mcp_servers.linear-product]");
    expect(external).not.toContain("required = true");
    expect(external.match(/required = false/g)).toHaveLength(2);
    expect(readCoreTable(external)).not.toContain("external.");
  });

  it("omits managed MCP setup without run auth regardless of required metadata", () => {
    expect(renderManagedExternalMcpCodexConfig(
      { managedExternalMcpBindings: [bindings[0]] },
      { RUDDER_API_URL: "https://rudder.example.test" },
    )).toBe("");

    expect(renderManagedExternalMcpCodexConfig(
      { managedExternalMcpBindings: [{ ...bindings[1], required: false }] },
      {},
    )).toBe("");
  });

  it("omits the first-party MCP table after a failed core preflight", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-codex-core-mcp-"));
    tempRoots.push(root);
    const home = path.join(root, "managed");
    await realizeManagedCodexSkillEntries(
      { CODEX_HOME: path.join(root, "operator") },
      home,
      [],
      async () => {},
      { disabledSkillPaths: [] },
      root,
      {},
      undefined,
      undefined,
      {},
      false,
    );

    const config = await readFile(path.join(home, "config.toml"), "utf8");
    expect(config).not.toContain("[mcp_servers.rudder-tools]");
  });
});
