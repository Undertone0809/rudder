import type {
  McpAgentBindingStatus,
  McpConnectionAccessMode,
  McpConnectionProvider,
  McpConnectionStatus,
  McpConnectionTransport,
  McpOAuthGrantStatus,
} from "../constants.js";

export interface McpStdioSafeConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  forwardedEnv?: string[];
  credentialEnvNames?: string[];
}

export interface McpStreamableHttpSafeConfig {
  url?: string;
  headers?: Record<string, string>;
  bearerEnvVar?: string;
  credentialHeaderNames?: string[];
}

export interface McpLegacyManualSafeConfig {
  legacyConfigRetained: true;
}

export type McpConnectionSafeConfig =
  | McpStdioSafeConfig
  | McpStreamableHttpSafeConfig
  | McpLegacyManualSafeConfig;

export interface McpConnectionSummary {
  id: string;
  orgId: string;
  name: string;
  displayName: string;
  provider: McpConnectionProvider;
  transport: McpConnectionTransport;
  externalScope: string | null;
  accessMode: McpConnectionAccessMode;
  status: McpConnectionStatus;
  safeConfig: McpConnectionSafeConfig | Record<string, never>;
  connectTimeoutMs: number;
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
  enabled: boolean;
  removedAt: Date | null;
}

export interface McpAgentBinding {
  id: string;
  connectionId: string;
  agentId: string;
  status: McpAgentBindingStatus;
  enabledToolIds: string[];
}

/**
 * Provider-neutral, run-scoped proxy descriptor consumed by runtime adapters.
 *
 * Provider scope and credentials stay on the Rudder server. Adapters receive
 * only the managed proxy address, a run-owned authorization environment name,
 * and the allowlisted tool surface.
 */
export interface ManagedExternalMcpBinding {
  connectionId: string;
  serverName: string;
  proxyUrl: string;
  authorizationEnvVar: string;
  enabledToolNames: string[];
  required: boolean;
  connectTimeoutMs: number;
  toolTimeoutMs: number;
}

export type ManagedExternalMcpBindings = ManagedExternalMcpBinding[];
