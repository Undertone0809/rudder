import { z } from "zod";
import { AGENT_RUNTIME_TYPES, CHAT_ISSUE_CREATION_MODES, ORGANIZATION_STATUSES } from "../constants.js";
import { validateModelFallbacksConfig } from "./model-fallbacks.js";

const logoAssetIdSchema = z.string().uuid().nullable().optional();
const brandColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();
const defaultChatRuntimeConfigSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  validateModelFallbacksConfig(value, ctx, []);
});

export const createOrganizationSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  defaultChatIssueCreationMode: z.enum(CHAT_ISSUE_CREATION_MODES).optional().default("manual_approval"),
  defaultChatAgentRuntimeType: z.enum(AGENT_RUNTIME_TYPES).optional().nullable(),
  defaultChatAgentRuntimeConfig: defaultChatRuntimeConfigSchema.optional().nullable(),
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
    defaultChatAgentRuntimeType: z.enum(AGENT_RUNTIME_TYPES).optional().nullable(),
    defaultChatAgentRuntimeConfig: defaultChatRuntimeConfigSchema.optional().nullable(),
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
