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
      .toEqual(["supabase", "linear", "notion", "github", "custom"]);
    expect((shared as unknown as Record<string, unknown>).MCP_CONNECTION_TRANSPORTS)
      .toEqual(["stdio", "streamable_http", "legacy_manual"]);
    expect((shared as unknown as Record<string, unknown>).MCP_CONNECTION_ACCESS_MODES)
      .toEqual(["provider_default", "read_only", "read_write"]);
    expect((shared as unknown as Record<string, unknown>).MCP_AGENT_ACCESS_MODES)
      .toEqual(["none", "read_only", "read_write", "provider_granted", "full"]);
    expect((shared as unknown as Record<string, unknown>).MCP_CONNECTION_CANONICAL_STATES)
      .toEqual(["canonical", "superseded"]);
    expect((shared as unknown as Record<string, unknown>).MCP_PROVIDER_SCOPE_MODES)
      .toEqual(["account", "workspace", "legacy_project"]);
    expect((shared as unknown as Record<string, unknown>).MCP_PROVIDER_CREDENTIAL_MODES)
      .toEqual(["oauth", "pat", "custom"]);
    expect((shared as unknown as Record<string, unknown>).MCP_PROVIDER_ORGANIZATION_STATES)
      .toEqual(["not_connected", "connecting", "connected", "needs_attention", "disconnected"]);
    expect((shared as unknown as Record<string, unknown>).MCP_TOOL_CAPABILITY_CLASSES)
      .toEqual(["read", "normal_write", "destructive", "admin_or_billing", "unknown"]);
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
    expect((shared as unknown as {
      MCP_PROVIDER_CATALOG: Array<{ id: string; accessModes: string[] }>;
    }).MCP_PROVIDER_CATALOG).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "supabase",
        accessModes: ["read_only", "read_write"],
        defaultAccessMode: "read_write",
      }),
      expect.objectContaining({
        id: "linear",
        accessModes: ["read_only", "read_write"],
        defaultAccessMode: "read_write",
      }),
      expect.objectContaining({
        id: "notion",
        accessModes: ["provider_default"],
        defaultAccessMode: "provider_default",
      }),
      expect.objectContaining({
        id: "github",
        credentialMode: "pat",
        accessModes: ["read_only", "read_write"],
        defaultAccessMode: "read_only",
      }),
      expect.objectContaining({
        id: "custom",
        transports: ["stdio", "streamable_http"],
      }),
    ]));
  });

  it("accepts curated HTTP and custom STDIO connection inputs with safe config only", () => {
    const schema = exportedSchema("createMcpConnectionSchema");
    if (!schema) return;

    expect(schema.safeParse({
      name: "team-supabase",
      displayName: "Team Supabase",
      provider: "supabase",
      scope: "organization",
      transport: "streamable_http",
      accessMode: "read_only",
      safeConfig: {},
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
      enabled: true,
      required: false,
    }).success).toBe(true);

    expect(schema.safeParse({
      name: "local-tools",
      displayName: "Local tools",
      provider: "custom",
      scope: "organization",
      transport: "stdio",
      accessMode: "provider_default",
      safeConfig: {
        command: "npx",
        args: ["-y", "@example/mcp-server"],
        cwd: "/workspace",
        staticEnv: { LOG_LEVEL: "info" },
        forwardedEnv: ["HOME"],
        secretEnvNames: ["API_TOKEN"],
      },
      secrets: {
        env: { API_TOKEN: "mutation-only-secret" },
      },
      enabled: true,
      required: true,
    }).success).toBe(true);
  });

  it("accepts GitHub PAT connections while keeping endpoint and credentials managed", () => {
    const schema = exportedSchema("createMcpConnectionSchema");
    if (!schema) return;

    const base = {
      name: "github-account",
      displayName: "GitHub account",
      provider: "github",
      scope: "organization",
      transport: "streamable_http",
      safeConfig: {
        endpoint: "https://api.githubcopilot.com/mcp/",
        scopeMode: "account",
      },
      secrets: { bearerToken: `github_pat_${"a".repeat(30)}` },
    };

    expect(schema.safeParse(base).success).toBe(true);
    const defaultAccess = schema.safeParse(base);
    if (defaultAccess.success) {
      expect((defaultAccess.data as { accessMode?: string }).accessMode).toBe("read_only");
    }
    expect(schema.safeParse({ ...base, accessMode: "read_write" }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      safeConfig: { endpoint: "https://github.com/mcp", scopeMode: "account" },
    }).success).toBe(false);
    expect(schema.safeParse({
      ...base,
      secrets: { bearerToken: "not-a-github-pat" },
    }).success).toBe(false);
    expect(schema.safeParse({
      ...base,
      secrets: { headers: { Authorization: "Bearer raw-token" } },
    }).success).toBe(false);
  });

  it("rejects internal runtime server names when creating external MCP connections", () => {
    const schema = exportedSchema("createMcpConnectionSchema");
    if (!schema) return;

    for (const name of ["rudder-tools", "rudder-browser"]) {
      expect(schema.safeParse({
        name,
        displayName: "Reserved runtime name",
        provider: "custom",
        transport: "streamable_http",
        accessMode: "provider_default",
        safeConfig: { url: "https://mcp.example.com" },
      }).success).toBe(false);
    }
  });

  it("keeps secret mutation fields out of safe connection config", () => {
    const schema = exportedSchema("createMcpConnectionSchema");
    if (!schema) return;

    for (const unsafeConfig of [
      { accessToken: "raw-token" },
      { clientSecret: "raw-secret" },
      { credentialSecretId: "11111111-1111-4111-8111-111111111111" },
      { secrets: { bearerToken: "raw-token" } },
      { secretValues: { API_TOKEN: "raw-token" } },
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

  it("separates static HTTP config, environment mappings, and mutation-only secrets", () => {
    const schema = exportedSchema("createMcpConnectionSchema");
    if (!schema) return;

    const parsed = schema.safeParse({
      name: "custom-http",
      displayName: "Custom HTTP",
      provider: "custom",
      scope: "organization",
      transport: "streamable_http",
      accessMode: "provider_default",
      safeConfig: {
        url: "https://mcp.example.com",
        staticHeaders: { Accept: "application/json" },
        headersFromEnv: { "X-Api-Key": "MCP_API_KEY" },
        secretHeaderNames: ["X-Tenant-Token"],
      },
      secrets: {
        headers: { "X-Tenant-Token": "encrypted-header-secret" },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts bounded exact-name tool allowlists and denylists for custom MCPs", () => {
    const schema = exportedSchema("createMcpConnectionSchema");
    if (!schema) return;

    const base = {
      name: "filtered-tools",
      displayName: "Filtered tools",
      provider: "custom",
      scope: "organization",
      transport: "streamable_http",
      accessMode: "provider_default",
    };
    expect(schema.safeParse({
      ...base,
      safeConfig: {
        url: "https://mcp.example.com",
        toolAllowlist: ["read_rows", "search.docs"],
        toolDenylist: ["delete_rows"],
      },
    }).success).toBe(true);
    expect(schema.safeParse({
      ...base,
      safeConfig: {
        url: "https://mcp.example.com",
        toolAllowlist: ["read rows"],
      },
    }).success).toBe(false);
  });

  it("accepts exactly one manual Authorization or Bearer source and rejects every pair", () => {
    const schema = exportedSchema("createMcpConnectionSchema");
    if (!schema) return;

    const base = {
      name: "conflicting-auth",
      displayName: "Conflicting auth",
      provider: "custom",
      scope: "organization",
      transport: "streamable_http",
      accessMode: "provider_default",
    };
    const sources = [
      {
        safeConfig: { headersFromEnv: { Authorization: "MCP_AUTHORIZATION" } },
      },
      {
        safeConfig: { secretHeaderNames: ["Authorization"] },
        secrets: { headers: { Authorization: "Bearer encrypted-header-token" } },
      },
      {
        safeConfig: { bearerTokenEnvVar: "MCP_BEARER_TOKEN" },
      },
      {
        safeConfig: { hasBearerToken: true },
        secrets: { bearerToken: "direct-bearer-token" },
      },
    ];

    for (const source of sources) {
      expect(schema.safeParse({
        ...base,
        safeConfig: { url: "https://mcp.example.com", ...source.safeConfig },
        ...("secrets" in source ? { secrets: source.secrets } : {}),
      }).success).toBe(true);
    }

    for (let first = 0; first < sources.length; first += 1) {
      for (let second = first + 1; second < sources.length; second += 1) {
        const firstSource = sources[first]!;
        const secondSource = sources[second]!;
        const headers = {
          ...firstSource.secrets?.headers,
          ...secondSource.secrets?.headers,
        };
        const bearerToken = (
          firstSource.secrets?.bearerToken
          ?? secondSource.secrets?.bearerToken
        );
        const secrets = Object.keys(headers).length > 0 || bearerToken
          ? { headers, bearerToken }
          : undefined;
        expect(schema.safeParse({
          ...base,
          safeConfig: {
            url: "https://mcp.example.com",
            ...firstSource.safeConfig,
            ...secondSource.safeConfig,
          },
          ...(secrets ? { secrets } : {}),
        }).success).toBe(false);
      }
    }
  });

  it("requires mutation secrets to exactly match their safe declarations", () => {
    const schema = exportedSchema("createMcpConnectionSchema");
    if (!schema) return;

    const base = {
      name: "secret-shape",
      displayName: "Secret shape",
      provider: "custom",
      transport: "streamable_http",
      accessMode: "provider_default",
    };
    for (const input of [
      {
        safeConfig: { url: "https://mcp.example.com" },
        secrets: { env: { MCP_API_KEY: "HTTP-env-secrets-are-not-accepted" } },
      },
      {
        safeConfig: {
          url: "https://mcp.example.com",
          secretHeaderNames: ["X-Api-Key"],
        },
      },
      {
        safeConfig: { url: "https://mcp.example.com" },
        secrets: { headers: { "X-Api-Key": "undeclared-secret" } },
      },
      {
        safeConfig: {
          url: "https://mcp.example.com",
          hasBearerToken: true,
        },
      },
      {
        safeConfig: { url: "https://mcp.example.com" },
        secrets: { bearerToken: "undeclared-direct-bearer" },
      },
    ]) {
      expect(schema.safeParse({ ...base, ...input }).success).toBe(false);
    }
  });

  it("validates persisted secret declarations without requiring plaintext again", () => {
    const mergedConfigSchema = exportedSchema("mcpConnectionMergedConfigSchema");
    const mutationConfigSchema = exportedSchema("mcpConnectionMutationConfigSchema");
    if (!mergedConfigSchema || !mutationConfigSchema) return;

    const persistedStdio = {
      provider: "custom",
      transport: "stdio",
      accessMode: "provider_default",
      safeConfig: {
        command: "node",
        secretEnvNames: ["API_TOKEN"],
      },
      enabled: true,
    };
    const persistedHttp = {
      provider: "custom",
      transport: "streamable_http",
      accessMode: "provider_default",
      safeConfig: {
        url: "https://mcp.example.com",
        secretHeaderNames: ["X-Api-Key"],
        hasBearerToken: true,
      },
      enabled: true,
    };

    expect(mergedConfigSchema.safeParse(persistedStdio).success).toBe(true);
    expect(mergedConfigSchema.safeParse(persistedHttp).success).toBe(true);

    expect(mutationConfigSchema.safeParse(persistedStdio).success).toBe(false);
    expect(mutationConfigSchema.safeParse({
      ...persistedStdio,
      secrets: { env: { API_TOKEN: "rotated-secret" } },
    }).success).toBe(true);
    expect(mutationConfigSchema.safeParse(persistedHttp).success).toBe(false);
    expect(mutationConfigSchema.safeParse({
      ...persistedHttp,
      secrets: {
        headers: { "X-Api-Key": "rotated-header-secret" },
        bearerToken: "rotated-bearer-secret",
      },
    }).success).toBe(true);
  });

  it("rejects sensitive names when their values remain in static safe config", () => {
    const schema = exportedSchema("createMcpConnectionSchema");
    if (!schema) return;

    expect(schema.safeParse({
      name: "unsafe-stdio",
      displayName: "Unsafe STDIO",
      provider: "custom",
      transport: "stdio",
      accessMode: "provider_default",
      safeConfig: {
        command: "node",
        staticEnv: { API_TOKEN: "must-not-remain" },
        secretEnvNames: ["API_TOKEN"],
      },
    }).success).toBe(false);

    expect(schema.safeParse({
      name: "unsafe-http",
      displayName: "Unsafe HTTP",
      provider: "custom",
      transport: "streamable_http",
      accessMode: "provider_default",
      safeConfig: {
        url: "https://mcp.example.com",
        staticHeaders: { Authorization: "Bearer raw-secret" },
      },
    }).success).toBe(false);
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
      scope: "organization",
      ownerAgentId: null,
      transport: "streamable_http",
      externalScope: "workspace-1",
      accessMode: "provider_default",
      status: "active",
      safeConfig: {},
      startupTimeoutMs: 10_000,
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
    expect(schema.safeParse({
      ...safeSummary,
      secrets: { bearerToken: "raw-token" },
    }).success).toBe(false);
  });

  it("enforces the curated provider access and configuration matrix", () => {
    const createSchema = exportedSchema("createMcpConnectionSchema");
    const updateSchema = exportedSchema("updateMcpConnectionSchema");
    const mergedConfigSchema = exportedSchema("mcpConnectionMergedConfigSchema");
    if (!createSchema || !updateSchema || !mergedConfigSchema) return;

    const supabaseBase = {
      name: "supabase-team",
      displayName: "Supabase Team",
      provider: "supabase",
      scope: "organization",
      transport: "streamable_http",
      safeConfig: {},
    };
    const supabaseDefault = createSchema.safeParse(supabaseBase);
    expect(supabaseDefault.success).toBe(true);
    if (supabaseDefault.success) {
      expect((supabaseDefault.data as { accessMode?: string }).accessMode).toBe("read_write");
    }
    expect(createSchema.safeParse({ ...supabaseBase, accessMode: "read_write" }).success).toBe(true);
    expect(createSchema.safeParse({ ...supabaseBase, accessMode: "provider_default" }).success).toBe(false);

    const linearBase = {
      name: "linear-team",
      displayName: "Linear Team",
      provider: "linear",
      scope: "organization",
      transport: "streamable_http",
      safeConfig: {},
    };
    expect(createSchema.safeParse({ ...linearBase, accessMode: "read_only" }).success).toBe(true);
    expect(createSchema.safeParse({ ...linearBase, accessMode: "read_write" }).success).toBe(true);
    expect(createSchema.safeParse({ ...linearBase, accessMode: "provider_default" }).success).toBe(false);
    const linearDefault = createSchema.safeParse(linearBase);
    expect(linearDefault.success).toBe(true);
    if (linearDefault.success) {
      expect((linearDefault.data as { accessMode?: string }).accessMode).toBe("read_write");
    }

    const notionBase = {
      name: "notion-team",
      displayName: "Notion Team",
      provider: "notion",
      scope: "organization",
      transport: "streamable_http",
      safeConfig: {},
    };
    expect(createSchema.safeParse({ ...notionBase, accessMode: "provider_default" }).success).toBe(true);
    expect(createSchema.safeParse({ ...notionBase, accessMode: "read_only" }).success).toBe(false);
    expect(createSchema.safeParse({ ...notionBase, accessMode: "read_write" }).success).toBe(false);
    expect(createSchema.safeParse({
      ...supabaseBase,
      scope: undefined,
    }).success).toBe(false);

    for (const override of [
      { safeConfig: { url: "https://override.example.com" } },
      { safeConfig: { staticHeaders: { Accept: "application/json" } } },
      { transport: "stdio", safeConfig: { command: "node" } },
      { transport: "legacy_manual", enabled: false, safeConfig: { legacyConfigRetained: true } },
      { secrets: { bearerToken: "curated-secret-override" } },
    ]) {
      expect(createSchema.safeParse({
        ...supabaseBase,
        accessMode: "read_only",
        ...override,
      }).success).toBe(false);
    }

    expect(updateSchema.safeParse({
      accessMode: "read_write",
    }).success).toBe(true);
    expect(updateSchema.safeParse({
      provider: "supabase",
      transport: "streamable_http",
      accessMode: "read_write",
    }).success).toBe(false);

    expect(mergedConfigSchema.safeParse({
      provider: "supabase",
      transport: "streamable_http",
      accessMode: "read_write",
      safeConfig: {},
      enabled: true,
    }).success).toBe(true);
    expect(mergedConfigSchema.safeParse({
      provider: "supabase",
      transport: "streamable_http",
      accessMode: "read_write",
      safeConfig: {
        featureGroups: {
          mode: "provider_default",
          excluded: ["storage"],
        },
      },
      enabled: true,
    }).success).toBe(true);
    expect(mergedConfigSchema.safeParse({
      provider: "supabase",
      transport: "streamable_http",
      accessMode: "provider_default",
      safeConfig: {},
      enabled: true,
    }).success).toBe(false);
    expect(mergedConfigSchema.safeParse({
      provider: "notion",
      transport: "streamable_http",
      accessMode: "read_only",
      safeConfig: {},
      enabled: true,
    }).success).toBe(false);
    expect(mergedConfigSchema.safeParse({
      provider: "linear",
      transport: "streamable_http",
      accessMode: "read_only",
      safeConfig: { url: "https://override.example.com" },
      enabled: true,
    }).success).toBe(false);
  });

  it("validates OAuth start, callback, and external scope selection without credential fields", () => {
    const startSchema = exportedSchema("mcpOAuthStartSchema");
    const callbackSchema = exportedSchema("mcpOAuthCallbackSchema");
    const selectionSchema = exportedSchema("mcpScopeSelectionSchema");
    if (!startSchema || !callbackSchema || !selectionSchema) return;

    expect(startSchema.safeParse({}).success).toBe(true);
    expect(startSchema.safeParse({
      connectionId: "11111111-1111-4111-8111-111111111111",
    }).success).toBe(false);
    expect(startSchema.safeParse({
      redirectUri: "https://attacker.example/oauth/callback",
    }).success).toBe(false);
    expect(callbackSchema.safeParse({
      state: "opaque-one-time-state",
      code: "provider-code",
      iss: "https://oauth.example.com",
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
    expect(callbackSchema.safeParse({
      state: "opaque-one-time-state",
      error: "access_denied",
      errorDescription: "must-not-be-reflected",
      iss: "https://oauth.example.com",
    }).success).toBe(true);
    expect(callbackSchema.safeParse({
      state: "opaque-one-time-state",
      code: "provider-code",
      error: "access_denied",
    }).success).toBe(false);
    expect(callbackSchema.safeParse({
      state: "opaque-one-time-state",
    }).success).toBe(false);
  });

  it("accepts persisted curated feature-group config without allowing it in create input", () => {
    const safeConfigSchema = exportedSchema("mcpConnectionSafeConfigSchema");
    const createSchema = exportedSchema("createMcpConnectionSchema");
    if (!safeConfigSchema || !createSchema) return;
    const safeConfig = {
      featureGroups: {
        mode: "provider_default",
        excluded: ["storage"],
      },
    };

    expect(safeConfigSchema.safeParse(safeConfig).success).toBe(true);
    expect(createSchema.safeParse({
      name: "supabase-main",
      displayName: "Supabase",
      provider: "supabase",
      transport: "streamable_http",
      safeConfig,
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
      capabilityClass: "read",
      policyRevision: 1,
      catalogRevision: 1,
      enabled: true,
      removedAt: null,
    }).success).toBe(true);
    expect(bindingSchema.safeParse({
      id: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      status: "active",
      accessMode: "read_only",
      policyRevision: 1,
      enabledToolIds: ["44444444-4444-4444-8444-444444444444"],
    }).success).toBe(true);

    const runtimeBinding = {
      bindingId: "22222222-2222-4222-8222-222222222222",
      serverName: "team-tools",
      accessMode: "read_only",
      toolPolicy: {
        mode: "allowlist",
        allowedToolNames: ["search"],
      },
      required: false,
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 60_000,
    };
    expect(runtimeBindingSchema.safeParse(runtimeBinding).success).toBe(true);
    expect(runtimeBindingSchema.safeParse({
      ...runtimeBinding,
      provider: "supabase",
      projectRef: "provider-specific-field",
      connectionId: "22222222-2222-4222-8222-222222222222",
      proxyUrl: "http://127.0.0.1:3100/api/runtime/mcp/connection",
      authorizationEnvVar: "RUDDER_EXTERNAL_MCP_TOKEN_1",
      credentialSecretId: "55555555-5555-4555-8555-555555555555",
      accessToken: "raw-token",
    }).success).toBe(false);
  });

  it("accepts an empty first-bind request and validates agent connection summaries", () => {
    const upsertSchema = exportedSchema("upsertMcpAgentBindingSchema");
    const summarySchema = exportedSchema("mcpAgentConnectionSummarySchema");
    if (!upsertSchema || !summarySchema) return;

    expect(upsertSchema.safeParse({}).success).toBe(true);
    expect(upsertSchema.safeParse({
      status: "disabled",
      accessMode: "none",
      expectedRevision: 3,
      enabledToolIds: ["44444444-4444-4444-8444-444444444444"],
    }).success).toBe(true);
    expect(upsertSchema.safeParse({
      enabledToolIds: ["not-a-uuid"],
    }).success).toBe(false);

    expect(summarySchema.safeParse({
      connection: {
        id: "22222222-2222-4222-8222-222222222222",
        orgId: "11111111-1111-4111-8111-111111111111",
        name: "team-tools",
        displayName: "Team tools",
        provider: "custom",
        scope: "organization",
        ownerAgentId: null,
        transport: "streamable_http",
        externalScope: null,
        accessMode: "provider_default",
        status: "active",
        safeConfig: { url: "https://mcp.example.com/mcp" },
        startupTimeoutMs: 10_000,
        toolTimeoutMs: 60_000,
        enabled: true,
        required: false,
        hasCredentials: false,
        lastDiscoveredAt: null,
        activatedAt: null,
        disabledAt: null,
        revokedAt: null,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
      },
      binding: null,
      tools: [],
      reviewRequired: false,
    }).success).toBe(true);
  });

  it("validates provider availability without mixing organization lifecycle and agent access", () => {
    const availabilitySchema = exportedSchema("mcpProviderAvailabilitySchema");
    if (!availabilitySchema) return;

    expect(availabilitySchema.safeParse({
      provider: "supabase",
      organization: {
        state: "connected",
        connectionId: "22222222-2222-4222-8222-222222222222",
        maxAccess: "read_write",
        scopeMode: "account",
        revision: 4,
        historicalGrantConnectionIds: [
          "33333333-3333-4333-8333-333333333333",
        ],
      },
      agent: {
        access: "read_only",
        activeRunUsesOlderPolicy: false,
      },
    }).success).toBe(true);

    expect(availabilitySchema.safeParse({
      provider: "supabase",
      organization: {
        state: "connected",
        connectionId: "22222222-2222-4222-8222-222222222222",
        maxAccess: "read_write",
        scopeMode: "account",
        revision: 4,
        historicalGrantConnectionIds: ["not-a-uuid"],
      },
    }).success).toBe(false);

    expect(availabilitySchema.safeParse({
      provider: "supabase",
      organization: {
        state: "connected",
        connectionId: null,
        maxAccess: "read_write",
        scopeMode: "account",
        revision: 4,
      },
    }).success).toBe(false);

    expect(availabilitySchema.safeParse({
      provider: "notion",
      organization: {
        state: "connected",
        connectionId: "22222222-2222-4222-8222-222222222222",
        maxAccess: "read_only",
        scopeMode: "workspace",
        revision: 1,
      },
    }).success).toBe(false);

    expect(availabilitySchema.safeParse({
      provider: "notion",
      organization: {
        state: "connected",
        connectionId: "22222222-2222-4222-8222-222222222222",
        maxAccess: "provider_granted",
        scopeMode: "workspace",
        revision: 1,
      },
      agent: {
        access: "provider_granted",
        activeRunUsesOlderPolicy: false,
      },
    }).success).toBe(true);

    expect(availabilitySchema.safeParse({
      provider: "supabase",
      organization: {
        state: "connected",
        connectionId: "22222222-2222-4222-8222-222222222222",
        maxAccess: "read_only",
        scopeMode: "account",
        revision: 1,
      },
      agent: {
        access: "read_write",
        activeRunUsesOlderPolicy: false,
      },
    }).success).toBe(false);

    expect(availabilitySchema.safeParse({
      provider: "notion",
      organization: {
        state: "connected",
        connectionId: "22222222-2222-4222-8222-222222222222",
        maxAccess: "provider_default",
        scopeMode: "workspace",
        revision: 1,
      },
      agent: {
        access: "read_only",
        activeRunUsesOlderPolicy: false,
      },
    }).success).toBe(false);
  });
});
