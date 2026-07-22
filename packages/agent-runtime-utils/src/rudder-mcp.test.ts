import { describe, expect, it } from "vitest";
import {
  RUDDER_BROWSER_MCP_CONTRACT_HASH,
  RUDDER_CORE_MCP_CONTRACT_HASH,
  RUDDER_MCP_CONTRACT_VERSION,
  RUDDER_MCP_MANAGED_ENV_KEYS,
  RUDDER_MCP_TOOL_COUNT,
  applyRudderBrowserCapabilityEnv,
  filterRudderMcpToolsForBrowserCapability,
  rudderMcpRuntimeMetadata,
} from "./rudder-mcp.js";

describe("Rudder MCP Browser capability", () => {
  it("adds provenance and contract diagnostics only after a real preflight", () => {
    expect(rudderMcpRuntimeMetadata({ browserEnabled: false })).toEqual({
      available: true,
      serverName: "rudder-tools",
      toolCount: RUDDER_MCP_TOOL_COUNT,
      fallbackReason: null,
    });

    expect(rudderMcpRuntimeMetadata({
      browserEnabled: true,
      preflight: {
        available: true,
        browserAvailable: true,
        provenance: "repo",
        version: "0.4.6",
        contractVersion: RUDDER_MCP_CONTRACT_VERSION,
        coreContractHash: RUDDER_CORE_MCP_CONTRACT_HASH,
        contractHash: RUDDER_BROWSER_MCP_CONTRACT_HASH,
        diagnosticCode: null,
        diagnostic: null,
        tools: [],
      },
    })).toMatchObject({
      browserAvailable: true,
      coreContractHash: RUDDER_CORE_MCP_CONTRACT_HASH,
      contractHash: RUDDER_BROWSER_MCP_CONTRACT_HASH,
      provenance: "repo",
      toolCount: RUDDER_MCP_TOOL_COUNT,
      version: "0.4.6",
    });
  });

  it("derives the enabled capability only from the trusted boolean run config", async () => {
    const env = { RUDDER_BROWSER_ENABLED: "false" };

    const enabled = applyRudderBrowserCapabilityEnv(env, {
      rudderBrowserEnabled: true,
    });

    expect(enabled).toBe(true);
    expect(env.RUDDER_BROWSER_ENABLED).toBe("true");
    expect(RUDDER_MCP_MANAGED_ENV_KEYS).toContain("RUDDER_BROWSER_ENABLED");
    expect(rudderMcpRuntimeMetadata({ browserEnabled: enabled }).toolCount).toBe(RUDDER_MCP_TOOL_COUNT);
    const module = await import("./rudder-mcp.js") as typeof import("./rudder-mcp.js") & {
      rudderBrowserMcpRuntimeMetadata?: () => { toolCount: number; serverName: string };
    };
    expect(module.rudderBrowserMcpRuntimeMetadata).toBeTypeOf("function");
    if (!module.rudderBrowserMcpRuntimeMetadata) return;
    expect(module.rudderBrowserMcpRuntimeMetadata().toolCount).toBe(8);
    expect(module.rudderBrowserMcpRuntimeMetadata().serverName).toBe("rudder-browser");
  });

  it.each([
    {},
    { rudderBrowserEnabled: false },
    { rudderBrowserEnabled: "true" },
    { rudderBrowserEnabled: 1 },
  ])("overwrites an untrusted enabled environment when config is %j", (config) => {
    const env = { RUDDER_BROWSER_ENABLED: "true" };

    const enabled = applyRudderBrowserCapabilityEnv(env, config);

    expect(enabled).toBe(false);
    expect(env.RUDDER_BROWSER_ENABLED).toBe("false");
    expect(rudderMcpRuntimeMetadata({ browserEnabled: enabled }).toolCount).toBe(
      RUDDER_MCP_TOOL_COUNT,
    );
  });

  it("filters Browser tools from fallback manifests when the capability is disabled", () => {
    const tools = [
      { name: "rudder_issue_get" },
      { name: "rudder_browser_open" },
      { name: "rudder_browser_close" },
      { name: " rudder_browser_read " },
      { name: "rudder_unknown_tool" },
    ];

    expect(filterRudderMcpToolsForBrowserCapability(tools, false)).toEqual([
      { name: "rudder_issue_get" },
    ]);
    expect(filterRudderMcpToolsForBrowserCapability(tools, true)).toEqual([
      { name: "rudder_issue_get" },
      { name: "rudder_browser_open" },
      { name: "rudder_browser_close" },
    ]);
  });
});
