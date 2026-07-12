import { applyRudderBrowserCapabilityEnv } from "@rudderhq/agent-runtime-utils";
import { describe, expect, it } from "vitest";
import { resolveRudderMcpServerConfig } from "./execute.js";

describe("Claude Browser capability", () => {
  it.each([
    { enabled: true, expected: "true", untrusted: "false" },
    { enabled: false, expected: "false", untrusted: "true" },
  ])("writes only the trusted run capability into MCP config ($expected)", async ({ enabled, expected, untrusted }) => {
    const env = { RUDDER_BROWSER_ENABLED: untrusted };
    applyRudderBrowserCapabilityEnv(env, { rudderBrowserEnabled: enabled });

    const config = await resolveRudderMcpServerConfig(env) as {
      env?: Record<string, string>;
    };

    expect(config.env?.RUDDER_BROWSER_ENABLED).toBe(expected);
  });
});
