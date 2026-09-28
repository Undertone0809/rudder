import type {
  CreateProjectInlineResourceInput,
  Project,
  ProjectResourceAttachment,
  ProjectResourceAttachmentInput,
  UpdateProjectResourceAttachmentRequest,
} from "@rudderhq/shared";
import { api } from "./client";

type ProjectMutationOptions = {
  idempotencyKey?: string | null;
};

function projectMutationRequestOptions(options?: ProjectMutationOptions) {
  return {
    headers: {
      "x-rudder-idempotency-key": options?.idempotencyKey ?? globalThis.crypto.randomUUID(),
    },
  };
}

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
  update: (
    id: string,
    data: Record<string, unknown>,
    orgId?: string,
    options?: ProjectMutationOptions,
  ) => api.patch<Project>(projectPath(id, orgId), data, projectMutationRequestOptions(options)),
  listResources: (id: string, orgId?: string) =>
    api.get<ProjectResourceAttachment[]>(projectPath(id, orgId, "/resources")),
  attachResource: (
    id: string,
    data: ProjectResourceAttachmentInput,
    orgId?: string,
    options?: ProjectMutationOptions,
  ) => api.post<ProjectResourceAttachment>(
    projectPath(id, orgId, "/resources"),
    data,
    projectMutationRequestOptions(options),
  ),
  updateResourceAttachment: (
    id: string,
    attachmentId: string,
    data: UpdateProjectResourceAttachmentRequest,
    orgId?: string,
    options?: ProjectMutationOptions,
  ) => api.patch<ProjectResourceAttachment>(
    projectPath(id, orgId, `/resources/${attachmentId}`),
    data,
    projectMutationRequestOptions(options),
  ),
  removeResourceAttachment: (
    id: string,
    attachmentId: string,
    orgId?: string,
    options?: ProjectMutationOptions,
  ) => api.delete<ProjectResourceAttachment>(
    projectPath(id, orgId, `/resources/${attachmentId}`),
    projectMutationRequestOptions(options),
  ),
  remove: (id: string, orgId?: string) => api.delete<Project>(projectPath(id, orgId)),
};
