import { describe, expect, it } from "vitest";
import * as shared from "../index.js";

type RuntimeSchema = {
  safeParse: (value: unknown) => { success: boolean; data?: unknown };
};

function exportedSchema(name: string): RuntimeSchema | null {
  const value = (shared as unknown as Record<string, unknown>)[name];
  expect(value, `${name} must be exported from @rudderhq/shared`).toBeDefined();
  return value ? value as RuntimeSchema : null;
}

describe("managed MCP shared contracts", () => {
  it("exports the complete provider, transport, access, and lifecycle catalogs", () => {
    expect((shared as unknown as Record<string, unknown>).MCP_CONNECTION_PROVIDERS)
      .toEqual(["supabase", "linear", "notion", "custom"]);
    expect((shared as unknown as Record<string, unknown>).MCP_CONNECTION_TRANSPORTS)
      .toEqual(["stdio", "streamable_http", "legacy_manual"]);
    expect((shared as unknown as Record<string, unknown>).MCP_CONNECTION_ACCESS_MODES)
      .toEqual(["provider_default", "read_only", "read_write"]);
    expect((shared as unknown as Record<string, unknown>).MCP_CONNECTION_STATUSES)
      .toEqual([
        "draft",
        "authorizing",
        "selecting_scope",
        "active",
        "needs_reauth",
        "disabled",
        "revoked",
        "error",
      ]);
  });

  it("accepts curated HTTP and custom STDIO connection inputs with safe config only", () => {
    const schema = exportedSchema("createMcpConnectionSchema");
    if (!schema) return;

    expect(schema.safeParse({
      name: "team-supabase",
      displayName: "Team Supabase",
      provider: "supabase",
      transport: "streamable_http",
      accessMode: "read_only",
      safeConfig: {},
      connectTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
      enabled: true,
      required: false,
    }).success).toBe(true);

    expect(schema.safeParse({
      name: "local-tools",
      displayName: "Local tools",
      provider: "custom",
      transport: "stdio",
      accessMode: "provider_default",
      safeConfig: {
        command: "npx",
        args: ["-y", "@example/mcp-server"],
        cwd: "/workspace",
        env: { LOG_LEVEL: "info" },
        forwardedEnv: ["HOME"],
      },
      enabled: true,
      required: true,
    }).success).toBe(true);
  });

  it("rejects secret values and secret identifiers from safe connection config", () => {
    const schema = exportedSchema("createMcpConnectionSchema");
    if (!schema) return;

    for (const unsafeConfig of [
      { accessToken: "raw-token" },
      { clientSecret: "raw-secret" },
      { credentialSecretId: "11111111-1111-4111-8111-111111111111" },
    ]) {
      expect(schema.safeParse({
        name: "unsafe",
        displayName: "Unsafe",
        provider: "custom",
        transport: "streamable_http",
        accessMode: "provider_default",
        safeConfig: {
          url: "https://mcp.example.com",
          ...unsafeConfig,
        },
      }).success).toBe(false);
    }
  });

  it("keeps public summaries free of credential references and values", () => {
    const schema = exportedSchema("mcpConnectionSummarySchema");
    if (!schema) return;

    const safeSummary = {
      id: "11111111-1111-4111-8111-111111111111",
      orgId: "22222222-2222-4222-8222-222222222222",
      name: "notion-team",
      displayName: "Notion Team",
      provider: "notion",
      transport: "streamable_http",
      externalScope: "workspace-1",
      accessMode: "provider_default",
      status: "active",
      safeConfig: {},
      connectTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
      enabled: true,
      required: false,
      hasCredentials: true,
      lastDiscoveredAt: null,
      activatedAt: "2026-07-23T00:00:00.000Z",
      disabledAt: null,
      revokedAt: null,
      createdAt: "2026-07-23T00:00:00.000Z",
      updatedAt: "2026-07-23T00:00:00.000Z",
    };

    expect(schema.safeParse(safeSummary).success).toBe(true);
    expect(schema.safeParse({
      ...safeSummary,
      credentialSecretId: "33333333-3333-4333-8333-333333333333",
    }).success).toBe(false);
    expect(schema.safeParse({
      ...safeSummary,
      accessToken: "raw-token",
    }).success).toBe(false);
  });

  it("validates OAuth start, callback, and external scope selection without credential fields", () => {
    const startSchema = exportedSchema("mcpOAuthStartSchema");
    const callbackSchema = exportedSchema("mcpOAuthCallbackSchema");
    const selectionSchema = exportedSchema("mcpScopeSelectionSchema");
    if (!startSchema || !callbackSchema || !selectionSchema) return;

    expect(startSchema.safeParse({
      connectionId: "11111111-1111-4111-8111-111111111111",
      redirectUri: "http://127.0.0.1:3100/api/mcp/oauth/callback",
    }).success).toBe(true);
    expect(callbackSchema.safeParse({
      state: "opaque-one-time-state",
      code: "provider-code",
    }).success).toBe(true);
    expect(selectionSchema.safeParse({
      connectionId: "11111111-1111-4111-8111-111111111111",
      externalScope: "project-ref",
      accessMode: "read_only",
    }).success).toBe(true);
    expect(callbackSchema.safeParse({
      state: "opaque-one-time-state",
      code: "provider-code",
      refreshToken: "must-not-cross-the-callback-contract",
    }).success).toBe(false);
  });

  it("validates discovered tools, agent bindings, and a provider-neutral runtime binding", () => {
    const toolSchema = exportedSchema("mcpDiscoveredToolSchema");
    const bindingSchema = exportedSchema("mcpAgentBindingSchema");
    const runtimeBindingSchema = exportedSchema("managedExternalMcpBindingSchema");
    if (!toolSchema || !bindingSchema || !runtimeBindingSchema) return;

    expect(toolSchema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
      externalToolName: "search",
      rudderToolName: "external.team.search",
      description: "Search connected content",
      inputSchema: { type: "object" },
      outputSchema: null,
      enabled: true,
      removedAt: null,
    }).success).toBe(true);
    expect(bindingSchema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      status: "active",
      enabledToolIds: ["44444444-4444-4444-8444-444444444444"],
    }).success).toBe(true);

    const runtimeBinding = {
      connectionId: "22222222-2222-4222-8222-222222222222",
      serverName: "team-tools",
      proxyUrl: "http://127.0.0.1:3100/api/runtime/mcp/connection",
      authorizationEnvVar: "RUDDER_EXTERNAL_MCP_TOKEN_1",
      enabledToolNames: ["search"],
      required: false,
      connectTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
    };
    expect(runtimeBindingSchema.safeParse(runtimeBinding).success).toBe(true);
    expect(runtimeBindingSchema.safeParse({
      ...runtimeBinding,
      provider: "supabase",
      projectRef: "provider-specific-field",
      credentialSecretId: "55555555-5555-4555-8555-555555555555",
      accessToken: "raw-token",
    }).success).toBe(false);
  });
});
