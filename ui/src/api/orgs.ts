import type {
  CreateLibraryDocument,
  CreateOrganizationResourceRequest,
  LibraryDocument,
  LibraryDocumentRevision,
  LibraryDocumentSummary,
  Organization,
  OrganizationResource,
  OrganizationWorkspaceEntryMutationResult,
  OrganizationWorkspaceEntryRenameRequest,
  OrganizationWorkspaceFileCreateRequest,
  OrganizationWorkspaceFileDetail,
  OrganizationWorkspaceFileEntry,
  OrganizationWorkspaceFileList,
  OrganizationWorkspaceFileUpdateRequest,
  OrganizationPortabilityExportRequest,
  OrganizationPortabilityExportPreviewResult,
  OrganizationPortabilityExportResult,
  OrganizationExportJob,
  OrganizationExportJobCreateResult,
  OrganizationPortabilityImportRequest,
  OrganizationPortabilityImportResult,
  OrganizationPortabilityPreviewRequest,
  OrganizationPortabilityPreviewResult,
  WorkspaceBackupCreateRequest,
  WorkspaceBackupFileDetail,
  WorkspaceBackupFileList,
  WorkspaceBackupList,
  WorkspaceBackupRestoreRequest,
  WorkspaceBackupRestoreResult,
  WorkspaceBackupSummary,
  RestoreLibraryDocumentRevision,
  UpdateLibraryDocument,
  UpdateOrganizationBranding,
  UpdateOrganizationResourceRequest,
} from "@rudderhq/shared";
import { api } from "./client";

