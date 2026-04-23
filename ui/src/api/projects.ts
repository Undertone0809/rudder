import type {
  CreateProjectInlineResourceInput,
  Project,
  ProjectResourceAttachment,
  ProjectResourceAttachmentInput,
  UpdateProjectResourceAttachmentRequest,
} from "@rudder/shared";
import { api } from "./client";

function withCompanyScope(path: string, orgId?: string) {
  if (!orgId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}orgId=${encodeURIComponent(orgId)}`;
}

function projectPath(id: string, orgId?: string, suffix = "") {
  return withCompanyScope(`/projects/${encodeURIComponent(id)}${suffix}`, orgId);
}

export const projectsApi = {
  list: (orgId: string) => api.get<Project[]>(`/orgs/${orgId}/projects`),
  get: (id: string, orgId?: string) => api.get<Project>(projectPath(id, orgId)),
  create: (
    orgId: string,
    data: Record<string, unknown> & {
      resourceAttachments?: ProjectResourceAttachmentInput[];
      newResources?: CreateProjectInlineResourceInput[];
    },
  ) =>
    api.post<Project>(`/orgs/${orgId}/projects`, data),
  update: (id: string, data: Record<string, unknown>, orgId?: string) =>
    api.patch<Project>(projectPath(id, orgId), data),
  listResources: (id: string, orgId?: string) =>
    api.get<ProjectResourceAttachment[]>(projectPath(id, orgId, "/resources")),
  attachResource: (id: string, data: ProjectResourceAttachmentInput, orgId?: string) =>
    api.post<ProjectResourceAttachment>(projectPath(id, orgId, "/resources"), data),
  updateResourceAttachment: (
    id: string,
    attachmentId: string,
    data: UpdateProjectResourceAttachmentRequest,
    orgId?: string,
  ) => api.patch<ProjectResourceAttachment>(projectPath(id, orgId, `/resources/${attachmentId}`), data),
  removeResourceAttachment: (id: string, attachmentId: string, orgId?: string) =>
    api.delete<ProjectResourceAttachment>(projectPath(id, orgId, `/resources/${attachmentId}`)),
  remove: (id: string, orgId?: string) => api.delete<Project>(projectPath(id, orgId)),
};
