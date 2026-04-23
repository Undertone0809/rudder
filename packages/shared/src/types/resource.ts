import type { OrganizationResourceKind, ProjectResourceAttachmentRole } from "../constants.js";

export interface OrganizationResource {
  id: string;
  orgId: string;
  name: string;
  kind: OrganizationResourceKind;
  locator: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrganizationResourceRequest {
  name: string;
  kind: OrganizationResourceKind;
  locator: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateOrganizationResourceRequest {
  name?: string;
  kind?: OrganizationResourceKind;
  locator?: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ProjectResourceAttachment {
  id: string;
  orgId: string;
  projectId: string;
  resourceId: string;
  role: ProjectResourceAttachmentRole;
  note: string | null;
  sortOrder: number;
  resource: OrganizationResource;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectResourceAttachmentInput {
  resourceId: string;
  role?: ProjectResourceAttachmentRole;
  note?: string | null;
  sortOrder?: number;
}

export interface UpdateProjectResourceAttachmentRequest {
  role?: ProjectResourceAttachmentRole;
  note?: string | null;
  sortOrder?: number;
}

export interface CreateProjectInlineResourceInput extends CreateOrganizationResourceRequest {
  role?: ProjectResourceAttachmentRole;
  note?: string | null;
  sortOrder?: number;
}
