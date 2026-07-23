import type {
  McpConnectionAccessMode,
  McpConnectionProvider,
} from "@rudderhq/shared";

export type McpProviderScopeSelection = "none" | "project" | "workspace";

export interface McpProviderDefinition {
  endpoint: string | null;
  readOnlyEndpoint?: string;
  requiresOAuth: boolean;
  scopeSelection: McpProviderScopeSelection;
  defaultAccessMode: McpConnectionAccessMode;
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
    requiresOAuth: true,
    scopeSelection: "project",
    defaultAccessMode: "read_only",
    featureGroups: {
      mode: "provider_default",
      excluded: ["storage"],
    },
  },
  linear: {
    endpoint: "https://mcp.linear.app/mcp",
    readOnlyEndpoint: "https://mcp.linear.app/mcp/readonly",
    requiresOAuth: true,
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
    requiresOAuth: true,
    scopeSelection: "workspace",
    defaultAccessMode: "provider_default",
    scopeIdentity: {
      toolNames: ["notion-get-self"],
      arguments: {},
      containers: ["workspace", "organization"],
    },
  },
  custom: {
    endpoint: null,
    requiresOAuth: false,
    scopeSelection: "none",
    defaultAccessMode: "provider_default",
  },
} as const satisfies Record<McpConnectionProvider, McpProviderDefinition>;

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
    const projectRef = input.externalScope?.trim();
    if (!projectRef) {
      throw new Error("Supabase MCP connections require a selected project");
    }
    if (input.accessMode !== "read_only" && input.accessMode !== "read_write") {
      throw new Error("Supabase MCP connections require read_only or read_write access");
    }
    const endpoint = new URL(definition.endpoint);
    endpoint.searchParams.set("project_ref", projectRef);
    endpoint.searchParams.set("read_only", String(input.accessMode === "read_only"));
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

  if (input.accessMode !== "provider_default") {
    throw new Error("Notion MCP connections use provider_default access");
  }
  return { href: definition.endpoint, transport: "streamable_http" };
}
