import { describe, expect, it } from "vitest";
import {
  ManagedExternalMcpConfigurationError,
  resolveManagedExternalMcpBindings,
} from "./managed-external-mcp.js";

const FIRST_BINDING_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_BINDING_ID = "22222222-2222-4222-8222-222222222222";

function binding(overrides: Record<string, unknown> = {}) {
  return {
    bindingId: FIRST_BINDING_ID,
    serverName: "supabase-memos",
    toolPolicy: {
      mode: "allowlist",
      allowedToolNames: ["external.supabase-memos.list_tables"],
    },
    required: true,
    startupTimeoutMs: 10_000,
    toolTimeoutMs: 60_000,
    ...overrides,
  };
}

describe("managed external MCP runtime bindings", () => {
  it("validates provider-neutral descriptors and derives stable run proxy URLs", () => {
    const resolved = resolveManagedExternalMcpBindings(
      {
        managedExternalMcpBindings: [
          binding(),
          binding({
            bindingId: SECOND_BINDING_ID,
            serverName: "linear-product",
            toolPolicy: {
              mode: "allowlist",
              allowedToolNames: ["external.linear-product.list_issues"],
            },
            required: false,
          }),
        ],
      },
      {
        RUDDER_API_URL: "https://rudder.example.test/base/",
        RUDDER_API_KEY: "run-secret-must-not-leak",
      },
    );

    expect(resolved).toEqual([
      expect.objectContaining({
        bindingId: FIRST_BINDING_ID,
        serverName: "supabase-memos",
        proxyUrl: `https://rudder.example.test/api/mcp/runtime/bindings/${FIRST_BINDING_ID}`,
        bearerTokenEnvVar: "RUDDER_API_KEY",
      }),
      expect.objectContaining({
        bindingId: SECOND_BINDING_ID,
        serverName: "linear-product",
        proxyUrl: `https://rudder.example.test/api/mcp/runtime/bindings/${SECOND_BINDING_ID}`,
        bearerTokenEnvVar: "RUDDER_API_KEY",
      }),
    ]);
    expect(JSON.stringify(resolved)).not.toContain("run-secret-must-not-leak");
  });

  it("fails closed for malformed descriptors, unknown provider data, and duplicates", () => {
    for (const managedExternalMcpBindings of [
      [binding({ provider: "supabase" })],
      [binding({ bindingId: "not-a-uuid" })],
      [binding({ serverName: "rudder-tools" })],
      [binding(), binding({ bindingId: SECOND_BINDING_ID })],
      [binding(), binding({ serverName: "linear", bindingId: FIRST_BINDING_ID })],
      [binding({ toolPolicy: { mode: "allowlist", allowedToolNames: ["same", "same"] } })],
      [binding({ toolPolicy: { mode: "allowlist", allowedToolNames: ["rudder_issue_get"] } })],
    ]) {
      expect(() => resolveManagedExternalMcpBindings(
        { managedExternalMcpBindings },
        {
          RUDDER_API_URL: "https://rudder.example.test",
          RUDDER_API_KEY: "run-token",
        },
      )).toThrow(ManagedExternalMcpConfigurationError);
    }
  });

  it("fails required bindings and omits optional bindings when runtime auth is missing", () => {
    expect(() => resolveManagedExternalMcpBindings(
      { managedExternalMcpBindings: [binding()] },
      { RUDDER_API_URL: "https://rudder.example.test" },
    )).toThrow(/required managed MCP binding/i);

    expect(resolveManagedExternalMcpBindings(
      {
        managedExternalMcpBindings: [
          binding({ required: false }),
          binding({
            bindingId: SECOND_BINDING_ID,
            serverName: "linear-product",
            required: false,
            toolPolicy: {
              mode: "allowlist",
              allowedToolNames: ["external.linear-product.list_issues"],
            },
          }),
        ],
      },
      {},
    )).toEqual([]);
  });

  it("treats an absent contract as no external bindings", () => {
    expect(resolveManagedExternalMcpBindings({}, {})).toEqual([]);
  });
});
