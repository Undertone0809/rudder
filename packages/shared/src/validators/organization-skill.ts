import { z } from "zod";

export const organizationSkillSourceTypeSchema = z.enum(["local_path", "github", "url", "catalog", "skills_sh"]);
export const organizationSkillTrustLevelSchema = z.enum(["markdown_only", "assets", "scripts_executables"]);
export const organizationSkillCompatibilitySchema = z.enum(["compatible", "unknown", "invalid"]);
export const organizationSkillSourceBadgeSchema = z.enum([
  "rudder",
  "community",
  "github",
  "local",
  "url",
  "catalog",
  "skills_sh",
]);

export const organizationSkillFileInventoryEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["skill", "markdown", "reference", "script", "asset", "other"]),
});

export const organizationSkillSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  key: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  markdown: z.string(),
  sourceType: organizationSkillSourceTypeSchema,
  sourceLocator: z.string().nullable(),
  sourceRef: z.string().nullable(),
  trustLevel: organizationSkillTrustLevelSchema,
  compatibility: organizationSkillCompatibilitySchema,
  fileInventory: z.array(organizationSkillFileInventoryEntrySchema).default([]),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const organizationSkillListItemSchema = organizationSkillSchema.extend({
  attachedAgentCount: z.number().int().nonnegative(),
  editable: z.boolean(),
  editableReason: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  sourceBadge: organizationSkillSourceBadgeSchema,
  sourcePath: z.string().nullable(),
  workspaceEditPath: z.string().nullable(),
});

export const organizationSkillUsageAgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  urlKey: z.string().min(1),
  agentRuntimeType: z.string().min(1),
  desired: z.boolean(),
  actualState: z.string().nullable(),
});

export const organizationSkillDetailSchema = organizationSkillSchema.extend({
  attachedAgentCount: z.number().int().nonnegative(),
  usedByAgents: z.array(organizationSkillUsageAgentSchema).default([]),
  editable: z.boolean(),
  editableReason: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  sourceBadge: organizationSkillSourceBadgeSchema,
  sourcePath: z.string().nullable(),
  workspaceEditPath: z.string().nullable(),
});

export const organizationSkillUpdateStatusSchema = z.object({
  supported: z.boolean(),
  reason: z.string().nullable(),
  trackingRef: z.string().nullable(),
  currentRef: z.string().nullable(),
  latestRef: z.string().nullable(),
  hasUpdate: z.boolean(),
});

export const organizationSkillImportSchema = z.object({
  source: z.string().min(1),
});

export const organizationSkillProjectScanRequestSchema = z.object({
  projectIds: z.array(z.string().uuid()).optional(),
  workspaceIds: z.array(z.string().uuid()).optional(),
});

export const organizationSkillProjectScanSkippedSchema = z.object({
  projectId: z.string().uuid(),
  projectName: z.string().min(1),
  workspaceId: z.string().uuid().nullable(),
  workspaceName: z.string().nullable(),
  path: z.string().nullable(),
  reason: z.string().min(1),
});

export const organizationSkillProjectScanConflictSchema = z.object({
  slug: z.string().min(1),
  key: z.string().min(1),
  projectId: z.string().uuid(),
  projectName: z.string().min(1),
  workspaceId: z.string().uuid(),
  workspaceName: z.string().min(1),
  path: z.string().min(1),
  existingSkillId: z.string().uuid(),
  existingSkillKey: z.string().min(1),
  existingSourceLocator: z.string().nullable(),
  reason: z.string().min(1),
});

export const organizationSkillProjectScanResultSchema = z.object({
  scannedProjects: z.number().int().nonnegative(),
  scannedWorkspaces: z.number().int().nonnegative(),
  discovered: z.number().int().nonnegative(),
  imported: z.array(organizationSkillSchema),
  updated: z.array(organizationSkillSchema),
  skipped: z.array(organizationSkillProjectScanSkippedSchema),
  conflicts: z.array(organizationSkillProjectScanConflictSchema),
  warnings: z.array(z.string()),
});

export const organizationSkillLocalScanRequestSchema = z.object({
  roots: z.array(z.string().min(1)).optional(),
});

export const organizationSkillLocalScanSkippedSchema = z.object({
  root: z.string().min(1),
  path: z.string().nullable(),
  reason: z.string().min(1),
});

export const organizationSkillLocalScanConflictSchema = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
  slug: z.string().min(1),
  key: z.string().min(1),
  existingSkillId: z.string().uuid(),
  existingSkillKey: z.string().min(1),
  existingSourceLocator: z.string().nullable(),
  reason: z.string().min(1),
});

export const organizationSkillLocalScanResultSchema = z.object({
  scannedRoots: z.number().int().nonnegative(),
  discovered: z.number().int().nonnegative(),
  imported: z.array(organizationSkillSchema),
  updated: z.array(organizationSkillSchema),
  skipped: z.array(organizationSkillLocalScanSkippedSchema),
  conflicts: z.array(organizationSkillLocalScanConflictSchema),
  warnings: z.array(z.string()),
});

export const organizationSkillCreateSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).nullable().optional(),
  description: z.string().nullable().optional(),
  markdown: z.string().nullable().optional(),
});

export const organizationSkillFileDetailSchema = z.object({
  skillId: z.string().uuid(),
  path: z.string().min(1),
  kind: z.enum(["skill", "markdown", "reference", "script", "asset", "other"]),
  content: z.string(),
  language: z.string().nullable(),
  markdown: z.boolean(),
  editable: z.boolean(),
});

export const organizationSkillFileUpdateSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type OrganizationSkillImport = z.infer<typeof organizationSkillImportSchema>;
export type OrganizationSkillProjectScan = z.infer<typeof organizationSkillProjectScanRequestSchema>;
export type OrganizationSkillLocalScan = z.infer<typeof organizationSkillLocalScanRequestSchema>;
export type OrganizationSkillCreate = z.infer<typeof organizationSkillCreateSchema>;
export type OrganizationSkillFileUpdate = z.infer<typeof organizationSkillFileUpdateSchema>;
