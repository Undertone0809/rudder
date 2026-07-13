import { z } from "zod";
import { CHAT_ISSUE_CREATION_MODES, ORGANIZATION_STATUSES } from "../constants.js";
import {
  ORGANIZATION_ISSUE_KEY_MAX_LENGTH,
  ORGANIZATION_ISSUE_KEY_PATTERN,
} from "../organization-issue-key.js";

const logoAssetIdSchema = z.string().uuid().nullable().optional();
const brandColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();
export const organizationIssueKeySchema = z.string()
  .trim()
  .min(1)
  .max(ORGANIZATION_ISSUE_KEY_MAX_LENGTH)
  .transform((value) => value.toUpperCase())
  .refine((value) => ORGANIZATION_ISSUE_KEY_PATTERN.test(value), {
    message: "Issue key must start with a letter and contain only letters and numbers",
  });

export const createOrganizationSchema = z.object({
  name: z.string().min(1),
  issuePrefix: organizationIssueKeySchema.optional(),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  defaultChatIssueCreationMode: z.enum(CHAT_ISSUE_CREATION_MODES).optional().default("manual_approval"),
  brandColor: brandColorSchema,
  requireBoardApprovalForNewAgents: z.boolean().optional(),
});

export type CreateOrganization = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = createOrganizationSchema
  .partial()
  .extend({
    status: z.enum(ORGANIZATION_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    defaultChatIssueCreationMode: z.enum(CHAT_ISSUE_CREATION_MODES).optional(),
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
  });

export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;

export const updateOrganizationBrandingSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined
      || value.description !== undefined
      || value.brandColor !== undefined
      || value.logoAssetId !== undefined,
    "At least one branding field must be provided",
  );

export type UpdateOrganizationBranding = z.infer<typeof updateOrganizationBrandingSchema>;

export const updateOrganizationWorkspaceFileSchema = z.object({
  content: z.string(),
});

export type UpdateOrganizationWorkspaceFile = z.infer<typeof updateOrganizationWorkspaceFileSchema>;

export const createOrganizationWorkspaceFileSchema = z.object({
  filePath: z.string().trim().min(1).max(1000),
  content: z.string().optional().default(""),
});

export type CreateOrganizationWorkspaceFile = z.infer<typeof createOrganizationWorkspaceFileSchema>;

export const createOrganizationWorkspaceDirectorySchema = z.object({
  directoryPath: z.string().trim().min(1).max(1000),
});

export type CreateOrganizationWorkspaceDirectory = z.infer<typeof createOrganizationWorkspaceDirectorySchema>;

export const renameOrganizationWorkspaceEntrySchema = z.object({
  name: z.string().trim().min(1).max(255),
});

export type RenameOrganizationWorkspaceEntry = z.infer<typeof renameOrganizationWorkspaceEntrySchema>;

export const moveOrganizationWorkspaceEntrySchema = z.object({
  destinationDirectoryPath: z.string().trim().max(1000).default(""),
});

export type MoveOrganizationWorkspaceEntry = z.infer<typeof moveOrganizationWorkspaceEntrySchema>;

export const copyOrganizationWorkspaceEntrySchema = z.object({
  destinationDirectoryPath: z.string().trim().max(1000).optional(),
});

export type CopyOrganizationWorkspaceEntry = z.infer<typeof copyOrganizationWorkspaceEntrySchema>;
