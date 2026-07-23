import { describe, expect, it } from "vitest";
import {
  resolveManagedExternalClaudeMcpConfigs,
  resolveRudderMcpServerConfigs,
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
    serverName: "notion-docs",
    toolPolicy: {
      mode: "allowlist",
      allowedToolNames: ["external.notion-docs.search"],
    },
    required: false,
    startupTimeoutMs: 12_000,
    toolTimeoutMs: 45_000,
  },
];

describe("Claude managed external MCP config", () => {
  it("adds two independent HTTP servers without changing the first-party server", async () => {
    const env = {
      RUDDER_API_URL: "https://rudder.example.test",
      RUDDER_API_KEY: "run-secret",
    };
    const baseline = await resolveRudderMcpServerConfigs(env);
    const external = resolveManagedExternalClaudeMcpConfigs(
      { managedExternalMcpBindings: bindings },
      env,
    );
    const combined = await resolveRudderMcpServerConfigs(
      env,
      undefined,
      undefined,
      { managedExternalMcpBindings: bindings },
    );

    expect(combined["rudder-tools"]).toEqual(baseline["rudder-tools"]);
    expect(external).toEqual({
      "supabase-memos": {
        type: "http",
        url: "https://rudder.example.test/api/mcp/runtime/bindings/11111111-1111-4111-8111-111111111111",
        headers: { Authorization: "Bearer ${RUDDER_API_KEY}" },
      },
      "notion-docs": {
        type: "http",
        url: "https://rudder.example.test/api/mcp/runtime/bindings/22222222-2222-4222-8222-222222222222",
        headers: { Authorization: "Bearer ${RUDDER_API_KEY}" },
      },
    });
    expect(Object.keys(combined)).toEqual([
      "rudder-tools",
      "supabase-memos",
      "notion-docs",
    ]);
    expect(JSON.stringify(external)).not.toContain("run-secret");
    expect(JSON.stringify(combined["rudder-tools"])).not.toContain("external.");
  });

  it("enforces required/optional missing-auth behavior", () => {
    expect(() => resolveManagedExternalClaudeMcpConfigs(
      { managedExternalMcpBindings: [bindings[0]] },
      {},
    )).toThrow(/required managed MCP binding/i);
    expect(resolveManagedExternalClaudeMcpConfigs(
      { managedExternalMcpBindings: [{ ...bindings[1], required: false }] },
      {},
    )).toEqual({});
  });
});
