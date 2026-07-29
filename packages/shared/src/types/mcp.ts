import type {
  McpAgentAccessMode,
  McpAgentBindingStatus,
  McpConnectionAccessMode,
  McpConnectionProvider,
  McpConnectionScope,
  McpConnectionStatus,
  McpConnectionTransport,
  McpOAuthGrantStatus,
  McpProviderOrganizationState,
  McpProviderScopeMode,
  McpToolCapabilityClass,
} from "../constants.js";

export interface McpStdioSafeConfig {
  command: string;
  args?: string[];
  cwd?: string;
  staticEnv?: Record<string, string>;
  forwardedEnv?: string[];
  secretEnvNames?: string[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

export interface McpStreamableHttpSafeConfig {
  url?: string;
  staticHeaders?: Record<string, string>;
  headersFromEnv?: Record<string, string>;
  bearerTokenEnvVar?: string;
  secretHeaderNames?: string[];
  hasBearerToken?: boolean;
  toolAllowlist?: string[];
  toolDenylist?: string[];
}

export interface McpConnectionSecretsMutation {
  env?: Record<string, string>;
  headers?: Record<string, string>;
  bearerToken?: string;
}

export interface McpLegacyManualSafeConfig {
  legacyConfigRetained: true;
}

export interface McpCuratedSafeConfig {
  featureGroups: {
    mode: "provider_default";
    excluded: string[];
  };
}

export type McpConnectionSafeConfig =
  | McpStdioSafeConfig
  | McpStreamableHttpSafeConfig
  | McpLegacyManualSafeConfig
  | McpCuratedSafeConfig;

export interface McpConnectionSummary {
  id: string;
  orgId: string;
  scope: McpConnectionScope;
  ownerAgentId: string | null;
  name: string;
  displayName: string;
  provider: McpConnectionProvider;
  transport: McpConnectionTransport;
  externalScope: string | null;
  accessMode: McpConnectionAccessMode;
  status: McpConnectionStatus;
  safeConfig: McpConnectionSafeConfig | Record<string, never>;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  enabled: boolean;
  required: boolean;
  hasCredentials: boolean;
  lastDiscoveredAt: Date | null;
  activatedAt: Date | null;
  disabledAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface McpProviderCatalogEntry {
  id: McpConnectionProvider;
  label: string;
  curated: boolean;
  requiresOAuth: boolean;
  requiresScopeSelection: boolean;
  scopeLabel: string;
  transports: McpConnectionTransport[];
  accessModes: McpConnectionAccessMode[];
  defaultAccessMode: McpConnectionAccessMode;
}

export interface McpOAuthGrantSummary {
  id: string;
  connectionId: string;
  providerSubject: string | null;
  providerScopes: string[];
  externalScopeMetadata: Record<string, unknown>;
  status: McpOAuthGrantStatus;
  hasCredentials: boolean;
  expiresAt: Date | null;
  lastRefreshedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface McpOAuthStartResponse {
  connectionId: string;
  authorizationUrl: string;
  expiresAt: Date;
}

export interface McpOAuthCallbackResult {
  connectionId: string;
  status: Extract<McpConnectionStatus, "selecting_scope" | "active" | "needs_reauth" | "error">;
}

export interface McpExternalScopeOption {
  id: string;
  displayName: string;
  metadata: Record<string, unknown>;
}

export interface McpExternalScopeSelectionResponse {
  connection: McpConnectionSummary;
}

export interface McpDiscoveredTool {
  id: string;
  connectionId: string;
  externalToolName: string;
  rudderToolName: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  capabilityClass: McpToolCapabilityClass;
  policyRevision: number;
  catalogRevision: number;
  enabled: boolean;
  removedAt: Date | null;
}

export interface McpAgentBinding {
  id: string;
  connectionId: string;
  agentId: string;
  status: McpAgentBindingStatus;
  accessMode: McpAgentAccessMode;
  policyRevision: number;
  /**
   * Compatibility-only exact tool filter. It may further restrict the
   * coarse access mode but must never grant a capability denied by it.
   */
  enabledToolIds: string[];
}

export interface McpAgentConnectionSummary {
  connection: McpConnectionSummary;
  binding: McpAgentBinding | null;
  tools: McpDiscoveredTool[];
  reviewRequired: boolean;
}

export interface McpProviderAvailability {
  provider: Exclude<McpConnectionProvider, "custom">;
  organization: {
    state: McpProviderOrganizationState;
    connectionId: string | null;
    maxAccess: Extract<McpAgentAccessMode, "read_only" | "read_write" | "provider_granted"> | null;
    scopeMode: McpProviderScopeMode | null;
    revision: number | null;
    affectedAgentCount?: number;
    /**
     * Superseded official connections whose encrypted OAuth grant is still
     * active. They remain disabled until an owner explicitly disconnects them.
     */
    historicalGrantConnectionIds?: string[];
    agentConnectionCount?: number;
  };
  agent?: {
    access: Exclude<McpAgentAccessMode, "full">;
    activeRunUsesOlderPolicy: boolean;
    connection: {
      state: McpProviderOrganizationState;
      connectionId: string;
      maxAccess: Extract<McpAgentAccessMode, "read_only" | "read_write" | "provider_granted">;
      revision: number;
    } | null;
    effectiveSource: "agent" | "organization" | "none";
    effectiveConnectionId: string | null;
    explicitlyDisabled: boolean;
  };
}

/**
 * Provider-neutral, run-scoped proxy descriptor consumed by runtime adapters.
 *
 * Provider scope, proxy coordinates, and credentials stay on the Rudder server.
 * Adapters receive only the binding identity, proxy server name, and explicit
 * allowlisted tool surface. Fixed proxy authentication is derived from run
 * context outside this array.
 */
export interface ManagedExternalMcpToolPolicy {
  mode: "allowlist";
  allowedToolNames: string[];
}

export interface ManagedExternalMcpBinding {
  bindingId: string;
  serverName: string;
  accessMode: McpAgentAccessMode;
  toolPolicy: ManagedExternalMcpToolPolicy;
  required: boolean;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
}

export type ManagedExternalMcpBindings = ManagedExternalMcpBinding[];
