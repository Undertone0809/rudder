import { z } from "zod";

export const rudderPluginPackageFileSchema = z.object({
  path: z.string().min(1).max(1_024),
  content: z.string().max(14_000_000),
  encoding: z.enum(["utf8", "base64"]).optional().default("utf8"),
}).strict();

export const inspectRudderPluginSchema = z.object({
  sourceLabel: z.string().trim().min(1).max(240),
  sourceType: z.literal("local_upload").optional().default("local_upload"),
  files: z.array(rudderPluginPackageFileSchema).min(1).max(500),
}).strict();

export const inspectRudderPluginArchiveSchema = z.object({
  sourceLabel: z.string().trim().min(1).max(240),
  filename: z.string().trim().min(1).max(240).refine((value) => /\.zip$/i.test(value), "Only ZIP Plugin archives are supported"),
  content: z.string().min(1).max(14_000_000),
  encoding: z.literal("base64"),
}).strict();

export const configureRudderPluginMarketplaceSchema = z.object({
  sourceLabel: z.string().trim().min(1).max(240),
  files: z.array(rudderPluginPackageFileSchema).min(1).max(500).optional(),
  github: z.object({
    repository: z.string().url().max(500),
    commit: z.string().regex(/^[0-9a-f]{40}$/i, "A full 40-character Git commit SHA is required"),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.files) === Boolean(value.github)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one local marketplace folder or pinned GitHub marketplace" });
  }
});

export const installRudderPluginSchema = z.object({
  enabled: z.boolean().optional().default(true),
  confirmAccessExpansion: z.boolean().optional().default(false),
  skillConflictStrategy: z.enum(["keep", "replace", "rename"]).optional(),
}).strict();

export const updateRudderPluginEnablementSchema = z.object({
  enabled: z.boolean(),
}).strict();

export const configureRudderPluginSkillsSchema = z.object({
  agentIds: z.array(z.string().uuid()).max(100),
}).strict();

export const configureRudderPluginMcpSchema = z.object({
  componentId: z.string().uuid(),
}).strict();

export const customizeRudderPluginSkillSchema = z.object({
  componentId: z.string().uuid(),
}).strict();

export type InspectRudderPlugin = z.infer<typeof inspectRudderPluginSchema>;
export type InspectRudderPluginArchive = z.infer<typeof inspectRudderPluginArchiveSchema>;
export type ConfigureRudderPluginMarketplace = z.infer<typeof configureRudderPluginMarketplaceSchema>;
export type InstallRudderPlugin = z.infer<typeof installRudderPluginSchema>;
export type UpdateRudderPluginEnablement = z.infer<typeof updateRudderPluginEnablementSchema>;
export type ConfigureRudderPluginSkills = z.infer<typeof configureRudderPluginSkillsSchema>;
export type ConfigureRudderPluginMcp = z.infer<typeof configureRudderPluginMcpSchema>;
export type CustomizeRudderPluginSkill = z.infer<typeof customizeRudderPluginSkillSchema>;
