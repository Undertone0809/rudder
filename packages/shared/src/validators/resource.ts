import { z } from "zod";
import {
  ORGANIZATION_RESOURCE_KINDS,
  ORGANIZATION_RESOURCE_SOURCE_TYPES,
  PROJECT_RESOURCE_ATTACHMENT_ROLES,
} from "../constants.js";

export const organizationResourceKindSchema = z.enum(ORGANIZATION_RESOURCE_KINDS);
export const organizationResourceSourceTypeSchema = z.enum(ORGANIZATION_RESOURCE_SOURCE_TYPES);
export const projectResourceAttachmentRoleSchema = z.enum(PROJECT_RESOURCE_ATTACHMENT_ROLES);

const LIBRARY_PATH_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
function isValidLibraryProjectPath(
  locator: string,
  kind?: z.infer<typeof organizationResourceKindSchema>,
) {
  const trimmed = locator.trim();
  if (!trimmed) return false;
  if (LIBRARY_PATH_SCHEME_RE.test(trimmed)) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || trimmed.startsWith("~")) return false;
  if (trimmed.includes("\\")) return false;
  const parts = trimmed.split("/");
  if (!parts.every((part) => part.length > 0 && part !== "." && part !== "..")) return false;
  if (parts[0] !== "projects") return false;
  return kind === "directory" ? parts.length >= 2 : parts.length >= 3;
}

function validateLibraryResourceContract(
  value: {
    kind?: z.infer<typeof organizationResourceKindSchema>;
    sourceType?: z.infer<typeof organizationResourceSourceTypeSchema>;
    locator?: string;
  },
  ctx: z.RefinementCtx,
) {
  if (value.sourceType !== "library") return;
  if (value.kind !== undefined && value.kind !== "file" && value.kind !== "directory") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Library resources must be file or directory resources.",
      path: ["kind"],
    });
  }
  if (value.locator !== undefined && !isValidLibraryProjectPath(value.locator, value.kind)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Library resource locator must be a normalized project Library path.",
      path: ["locator"],
    });
  }
}

const createOrganizationResourceBaseSchema = z.object({
  name: z.string().min(1),
  kind: organizationResourceKindSchema,
  sourceType: organizationResourceSourceTypeSchema.optional().default("external"),
  locator: z.string().min(1),
  description: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export const createOrganizationResourceSchema = createOrganizationResourceBaseSchema
  .superRefine(validateLibraryResourceContract);

export type CreateOrganizationResource = z.infer<typeof createOrganizationResourceSchema>;

export const updateOrganizationResourceSchema = z.object({
  name: z.string().min(1).optional(),
  kind: organizationResourceKindSchema.optional(),
  sourceType: organizationResourceSourceTypeSchema.optional(),
  locator: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable(),
}).strict().superRefine(validateLibraryResourceContract);

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

export const createProjectInlineResourceSchema = createOrganizationResourceBaseSchema.extend({
  role: projectResourceAttachmentRoleSchema.optional(),
  note: z.string().optional().nullable(),
  sortOrder: z.number().int().nonnegative().optional(),
}).strict().superRefine(validateLibraryResourceContract);

export type CreateProjectInlineResource = z.infer<typeof createProjectInlineResourceSchema>;
