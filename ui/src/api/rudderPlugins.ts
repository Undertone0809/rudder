import type {
  RudderInstalledPlugin,
  RudderMcpUiResource,
  RudderMcpUiResourceContent,
  RudderPluginArchiveInput,
  RudderPluginComponentLink,
  RudderPluginDirectory,
  RudderPluginImportReport,
  RudderPluginMarketplaceInput,
  RudderPluginPackageFileInput,
} from "@rudderhq/shared";
import { api } from "./client";

function base(orgId: string) {
  return `/orgs/${encodeURIComponent(orgId)}/plugins`;
}

export const rudderPluginsApi = {
  directory: (orgId: string) => api.get<RudderPluginDirectory>(base(orgId)),
  get: (orgId: string, pluginId: string) =>
    api.get<RudderInstalledPlugin>(`${base(orgId)}/${encodeURIComponent(pluginId)}`),
  inspect: (orgId: string, sourceLabel: string, files: RudderPluginPackageFileInput[]) =>
    api.post<RudderPluginImportReport>(`${base(orgId)}/imports/inspect`, { sourceType: "local_upload", sourceLabel, files }),
  inspectArchive: (orgId: string, input: RudderPluginArchiveInput) =>
    api.post<RudderPluginImportReport>(`${base(orgId)}/imports/inspect-archive`, input),
  configureMarketplace: (orgId: string, input: RudderPluginMarketplaceInput) =>
    api.post<RudderPluginImportReport[]>(`${base(orgId)}/marketplaces`, input),
  getImportReport: (orgId: string, reportId: string) =>
    api.get<RudderPluginImportReport>(`${base(orgId)}/imports/${encodeURIComponent(reportId)}`),
  install: (orgId: string, reportId: string, confirmAccessExpansion = false, skillConflictStrategy?: "keep" | "replace" | "rename") =>
    api.post<RudderInstalledPlugin>(`${base(orgId)}/imports/${encodeURIComponent(reportId)}/install`, {
      enabled: true,
      confirmAccessExpansion,
      ...(skillConflictStrategy ? { skillConflictStrategy } : {}),
    }),
  setEnabled: (orgId: string, pluginId: string, enabled: boolean) =>
    api.patch<RudderInstalledPlugin>(`${base(orgId)}/${encodeURIComponent(pluginId)}/enablement`, { enabled }),
  configureSkills: (orgId: string, pluginId: string, agentIds: string[]) =>
    api.post<RudderInstalledPlugin>(`${base(orgId)}/${encodeURIComponent(pluginId)}/skills/agents`, { agentIds }),
  configureMcp: (orgId: string, pluginId: string, componentId: string) =>
    api.post<RudderPluginComponentLink>(`${base(orgId)}/${encodeURIComponent(pluginId)}/mcp/setup`, { componentId }),
  listMcpUiResources: (orgId: string, pluginId: string, componentId: string) =>
    api.get<RudderMcpUiResource[]>(`${base(orgId)}/${encodeURIComponent(pluginId)}/mcp/${encodeURIComponent(componentId)}/resources`),
  readMcpUiResource: (orgId: string, pluginId: string, componentId: string, uri: string) =>
    api.get<RudderMcpUiResourceContent>(`${base(orgId)}/${encodeURIComponent(pluginId)}/mcp/${encodeURIComponent(componentId)}/resource?uri=${encodeURIComponent(uri)}`),
  customizeSkill: (orgId: string, pluginId: string, componentId: string) =>
    api.post<{ id: string }>(`${base(orgId)}/${encodeURIComponent(pluginId)}/skills/customize`, { componentId }),
  uninstall: (orgId: string, pluginId: string) =>
    api.delete<{ id: string; uninstalled: true }>(`${base(orgId)}/${encodeURIComponent(pluginId)}`),
  rollback: (orgId: string, pluginId: string) =>
    api.post<RudderInstalledPlugin>(`${base(orgId)}/${encodeURIComponent(pluginId)}/rollback`, {}),
  applyLocalAppUpdate: (orgId: string, pluginId: string) =>
    api.post<RudderInstalledPlugin>(`${base(orgId)}/${encodeURIComponent(pluginId)}/local-app-update/apply`, {}),
};