export type OrganizationStats = Record<string, { agentCount: number; issueCount: number }>;

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
        | "brandColor"
        | "logoAssetId"
      >
    >,
  ) => api.patch<Organization>(`/orgs/${orgId}`, data),
  updateBranding: (orgId: string, data: UpdateOrganizationBranding) =>
    api.patch<Organization>(`/orgs/${orgId}/branding`, data),
  listLibraryDocuments: (orgId: string) =>
    api.get<LibraryDocumentSummary[]>(`/orgs/${orgId}/library/documents`),
  createLibraryDocument: (orgId: string, data: CreateLibraryDocument) =>
    api.post<LibraryDocument>(`/orgs/${orgId}/library/documents`, data),
  getLibraryDocument: (orgId: string, documentId: string) =>
    api.get<LibraryDocument>(`/orgs/${orgId}/library/documents/${encodeURIComponent(documentId)}`),
  updateLibraryDocument: (orgId: string, documentId: string, data: UpdateLibraryDocument) =>
    api.patch<LibraryDocument>(`/orgs/${orgId}/library/documents/${encodeURIComponent(documentId)}`, data),
  listLibraryDocumentRevisions: (orgId: string, documentId: string) =>
    api.get<LibraryDocumentRevision[]>(
      `/orgs/${orgId}/library/documents/${encodeURIComponent(documentId)}/revisions`,
    ),
  restoreLibraryDocumentRevision: (
    orgId: string,
    documentId: string,
    revisionId: string,
    data: RestoreLibraryDocumentRevision = {},
  ) =>
    api.post<LibraryDocument>(
      `/orgs/${orgId}/library/documents/${encodeURIComponent(documentId)}/revisions/${encodeURIComponent(revisionId)}/restore`,
      data,
    ),
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
  listWorkspaceMentionFiles: (orgId: string, options?: { query?: string | null; limit?: number | null }) => {
    const search = new URLSearchParams();
    const query = options?.query?.trim();
    if (query) search.set("q", query);
    if (options?.limit) search.set("limit", String(options.limit));
    const suffix = search.toString();
    return api.get<{ entries: OrganizationWorkspaceFileEntry[] }>(
      `/orgs/${orgId}/workspace/mention-files${suffix ? `?${suffix}` : ""}`,
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
  createWorkspaceFile: (orgId: string, data: OrganizationWorkspaceFileCreateRequest) =>
    api.post<OrganizationWorkspaceFileDetail>(`/orgs/${orgId}/workspace/file`, data),
  updateWorkspaceFile: (orgId: string, filePath: string, data: OrganizationWorkspaceFileUpdateRequest) => {
    const search = new URLSearchParams();
    if (filePath) search.set("path", filePath);
    const query = search.toString();
    return api.patch<OrganizationWorkspaceFileDetail>(
      `/orgs/${orgId}/workspace/file${query ? `?${query}` : ""}`,
      data,
    );
  },
  renameWorkspaceEntry: (orgId: string, entryPath: string, data: OrganizationWorkspaceEntryRenameRequest) => {
    const search = new URLSearchParams();
    if (entryPath) search.set("path", entryPath);
    const query = search.toString();
    return api.patch<OrganizationWorkspaceEntryMutationResult>(
      `/orgs/${orgId}/workspace/entry${query ? `?${query}` : ""}`,
      data,
    );
  },
  deleteWorkspaceEntry: (orgId: string, entryPath: string) => {
    const search = new URLSearchParams();
    if (entryPath) search.set("path", entryPath);
    const query = search.toString();
    return api.delete<OrganizationWorkspaceEntryMutationResult>(
      `/orgs/${orgId}/workspace/entry${query ? `?${query}` : ""}`,
    );
  },
  listWorkspaceBackups: (orgId: string) =>
    api.get<WorkspaceBackupList>(`/orgs/${orgId}/workspace/backups`),
  createWorkspaceBackup: (orgId: string, data: WorkspaceBackupCreateRequest = {}) =>
    api.post<WorkspaceBackupSummary>(`/orgs/${orgId}/workspace/backups`, data),
  listWorkspaceBackupFiles: (orgId: string, backupId: string, directoryPath: string = "") => {
    const search = new URLSearchParams();
    if (directoryPath) search.set("path", directoryPath);
    const query = search.toString();
    return api.get<WorkspaceBackupFileList>(
      `/orgs/${orgId}/workspace/backups/${backupId}/files${query ? `?${query}` : ""}`,
    );
  },
  readWorkspaceBackupFile: (orgId: string, backupId: string, filePath: string) => {
    const search = new URLSearchParams();
    if (filePath) search.set("path", filePath);
    const query = search.toString();
    return api.get<WorkspaceBackupFileDetail>(
      `/orgs/${orgId}/workspace/backups/${backupId}/file${query ? `?${query}` : ""}`,
    );
  },
  restoreWorkspaceBackup: (orgId: string, backupId: string, data: WorkspaceBackupRestoreRequest) =>
    api.post<WorkspaceBackupRestoreResult>(`/orgs/${orgId}/workspace/backups/${backupId}/restore`, data),
  deleteWorkspaceBackup: (orgId: string, backupId: string) =>
    api.delete<WorkspaceBackupSummary>(`/orgs/${orgId}/workspace/backups/${backupId}`),
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
  createExportJob: (
    orgId: string,
    data: OrganizationPortabilityExportRequest,
  ) =>
    api.post<OrganizationExportJobCreateResult>(`/orgs/${orgId}/exports/jobs`, data),
  getExportJob: (orgId: string, jobId: string) =>
    api.get<OrganizationExportJob>(`/orgs/${orgId}/exports/jobs/${jobId}`),
  cancelExportJob: (orgId: string, jobId: string) =>
    api.delete<OrganizationExportJob>(`/orgs/${orgId}/exports/jobs/${jobId}`),
  getExportJobResult: (orgId: string, jobId: string) =>
    api.get<OrganizationPortabilityExportResult>(`/orgs/${orgId}/exports/jobs/${jobId}/result`),
  importPreview: (data: OrganizationPortabilityPreviewRequest) =>
    api.post<OrganizationPortabilityPreviewResult>("/orgs/import/preview", data),
  importBundle: (data: OrganizationPortabilityImportRequest) =>
    api.post<OrganizationPortabilityImportResult>("/orgs/import", data),
};
