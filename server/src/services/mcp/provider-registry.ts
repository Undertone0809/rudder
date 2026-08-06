import type {
  McpConnectionAccessMode,
  McpConnectionProvider,
  McpConnectionSafeConfig,
  McpProviderCredentialMode,
  McpProviderScopeMode,
} from "@rudderhq/shared";

export type McpProviderScopeSelection = "none" | "project" | "workspace";

export interface McpProviderDefinition {
  endpoint: string | null;
  readOnlyEndpoint?: string;
  oauthOrigins: readonly string[];
  requiresOAuth: boolean;
  credentialMode: McpProviderCredentialMode;
  scopeMode?: McpProviderScopeMode;
  scopeSelection: McpProviderScopeSelection;
  defaultAccessMode: McpConnectionAccessMode;
  safeConfig?: McpConnectionSafeConfig;
  featureGroups?: {
    mode: "provider_default";
    excluded: string[];
  };
  scopeIdentity?: {
    toolNames: readonly string[];
    arguments: Record<string, unknown>;
    containers: readonly ("workspace" | "organization")[];
  };
}

/**
 * Provider-specific MCP endpoint and onboarding behavior lives here so runtime
 * adapters consume only provider-neutral Rudder proxy bindings.
 */
export const MCP_PROVIDER_REGISTRY = {
  supabase: {
    endpoint: "https://mcp.supabase.com/mcp",
    oauthOrigins: ["https://mcp.supabase.com", "https://api.supabase.com"],
    requiresOAuth: true,
    credentialMode: "oauth",
    scopeMode: "account",
    scopeSelection: "none",
    defaultAccessMode: "read_only",
    featureGroups: {
      mode: "provider_default",
      excluded: ["storage"],
    },
  },
  linear: {
    endpoint: "https://mcp.linear.app/mcp",
    readOnlyEndpoint: "https://mcp.linear.app/mcp/readonly",
    oauthOrigins: ["https://mcp.linear.app"],
    requiresOAuth: true,
    credentialMode: "oauth",
    scopeMode: "workspace",
    scopeSelection: "workspace",
    defaultAccessMode: "read_write",
    scopeIdentity: {
      toolNames: ["get_user"],
      arguments: { query: "me" },
      containers: ["workspace", "organization"],
    },
  },
  notion: {
    endpoint: "https://mcp.notion.com/mcp",
    oauthOrigins: ["https://mcp.notion.com"],
    requiresOAuth: true,
    credentialMode: "oauth",
    scopeMode: "workspace",
    scopeSelection: "workspace",
    defaultAccessMode: "provider_default",
    scopeIdentity: {
      toolNames: ["notion-fetch"],
      arguments: { id: "self" },
      containers: ["workspace", "organization"],
    },
  },
  github: {
    endpoint: "https://api.githubcopilot.com/mcp/",
    oauthOrigins: [],
    requiresOAuth: false,
    credentialMode: "pat",
    scopeMode: "account",
    scopeSelection: "none",
    defaultAccessMode: "read_only",
    safeConfig: {
      endpoint: "https://api.githubcopilot.com/mcp/",
      scopeMode: "account",
    },
  },
  custom: {
    endpoint: null,
    oauthOrigins: [],
    requiresOAuth: false,
    credentialMode: "custom",
    scopeSelection: "none",
    defaultAccessMode: "provider_default",
  },
} as const satisfies Record<McpConnectionProvider, McpProviderDefinition>;

export const MCP_CURATED_OAUTH_ORIGINS = Array.from(new Set(
  Object.values(MCP_PROVIDER_REGISTRY).flatMap((definition) => definition.oauthOrigins),
));

export interface ResolvedCuratedMcpEndpoint {
  href: string;
  transport: "streamable_http";
}

export function resolveCuratedMcpEndpoint(input: {
  provider: McpConnectionProvider;
  accessMode: McpConnectionAccessMode;
  externalScope: string | null;
}): ResolvedCuratedMcpEndpoint {
  if (input.provider === "custom") {
    throw new Error("Custom MCP endpoints come from validated connection configuration");
  }

  const definition = MCP_PROVIDER_REGISTRY[input.provider];
  if (input.provider === "supabase") {
    if (input.accessMode !== "read_only" && input.accessMode !== "read_write") {
      throw new Error("Supabase MCP connections require read_only or read_write access");
    }
    const endpoint = new URL(definition.endpoint);
    endpoint.searchParams.set("read_only", String(input.accessMode === "read_only"));
    if (input.externalScope) {
      endpoint.searchParams.set("project_ref", input.externalScope);
    }
    return { href: endpoint.href, transport: "streamable_http" };
  }

  if (input.provider === "linear") {
    if (input.accessMode !== "read_only" && input.accessMode !== "read_write") {
      throw new Error("Linear MCP connections require read_only or read_write access");
    }
    return {
      href: input.accessMode === "read_only"
        ? MCP_PROVIDER_REGISTRY.linear.readOnlyEndpoint
        : MCP_PROVIDER_REGISTRY.linear.endpoint,
      transport: "streamable_http",
    };
  }

  if (input.provider === "github") {
    if (input.accessMode !== "read_only" && input.accessMode !== "read_write") {
      throw new Error("GitHub MCP connections require read_only or read_write access");
    }
    return { href: definition.endpoint, transport: "streamable_http" };
  }

  if (input.accessMode !== "provider_default") {
    throw new Error("Notion MCP connections use provider_default access");
  }
  return { href: definition.endpoint, transport: "streamable_http" };
}
