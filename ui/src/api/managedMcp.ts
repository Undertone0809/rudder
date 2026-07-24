import type {
  CreateMcpConnection,
  McpConnectionAccessMode,
  McpConnectionSummary,
  McpDiscoveredTool,
  McpExternalScopeOption,
  McpExternalScopeSelectionResponse,
  McpOAuthGrantSummary,
  McpOAuthStartResponse,
  McpProviderCatalogEntry,
  UpdateMcpConnection,
} from "@rudderhq/shared";
import { api } from "./client";

function connectionPath(orgId: string, connectionId?: string) {
  const root = `/orgs/${encodeURIComponent(orgId)}/mcp/connections`;
  return connectionId ? `${root}/${encodeURIComponent(connectionId)}` : root;
}

export const managedMcpApi = {
  catalog: (orgId: string) =>
    api.get<McpProviderCatalogEntry[]>(
      `/orgs/${encodeURIComponent(orgId)}/mcp/providers`,
    ),
  listConnections: (orgId: string) =>
    api.get<McpConnectionSummary[]>(connectionPath(orgId)),
  getConnection: (orgId: string, connectionId: string) =>
    api.get<McpConnectionSummary>(connectionPath(orgId, connectionId)),
  createConnection: (orgId: string, input: CreateMcpConnection) =>
    api.post<McpConnectionSummary>(connectionPath(orgId), input),
  updateConnection: (
    orgId: string,
    connectionId: string,
    input: UpdateMcpConnection,
  ) => api.patch<McpConnectionSummary>(connectionPath(orgId, connectionId), input),
  updateAccessMode: (
    orgId: string,
    connectionId: string,
    accessMode: McpConnectionAccessMode,
  ) => api.patch<McpConnectionSummary>(
    `${connectionPath(orgId, connectionId)}/access-mode`,
    { accessMode },
  ),
  listTools: (orgId: string, connectionId: string) =>
    api.get<McpDiscoveredTool[]>(`${connectionPath(orgId, connectionId)}/tools`),
  startOAuth: (orgId: string, connectionId: string) =>
    api.post<McpOAuthStartResponse>(
      `${connectionPath(orgId, connectionId)}/oauth/start`,
      {},
    ),
  getGrant: (orgId: string, connectionId: string) =>
    api.get<McpOAuthGrantSummary | null>(
      `${connectionPath(orgId, connectionId)}/oauth/grant`,
    ),
  listScopes: (orgId: string, connectionId: string) =>
    api.get<McpExternalScopeOption[]>(
      `${connectionPath(orgId, connectionId)}/oauth/scopes`,
    ),
  selectScope: (
    orgId: string,
    connectionId: string,
    input: { externalScope: string; accessMode: McpConnectionAccessMode },
  ) => api.post<McpExternalScopeSelectionResponse>(
    `${connectionPath(orgId, connectionId)}/oauth/scope`,
    input,
  ),
  refreshTools: (orgId: string, connectionId: string) =>
    api.post<McpDiscoveredTool[]>(
      `${connectionPath(orgId, connectionId)}/refresh-tools`,
      {},
    ),
  reconnect: (orgId: string, connectionId: string) =>
    api.post<McpConnectionSummary | McpOAuthStartResponse>(
      `${connectionPath(orgId, connectionId)}/reconnect`,
      {},
    ),
  disconnect: (orgId: string, connectionId: string) =>
    api.post<McpConnectionSummary>(
      `${connectionPath(orgId, connectionId)}/disconnect`,
      {},
    ),
};
