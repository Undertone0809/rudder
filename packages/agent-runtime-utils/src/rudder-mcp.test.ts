import { describe, expect, it } from "vitest";
import {
  RUDDER_MCP_MANAGED_ENV_KEYS,
  RUDDER_MCP_TOOL_COUNT,
  applyRudderBrowserCapabilityEnv,
  filterRudderMcpToolsForBrowserCapability,
  rudderMcpRuntimeMetadata,
} from "./rudder-mcp.js";

describe("Rudder MCP Browser capability", () => {
  it("derives the enabled capability only from the trusted boolean run config", () => {
    const env = { RUDDER_BROWSER_ENABLED: "false" };

    const enabled = applyRudderBrowserCapabilityEnv(env, {
      rudderBrowserEnabled: true,
    });

    expect(enabled).toBe(true);
    expect(env.RUDDER_BROWSER_ENABLED).toBe("true");
    expect(RUDDER_MCP_MANAGED_ENV_KEYS).toContain("RUDDER_BROWSER_ENABLED");
    expect(rudderMcpRuntimeMetadata({ browserEnabled: enabled }).toolCount).toBe(
      RUDDER_MCP_TOOL_COUNT + 8,
    );
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
    ];

    expect(filterRudderMcpToolsForBrowserCapability(tools, false)).toEqual([
      { name: "rudder_issue_get" },
    ]);
    expect(filterRudderMcpToolsForBrowserCapability(tools, true)).toEqual(tools);
  });
});
