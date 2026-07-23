import { describe, expect, it } from "vitest";
import {
  resolveManagedExternalOpenCodeMcpConfigs,
  resolveRudderOpenCodeMcpConfigs,
} from "./execute.js";

const bindings = [
  {
    bindingId: "11111111-1111-4111-8111-111111111111",
    serverName: "supabase-memos",
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
    toolPolicy: {
      mode: "allowlist",
      allowedToolNames: ["external.linear-product.list_issues"],
    },
    required: false,
    startupTimeoutMs: 12_000,
    toolTimeoutMs: 45_000,
  },
];

describe("OpenCode managed external MCP config", () => {
  it("adds two remote servers without changing the first-party server", async () => {
    const env = {
      RUDDER_API_URL: "https://rudder.example.test",
      RUDDER_API_KEY: "run-secret",
    };
    const baseline = await resolveRudderOpenCodeMcpConfigs(env);
    const external = resolveManagedExternalOpenCodeMcpConfigs(
      { managedExternalMcpBindings: bindings },
      env,
    );
    const combined = await resolveRudderOpenCodeMcpConfigs(
      env,
      undefined,
      undefined,
      { managedExternalMcpBindings: bindings },
    );

    expect(combined["rudder-tools"]).toEqual(baseline["rudder-tools"]);
    expect(external).toEqual({
      "supabase-memos": {
        type: "remote",
        url: "https://rudder.example.test/api/mcp/runtime/bindings/11111111-1111-4111-8111-111111111111",
        enabled: true,
        oauth: false,
        headers: { Authorization: "Bearer {env:RUDDER_API_KEY}" },
        timeout: 60_000,
      },
      "linear-product": {
        type: "remote",
        url: "https://rudder.example.test/api/mcp/runtime/bindings/22222222-2222-4222-8222-222222222222",
        enabled: true,
        oauth: false,
        headers: { Authorization: "Bearer {env:RUDDER_API_KEY}" },
        timeout: 45_000,
      },
    });
    expect(Object.keys(combined)).toEqual([
      "rudder-tools",
      "supabase-memos",
      "linear-product",
    ]);
    expect(JSON.stringify(external)).not.toContain("run-secret");
    expect(JSON.stringify(combined["rudder-tools"])).not.toContain("external.");
  });

  it("enforces required/optional missing-auth behavior", () => {
    expect(() => resolveManagedExternalOpenCodeMcpConfigs(
      { managedExternalMcpBindings: [bindings[0]] },
      {},
    )).toThrow(/required managed MCP binding/i);
    expect(resolveManagedExternalOpenCodeMcpConfigs(
      { managedExternalMcpBindings: [{ ...bindings[1], required: false }] },
      {},
    )).toEqual({});
  });
});
