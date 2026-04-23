import type {
  CreateOrganizationResourceRequest,
  Organization,
  OrganizationResource,
  OrganizationWorkspaceFileDetail,
  OrganizationWorkspaceFileList,
  OrganizationWorkspaceFileUpdateRequest,
  OrganizationPortabilityExportRequest,
  OrganizationPortabilityExportPreviewResult,
  OrganizationPortabilityExportResult,
  OrganizationPortabilityImportRequest,
  OrganizationPortabilityImportResult,
  OrganizationPortabilityPreviewRequest,
  OrganizationPortabilityPreviewResult,
  UpdateOrganizationBranding,
  UpdateOrganizationResourceRequest,
} from "@rudder/shared";
import { api } from "./client";

export type OrganizationStats = Record<string, { agentCount: number; issueCount: number }>;
export interface LinearImportSourceRequest {
  apiKey: string;
  teamIdOrKey?: string;
  projectIds?: string[];
  issueLimit?: number;
  projectLimit?: number;
}

export interface LinearImportSourceResult {
  rootPath: string;
  files: Record<string, string>;
  summary: {
    projectCount: number;
    issueCount: number;
  };
}

export const organizationsApi = {
  list: () => api.get<Organization[]>("/orgs"),
  get: (orgId: string) => api.get<Organization>(`/orgs/${orgId}`),
  stats: () => api.get<OrganizationStats>("/orgs/stats"),
  create: (data: {
    name: string;
    description?: string | null;
    budgetMonthlyCents?: number;
  }) =>
    api.post<Organization>("/orgs", data),
  update: (
    orgId: string,
    data: Partial<
      Pick<
        Organization,
        | "name"
        | "description"
        | "status"
        | "budgetMonthlyCents"
        | "requireBoardApprovalForNewAgents"
        | "defaultChatIssueCreationMode"
        | "defaultChatAgentRuntimeType"
        | "defaultChatAgentRuntimeConfig"
        | "brandColor"
        | "logoAssetId"
      >
    >,
  ) => api.patch<Organization>(`/orgs/${orgId}`, data),
  updateBranding: (orgId: string, data: UpdateOrganizationBranding) =>
    api.patch<Organization>(`/orgs/${orgId}/branding`, data),
  listResources: (orgId: string) => api.get<OrganizationResource[]>(`/orgs/${orgId}/resources`),
  createResource: (orgId: string, data: CreateOrganizationResourceRequest) =>
    api.post<OrganizationResource>(`/orgs/${orgId}/resources`, data),
  updateResource: (orgId: string, resourceId: string, data: UpdateOrganizationResourceRequest) =>
    api.patch<OrganizationResource>(`/orgs/${orgId}/resources/${resourceId}`, data),
  removeResource: (orgId: string, resourceId: string) =>
    api.delete<OrganizationResource>(`/orgs/${orgId}/resources/${resourceId}`),
  listWorkspaceFiles: (orgId: string, directoryPath: string = "") => {
    const search = new URLSearchParams();
    if (directoryPath) search.set("path", directoryPath);
    const query = search.toString();
    return api.get<OrganizationWorkspaceFileList>(
      `/orgs/${orgId}/workspace/files${query ? `?${query}` : ""}`,
    );
  },
  readWorkspaceFile: (orgId: string, filePath: string) => {
    const search = new URLSearchParams();
    if (filePath) search.set("path", filePath);
    const query = search.toString();
    return api.get<OrganizationWorkspaceFileDetail>(
      `/orgs/${orgId}/workspace/file${query ? `?${query}` : ""}`,
    );
  },
  updateWorkspaceFile: (orgId: string, filePath: string, data: OrganizationWorkspaceFileUpdateRequest) => {
    const search = new URLSearchParams();
    if (filePath) search.set("path", filePath);
    const query = search.toString();
    return api.patch<OrganizationWorkspaceFileDetail>(
      `/orgs/${orgId}/workspace/file${query ? `?${query}` : ""}`,
      data,
    );
  },
  archive: (orgId: string) => api.post<Organization>(`/orgs/${orgId}/archive`, {}),
  remove: (orgId: string) => api.delete<{ ok: true }>(`/orgs/${orgId}`),
  exportBundle: (
    orgId: string,
    data: OrganizationPortabilityExportRequest,
  ) =>
    api.post<OrganizationPortabilityExportResult>(`/orgs/${orgId}/export`, data),
  exportPreview: (
    orgId: string,
    data: OrganizationPortabilityExportRequest,
  ) =>
    api.post<OrganizationPortabilityExportPreviewResult>(`/orgs/${orgId}/exports/preview`, data),
  exportPackage: (
    orgId: string,
    data: OrganizationPortabilityExportRequest,
  ) =>
    api.post<OrganizationPortabilityExportResult>(`/orgs/${orgId}/exports`, data),
  importPreview: (data: OrganizationPortabilityPreviewRequest) =>
    api.post<OrganizationPortabilityPreviewResult>("/orgs/import/preview", data),
  importBundle: (data: OrganizationPortabilityImportRequest) =>
    api.post<OrganizationPortabilityImportResult>("/orgs/import", data),
  buildLinearImportSource: (data: LinearImportSourceRequest) =>
    api.post<LinearImportSourceResult>("/orgs/import/linear-source", data),
};
