import { z } from "zod";
import { ORGANIZATION_RESOURCE_KINDS, PROJECT_RESOURCE_ATTACHMENT_ROLES } from "../constants.js";

export const organizationResourceKindSchema = z.enum(ORGANIZATION_RESOURCE_KINDS);
export const projectResourceAttachmentRoleSchema = z.enum(PROJECT_RESOURCE_ATTACHMENT_ROLES);

export const createOrganizationResourceSchema = z.object({
  name: z.string().min(1),
  kind: organizationResourceKindSchema,
  locator: z.string().min(1),
  description: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export type CreateOrganizationResource = z.infer<typeof createOrganizationResourceSchema>;

export const updateOrganizationResourceSchema = z.object({
  name: z.string().min(1).optional(),
  kind: organizationResourceKindSchema.optional(),
  locator: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
}).strict();

export type UpdateOrganizationResource = z.infer<typeof updateOrganizationResourceSchema>;

export const projectResourceAttachmentInputSchema = z.object({
  resourceId: z.string().uuid(),
  role: projectResourceAttachmentRoleSchema.optional(),
  note: z.string().optional().nullable(),
  sortOrder: z.number().int().nonnegative().optional(),
}).strict();

export type ProjectResourceAttachmentInputPayload = z.infer<typeof projectResourceAttachmentInputSchema>;

export const updateProjectResourceAttachmentSchema = z.object({
  role: projectResourceAttachmentRoleSchema.optional(),
  note: z.string().optional().nullable(),
  sortOrder: z.number().int().nonnegative().optional(),
}).strict();

export type UpdateProjectResourceAttachment = z.infer<typeof updateProjectResourceAttachmentSchema>;

export const createProjectInlineResourceSchema = createOrganizationResourceSchema.extend({
  role: projectResourceAttachmentRoleSchema.optional(),
  note: z.string().optional().nullable(),
  sortOrder: z.number().int().nonnegative().optional(),
}).strict();

export type CreateProjectInlineResource = z.infer<typeof createProjectInlineResourceSchema>;
