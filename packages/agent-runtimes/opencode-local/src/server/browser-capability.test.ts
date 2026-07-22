import { applyRudderBrowserCapabilityEnv } from "@rudderhq/agent-runtime-utils";
import { describe, expect, it } from "vitest";
import { resolveRudderOpenCodeMcpConfig } from "./execute.js";

describe("OpenCode Browser capability", () => {
  it.each([
    { enabled: true, expected: "true", untrusted: "false" },
    { enabled: false, expected: "false", untrusted: "true" },
  ])("keeps Browser capability out of the core MCP config ($expected)", async ({ enabled, expected, untrusted }) => {
    const env = { RUDDER_BROWSER_ENABLED: untrusted };
    applyRudderBrowserCapabilityEnv(env, { rudderBrowserEnabled: enabled });

    const config = await resolveRudderOpenCodeMcpConfig(env) as {
      environment?: Record<string, string>;
    };

    expect(config.environment?.RUDDER_BROWSER_ENABLED).toBeUndefined();
  });

  it("builds separate managed server configs only when Browser is enabled", async () => {
    const module = await import("./execute.js") as typeof import("./execute.js") & {
      resolveRudderOpenCodeMcpConfigs?: (env: Record<string, string>) => Promise<Record<string, unknown>>;
    };
    expect(module.resolveRudderOpenCodeMcpConfigs).toBeTypeOf("function");
    if (!module.resolveRudderOpenCodeMcpConfigs) return;

    await expect(module.resolveRudderOpenCodeMcpConfigs({ RUDDER_BROWSER_ENABLED: "false" }))
      .resolves.toMatchObject({ "rudder-tools": {} });
    const enabled = await module.resolveRudderOpenCodeMcpConfigs({ RUDDER_BROWSER_ENABLED: "true" });
    expect(enabled).toMatchObject({ "rudder-tools": {}, "rudder-browser": {} });
  });
});
